// Shared dashboard renderer — builds the health strip, metric tiles, the
// Conscious Spending Plan strip, the drift table, and a monthly-spend chart
// from { accounts, transactions, planTargets, people }. Used by both the local
// app (dashboard.js) and the published view, so both show identical results.
// Browser-only (uses the DOM); pure computation lives in metrics.js / drift.js /
// csp.js. Injects its own scoped styles (inherits the host palette).

import { summary, monthlySpend } from "./metrics.js";
import { cashRows, totalDebt } from "./cards.js";
import { computeDrift, overallStatus, cardPayoffDrift } from "./drift.js";
import { computeCsp } from "./csp.js";
import { DEFAULT_MONTH_PRESET, monthPresetWindow, presetLabel } from "./timeframe.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt2 = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct1 = (n) => `${(Number(n) || 0).toFixed(1)}%`;
// A delta only means something with its sign attached, and "−$52" reads better
// than "-$52" at 12px (same treatment as the Spending Plan page).
const signed = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : "") + fmt(Math.abs(n));
const NS = "http://www.w3.org/2000/svg";
const STATUS = { good: { label: "On track", icon: "✓", color: "var(--pos)" }, warn: { label: "Watch", icon: "!", color: "var(--warn)" }, bad: { label: "Off track", icon: "✕", color: "var(--neg)" } };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SPEND_LIMIT = 600; // monthly-spend line above this is flagged (pointed + shaded red)

// The single editable number per plan kind (the value shown in the "plan …" tag).
const PLAN_FIELD = { savings_goal: "target_amount", investment_cadence: "monthly_target", debt_payoff: "monthly_payment" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const avatarPath = (p) => String(p || "").replace(/^\//, ""); // "/avatars/x.jpg" → "avatars/x.jpg" (works at root and under /finance-dashboard/)

function ensureStyles() {
  if (document.getElementById("dash-style")) return;
  const s = document.createElement("style");
  s.id = "dash-style";
  s.textContent = `
  .dash { max-width: 1080px; }
  .health { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel); margin-bottom: 20px; }
  .health .badge { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; font-weight: 700; color: var(--on-accent); }
  .health .h-title { font-weight: 700; font-size: 16px; }
  .health .h-sub { color: var(--muted); font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .tile .t-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .tile .t-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .tile .t-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .dash h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 22px 0 10px; }
  .drift-row { display: grid; grid-template-columns: 22px 1.3fr 1fr auto; gap: 12px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; background: var(--panel); }
  .drift-row .st, .csp-row .st { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: var(--on-accent); font-size: 12px; font-weight: 700; }
  .drift-row .d-name, .csp-head .d-name { font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
  .drift-row .d-detail { color: var(--muted); font-size: 12px; }
  .drift-row .d-vals { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
  /* owner avatars — a single circle, or overlapping stack for "shared" */
  .av-stack { display: inline-flex; align-items: center; }
  .av-stack .pav { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; border: 2px solid var(--panel); background: var(--accent); margin-left: -7px; }
  .av-stack .pav:first-child { margin-left: 0; }
  .av-stack .pav-i { display: grid; place-items: center; color: var(--on-accent); font-size: 10px; font-weight: 700; }
  /* editable plan tag */
  .plan-edit { cursor: pointer; border-bottom: 1px dashed var(--muted); }
  .plan-edit:hover { color: var(--text); border-bottom-color: var(--accent); }
  .plan-input { width: 92px; background: var(--panel-2); border: 1px solid var(--accent); border-radius: 6px; color: var(--text); font: inherit; padding: 2px 6px; font-variant-numeric: tabular-nums; }
  /* Conscious Spending Plan strip — one card per plan, one line per bucket */
  .dash h2 .h2-sub { font-weight: 400; }
  .dash h2 .csp-open { float: right; color: var(--accent); text-decoration: none; }
  .dash h2 .csp-open:hover { text-decoration: underline; }
  .csp-strip { display: grid; gap: 10px; }
  /* The card is the grid and every row subgrids onto it, so target / actual /
     delta line up down the whole card instead of each row sizing its own
     columns. Vertical padding and a horizontal rule on a subgrid item don't
     move its tracks, so the row separators are still the rows' own. The
     fixed-width declaration above is the pre-subgrid fallback. */
  .csp-plan { display: grid; grid-template-columns: 22px minmax(110px, 1fr) 160px 160px 80px; column-gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px 8px; }
  .csp-head, .csp-recon { grid-column: 1 / -1; }
  .csp-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .csp-head .csp-tot { margin-left: auto; display: flex; align-items: baseline; gap: 12px; font-size: 13px; }
  .csp-row { display: grid; grid-template-columns: 22px minmax(110px, 1fr) 160px 160px 80px; grid-column: 1 / -1; column-gap: 12px; align-items: center; padding: 7px 0; }
  @supports (grid-template-columns: subgrid) { .csp-row { grid-template-columns: subgrid; } }
  .csp-row + .csp-row { border-top: 1px solid var(--line); }
  .csp-row .c-name { font-weight: 600; }
  .csp-row .c-num, .csp-head .csp-tot { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .csp-row .c-num { font-size: 13px; text-align: right; }
  .csp-strip .lbl { color: var(--muted); font-size: 11px; }
  .csp-strip .pc { color: var(--muted); font-size: 11px; }
  .csp-strip .c-delta { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; min-width: 74px; }
  .csp-strip .c-delta.good { color: var(--pos); }
  .csp-strip .c-delta.warn { color: var(--warn); }
  .csp-strip .c-delta.bad { color: var(--neg); }
  .csp-recon { color: var(--neg); font-size: 12px; padding-top: 6px; }
  .chart-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .axis-label { fill: var(--muted); font-size: 10px; }
  .spend-dot { cursor: default; } .spend-dot:hover { r: 6; }`;
  document.head.appendChild(s);
}

/**
 * @param {object} opts
 * @param {Array} opts.accounts
 * @param {Array} opts.transactions
 * @param {Array} opts.planTargets
 * @param {Array} [opts.people]        for owner avatars
 * @param {string} [opts.asOf]
 * @param {string} [opts.currentUser]  when set, scope tiles + plan to this person (+ shared)
 * @param {(id:string, field:string, value:number)=>any} [opts.onEditPlan]  makes plan tags editable
 */
export function renderDashboard(root, { accounts = [], transactions = [], planTargets = [], people = [], asOf, currentUser = "", onEditPlan } = {}) {
  ensureStyles();
  asOf = asOf || new Date().toISOString().slice(0, 10);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  // User-specific view: a person sees their own + shared accounts and plan items.
  const mine = (owner) => !currentUser || owner === currentUser || owner === "shared";
  const myAccounts = accounts.filter((a) => mine(a.owner));
  const myAccountIds = new Set(myAccounts.map((a) => a.id));
  const myTxns = currentUser ? transactions.filter((t) => myAccountIds.has(t.account_id)) : transactions;
  // The YTD tiles and the spend chart read CASH accounts only, and saying so
  // here is the whole of T27's call-site audit for this file.
  //
  // `summary()` and `monthlySpend()` classify by `description`, and a card
  // purchase carries an ordinary category (`Food`, `Groceries`). So from the
  // moment card ledgers existed, handing them `myTxns` counted the groceries
  // twice — once as the card purchase, once as the checking payment that
  // covered it — and read every payment ARRIVING on a card as income. Measured
  // YTD at 2026-10-08: Woody's outflow +81% ($52.5k → $95.3k), his income
  // +$36.0k, Rajna's outflow +26%; her tiles were affected even though her CSP
  // was not, because this filter is owner-or-shared and `computeCsp`'s is owner
  // equality, and her three cards are `shared`.
  //
  // Cash-only restores exactly the figures T0 verified. It is deliberately NOT
  // the last word on the question: what a card BOUGHT is real spending, and
  // adding it as its own series — rather than silently into a total built from
  // the checking payment — is T35's call, alongside the debt tile. Nothing in
  // metrics.js changed; the scope is explicit at the call site instead.
  const myCashTxns = cashRows(myTxns, myAccounts);
  // A plan can name several owners (data.owners); it's in scope when it includes
  // the current person (or names everyone / no one).
  const minePlan = (pt) => { const ow = resolveOwners(pt.data && pt.data.owners, pt.owner, people); return !currentUser || ow.length === 0 || ow.includes(currentUser); };
  const myPlan = planTargets.filter(minePlan);

  // As-of-today checking balance = opening + net of that account's txns ≤ today.
  const checkingToday = myAccounts.filter((a) => a.type === "checking").reduce((sum, a) => {
    let bal = Number(a.opening_balance) || 0;
    for (const t of myTxns) if (t.account_id === a.id && t.txn_date <= asOf) bal += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
    return sum + bal;
  }, 0);

  const ytd = summary(myCashTxns, { from: yearStart, to: asOf });
  // Drift matches by source, so use the full ledger (a shared goal may be funded
  // by either person) but only for the plan items in scope.
  const drift = computeDrift(transactions, myPlan, { asOf });

  // Real card debt (T35): totalDebt() owns the "what's owed right now, per
  // card" figure; cardPayoffDrift() runs the same payoff math as a
  // hand-entered debt but fed by that real balance and real payment history.
  // A card that already has a hand-entered debt_payoff target (matched by
  // name/issuer/alias) replaces that target's row rather than duplicating it
  // — same debt, real numbers instead of whatever was typed in once.
  const cardDebt = totalDebt(transactions, accounts, { owner: currentUser, asOf });
  const cardDrift = cardPayoffDrift(transactions, accounts, planTargets, { owner: currentUser, asOf });
  const absorbedIds = new Set(cardDrift.map((r) => r.matchedPlanId).filter(Boolean));
  const debts = [...cardDrift, ...drift.filter((d) => d.kind === "debt_payoff" && !absorbedIds.has(d.id))];

  const allDrift = [...debts, ...drift.filter((d) => d.kind !== "debt_payoff")];
  const overall = overallStatus(allDrift);
  const warnings = allDrift.filter((d) => d.status !== "good");

  const cspPlans = cspPlansInScope(planTargets, { accounts, transactions, people, asOf, currentUser });
  // net_worth.debt is hand-entered on the Spending Plan page and goes stale
  // the moment a statement posts; cardDebt.total is computed fresh from the
  // ledger every render. Comparing them (rather than letting the computed
  // figure silently replace the entered one) is cardDebtSection()'s job.
  const enteredDebt = cspPlans.length ? round2(cspPlans.reduce((s, p) => s + (p.netWorth?.debt || 0), 0)) : null;

  const st = STATUS[overall];
  root.className = "dash";
  root.innerHTML = `
    <div class="health">
      <div class="badge" style="background:${st.color}">${st.icon}</div>
      <div>
        <div class="h-title">${overall === "good" ? "Everything's on track" : `${warnings.length} thing${warnings.length === 1 ? "" : "s"} need attention`}</div>
        <div class="h-sub">${warnings.length ? warnings.map((w) => esc(w.name)).join(", ") : "Debts, savings goals and investments are all pacing to plan."}</div>
      </div>
    </div>
    <div class="tiles">
      ${tile("In checking (today)", fmt2(checkingToday))}
      ${tile("Income (YTD)", fmt(ytd.income))}
      ${tile("Spending (YTD)", fmt(ytd.spend), "excl. savings, debt, transfers")}
      ${tile("Saved (YTD)", fmt(ytd.saved), `${ytd.savingsRate}% of income`)}
      ${tile("Invested (YTD)", fmt(ytd.invested), `${ytd.investRate}% of income`)}
      ${tile("Debt paid (YTD)", fmt(ytd.debtPaid))}
      ${cardDebt.cardCount ? tile("Card debt (today)", fmt(cardDebt.total), cardDebt.limitKnown ? `${pct1(cardDebt.utilization * 100)} utilized · ${cardDebt.cardCount} card${cardDebt.cardCount === 1 ? "" : "s"}` : `${cardDebt.cardCount} card${cardDebt.cardCount === 1 ? "" : "s"}`) : ""}
    </div>
    ${cspSection(cspPlans, people)}
    ${cardDebtSection(cardDebt, enteredDebt)}
    ${driftSection("Debts", debts, people, !!onEditPlan)}
    ${driftSection("Savings goals", drift.filter((d) => d.kind === "savings_goal").sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9)), people, !!onEditPlan)}
    ${driftSection("Investments", drift.filter((d) => d.kind === "investment_cadence"), people, !!onEditPlan)}
    <h2>Monthly spending (excl. credit-card &amp; transfers)</h2>
    <div class="chart-card"><svg id="dashSpend" width="100%" height="210" role="img" aria-label="Monthly spending"></svg></div>`;

  const spend = monthlySpend(myCashTxns).filter((m) => m.month <= asOf.slice(0, 7));
  drawSpendChart(root.querySelector("#dashSpend"), spend.slice(-12));

  if (onEditPlan) wirePlanEditing(root, drift, onEditPlan);
}

const tile = (label, value, sub = "") =>
  `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ""}</div>`;

// --- owner avatars ---------------------------------------------------------

function avatarHTML(person) {
  const name = esc(person?.name || "?");
  if (person?.avatar) return `<img class="pav" src="${avatarPath(person.avatar)}" alt="${name}" title="${name}">`;
  return `<span class="pav pav-i" title="${name}">${name.slice(0, 1).toUpperCase()}</span>`;
}
// Resolve a plan's owners to a list of person ids. Prefer the multi-owner array
// (data.owners); fall back to the legacy single owner string ("shared" = all).
function resolveOwners(ownersArray, ownerStr, people) {
  const ids = new Set(people.map((p) => p.id));
  if (Array.isArray(ownersArray) && ownersArray.length) return ownersArray.filter((id) => ids.has(id));
  if (ownerStr === "shared") return people.map((p) => p.id);
  if (ownerStr && ids.has(ownerStr)) return [ownerStr];
  return [];
}
function ownerAvatars(ownerIds, people) {
  const list = ownerIds.length ? ownerIds : people.map((p) => p.id); // none named ⇒ everyone
  const title = list.map((id) => (people.find((p) => p.id === id) || {}).name || id).join(", ");
  return `<span class="av-stack" title="${esc(title)}">${list.map((id) => avatarHTML(people.find((p) => p.id === id) || { name: id })).join("")}</span>`;
}

// --- Conscious Spending Plan strip ----------------------------------------

/**
 * One compact line per CSP bucket: its target share of take-home against its
 * actual share, then the delta, whose red/green is the only status signal on
 * the line (Phase 11’s "one signal per fact" — the same rule the Spending
 * Plan page’s own bucket summary follows).
 *
 * The window is the Spending Plan page’s own default — DEFAULT_MONTH_PRESET
 * (the last three *complete* months) resolved with `monthPresetWindow`, not
 * `presetWindow("3paychecks", …)`. A Conscious Spending Plan is a monthly
 * budget, so averaging it over a 42-day pay window would measure it against a
 * unit it was never written in (resolved decision #11), and a number here has
 * to agree with the number the Spending Plan page opens on.
 *
 * Deliberately additive: no `csp_plan` in scope, or anything at all going wrong
 * in the engine, renders the empty string and leaves the rest of the dashboard
 * exactly as it was.
 */
function cspPlansInScope(planTargets, { accounts, transactions, people, asOf, currentUser }) {
  try {
    // The Spending Plan page is personal-scope (reversed decision #3), so a
    // person sees their own plan — but "Everyone" is this page’s own view, and
    // there it shows every plan, one card each. `shared` is included for the
    // person-scoped view only because nothing stops a household plan existing
    // in the data; the page just never creates one.
    const plans = planTargets.filter(
      (pt) => pt.kind === "csp_plan" && !pt.deleted_at &&
        (!currentUser || pt.owner === currentUser || pt.owner === "shared"),
    );
    if (!plans.length) return [];
    const win = monthPresetWindow(DEFAULT_MONTH_PRESET, { today: asOf });
    // Unscoped accounts/transactions on purpose: the engine scopes each plan to
    // its own owner’s accounts, and pre-filtering to "mine plus shared" would
    // double-count every joint dollar and break its reconciliation check.
    const { plans: computed } = computeCsp({
      transactions, accounts, people,
      cspPlans: plans,
      cspItems: planTargets.filter((pt) => pt.kind === "csp_item"),
      window: win, asOf,
    });
    return computed;
  } catch {
    // A strip that can't be computed is not worth taking the dashboard down for.
    return [];
  }
}

/**
 * Deliberately additive, like `cspPlansInScope`: no computed plans (or
 * anything going wrong rendering them) just leaves the strip off the page.
 */
function cspSection(computed, people) {
  if (!computed.length) return "";
  const cards = computed.map((p) => cspCard(p, people)).join("");
  return `<h2>Spending plan <span class="h2-sub">· monthly average, ${esc(presetLabel(DEFAULT_MONTH_PRESET).toLowerCase())}</span>` +
    `<a class="csp-open" href="csp.html">Open →</a></h2>` +
    `<div class="csp-strip">${cards}</div>`;
}

// target / actual as a share of take-home, with the dollar figure muted beside
// it. A plan with no take-home has no shares to show — 0.0% everywhere would
// be a lie — so the dollars become the headline number instead.
const cspNum = (label, amount, pct, hasPct) =>
  `<div class="c-num"><span class="lbl">${label}</span> <b>${hasPct ? pct1(pct) : fmt2(amount)}</b>` +
  `${hasPct ? ` <span class="pc">${fmt(amount)}</span>` : ""}</div>`;

function cspCard(p, people) {
  const hasPct = p.takeHome > 0;
  const share = (v) => (hasPct ? (v / p.takeHome) * 100 : 0);
  const rows = p.buckets.map((b) => {
    const s = STATUS[b.status] || STATUS.warn;
    // The catch-all absorbs every dollar no plan line claims. That is the whole
    // reason its actual can dwarf its target, and it is worth saying — but not
    // worth a second line on a strip this compact.
    const un = b.catchAll && b.unassigned && b.unassigned.actualMonthly > 0
      ? ` title="Includes ${fmt2(b.unassigned.actualMonthly)}/mo of spending no plan line claims"`
      : "";
    return `<div class="csp-row"${un}>
      <div class="st" style="background:${s.color}" title="${s.label}">${s.icon}</div>
      <div class="c-name">${esc(b.label)}</div>
      ${cspNum("target", b.targetMonthly, b.targetPct, hasPct)}
      ${cspNum("actual", b.actualMonthly, b.actualPct, hasPct)}
      <div class="c-delta ${b.status}">${signed(b.delta)}</div>
    </div>`;
  }).join("");

  // The engine re-checks on every call that every windowed dollar is either
  // bucketed or explicitly excluded. If it ever stops adding up, say so rather
  // than quietly showing numbers that don’t.
  const recon = p.reconciles ? "" :
    `<div class="csp-recon">Doesn’t reconcile: buckets + excluded = ${fmt2(p.total + p.excluded.total)} but the window’s outflow is ${fmt2(p.windowOutflow)}</div>`;

  return `<div class="csp-plan">
    <div class="csp-head">
      <span class="d-name">${esc(p.personName || p.name)} ${ownerAvatars(resolveOwners(null, p.owner, people), people)}</span>
      <div class="csp-tot">${cspNum("target", p.targetMonthly, share(p.targetMonthly), hasPct)}${cspNum("actual", p.actualMonthly, share(p.actualMonthly), hasPct)}<span class="c-delta ${p.status}">${signed(p.actualMonthly - p.targetMonthly)}</span></div>
    </div>
    ${rows}${recon}</div>`;
}

// --- drift rows ------------------------------------------------------------

function driftSection(title, rows, people, editable) {
  if (!rows.length) return "";
  return `<h2>${title}</h2>` + rows.map((r) => {
    const s = STATUS[r.status];
    const perMo = r.kind !== "savings_goal";
    // A real-card row (T35) has no plan_targets row of its own to PATCH — its
    // id is synthetic (`card:<accountId>`) — so it is never editable, and one
    // with no matching hand-entered debt has no fixed target to show at all.
    const isCardRow = String(r.id).startsWith("card:");
    const num = fmt(r.planValue) + (perMo ? "/mo" : "");
    const planTag = isCardRow && !r.matchedPlanId
      ? "no fixed plan"
      : editable && !isCardRow
        ? `plan <span class="plan-edit" data-id="${r.id}" data-field="${PLAN_FIELD[r.kind]}" data-value="${r.planValue}" title="Click to edit the plan target">${num}</span>`
        : `plan ${num}`;
    return `<div class="drift-row">
      <div class="st" style="background:${s.color}" title="${s.label}">${s.icon}</div>
      <div><span class="d-name">${esc(r.name)} ${ownerAvatars(resolveOwners(r.owners, r.owner, people), people)}</span><div class="d-detail">${esc(r.detail)}</div></div>
      <div class="d-detail">${planTag}</div>
      <div class="d-vals">${fmt(r.actualValue)}${perMo ? "/mo" : ""}</div>
    </div>`;
  }).join("");
}

// --- card debt: total + per-card breakdown + entered-vs-computed gap -------

/**
 * `totalDebt()`'s per-card breakdown, then — when at least one Spending Plan
 * is in scope — a row comparing its hand-entered `net_worth.debt` against the
 * same total `totalDebt()` just computed, the same "plan vs. reality" framing
 * `driftSection` uses. `enteredDebt` is `null` (not 0) when no plan is in
 * scope, which is how this tells "nobody has entered a net worth" apart from
 * "entered net worth with zero debt" and skips the comparison rather than
 * printing a false "off by $36,314.92".
 */
function cardDebtSection(cardDebt, enteredDebt) {
  if (!cardDebt.cardCount) return "";
  const rows = cardDebt.cards.map((c) => {
    const util = c.utilization != null ? ` · ${pct1(c.utilization * 100)} of limit` : "";
    return `<div class="drift-row">
      <div class="st" style="background:var(--panel-2)"></div>
      <div><span class="d-name">${esc(c.name)}</span><div class="d-detail">${esc(c.issuer || "")}${util}</div></div>
      <div class="d-detail"></div>
      <div class="d-vals">${fmt(c.debt)}</div>
    </div>`;
  }).join("");

  let compare = "";
  if (enteredDebt != null) {
    const gap = round2(enteredDebt - cardDebt.total);
    const off = Math.abs(gap) > Math.max(25, cardDebt.total * 0.03);
    const s = off ? STATUS.bad : STATUS.good;
    compare = `<div class="drift-row">
      <div class="st" style="background:${s.color}" title="${s.label}">${s.icon}</div>
      <div><span class="d-name">Entered vs. computed</span><div class="d-detail">Spending Plan's net worth says ${fmt(enteredDebt)} owed</div></div>
      <div class="d-detail">ledger says ${fmt(cardDebt.total)}</div>
      <div class="d-vals">${signed(-gap)}</div>
    </div>`;
  }
  return `<h2>Card debt</h2>${rows}${compare}`;
}

// Turn a clicked plan tag into an inline number input; commit calls onEditPlan.
function wirePlanEditing(root, drift, onEditPlan) {
  root.querySelectorAll(".plan-edit").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.querySelector("input")) return;
      const { id, field, value } = el.dataset;
      const input = document.createElement("input");
      input.type = "number"; input.step = "1"; input.className = "plan-input"; input.value = value;
      const prev = el.textContent; el.textContent = ""; el.appendChild(input); input.focus(); input.select();
      let done = false;
      const cancel = () => { if (done) return; done = true; el.textContent = prev; };
      const commit = async () => {
        if (done) return; done = true;
        const v = Number(input.value);
        el.textContent = "saving…";
        try { await onEditPlan(id, field, Number.isFinite(v) ? v : Number(value)); }
        catch (e) { el.textContent = prev; alert("Could not save: " + e.message); }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") cancel(); });
      input.addEventListener("blur", commit);
    });
  });
}

// --- monthly-spend chart (line + shaded area; over-limit pointed & red) ----

function drawSpendChart(svg, data) {
  if (!svg || !data.length) return;
  const W = svg.clientWidth || 800, H = 210, padB = 26, padL = 48, padT = 14, padR = 10;
  const plotW = Math.max(1, W - padL - padR), plotH = H - padB - padT;
  const domainMax = Math.max(SPEND_LIMIT * 1.15, ...data.map((d) => d.amount));
  const x = (i) => padL + (data.length === 1 ? plotW / 2 : (plotW * i) / (data.length - 1));
  const y = (v) => padT + plotH * (1 - v / domainMax);
  const pts = data.map((d, i) => ({ x: x(i), y: y(d.amount), d }));
  const base = y(0), limitY = y(SPEND_LIMIT);
  const linePath = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `M ${pts[0].x.toFixed(1)} ${base.toFixed(1)} ` + pts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L ${pts[pts.length - 1].x.toFixed(1)} ${base.toFixed(1)} Z`;
  const cid = "spclip" + Math.random().toString(36).slice(2, 8);

  const dots = pts.map((p) => {
    const over = p.d.amount > SPEND_LIMIT;
    return `<circle class="spend-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${over ? 5 : 3.5}" fill="${over ? "var(--neg)" : "var(--chart-line)"}" stroke="var(--panel)" stroke-width="1.5"><title>${p.d.month}: ${fmt2(p.d.amount)}${over ? " · over $600" : ""}</title></circle>`;
  }).join("");
  const labels = pts.map((p, i) => {
    const [yr, mm] = p.d.month.split("-").map(Number);
    const txt = (mm === 1 || i === 0) ? `${MON[mm - 1]} ’${String(yr).slice(2)}` : MON[mm - 1];
    return `<text class="axis-label" x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${txt}</text>`;
  }).join("");

  svg.innerHTML = `
    <defs><clipPath id="${cid}"><rect x="${padL}" y="${padT}" width="${(W - padR - padL).toFixed(1)}" height="${Math.max(0, limitY - padT).toFixed(1)}"/></clipPath></defs>
    <line x1="${padL}" x2="${W - padR}" y1="${y(domainMax).toFixed(1)}" y2="${y(domainMax).toFixed(1)}" stroke="var(--line)"/>
    <text class="axis-label" x="4" y="${(y(domainMax) + 4).toFixed(1)}">${fmt(domainMax)}</text>
    <path d="${areaPath}" fill="var(--chart-line)" fill-opacity="0.15"/>
    <path d="${areaPath}" fill="var(--neg)" fill-opacity="0.22" clip-path="url(#${cid})"/>
    <line x1="${padL}" x2="${W - padR}" y1="${limitY.toFixed(1)}" y2="${limitY.toFixed(1)}" stroke="var(--neg)" stroke-dasharray="4 3" stroke-opacity="0.8"/>
    <text class="axis-label" x="4" y="${(limitY + 4).toFixed(1)}" style="fill:var(--neg)">${fmt(SPEND_LIMIT)}</text>
    <path d="${linePath}" fill="none" stroke="var(--chart-line)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}`;
}
