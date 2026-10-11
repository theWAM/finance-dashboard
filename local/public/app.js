import { payAnchor as timeframeAnchor, DEFAULT_PRESET, PRESETS } from "/shared/timeframe.js";
import { mountTimeframe } from "./timeframe-ui.js";
import { formatStamp, lastUpdated } from "/shared/stamp.js";
import { mountPlanNav } from "./nav-plan.js";
import { askPair, loadTransferIndex, mirrorPlan, newTransferId, pairBadge, signed } from "./pairing.js";

mountPlanNav(document.querySelector(".nav"), { view: null });

// Ledger grid: a spreadsheet-style editor over the local CRUD API.
//
// Edits are STAGED in memory, never written on keystroke. Cell edits, added
// rows, and deletes accumulate as pending changes; the running balance and
// totals are recomputed live from that staged state so you preview the result.
// Nothing hits the database until you click Save (Discard drops the changes).

const $ = (sel) => document.querySelector(sel);
// Reuse a single currency formatter (constructing one per call is measurably
// slower across hundreds of cells). Invisible to the user — same output.
const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const fmt = (n) => CURRENCY.format(Number(n) || 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Compact date for the phone layout: "2026-06-25" → "6/25/26". CSS decides when
// to show this vs. the full value (see .date-abbr / .date-full).
const fmtDateAbbr = (iso) => {
  const [y, m, d] = String(iso || "").split("-");
  return y && m && d ? `${Number(m)}/${Number(d)}/${y.slice(2)}` : String(iso || "");
};
// Ledger ordering: by date, then same-day priority — paycheck > investments >
// savings > bills > everything else — then created_at.
const isPaycheck = (t) => /paycheck/i.test(t.description || "") && (Number(t.deposit) || 0) > 0;
const DAY_RANK = { Investments: 1, Savings: 2, Bill: 3 };
const dayRank = (t) => (isPaycheck(t) ? 0 : (DAY_RANK[t.description] ?? 4));
const byDate = (a, b) =>
  cmp(a.txn_date, b.txn_date) ||
  (dayRank(a) - dayRank(b)) ||
  cmp(a.created_at || "", b.created_at || "");

const TODAY = new Date().toISOString().slice(0, 10);
const params = new URLSearchParams(location.search);
// A repeatable (?source=a&source=b) or comma-separated (?source=a,b) param,
// as a list of trimmed, non-empty values.
const paramList = (key) => params.getAll(key).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
// Deep-link filter from the URL — used by the CSP drill-down's "View in
// Ledger" link (and hand-built URLs) to land pre-filtered. Resolved once at
// load; absent params keep today's behavior (resetFilter's old default).
const deepLink = {
  preset: params.get("preset") || "",
  from: params.get("from") || "",
  to: params.get("to") || "",
  categories: paramList("category"),
  sources: paramList("source"),
};
const state = {
  accountId: params.get("account"),
  accounts: [],
  people: [],
  // ?user=<id> deep-links as a person; otherwise the last stored choice.
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,          // the selected account's row (has opening_balance)
  rows: [],               // transactions as last loaded from the server
  edits: new Map(),       // id -> { field: value } staged edits to existing rows
  dels: new Set(),        // ids staged for deletion
  news: [],               // staged new rows ({ _tempId, created_at, ...fields })
  filter: { from: "", to: "", categories: new Set(), sources: new Set() }, // date window → category set → source set
  selected: new Set(),    // _ids selected for bulk edit/delete
  _shown: [],             // rows currently displayed (for select-all)
  // Low-power mode is a per-MACHINE preference (localStorage), so a weaker
  // computer can opt into the lighter renderer without changing anyone else's
  // experience. Default off = the original always-editable grid.
  lowPower: localStorage.getItem("lowPower") === "1",
  // T34 — paired transfers. `transfers` is the server's group index (see
  // GET /api/transfers); the three staged sets are decisions the user has
  // already made about a pair but has not Saved yet, so they discard with
  // everything else rather than acting the moment they are chosen.
  transfers: { groups: {}, unpaired: new Set(), cards: [], summary: null, readOnly: true },
  propagate: new Set(),   // row ids whose edit should travel to the pair
  unlink: new Set(),      // row ids whose edit should BREAK the pair instead
  delPairs: new Set(),    // row ids whose delete should take the whole movement
};
const accountById = () => new Map(state.accounts.map((a) => [a.id, a]));

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

// --- current user (no auth; personalizes the view) -------------------------

async function loadPeople() {
  const { people } = await api("/api/people");
  state.people = people;
}

const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();
const currentPerson = () => state.people.find((p) => p.id === state.currentUser) || null;

// A person's profile image, falling back to their initials on a colored circle.
function avatarMarkup(person, photoClass) {
  return person.avatar
    ? `<img class="${photoClass}" src="${person.avatar}" alt="${person.name}">`
    : `<span class="${photoClass} initials">${initials(person.name)}</span>`;
}

function renderUserChip() {
  const chip = $("#userChip");
  const person = currentPerson();
  // A single-person household needs no chip (nobody to switch to).
  if (!person || state.people.length <= 1) { chip.hidden = true; return; }
  const av = $("#userAvatar");
  if (person.avatar) av.innerHTML = `<img src="${person.avatar}" alt="">`;
  else av.textContent = initials(person.name);
  $("#userName").textContent = person.name;
  chip.hidden = false;
}

function showWho() {
  const box = $("#whoOptions");
  box.innerHTML = "";
  for (const p of state.people) {
    const btn = document.createElement("button");
    btn.className = "who-card";
    btn.innerHTML = `${avatarMarkup(p, "who-photo")}<span class="name">${p.name}</span>`;
    btn.onclick = () => selectUser(p.id);
    box.appendChild(btn);
  }
  $("#who").hidden = false;
}

async function selectUser(id) {
  if (hasPending() && !confirm("Discard unsaved changes?")) return;
  state.currentUser = id;
  localStorage.setItem("currentUser", id);
  // The theme belongs to the person, and this switch doesn't reload — tell the
  // settings panel so it can re-resolve for the newly selected profile.
  window.dispatchEvent(new CustomEvent("userchange", { detail: { id } }));
  $("#who").hidden = true;
  renderUserChip();
  state.accountId = null; // re-default to the newly selected person's account
  await loadAccounts();
  await loadLedger();
}

// --- accounts --------------------------------------------------------------

const isCard = () => state.account?.type === "credit_card";

// Grouping + ordering for the account <optgroup>s — checking first (the
// common case), then cards, then anything else, each alphabetized within.
const ACCOUNT_GROUP_LABELS = { checking: "Checking", credit_card: "Credit Cards", savings: "Savings", investment: "Investments", loan: "Loans" };
const ACCOUNT_GROUP_ORDER = ["checking", "credit_card", "savings", "investment", "loan"];

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  // Personal scope: show the current person's accounts plus shared ones.
  const visible = state.currentUser
    ? accounts.filter((a) => a.owner === state.currentUser || a.owner === "shared")
    : accounts;
  state.accounts = visible;

  const sel = $("#account");
  sel.innerHTML = "";
  // A flat list stops being scannable once card accounts join checking (up to
  // ~5 cards per person) — group by type, checking first.
  const groups = new Map();
  for (const a of visible) {
    const key = a.type || "checking";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = ACCOUNT_GROUP_ORDER.indexOf(a), ib = ACCOUNT_GROUP_ORDER.indexOf(b);
    return (ia === -1 ? ACCOUNT_GROUP_ORDER.length : ia) - (ib === -1 ? ACCOUNT_GROUP_ORDER.length : ib);
  });
  for (const key of keys) {
    const og = document.createElement("optgroup");
    og.label = ACCOUNT_GROUP_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
    for (const a of groups.get(key)) {
      const opt = document.createElement("option");
      opt.value = a.id;
      // Debt displays positive everywhere outside the stored balance itself.
      const bal = key === "credit_card" ? -a.balance : a.balance;
      opt.textContent = `${a.name} — ${fmt(bal)}`;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (!state.accountId || !visible.some((a) => a.id === state.accountId)) {
    // Prefer the current person's checking account, then their busiest account,
    // then the busiest visible account overall.
    const mine = visible.filter((a) => a.owner === state.currentUser);
    const pref =
      mine.find((a) => a.type === "checking") ||
      [...mine].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))[0] ||
      [...visible].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))[0];
    state.accountId = pref?.id ?? null;
  }
  sel.value = state.accountId ?? "";
}

// --- ledger data + staging -------------------------------------------------

function clearPending() {
  state.edits.clear();
  state.dels.clear();
  state.news = [];
  state.selected.clear();
  state.propagate.clear();
  state.unlink.clear();
  state.delPairs.clear();
  addDraft = freshDraft();
}

async function loadLedger() {
  $("#dailyCheck").hidden = true; // stale projection from whatever account was open before
  if (!state.accountId) { state.rows = []; state.account = null; clearPending(); resetFilter(); buildFilters(); render(); return; }
  const [{ account, transactions }, transfers] = await Promise.all([
    api(`/api/transactions?account_id=${encodeURIComponent(state.accountId)}`),
    loadTransferIndex(),
  ]);
  state.account = account;
  state.rows = transactions;
  state.transfers = transfers;
  clearPending();
  resetFilter();          // a fresh account starts unfiltered
  buildFilters();         // rebuild category/source checkboxes for this account
  render();
}

// --- filtering (date window → category → source) ---------------------------

const filterActive = () => {
  const f = state.filter;
  return !!(f.from || f.to || f.categories.size || f.sources.size);
};

function matchesFilter(r) {
  const f = state.filter;
  if (f.from && r.txn_date < f.from) return false;
  if (f.to && r.txn_date > f.to) return false;
  // Within a facet, any checked value matches (OR); facets combine (AND).
  if (f.categories.size && !f.categories.has(r.description || "")) return false;
  if (f.sources.size && !f.sources.has(r.source || "")) return false;
  return true;
}

// The current person's cadence + the paycheck to anchor pay-window math to.
// Resolved fresh on every preset application (the control calls this), so the
// `3paychecks` window follows the latest paycheck as rows are added.
const payAnchor = () => timeframeAnchor(state.rows, {
  person: state.people.find((p) => p.id === state.currentUser),
});

// The shared timeframe control owns the funnel toggle, the "Displaying …" chip,
// the preset <select> and From/To; the Ledger-only Category/Source facets (plus
// Clear and the row count) are appended into its slot, so the filter row looks
// and behaves exactly as it did when all of it lived in this file.
const tf = mountTimeframe($("#timeframe"), {
  context: () => payAnchor(),
  onChange: ({ from, to }) => { state.filter.from = from; state.filter.to = to; render(); },
  summaryExtra: () => {
    const n = state.filter.categories.size + state.filter.sources.size;
    return n ? `${n} filter${n === 1 ? "" : "s"}` : "";
  },
});
tf.slot.appendChild($("#ledgerFacets").content);

// A fresh account starts on the default timeframe with no facets selected —
// unless the URL carries a deep-link window/facets (?preset=, ?from=, ?to=,
// ?category=, ?source=), in which case that's the "fresh" state instead.
// Silent: loadLedger renders once afterwards.
function resetFilter() {
  const presetValid = deepLink.preset && PRESETS.some((p) => p.key === deepLink.preset);
  const win = presetValid ? tf.applyPreset(deepLink.preset, { silent: true })
    : (deepLink.from || deepLink.to) ? tf.set({ from: deepLink.from, to: deepLink.to }, { silent: true })
    : tf.applyPreset(DEFAULT_PRESET, { silent: true });
  state.filter = {
    from: win.from, to: win.to,
    categories: new Set(deepLink.categories),
    sources: new Set(deepLink.sources),
  };
}

// Distinct values of a field across the loaded ledger, sorted case-insensitively.
function distinctValues(key) {
  const set = new Set();
  for (const r of state.rows) set.add(r[key] ?? "");
  return [...set].sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()));
}

// A card can carry hundreds of distinct merchants (vs. a handful of
// categories), which makes an uncapped checkbox list unusable. Cap at `cap`,
// ranked by frequency so the merchants worth filtering on survive the cut,
// but keep anything already checked visible even if it falls outside the cap.
function topValues(key, selected, cap) {
  const counts = new Map();
  for (const r of state.rows) {
    const v = r[key] ?? "";
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const all = [...counts.keys()];
  if (all.length <= cap) return { values: all.sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase())), omitted: 0 };
  const shown = new Set([...all].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, cap));
  for (const v of selected) shown.add(v);
  return { values: [...shown].sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase())), omitted: all.length - shown.size };
}

const SOURCE_FACET_CAP = 150;

function buildFilters() {
  buildMultiselect("msCategory", "Category", distinctValues("description"), state.filter.categories, 0);
  const { values: sources, omitted } = topValues("source", state.filter.sources, SOURCE_FACET_CAP);
  buildMultiselect("msSource", "Source", sources, state.filter.sources, omitted);
}

// A checkbox dropdown over `values`; checking several matches ANY of them.
// `omitted` (card merchant lists only) prints a note instead of silently
// dropping the rest.
function buildMultiselect(elId, label, values, selected, omitted = 0) {
  const el = $("#" + elId);
  el.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ms-btn";
  const relabel = () => {
    btn.textContent = (selected.size ? `${label} (${selected.size})` : label) + " ▾";
    btn.classList.toggle("active", selected.size > 0);
  };
  relabel();

  const panel = document.createElement("div");
  panel.className = "ms-panel";
  panel.hidden = true;
  for (const v of values) {
    const opt = document.createElement("label");
    opt.className = "ms-opt";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(v);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(v); else selected.delete(v);
      relabel();
      render();
    });
    const span = document.createElement("span");
    span.textContent = v === "" ? "(blank)" : v;
    opt.append(cb, span);
    panel.appendChild(opt);
  }
  if (omitted > 0) {
    const note = document.createElement("div");
    note.className = "ms-note";
    note.textContent = `+${omitted} more not shown — narrow by date or category first`;
    panel.appendChild(note);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeAllPanels();
    panel.hidden = !willOpen;
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  el.append(btn, panel);
}

function closeAllPanels() {
  document.querySelectorAll(".ms-panel").forEach((p) => (p.hidden = true));
}

// --- Balance correction (projected-vs-actual balance for today) ------------

let dcProjected = 0;
// Opened from the "Balance check" button in the header. This used to pop up on
// its own, once per account per calendar day, and it stamped localStorage the
// moment it opened -- so merely seeing it, dismissing it, reloading, or
// switching accounts burned the only chance to use it until the next day. It is
// on-demand now: no gating, no auto-open, available whenever the bank disagrees.
function openBalanceCheck() {
  if (!state.accountId) { toast("Pick an account first"); return; }
  // A bank balance is a daily thing to check; a card's equivalent is a monthly
  // statement, which this flow doesn't model — disabled below rather than
  // faked against a comparison point that doesn't exist for every card yet.
  if (isCard()) { toast("Balance check isn't available on card accounts"); return; }
  dcProjected = computeView().todayBal;
  $("#dcAmount").textContent = fmt(dcProjected);
  $("#dcActual").value = "";
  $("#dcDiff").textContent = "";
  $("#dcApply").disabled = true;
  $("#dailyCheck").hidden = false;
  $("#dcActual").focus();
}
const closeBalanceCheck = () => { $("#dailyCheck").hidden = true; };
const toggleBalanceCheck = () => { if ($("#dailyCheck").hidden) openBalanceCheck(); else closeBalanceCheck(); };
$("#dcClose").addEventListener("click", closeBalanceCheck);
$("#dcActual").addEventListener("input", (e) => {
  const has = e.target.value !== "" && !Number.isNaN(Number(e.target.value));
  const diff = has ? round2(Number(e.target.value) - dcProjected) : 0;
  $("#dcApply").disabled = !has || Math.abs(diff) < 0.01;
  $("#dcDiff").textContent = !has ? ""
    : Math.abs(diff) < 0.01 ? "Matches — nothing to correct."
    : `Bank is ${diff > 0 ? "over" : "short"} by ${fmt(Math.abs(diff))} — Add correction stages an adjustment dated ${TODAY}.`;
});
$("#dcApply").addEventListener("click", () => {
  const diff = round2(Number($("#dcActual").value) - dcProjected);
  if (Math.abs(diff) < 0.01) return;
  state.news.push({
    _tempId: "new-" + (++tempCounter), created_at: new Date().toISOString(), txn_date: TODAY,
    description: "Adjustment", source: "Balance correction",
    deposit: diff > 0 ? diff : 0, withdrawal: diff < 0 ? -diff : 0,
  });
  closeBalanceCheck();
  render();
  toast("Adjustment added — review and Save");
});

// --- bulk selection / edit / delete ----------------------------------------

function updateSelectionUI() {
  // Drop any selections that are no longer visible (e.g. after filtering).
  const shownIds = new Set(state._shown.map((r) => r._id));
  for (const id of [...state.selected]) if (!shownIds.has(id)) state.selected.delete(id);

  const n = state.selected.size;
  $("#bulkBar").hidden = n === 0;
  $("#bulkCount").textContent = `${n} selected`;
  const sa = $("#selectAll");
  sa.checked = n > 0 && n === state._shown.length;
  sa.indeterminate = n > 0 && n < state._shown.length;
  document.querySelectorAll('#rows tr[data-id]').forEach((tr) => {
    const sel = state.selected.has(tr.dataset.id);
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = sel;
    tr.classList.toggle("row-selected", sel);
  });
}

// Stage the same field=value across every selected row (edits, or new-row fields).
function bulkSetField(field, value) {
  for (const id of state.selected) {
    const nw = state.news.find((x) => x._tempId === id);
    if (nw) nw[field] = value;
    else { const e = state.edits.get(id) || {}; e[field] = value; state.edits.set(id, e); }
  }
  render();
}

function bulkDelete() {
  for (const id of state.selected) {
    if (String(id).startsWith("new-")) state.news = state.news.filter((x) => x._tempId !== id);
    else { state.dels.add(id); state.edits.delete(id); }
  }
  state.selected.clear();
  render();
}

// Show the value input appropriate to the chosen bulk field.
function renderBulkValue() {
  const field = $("#bulkField").value;
  const wrap = $("#bulkValueWrap");
  wrap.innerHTML = "";
  $("#bulkApply").disabled = !field;
  if (!field) return;
  const inp = document.createElement("input");
  inp.id = "bulkValue";
  if (field === "txn_date") inp.type = "date";
  else if (field === "deposit" || field === "withdrawal") { inp.type = "number"; inp.step = "0.01"; inp.min = "0"; inp.placeholder = "0.00"; }
  else { inp.type = "text"; if (field === "description") inp.setAttribute("list", "categories"); inp.placeholder = field === "description" ? "Category" : "Source / Recipient"; }
  wrap.appendChild(inp);
}

// Merge staged changes over the loaded rows, then recompute the running balance
// (oldest → newest) so the preview reflects unsaved edits. Deleted rows are kept
// for display (struck-through) but excluded from the balance.
function computeView() {
  const rows = [];
  for (const r of state.rows) {
    if (state.dels.has(r.id)) { rows.push({ ...r, _id: r.id, _deleted: true }); continue; }
    const e = state.edits.get(r.id);
    rows.push({ ...r, ...(e || {}), _id: r.id, _edited: !!e });
  }
  for (const n of state.news) rows.push({ ...n, _id: n._tempId, _new: true });

  const live = rows
    .filter((r) => !r._deleted)
    .sort(byDate);
  const winTo = state.filter?.to || ""; // end of the selected timeframe ("" = open-ended)
  let bal = Number(state.account?.opening_balance) || 0;
  let deposits = 0, withdrawals = 0, todayBal = bal, windowEndBal = bal;
  const balById = new Map();
  for (const t of live) {
    const d = Number(t.deposit) || 0, w = Number(t.withdrawal) || 0;
    deposits += d; withdrawals += w; bal = round2(bal + d - w);
    balById.set(t._id, bal);
    if (t.txn_date <= TODAY) todayBal = bal;          // running balance as of today
    if (!winTo || t.txn_date <= winTo) windowEndBal = bal; // running balance as of the window's end
  }
  return { rows, balById, totals: { deposits: round2(deposits), withdrawals: round2(withdrawals) }, endBal: round2(bal), todayBal, windowEndBal: round2(windowEndBal) };
}

// Debt is stored as a negative balance (decision #22); it displays positive
// everywhere outside the stored value itself. Checking passes through
// unchanged, so this is the only place the flip needs to happen.
const dispBal = (b) => (isCard() ? round2(-b) : b);

function relabelForAccountType() {
  const card = isCard();
  $("#hDep").textContent = card ? "Credit −" : "Deposit +";
  $("#hWd").textContent = card ? "Charge +" : "Withdrawal −";
  $("#hBal").textContent = card ? "Owed" : "Balance";
  $("#lblIn").textContent = card ? "Credits" : "Deposits";
  $("#lblOut").textContent = card ? "Charges" : "Withdrawals";
  $("#lblBal").textContent = card ? "Owed" : "Balance";
  $("#bfDep").textContent = card ? "Credit" : "Deposit";
  $("#bfWd").textContent = card ? "Charge" : "Withdrawal";
  const ob = Number(state.account?.opening_balance) || 0;
  $("#openingLabel").textContent = card ? "Opening owed" : "Opening balance";
  $("#openingValue").textContent = state.account ? fmt(card ? -ob : ob) : "—";
}

function render() {
  const { rows, balById, totals, windowEndBal } = computeView();
  const active = filterActive();
  const shown = active ? rows.filter(matchesFilter) : rows;

  relabelForAccountType();

  const tbody = $("#rows");
  tbody.innerHTML = "";
  $("#empty").hidden = rows.length > 0;
  // Oldest → newest (top to bottom). Each row keeps its TRUE running balance
  // (computed over the whole ledger in computeView), so filtering never distorts it.
  // Build all rows in a fragment and attach once (one reflow instead of N).
  const display = [...shown].sort(byDate);
  const build = state.lowPower ? rowElLP : rowEl;
  const frag = document.createDocumentFragment();
  for (const r of display) frag.appendChild(build(r, dispBal(balById.get(r._id))));
  tbody.appendChild(frag);
  renderAddRow();

  // Deposits/Withdrawals reflect the filtered view (e.g. total for a category);
  // Balance is the running balance as of the end of the selected timeframe
  // (the date window's "to"), so it varies with the timeframe like the totals do.
  // It follows the date window only — category/source filters don't move it,
  // since a point-in-time balance always includes every account transaction up
  // to that date.
  const shownTotals = active
    ? shown.filter((r) => !r._deleted).reduce((t, r) => ({
        deposits: round2(t.deposits + (Number(r.deposit) || 0)),
        withdrawals: round2(t.withdrawals + (Number(r.withdrawal) || 0)),
      }), { deposits: 0, withdrawals: 0 })
    : totals;
  $("#totIn").textContent = fmt(shownTotals.deposits);
  $("#totOut").textContent = fmt(shownTotals.withdrawals);
  const balEl = $("#balance");
  const endBal = dispBal(windowEndBal);
  balEl.textContent = fmt(endBal);
  // Negative is the attention-worthy state either way: overdrawn checking, or
  // an overpaid card (the raw balance crossed back above zero).
  balEl.classList.toggle("neg", endBal < 0);
  balEl.title = state.filter?.to
    ? `${isCard() ? "Owed" : "Balance"} as of ${state.filter.to}`
    : isCard() ? "Current amount owed" : "Current end balance";

  $("#fClear").hidden = !active;
  $("#fCount").textContent = active ? `showing ${shown.length} of ${rows.length}` : "";
  state._shown = shown;
  updateSelectionUI();
  renderControls();
  tf.refreshSummary();   // the chip also reports the Ledger-only facet count
}


function rowEl(row, bal) {
  const tr = document.createElement("tr");
  tr.dataset.id = row._id;
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  if (state.selected.has(row._id)) tr.classList.add("row-selected");
  // `bal` is already display-adjusted (dispBal) — negative means overdrawn on
  // checking, overpaid on a card. Both are the attention-worthy state.
  if (!row._deleted && bal < 0) tr.classList.add("neg-row");

  const checkTd = document.createElement("td");
  checkTd.className = "col-check";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = state.selected.has(row._id);
  chk.addEventListener("change", () => {
    if (chk.checked) state.selected.add(row._id); else state.selected.delete(row._id);
    updateSelectionUI();
  });
  checkTd.appendChild(chk);
  tr.appendChild(checkTd);

  const dis = !!row._deleted;
  tr.appendChild(dateCell(row, dis));
  tr.appendChild(cell("text", row.description, "description", "col-cat", "categories", "Category", dis));
  tr.appendChild(cell("text", row.source, "source", "", null, "Source / Recipient", dis));
  tr.appendChild(cell("number", row.deposit || "", "deposit", "num col-dep", null, "", dis));
  tr.appendChild(cell("number", row.withdrawal || "", "withdrawal", "num col-wd", null, "", dis));
  tr.appendChild(amountCell(row, dis)); // phone-only column (CSS-gated); editable

  const balTd = document.createElement("td");
  balTd.className = "bal" + (bal < 0 ? " neg" : "");
  balTd.textContent = row._deleted ? "—" : fmt(bal);
  if (!row._deleted && bal < 0) balTd.title = isCard() ? "You've overpaid as of here" : "Balance goes negative here";
  tr.appendChild(balTd);

  const act = document.createElement("td");
  act.className = "row-actions";
  const badge = rowPairBadge(row);
  if (badge) act.appendChild(badge);
  const btn = document.createElement("button");
  btn.className = "del" + (row._deleted ? " restore" : "");
  btn.title = row._deleted ? "Restore" : "Delete";
  btn.textContent = row._deleted ? "↺" : "×";
  btn.onclick = () => toggleDelete(row);
  act.appendChild(btn);
  tr.appendChild(act);

  // Stage each edit on change (blur/enter) — not on every keystroke.
  tr.querySelectorAll("input[data-field]").forEach((inp) => {
    inp.addEventListener("change", () => stageEdit(row, inp.dataset.field, inp.value));
  });
  return tr;
}

function cell(type, value, field, cls = "", list = null, placeholder = "", disabled = false) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value ?? "";
  if (placeholder) inp.placeholder = placeholder;
  if (list) inp.setAttribute("list", list);
  if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
  if (disabled) inp.disabled = true;
  inp.dataset.field = field;
  td.appendChild(inp);
  return td;
}

function applyStage(row, field, value) {
  if (row._new) {
    const n = state.news.find((x) => x._tempId === row._id);
    if (n) n[field] = value;
  } else {
    const e = state.edits.get(row._id) || {};
    e[field] = value;
    state.edits.set(row._id, e);
    askPropagate(row._id, field);
  }
}

// Normal-grid date cell: the native <input type=date> for editing (hidden on
// phones via CSS) plus a compact abbreviated span shown only on phones.
function dateCell(row, disabled) {
  const td = document.createElement("td");
  td.className = "col-date";
  const inp = document.createElement("input");
  inp.type = "date";
  inp.className = "date-native";
  inp.value = row.txn_date ?? "";
  inp.dataset.field = "txn_date";
  if (disabled) inp.disabled = true;
  const abbr = document.createElement("span");
  abbr.className = "date-abbr";
  abbr.textContent = fmtDateAbbr(row.txn_date);
  td.append(inp, abbr);
  return td;
}

// Signed "Amount" cell (deposit − withdrawal) for the normal grid. Hidden on
// desktop, shown on phones; editing it stages deposit/withdrawal (see stageEdit).
function amountCell(row, disabled) {
  const amt = (Number(row.deposit) || 0) - (Number(row.withdrawal) || 0);
  const td = document.createElement("td");
  td.className = "num col-amt" + (amt > 0 ? " pos" : amt < 0 ? " neg" : "");
  const inp = document.createElement("input");
  inp.type = "number";
  inp.step = "0.01"; // no min: negative = withdrawal
  inp.value = amt !== 0 ? amt : "";
  inp.dataset.field = "amount";
  if (disabled) inp.disabled = true;
  td.appendChild(inp);
  return td;
}

function stageEdit(row, field, value) {
  if (field === "amount") {
    // Phone "Amount" column: one signed field → deposit (≥0) or withdrawal (<0).
    const a = Number(value) || 0;
    applyStage(row, "deposit", a > 0 ? a : 0);
    applyStage(row, "withdrawal", a < 0 ? -a : 0);
  } else {
    applyStage(row, field, value);
  }
  render();
}

function toggleDelete(row) { toggleDeleteById(row._id); }

async function toggleDeleteById(id) {
  if (String(id).startsWith("new-")) {
    state.news = state.news.filter((x) => x._tempId !== id);
  } else if (state.dels.has(id)) {
    state.dels.delete(id);
    state.delPairs.delete(id);
  } else {
    if (!(await askDeletePair(id))) return;
    state.dels.add(id);
    state.edits.delete(id); // pending edits on a to-be-deleted row are moot
    state.propagate.delete(id);
    state.unlink.delete(id);
  }
  render();
}

// --- Low-power renderer: text cells, edit-on-demand ------------------------
// Same data, totals, flags, and staging as the normal grid — but each cell is
// plain TEXT that becomes a single <input> only while you're editing it. That
// removes the thousands of always-live inputs that strain weaker machines.
// Events are delegated on #rows (see init), so there are no per-row listeners.

// The staged-or-original value of one field (what computeView would show).
function stagedValue(id, field) {
  if (String(id).startsWith("new-")) { const n = state.news.find((x) => x._tempId === id); return n ? n[field] : ""; }
  const e = state.edits.get(id); if (e && field in e) return e[field];
  const r = state.rows.find((x) => x.id === id); return r ? r[field] : "";
}

function stageEditRaw(id, field, value) {
  if (String(id).startsWith("new-")) { const n = state.news.find((x) => x._tempId === id); if (n) n[field] = value; return; }
  const e = state.edits.get(id) || {}; e[field] = value; state.edits.set(id, e);
  askPropagate(id, field);
}

function textCell(row, field, type, cls, list, placeholder) {
  const td = document.createElement("td");
  td.className = "tcell" + (cls ? " " + cls : "");
  td.dataset.field = field;
  td.dataset.type = type;
  if (list) td.dataset.list = list;
  const raw = row[field];
  const text = type === "number" ? (Number(raw) > 0 ? fmt(raw) : "") : (raw ? String(raw) : "");
  if (text === "") { td.textContent = placeholder || ""; td.classList.add("empty"); }
  else td.textContent = text;
  return td;
}

function rowElLP(row, bal) {
  const tr = document.createElement("tr");
  tr.dataset.id = row._id;
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  if (state.selected.has(row._id)) tr.classList.add("row-selected");
  if (!row._deleted && bal < 0) tr.classList.add("neg-row");

  const checkTd = document.createElement("td");
  checkTd.className = "col-check";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = state.selected.has(row._id); // change handled by delegation
  checkTd.appendChild(chk);
  tr.appendChild(checkTd);

  // Date cell: full value + abbreviated span (CSS swaps them by screen size);
  // stays a click-to-edit tcell.
  const dTd = document.createElement("td");
  dTd.className = "tcell col-date";
  dTd.dataset.field = "txn_date";
  dTd.dataset.type = "date";
  if (row.txn_date) {
    const full = document.createElement("span"); full.className = "date-full"; full.textContent = row.txn_date;
    const abbr = document.createElement("span"); abbr.className = "date-abbr"; abbr.textContent = fmtDateAbbr(row.txn_date);
    dTd.append(full, abbr);
  } else { dTd.textContent = "Date"; dTd.classList.add("empty"); }
  tr.appendChild(dTd);
  tr.appendChild(textCell(row, "description", "text", "col-cat", "categories", "Category"));
  tr.appendChild(textCell(row, "source", "text", "", null, "Source / Recipient"));
  tr.appendChild(textCell(row, "deposit", "number", "num col-dep", null, ""));
  tr.appendChild(textCell(row, "withdrawal", "number", "num col-wd", null, ""));

  // Phone-only "Amount" text cell (signed); edit-on-demand handles field "amount".
  const amt = (Number(row.deposit) || 0) - (Number(row.withdrawal) || 0);
  const amtTd = document.createElement("td");
  amtTd.className = "tcell num col-amt" + (amt > 0 ? " pos" : amt < 0 ? " neg" : "");
  amtTd.dataset.field = "amount";
  amtTd.dataset.type = "number";
  if (amt === 0) { amtTd.textContent = ""; amtTd.classList.add("empty"); }
  else amtTd.textContent = fmt(amt);
  tr.appendChild(amtTd);

  const balTd = document.createElement("td");
  balTd.className = "bal" + (bal < 0 ? " neg" : "");
  balTd.textContent = row._deleted ? "—" : fmt(bal);
  if (!row._deleted && bal < 0) balTd.title = isCard() ? "You've overpaid as of here" : "Balance goes negative here";
  tr.appendChild(balTd);

  const act = document.createElement("td");
  act.className = "row-actions";
  const badge = rowPairBadge(row);
  if (badge) act.appendChild(badge);
  const btn = document.createElement("button");
  btn.className = "del" + (row._deleted ? " restore" : "");
  btn.title = row._deleted ? "Restore" : "Delete";
  btn.textContent = row._deleted ? "↺" : "×"; // click handled by delegation
  act.appendChild(btn);
  tr.appendChild(act);
  return tr;
}

/**
 * The pairing badge for one grid row, staged decisions included — the badge has
 * to show what the row WILL be after Save, not what it is on disk, or the
 * preview the whole staging model exists to provide stops at pairs.
 */
function rowPairBadge(row) {
  if (row._new) {
    if (!row._mirror) return null;
    const el = document.createElement("span");
    el.className = "pair-badge paired staged";
    el.textContent = "↔";
    el.title = `Will be paired with a new row on ${row._mirror.cardName} when you Save.`;
    return el;
  }
  const el = pairBadge(row, { account: state.account, index: state.transfers, accountById: accountById() });
  if (!el) return null;
  if (state.unlink.has(row._id) || (state.dels.has(row._id) && !state.delPairs.has(row._id))) {
    el.className = "pair-badge unpaired staged";
    el.textContent = "⚠";
    el.title = "Will be unlinked on Save, leaving both ends visibly unpaired.";
  } else if (state.propagate.has(row._id)) {
    el.classList.add("staged");
    el.title = "Both ends will be updated on Save.\n\n" + el.title;
  } else if (state.delPairs.has(row._id)) {
    el.classList.add("staged");
    el.title = "The whole transfer will be deleted on Save.\n\n" + el.title;
  }
  return el;
}

// Upgrade a text cell to an input; commit on blur / Enter / Tab, cancel on Esc.
function beginEdit(td) {
  const existing = td.querySelector("input");
  if (existing) { existing.focus(); return; }
  const tr = td.closest("tr");
  if (!tr || tr.classList.contains("to-delete")) return;
  const id = tr.dataset.id, field = td.dataset.field, type = td.dataset.type;
  const inp = document.createElement("input");
  inp.type = type;
  // Amount is signed (negative = withdrawal), so it gets no min; others are ≥0.
  if (type === "number") { inp.step = "0.01"; if (field !== "amount") inp.min = "0"; }
  if (td.dataset.list) inp.setAttribute("list", td.dataset.list);
  if (field === "amount") {
    const a = (Number(stagedValue(id, "deposit")) || 0) - (Number(stagedValue(id, "withdrawal")) || 0);
    inp.value = a !== 0 ? a : "";
  } else {
    const v = stagedValue(id, field);
    inp.value = type === "number" ? (Number(v) > 0 ? v : "") : (v ?? "");
  }
  td.textContent = "";
  td.classList.remove("empty");
  td.appendChild(inp);
  inp.focus();
  if (inp.select) inp.select();

  let done = false;
  inp.addEventListener("blur", () => { if (!done) { done = true; commitEdit(id, field, inp.value, null); } });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    else if (e.key === "Escape") { done = true; render(); }
    else if (e.key === "Tab") { e.preventDefault(); done = true; commitEdit(id, field, inp.value, e.shiftKey ? "prev" : "next"); }
  });
}

function commitEdit(id, field, value, advance) {
  if (field === "amount") {
    // Signed amount → deposit (≥0) / withdrawal (<0); only stage if it changed.
    const a = Number(value) || 0;
    const cur = (Number(stagedValue(id, "deposit")) || 0) - (Number(stagedValue(id, "withdrawal")) || 0);
    if (a !== cur) { stageEditRaw(id, "deposit", a > 0 ? a : 0); stageEditRaw(id, "withdrawal", a < 0 ? -a : 0); }
  } else if (String(value) !== String(stagedValue(id, field) ?? "")) {
    stageEditRaw(id, field, value);
  }
  render(); // cheap in text mode; keeps balances/totals/filter/order correct
  if (advance) advanceEdit(id, field, advance);
}

// After a re-render, open the next/previous editable cell for keyboard flow.
function advanceEdit(id, field, dir) {
  // Skip columns hidden by CSS (Amount on desktop; Category/Deposit/Withdrawal on
  // phone) so Tab never lands on an invisible cell. offsetParent is null when hidden.
  const cells = [...document.querySelectorAll('#rows tr:not(.to-delete) td.tcell')]
    .filter((c) => c.offsetParent !== null);
  const idx = cells.findIndex((c) => c.closest("tr").dataset.id === id && c.dataset.field === field);
  if (idx === -1) return;
  const next = cells[idx + (dir === "prev" ? -1 : 1)];
  if (next) beginEdit(next);
}

// --- T34: paired transfers -------------------------------------------------
//
// Every one of these asks BEFORE staging and stages the ANSWER, so a pairing
// decision discards with Discard like any other pending change. None of them
// writes. The one rule they all enforce: declining leaves a VISIBLY UNPAIRED
// row — never a pair whose two halves disagree.

const PAIR_FIELDS = new Set(["txn_date", "deposit", "withdrawal", "amount"]);
const groupFor = (row) => (row?.transfer_id ? state.transfers.groups[row.transfer_id] : null);
const peerLines = (group, selfId) => (group?.rows || [])
  .filter((r) => r.id !== selfId)
  .map((r) => `<li>${r.account_name} · ${r.txn_date} · ${fmt(r.deposit - r.withdrawal)}</li>`).join("");

/** Offer to mirror a brand-new payment onto the card its `source` names. */
async function askMirrorForNew(draft) {
  if (state.transfers.readOnly) return null; // published view: read-only, no offers
  const plan = mirrorPlan(draft, { account: state.account, accounts: state.accounts });
  if (plan.ok) {
    const amt = Math.abs(signed({ deposit: Number(draft.deposit) || 0, withdrawal: Number(draft.withdrawal) || 0 }));
    const choice = await askPair({
      title: `Mirror this onto ${plan.card.name}?`,
      body: `<b>${fmt(amt)}</b> on ${draft.txn_date} leaves ${state.account.name} toward <b>${plan.card.name}</b>.`
        + ` A payment has two ends, and the other one belongs on the card.`
        + `<br><span class="pair-note">Both rows save together under one transfer id, or neither saves.</span>`,
      options: [
        { value: "mirror", label: `Add both rows`, hint: `${state.account.name} −${fmt(amt)} and ${plan.card.name} +${fmt(amt)}`, primary: true },
        { value: "solo", label: "Add this row only", hint: "The card side stays missing, and the row is flagged ⚠ unpaired" },
        { value: "cancel", label: "Cancel", cancel: true },
      ],
    });
    if (choice === "cancel") return "cancel";
    return choice === "mirror" ? { cardId: plan.card.id, cardName: plan.card.name } : null;
  }
  // A card DOES claim this source but its reconciliation forbids a row here.
  // Worth a sentence: silently not offering looks identical to not noticing.
  if (plan.card) {
    const choice = await askPair({
      title: `Can't mirror onto ${plan.card.name}`,
      body: `${plan.why}.<br><span class="pair-note">Adding the row here is fine — it just won't get a card-side twin, so it will show as ⚠ unpaired.</span>`,
      options: [
        { value: "solo", label: "Add this row only", primary: true },
        { value: "cancel", label: "Cancel", cancel: true },
      ],
    });
    return choice === "cancel" ? "cancel" : null;
  }
  return null;
}

/**
 * An edit landed on a field that both ends of a movement share. Propagate it,
 * or break the link — those are the only two sound answers, and the second is
 * why declining is safe.
 */
async function askPropagate(id, field) {
  if (state.transfers.readOnly) return;
  if (!PAIR_FIELDS.has(field)) return;
  if (state.propagate.has(id) || state.unlink.has(id)) return; // asked already
  const row = state.rows.find((r) => r.id === id);
  const group = groupFor(row);
  if (!group || group.rows.length < 2) return;

  const amountChanged = field !== "txn_date";
  const split = group.rows.length > 2;
  const merged = { ...row, ...(state.edits.get(id) || {}) };
  const now = Math.abs(signed({ deposit: Number(merged.deposit) || 0, withdrawal: Number(merged.withdrawal) || 0 }));
  const was = Math.abs(signed(row));

  const body = `This row is one end of a transfer:<ul class="pair-peers">${peerLines(group, id)}</ul>`
    + (amountChanged ? `Amount ${fmt(was)} → <b>${fmt(now)}</b>.` : `Date ${row.txn_date} → <b>${merged.txn_date}</b>.`)
    + (split && amountChanged
      ? `<br><span class="pair-note">This is a 1:${group.rows.length - 1} split — one payment that arrived as several rows — so a new total can't be divided across them without guessing. Change them individually.</span>`
      : `<br><span class="pair-note">Leaving only one end changed would make the pair reconcile to nothing, so the other option breaks the link instead.</span>`);

  const options = [];
  if (!(split && amountChanged)) {
    options.push({ value: "both", label: "Update both ends", hint: "Keeps the transfer balanced", primary: true });
  }
  options.push({ value: "unlink", label: "Change only this row", hint: "Breaks the link; both rows show as ⚠ unpaired" });
  options.push({ value: "cancel", label: "Undo my edit", cancel: true });

  const choice = await askPair({ title: "This payment is paired", body, options });
  if (choice === "both") state.propagate.add(id);
  else if (choice === "unlink") state.unlink.add(id);
  else {
    // Undo: drop the staged edit entirely and re-read from the server copy.
    state.edits.delete(id);
  }
  render();
}

/** Deleting one end of a movement: take both, or leave the survivor unpaired. */
async function askDeletePair(id) {
  if (state.transfers.readOnly) return true;
  const row = state.rows.find((r) => r.id === id);
  const group = groupFor(row);
  if (!group || group.rows.length < 2) return true;
  const choice = await askPair({
    title: "Delete both ends?",
    body: `This row is one end of a transfer:<ul class="pair-peers">${peerLines(group, id)}</ul>`
      + `<span class="pair-note">Deleting one end alone leaves the other as money with no counterpart, so it gets unlinked and flagged ⚠ rather than left in a one-sided pair.</span>`,
    options: [
      { value: "both", label: "Delete the whole transfer", hint: `${group.rows.length} rows across ${new Set(group.rows.map((r) => r.account_id)).size} accounts`, primary: true },
      { value: "one", label: "Delete only this row", hint: "The other end survives, unlinked and flagged" },
      { value: "cancel", label: "Cancel", cancel: true },
    ],
  });
  if (choice === "cancel") return false;
  if (choice === "both") state.delPairs.add(id);
  return true;
}

// --- add row ---------------------------------------------------------------

const freshDraft = () => ({ txn_date: new Date().toISOString().slice(0, 10), description: "", source: "", deposit: "", withdrawal: "" });
let addDraft = freshDraft();
let tempCounter = 0;

function renderAddRow() {
  const foot = $("#addFoot");
  foot.innerHTML = "";
  const tr = document.createElement("tr");
  tr.className = "add";
  tr.appendChild(document.createElement("td")); // checkbox column spacer
  const mk = (type, key, cls = "", list = null, placeholder = "") => {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    const inp = document.createElement("input");
    inp.type = type; inp.value = addDraft[key]; inp.placeholder = placeholder;
    if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (addDraft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") stageAdd(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("date", "txn_date", "col-date"));
  tr.appendChild(mk("text", "description", "col-cat", "categories", "Category"));
  tr.appendChild(mk("text", "source", "", null, "Source / Recipient"));
  tr.appendChild(mk("number", "deposit", "num col-dep", null, "0.00"));
  tr.appendChild(mk("number", "withdrawal", "num col-wd", null, "0.00"));

  // Phone-only Amount input: a single signed field feeding deposit/withdrawal.
  const amtTd = document.createElement("td");
  amtTd.className = "num col-amt";
  const amtInp = document.createElement("input");
  amtInp.type = "number"; amtInp.step = "0.01"; amtInp.placeholder = "0.00";
  amtInp.value = (Number(addDraft.deposit) || 0) - (Number(addDraft.withdrawal) || 0) || "";
  amtInp.addEventListener("input", () => {
    const a = Number(amtInp.value) || 0;
    addDraft.deposit = a > 0 ? a : "";
    addDraft.withdrawal = a < 0 ? -a : "";
  });
  amtInp.addEventListener("keydown", (e) => { if (e.key === "Enter") stageAdd(); });
  amtTd.appendChild(amtInp);
  tr.appendChild(amtTd);

  // Balance column: the balance-check trigger, in line with the add form.
  const balTd = document.createElement("td");
  balTd.className = "col-bal"; // .num only right-aligns inputs; this cell holds a button
  const chk = document.createElement("button");
  chk.type = "button";
  chk.className = "btn ghost bal-check";
  chk.textContent = "Check";
  if (isCard()) {
    chk.disabled = true;
    chk.title = "Balance check isn't available on card accounts — reconcile against your statement instead";
  } else {
    chk.title = "Compare today's projected balance to your bank and add a correction";
  }
  chk.onclick = toggleBalanceCheck;
  balTd.appendChild(chk);
  tr.appendChild(balTd);

  const act = document.createElement("td");
  act.className = "row-actions";
  const add = document.createElement("button");
  add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = stageAdd;
  act.appendChild(add);
  tr.appendChild(act);
  foot.appendChild(tr);
}

async function stageAdd() {
  if (!addDraft.txn_date) return toast("Date is required");
  if (!addDraft.deposit && !addDraft.withdrawal) return toast("Enter a deposit or withdrawal");
  const draft = { _tempId: "new-" + (++tempCounter), created_at: new Date().toISOString(), ...addDraft };
  const mirror = await askMirrorForNew(draft);
  if (mirror === "cancel") return;          // the draft stays in the add row
  if (mirror) draft._mirror = mirror;
  state.news.push(draft);
  addDraft = freshDraft();
  render();
  toast(mirror ? `Row + card-side mirror added (unsaved)` : "Row added (unsaved)");
}

// --- save / discard --------------------------------------------------------

const pendingCount = () => state.edits.size + state.dels.size + state.news.length;
const hasPending = () => pendingCount() > 0;

function renderControls() {
  const n = pendingCount();
  const save = $("#saveBtn");
  save.disabled = n === 0;
  save.textContent = n ? `Save (${n})` : "Save";
  $("#discardBtn").hidden = n === 0;
  const note = $("#dirtyNote");
  note.hidden = n === 0;
  // Pair work lands on an account you are NOT looking at, so the only place it
  // can be seen before Save is here. Spelling it out is the difference between
  // "I added a payment" and "I added a payment and a row on the Apple Card".
  const mirrors = state.news.filter((x) => x._mirror);
  const bits = [];
  if (mirrors.length) {
    const where = [...new Set(mirrors.map((m) => m._mirror.cardName))].join(", ");
    bits.push(`${mirrors.length} mirrored row${mirrors.length === 1 ? "" : "s"} on ${where}`);
  }
  if (state.propagate.size) bits.push(`${state.propagate.size} paired edit${state.propagate.size === 1 ? "" : "s"} will update both ends`);
  if (state.unlink.size) bits.push(`${state.unlink.size} pair${state.unlink.size === 1 ? "" : "s"} will be unlinked`);
  if (state.delPairs.size) bits.push(`${state.delPairs.size} whole transfer${state.delPairs.size === 1 ? "" : "s"} will be deleted`);
  note.textContent = bits.length ? `unsaved changes · ${bits.join(" · ")}` : "unsaved changes";
}

async function applyPending() {
  if (!hasPending()) return;
  const n = pendingCount();
  $("#saveBtn").disabled = true;
  try {
    for (const nr of state.news) {
      const parent = {
        account_id: state.accountId, txn_date: nr.txn_date,
        description: nr.description, source: nr.source,
        deposit: Number(nr.deposit) || 0, withdrawal: Number(nr.withdrawal) || 0,
      };
      if (!nr._mirror) {
        await api("/api/transactions", { method: "POST", body: parent });
        continue;
      }
      // One call, one SQLite transaction: both ends land or neither does. A
      // sequential POST + POST can leave the card side missing if the second
      // call fails, which is a payment that came out of checking and arrived
      // nowhere — exactly the state T37 assertion #3 exists to catch.
      const transferId = newTransferId();
      const plan = mirrorPlan({ ...parent }, { account: state.account, accounts: state.accounts, transferId });
      if (!plan.ok) throw new Error(`can't mirror onto ${nr._mirror.cardName}: ${plan.why}`);
      await api("/api/transfers", { method: "POST", body: { transfer_id: transferId, creates: [parent, plan.draft] } });
    }
    for (const [id, fields] of state.edits) {
      const row = state.rows.find((r) => r.id === id);
      const tid = row?.transfer_id;
      if (tid && state.propagate.has(id)) {
        // Date / amount travel to every end; the rest is this row's own content.
        const merged = { ...row, ...fields };
        const body = {};
        if ("txn_date" in fields) body.txn_date = merged.txn_date;
        if ("deposit" in fields || "withdrawal" in fields) {
          body.amount = Math.abs(signed({ deposit: Number(merged.deposit) || 0, withdrawal: Number(merged.withdrawal) || 0 }));
        }
        if (Object.keys(body).length) await api(`/api/transfers/${encodeURIComponent(tid)}`, { method: "PATCH", body });
        const own = {};
        for (const k of ["description", "source", "note"]) if (k in fields) own[k] = fields[k];
        if (Object.keys(own).length) await api(`/api/transactions/${id}`, { method: "PATCH", body: own });
        continue;
      }
      await api(`/api/transactions/${id}`, { method: "PATCH", body: fields });
      // Declined propagation: break the link rather than leave two ends that
      // disagree. Both rows become visibly unpaired, which is auditable.
      if (tid && state.unlink.has(id)) {
        await api(`/api/transfers/${encodeURIComponent(tid)}/link`, { method: "DELETE" });
      }
    }
    for (const id of state.dels) {
      const row = state.rows.find((r) => r.id === id);
      const tid = row?.transfer_id;
      if (tid && state.delPairs.has(id)) {
        await api(`/api/transfers/${encodeURIComponent(tid)}`, { method: "DELETE" });
        continue;
      }
      await api(`/api/transactions/${id}`, { method: "DELETE" });
      // The survivor would otherwise sit in a one-row group, which reads as
      // paired. Unlink it so it shows as unpaired, which is what it is.
      if (tid) await api(`/api/transfers/${encodeURIComponent(tid)}/link`, { method: "DELETE" });
    }
    await loadAccounts();
    await loadLedger(); // clears pending + re-renders from the server
    loadSyncStatus();   // saved edits are now unpublished → reveal Publish
    toast(`Saved ${n} change${n === 1 ? "" : "s"}`);
  } catch (err) {
    toast("Error saving: " + err.message);
    renderControls(); // re-enable Save so the user can retry
  }
}

function discardPending() {
  if (!hasPending()) return;
  clearPending();
  render();
  toast("Changes discarded");
}

// --- init ------------------------------------------------------------------

$("#account").addEventListener("change", (e) => {
  if (hasPending() && !confirm("Discard unsaved changes and switch account?")) {
    e.target.value = state.accountId;
    return;
  }
  state.accountId = e.target.value;
  loadLedger();
});

$("#userChip").addEventListener("click", showWho);
$("#saveBtn").addEventListener("click", applyPending);
$("#discardBtn").addEventListener("click", discardPending);

// Low-power mode: one set of delegated listeners on the ledger body instead of
// per-row/-cell listeners. Guarded so the normal grid is completely unaffected.
$("#rows").addEventListener("click", (e) => {
  if (!state.lowPower) return;
  const del = e.target.closest("button.del");
  if (del) { toggleDeleteById(del.closest("tr").dataset.id); return; }
  const td = e.target.closest("td.tcell");
  if (td && document.contains(td)) beginEdit(td);
});
$("#rows").addEventListener("change", (e) => {
  if (!state.lowPower) return;
  const cb = e.target.closest('input[type="checkbox"]');
  const id = cb && cb.closest("tr")?.dataset.id;
  if (!id) return;
  if (cb.checked) state.selected.add(id); else state.selected.delete(id);
  updateSelectionUI();
});

// The toggle itself lives in the global Settings panel (settings.js), which
// owns the localStorage flag and the `body.lowpower` class. All the Ledger has
// to do is swap renderers when it changes — it is the only page with a lighter
// renderer to swap to, so the other four never listen.
window.addEventListener("lowpowerchange", (e) => {
  state.lowPower = !!e.detail?.on;
  render();
});

$("#fClear").addEventListener("click", () => {
  // Clear wipes to show-all (not the default window), so nothing is hidden.
  const { from, to } = tf.clear({ silent: true });
  state.filter = { from, to, categories: new Set(), sources: new Set() };
  buildFilters(); render();
});
document.addEventListener("click", () => closeAllPanels()); // click-away closes dropdowns

$("#selectAll").addEventListener("change", (e) => {
  if (e.target.checked) for (const r of state._shown) state.selected.add(r._id);
  else state.selected.clear();
  updateSelectionUI();
});
$("#bulkField").addEventListener("change", renderBulkValue);
$("#bulkApply").addEventListener("click", () => {
  const field = $("#bulkField").value;
  const valEl = $("#bulkValue");
  if (!field || !valEl) return;
  const n = state.selected.size;
  bulkSetField(field, valEl.value);
  toast(`Updated ${n} row${n === 1 ? "" : "s"} — review and Save`);
});
$("#bulkDelete").addEventListener("click", () => {
  const n = state.selected.size;
  if (!n) return;
  bulkDelete();
  toast(`Marked ${n} row${n === 1 ? "" : "s"} for deletion — Save to apply`);
});
$("#bulkClearSel").addEventListener("click", () => { state.selected.clear(); updateSelectionUI(); });

// --- publish / refresh (Phase 7) -------------------------------------------

async function loadSyncStatus() {
  try {
    const s = await api("/api/sync-status");
    // When, not which version: the most recent moment this machine's data
    // changed hands — published out or pulled in. (Both stamps are ISO UTC, so
    // a lexical sort is a chronological one.)
    const newest = [s.last_published_at, s.last_pulled_at].filter(Boolean).sort().pop() || null;
    const el = $("#syncStatus");
    el.textContent = lastUpdated(newest) + (s.site_stale ? " · site behind" : "");
    el.classList.toggle("stale", !!s.site_stale);
    el.title = [
      `Published from here: ${formatStamp(s.last_published_at)}${s.published_by ? " by " + s.published_by : ""}`,
      `Last refreshed: ${formatStamp(s.last_pulled_at)}`,
      s.site_note || "",
    ].filter(Boolean).join("\n");
    // Only show Publish when there's something to push, Sync when there's something to pull.
    // Hide only when the server explicitly says false, so an older server (or a
    // missing field) leaves the buttons visible rather than hiding them.
    // A stale site also keeps Publish available: the data may match the DB while
    // the *site* is behind because an earlier push failed.
    $("#publishBtn").hidden = s.has_unpublished === false && !s.site_stale;
    $("#refreshBtn").hidden = s.has_unpulled === false;
  } catch { /* ignore */ }
}
$("#publishBtn").addEventListener("click", async () => {
  if (hasPending() && !confirm("You have unsaved changes that won't be included. Publish anyway?")) return;
  if (!confirm("Publish a snapshot to the PUBLIC site? This commits and pushes real balances.")) return;
  $("#publishBtn").disabled = true;
  try {
    const r = await api("/api/publish", { method: "POST", body: { publishedBy: state.currentUser } });
    if (r.pushed) {
      toast(`Published to the site — ${r.stamp}`);
    } else if (r.readonly) {
      toast("This is the read-only published view — nothing to publish from here");
    } else {
      // A failed push means everyone else is still looking at the old numbers.
      // That is far too important to leave as a console warning.
      toast("Publish FAILED — the site was NOT updated");
      alert(
        "The snapshot was written locally but could not be pushed, so the published site is still showing the old data.\n\n" +
        (r.gitOut || "unknown git error") +
        "\n\nFix that, then click Publish again."
      );
    }
    loadSyncStatus();
  } catch (e) { toast("Publish failed: " + e.message); }
  $("#publishBtn").disabled = false;
});
$("#refreshBtn").addEventListener("click", async () => {
  if (hasPending() && !confirm("Sync merges the latest published data. Discard unsaved changes?")) return;
  try {
    const r = await api("/api/refresh", { method: "POST", body: {} });
    toast(`Synced from v${r.version || 0}`);
    await loadAccounts(); await loadLedger(); loadSyncStatus();
  } catch (e) { toast("Sync failed: " + e.message); }
});
window.addEventListener("beforeunload", (e) => { if (hasPending()) { e.preventDefault(); e.returnValue = ""; } });

(async function init() {
  try {
    await loadPeople();
    if (state.people.length <= 1) {
      // Single-person (or empty) household: auto-select and skip the popup.
      state.currentUser = state.people[0]?.id ?? null;
      if (state.currentUser) localStorage.setItem("currentUser", state.currentUser);
    } else if (!state.people.some((p) => p.id === state.currentUser)) {
      showWho(); // multi-person with no valid stored choice → ask who they are
    } else {
      localStorage.setItem("currentUser", state.currentUser); // persist a valid choice
    }
    renderUserChip();
    await loadAccounts();
    await loadLedger();
    loadSyncStatus();
  } catch (e) {
    document.querySelector("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
  }
})();
