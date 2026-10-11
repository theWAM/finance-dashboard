// Credit cards: what is owed, how the debt moved, and when the statement
// closes. This is to the Credit subtab what shared/csp.js is to the Spending
// Plan — pure compute, zero dependencies beyond the other shared modules, no
// DOM and no fetch, identical answers in the browser and in Node.
//
// Decisions this file implements (TASKS.md "Resolved decisions"):
//
//  #22 Debt is a NEGATIVE BALANCE; the sign flips only for display. A card's
//      `opening_balance` is negative, a purchase is a `withdrawal`, a payment or
//      a refund is a `deposit`. So `withRunningBalance`, `accountLedger`,
//      `accountBalance` and `totals` in shared/metrics.js work on cards with no
//      change at all, and the one flip in the compute layer lives here, in
//      `cardDebt()`. A credit balance (you overpaid) reports as NEGATIVE debt
//      rather than being clamped to 0 — flooring it would make the household
//      total wrong by however much you were ahead.
//  #23 A payment is two rows joined by `transfer_id`, not a journal entry. This
//      file only ever reads the card side; the pairing is T34's to write and
//      T37's to police.
//  #24 The card set is owner-scoped: `owner === currentUser || owner ===
//      'shared'`, the same filter the Ledger already uses. `cardAccounts()` is
//      that filter, in one place, so the dropdown (T31), the headline total
//      (T32) and the Dashboard tile (T35) can't disagree about which cards
//      belong to whom.
//  #25/#37 No timeframe control on the Credit subtab: it shares This Paycheck's
//      pay window. `cardSummary()` therefore takes whatever `{from,to}` it is
//      handed and makes no assumption about month alignment. `statementCycle()`
//      exists anyway — the "current statement balance" figure and T37's
//      reconciliation need it — but nothing here mounts it on a picker.
//  #39 No merchant rollup. `byCategory` is the only grouping, because the donut
//      answers "where did it go" and the ledger already lists every merchant.
//  #47 A balance transfer is card-to-card and is NOT a payment. It still moves
//      debt, so it gets its own line rather than being folded into either side
//      (see "the identity" below).
//
// ---------------------------------------------------------------------------
// The identity, and why it has four terms instead of two
//
// The number that makes the subtab worth having is "charged $1,223.80, paid
// $434.00, debt up $789.80" — i.e.
//
//     netPurchases − payments === debtChange
//     openingOwed + debtChange === closingOwed
//
// That holds for every window in which the only things that happened were
// purchases, refunds and payments, which is the overwhelming majority of them.
// It does NOT hold for a window containing a balance transfer (decision #47) or
// an issuer bookkeeping reversal (`Adjustment`), and those are real: Apple
// moved $4,000 to Citi in 2026-05, and a bounced $850 payment was reversed in
// 2026-06. So the full identity this file guarantees to the cent, always, is
//
//     debtChange === netPurchases − payments + transfers + adjustments
//
// with `transfers` and `adjustments` signed toward debt and both exactly 0 in
// an ordinary window — at which point it collapses to the two-term form the UI
// prints. Reporting them as their own lines is the same move csp.js makes with
// its `excluded` line: a dollar the headline doesn't want is still shown
// somewhere rather than silently absorbed into one that doesn't fit it.
// ---------------------------------------------------------------------------

import { live } from "./merge.js";
import { accountBalance } from "./metrics.js";
import { monthOf, monthStart, monthEnd, shiftMonth } from "./timeframe.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);

// --- scope: which accounts are cards, which rows are theirs ----------------

/** A card is where debt lives; every other account type holds cash. */
export const isCardAccount = (a) => a?.type === "credit_card";

/**
 * The cards one person sees (decision #24): their own plus the household's
 * shared ones. `owner` omitted means every card, which is what a check script
 * or the household total wants.
 */
export function cardAccounts(accounts = [], { owner = "" } = {}) {
  return live(accounts).filter((a) => isCardAccount(a) && (!owner || a.owner === owner || a.owner === "shared"));
}

/** The account ids that are cards — the set the two splitters below key on. */
export const cardAccountIds = (accounts = []) => new Set(accounts.filter(isCardAccount).map((a) => a.id));

/**
 * Split a ledger by account type. The reason these exist at all is the trap
 * T27 was written to catch: `summary()` and `monthlySpend()` in
 * shared/metrics.js take *any* transaction list and classify by `description`,
 * and a card purchase carries an ordinary category (`Food`, `Groceries`). So
 * the moment a card account exists, handing either function the whole ledger
 * counts the household's groceries twice — once as the card purchase and once
 * as the checking payment that covered it — and reads every card payment
 * arriving on the card as income. Neither function needs to change; every
 * caller needs to say which scope it meant. These are how it says so.
 *
 * Tombstones are left alone: `live()` is applied downstream by `summary()` and
 * friends, and filtering twice would only hide where the real filter lives.
 */
export function cashRows(transactions = [], accounts = []) {
  const ids = cardAccountIds(accounts);
  return transactions.filter((t) => !ids.has(t.account_id));
}
/** The complement of `cashRows` — only rows on a card account. */
export function cardRows(transactions = [], accounts = []) {
  const ids = cardAccountIds(accounts);
  return transactions.filter((t) => ids.has(t.account_id));
}

// --- the card-specific metadata in accounts.data ---------------------------

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const dayOf = (v) => { const n = num(v); return n && n >= 1 && n <= 31 ? Math.trunc(n) : null; };

/**
 * `accounts.data` normalized once, so no caller has to know that `apr` is
 * stored as a fraction or that an unknown `statement_day` is `null` rather than
 * 0. Unknown stays `null` — T25 left `last4` / `statement_day` / `due_day` /
 * `min_payment` unknown on every card rather than guessing them, and a `0`
 * here would read as "closes on the 0th" instead of "nobody knows yet".
 */
export function cardMeta(account) {
  const d = account?.data || {};
  const range = Array.isArray(d.seeded_range) ? d.seeded_range : [];
  return {
    issuer: d.issuer || "",
    last4: d.last4 || null,
    creditLimit: num(d.credit_limit),
    apr: num(d.apr),
    statementDay: dayOf(d.statement_day),
    dueDay: dayOf(d.due_day),
    minPayment: num(d.min_payment),
    // Decision #47: Citi's 0% is PROMOTIONAL on a 99.3%-utilized card, and a
    // payoff projection that assumes 0% forever promises a date that does not
    // exist. Both are optional and both are unrecorded today, so the projection
    // says "0%, assumed to hold" rather than inventing an end date — but the
    // moment the user enters `promo_apr_until`, `payoffSchedule` steps the rate
    // up on schedule instead of this file needing to change.
    promoAprUntil: d.promo_apr_until || null,
    postPromoApr: num(d.post_promo_apr),
    sourceAliases: Array.isArray(d.source_aliases) ? d.source_aliases.filter(Boolean) : [],
    seededRange: range.length === 2 ? { from: range[0], to: range[1] } : null,
  };
}

// --- what a row on a card ledger is ---------------------------------------

/**
 * A card-side deposit is not one thing. `Credit Card Payment` is cash arriving
 * from checking; `Transfer` is debt arriving from another card (#47); a deposit
 * under an ordinary category is a merchant refund, a statement credit or
 * cashback, and nets against its own category. On the withdrawal side the same
 * split matters: Citi's $5,862.14 `Transfer` is debt moving in, not $5,862.14
 * of shopping, and Apple's $850 `Adjustment` reverses a payment that bounced
 * rather than buying anything.
 *
 * `Loan Payment` rides with `Credit Card Payment` because a card and a loan are
 * the same shape here — money toward a balance you owe.
 */
export const CARD_PAYMENT_CATEGORIES = new Set(["Credit Card Payment", "Loan Payment"]);
export const CARD_TRANSFER_CATEGORIES = new Set(["Transfer"]);
/**
 * Bookkeeping, not activity — the same two categories csp.js excludes as
 * reconciliation artifacts. Re-declared rather than imported from csp.js on
 * purpose: T28 has csp.js reading this module, and a cycle whose entry point is
 * csp.js would reach this line while the binding is still in its temporal dead
 * zone. Two strings, one direction of dependency; `check-cards.js` asserts the
 * two sets still agree.
 */
export const CARD_ARTIFACT_CATEGORIES = new Set(["Adjustment", "Negative Balance"]);

/** `purchase` | `payment` | `balance_transfer` | `adjustment`, by category. */
export function classifyCardRow(row) {
  const c = row?.description || "";
  if (CARD_PAYMENT_CATEGORIES.has(c)) return "payment";
  if (CARD_TRANSFER_CATEGORIES.has(c)) return "balance_transfer";
  if (CARD_ARTIFACT_CATEGORIES.has(c)) return "adjustment";
  return "purchase";
}

// --- debt -----------------------------------------------------------------

const owedOver = (rows, account) => (account ? round2(-accountBalance(rows, account)) : 0);

/**
 * What this card owes, over the whole ledger it is handed — the sign flip of
 * decision #22 and the only one in the compute layer. Negative means a credit
 * balance, deliberately (see the header).
 *
 * Note the ledger runs to 2027-11, so "the whole ledger" includes future-dated
 * rows. For a headline "what you owe today" figure, pass today through
 * `cardDebtAsOf` / `totalDebt`'s `asOf` instead.
 */
export const cardDebt = (transactions = [], account) => owedOver(transactions, account);

/** What this card owed at the end of `dateISO`. `""` means the whole ledger. */
export const cardDebtAsOf = (transactions = [], account, dateISO = "") =>
  dateISO ? owedOver(transactions.filter((t) => t.txn_date <= dateISO), account) : cardDebt(transactions, account);

/** What this card owed going INTO `dateISO` — i.e. before any row on that day. */
export const cardDebtBefore = (transactions = [], account, dateISO = "") =>
  owedOver(dateISO ? transactions.filter((t) => t.txn_date < dateISO) : [], account);

/**
 * The Credit subtab's headline figure over an owner's card set, with the
 * per-card contributions that make it up — returned together so the stat row
 * can break the total down without a second pass over the ledger.
 *
 * `asOf` defaults to today, because "total debt" means what is owed now; pass
 * `asOf: ""` for the end-of-ledger figure including projected rows (which is
 * what `projected` reports alongside it either way).
 *
 * @param {Array} transactions  full ledger (any accounts), raw or live
 * @param {Array} accounts      accounts, for the card set and its metadata
 * @param {{owner?:string, asOf?:string}} [opts]
 */
export function totalDebt(transactions = [], accounts = [], { owner = "", asOf } = {}) {
  const today = asOf === "" ? "" : asOf || todayISO();
  const cards = cardAccounts(accounts, { owner });
  const rows = live(transactions);

  const contributions = cards.map((a) => {
    const mine = rows.filter((t) => t.account_id === a.id);
    const meta = cardMeta(a);
    const debt = cardDebtAsOf(mine, a, today);
    return {
      accountId: a.id, name: a.name, owner: a.owner, issuer: meta.issuer,
      debt,
      projected: cardDebt(mine, a),
      creditLimit: meta.creditLimit,
      // Utilization needs a limit; a card whose limit nobody has entered gets
      // `null`, never a 0% or a divide-by-zero Infinity.
      utilization: meta.creditLimit ? round2(debt / meta.creditLimit) : null,
      apr: meta.apr,
      rows: mine.length,
    };
  }).sort((x, y) => y.debt - x.debt);

  const total = round2(contributions.reduce((s, c) => s + c.debt, 0));
  const withLimit = contributions.filter((c) => c.creditLimit);
  const limit = round2(withLimit.reduce((s, c) => s + c.creditLimit, 0));
  return {
    owner, asOf: today, total,
    projected: round2(contributions.reduce((s, c) => s + c.projected, 0)),
    cards: contributions.map((c) => ({ ...c, share: total ? round2(c.debt / total) : 0 })),
    // Household utilization over the cards whose limit is known, and how many
    // that was — a 71% that silently covers 3 of 6 cards is a lie by omission.
    limit, limitKnown: withLimit.length, cardCount: contributions.length,
    utilization: limit ? round2(round2(withLimit.reduce((s, c) => s + c.debt, 0)) / limit) : null,
  };
}

// --- the per-card rollup --------------------------------------------------

/**
 * The four signed components of a window's debt movement, plus the counts the
 * stat row wants. Every term is a sum of 2-decimal ledger values, so `round2`
 * is exact here and the identities below hold to the cent rather than to within
 * a rounding error.
 *
 * `payments` is signed as a CREDIT (deposits less withdrawals) because that is
 * how it reads — "paid $434". `transfers` and `adjustments` are signed toward
 * DEBT, so a balance transfer onto this card is positive.
 */
function components(rows) {
  let charges = 0, refunds = 0, payments = 0, transfers = 0, adjustments = 0;
  let chargeCount = 0, refundCount = 0, paymentCount = 0;
  for (const r of rows) {
    const dep = Number(r.deposit) || 0, wd = Number(r.withdrawal) || 0;
    switch (classifyCardRow(r)) {
      case "payment": payments += dep - wd; if (dep || wd) paymentCount++; break;
      case "balance_transfer": transfers += wd - dep; break;
      case "adjustment": adjustments += wd - dep; break;
      default:
        charges += wd; refunds += dep;
        if (wd > 0) chargeCount++;
        if (dep > 0) refundCount++;
    }
  }
  charges = round2(charges); refunds = round2(refunds);
  payments = round2(payments); transfers = round2(transfers); adjustments = round2(adjustments);
  const netPurchases = round2(charges - refunds);
  return {
    charges, refunds, netPurchases, payments, transfers, adjustments,
    debtChange: round2(netPurchases - payments + transfers + adjustments),
    count: rows.length, chargeCount, refundCount, paymentCount,
  };
}

/**
 * Where the window's purchases went, net of refunds per category (#39 cut the
 * merchant half of this). Same row shape as csp.js's `groupRows` —
 * `{label, amount, count, share}` — so it feeds the donut directly.
 *
 * A category whose refunds beat its charges comes back with a NEGATIVE amount
 * rather than being dropped or floored: a $273.90 Walmart return is a real
 * thing that happened, and the donut clamping the slice (T31) is a drawing
 * problem, not a reason to lose the number. `charges`/`refunds` ride along so
 * the UI can show the gross pair behind a surprising net.
 */
function categoryRows(rows, total) {
  const m = new Map();
  for (const r of rows) {
    if (classifyCardRow(r) !== "purchase") continue;
    const category = r.description || "";
    const label = category || "—";
    if (!m.has(label)) m.set(label, { label, category, amount: 0, charges: 0, refunds: 0, count: 0 });
    const g = m.get(label);
    const dep = Number(r.deposit) || 0, wd = Number(r.withdrawal) || 0;
    g.charges += wd; g.refunds += dep; g.amount += wd - dep; g.count++;
  }
  return [...m.values()]
    .map((g) => ({
      ...g, amount: round2(g.amount), charges: round2(g.charges), refunds: round2(g.refunds),
      share: total ? round2(g.amount / total) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * One card over one window, in the shape *This Paycheck* already reads in:
 * what it owed going in, what it owes coming out, and the four components that
 * explain the difference.
 *
 * The window is whatever the pay-period control hands over (#37) — no month
 * alignment is assumed and nothing here divides by a month count, which is the
 * one real difference from `computeCsp`: a card rollup is a *movement over this
 * window*, not a monthly average, so there is no `months` divisor to get wrong.
 *
 * @param {object} input
 * @param {Array}  input.transactions  full ledger (any accounts), raw or live
 * @param {object} input.account        the card account, with parsed `data`
 * @param {{from:string,to:string}} [input.window]  `""` on either side = open-ended
 * @param {string} [input.asOf]         today; splits the window into to-date vs projected
 */
export function cardSummary({ transactions = [], account, window: win = {}, asOf } = {}) {
  if (!account) return null;
  const today = asOf || todayISO();
  const from = win.from || "", to = win.to || "";

  const rows = live(transactions).filter((t) => t.account_id === account.id);
  const dates = rows.map((t) => t.txn_date).sort();
  const inWindow = rows.filter((t) => (!from || t.txn_date >= from) && (!to || t.txn_date <= to));

  const openingOwed = cardDebtBefore(rows, account, from);
  const closingOwed = cardDebtAsOf(rows, account, to);
  // The window usually runs past today (the ledger reaches 2027-11), so the
  // figure a person actually recognizes as "what I owe" is neither end of it.
  const owedToDate = cardDebtAsOf(rows, account, to && to < today ? to : today);

  const whole = components(inWindow);
  const meta = cardMeta(account);
  const effectiveTo = to || dates[dates.length - 1] || today;

  return {
    accountId: account.id, name: account.name, owner: account.owner, issuer: meta.issuer,
    window: { from, to }, asOf: today,
    openingOwed, closingOwed, owedToDate,
    ...whole,
    byCategory: categoryRows(inWindow, whole.netPurchases),
    // Same split and the same labeling the CSP uses, for the same reason: part
    // of every "actual" past today is the ledger's own forecast.
    toDate: components(inWindow.filter((t) => t.txn_date <= today)),
    projected: components(inWindow.filter((t) => t.txn_date > today)),
    windowProjected: effectiveTo > today,
    span: { first: dates[0] || "", last: dates[dates.length - 1] || "" },
    seededRange: meta.seededRange,
    creditLimit: meta.creditLimit, apr: meta.apr,
    utilization: meta.creditLimit ? round2(owedToDate / meta.creditLimit) : null,
    rows: inWindow,
    // Recomputed on every call, exactly as computeCsp does with `reconciles`:
    // the window's components have to explain the balance's movement, or one of
    // the two is wrong and the page should not be the thing that finds out.
    reconciles: Math.abs(openingOwed + whole.debtChange - closingOwed) < 0.005,
  };
}

// --- coverage -------------------------------------------------------------

/** Every YYYY-MM a window touches, inclusive. */
function monthsSpanned(from, to) {
  const a = monthOf(from), b = monthOf(to);
  if (!a || !b || a > b) return [];
  const out = [];
  for (let m = a; m <= b; m = shiftMonth(m, 1)) {
    out.push(m);
    if (out.length > 600) break;   // a 50-year window is a bug, not a request
  }
  return out;
}

/**
 * Which months of a window the cards actually have rows for.
 *
 * A window the cards have no rows for UNDER-reports rather than
 * mis-attributes, which is the correct failure and an invisible one: a 70%
 * "underspend" on Groceries looks like thrift and is actually a month nobody
 * loaded a statement for. So name the months, per card, and let the UI say it.
 *
 * Both callers of this live on screens that can lie the same way — the
 * Spending Plan's bucket percentages (T28) and the Credit subtab's rollup
 * (T32) — so it is computed once here rather than twice, agreeing by
 * construction instead of by review.
 *
 * `window.from`/`window.to` are expected RESOLVED (an open-ended window should
 * have been collapsed to its ledger extent by the caller, which is the only
 * place that knows what "all time" means); an empty side falls back to the
 * span of the card rows handed over.
 *
 * @param {object} input
 * @param {Array}  input.transactions  any ledger; non-card rows are ignored
 * @param {Array}  input.accounts      the card accounts in scope
 * @param {{from?:string,to?:string}} [input.window]
 */
export function cardCoverage({ transactions = [], accounts = [], window: win = {} } = {}) {
  const cards = live(accounts).filter(isCardAccount);
  const ids = new Set(cards.map((a) => a.id));
  const rows = live(transactions).filter((t) => ids.has(t.account_id));
  const dates = rows.map((t) => t.txn_date).sort();

  const from = win.from || dates[0] || todayISO();
  const to = win.to || dates[dates.length - 1] || from;
  const months = monthsSpanned(from, to);

  const have = new Map(cards.map((a) => [a.id, new Set()]));
  for (const t of rows) {
    if (t.txn_date >= from && t.txn_date <= to) have.get(t.account_id).add(monthOf(t.txn_date));
  }
  const covered = months.filter((m) => [...have.values()].some((set) => set.has(m)));

  return {
    months,
    cards: cards.map((a) => {
      const mine = have.get(a.id);
      return {
        accountId: a.id, name: a.name,
        months: months.filter((m) => mine.has(m)),
        missing: months.filter((m) => !mine.has(m)),
        // The range T26b actually loaded from statements, so "no rows in
        // 2026-11" can be told apart from "we never had a statement for it".
        seededRange: cardMeta(a).seededRange,
      };
    }),
    covered: covered.length,
    total: months.length,
    // No cards in scope at all is not "0 of 6 months covered" — there is
    // nothing to cover, and the UI should say nothing rather than a warning.
    anyCards: cards.length > 0,
    complete: cards.length > 0 && covered.length === months.length,
  };
}

// --- statement cycles -----------------------------------------------------
//
// Pure string arithmetic on YYYY-MM-DD via timeframe.js's month helpers. No
// `Date` objects: a cycle boundary is a calendar fact, and the one bug this
// avoids outright is a UTC-vs-local off-by-one day on a statement close.

const pad2 = (n) => String(n).padStart(2, "0");
const lastDayOf = (ym) => Number(monthEnd(ym).slice(8));
/** The `day`th of `ym`, clamped to the month's real length (a 31st in Feb). */
const dayInMonth = (ym, day) => `${ym}-${pad2(Math.min(day, lastDayOf(ym)))}`;
const nextDay = (iso) =>
  iso === monthEnd(monthOf(iso)) ? monthStart(shiftMonth(monthOf(iso), 1)) : `${monthOf(iso)}-${pad2(Number(iso.slice(8)) + 1)}`;
const prevDay = (iso) =>
  iso === monthStart(monthOf(iso)) ? monthEnd(shiftMonth(monthOf(iso), -1)) : `${monthOf(iso)}-${pad2(Number(iso.slice(8)) - 1)}`;
/** The first `day`th of a month falling on or after `floorISO`. */
const dayOnOrAfter = (day, floorISO) => {
  const here = dayInMonth(monthOf(floorISO), day);
  return here >= floorISO ? here : dayInMonth(shiftMonth(monthOf(floorISO), 1), day);
};

/**
 * The statement period containing `refDate`: `[start, end]` inclusive, where
 * `end` is the closing date, plus the payment due date. A period runs from the
 * day after the previous close through this close, so `refDate` always falls
 * inside the window returned.
 *
 * `dueDate` is the first `due_day` strictly after the close, which is what
 * makes both real-world layouts come out right without a special case: a card
 * closing on the 18th and due on the 15th is due NEXT month, and one closing on
 * the 3rd and due on the 28th is due in the same one.
 *
 * **`null` when the card has no `statement_day`**, which today is all six of
 * them: T25 left it unknown rather than guessed, and inventing a cycle would
 * put a confident wrong close date on the page. Callers show "unknown" —
 * that is the honest state, and it resolves the day the user enters the day.
 *
 * Per decisions #25/#37 this is never wired into a timeframe picker; it exists
 * for the current-statement-balance figure and T37's reconciliation.
 */
export function statementCycle(account, refDate) {
  const { statementDay, dueDay } = cardMeta(account);
  if (!statementDay) return null;
  const ref = refDate || todayISO();

  let ym = monthOf(ref);
  let end = dayInMonth(ym, statementDay);
  if (end < ref) { ym = shiftMonth(ym, 1); end = dayInMonth(ym, statementDay); }
  const start = nextDay(dayInMonth(shiftMonth(ym, -1), statementDay));

  return { start, end, dueDate: dueDay ? dayOnOrAfter(dueDay, nextDay(end)) : null, statementDay, dueDay };
}

/** The flat minimum a card charges when its balance is too small to matter. */
export const MIN_PAYMENT_FLOOR = 25;
/** The percent-of-balance minimum, used only when the card doesn't state one. */
export const MIN_PAYMENT_PCT = 0.02;

/** True when `minimumDue` had to estimate because the card states no minimum. */
export const minimumDueEstimated = (account) => !(cardMeta(account).minPayment > 0);

/**
 * What this card's minimum payment is: `data.min_payment` when the card states
 * one, otherwise the industry-shaped fallback — the greater of
 * `MIN_PAYMENT_PCT` of the balance and `MIN_PAYMENT_FLOOR`, and never more than
 * the balance itself, since a $12 balance has a $12 minimum however the formula
 * reads. 0 on a paid-off or credit-balance card. Pair it with
 * `minimumDueEstimated()` before putting it on screen: all six cards state no
 * minimum today, so the fallback is the live path, not the edge case.
 *
 * @param {object} account
 * @param {number|Array} cycleRows  the statement balance owed, or the card's
 *   rows through the close, from which that balance is derived
 */
export function minimumDue(account, cycleRows) {
  const owed = typeof cycleRows === "number"
    ? cycleRows
    : owedOver(Array.isArray(cycleRows) ? cycleRows : [], account);
  if (!(owed > 0)) return 0;
  const stated = cardMeta(account).minPayment;
  return round2(Math.min(owed, stated > 0 ? stated : Math.max(MIN_PAYMENT_FLOOR, owed * MIN_PAYMENT_PCT)));
}

/**
 * The "current statement balance" figure: what the last CLOSED statement bills,
 * not what the cycle still accruing shows. `null` when the card has no known
 * statement day — see `statementCycle`.
 */
export function statementBalance(transactions = [], account, refDate) {
  const today = refDate || todayISO();
  const open = statementCycle(account, today);
  if (!open) return null;
  const closed = statementCycle(account, prevDay(open.start));
  const rows = live(transactions).filter((t) => t.account_id === account.id);
  const balance = cardDebtAsOf(rows, account, closed.end);
  return {
    accountId: account.id, asOf: today,
    cycle: closed, accruing: open,
    balance,
    minimumDue: minimumDue(account, balance),
    minimumEstimated: minimumDueEstimated(account),
    dueDate: closed.dueDate,
    movement: components(rows.filter((t) => t.txn_date >= closed.start && t.txn_date <= closed.end)),
  };
}

// --- the payoff projection (T32b) -----------------------------------------
//
// The one number on this subtab that makes a claim about the FUTURE, which is
// why it is a pure function with its own checker assertions rather than a few
// lines inside a render pass. `payoffSchedule` is the whole model; everything
// else here only decides what to feed it.
//
// The recurrence, exactly as specified, in this order:
//
//     interest = balance × apr/12          (on the balance the month OPENS at)
//     gross    = balance + interest + charges
//     payment  = min(scheduled payment, gross)      — never overpay a balance
//     balance  = gross − payment
//
// Every step is rounded to the cent, because an issuer rounds to the cent: a
// schedule computed in full floats and rounded only for display drifts from
// the statement by a few cents a year and makes the last month's figure wrong.
//
// Three things it refuses to do:
//
//  · **Fabricate a payoff date.** A balance that grows returns
//    `payoffMonth: null`. There is no far-future month that means "never", and
//    printing one would be the single most damaging lie available on this page.
//  · **Project past the credit limit.** Once the end-of-month balance clears
//    the limit the issuer starts declining the charges this line assumes, so
//    the series STOPS at that month and reports it as `limitMonth`. Beyond the
//    crossing the model's own premise is false; continuing to draw it would
//    dress that up as data.
//  · **Guess a rate.** `apr: null` is 0% with `aprAssumed: true` set, for the
//    UI to say so on the chart (T32b's flag), never a plausible 22%.
//
// The limit crossing tests the END-of-month balance, not the mid-month peak
// before the payment lands, because the series plots end-of-month balances —
// so the marker sits exactly where the drawn line crosses the dashed rule
// rather than a month before it, for a reason a reader can't see.

const monthsAfter = (ym, n) => shiftMonth(ym, n);
/** A YYYY-MM-DD or YYYY-MM, as the YYYY-MM the projection starts from. */
const startMonthOf = (v) => monthOf(v || todayISO());

/**
 * Amortize a revolving balance forward, month by month.
 *
 * @param {object}  input
 * @param {number}  input.balance   what is owed at the start (negative/0 = nothing to pay)
 * @param {number?} input.apr       annual rate as a FRACTION (0.2574, not 25.74). `null` → 0%, flagged.
 * @param {number}  input.payment   paid every month
 * @param {number}  [input.charges] new charges every month
 * @param {number?} [input.limit]   credit limit; `null` → no crossing is reported
 * @param {number}  [input.months]  hard cap on the horizon (default 360 = 30y)
 * @param {string}  [input.from]    YYYY-MM(-DD) the projection starts in; defaults to this month
 * @param {string?} [input.promoAprUntil]  YYYY-MM(-DD) a promotional `apr` runs through (#47)
 * @param {number?} [input.postPromoApr]   the rate after it; `null` → unknown, flagged
 * @returns {{series, payoffMonth, totalInterest, limitMonth, payoffIndex, limitIndex,
 *   diverges, aprAssumed, promoUnknownFrom, hitCap, monthlyRate}}
 */
export function payoffSchedule({
  balance, apr, payment, charges = 0, limit = null, months = 360, from,
  promoAprUntil = null, postPromoApr = null,
} = {}) {
  const startMonth = startMonthOf(from);
  const aprAssumed = apr == null;
  const baseApr = Number(aprAssumed ? 0 : apr) || 0;
  const promoMonth = promoAprUntil ? monthOf(promoAprUntil) : null;
  // An unknown post-promo rate keeps the promotional one and SAYS so: a card
  // whose teaser ends in 2027 and whose real rate nobody recorded cannot be
  // projected honestly either way, and the choice between "assume 0% forever"
  // and "assume 25%" is the user's to resolve by entering the number.
  const promoUnknown = !!promoMonth && postPromoApr == null;
  const rateFor = (ym) => (!promoMonth || ym <= promoMonth ? baseApr : Number(postPromoApr) || 0) / 12;

  const cap = Math.max(1, Math.trunc(months) || 360);
  const pay = Math.max(0, round2(Number(payment) || 0));
  const chg = Math.max(0, round2(Number(charges) || 0));
  const lim = limit == null ? null : Number(limit);

  let bal = round2(Number(balance) || 0);
  const series = [{ monthIndex: 0, month: startMonth, balance: bal, interest: 0, charges: 0, payment: 0, rate: rateFor(startMonth) }];
  let totalInterest = 0, payoffIndex = null, limitIndex = null, hitCap = false;

  // Nothing owed is a payoff in month zero, not an empty chart — a card you
  // are ahead on is a real state and the panel should say "already clear".
  if (bal <= 0.005) {
    return result({ series, payoffIndex: 0, limitIndex: null, totalInterest: 0, startMonth, aprAssumed, promoUnknown, promoMonth, hitCap, rate: rateFor(startMonth) });
  }

  for (let i = 1; i <= cap; i++) {
    const month = monthsAfter(startMonth, i);
    const interest = round2(bal * rateFor(month));
    const gross = round2(bal + interest + chg);
    const paid = Math.min(pay, Math.max(0, gross));
    bal = round2(gross - paid);
    totalInterest = round2(totalInterest + interest);
    series.push({ monthIndex: i, month, balance: bal, interest, charges: chg, payment: round2(paid), rate: rateFor(month) });

    if (bal <= 0.005) { payoffIndex = i; break; }
    if (lim != null && bal > lim) { limitIndex = i; break; }   // premise broken — stop, don't extrapolate
    if (i === cap) hitCap = true;
  }

  return result({ series, payoffIndex, limitIndex, totalInterest, startMonth, aprAssumed, promoUnknown, promoMonth, hitCap, rate: rateFor(startMonth) });
}

function result({ series, payoffIndex, limitIndex, totalInterest, startMonth, aprAssumed, promoUnknown, promoMonth, hitCap, rate }) {
  return {
    series,
    payoffIndex, payoffMonth: payoffIndex == null ? null : monthsAfter(startMonth, payoffIndex),
    limitIndex, limitMonth: limitIndex == null ? null : monthsAfter(startMonth, limitIndex),
    totalInterest, diverges: payoffIndex == null,
    startMonth, monthlyRate: rate,
    aprAssumed,
    // The month the projection stops being defensible, when a promotional rate
    // ends and nobody has recorded what replaces it.
    promoUnknownFrom: promoUnknown ? monthsAfter(promoMonth, 1) : null,
    hitCap,
  };
}

/**
 * 🚩 The charge rate is a judgment call, so this returns the window it used
 * and how much of it had data — never a bare number.
 *
 * A 3-month trailing average over the three COMPLETE calendar months before
 * `asOf`'s month. Annualizing one pay window (`× 26/12`) is too noisy to put a
 * payoff date on, and the current month is partial by definition.
 *
 * `monthsWithRows` is the part that matters: a card whose statements stop in
 * August averages two months of charges over three and reads 33% calmer than
 * it is, which is exactly the invisible failure `cardCoverage` exists to name.
 * `null` when none of the three months has a single row — unknown, not zero.
 */
export function trailingChargeRate(transactions = [], account, asOf, monthCount = 3) {
  if (!account) return null;
  const end = shiftMonth(monthOf(asOf || todayISO()), -1);
  const first = shiftMonth(end, -(monthCount - 1));
  const months = [];
  for (let m = first; m <= end; m = shiftMonth(m, 1)) months.push(m);

  const rows = live(transactions).filter((t) => t.account_id === account.id);
  const inRange = rows.filter((t) => monthOf(t.txn_date) >= first && monthOf(t.txn_date) <= end);
  const withRows = new Set(inRange.map((t) => monthOf(t.txn_date)));
  const net = components(inRange).netPurchases;

  return {
    months, from: monthStart(first), to: monthEnd(end),
    monthsWithRows: withRows.size,
    // Divided by the FULL month count, not by the months that happened to have
    // rows: a quiet month is a real month of pace, and dividing by 2 because
    // one month is missing data inflates the rate instead of flagging it.
    rate: withRows.size ? round2(net / monthCount) : null,
    net, monthCount,
  };
}

/**
 * The scheduled payment side, which — unlike the charge side — is a real plan:
 * a future-dated `Credit Card Payment` row is literally money someone intends
 * to send (T34 mirrored every one of them onto the card).
 *
 * It is reduced to a monthly RATE rather than replayed date-by-date because
 * the plan runs out — this ledger's mirrored payments stop in 2027-07 — and a
 * schedule that pays nothing after that month would report "never pays off"
 * about a household that simply hasn't written next year's payments down yet.
 * So: the mean over the months the plan covers, carried forward, with the
 * series it came from returned alongside so the UI can name it exactly.
 */
export function scheduledPaymentRate(transactions = [], account, asOf) {
  if (!account) return null;
  const today = asOf || todayISO();
  const rows = live(transactions).filter(
    (t) => t.account_id === account.id && t.txn_date > today && classifyCardRow(t) === "payment",
  );
  const byMonth = new Map();
  for (const t of rows) {
    const m = monthOf(t.txn_date);
    byMonth.set(m, round2((byMonth.get(m) || 0) + ((Number(t.deposit) || 0) - (Number(t.withdrawal) || 0))));
  }
  const months = [...byMonth.keys()].sort();
  const total = round2([...byMonth.values()].reduce((s, n) => s + n, 0));
  // Elapsed months, not months-with-a-payment: a plan with payments in 8 of
  // the next 10 months pays at 8/10 of its own per-payment size, and averaging
  // over only the 8 would claim a pace the plan doesn't have.
  const span = months.length ? monthSpan(months[0], months[months.length - 1]) : 0;
  return {
    rate: span ? round2(total / span) : 0,
    total, count: rows.length, months, span,
    first: months[0] || "", last: months[months.length - 1] || "",
  };
}
const monthSpan = (a, b) => {
  let n = 0;
  for (let m = a; m <= b; m = shiftMonth(m, 1)) { n++; if (n > 600) break; }
  return n;
};

/**
 * The two ledger-derived scenarios the Credit subtab draws, plus everything a
 * caller needs to LABEL them. The what-if third scenario is the same
 * `payoffSchedule` with the sliders' numbers, which the UI runs itself (it is
 * ephemeral by definition — never written to the ledger, never persisted).
 *
 * Reads debt AS OF `asOf`, per decision #58: after T34 a card's all-dates
 * balance is what would be owed if the card were never used again, which is a
 * projection, and projecting a projection forward is how you get a payoff date
 * that is wrong by a year.
 */
export function payoffScenarios({ transactions = [], account, asOf, months = 360 } = {}) {
  if (!account) return null;
  const today = asOf || todayISO();
  const meta = cardMeta(account);
  const rows = live(transactions).filter((t) => t.account_id === account.id);
  const balance = cardDebtAsOf(rows, account, today);

  const charge = trailingChargeRate(rows, account, today);
  const sched = scheduledPaymentRate(rows, account, today);
  const common = {
    balance, apr: meta.apr, limit: meta.creditLimit, months, from: monthOf(today),
    promoAprUntil: meta.promoAprUntil, postPromoApr: meta.postPromoApr,
  };

  return {
    accountId: account.id, asOf: today, balance,
    apr: meta.apr, limit: meta.creditLimit,
    payment: sched.rate, scheduled: sched,
    charge, chargeRate: charge.rate,
    // Scenario 1 keeps charging at the measured pace; an unknown pace (no rows
    // at all in the trailing window) charges nothing and is flagged, because
    // the alternative is inventing the number the whole 🚩 above is about.
    pace: payoffSchedule({ ...common, payment: sched.rate, charges: charge.rate || 0 }),
    // Scenario 2: the same real payment plan, nothing new charged.
    stop: payoffSchedule({ ...common, payment: sched.rate, charges: 0 }),
    minimum: minimumDue(account, balance),
  };
}
