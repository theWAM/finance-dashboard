// This Paycheck — the current pay window as a focused, editable slice of the
// ledger. The window is [payday, next payday) from the person's cadence, anchored
// to their most recent paycheck. We prefill the ledger entries that fall inside
// that window (what's *known to happen* this pay period — paycheck, savings,
// investments, card payments, car note, …), project the running balance from the
// balance entering the window, flag where it goes negative, and warn before
// saving. Edits/adds/deletes are staged and written back to the ledger on Save.
//
// T31 adds a [ Debit | Credit ] subtab (decision #37's resolution — Credit Cards
// is a subtab here, not a fifth nav item). Both subtabs share the pay window
// above; each keeps its own staged edit set, mirroring the Ledger's per-account
// staging.
//
// T32 replaced T31's `computeCardView()` seam with shared/cards.js, the way T4b
// did for the Spending Plan: every figure on the Credit subtab — debt, the four
// components of the window's debt movement, the category rollup behind the
// donut, the statement cycle, coverage, the to-date/projected split — comes out
// of that module, so this page and `node local/check-cards.js` cannot disagree.
// What stays here is display: the running "Owed" column (which has to follow
// THIS table's same-day ordering, something cardSummary deliberately knows
// nothing about), the staged-edit merge feeding the engine, and the wording.

import { windowFor } from "/shared/paycycle.js";
import { mountPlanNav } from "./nav-plan.js";
import { mountViewSwitch } from "./view-switch.js";
import { readStatement, diffAgainstLedger, toBulkRow, StatementImportError } from "/shared/statement-import.js";
// T30: the recurring engine and the merchant rules. Both are pure modules in
// shared/, so the published read-only copy and local/check-rules.js run the
// same code this page does.
import { occurrences, defaultUntil, detectRecurring, projectionRows, supersedeProjections, staleProjections, merchantStem, parseProjection } from "/shared/recurring.js";
import { RULE_KIND, compileRules, applyRules, ruleCoverage, ruleFromRow, pickRule, MATCH_TYPES } from "/shared/card-rules.js";
// T32: the Credit subtab's engine. Pure compute, no DOM, no fetch — the same
// module local/check-cards.js runs in Node.
import {
  cardSummary, totalDebt, cardCoverage, statementCycle, statementBalance,
  minimumDue, minimumDueEstimated, cardRows,
  // T32b: the payoff projection. `payoffScenarios` derives the two
  // ledger-backed scenarios; `payoffSchedule` is the same amortization run
  // with the what-if sliders' numbers, which never leave this tab.
  payoffScenarios, payoffSchedule,
} from "/shared/cards.js";

mountPlanNav(document.querySelector(".nav"), { view: null });

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Same-day order: paycheck > investments > savings > bills > everything else.
const isPaycheck = (t) => /paycheck/i.test(t.description || "") && (Number(t.deposit) || 0) > 0;
const DAY_RANK = { Investments: 1, Savings: 2, Bill: 3 };
const dayRank = (t) => (isPaycheck(t) ? 0 : (DAY_RANK[t.description] ?? 4));
const byDate = (a, b) =>
  cmp(a.txn_date, b.txn_date) ||
  (dayRank(a) - dayRank(b)) ||
  cmp(a.created_at || "", b.created_at || "");
const params = new URLSearchParams(location.search);
const TODAY = new Date().toISOString().slice(0, 10);

const state = {
  people: [],
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,
  cadence: "biweekly",
  anchor: null,           // stable payday the pay-window grid is anchored to
  refDate: null,          // the day whose pay window is currently shown
  window: null,
  txns: [],               // Debit (checking) account transactions as last loaded
  allTxns: [],            // the whole live ledger, for resolving transfer_id pairs
  edits: new Map(),       // id -> { field: value } — Debit's staged edits
  dels: new Set(),        // Debit ids staged for deletion
  news: [],               // Debit's staged new rows

  view: "debit",          // "debit" | "credit" — the active subtab
  cards: [],              // visible credit-card accounts, owner-scoped (decision #24)
  accountsById: new Map(),
  // Every row on every visible card, as last loaded. The headline "Owed — all N
  // cards" is `totalDebt()` over this set, so one fetch of the ledger replaces
  // one fetch per card and the household figure can move with a staged edit
  // instead of waiting for a save.
  cardTxns: [],
  card: {                 // the Credit subtab's own staged slice, for whichever card is selected
    accountId: null,
    account: null,
    txns: [],             // the selected card's slice of state.cardTxns
    edits: new Map(),
    dels: new Set(),
    news: [],
  },

  // T30(b): the merchant rules, as `plan_targets` rows of kind `card_rule`.
  // A THIRD staged set, kept separate from the two ledger ones on purpose: a
  // rule is strategy and a transaction is a fact, they have different Save
  // buttons, and mixing them would mean "Save to ledger" silently rewriting
  // the rule set (or worse, the reverse).
  rules: {
    all: [],              // every card_rule row visible to this person
    edits: new Map(),     // id -> { name?, data? }
    dels: new Set(),
    news: [],             // { _tempId, owner, name, data }
    open: false,          // panel expanded?
  },
  recur: { open: false, hits: [] },
};
let tempId = 0;

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) { const m = await res.json().catch(() => ({})); throw new Error(m.error || `${res.status} ${res.statusText}`); }
  return res.status === 204 ? null : res.json();
}
let toastTimer;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800); }

// --- current user ----------------------------------------------------------

const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
const currentPerson = () => state.people.find((p) => p.id === state.currentUser) || null;

function renderUserChip() {
  const chip = $("#userChip"); const p = currentPerson();
  if (!p || state.people.length <= 1) { chip.hidden = true; return; }
  $("#userAvatar").innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  $("#userName").textContent = p.name;
  chip.hidden = false;
}
function showWho() {
  const box = $("#whoOptions"); box.innerHTML = "";
  for (const p of state.people) {
    const b = document.createElement("button"); b.className = "who-card";
    b.innerHTML = (p.avatar ? `<img class="who-photo" src="${p.avatar}" alt="${p.name}">` : `<span class="who-photo initials">${initials(p.name)}</span>`) + `<span class="name">${p.name}</span>`;
    b.onclick = () => { if (hasAnyPending() && !confirm("Discard unsaved changes?")) return; localStorage.setItem("currentUser", p.id); location.href = "./paycheck.html"; };
    box.appendChild(b);
  }
  $("#who").hidden = false;
}
$("#userChip").addEventListener("click", showWho);

// --- load ------------------------------------------------------------------

async function init() {
  try {
    state.people = (await api("/api/people")).people;
    if (state.people.length <= 1) state.currentUser = state.people[0]?.id ?? null;
    else if (!state.people.some((p) => p.id === state.currentUser)) { showWho(); return; }
    renderUserChip();
    state.cadence = currentPerson()?.pay_cadence || "biweekly";

    const { accounts } = await api("/api/accounts");
    state.accountsById = new Map(accounts.map((a) => [a.id, a]));
    state.account = accounts.find((a) => a.owner === state.currentUser && a.type === "checking")
                 || accounts.find((a) => a.owner === state.currentUser) || null;
    // Owner-scoped per decision #24 — the Ledger's existing filter, lifted.
    state.cards = accounts.filter((a) => (a.owner === state.currentUser || a.owner === "shared") && a.type === "credit_card");
    await loadRules();
    if (!state.account) { $("main").innerHTML = `<div class="empty">No checking account for this person yet.</div>`; return; }

    const viewParam = params.get("view");
    const storedView = localStorage.getItem("paycheckView");
    state.view = viewParam === "credit" || (!viewParam && storedView === "credit") ? "credit" : "debit";

    const acctParam = params.get("account");
    const storedCard = localStorage.getItem("cardsAccount");
    state.card.accountId =
      (acctParam && state.cards.some((c) => c.id === acctParam) && acctParam) ||
      (storedCard && state.cards.some((c) => c.id === storedCard) && storedCard) ||
      state.cards[0]?.id || null;

    await loadWindow();
    await loadCardLedger();
    showWindow();
  } catch (e) { $("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`; }
}

// Fetch the ledger and reset staged edits; keeps whatever pay period is in view.
async function loadWindow() {
  const { transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.account.id)}`);
  state.txns = transactions;
  state.anchor = anchorPaycheck(transactions, TODAY); // stable grid anchor
  if (!state.refDate) state.refDate = TODAY;
  clearPending();
}

// Fetch every card's ledger in one call and reset the staged edits.
//
// One whole-ledger read rather than one read per card: "Owed — all N cards" is
// `totalDebt()` across the owner's whole card set (decision #24), and six
// sequential round-trips to answer one stat row is the kind of thing that makes
// a card switch feel slow. 2k rows is nothing to filter in the browser, and
// having them all here is also what lets a card-to-card transfer resolve its
// pair (#47) instead of showing an unpaired payment.
async function loadCardLedger() {
  const { transactions } = await api("/api/transactions");
  state.allTxns = transactions;
  state.cardTxns = cardRows(transactions, state.cards);
  selectCardSlice();
}

// Re-point `state.card` at whichever card is selected. No fetch: every card's
// rows are already in `state.cardTxns`.
function selectCardSlice() {
  state.card.account = state.cards.find((c) => c.id === state.card.accountId) || null;
  state.card.txns = state.card.account ? state.cardTxns.filter((t) => t.account_id === state.card.account.id) : [];
  clearCardPending();
}

// Recompute + render the pay window containing state.refDate (no fetch, no clear).
function showWindow() {
  state.window = windowFor(state.cadence, state.anchor, state.refDate);
  render();
}

const shiftDay = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};
function gotoPrev() { state.refDate = shiftDay(state.window.start, -1); showWindow(); }
function gotoNext() { state.refDate = state.window.nextStart; showWindow(); }
function gotoCurrent() { state.refDate = TODAY; showWindow(); } // back to the current pay period
// Nav appears at top and bottom: wire every instance by class.
const $all = (sel) => document.querySelectorAll(sel);
$all(".navprev").forEach((b) => b.addEventListener("click", gotoPrev));
$all(".navnext").forEach((b) => b.addEventListener("click", gotoNext));
$all(".navcurrent").forEach((b) => b.addEventListener("click", gotoCurrent));
$all(".winrange").forEach((b) => b.addEventListener("click", (e) => {
  const el = e.currentTarget.closest(".window-nav").querySelector(".windate");
  el.value = state.refDate; if (el.showPicker) el.showPicker(); else el.focus();
}));
$all(".windate").forEach((el) => el.addEventListener("change", (e) => { if (e.target.value) { state.refDate = e.target.value; showWindow(); } }));

// Anchor = most recent paycheck deposit on/before today; else the latest/only; else today.
function anchorPaycheck(txns, today) {
  const pays = txns.filter((t) => /paycheck/i.test(t.description || "") && Number(t.deposit) > 0).map((t) => t.txn_date).sort();
  if (!pays.length) return today;
  const past = pays.filter((d) => d <= today);
  return past.length ? past[past.length - 1] : pays[pays.length - 1];
}

function clearPending() { state.edits.clear(); state.dels.clear(); state.news = []; addDraft = freshDraft(); }
function clearCardPending() { state.card.edits.clear(); state.card.dels.clear(); state.card.news = []; cardAddDraft = freshCardDraft(); }
const inWin = (d) => d >= state.window.start && d < state.window.nextStart;

// A slice is either Debit's top-level { edits, dels, news } or the Credit
// subtab's state.card — same shape, so stageEdit/toggleDelete/pushNewTo work
// on either without caring which subtab is active.
const sliceFor = (target) => (target === "credit" ? state.card : state);

// Merge staged changes over the ledger, run the running balance oldest→newest,
// then surface just this window's rows with their projected balance.
function computeView() {
  const all = [];
  for (const t of state.txns) {
    if (state.dels.has(t.id)) { all.push({ ...t, _id: t.id, _deleted: true }); continue; }
    const e = state.edits.get(t.id);
    all.push({ ...t, ...(e || {}), _id: t.id, _edited: !!e });
  }
  for (const n of state.news) all.push({ ...n, _id: n._tempId, _new: true });

  const live = all.filter((r) => !r._deleted)
    .sort(byDate);
  let bal = Number(state.account.opening_balance) || 0;
  let startBal = bal;
  const balById = new Map();
  for (const t of live) {
    bal = round2(bal + (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0));
    balById.set(t._id, bal);
    if (t.txn_date < state.window.start) startBal = bal;
  }

  // Display set: window rows (incl. staged deletes for restore), chronological.
  const rows = all.filter((r) => inWin(r.txn_date)).sort(byDate);
  let deposits = 0, withdrawals = 0, min = startBal, minRow = null, endBal = startBal;
  for (const r of rows) {
    if (r._deleted) continue;
    deposits += Number(r.deposit) || 0;
    withdrawals += Number(r.withdrawal) || 0;
    const b = balById.get(r._id);
    endBal = b;
    if (b < min) { min = b; minRow = r; }
  }
  return { rows, balById, startBal, endBal: round2(endBal), deposits: round2(deposits), withdrawals: round2(withdrawals), min: round2(min), minRow };
}

// The selected card's rows with this page's staged edits merged over them.
// `_deleted` marks a staged delete, which the table still shows (so it can be
// restored) and the engine must not see — shared/merge.js's `live()` filters
// tombstones, and knows nothing about this page's staging markers.
function mergedCardRows() {
  const c = state.card;
  const all = [];
  for (const t of c.txns) {
    if (c.dels.has(t.id)) { all.push({ ...t, _id: t.id, _deleted: true }); continue; }
    const e = c.edits.get(t.id);
    all.push({ ...t, ...(e || {}), _id: t.id, _edited: !!e });
  }
  for (const n of c.news) all.push({ ...n, _id: n._tempId, _new: true });
  return all;
}

// T32: everything numeric on the Credit subtab, from shared/cards.js over the
// pay window both subtabs share (#37). Nothing here does card arithmetic — the
// four components of the debt movement, the category rollup, the cycle, the
// coverage report and the to-date/projected split are all the engine's, so
// `node local/check-cards.js` is checking the same answers the page shows.
//
// Two things ARE computed here, and both are display-layer on purpose:
//
//  · `balById`, the running "Owed" column. It has to follow the order the TABLE
//    renders in — `byDate`, which puts a paycheck ahead of a bill on the same
//    day — and cardSummary deliberately has no opinion about same-day order.
//    Its closing figure still has to agree with the engine's `closingOwed`, and
//    `balanceAgrees` is that assertion rather than a hope.
//  · the household total's staged-edit overlay: `totalDebt` is handed every
//    card's rows with the selected card's swapped for the staged version, so
//    editing a charge moves "Owed — all N cards" without waiting for a save.
function computeCardView() {
  const c = state.card;
  if (!c.account) return null;
  const all = mergedCardRows();
  const liveRows = all.filter((r) => !r._deleted);
  const win = { from: state.window.start, to: state.window.end };

  const v = cardSummary({ transactions: liveRows, account: c.account, window: win, asOf: TODAY });

  let bal = Number(c.account.opening_balance) || 0;
  const balById = new Map();
  for (const t of liveRows.slice().sort(byDate)) {
    bal = round2(bal + (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0));
    balById.set(t._id, bal);
  }
  const lastInWindow = all.filter((r) => !r._deleted && inWin(r.txn_date)).sort(byDate).pop();
  const endBal = lastInWindow ? balById.get(lastInWindow._id) : round2(-v.openingOwed);

  // The staged view of the whole card set: this card's rows replaced by the
  // merged ones, every other card's left alone.
  const householdRows = state.cardTxns.filter((t) => t.account_id !== c.account.id).concat(liveRows);

  return {
    ...v,
    // Display rows, chronological, INCLUDING staged deletes so they can be
    // restored — which is why this overrides the engine's live-only `rows`.
    rows: all.filter((r) => inWin(r.txn_date)).sort(byDate),
    windowRows: v.rows,
    balById,
    endBal: round2(endBal),
    balanceAgrees: Math.abs(round2(-endBal) - v.closingOwed) < 0.005,
    household: totalDebt(householdRows, state.cards, { owner: state.currentUser }),
    coverage: cardCoverage({ transactions: state.cardTxns, accounts: state.cards, window: win }),
    cycle: statementCycle(c.account, TODAY),
    statement: statementBalance(liveRows, c.account, TODAY),
    // T32b. Over the card's WHOLE staged ledger, not the window's slice: a
    // payoff projection starts from what is owed today (#58), measures the
    // charge pace over the three months before today, and reads the payments
    // the ledger has scheduled after it — none of which the pay window bounds.
    // Staging it means a charge you have typed but not saved moves the payoff
    // date, which is the point of a projection you can argue with.
    payoff: payoffScenarios({ transactions: liveRows, account: c.account, asOf: TODAY }),
  };
}

// Categorical colors assigned by category IDENTITY (never by slice size);
// unmapped categories fold into a single catch-all "Other". These are CSS
// variables, not literals, so the pie follows the theme — each theme ships its
// own validated set in theme.css (SVG `fill` accepts `var()` because the chart
// is inline in the document). Groceries/Transportation/Misc ship from T38;
// Interest (a card's own category, previously falling through to the gray
// catch-all) ships from T46.
const CAT_COLORS = {
  "Housing": "var(--cat-housing)", "Bill": "var(--cat-bill)", "Savings": "var(--cat-savings)",
  "Investments": "var(--cat-investments)", "Credit Card Payment": "var(--cat-card)",
  "Loan Payment": "var(--cat-loan)", "Food": "var(--cat-food)", "Fun": "var(--cat-fun)",
  "Groceries": "var(--cat-groceries)", "Transportation": "var(--cat-transport)", "Misc": "var(--cat-misc)",
  "Interest": "var(--cat-interest)",
};
const OTHER_COLOR = "var(--cat-other)";
const NS = "http://www.w3.org/2000/svg";
const colorFor = (cat) => CAT_COLORS[cat] || OTHER_COLOR;

// Sum `amountFor(row)` by category (identity = row.description). Debit only:
// the card donut is drawn from `cardSummary().byCategory`, so its grouping is
// the engine's rather than a second one that could drift from the headline.
function categorySums(rows, { amountFor }) {
  const sums = new Map();
  for (const r of rows) {
    if (r._deleted) continue;
    const cat = r.description || "Other";
    const amt = amountFor(r);
    if (!amt) continue;
    sums.set(cat, round2((sums.get(cat) || 0) + amt));
  }
  return sums;
}

// Draw a donut + legend from category sums. A category whose net amount is
// negative (a refund exceeding its charges) can't be drawn as a slice — it's
// clamped to zero in the arc but still shown as the true negative in the
// legend, per the card donut's refund-netting flag.
function drawDonut({ svg, legend, chartHost, sums, subLabel, linkFor }) {
  const entries = [...sums.entries()].map(([cat, amount]) => ({ cat, amount, arcAmt: Math.max(0, amount), color: colorFor(cat) }));
  const total = round2(entries.reduce((a, d) => a + d.amount, 0));
  const arcTotal = round2(entries.reduce((a, d) => a + d.arcAmt, 0));
  if (arcTotal <= 0) { chartHost.hidden = true; return null; }
  chartHost.hidden = false;

  const sorted = entries.slice().sort((a, b) => b.arcAmt - a.arcAmt);
  const drawn = sorted.filter((d) => d.arcAmt > 0);
  const pad = drawn.length > 1 ? 0.03 : 0;

  svg.innerHTML = "";
  const cx = 110, cy = 110, rO = 96, rI = 60;
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  let start = -Math.PI / 2;
  for (const d of drawn) {
    const frac = d.arcAmt / arcTotal;
    const end = start + frac * 2 * Math.PI;
    const a0 = start + pad / 2, a1 = Math.max(a0, end - pad / 2);
    const [x1, y1] = pt(rO, a0), [x2, y2] = pt(rO, a1), [x3, y3] = pt(rI, a1), [x4, y4] = pt(rI, a0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${x1} ${y1} A${rO} ${rO} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${rI} ${rI} 0 ${large} 0 ${x4} ${y4} Z`);
    path.setAttribute("fill", d.color);
    const title = document.createElementNS(NS, "title");
    title.textContent = `${d.cat}: ${fmt(d.amount)} (${Math.round(frac * 100)}%)`;
    path.appendChild(title);
    svg.appendChild(path);
    // Direct % label for slices with enough room (≥ 7%).
    if (frac >= 0.07) {
      const [lx, ly] = pt((rO + rI) / 2, (a0 + a1) / 2);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "slice-label"); t.setAttribute("x", lx); t.setAttribute("y", ly + 4);
      t.textContent = `${Math.round(frac * 100)}%`;
      svg.appendChild(t);
    }
    start = end;
  }
  const totalText = document.createElementNS(NS, "text");
  totalText.setAttribute("class", "donut-total"); totalText.setAttribute("x", cx); totalText.setAttribute("y", cy);
  totalText.textContent = fmt(total);
  const subText = document.createElementNS(NS, "text");
  subText.setAttribute("class", "donut-sub"); subText.setAttribute("x", cx); subText.setAttribute("y", cy + 16);
  subText.textContent = subLabel;
  svg.append(totalText, subText);

  // --- legend (identity is never color-alone) ---
  legend.innerHTML = "";
  for (const d of sorted) {
    if (d.amount === 0) continue;
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = d.color;
    const cat = document.createElement("span"); cat.className = "cat";
    // T32's "View in Ledger", on the category name itself so the legend stays
    // four columns wide. `linkFor` returning "" means that category can't be
    // expressed as a filter (an empty category), and it renders as plain text.
    const href = linkFor ? linkFor(d.cat) : "";
    if (href) {
      const a = document.createElement("a");
      a.href = href; a.textContent = d.cat;
      a.title = `View this card's ${d.cat} rows for this pay window in the Ledger`;
      cat.appendChild(a);
    } else {
      cat.textContent = d.cat;
    }
    const amt = document.createElement("span"); amt.className = "amt"; amt.textContent = fmt(d.amount);
    const pct = document.createElement("span"); pct.className = "pct";
    pct.textContent = arcTotal ? `${Math.round((d.arcAmt / arcTotal) * 100)}%` : "—";
    legend.append(sw, cat, amt, pct);
  }
  return { total, arcTotal };
}

function renderChart(rows) {
  const sums = categorySums(rows, { amountFor: (r) => Number(r.withdrawal) || 0 });
  drawDonut({ svg: $("#donut"), legend: $("#legend"), chartHost: $("#chart"), sums, subLabel: "allocated" });
}

// The card donut IS `cardSummary().byCategory` — the engine's own grouping, so
// a slice and the "Charged" stat are the same number by construction. Refunds
// net into their own category, and what is NOT a purchase is decided by
// `classifyCardRow` rather than a name list kept by hand here: that is what
// stops Citi's $5,862.14 balance transfer drawing as the biggest "purchase" of
// the window, and Apple's $850 reversal as the second.
function renderCardChart(v) {
  const sums = new Map(v.byCategory.map((g) => [g.label, g.amount]));
  // `label` is the display string ("—" for a row with no category); `category`
  // is what the Ledger can actually filter on, and "" can't be a URL param.
  const categoryOf = new Map(v.byCategory.map((g) => [g.label, g.category]));
  const legend = $("#cardLegend");
  const result = drawDonut({
    svg: $("#cardDonut"), legend, chartHost: $("#cardChart"), sums, subLabel: "charged",
    linkFor: (label) => (categoryOf.get(label) ? cardLedgerHref(categoryOf.get(label)) : ""),
  });
  if (!result) return;
  if (v.refunds > 0.005) {
    const blank = document.createElement("span");
    const note = document.createElement("span"); note.className = "muted sm"; note.textContent = `net of ${fmt(v.refunds)} refunded`;
    const amt = document.createElement("span"); amt.className = "amt muted sm"; amt.textContent = fmt(v.netPurchases);
    const pct = document.createElement("span"); pct.className = "pct"; pct.textContent = "100%";
    legend.append(blank, note, amt, pct);
  }
}

// T5's deep-link params plus `?account=`, so a slice lands on the rows it
// counted. The Ledger ANDs its facets, so category + this card + this window is
// exactly the slice — except an EMPTY category, which no URL param can express
// and which is therefore dropped rather than silently filtering to nothing.
function cardLedgerHref(category) {
  const q = new URLSearchParams();
  if (state.currentUser) q.set("user", state.currentUser);
  q.set("account", state.card.accountId);
  q.set("from", state.window.start);
  q.set("to", state.window.end);
  if (category) q.append("category", category);
  return `./?${q}`;
}

// --- T32b: the debt payoff projection ---------------------------------------
//
// The only thing on this subtab that makes a claim about the FUTURE, so the
// whole of its arithmetic lives in `shared/cards.js` (pure, Node-checkable,
// asserted against hand-computed amortization tables by check-cards.js) and
// what lives here is strictly the drawing and the wording.
//
// Three things the wording has to carry, because the numbers can't:
//
//  · **The payment side is a real plan; the charge side is a judgment call.**
//    A future-dated `Credit Card Payment` row is money someone intends to
//    send — T34 mirrored every one onto the card. Charges are not scheduled,
//    so the charge line is a 3-month trailing average and is labelled "at your
//    3-month pace" every single time it appears, with this window's own figure
//    printed beside it so the number is never ambiguous about where it came
//    from.
//  · **"Never" is a real answer and the most important one.** It rides on the
//    COLLAPSED line, because it is the part worth seeing without opening
//    anything, and `payoffSchedule` returns `payoffMonth: null` rather than a
//    far-future date nobody would notice was fiction.
//  · **A missing input is said, not guessed.** No APR projects at 0% and says
//    so; no credit limit hides the limit line and says so; a 0% that is
//    promotional (decision #47 — Citi, on a 99%-utilized card) says that too.
//
// The sliders are EPHEMERAL by construction: `whatIf` is a module variable, so
// a reload, a card switch or a Discard returns the panel to the ledger plan.
// Nothing here writes to the ledger and there is no Save — `↺ reset to my
// ledger plan` is the only state this panel has.

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (ym) => (ym ? MONTH_ABBR[Number(ym.slice(5, 7)) - 1] : "");
const monthLabel = (ym) => (ym ? `${monthName(ym)} ${ym.slice(0, 4)}` : "");
const fmt0 = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
// Exact up to $100k, then abbreviated — a limit of $10,500 rounded to "$11k"
// next to a label reading "the $10,500 limit" makes the chart look wrong when
// it is the axis that is lying.
const axisMoney = (n) => (Math.abs(n) >= 100000 ? `$${Math.round(n / 1000)}k` : fmt0(n));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Per-card, in localStorage, exactly like Phase 11's buckets: expanding one
// card's panel to study it must not re-open the other five on the next visit.
const payoffKey = (id) => `payoffOpen:${id}`;
const payoffOpen = (id) => localStorage.getItem(payoffKey(id)) === "1";   // collapsed by default
const setPayoffOpen = (id, v) => localStorage.setItem(payoffKey(id), v ? "1" : "0");

// The what-if sliders' state: `null` means "the ledger plan", which is also
// what a reload and a card switch mean. Never persisted, never POSTed.
let whatIf = null;
let whatIfCard = null;
let payoffCtx = null;     // the last card view, so a slider can repaint without a full render

function renderPayoff(v) {
  const line = $("#payoffLine"), panel = $("#payoffPanel");
  const p = v?.payoff;
  if (!p) { line.hidden = true; panel.hidden = true; payoffCtx = null; return; }
  payoffCtx = v;
  line.hidden = false;

  // A card switch invalidates the sliders: they are denominated in that card's
  // balance and APR, and carrying them across would silently answer a question
  // about Apple with Discover's numbers.
  if (whatIfCard !== p.accountId) { whatIf = null; whatIfCard = p.accountId; }

  const open = payoffOpen(p.accountId);
  line.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;

  buildPayoffSliders(p);
  paintPayoff();
}

// Everything numeric, split out from the build above so dragging a slider
// repaints the chart without rebuilding (and so dropping) the slider that is
// being dragged. Reads `payoffCtx`, which `renderPayoff` keeps current.
function paintPayoff() {
  const v = payoffCtx; if (!v) return;
  const p = v.payoff;
  const w = whatIfInputs(p);
  const what = payoffSchedule({
    balance: p.balance, apr: w.apr, payment: w.payment, charges: w.charges,
    limit: p.limit, from: p.asOf.slice(0, 7),
    promoAprUntil: null, postPromoApr: null,   // the slider IS the rate; a promo step would fight it
  });

  paintPayoffLine(v, p);

  // Nothing owed is a real state, and an empty chart with a credit-limit rule
  // floating over a flat $0 line is a page pretending it has something to
  // project. One sentence, no chart, no sliders.
  // One class on the panel rather than three `hidden` flags: `hidden` is an
  // HTMLElement property, so setting it on an inline <svg> (an SVGElement)
  // silently assigns a JS expando and leaves the chart on the page.
  const clear = p.balance <= 0.005;
  $("#payoffPanel").classList.toggle("is-clear", clear);
  if (clear) {
    $("#payoffScenarios").innerHTML = "";
    $("#payoffNote").innerHTML = `<div>${p.balance < -0.005
      ? `This card is <b>overpaid by ${fmt(-p.balance)}</b> as of ${p.asOf} — there is no balance to retire, so there is nothing to project.`
      : `<b>Nothing owed</b> on this card as of ${p.asOf}, so there is nothing to project. The chart returns the moment a charge lands.`}</div>`;
    return;
  }

  drawPayoffChart(p, what);
  paintPayoffScenarios(v, p, what, w);
  paintPayoffNote(v, p);
  for (const el of document.querySelectorAll("#payoffSliders .sl")) {
    const inp = el.querySelector("input");
    el.querySelector(".v").innerHTML = SLIDER_LABEL[inp.dataset.key](w, p);
  }
  $("#payoffReset").disabled = !whatIf;
}

// --- the collapsed line -----------------------------------------------------
//
// Caret · card · dashed rule · the payoff DATE on the planned payments · the
// qualifier that says which scenario that date is · the warning. Scenario 2 is
// the date, because it is the one that is actually a plan; scenario 1 is the
// warning, because a pace that never clears is the finding.
function paintPayoffLine(v, p) {
  const line = $("#payoffLine");
  const card = state.card.account;
  const last4 = card?.data?.last4;
  const paid = p.balance <= 0.005;
  // `shortCardName` is the issuer where that is unambiguous and the full name
  // where two visible cards share one, so this reads "— Apple Card" rather
  // than "— Woody — Apple Card" and still disambiguates the two Chases.
  const title = `Debt payoff projection — ${shortCardName(card)}${last4 ? ` ···· ${last4}` : ""}`;

  let date, dateCls = "", qualifier = "on your planned payments", warn = "", warnTitle = "";
  if (paid) {
    date = "already clear"; qualifier = p.balance < -0.005 ? `overpaid by ${fmt(-p.balance)}` : `nothing owed as of ${p.asOf}`;
  } else if (!p.payment) {
    date = "never"; dateCls = "none";
    qualifier = "the ledger has no payments scheduled on this card";
  } else if (p.stop.payoffMonth) {
    date = monthLabel(p.stop.payoffMonth);
  } else {
    date = "never"; dateCls = "none";
    qualifier = `${fmt(p.payment)}/mo does not keep up with the interest`;
  }

  // The "never" warning is scenario 1's and belongs here rather than inside
  // the panel: it is the one thing on this line a person would want to know
  // without clicking, and it disagrees with the date beside it on purpose.
  if (!paid && p.payment && p.pace.diverges) {
    warn = p.pace.limitMonth
      ? `⚠ hits the ${fmt0(p.limit)} limit in ${plural(p.pace.limitIndex, "month")} at your 3-month charge pace`
      : "⚠ never at your current charge pace";
    warnTitle = `Charging ${fmt(p.chargeRate || 0)}/mo (the 3-month trailing average) against ${fmt(p.payment)}/mo of scheduled payments.`
      + (p.pace.limitMonth ? ` The balance clears the ${fmt(p.limit)} limit in ${monthLabel(p.pace.limitMonth)}, after which the projection's own premise — that these charges keep going through — stops being true.` : "");
  }

  line.innerHTML = "";
  const add = (cls, text, titleAttr) => {
    const el = document.createElement("span");
    el.className = cls; el.textContent = text;
    if (titleAttr) el.title = titleAttr;
    line.appendChild(el);
    return el;
  };
  add("car", "▶");
  add("pl-title", title);
  add("pl-rule", "");
  add(`pl-date${dateCls ? " " + dateCls : ""}`, date,
    paid ? "" : p.stop.payoffMonth
      ? `If you stop charging and keep paying ${fmt(p.payment)}/mo, this card clears in ${monthLabel(p.stop.payoffMonth)} after ${fmt(p.stop.totalInterest)} of interest.`
      : "No payoff date: the scheduled payments do not retire this balance, so there is no month to name.");
  add("muted sm", qualifier);
  if (warn) add("pl-warn", warn, warnTitle);
}

$("#payoffLine").addEventListener("click", () => {
  const id = payoffCtx?.payoff?.accountId; if (!id) return;
  const open = !payoffOpen(id);
  setPayoffOpen(id, open);
  $("#payoffLine").setAttribute("aria-expanded", String(open));
  $("#payoffPanel").hidden = !open;
});

// --- the chart --------------------------------------------------------------
//
// Three scenarios, one y-scale, end-of-month balances. The limit is the TOP
// gridline when it is known and the card is still under it, so a diverging
// line clips at the rule rather than rescaling the whole chart around a
// balance the issuer would never allow to exist.
const PLOT = { x0: 48, x1: 736, yTop: 16, yBot: 164, xLab: 182 };

function drawPayoffChart(p, what) {
  const svg = $("#payoffChart");
  svg.innerHTML = "";
  const lines = [
    { key: "pace", cls: "pace", color: "var(--neg)", s: p.pace },
    { key: "stop", cls: "stop", color: "var(--pos)", s: p.stop },
    { key: "what", cls: "what", color: "var(--accent)", s: what },
  ];

  // Horizon: the furthest month any scenario actually RESOLVES in (payoff or
  // limit crossing), floored at 6 and capped at 60. A line that resolves in
  // neither simply runs off the right edge, which reads as "keeps going" —
  // the honest picture — instead of stretching the axis to the 30-year cap so
  // that the whole story happens in the first inch.
  const ends = lines.map((l) => l.s.payoffIndex ?? l.s.limitIndex).filter((n) => n != null);
  const H = Math.min(60, Math.max(6, ...ends, 0));
  const at = (s, i) => s.series[Math.min(i, s.series.length - 1)];
  const spanOf = (s) => Math.min(H, s.series.length - 1);

  const peak = Math.max(p.balance, ...lines.flatMap((l) => l.s.series.slice(0, H + 1).map((pt) => pt.balance)));
  const clipsAtLimit = p.limit != null && p.balance <= p.limit;
  const yMax = clipsAtLimit ? p.limit : niceCeil(Math.max(peak, 1));
  const x = (i) => PLOT.x0 + (PLOT.x1 - PLOT.x0) * (H ? i / H : 0);
  const y = (bal) => {
    const raw = PLOT.yBot - (PLOT.yBot - PLOT.yTop) * (Math.max(0, bal) / yMax);
    return Math.max(PLOT.yTop, Math.min(PLOT.yBot, raw));   // the clip
  };
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, vv] of Object.entries(attrs)) n.setAttribute(k, vv);
    if (text != null) n.textContent = text;
    svg.appendChild(n);
    return n;
  };

  // y gridlines at ROUND values — $2,500 apart, not at quarters of whatever the
  // limit happens to be, because "$7,875" is a tick nobody reads twice. The
  // top rule is the credit limit itself when the limit is the scale, dashed in
  // --neg so "the line that must not be crossed" looks different from the
  // three that are only arithmetic.
  const step = niceStep(yMax / 4);
  const ticks = [];
  for (let val = 0; val < yMax; val += step) ticks.push({ val });
  // Drop the last round tick if the limit rule would land on top of it.
  while (ticks.length > 1 && Math.abs(y(ticks[ticks.length - 1].val) - y(yMax)) < 11) ticks.pop();
  ticks.push({ val: yMax, isLimit: clipsAtLimit });
  for (const t of ticks) {
    const yy = Math.round(y(t.val));
    el("line", { class: `gl${t.isLimit ? " limit" : t.val === 0 ? " axis" : ""}`, x1: PLOT.x0, y1: yy, x2: PLOT.x1, y2: yy });
    el("text", { class: `gtext r${t.isLimit ? " lim" : ""}`, x: PLOT.x0 - 6, y: yy + 3 }, axisMoney(t.val))
      .appendChild(titleNode(t.isLimit ? `The ${fmt(p.limit)} credit limit.` : `${fmt(t.val)} owed.`));
  }
  if (p.limit != null && !clipsAtLimit) {
    // Already over the limit (or no headroom): the rule still belongs on the
    // chart, just not as the ceiling.
    const yy = Math.round(y(p.limit));
    el("line", { class: "gl limit", x1: PLOT.x0, y1: yy, x2: PLOT.x1, y2: yy });
    el("text", { class: "gtext lim", x: PLOT.x1, y: yy - 4, "text-anchor": "end" }, `${axisMoney(p.limit)} limit`);
  }

  // x ticks: five of them, labelled with the year only when it changes.
  const xTicks = [...new Set([0, Math.round(H / 4), Math.round(H / 2), Math.round((3 * H) / 4), H])];
  const startYear = p.asOf.slice(0, 4);
  for (const i of xTicks) {
    const m = at(p.stop, 0).month;
    const ym = shiftMonthStr(m, i);
    const lab = ym.slice(0, 4) === startYear ? monthName(ym) : `${monthName(ym)} '${ym.slice(2, 4)}`;
    el("text", { class: "gtext", x: Math.round(x(i)), y: PLOT.yBot + 18, "text-anchor": i === 0 ? "start" : i === H ? "end" : "middle" }, lab);
  }

  // the three lines, drawn stop → what → pace so the warning sits on top.
  // The what-if line is omitted until a slider moves: its defaults ARE the
  // ledger plan (that is what `↺ reset to my ledger plan` resets to), so
  // before then it is drawn exactly underneath the pace line, where it is
  // invisible and its caption only repeats one already on the chart.
  const label = [];
  for (const l of [lines[1], lines[2], lines[0]]) {
    if (l.key === "what" && !whatIf) continue;
    const n = spanOf(l.s);
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(`${x(i).toFixed(1)},${y(at(l.s, i).balance).toFixed(1)}`);
    if (pts.length < 2) continue;
    el("polyline", { class: `ln ${l.cls}`, points: pts.join(" ") });

    // The terminal marker only means something where the line RESOLVES. A line
    // that just ran out of horizon gets no dot, because a dot there would read
    // as an answer.
    const res = l.s.payoffIndex ?? l.s.limitIndex;
    if (res != null && res <= H) {
      el("circle", { cx: x(res).toFixed(1), cy: y(at(l.s, res).balance).toFixed(1), r: 4, fill: l.color });
      label.push({ l, i: res });
    }
  }

  // Labels last, so a line can't be drawn over its own caption — and in
  // PRIORITY order (the "never pays off" warning first), because they collide:
  // on a card at 99% utilization the pace line resolves in month 1 and the
  // what-if line sits exactly on top of it until a slider moves. Each label
  // takes the first vertical slot that doesn't land on one already placed,
  // and a label with nowhere to go is dropped rather than overprinted.
  const placed = [];
  const byPriority = ["pace", "stop", "what"];
  const sameAsPace = (l) => l.key === "what" && !whatIf;
  for (const key of byPriority) {
    const hit = label.find((d) => d.l.key === key);
    if (!hit) continue;
    const { l, i } = hit;
    // Before a slider is touched the what-if line IS one of the other two, so
    // its caption would only repeat one already on the chart.
    if (sameAsPace(l)) continue;
    const text = terminalLabel(l.key, l.s, p);
    if (!text) continue;
    const xx = x(i), end = xx > (PLOT.x0 + PLOT.x1) / 2;
    const y0 = y(at(l.s, i).balance);
    // Collision on the label's actual horizontal SPAN, not on its anchor
    // point: a left-anchored caption and a right-anchored one 200px away still
    // overlap in the middle. ~5.2px/char at 10px bold is close enough for a
    // decision about which of five vertical slots to take.
    const w = text.length * 5.2;
    const span = end ? [xx - 9 - w, xx - 9] : [xx + 9, xx + 9 + w];
    const slot = [-11, 15, -25, 29, -39].find((d) => {
      const yy = y0 + d;
      return yy > PLOT.yTop - 6 && yy < PLOT.yBot + 14
        && !placed.some((q) => Math.abs(q.y - yy) < 12 && q.span[0] < span[1] && span[0] < q.span[1]);
    });
    if (slot == null) continue;
    placed.push({ span, y: y0 + slot });
    el("text", {
      class: "lnote", fill: l.color, "text-anchor": end ? "end" : "start",
      x: Math.round(end ? xx - 9 : xx + 9), y: Math.round(y0 + slot),
    }, text);
  }
  el("circle", { cx: PLOT.x0, cy: y(p.balance).toFixed(1), r: 4, fill: "var(--text)" })
    .appendChild(titleNode(`${fmt(p.balance)} owed as of ${p.asOf}.`));

  svg.setAttribute("aria-label",
    `Projected balance from ${fmt(p.balance)} owed, over ${plural(H, "month")}. `
    + `At the 3-month charge pace: ${p.pace.payoffMonth ? `paid off ${monthLabel(p.pace.payoffMonth)}` : "never paid off"}. `
    + `If charging stops: ${p.stop.payoffMonth ? `paid off ${monthLabel(p.stop.payoffMonth)}` : "never paid off"}. `
    + `What-if: ${what.payoffMonth ? `paid off ${monthLabel(what.payoffMonth)}` : "never paid off"}.`);
}

function titleNode(text) { const t = document.createElementNS(NS, "title"); t.textContent = text; return t; }
const niceCeil = (n) => { const mag = Math.pow(10, Math.floor(Math.log10(n))); return Math.ceil(n / (mag / 2)) * (mag / 2); };
/**
 * The 1/2/2.5/5/10 × 10^k NEAREST `n` — gridline steps a reader recognizes.
 * Nearest rather than next-above: a $25,500 limit wants $5,000 steps (six
 * lines), and rounding its quarter up gives $10,000 and three.
 */
const niceStep = (n) => {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, n))));
  const r = Math.max(1, n) / mag;
  const m = [1, 2, 2.5, 5, 10].reduce((best, c) => (Math.abs(c - r) < Math.abs(best - r) ? c : best));
  return m * mag;
};
const shiftMonthStr = (ym, n) => {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

function terminalLabel(key, s, p) {
  if (s.limitIndex != null) {
    return `⚠ hits the ${fmt0(p.limit)} limit in ${plural(s.limitIndex, "month")} — never pays off`;
  }
  if (s.payoffIndex == null) return "";
  if (s.payoffIndex === 0) return "already clear";
  return key === "what" ? `what-if: ${monthLabel(s.payoffMonth)}` : `paid off ${monthLabel(s.payoffMonth)}`;
}

// --- the three scenario rows ------------------------------------------------
function paintPayoffScenarios(v, p, what, w) {
  const host = $("#payoffScenarios"); host.innerHTML = "";
  const pace = p.chargeRate == null
    ? `charge pace unknown (no rows in ${p.charge.months.join(", ")})`
    : `charging ${fmt(p.chargeRate)}/mo at your 3-month pace`;

  const rows = [
    {
      cls: p.pace.diverges ? "is-pace" : "", sw: `background:${"var(--neg)"}`,
      key: `<b>At your current pace</b> — ${pace}, paying ${fmt(p.payment)}/mo`,
      out: outcomeOf(p.pace, p, { growth: true }),
      title: `Scheduled payments and the 3-month trailing charge rate. ${chargeProvenance(v, p)}`,
    },
    {
      cls: "", sw: "", dash: true,
      key: `<b>If you stop charging</b> — same ${fmt(p.payment)}/mo payment, $0 new charges`,
      out: outcomeOf(p.stop, p, {}),
      title: `The payments the ledger has already scheduled, with nothing new charged. This is the date on the line above.`,
    },
    {
      cls: "", sw: "background:var(--accent)",
      key: `<b>What-if</b> — ${fmt(w.payment)}/mo, ${fmt(w.charges)}/mo charged, ${(w.apr * 100).toFixed(2)}% APR`
        + (whatIf ? "" : ` <span class="muted">· your ledger plan until you move a slider</span>`),
      out: outcomeOf(what, p, {}), outCls: "what",
      title: "The sliders on the right. Nothing here is written to the ledger or kept — a reload returns this panel to the ledger plan.",
    },
  ];
  for (const r of rows) {
    const div = document.createElement("div");
    div.className = `scn${r.cls ? " " + r.cls : ""}`;
    div.title = r.title;
    const sw = document.createElement("span");
    sw.className = `sw${r.dash ? " dash" : ""}`; if (r.sw) sw.style.cssText = r.sw;
    const key = document.createElement("span"); key.className = "key"; key.innerHTML = r.key;
    const out = document.createElement("span"); out.className = `out ${r.outCls || r.out.cls}`; out.textContent = r.out.text;
    div.append(sw, key, out);
    host.appendChild(div);
  }
}

// "never · +$1,877/mo" or "Apr 2027 · $380 interest". The growth figure is the
// FIRST month's change, which is the only one a reader can check against the
// numbers beside it — a mean over a diverging series is a number nobody can
// reproduce from anything on screen.
function outcomeOf(s, p, { growth }) {
  if (s.payoffIndex === 0) return { text: "already clear", cls: "pos" };
  if (s.payoffMonth) return { text: `${monthLabel(s.payoffMonth)} · ${fmt0(s.totalInterest)} interest`, cls: "pos" };
  const per = s.series.length > 1 ? s.series[1].balance - s.series[0].balance : 0;
  return { text: growth && per > 0 ? `never · +${fmt0(per)}/mo` : "never", cls: "neg" };
}

// --- the one caveat line ----------------------------------------------------
//
// Deliberately not prose about the feature (the mockup's two explanatory
// paragraphs were cut): every sentence here is about an INPUT that is missing,
// estimated or promotional, which is the part no number on the chart can say.
function chargeProvenance(v, p) {
  if (p.chargeRate == null) {
    return `No rows at all on this card in ${p.charge.months.join(", ")}, so there is no pace to measure and this line charges nothing — which flatters it.`;
  }
  const win = `this pay window alone ran ${fmt(v.netPurchases)}`;
  const short = p.charge.monthsWithRows < p.charge.monthCount
    ? ` Only ${p.charge.monthsWithRows} of those ${p.charge.monthCount} months has any rows, so the average is over a window the statements do not fill and reads calmer than the card is.`
    : "";
  return `${fmt(p.charge.net)} charged across ${p.charge.months.join(", ")} ÷ ${p.charge.monthCount} = ${fmt(p.chargeRate)}/mo; ${win}.${short}`;
}

function paintPayoffNote(v, p) {
  const bits = [];
  bits.push(`<b>Charge pace</b> ${chargeProvenance(v, p)}`);
  bits.push(`<b>Payments</b> ${p.scheduled.count
    ? `${fmt(p.scheduled.total)} across the ${plural(p.scheduled.span, "month")} from ${p.scheduled.first} to ${p.scheduled.last} (${plural(p.scheduled.count, "row")}) = ${fmt(p.payment)}/mo, carried forward past the last one the ledger holds.`
    : "the ledger has no payments scheduled on this card after today, so there is no plan to project and no payoff date."}`);
  if (p.apr == null) {
    bits.push(`<b>APR</b> none recorded for this card, so every line above projects at <b>0%</b> and the real payoff is later than it says. The limit line is hidden for the same reason.`);
  } else if (p.apr === 0) {
    bits.push(`<b>APR</b> 0% — promotional, with no end date recorded (decision #47), so these lines assume it holds. Enter <code>promo_apr_until</code> and the rate after it on the account and the projection will step up on schedule instead.`);
  }
  if (p.limit == null) bits.push(`<b>Credit limit</b> none recorded, so there is no limit line and no "hits the limit in N months" warning — the most useful thing on this chart is the one it cannot draw.`);
  else if (p.balance > p.limit) bits.push(`<b>Credit limit</b> already over it: ${fmt(p.balance)} owed against ${fmt(p.limit)}.`);
  if (p.pace.hitCap || p.stop.hitCap) bits.push(`One line ran the full 30-year horizon without clearing; it is drawn to the edge of the chart rather than to a date.`);
  $("#payoffNote").innerHTML = bits.map((b) => `<div>${b}</div>`).join("");
}

// --- the sliders ------------------------------------------------------------
//
// Ephemeral, and the panel says so. No Save, no POST, no localStorage — the
// one control that changes state is `↺ reset to my ledger plan`.
const whatIfInputs = (p) => whatIf || { payment: p.payment, charges: p.chargeRate || 0, apr: p.apr == null ? 0 : p.apr };
const SLIDER_LABEL = {
  payment: (w, p) => fmt0(w.payment) + (p.minimum > 0 && w.payment < p.minimum ? ` <span class="muted">&lt; min ${fmt0(p.minimum)}</span>` : ""),
  charges: (w) => fmt0(w.charges),
  apr: (w) => `${(w.apr * 100).toFixed(2)}%`,
};
const roundUp100 = (n) => Math.max(100, Math.ceil(n / 100) * 100);

function buildPayoffSliders(p) {
  const host = $("#payoffSliders"); host.innerHTML = "";
  const w = whatIfInputs(p);
  // Wide enough to model clearing the card in about three months, or triple
  // the current plan — a slider that tops out below "what if I threw a bonus
  // at it" can't answer the question people actually open this panel to ask.
  const payMax = roundUp100(Math.max(1000, p.balance / 3, p.payment * 3));
  const chgMax = roundUp100(Math.max(500, (p.chargeRate || 0) * 2));

  const defs = [
    { key: "payment", label: "Monthly payment", min: 0, max: payMax, step: 10, value: w.payment, scale: 1 },
    { key: "charges", label: "New charges / mo", min: 0, max: chgMax, step: 10, value: w.charges, scale: 1 },
    // The APR slider is in PERCENT because that is the unit on the card;
    // `scale` converts back to the fraction the engine takes.
    { key: "apr", label: "APR", min: 0, max: 35, step: 0.01, value: w.apr * 100, scale: 100 },
  ];
  for (const d of defs) {
    const wrap = document.createElement("div"); wrap.className = "sl";
    const k = document.createElement("span"); k.className = "k"; k.textContent = d.label;
    const val = document.createElement("span"); val.className = "v"; val.innerHTML = SLIDER_LABEL[d.key](w, p);
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = d.min; inp.max = Math.max(d.max, d.value); inp.step = d.step;
    inp.value = d.value; inp.dataset.key = d.key;
    inp.setAttribute("aria-label", d.label);
    inp.addEventListener("input", () => {
      const base = whatIfInputs(p);
      whatIf = { ...base, [d.key]: Number(inp.value) / d.scale };
      whatIfCard = p.accountId;
      paintPayoff();   // the what-if line and its row only; nothing is staged
    });
    wrap.append(k, val, inp);
    host.appendChild(wrap);
  }
}

$("#payoffReset").addEventListener("click", () => {
  if (!whatIf) return;
  whatIf = null;
  if (payoffCtx) { buildPayoffSliders(payoffCtx.payoff); paintPayoff(); }
});

// --- the [ Debit | Credit ] subtab switch -----------------------------------

function viewHref(v) {
  const url = new URL(location.href);
  url.searchParams.set("view", v);
  return url.pathname + "?" + url.searchParams.toString();
}
function renderSubtabSwitch() {
  const views = [{ key: "debit", href: viewHref("debit"), label: "Debit" }];
  // Zero cards: hide the Credit half entirely rather than offering a dead tab.
  if (state.cards.length) views.push({ key: "credit", href: viewHref("credit"), label: "Credit" });
  mountViewSwitch($("#subtabSwitch"), { active: state.view, views });
}
$("#subtabSwitch").addEventListener("click", (e) => {
  const a = e.target.closest("a"); if (!a) return;
  e.preventDefault();
  const v = new URL(a.href, location.href).searchParams.get("view");
  if (!v || v === state.view) return;
  switchView(v);
});
function switchView(v) {
  const leavingPending = state.view === "credit" ? (hasCardPending() || hasRulePending()) : hasPending();
  if (leavingPending && !confirm(`Discard unsaved changes and switch to ${v === "credit" ? "Credit" : "Debit"}?`)) return;
  if (leavingPending) { if (state.view === "credit") { clearCardPending(); clearRulePending(); } else clearPending(); }
  state.view = v;
  localStorage.setItem("paycheckView", v);
  const url = new URL(location.href); url.searchParams.set("view", v);
  history.replaceState(null, "", url);
  render();
}

function applyViewVisibility() {
  document.querySelectorAll("[data-view]").forEach((el) => { el.hidden = el.dataset.view !== state.view; });
  $("#debitView").hidden = state.view !== "debit";
  $("#creditView").hidden = state.view !== "credit";
}

// --- top-level render dispatch ----------------------------------------------

function render() {
  const isCurrent = inWin(TODAY);
  const rangeHTML = `${state.cadence} · ${state.window.start} → ${state.window.end}` + (isCurrent ? ` <span class="today-dot">• current</span>` : "");
  document.querySelectorAll(".winrange").forEach((el) => (el.innerHTML = rangeHTML));
  document.querySelectorAll(".navcurrent").forEach((el) => el.classList.toggle("on-current", isCurrent));
  $("#winTitle").textContent = `This Paycheck — ${currentPerson()?.name || state.account.name}`;

  renderSubtabSwitch();
  renderDebit();
  renderCredit();
  applyViewVisibility();
}

// --- Debit subtab (today's page, unchanged behavior) ------------------------

function renderDebit() {
  const v = computeView();
  $("#startBal").textContent = fmt(v.startBal);
  $("#incomeTotal").textContent = fmt(v.deposits);
  $("#outTotal").textContent = fmt(v.withdrawals);
  const endEl = $("#endBal"); endEl.textContent = fmt(v.endBal);
  endEl.classList.toggle("neg", v.endBal < 0); endEl.classList.toggle("pos", v.endBal >= 0);

  const banner = $("#banner");
  if (v.min < 0) {
    banner.className = "banner warn"; banner.hidden = false;
    const where = v.minRow ? `“${v.minRow.source || v.minRow.description || "an entry"}”` : "the starting balance";
    banner.textContent = `⚠ This pay period dips to ${fmt(v.min)} (at ${where}). Adjust amounts or you’ll overdraw.`;
  } else {
    banner.className = "banner ok"; banner.hidden = false;
    banner.textContent = `On track — ends the pay period at ${fmt(v.endBal)}.`;
  }

  renderChart(v.rows);

  const tbody = $("#rows"); tbody.innerHTML = "";
  $("#empty").hidden = v.rows.length > 0;
  for (const r of v.rows) tbody.appendChild(rowEl(r, v.balById.get(r._id)));
  renderAddRow();
  renderControls();
}

function rowEl(row, proj) {
  const tr = document.createElement("tr");
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  else if (proj < 0) tr.className = "neg-row";
  const dis = !!row._deleted;

  tr.appendChild(cell("date", row.txn_date, "txn_date", "col-date", null, "", dis));
  tr.appendChild(cell("text", row.description, "description", "", "categories", "Category", dis));
  tr.appendChild(cell("text", row.source, "source", "", null, "Source / Recipient", dis));
  tr.appendChild(cell("number", row.deposit || "", "deposit", "num col-dep", null, "", dis));
  tr.appendChild(cell("number", row.withdrawal || "", "withdrawal", "num col-wd", null, "", dis));

  const projTd = document.createElement("td");
  projTd.className = "proj col-proj" + (!row._deleted && proj < 0 ? " neg" : "");
  projTd.textContent = row._deleted ? "—" : fmt(proj);
  tr.appendChild(projTd);

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button");
  del.className = "del" + (row._deleted ? " restore" : "");
  del.textContent = row._deleted ? "↺" : "×"; del.title = row._deleted ? "Restore" : "Delete";
  del.onclick = () => toggleDelete(row, "debit");
  act.appendChild(del); tr.appendChild(act);

  tr.querySelectorAll("input[data-field]").forEach((inp) => inp.addEventListener("change", () => stageEdit(row, inp.dataset.field, inp.value, "debit")));
  return tr;
}

function cell(type, value, field, cls = "", list = null, ph = "", disabled = false) {
  const td = document.createElement("td"); if (cls) td.className = cls;
  const inp = document.createElement("input");
  inp.type = type; inp.value = value ?? ""; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
  if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
  if (disabled) inp.disabled = true;
  inp.dataset.field = field; td.appendChild(inp); return td;
}

function stageEdit(row, field, value, target = "debit") {
  const s = sliceFor(target);
  if (row._new) { const n = s.news.find((x) => x._tempId === row._id); if (n) n[field] = value; }
  else { const e = s.edits.get(row._id) || {}; e[field] = value; s.edits.set(row._id, e); }
  // Fixing a card row's category by hand is the moment to learn a rule from it
  // (T30b). Offered, never assumed — and skipped entirely when a rule already
  // says the same thing. `_learning` guards the re-entrant case: applying the
  // rules in bulk calls stageEdit in a loop and must not pop an offer per row.
  if (target === "credit" && field === "description" && !applyingRules) offerRule(row, value);
  target === "credit" ? renderCredit() : renderDebit();
}
let applyingRules = false;
function toggleDelete(row, target = "debit") {
  const s = sliceFor(target);
  if (row._new) s.news = s.news.filter((x) => x._tempId !== row._id);
  else if (s.dels.has(row._id)) s.dels.delete(row._id);
  else { s.dels.add(row._id); s.edits.delete(row._id); }
  target === "credit" ? renderCredit() : renderDebit();
}

// Add row defaults to the window's payday (a date inside the window).
const freshDraft = () => ({ txn_date: state.window ? state.window.start : TODAY, description: "", source: "", deposit: "", withdrawal: "" });
let addDraft = freshDraft();
function renderAddRow() {
  const foot = $("#addFoot"); foot.innerHTML = "";
  const tr = document.createElement("tr"); tr.className = "add";
  const mk = (type, key, cls, list, ph) => {
    const td = document.createElement("td"); if (cls) td.className = cls;
    const inp = document.createElement("input"); inp.type = type; inp.value = addDraft[key]; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (addDraft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addRow(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("date", "txn_date", "col-date"));
  tr.appendChild(mk("text", "description", "", "categories", "Category"));
  tr.appendChild(mk("text", "source", "", null, "Source / Recipient"));
  tr.appendChild(mk("number", "deposit", "num col-dep", null, "0.00"));
  tr.appendChild(mk("number", "withdrawal", "num col-wd", null, "0.00"));
  tr.appendChild(document.createElement("td"));
  const act = document.createElement("td"); act.className = "row-actions";
  const add = document.createElement("button"); add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = addRow; act.appendChild(add); tr.appendChild(act);
  foot.appendChild(tr);
}
// `note` and `projected` ride along when the caller set them, which is T30's
// projection path and nothing else — an ordinary add leaves both undefined, so
// the row posts exactly as it did before.
const pushNewTo = (target, t) => sliceFor(target).news.push({ _tempId: "new-" + (++tempId), created_at: new Date().toISOString(), txn_date: t.txn_date, description: t.description, source: t.source, deposit: t.deposit, withdrawal: t.withdrawal, note: t.note, projected: t.projected });

function addRow() {
  if (!addDraft.txn_date) return toast("Date is required");
  if (!addDraft.deposit && !addDraft.withdrawal) return toast("Enter a deposit or withdrawal");
  if (!inWin(addDraft.txn_date) && !confirm("That date is outside this pay window — add it anyway?")) return;
  const base = { ...addDraft };
  pushNewTo("debit", base);  // the entry itself is always added to this period
  addDraft = freshDraft();
  render();
  openRecurModal(base, "debit"); // then offer to repeat it going forward
}

// --- Credit subtab -----------------------------------------------------------

function renderCredit() {
  buildCardSelect();

  if (!state.cards.length) {
    $("#cardEmpty").hidden = false;
    $("#cardMain").hidden = true;
    $("#cardBanner").hidden = true;
    $("#cardIdentity").hidden = true;
    $("#cardCoverage").hidden = true;
    renderPayoff(null);
    renderCardShares(null);
    $("#owedLabel").textContent = "Owed";
    for (const id of ["#owedTotal", "#chargedTotal", "#paidTotal", "#debtChangeTotal"]) $(id).textContent = "—";
    for (const id of ["#owedSub", "#chargedSub", "#paidSub", "#debtChangeSub"]) $(id).textContent = "";
    $("#uploadBtn").disabled = true;
    return;
  }
  $("#cardEmpty").hidden = true;
  $("#cardMain").hidden = false;
  $("#uploadBtn").disabled = !state.card.account;

  // `computeCardView()` already computes the household total over the staged
  // view of every card; with no card selected there is no staged view, so ask
  // the engine for the plain one rather than leaving the headline blank.
  const v = computeCardView();
  const household = v ? v.household : totalDebt(state.cardTxns, state.cards, { owner: state.currentUser });
  renderCardShares(household);
  paintOwedStat(household);

  if (!v) {
    $("#cardBanner").hidden = true;
    $("#cardIdentity").hidden = true;
    $("#cardCoverage").hidden = true;
    renderPayoff(null);
    for (const id of ["#chargedTotal", "#paidTotal", "#debtChangeTotal"]) $(id).textContent = "—";
    for (const id of ["#chargedSub", "#paidSub", "#debtChangeSub"]) $(id).textContent = "";
    return;
  }

  paintWindowStats(v);
  paintCardBanner(v);
  paintCardIdentity(v);
  paintCardCoverage(v);
  renderCardMeta(v, household.cards.find((x) => x.accountId === v.accountId));
  renderCardChart(v);
  renderPayoff(v);

  const tbody = $("#cardRows"); tbody.innerHTML = "";
  $("#cardLedgerEmpty").hidden = v.rows.length > 0;
  for (const r of v.rows) {
    tbody.appendChild(cardRowEl(r, v.balById.get(r._id)));
    const pair = pairNoteFor(r);
    if (pair) tbody.appendChild(pair);
    const proj = projNoteFor(r);
    if (proj) tbody.appendChild(proj);
  }
  renderCardAddRow();
  renderCardControls();
  renderRulesPanel(v);
  renderRecurPanel();
}

const pct0 = (frac) => `${Math.round(frac * 100)}%`;
const signedFmt = (n) => (n > 0 ? "+" : "") + fmt(n);

// "Owed — all N cards": `totalDebt()` across the owner's card set (#24), as of
// TODAY. Not floored at zero — cards.js is explicit that flooring a credit
// balance makes the household total wrong by however much you are ahead.
function paintOwedStat(h) {
  $("#owedLabel").textContent = `Owed — all ${h.cardCount} card${h.cardCount === 1 ? "" : "s"}`;
  const el = $("#owedTotal");
  el.textContent = fmt(h.total);
  el.classList.toggle("neg", h.total > 0.005);
  el.classList.toggle("pos", h.total <= 0.005);

  // Decision #58: T34 mirrored every planned payment onto the card side and
  // there are no planned charges, so the all-dates figure is a PROJECTION and
  // only today's reading is a balance. Printing one number for both would be
  // the quietest possible lie on this page — so both are here, short enough to
  // sit under the figure, with the sentence each one needs on the tooltip.
  const parts = [`as of ${h.asOf}`], why = [];
  if (Math.abs(h.projected - h.total) > 0.005) {
    parts.push(`${fmt(h.projected)} projected`);
    why.push(`${fmt(h.projected)} is what is left once every payment already written into the ledger has landed — a projection, not a balance.`);
  }
  if (h.utilization != null) {
    parts.push(`${pct0(h.utilization)} used`);
    why.push(h.limitKnown === h.cardCount
      ? `${pct0(h.utilization)} of ${fmt(h.limit)} in limits, across all ${h.cardCount} cards.`
      : `${pct0(h.utilization)} of ${fmt(h.limit)} in limits — only ${h.limitKnown} of ${h.cardCount} cards has one recorded, so the other ${h.cardCount - h.limitKnown} are left out of both sides.`);
  }
  const sub = $("#owedSub");
  sub.textContent = parts.join(" · ");
  sub.title = why.join("\n");
}

// Charged / Paid / Debt change, over the pay window. "Charged" is NET of
// refunds so it matches the donut; the gross pair rides in the secondary line,
// because "$1,223.80 of purchases" and "$1,246.40 charged less $22.60 returned"
// are different sentences and the stat should be able to say the second.
function paintWindowStats(v) {
  $("#chargedTotal").textContent = fmt(v.netPurchases);
  $("#chargedSub").textContent = v.refunds > 0.005
    ? `${fmt(v.charges)} charged − ${fmt(v.refunds)} refunded`
    : `${v.chargeCount} charge${v.chargeCount === 1 ? "" : "s"}`;

  $("#paidTotal").textContent = fmt(v.payments);
  $("#paidSub").textContent = `${v.paymentCount} payment${v.paymentCount === 1 ? "" : "s"}`;

  const dcEl = $("#debtChangeTotal");
  dcEl.textContent = signedFmt(v.debtChange);
  dcEl.classList.toggle("neg", v.debtChange > 0.005);
  dcEl.classList.toggle("pos", v.debtChange <= 0.005);
  const dcSub = $("#debtChangeSub");
  dcSub.textContent = `${fmt(v.openingOwed)} → ${fmt(v.closingOwed)}`;
  dcSub.title = `Owed going into ${v.window.from}, and owed coming out of ${v.window.to}.`;
}

// The verdict, in words. The arithmetic behind it is in `#cardIdentity` — this
// is the one sentence that makes the subtab worth having, not a second copy of
// the equation.
function paintCardBanner(v) {
  const banner = $("#cardBanner");
  banner.hidden = false;
  const owing = `<b>${fmt(v.closingOwed)}</b>`;
  if (!v.reconciles || !v.balanceAgrees) {
    banner.className = "banner warn";
    banner.innerHTML = `⚠ This window does not reconcile: ${fmt(v.openingOwed)} owed going in plus a ${fmt(v.debtChange)} change should leave ${fmt(v.closingOwed)}.`
      + (v.balanceAgrees ? "" : ` The table's running Owed column ends at <b>${fmt(round2(-v.endBal))}</b> instead.`)
      + ` Treat every figure on this subtab as suspect until it does.`;
  } else if (Math.abs(v.debtChange) < 0.005) {
    banner.className = "banner ok";
    banner.innerHTML = `Flat this pay period — charged ${fmt(v.netPurchases)}, paid ${fmt(v.payments)}, still owing ${owing}.`;
  } else if (v.debtChange > 0) {
    banner.className = "banner warn";
    banner.innerHTML = `Charging faster than you're paying — this card ends the pay period owing ${owing}, up <b>${fmt(v.debtChange)}</b>.`;
  } else {
    banner.className = "banner ok";
    banner.innerHTML = `Paying down faster than you're charging — this card ends the pay period owing ${owing}, down <b>${fmt(-v.debtChange)}</b>.`;
  }
}

// Both identities, on the page. The point of printing them is that they are
// CHECKABLE: every term is shown, including the two that are normally zero, so
// a reader can add the line up rather than trusting that someone did.
function paintCardIdentity(v) {
  const el = $("#cardIdentity");
  el.hidden = false;
  const ok = (good) => `<span class="tag ${good ? "ok" : "warn"}">${good ? "✓" : "⚠"}</span>`;

  // Two terms in an ordinary window. A balance transfer (#47) or an issuer
  // reversal adds its own rather than being folded into either side — the same
  // move csp.js makes with `excluded`: a dollar the headline doesn't want is
  // still shown somewhere instead of absorbed into one that doesn't fit it.
  const terms = [`<b>${fmt(v.netPurchases)}</b> charged`, `− <b>${fmt(v.payments)}</b> paid`];
  if (Math.abs(v.transfers) > 0.005) {
    terms.push(`${v.transfers > 0 ? "+" : "−"} <b>${fmt(Math.abs(v.transfers))}</b> balance ${v.transfers > 0 ? "transferred onto" : "moved off"} this card`);
  }
  if (Math.abs(v.adjustments) > 0.005) {
    terms.push(`${v.adjustments > 0 ? "+" : "−"} <b>${fmt(Math.abs(v.adjustments))}</b> issuer adjustment`);
  }

  const lines = [
    `${terms.join(" ")} = <b>${signedFmt(v.debtChange)}</b> debt change ${ok(v.reconciles)}`,
    `<b>${fmt(v.openingOwed)}</b> owed going in ${v.debtChange < 0 ? "−" : "+"} <b>${fmt(Math.abs(v.debtChange))}</b> = <b>${fmt(v.closingOwed)}</b> owed coming out ${ok(v.reconciles && v.balanceAgrees)}`,
  ];
  const split = projectedSplitHTML(v);
  if (split) lines.push(split);
  // Nothing in the window: no split to report and nothing to go look at.
  if (v.count) {
    lines.push(`<a href="${cardLedgerHref("")}" title="Opens the Ledger on this card and this pay window">View all ${v.count} row${v.count === 1 ? "" : "s"} in the Ledger →</a>`);
  }

  el.innerHTML = lines.map((t) => `<span class="line">${t}</span>`).join("");
}

// To-date vs. projected, with the same labeling the CSP uses and for the same
// reason: the ledger runs to 2027-11, so a pay window reaching past today is
// the common case, and part of every "charged" is the ledger's own forecast.
function projectedSplitHTML(v) {
  if (!v.windowProjected || !v.count) return "";
  const d = v.toDate, p = v.projected;
  if (!p.count) {
    return `<span class="proj">this window runs past ${TODAY}</span>, but nothing in it is scheduled after today — every figure above is history`;
  }
  return `<span class="proj">this window runs past ${TODAY}</span> — to date <b>${fmt(d.netPurchases)}</b> charged, <b>${fmt(d.payments)}</b> paid`
    + ` · projected <b>${fmt(p.netPurchases)}</b> charged, <b>${fmt(p.payments)}</b> paid`
    + ` (${p.count} row${p.count === 1 ? "" : "s"} dated after today)`;
}

// T28's coverage report, on the page. A month the card has no rows for
// UNDER-reports rather than mis-attributes, which is the correct failure and an
// invisible one — a quiet pay period looks like restraint and is actually a
// statement nobody loaded.
//
// Two different ways a window can be short of data, and the month report alone
// can only see the first. T34 mirrored every PLANNED payment onto the card
// side, so a pay window in 2027 has a row, reports "1 of 1 month covered", and
// contains nothing anybody observed. `seeded_range` — what T26b actually loaded
// from statements — is what answers "is there anything real in here", and on
// this ledger that is the common case, not the edge one.
//
// The pill is about the SELECTED card; the title carries all of them, because
// the "Owed — all N cards" stat above is only as good as the worst of them.
function paintCardCoverage(v) {
  const el = $("#cardCoverage"), c = v.coverage;
  const mine = c.cards.find((x) => x.accountId === v.accountId);
  if (!c.anyCards || !c.total || !mine) { el.hidden = true; return; }
  el.hidden = false;
  const n = (k) => `${k} month${k === 1 ? "" : "s"}`;
  const seeded = mine.seededRange;
  const { from, to } = v.window;
  const beyond = !seeded || to > seeded.to || from < seeded.from;

  el.classList.toggle("partial", beyond || mine.missing.length > 0);
  if (!seeded) el.textContent = "no statements ever loaded for this card";
  else if (mine.missing.length) el.textContent = `no rows at all in ${mine.missing.join(", ")}`;
  else if (to > seeded.to) el.textContent = `statements end ${seeded.to} — this window runs past them`;
  else if (from < seeded.from) el.textContent = `statements start ${seeded.from} — this window opens before them`;
  else el.textContent = `✓ statements cover all ${n(c.total)} this window touches`;

  el.title = c.cards
    .map((card) => `${card.name}: rows in ${card.months.length}/${c.total} of this window's months`
      + (card.missing.length ? ` · none in ${card.missing.join(", ")}` : "")
      + (card.seededRange ? ` · statements loaded ${card.seededRange.from} → ${card.seededRange.to}` : " · no statements loaded"))
    .join("\n")
    + (beyond || mine.missing.length
      ? "\n\nBeyond the loaded statements a window holds only what the ledger predicted — the planned payments T34 mirrored"
        + " onto the card, and no charges at all. Debt falling in such a window is a projection, not a payment someone made."
      : "");
}

// A projected row has to be obvious as a GUESS. It is a real ledger row — it
// counts in the owed figure, the donut and the CSP, which is the point of
// writing it down — but it was predicted by T30's detector, not observed on a
// statement, and the statement row it is waiting for will replace it in place.
function projNoteFor(row) {
  if (row._deleted || !row.projected) return null;
  const p = parseProjection(row.projected);
  const late = row.txn_date < TODAY;
  const tr = document.createElement("tr"); tr.className = "pairnote";
  const td = document.createElement("td"); td.colSpan = 7;
  td.innerHTML = `⟳ projected <b>${p.cadence}</b> from <b>${p.stem}</b> — a real statement row replaces this one` +
    (late ? ` <span class="tag warn">past due, no statement row yet</span>` : ` <span class="tag">projection</span>`);
  tr.appendChild(td);
  return tr;
}

// The issuer is the short, readable label — until two visible cards share one,
// which this household actually does: Woody services a Chase card and Rajna has
// her own, and two chips both reading "Chase" is worse than two long ones.
function shortCardName(c) {
  const issuer = c.data?.issuer;
  if (!issuer) return c.name;
  const shared = state.cards.filter((x) => x.data?.issuer === issuer).length > 1;
  return shared ? c.name : issuer;
}

function buildCardSelect() {
  const sel = $("#cardSelect");
  sel.innerHTML = "";
  for (const c of state.cards) {
    const opt = document.createElement("option");
    opt.value = c.id; opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = state.card.accountId ?? "";
}
// One chip per card, from `totalDebt()`'s per-card contributions rather than a
// second derivation — the chips, the headline and the Dashboard tile (T35) all
// read the same function, so they cannot disagree about who owes what. Kept in
// dropdown order, not debt order, so the two controls match.
function renderCardShares(household) {
  const host = $("#cardShares"); host.innerHTML = "";
  if (!household) return;
  const byId = new Map(household.cards.map((c) => [c.accountId, c]));
  for (const c of state.cards) {
    const d = byId.get(c.id);
    const b = document.createElement("button");
    b.type = "button"; b.className = "share" + (c.id === state.card.accountId ? " on" : "");
    b.textContent = `${shortCardName(c)} ${fmt(d ? d.debt : 0)}`;
    b.title = !d || !d.rows
      ? `${c.name} — no rows on this card yet`
      : d.debt < 0
        ? `${c.name} — overpaid by ${fmt(-d.debt)} as of ${household.asOf}`
        : `${c.name} — ${fmt(d.debt)} owed as of ${household.asOf}, ${fmt(d.projected)} once the ledger's planned payments land`;
    b.onclick = () => selectCard(c.id);
    host.appendChild(b);
  }
}
$("#cardSelect").addEventListener("change", (e) => selectCard(e.target.value));

function selectCard(id) {
  if (id === state.card.accountId) return;
  if (hasCardPending() && !confirm("Discard unsaved changes and switch card?")) { buildCardSelect(); return; }
  state.card.accountId = id;
  localStorage.setItem("cardsAccount", id);
  const url = new URL(location.href); url.searchParams.set("account", id);
  history.replaceState(null, "", url);
  selectCardSlice();   // no fetch — every card's rows are already loaded
  render();
}

// The card's own facts, every one of them from `cardSummary` / `statementCycle`
// / `statementBalance` / `minimumDue`.
//
// Unknown prints the word "unknown", never a dash and never a fallback: T25
// left `statement_day`, `due_day` and `min_payment` unrecorded on all six cards
// rather than guessing them, so a confident "closes on the 1st" would be this
// page inventing a billing cycle. It resolves the day the user enters the day.
function renderCardMeta(v, mine) {
  const account = state.card.account;
  const host = $("#cardMeta"); host.innerHTML = "";
  const row = (label, valueHTML, title) => {
    const div = document.createElement("div");
    div.innerHTML = `${label}<b>${valueHTML}</b>`;
    if (title) div.title = title;
    host.appendChild(div);
  };
  const est = (text) => `<span class="est">${text}</span>`;

  row("opening owed", fmt(v.openingOwed), `What this card owed going into ${v.window.from}.`);
  // Decision #58: the ledger runs to 2027-11 and the window can sit anywhere in
  // it, so what a person recognizes as "what I owe" is usually neither end of
  // the window. This one figure therefore does NOT move when you page through
  // windows, and `totalDebt`'s per-card contribution is where it comes from —
  // the same number the chip above shows, not a second derivation of it.
  const owedToday = mine ? mine.debt : v.owedToDate;
  row("owed today", fmt(owedToday), `What this card owes as of ${TODAY}, whichever window is in view.`);

  const imported = account.data?.statements;
  if (v.statement) {
    row("statement balance", fmt(v.statement.balance),
      `Billed by the statement that closed ${v.statement.cycle.end}; the cycle now accruing runs ${v.statement.accruing.start} → ${v.statement.accruing.end}.`);
  } else if (imported?.current_balance != null) {
    row("statement balance", `${fmt(imported.current_balance)}${est("imported")}`,
      `${fmt(imported.current_balance)} as of ${imported.as_of || "an unrecorded date"}, from ${imported.source || "the last statement load"}. `
      + `No statement day is recorded on this card, so there is no cycle to bill from and this is the loaded figure, not a computed one.`);
  } else {
    row("statement balance", "unknown", "No statement day recorded and no statement loaded for this card.");
  }

  row("credit limit", v.creditLimit != null ? fmt(v.creditLimit) : "unknown",
    v.creditLimit != null ? "" : "No credit limit recorded for this card.");
  // Utilization is a present-tense fact about the card, so it reads today's
  // debt too — the window you happen to be looking at does not change how much
  // of the limit is used up right now.
  const util = mine ? mine.utilization : v.utilization;
  if (util != null) {
    const u = Math.round(util * 100);
    row("utilization", `${u}%<span class="util"><i class="${u >= 80 ? "hot" : ""}" style="width:${Math.min(100, Math.max(0, u))}%"></i></span>`,
      `${fmt(owedToday)} owed today against a ${fmt(v.creditLimit)} limit.`);
  } else {
    row("utilization", "unknown", "Utilization needs a credit limit, and none is recorded for this card.");
  }
  row("APR", v.apr != null ? `${(v.apr * 100).toFixed(2)}%` : "unknown",
    v.apr === 0 ? "0% — a promotional rate, which will have an end date the ledger does not know yet." : "");

  row("payment due", v.cycle?.dueDate || "unknown",
    v.cycle
      ? `The first ${ordinal(v.cycle.dueDay)} after the ${v.cycle.end} close.`
      : "No statement day is recorded on this card, so there is no cycle and no due date. Enter one on the account to get both.");

  // The minimum is estimated on every card today (none states one), so it is
  // labelled rather than passed off as the issuer's number.
  const owedForMin = v.statement ? v.statement.balance : owedToday;
  const min = minimumDue(account, owedForMin);
  const estimated = minimumDueEstimated(account);
  // The tag earns its place only on a figure that was actually estimated; an
  // "est." on $0.00 is a label with nothing behind it.
  row("minimum", `${fmt(min)}${estimated && min > 0 ? est("est.") : ""}`,
    estimated
      ? `This card states no minimum, so this is the industry shape: the greater of 2% of ${fmt(owedForMin)} and $25, capped at the balance itself.`
      : "Stated by the card.");
}

function cardRowEl(row, bal) {
  const owed = round2(-(bal ?? 0));
  const tr = document.createElement("tr");
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  else if (owed < 0) tr.className = "neg-row"; // negative owed = overpaid — the inverted highlight
  const dis = !!row._deleted;

  tr.appendChild(cell("date", row.txn_date, "txn_date", "col-date", null, "", dis));
  tr.appendChild(cell("text", row.description, "description", "", "categories", "Category", dis));
  tr.appendChild(cell("text", row.source, "source", "", null, "Merchant", dis));
  tr.appendChild(cell("number", row.withdrawal || "", "withdrawal", "num col-wd", null, "", dis));
  tr.appendChild(cell("number", row.deposit || "", "deposit", "num col-dep", null, "", dis));

  const owedTd = document.createElement("td");
  owedTd.className = "proj col-proj" + (!row._deleted && owed < 0 ? " neg" : "");
  owedTd.textContent = row._deleted ? "—" : fmt(owed);
  tr.appendChild(owedTd);

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button");
  del.className = "del" + (row._deleted ? " restore" : "");
  del.textContent = row._deleted ? "↺" : "×"; del.title = row._deleted ? "Restore" : "Delete";
  del.onclick = () => toggleDelete(row, "credit");
  act.appendChild(del); tr.appendChild(act);

  tr.querySelectorAll("input[data-field]").forEach((inp) => inp.addEventListener("change", () => stageEdit(row, inp.dataset.field, inp.value, "credit")));
  return tr;
}

// A payment row with a transfer_id gets a sub-row naming its pair — an
// unpaired payment has to be noticeable to be fixable. Resolved against the
// WHOLE ledger now that T32 loads it, so a card-to-card balance transfer (#47)
// resolves instead of reading as unpaired, and so does a payment from an
// account other than the one Debit happens to be showing.
function pairNoteFor(row) {
  if (row._deleted || !row.transfer_id) return null;
  const match = state.allTxns.find((t) => t.transfer_id === row.transfer_id && t.id !== row._id && t.account_id !== row.account_id);
  if (!match) return null;
  const acct = state.accountsById.get(match.account_id);
  const signed = (Number(match.deposit) || 0) - (Number(match.withdrawal) || 0);
  const tr = document.createElement("tr"); tr.className = "pairnote";
  const td = document.createElement("td"); td.colSpan = 7;
  td.innerHTML = `⇄ paired with <b>${acct ? acct.name : "another account"}</b> · ${match.txn_date} · ${signed < 0 ? "−" : ""}${fmt(Math.abs(signed))} <span class="tag ok">transfer_id</span>`;
  tr.appendChild(td);
  return tr;
}

const freshCardDraft = () => ({ txn_date: state.window ? state.window.start : TODAY, description: "", source: "", withdrawal: "", deposit: "" });
let cardAddDraft = freshCardDraft();
function renderCardAddRow() {
  const foot = $("#cardAddFoot"); foot.innerHTML = "";
  const tr = document.createElement("tr"); tr.className = "add";
  const mk = (type, key, cls, list, ph) => {
    const td = document.createElement("td"); if (cls) td.className = cls;
    const inp = document.createElement("input"); inp.type = type; inp.value = cardAddDraft[key]; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (cardAddDraft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addCardRow(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("date", "txn_date", "col-date"));
  tr.appendChild(mk("text", "description", "", "categories", "Category"));
  tr.appendChild(mk("text", "source", "", null, "Merchant"));
  tr.appendChild(mk("number", "withdrawal", "num col-wd", null, "0.00"));
  tr.appendChild(mk("number", "deposit", "num col-dep", null, "0.00"));
  tr.appendChild(document.createElement("td"));
  const act = document.createElement("td"); act.className = "row-actions";
  const add = document.createElement("button"); add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = addCardRow; act.appendChild(add); tr.appendChild(act);
  foot.appendChild(tr);
}

function addCardRow() {
  if (!state.card.account) return;
  if (!cardAddDraft.txn_date) return toast("Date is required");
  if (!cardAddDraft.withdrawal && !cardAddDraft.deposit) return toast("Enter a charge or credit");
  if (!inWin(cardAddDraft.txn_date) && !confirm("That date is outside this pay window — add it anyway?")) return;
  const base = { ...cardAddDraft };
  pushNewTo("credit", base);
  cardAddDraft = freshCardDraft();
  render();
  openRecurModal(base, "credit"); // the same once-or-repeating modal Debit uses, no extraction needed
}

const cardPendingCount = () => state.card.edits.size + state.card.dels.size + state.card.news.length;
const hasCardPending = () => cardPendingCount() > 0;
function renderCardControls() {
  const n = cardPendingCount();
  const save = $("#cardSaveBtn"); save.disabled = n === 0; save.textContent = n ? `Save to ledger (${n})` : "Save to ledger";
  $("#cardDiscardBtn").hidden = n === 0;
  $("#cardDirtyNote").hidden = n === 0;
}

$("#cardSaveBtn").addEventListener("click", async () => {
  if (!hasCardPending() || !state.card.account) return;
  const n = cardPendingCount();
  $("#cardSaveBtn").disabled = true;
  try {
    for (const nr of state.card.news) {
      await api("/api/transactions", { method: "POST", body: { account_id: state.card.account.id, owner: state.card.account.owner, txn_date: nr.txn_date, description: nr.description, source: nr.source, deposit: Number(nr.deposit) || 0, withdrawal: Number(nr.withdrawal) || 0, note: nr.note ?? "", projected: nr.projected ?? null } });
    }
    for (const [id, fields] of state.card.edits) await api(`/api/transactions/${id}`, { method: "PATCH", body: fields });
    for (const id of state.card.dels) await api(`/api/transactions/${id}`, { method: "DELETE" });
    await loadCardLedger();
    render();
    toast(`Saved ${n} change${n === 1 ? "" : "s"} to the ledger`);
  } catch (e) { toast("Error: " + e.message); renderCardControls(); }
});
$("#cardDiscardBtn").addEventListener("click", () => { if (!hasCardPending()) return; clearCardPending(); render(); toast("Changes discarded"); });

// --- statement upload + review modal ----------------------------------------
//
// decision #27's no-leak guarantee: the file is read with FileReader and
// parsed in shared/statement-import.js, in this tab, and only already-parsed
// rows ever leave the browser (POSTed to /api/transactions/bulk). The File
// object itself is never stored and the input is cleared the instant it's
// read. Cancel discards everything in memory — nothing has touched the DB.

const CARD_IMPORT_CATEGORIES = ["Groceries", "Food", "Bill", "Transportation", "Misc", "Fun", "Housing", "Savings", "Investments", "Loan Payment", "Interest", "Transfer"];
const signedNet = (r) => round2((Number(r.withdrawal) || 0) - (Number(r.deposit) || 0));

let importState = null;

$("#uploadBtn").addEventListener("click", () => { if (state.card.account) $("#importFile").click(); });
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // the File object is never kept beyond this read
  if (!file || !state.card.account) return;
  const text = await file.text();
  startImport(text);
});

function startImport(text) {
  const acct = state.card.account;
  let parsed;
  try {
    parsed = readStatement(text, { accountId: acct.id });
  } catch (err) {
    if (err instanceof StatementImportError) { toast(`Import failed: ${err.message}`); return; }
    throw err;
  }
  if (parsed.needsMapping) { toast("Unrecognized statement format — this issuer isn't supported yet"); return; }

  // Detection is on the CSV's own header, not the selected card — nothing
  // stops someone uploading Apple's export while Citi is the active card. A
  // mismatch would silently attribute one card's charges to another's ledger.
  const acctIssuer = acct.data?.issuer;
  if (acctIssuer && parsed.issuer !== acctIssuer && !confirm(`This looks like a ${parsed.issuer} statement, but ${acct.name} is a ${acctIssuer} card. Import onto ${acct.name} anyway?`)) return;

  const diff = diffAgainstLedger(parsed.rows, state.card.txns);

  // T30: the two passes that run between parsing and showing the modal.
  //
  // (1) SUPERSEDE. A projection carries no `external_id` and its date is a
  //     guess, so neither of `diffAgainstLedger`'s matchers can see it — the
  //     real charge would land as a brand-new row beside the projection that
  //     predicted it, counting the month twice. Matching on merchant stem
  //     inside half a cadence step turns each one into an `update_id` against
  //     the projection's own row, which the bulk route then overwrites and
  //     un-flags.
  // (2) THE RULES. `applyRules` over the fresh rows is what makes the modal
  //     open pre-categorized. A row no rule claims keeps the issuer's
  //     first-pass category and, if that was the catch-all, shows as needing an
  //     answer — never a guess.
  const sup = supersedeProjections(diff.fresh, state.card.txns, { today: TODAY });
  const ruled = applyRules(sup.fresh, compiledRules(), { accountId: acct.id });
  const fresh = sup.fresh.map((r, i) => ({ ...r, description: ruled[i].description, _rule: ruled[i]._rule, _needsCategory: ruled[i]._needsCategory }));

  importState = {
    issuer: parsed.issuer,
    span: parsed.span,
    rowCount: parsed.rowCount,
    fresh,
    superseded: sup.superseded.map((x) => ({
      ...x,
      // The real row's category goes through the rules too; the projection's
      // was only ever the merchant's historical category.
      row: { ...x.row, description: applyRules([x.row], compiledRules(), { accountId: acct.id })[0].description },
    })),
    duplicates: diff.duplicates,
    conflicts: diff.conflicts.map((c) => ({ ...c, decision: "update" })),
    totals: diff.totals,
    included: new Set(fresh.map((_, i) => i)),
    categories: new Map(fresh.map((r, i) => [i, r.description])),
    // What the user changed by hand, so confirm can offer to learn it.
    learned: new Map(),
  };
  renderImportModal();
  $("#impScrim").classList.add("open");
}

function renderImportModal() {
  const s = importState;
  const acct = state.card.account;
  $("#impTitle").textContent = `Import statement — ${acct.name}`;
  const spanText = s.span.length ? `${s.span[0]} → ${s.span[1]}` : "no rows";
  $("#impSummary").innerHTML = `Detected <b style="color:var(--text)">${s.issuer}</b> · ${spanText} · ${s.rowCount} rows parsed`;

  const pills = $("#impPills"); pills.innerHTML = "";
  const addPill = (cls, text) => { const sp = document.createElement("span"); sp.className = `pill ${cls}`; sp.textContent = text; pills.appendChild(sp); };
  addPill("new", `${s.fresh.length} new`);
  if (s.duplicates.length) addPill("dup", `${s.duplicates.length} already imported`);
  if (s.conflicts.length) addPill("chg", `${s.conflicts.length} amount changed`);
  // T30: rows that land ON a projection rather than beside it.
  if (s.superseded?.length) addPill("chg", `${s.superseded.length} replace a projection`);

  const confHost = $("#impConflicts"); confHost.innerHTML = "";
  for (const c of s.conflicts) {
    const div = document.createElement("div"); div.className = "conflict";
    const info = document.createElement("span");
    info.innerHTML = `⚠ settled at a different amount than the pending charge on file<br>
      <span class="muted sm">${c.row.txn_date} · ${c.row.source} · <b style="color:var(--text)">${fmt(Math.abs(c.from))} → ${fmt(Math.abs(c.to))}</b></span>`;
    const sp = document.createElement("span"); sp.className = "sp";
    const upd = document.createElement("button"); upd.className = c.decision === "update" ? "btn" : "btn ghost"; upd.textContent = "update";
    const skip = document.createElement("button"); skip.className = c.decision === "skip" ? "btn" : "btn ghost"; skip.textContent = "skip";
    upd.onclick = () => { c.decision = "update"; renderImportModal(); };
    skip.onclick = () => { c.decision = "skip"; renderImportModal(); };
    div.append(info, sp, upd, skip);
    confHost.appendChild(div);
  }

  const tbody = $("#impRows"); tbody.innerHTML = "";
  s.fresh.forEach((r, i) => {
    const tr = document.createElement("tr");
    const isPay = r.kind === "payment" || r.kind === "balance_transfer";
    if (!isPay && !r.description) tr.className = "needcat";
    if (isPay) tr.className = "ispay";

    const cbTd = document.createElement("td");
    const chk = document.createElement("input"); chk.type = "checkbox"; chk.checked = s.included.has(i);
    chk.onchange = () => { if (chk.checked) s.included.add(i); else s.included.delete(i); renderImportTotals(); };
    cbTd.appendChild(chk); tr.appendChild(cbTd);

    const dateTd = document.createElement("td"); dateTd.className = "num"; dateTd.textContent = r.txn_date; tr.appendChild(dateTd);
    const merchTd = document.createElement("td"); merchTd.textContent = r.source; tr.appendChild(merchTd);

    const catTd = document.createElement("td");
    if (isPay) {
      catTd.innerHTML = `— <span class="tag">${r.kind === "payment" ? "payment" : "transfer"}</span>`;
    } else {
      const current = s.categories.get(i) || r.description || "?";
      const sel = document.createElement("select");
      const options = CARD_IMPORT_CATEGORIES.includes(current) ? CARD_IMPORT_CATEGORIES : [current, ...CARD_IMPORT_CATEGORIES];
      for (const cat of options) {
        const opt = document.createElement("option"); opt.value = cat; opt.textContent = cat; opt.selected = cat === current;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        s.categories.set(i, sel.value);
        // T30: a category corrected by hand in the review modal is a rule
        // waiting to be learned. Recorded here, offered once on confirm —
        // one prompt for the statement rather than one per row.
        const stem = merchantStem(r.source);
        if (stem && sel.value) s.learned.set(stem, sel.value);
      };
      catTd.appendChild(sel);
      if (r._rule) { const t = document.createElement("span"); t.className = "tag ok"; t.textContent = "rule"; t.title = `matched by “${r._rule.name || r._rule.match}”`; catTd.appendChild(t); }
      if (current === "?") { const note = document.createElement("span"); note.className = "sm muted"; note.style.marginLeft = "6px"; note.textContent = "needs one"; catTd.appendChild(note); }
    }
    tr.appendChild(catTd);

    const net = signedNet(r);
    const amtTd = document.createElement("td"); amtTd.className = "r" + (net < 0 ? " pos" : "");
    amtTd.textContent = (net < 0 ? "+" : "−") + fmt(Math.abs(net));
    tr.appendChild(amtTd);
    tr.appendChild(document.createElement("td"));
    tbody.appendChild(tr);
  });

  renderImportTotals();
}

function renderImportTotals() {
  const s = importState;
  let purchases = 0, refunds = 0, payments = 0;
  for (const i of s.included) {
    const r = s.fresh[i];
    if (r.kind === "payment" || r.kind === "balance_transfer") payments += Number(r.deposit) || 0;
    else if ((Number(r.withdrawal) || 0) > 0) purchases += Number(r.withdrawal) || 0;
    else refunds += Number(r.deposit) || 0;
  }
  purchases = round2(purchases); refunds = round2(refunds); payments = round2(payments);
  $("#impTotals").innerHTML =
    `<span>purchases <b class="num">−${fmt(purchases)}</b></span>` +
    (refunds ? `<span>refunds <b class="num pos">+${fmt(refunds)}</b></span>` : "") +
    (payments ? `<span>payments <b class="num pos">+${fmt(payments)}</b></span>` : "");

  const match = $("#impMatch");
  const excluded = s.fresh.length - s.included.size;
  if (excluded === 0) {
    const fileFreshNet = round2((s.totals.fresh_charges || 0) - (s.totals.fresh_credits || 0));
    const shownNet = round2(purchases - refunds - payments);
    const ok = Math.abs(fileFreshNet - shownNet) < 0.01;
    match.textContent = ok ? `✓ matches the statement total ${fmt(fileFreshNet)}` : `⚠ totals don't reconcile — ${fmt(shownNet)} shown vs ${fmt(fileFreshNet)} parsed`;
    match.style.color = ok ? "" : "var(--warn)";
  } else {
    match.textContent = `${excluded} row${excluded === 1 ? "" : "s"} excluded by you — totals above reflect what will import`;
    match.style.color = "";
  }

  const n = s.included.size + s.conflicts.filter((c) => c.decision === "update").length;
  $("#impConfirm").textContent = `Import ${n} row${n === 1 ? "" : "s"}`;
  $("#impConfirm").disabled = n === 0 && !s.duplicates.some((d) => d.matched_by !== "external_id");
}

function closeImport() { $("#impScrim").classList.remove("open"); importState = null; }
$("#impCancel").addEventListener("click", closeImport);
$("#impScrim").addEventListener("click", (e) => { if (e.target.id === "impScrim") closeImport(); });

$("#impConfirm").addEventListener("click", async () => {
  const s = importState;
  const acct = state.card.account;
  if (!s || !acct) return closeImport();
  const batch = `import-${acct.id}-${s.span[0] || "x"}-${s.span[1] || "x"}-${s.rowCount}`;
  const rows = [];
  for (const i of s.included) {
    const r = s.fresh[i];
    rows.push(toBulkRow({ ...r, description: s.categories.get(i) || r.description }));
  }
  for (const d of s.duplicates) {
    if (d.matched_by === "external_id") continue; // exact match already — nothing to adopt
    rows.push(toBulkRow(d.row, { update_id: d.adopt_id }));
  }
  for (const c of s.conflicts) {
    if (c.decision !== "update") continue;
    rows.push(toBulkRow(c.row, { update_id: c.update_id }));
  }
  // T30's supersede: the real row is written ONTO its projection, so the
  // projection keeps its id, gains the statement's date, amount and
  // fingerprint, and loses its `projected` flag (the bulk route clears it).
  for (const x of s.superseded || []) {
    rows.push(toBulkRow(x.row, { update_id: x.update_id }));
  }
  if (!rows.length) { closeImport(); return; }
  $("#impConfirm").disabled = true;
  try {
    const res = await api("/api/transactions/bulk", { method: "POST", body: { account_id: acct.id, owner: acct.owner, import_batch: batch, rows } });
    const learned = [...(s.learned || new Map())].filter(([stem, cat]) => {
      const hit = pickRule(compiledRules(), stem, acct.id);
      return !hit || hit.description !== cat; // nothing to learn if a rule already says it
    });
    closeImport();
    await loadCardLedger();
    render();
    toast(`Imported ${res.inserted} new, updated ${res.updated}, skipped ${res.skipped}`);
    // Learn, once, from whatever was corrected by hand during the review. Still
    // a confirmation, and still staged behind "Save rules".
    if (learned.length) {
      const list = learned.map(([stem, cat]) => `  ${stem} → ${cat}`).join("\n");
      if (confirm(`Remember ${learned.length === 1 ? "this categorization" : "these categorizations"} for next time?\n\n${list}\n\nRules stage behind "Save rules" on the Merchant rules panel.`)) {
        for (const [stem, cat] of learned) stageNewRule(stem, cat, null);
        state.rules.open = true;
        renderCredit();
        toast(`${learned.length} rule${learned.length === 1 ? "" : "s"} staged — Save rules to keep ${learned.length === 1 ? "it" : "them"}`);
      }
    }
  } catch (e) {
    toast("Import failed: " + e.message);
    $("#impConfirm").disabled = false;
  }
});

// --- recurring entries (shared by both subtabs' add rows) -------------------

let recurBase = null, recurTarget = "debit";
function openRecurModal(base, target = "debit") {
  recurBase = base; recurTarget = target;
  const amt = Number(base.deposit) || Number(base.withdrawal) || 0;
  $("#recurSummary").textContent = `${base.description || "Entry"} · ${base.source || "—"} · ${fmt(amt)} — starting ${base.txn_date}`;
  $("#recurFreq").value = "monthly";
  $("#recurUntil").value = defaultUntil(base.txn_date, target === "credit" ? state.card.txns : state.txns);
  $("#recurModal").hidden = false;
}
const closeRecurModal = () => { $("#recurModal").hidden = true; recurBase = null; };

// Stage the future occurrences of `base` into the target subtab. The cadence
// arithmetic itself lives in shared/recurring.js (T30a) — this is the four
// lines that were wrapped around it: which staged slice to push into, and how
// many rows the toast should report. `occurrences()` is pure and returns an
// array, so the two callers that cannot push (the statement importer's
// projections, and check:rules) use the same arithmetic without going through
// this function.
function generateRecurring(base, freq, until, target = "debit") {
  const rows = occurrences(base, freq, until, { cadence: state.cadence, anchor: state.anchor });
  for (const r of rows) pushNewTo(target, r);
  return rows.length;
}

$("#recurAdd").addEventListener("click", () => {
  if (!recurBase) return closeRecurModal();
  const freq = $("#recurFreq").value;
  const target = recurTarget;
  const until = $("#recurUntil").value || defaultUntil(recurBase.txn_date, target === "credit" ? state.card.txns : state.txns);
  const n = generateRecurring(recurBase, freq, until, target);
  closeRecurModal();
  render();
  toast(n ? `Added ${n} future occurrence${n === 1 ? "" : "s"} — review and Save` : "No occurrences in that range");
});
$("#recurOnce").addEventListener("click", closeRecurModal);
$("#recurModal").addEventListener("click", (e) => { if (e.target.id === "recurModal") closeRecurModal(); });

// --- Debit save / discard ----------------------------------------------------

const pendingCount = () => state.edits.size + state.dels.size + state.news.length;
const hasPending = () => pendingCount() > 0;
// Unsaved RULES count as unsaved work too — they are the Credit subtab's
// third staged set (T30b), and losing a rule set to a navigation is just as
// annoying as losing a staged row.
const hasAnyPending = () => hasPending() || hasCardPending() || hasRulePending();
function renderControls() {
  const n = pendingCount();
  const save = $("#saveBtn"); save.disabled = n === 0; save.textContent = n ? `Save to ledger (${n})` : "Save to ledger";
  $("#discardBtn").hidden = n === 0;
  $("#dirtyNote").hidden = n === 0;
}

$("#saveBtn").addEventListener("click", async () => {
  if (!hasPending()) return;
  const v = computeView();
  if (v.min < 0 && !confirm(`This pay period dips to ${fmt(v.min)}. Save to the ledger anyway?`)) return;
  const n = pendingCount();
  $("#saveBtn").disabled = true;
  try {
    for (const nr of state.news) {
      await api("/api/transactions", { method: "POST", body: { account_id: state.account.id, owner: state.currentUser, txn_date: nr.txn_date, description: nr.description, source: nr.source, deposit: Number(nr.deposit) || 0, withdrawal: Number(nr.withdrawal) || 0 } });
    }
    for (const [id, fields] of state.edits) await api(`/api/transactions/${id}`, { method: "PATCH", body: fields });
    for (const id of state.dels) await api(`/api/transactions/${id}`, { method: "DELETE" });
    await loadWindow();
    // The Credit subtab reads the same ledger, and a debit save can move the
    // checking side of a card payment — whose mirror is a card row (#56). So
    // refresh the card ledger too, but never over staged card edits: this
    // button has no mandate to discard the other subtab's work.
    if (!hasCardPending()) await loadCardLedger();
    showWindow(); // anchor may have shifted (e.g. a new paycheck was added) — recompute the window, not just render
    toast(`Saved ${n} change${n === 1 ? "" : "s"} to the ledger`);
  } catch (e) { toast("Error: " + e.message); renderControls(); }
});

$("#discardBtn").addEventListener("click", () => { if (!hasPending()) return; clearPending(); render(); toast("Changes discarded"); });
window.addEventListener("beforeunload", (e) => { if (hasAnyPending()) { e.preventDefault(); e.returnValue = ""; } });

// --- T30(b): merchant rules, editable where they are used --------------------
//
// The rules live on the Credit subtab rather than on a page of their own
// (there is no sixth page, and a rule is only ever interesting next to the rows
// it claims). They are `plan_targets` rows, so the editing is the same shape as
// plan.js's: stage locally, Save writes POST/PATCH/DELETE, Discard throws the
// staging away. Never auto-save.

const ruleCategories = () => [...document.querySelectorAll("#categories option")].map((o) => o.textContent);

async function loadRules() {
  try {
    const { plan_targets } = await api(`/api/plan-targets?kind=${RULE_KIND}`);
    // Same owner scoping as the card dropdown (decision #24): your own rules
    // plus the household's. Seeded rules are `shared` because "Walmart is
    // groceries" is not a fact about a person.
    // Filter on `kind` here too, not just in the query: the published page's
    // mock API answers from the snapshot, and a surface that trusts the server
    // to have filtered would compile `csp_item` rows as if they were rules.
    state.rules.all = plan_targets.filter((r) => r.kind === RULE_KIND && (r.owner === state.currentUser || r.owner === "shared"));
  } catch { state.rules.all = []; }
  clearRulePending();
}
function clearRulePending() { state.rules.edits.clear(); state.rules.dels.clear(); state.rules.news = []; ruleDraft = freshRuleDraft(); }
const rulePendingCount = () => state.rules.edits.size + state.rules.dels.size + state.rules.news.length;
const hasRulePending = () => rulePendingCount() > 0;

// The rule set as the engine sees it: staged edits merged over the loaded rows,
// staged deletes removed, staged additions included. So the "rows here" counts
// and the live re-categorization preview reflect what you are typing, before
// you save it.
function stagedRules() {
  const out = [];
  for (const r of state.rules.all) {
    if (state.rules.dels.has(r.id)) continue;
    const e = state.rules.edits.get(r.id);
    out.push(e ? { ...r, ...e, data: { ...r.data, ...(e.data || {}) } } : r);
  }
  for (const n of state.rules.news) out.push({ id: n._tempId, owner: n.owner, kind: RULE_KIND, name: n.name, data: n.data });
  return out;
}
const compiledRules = () => compileRules(stagedRules().map((r) => ({ ...r, kind: RULE_KIND })));

function renderRulesPanel(v) {
  const rules = stagedRules();
  const compiled = compiledRules();
  const acctId = state.card.accountId;
  // Counted over the whole card ledger, not the window: a rule's usefulness is
  // a property of the history, and a 14-day window is far too small a sample to
  // tell "matches nothing" from "matched nothing this fortnight".
  const cov = ruleCoverage(state.card.txns, compiled, { accountId: acctId });
  $("#rulesSummary").textContent =
    `${rules.length} rule${rules.length === 1 ? "" : "s"} · ${cov.matched} of ${cov.total} rows on this card matched` +
    (cov.needsCategory ? ` · ${cov.needsCategory} unanswered (${fmt(cov.needsCategoryAmount)})` : " · nothing unanswered");

  const open = state.rules.open;
  $("#rulesBody").hidden = !open;
  $("#rulesToggle").textContent = open ? "hide" : "show";
  renderRuleControls();
  if (!open) return;

  const counts = new Map(cov.perRule.map((e) => [e.rule.id, e]));
  const tbody = $("#rulesRows"); tbody.innerHTML = "";
  // Listed in the order they are actually consulted, which is the only honest
  // way to show a rule set whose answer depends on precedence.
  const ordered = compiled.slice().sort((a, b) => compareRulesForDisplay(a, b, acctId));
  for (const r of ordered) tbody.appendChild(ruleRowEl(r, counts.get(r.id)));
  for (const r of stagedRules().filter((x) => !compiled.some((c) => c.id === x.id))) {
    tbody.appendChild(ruleRowEl({ ...compileRuleShim(r) }, null)); // unusable: still editable
  }
  renderRuleAddRow();

  const unusable = compiled.length !== rules.length;
  $("#rulesPrecedence").innerHTML =
    `When several rules match one merchant, the winner is: <b>exact</b> → <b>contains</b> → <b>regex</b>, ` +
    `then a rule naming this card over one that applies to all, then higher priority, then the longest match. ` +
    `Matching is on the merchant string <b>normalized</b> the way the importer normalizes it (uppercase, punctuation collapsed, digits kept) — ` +
    `so <code>WHOLEFDS</code> matches <code>WHOLEFDS DCT 10687</code>, and <code>Whole Foods</code> matches nothing.` +
    (unusable ? ` <span class="tag warn">a rule below can't be used — see its row</span>` : "");
}

// Display order only; `pickRule` owns the real precedence.
function compareRulesForDisplay(a, b, acctId) {
  const rank = { exact: 2, contains: 1, regex: 0 };
  const scope = (r) => (acctId && r.account_id === acctId ? 1 : 0);
  return (rank[b.match_type] - rank[a.match_type]) || (scope(b) - scope(a)) ||
    (b.priority - a.priority) || (b.needle.length - a.needle.length) || (a.id < b.id ? -1 : 1);
}
const compileRuleShim = (r) => ({
  id: r.id, owner: r.owner, name: r.name, match: r.data?.match ?? "", match_type: r.data?.match_type ?? "contains",
  account_id: r.data?.account_id ?? null, description: r.data?.description ?? "", priority: Number(r.data?.priority) || 0,
  needle: "", error: "incomplete — needs a match string and a category",
});

function ruleRowEl(rule, count) {
  const isNew = String(rule.id).startsWith("new-");
  const tr = document.createElement("tr");
  if (state.rules.dels.has(rule.id)) tr.className = "to-delete";
  else if (isNew) tr.className = "new-row";
  else if (state.rules.edits.has(rule.id)) tr.className = "edited";
  // A rule with no rows on THIS card is not a broken rule — most of the set
  // belongs to another card. Only `categorize:cards --report`, which reads
  // every card at once, can tell "matches nothing anywhere" (a typo'd needle)
  // from "matches nothing here", so the warning lives there and not on a row
  // the person is looking at for a different reason.

  const text = (value, field, ph) => {
    const td = document.createElement("td");
    const inp = document.createElement("input"); inp.type = "text"; inp.value = value ?? ""; inp.placeholder = ph || "";
    inp.onchange = () => stageRuleEdit(rule, field, inp.value);
    td.appendChild(inp); return td;
  };
  tr.appendChild(text(rule.match, "match", "WHOLEFDS"));

  const typeTd = document.createElement("td");
  const typeSel = document.createElement("select");
  for (const t of MATCH_TYPES) { const o = document.createElement("option"); o.value = t; o.textContent = t; o.selected = t === rule.match_type; typeSel.appendChild(o); }
  typeSel.onchange = () => stageRuleEdit(rule, "match_type", typeSel.value);
  typeTd.appendChild(typeSel); tr.appendChild(typeTd);

  const scopeTd = document.createElement("td");
  const scopeSel = document.createElement("select");
  const allOpt = document.createElement("option"); allOpt.value = ""; allOpt.textContent = "all my cards"; allOpt.selected = !rule.account_id;
  scopeSel.appendChild(allOpt);
  for (const c of state.cards) {
    const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; o.selected = rule.account_id === c.id;
    scopeSel.appendChild(o);
  }
  scopeSel.onchange = () => stageRuleEdit(rule, "account_id", scopeSel.value || null);
  scopeTd.appendChild(scopeSel); tr.appendChild(scopeTd);

  const catTd = document.createElement("td");
  const catSel = document.createElement("select");
  const cats = ruleCategories();
  const options = cats.includes(rule.description) || !rule.description ? cats : [rule.description, ...cats];
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "— pick one —"; blank.selected = !rule.description;
  catSel.appendChild(blank);
  for (const c of options) { const o = document.createElement("option"); o.value = c; o.textContent = c; o.selected = c === rule.description; catSel.appendChild(o); }
  catSel.onchange = () => stageRuleEdit(rule, "description", catSel.value);
  catTd.appendChild(catSel); tr.appendChild(catTd);

  const countTd = document.createElement("td"); countTd.className = "r";
  countTd.textContent = rule.error ? "—" : count ? `${count.rows}` : "0";
  countTd.title = rule.error
    ? rule.error
    : count && count.rows
      ? `${fmt(count.amount)} on this card${rule.why ? `\n\n${rule.why}` : ""}`
      : "No rows on this card — it may well be doing work on another one. `npm run categorize:cards -- --report` is what sees every card at once.";
  tr.appendChild(countTd);

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button");
  const staged = state.rules.dels.has(rule.id);
  del.className = "del" + (staged ? " restore" : "");
  del.textContent = staged ? "↺" : "×"; del.title = staged ? "Restore" : "Delete this rule";
  del.onclick = () => toggleRuleDelete(rule);
  act.appendChild(del); tr.appendChild(act);

  if (rule.error) {
    const warn = document.createElement("span"); warn.className = "tag warn"; warn.textContent = "unusable";
    catTd.appendChild(warn);
  }
  return tr;
}

const freshRuleDraft = () => ({ match: "", match_type: "contains", account_id: "", description: "" });
let ruleDraft = freshRuleDraft();
function renderRuleAddRow() {
  const foot = $("#rulesAddFoot"); foot.innerHTML = "";
  const tr = document.createElement("tr"); tr.className = "add";
  const td = (el) => { const d = document.createElement("td"); d.appendChild(el); return d; };

  const match = document.createElement("input"); match.type = "text"; match.placeholder = "merchant text, as the statement spells it"; match.value = ruleDraft.match;
  match.oninput = () => (ruleDraft.match = match.value);
  match.onkeydown = (e) => { if (e.key === "Enter") addRule(); };
  tr.appendChild(td(match));

  const type = document.createElement("select");
  for (const t of MATCH_TYPES) { const o = document.createElement("option"); o.value = t; o.textContent = t; o.selected = t === ruleDraft.match_type; type.appendChild(o); }
  type.onchange = () => (ruleDraft.match_type = type.value);
  tr.appendChild(td(type));

  const scope = document.createElement("select");
  const all = document.createElement("option"); all.value = ""; all.textContent = "all my cards"; scope.appendChild(all);
  for (const c of state.cards) { const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; o.selected = ruleDraft.account_id === c.id; scope.appendChild(o); }
  scope.onchange = () => (ruleDraft.account_id = scope.value);
  tr.appendChild(td(scope));

  const cat = document.createElement("select");
  const blank = document.createElement("option"); blank.value = ""; blank.textContent = "— pick one —"; cat.appendChild(blank);
  for (const c of ruleCategories()) { const o = document.createElement("option"); o.value = c; o.textContent = c; o.selected = ruleDraft.description === c; cat.appendChild(o); }
  cat.onchange = () => (ruleDraft.description = cat.value);
  tr.appendChild(td(cat));

  tr.appendChild(document.createElement("td"));
  const act = document.createElement("td"); act.className = "row-actions";
  const add = document.createElement("button"); add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = addRule; act.appendChild(add); tr.appendChild(act);
  foot.appendChild(tr);
}

function stageRuleEdit(rule, field, value) {
  const id = rule.id;
  if (String(id).startsWith("new-")) {
    const n = state.rules.news.find((x) => x._tempId === id);
    if (!n) return;
    if (field === "match") n.name = value;
    n.data = { ...n.data, [field]: value };
  } else {
    const e = state.rules.edits.get(id) || {};
    e.data = { ...(e.data || {}), [field]: value };
    if (field === "match") e.name = value;
    state.rules.edits.set(id, e);
  }
  renderCredit();
}
function toggleRuleDelete(rule) {
  const id = rule.id;
  if (String(id).startsWith("new-")) state.rules.news = state.rules.news.filter((x) => x._tempId !== id);
  else if (state.rules.dels.has(id)) state.rules.dels.delete(id);
  else { state.rules.dels.add(id); state.rules.edits.delete(id); }
  renderCredit();
}
function addRule() {
  if (!ruleDraft.match.trim()) return toast("A rule needs some merchant text to match");
  if (!ruleDraft.description) return toast("A rule needs a category");
  stageNewRule(ruleDraft.match.trim(), ruleDraft.description, ruleDraft.account_id || null, ruleDraft.match_type);
  ruleDraft = freshRuleDraft();
  renderCredit();
}
function stageNewRule(match, description, accountId, matchType = "contains") {
  const body = ruleFromRow({ source: match }, description, {
    accountId, owner: state.currentUser || "shared", matchType, match,
  });
  state.rules.news.push({ _tempId: "new-" + (++tempId), owner: body.owner, name: body.name, data: body.data });
}

function renderRuleControls() {
  const n = rulePendingCount();
  const save = $("#rulesSaveBtn"); save.disabled = n === 0; save.textContent = n ? `Save rules (${n})` : "Save rules";
  $("#rulesDiscardBtn").hidden = n === 0;
  $("#rulesDirtyNote").hidden = n === 0;
  $("#applyRulesBtn").disabled = !state.card.account;
}

$("#rulesToggle").addEventListener("click", () => { state.rules.open = !state.rules.open; renderCredit(); });
$("#rulesDiscardBtn").addEventListener("click", () => { if (!hasRulePending()) return; clearRulePending(); renderCredit(); toast("Rule changes discarded"); });
$("#rulesSaveBtn").addEventListener("click", async () => {
  if (!hasRulePending()) return;
  const n = rulePendingCount();
  $("#rulesSaveBtn").disabled = true;
  try {
    for (const nr of state.rules.news) {
      await api("/api/plan-targets", { method: "POST", body: { owner: nr.owner, kind: RULE_KIND, name: nr.name, data: nr.data } });
    }
    for (const [id, fields] of state.rules.edits) {
      const cur = state.rules.all.find((r) => r.id === id);
      await api(`/api/plan-targets/${id}`, { method: "PATCH", body: { name: fields.name ?? cur.name, data: { ...cur.data, ...(fields.data || {}) } } });
    }
    for (const id of state.rules.dels) await api(`/api/plan-targets/${id}`, { method: "DELETE" });
    await loadRules();
    renderCredit();
    toast(`Saved ${n} rule change${n === 1 ? "" : "s"}`);
  } catch (e) { toast("Error: " + e.message); renderRuleControls(); }
});

// Apply the rules to the rows IN VIEW, as staged ledger edits. Deliberately
// scoped to the window and deliberately staged: the bulk pass over the whole
// history is `npm run categorize:cards`, which takes a backup and prints a plan
// first, because re-categorizing 977 rows is not something a button on a page
// should do between two clicks.
$("#applyRulesBtn").addEventListener("click", () => {
  if (!state.card.account) return;
  const v = computeCardView();
  const live = v.rows.filter((r) => !r._deleted);
  const ruled = applyRules(live.map((r) => ({ ...r, account_id: state.card.accountId })), compiledRules(), { accountId: state.card.accountId });
  let n = 0;
  applyingRules = true;
  ruled.forEach((out, i) => {
    const row = live[i];
    if (!out._rule || !out.description || out.description === row.description) return;
    // Identity rows are never rewritten by a merchant rule — same guardrail the
    // bulk pass applies, for the same reason (a payment that became Groceries
    // would break the transfer pairing and the CSP's exclude set).
    if (PROTECTED_CATEGORIES.has(row.description || "")) return;
    stageEdit(row, "description", out.description, "credit");
    n++;
  });
  applyingRules = false;
  renderCredit();
  toast(n ? `Re-categorized ${n} row${n === 1 ? "" : "s"} — review and Save` : "Every row in this window already matches the rules");
});

const PROTECTED_CATEGORIES = new Set(["Credit Card Payment", "Transfer", "Interest", "Adjustment", "Negative Balance"]);

// "Always categorize WHOLEFDS as Groceries" — the learned rule, offered the
// moment someone fixes a category by hand. The review modal offers the same
// thing through the same helper (see confirmLearn below); this is the version
// for the mini ledger, which is where a category actually gets corrected most
// often.
let pendingOffer = null;
function offerRule(row, category) {
  if (!category || PROTECTED_CATEGORIES.has(category)) return clearOffer();
  const stem = merchantStem(row.source);
  if (!stem) return clearOffer();
  // Already decided? Then there is nothing to learn.
  const existing = pickRule(compiledRules(), row.source, state.card.accountId);
  if (existing && existing.description === category) return clearOffer();
  pendingOffer = { stem, category, source: row.source };
  const el = $("#ruleOffer");
  el.hidden = false;
  el.innerHTML = "";
  const txt = document.createElement("span");
  txt.innerHTML = `Always categorize <b>${stem}</b> as <b>${category}</b>?`;
  const grow = document.createElement("span"); grow.className = "grow";
  const yes = document.createElement("button"); yes.className = "btn"; yes.textContent = "Add rule";
  const no = document.createElement("button"); no.className = "btn ghost"; no.textContent = "Not now";
  yes.onclick = () => {
    stageNewRule(stem, category, null);
    state.rules.open = true;
    clearOffer();
    renderCredit();
    toast("Rule staged — Save rules to keep it");
  };
  no.onclick = () => { clearOffer(); renderCredit(); };
  el.style.display = "flex"; el.style.alignItems = "center"; el.style.gap = "10px";
  el.append(txt, grow, no, yes);
}
function clearOffer() { pendingOffer = null; const el = $("#ruleOffer"); if (el) { el.hidden = true; el.innerHTML = ""; } }

// --- T30(c): detection, and projecting a subscription forward ---------------

function renderRecurPanel() {
  const panel = $("#recurPanel");
  if (!state.card.account) { panel.hidden = true; return; }
  const hits = detectRecurring(state.card.txns, { months: 3, tolerance: 0.15 })
    .filter((h) => h.confidence >= 0.6);
  state.recur.hits = hits;
  const stale = staleProjections(state.card.txns, TODAY);
  panel.hidden = hits.length === 0 && stale.length === 0;
  if (panel.hidden) return;

  $("#recurSummaryLine").textContent =
    `${hits.length} merchant${hits.length === 1 ? "" : "s"} on this card bill like a subscription` +
    (stale.length ? ` · ${stale.length} projection${stale.length === 1 ? "" : "s"} past due` : "");
  const open = state.recur.open;
  $("#recurBody").hidden = !open;
  $("#recurToggle").textContent = open ? "hide" : "show";
  if (!open) return;

  const host = $("#recurHits"); host.innerHTML = "";
  for (const h of hits) host.appendChild(recurHitEl(h));
  if (!hits.length) host.innerHTML = `<div class="panel-note">Nothing on this card bills once a month at a steady amount for three months running.</div>`;

  const note = $("#staleProjNote");
  note.hidden = stale.length === 0;
  if (stale.length) {
    note.innerHTML = "";
    const txt = document.createElement("span");
    txt.innerHTML = `⚠ ${stale.length} projected row${stale.length === 1 ? "" : "s"} ${stale.length === 1 ? "is" : "are"} dated in the past with no statement row to replace ${stale.length === 1 ? "it" : "them"} — a cancelled subscription, or a statement you haven't uploaded yet.`;
    const grow = document.createElement("span"); grow.className = "grow";
    const del = document.createElement("button"); del.className = "btn ghost"; del.textContent = `Delete ${stale.length}`;
    del.onclick = () => {
      for (const r of stale) if (!state.card.dels.has(r.id)) state.card.dels.add(r.id);
      renderCredit();
      toast(`${stale.length} projection${stale.length === 1 ? "" : "s"} staged for deletion — review and Save`);
    };
    note.style.display = "flex"; note.style.alignItems = "center"; note.style.gap = "10px";
    note.append(txt, grow, del);
  }
}

function recurHitEl(h) {
  const div = document.createElement("div"); div.className = "recurhit";
  const who = document.createElement("span"); who.className = "who"; who.textContent = h.label;
  const meta = document.createElement("span"); meta.className = "meta";
  meta.textContent = `${fmt(h.typicalAmount)} ${h.cadence}${h.dayOfMonth ? ` around the ${ordinal(h.dayOfMonth)}` : ""} · ` +
    `${h.monthsRun} months through ${h.lastSeen} · ${h.category || "uncategorized"}` +
    (h.mixed ? " · also has months with several charges" : "");
  const conf = document.createElement("span"); conf.className = "conf"; conf.title = `confidence ${Math.round(h.confidence * 100)}%`;
  const bar = document.createElement("i"); bar.style.width = `${Math.round(h.confidence * 100)}%`; conf.appendChild(bar);
  const grow = document.createElement("span"); grow.className = "grow";

  div.append(who, meta, conf, grow);

  // Already projected? Then say so instead of offering to do it twice.
  const already = state.card.txns.filter((r) => r.projected === h.key && !r.deleted_at);
  const staged = state.card.news.filter((r) => r.projected === h.key);
  if (already.length || staged.length) {
    const through = [...already, ...staged].map((r) => r.txn_date).sort().pop();
    const tag = document.createElement("span"); tag.className = "tag ok";
    tag.textContent = `projected through ${through}${staged.length ? " (unsaved)" : ""}`;
    div.appendChild(tag);
    return div;
  }

  const btn = document.createElement("button"); btn.className = "btn ghost"; btn.textContent = "Project forward";
  btn.onclick = () => projectForward(h);
  div.appendChild(btn);
  return div;
}

const ordinal = (n) => n + (["th", "st", "nd", "rd"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10] || "th");

// Stage the projected rows. Three guardrails, all from T30's spec:
//   · never without confirmation — this is behind a button and then a confirm;
//   · never past the recurring modal's own default `until`, which is why the
//     date comes from the same `defaultUntil()` the modal uses;
//   · never with an `external_id`, so a future import cannot collide with a row
//     we invented. `projectionRows` is what guarantees that one.
function projectForward(h) {
  const until = defaultUntil(h.lastSeen, state.card.txns);
  const rows = projectionRows(h, { until, cadence: state.cadence, anchor: state.anchor });
  if (!rows.length) return toast("Nothing to project — the next occurrence is already past the stop date");
  const last = rows[rows.length - 1].txn_date;
  if (!confirm(`Add ${rows.length} projected ${h.cadence} charge${rows.length === 1 ? "" : "s"} of ${fmt(h.typicalAmount)} for ${h.label}, through ${last}?\n\nThey stage behind Save, and a real statement row replaces its projection instead of duplicating it.`)) return;
  for (const r of rows) pushNewTo("credit", r);
  renderCredit();
  toast(`${rows.length} projection${rows.length === 1 ? "" : "s"} staged — review and Save`);
}

init();
