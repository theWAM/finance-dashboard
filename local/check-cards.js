// Acceptance harness for shared/cards.js (Phase 13): run the card engine over
// the real local/dashboard.db and reconcile every figure against independent
// SQL sums or hand-computed tables — every card, three consecutive pay
// windows per owner, three MONTH_PRESETS windows, one fully open one, the
// T32b payoff scenarios, and the Phase 13 cross-task invariants (T37).
//
//   npm run check:cards -- --db
//
// Read-only: it never writes to the database.
//
// Section map: A/B card debt + the totalDebt identity · C the Credit
// subtab's per-window figures · D classifyCardRow · E statementCycle ·
// F minimumDue · G statementBalance · H the cashRows/cardRows scope split ·
// I/J T32b's payoffSchedule and the two ledger-derived scenarios ·
// K transfer pairing (T34, assertions #3/#8) · L external_id uniqueness
// (#4) · M the statement-period ladder (#6) · N cardCoverage's
// seeded_range semantics (#9).
//
// Two assertions from T37's list live elsewhere on purpose rather than
// being duplicated here: #5/#5b (the CSP identity and decision #38's
// coloring) are `local/check-csp.js`'s, since they're about `shared/csp.js`'s
// own output; #7 (fixture-reparse idempotency) is `local/check-import.js`'s,
// since it already asserts it per issuer with synthetic fixtures. `npm run
// check:csp -- --db`, `check:theme`, `check:transfers`, `check:import`,
// `check:bulk` and `check:rules` all still pass — see TASKS.md T37.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cardAccounts, cardMeta, cardDebt, cardDebtAsOf, cardDebtBefore, totalDebt, cardSummary,
  statementCycle, statementBalance, minimumDue, minimumDueEstimated,
  classifyCardRow, cashRows, cardRows, isCardAccount, cardCoverage,
  CARD_ARTIFACT_CATEGORIES, CARD_PAYMENT_CATEGORIES, CARD_TRANSFER_CATEGORIES,
  MIN_PAYMENT_FLOOR, MIN_PAYMENT_PCT,
  // T32b
  payoffSchedule, payoffScenarios, trailingChargeRate, scheduledPaymentRate,
} from "../shared/cards.js";
// T32b's one cross-module obligation: the Dashboard's payoff-drift row (T35)
// and this subtab's scenario 2 must not disagree about the arithmetic they
// share. See section I for what "share" does and does not mean.
import { debtPayoffResult } from "../shared/drift.js";
import { CSP_EXCLUDE } from "../shared/csp.js";
import { summary, monthlySpend, accountBalance } from "../shared/metrics.js";
import { payAnchor, monthPresetWindow, monthOf, monthStart, monthEnd, shiftMonth } from "../shared/timeframe.js";
import { windowFor } from "../shared/paycycle.js";
// T34's pairing invariant (#3/#8) — the exact same function and the exact
// same enumerated exceptions `check:transfers` asserts against, so the two
// checkers can never silently disagree about what counts as paired.
import { auditTransfers, KNOWN_UNPAIRED, unexpectedUnpaired, staleKnownUnpaired } from "../shared/transfers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(join(ROOT, "local", "dashboard.db"));
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

const transactions = all("SELECT * FROM transactions");
const accounts = all("SELECT * FROM accounts").map((a) => ({ ...a, data: safeParse(a.data) }));
const people = all("SELECT * FROM people WHERE deleted_at IS NULL");
function safeParse(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

// The reference date. Fixed rather than `new Date()` so a rerun tomorrow
// compares against the same numbers — the same reason check-csp.js pins it.
const TODAY = process.argv.includes("--today")
  ? process.argv[process.argv.indexOf("--today") + 1]
  : "2026-10-08";

const fmt = (n) => (n == null ? "     —    " : (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(9));
const pct = (n) => (n == null ? "   —  " : (n * 100).toFixed(1).padStart(5) + "%");

let failures = 0, checks = 0;
const check = (label, got, want, tol = 0.005) => {
  checks++;
  const ok = Math.abs((got ?? 0) - (want ?? 0)) <= tol;
  if (!ok) failures++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: got ${fmt(got)} want ${fmt(want)}`);
};
const is = (label, got, want) => {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const head = (t) => console.log(`\n${"═".repeat(100)}\n${t}\n${"═".repeat(100)}`);

const cards = cardAccounts(accounts);
const inList = (xs) => xs.map(() => "?").join(",");
const PAY = [...CARD_PAYMENT_CATEGORIES], XFER = [...CARD_TRANSFER_CATEGORIES], ART = [...CARD_ARTIFACT_CATEGORIES];
const NON_PURCHASE = [...PAY, ...XFER, ...ART];

// --- independent SQL oracle -------------------------------------------------
// Deliberately re-derives each component from the table rather than from the
// module's own classification, so a wrong category landing in the wrong bucket
// shows up as a mismatch instead of agreeing with itself.
function sqlComponents(accountId, { from, to }) {
  const p = [accountId];
  let where = "deleted_at IS NULL AND account_id = ?";
  if (from) { where += " AND txn_date >= ?"; p.push(from); }
  if (to) { where += " AND txn_date <= ?"; p.push(to); }
  const sum = (extra, extraP = []) =>
    one(`SELECT ROUND(COALESCE(SUM(withdrawal),0),2) w, ROUND(COALESCE(SUM(deposit),0),2) d, COUNT(*) n
         FROM transactions WHERE ${where}${extra}`, ...p, ...extraP);

  const purch = sum(` AND description NOT IN (${inList(NON_PURCHASE)})`, NON_PURCHASE);
  const pay = sum(` AND description IN (${inList(PAY)})`, PAY);
  const xfer = sum(` AND description IN (${inList(XFER)})`, XFER);
  const art = sum(` AND description IN (${inList(ART)})`, ART);
  const total = sum("");
  return {
    charges: purch.w, refunds: purch.d, netPurchases: round2(purch.w - purch.d),
    payments: round2(pay.d - pay.w),
    transfers: round2(xfer.w - xfer.d),
    adjustments: round2(art.w - art.d),
    debtChange: round2(total.w - total.d),
    count: total.n,
  };
}
// Debt as of a date, straight from the accounts table and a SQL net — nothing
// in shared/ touched.
function sqlDebtAsOf(account, dateISO) {
  const p = [account.id];
  let where = "deleted_at IS NULL AND account_id = ?";
  if (dateISO) { where += " AND txn_date <= ?"; p.push(dateISO); }
  const r = one(`SELECT ROUND(COALESCE(SUM(withdrawal - deposit),0),2) net FROM transactions WHERE ${where}`, ...p);
  return round2(-(Number(account.opening_balance) || 0) + r.net);
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ===========================================================================
head(`CARD INVENTORY — ${cards.length} cards, as of ${TODAY}`);
console.log("card".padEnd(20), "owner".padEnd(8), "opening".padStart(11), "debt(today)".padStart(12), "debt(ledger)".padStart(13), "limit".padStart(11), "util".padStart(7), "rows".padStart(5));
for (const a of cards) {
  const m = cardMeta(a);
  const mine = transactions.filter((t) => t.account_id === a.id && !t.deleted_at);
  console.log(
    a.id.padEnd(20), String(a.owner).padEnd(8), fmt(a.opening_balance).padStart(11),
    fmt(cardDebtAsOf(mine, a, TODAY)), fmt(cardDebt(mine, a)),
    m.creditLimit == null ? "     —    " : fmt(m.creditLimit), pct(m.creditLimit ? cardDebtAsOf(mine, a, TODAY) / m.creditLimit : null),
    String(mine.length).padStart(5),
  );
}

// ===========================================================================
head("A · cardDebt / cardDebtAsOf / cardDebtBefore vs SQL");
for (const a of cards) {
  console.log(` ${a.id}`);
  check("cardDebt == −accountBalance", cardDebt(transactions, a), -accountBalance(transactions, a));
  check("cardDebt == SQL(−opening + Σ(w−d))", cardDebt(transactions, a), sqlDebtAsOf(a, ""));
  check(`cardDebtAsOf(${TODAY}) == SQL`, cardDebtAsOf(transactions, a, TODAY), sqlDebtAsOf(a, TODAY));
  // A card with no rows yet must report its opening, not 0 — and must report it
  // flipped, which is the one thing a `|| 0` fallback would quietly get wrong.
  check("cardDebtBefore(first row) == −opening", cardDebtBefore(transactions, a, (cardMeta(a).seededRange?.from) || "1900-01-01"), -(Number(a.opening_balance) || 0));
  check("cardDebtAsOf('') == cardDebt (whole ledger)", cardDebtAsOf(transactions, a, ""), cardDebt(transactions, a));
  const half = all("SELECT txn_date FROM transactions WHERE deleted_at IS NULL AND account_id = ? ORDER BY txn_date", a.id);
  if (half.length > 4) {
    const mid = half[Math.floor(half.length / 2)].txn_date;
    check(`cardDebtAsOf(mid ${mid}) == SQL`, cardDebtAsOf(transactions, a, mid), sqlDebtAsOf(a, mid));
    check(`cardDebtBefore(mid ${mid}) == SQL(< mid)`, cardDebtBefore(transactions, a, mid),
      round2(-(Number(a.opening_balance) || 0) + one("SELECT ROUND(COALESCE(SUM(withdrawal - deposit),0),2) net FROM transactions WHERE deleted_at IS NULL AND account_id = ? AND txn_date < ?", a.id, mid).net));
  }
}
// A credit balance must come back NEGATIVE, not clamped — decision #22's whole
// point, and nothing in the real DB exercises it, so it is checked synthetically.
console.log(" synthetic: overpaid card");
const overpaid = { id: "synthetic-overpaid", type: "credit_card", owner: "woody", name: "Overpaid", opening_balance: -100, data: {} };
check("overpaid card reports negative debt", cardDebt([
  { id: "x1", account_id: overpaid.id, txn_date: "2026-01-01", description: "Credit Card Payment", deposit: 250, withdrawal: 0 },
], overpaid), -150);

// ===========================================================================
head("B · totalDebt — the identity Σ cardDebt === totalDebt, per owner scope");
for (const owner of ["", ...people.map((p) => p.id)]) {
  const scoped = cardAccounts(accounts, { owner });
  const t = totalDebt(transactions, accounts, { owner, asOf: TODAY });
  const label = owner || "(all cards)";
  console.log(`\n ${label} — ${t.cards.length} cards, total ${fmt(t.total)}, limit ${fmt(t.limit)} (${t.limitKnown}/${t.cardCount} known), util ${pct(t.utilization)}`);
  for (const c of t.cards) console.log(`   ${c.accountId.padEnd(20)} ${fmt(c.debt)} share ${pct(c.share)} util ${pct(c.utilization)} apr ${c.apr == null ? "  —  " : (c.apr * 100).toFixed(2) + "%"}`);
  ok(`scope is own-or-shared (${scoped.length} cards)`, scoped.every((a) => !owner || a.owner === owner || a.owner === "shared"));
  check("Σ cardDebtAsOf(today) == totalDebt.total", scoped.reduce((s, a) => s + cardDebtAsOf(transactions, a, TODAY), 0), t.total);
  check("Σ cardDebt(ledger) == totalDebt.projected", scoped.reduce((s, a) => s + cardDebt(transactions, a), 0), t.projected);
  check("Σ per-card SQL == totalDebt.total", scoped.reduce((s, a) => s + sqlDebtAsOf(a, TODAY), 0), t.total);
  check("Σ shares == 1 (or 0 with no debt)", t.cards.reduce((s, c) => s + c.share, 0), t.total ? 1 : 0, 0.02);
  check("Σ known limits == totalDebt.limit", scoped.filter((a) => cardMeta(a).creditLimit).reduce((s, a) => s + cardMeta(a).creditLimit, 0), t.limit);
  ok("a card with no stated limit has utilization null, not 0",
    t.cards.filter((c) => c.creditLimit == null).every((c) => c.utilization === null),
    `${t.cards.filter((c) => c.creditLimit == null).length} limitless card(s)`);
}
// The per-card figures T26b reconciled to the cent, re-asserted here so a
// regression reads as "Apple moved" rather than "a number changed".
//
// Two things make this an `asOf` check rather than a whole-ledger one, and both
// are the reason `totalDebt` defaults `asOf` to today:
//   · Chase comes in $40.00 ABOVE its T26b figure, because the issuer's
//     scheduled autopay is dated 2026-10-27 — T26b's replay counted it, and a
//     person asking what they owe today has not paid it yet.
//   · T34's paired-transfer backfill has since put the card half of every
//     planned checking payment on the ledger, out to 2027-07. So the
//     end-of-ledger total is now a PROJECTION (debt after the whole plan runs),
//     which is a useful figure and not this one.
head("B2 · the per-card figures T26b reconciled, re-asserted as of today");
const household = totalDebt(transactions, accounts, { asOf: TODAY });
const T26B = {
  "woody-apple-card": 10421.38, "woody-citi-card": 6750.53, "woody-chase-card": 0,
  "rajna-capital-one": 173.05, "rajna-discover": 17134.81,
  "rajna-chase": 1835.15 + 40, // + the 2026-10-27 autopay that has not landed yet
};
for (const [id, want] of Object.entries(T26B)) {
  check(`${id} debt as of ${TODAY}`, household.cards.find((c) => c.accountId === id)?.debt, want);
}
check("household card debt as of today", household.total, Object.values(T26B).reduce((s, n) => s + n, 0));
check("end-of-ledger total == today − the net of every future-dated card row", household.projected,
  household.total - one(`SELECT ROUND(COALESCE(SUM(deposit - withdrawal),0),2) net FROM transactions
       WHERE deleted_at IS NULL AND txn_date > ? AND account_id IN (SELECT id FROM accounts WHERE type = 'credit_card')`, TODAY).net);
console.log(`   ·  end-of-ledger (after T34's planned payments) ${fmt(household.projected)} vs today ${fmt(household.total)}`);

// ===========================================================================
// Three consecutive pay windows per owner (#37 — the Credit subtab shares This
// Paycheck's window) plus three month presets and one open window.
function windowsFor(owner) {
  const person = people.find((p) => p.id === owner);
  const cash = transactions.filter((t) => !t.deleted_at && accounts.some((a) => a.id === t.account_id && !isCardAccount(a) && a.owner === owner));
  const { cadence, anchor } = payAnchor(cash, { person, today: TODAY });
  const cur = windowFor(cadence, anchor, TODAY);
  const prev = windowFor(cadence, anchor, prevDayOf(cur.start));
  const next = windowFor(cadence, anchor, cur.nextStart);
  return [
    { name: `pay · previous (${cadence})`, win: { from: prev.start, to: prev.end } },
    { name: `pay · current  (${cadence})`, win: { from: cur.start, to: cur.end } },
    { name: `pay · next     (${cadence})`, win: { from: next.start, to: next.end } },
    { name: "month · this month", win: monthPresetWindow("thismonth", { today: TODAY }) },
    { name: "month · last month", win: monthPresetWindow("lastmonth", { today: TODAY }) },
    { name: "month · last 3 months", win: monthPresetWindow("last3months", { today: TODAY }) },
    { name: "open (all time)", win: { from: "", to: "" } },
  ];
}
const prevDayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

for (const owner of people.map((p) => p.id)) {
  const scoped = cardAccounts(accounts, { owner });
  for (const shape of windowsFor(owner)) {
    head(`C · ${owner.toUpperCase()} · ${shape.name} · ${shape.win.from || "(open)"} → ${shape.win.to || "(open)"}`);
    console.log("card".padEnd(20), "opening".padStart(11), "charges".padStart(11), "refunds".padStart(11), "netPurch".padStart(11), "payments".padStart(11), "xfer".padStart(11), "adj".padStart(11), "Δdebt".padStart(11), "closing".padStart(11));
    for (const a of scoped) {
      const s = cardSummary({ transactions, account: a, window: shape.win, asOf: TODAY });
      console.log(
        a.id.padEnd(20), fmt(s.openingOwed), fmt(s.charges), fmt(s.refunds), fmt(s.netPurchases),
        fmt(s.payments), fmt(s.transfers), fmt(s.adjustments), fmt(s.debtChange), fmt(s.closingOwed),
      );
    }
    for (const a of scoped) {
      const s = cardSummary({ transactions, account: a, window: shape.win, asOf: TODAY });
      console.log(`\n  ${a.id} (${s.count} rows in window${s.windowProjected ? ", window runs past today" : ""})`);

      // --- the two identities T32 prints on screen -------------------------
      check("netPurchases == charges − refunds", s.netPurchases, s.charges - s.refunds);
      check("debtChange == netPurchases − payments + transfers + adjustments",
        s.debtChange, s.netPurchases - s.payments + s.transfers + s.adjustments);
      check("openingOwed + debtChange == closingOwed", s.openingOwed + s.debtChange, s.closingOwed);
      ok("engine's own reconciles flag", s.reconciles);
      // In a window with no balance transfer and no adjustment the headline
      // two-term form has to hold exactly, which is what the UI asserts.
      if (!s.transfers && !s.adjustments) check("(clean window) netPurchases − payments == debtChange", s.netPurchases - s.payments, s.debtChange);
      else console.log(`   ·  window carries ${fmt(s.transfers)} transfers / ${fmt(s.adjustments)} adjustments — four-term identity applies`);

      // --- every component against SQL -------------------------------------
      const o = sqlComponents(a.id, shape.win);
      for (const k of ["charges", "refunds", "netPurchases", "payments", "transfers", "adjustments", "debtChange"]) {
        check(`SQL ${k}`, s[k], o[k]);
      }
      is("SQL row count", s.count, o.count);
      check("openingOwed vs SQL", s.openingOwed, shape.win.from
        ? round2(-(Number(a.opening_balance) || 0) + one("SELECT ROUND(COALESCE(SUM(withdrawal - deposit),0),2) net FROM transactions WHERE deleted_at IS NULL AND account_id = ? AND txn_date < ?", a.id, shape.win.from).net)
        : -(Number(a.opening_balance) || 0));
      check("closingOwed vs SQL", s.closingOwed, sqlDebtAsOf(a, shape.win.to));

      // --- byCategory ------------------------------------------------------
      check("Σ byCategory.amount == netPurchases", s.byCategory.reduce((t, g) => t + g.amount, 0), s.netPurchases);
      check("Σ byCategory.charges == charges", s.byCategory.reduce((t, g) => t + g.charges, 0), s.charges);
      check("Σ byCategory.refunds == refunds", s.byCategory.reduce((t, g) => t + g.refunds, 0), s.refunds);
      is("Σ byCategory.count == purchase rows", s.byCategory.reduce((t, g) => t + g.count, 0),
        s.rows.filter((r) => classifyCardRow(r) === "purchase").length);
      ok("byCategory holds no payment/transfer/adjustment category",
        s.byCategory.every((g) => classifyCardRow({ description: g.category }) === "purchase"));
      ok("byCategory sorted by amount desc", s.byCategory.every((g, i, xs) => i === 0 || xs[i - 1].amount >= g.amount));

      // --- to-date / projected split ---------------------------------------
      for (const k of ["charges", "refunds", "netPurchases", "payments", "transfers", "adjustments", "debtChange"]) {
        check(`toDate.${k} + projected.${k} == ${k}`, s.toDate[k] + s.projected[k], s[k]);
      }
      is("toDate.count + projected.count == count", s.toDate.count + s.projected.count, s.count);
      check("owedToDate == SQL as of min(today, to)", s.owedToDate, sqlDebtAsOf(a, shape.win.to && shape.win.to < TODAY ? shape.win.to : TODAY));
      ok("every projected row is after today", s.rows.filter((r) => r.txn_date > TODAY).length === s.projected.count);

      // --- the returned rows are exactly the window ------------------------
      ok("rows are in-window, this account, live",
        s.rows.every((r) => r.account_id === a.id && !r.deleted_at
          && (!shape.win.from || r.txn_date >= shape.win.from) && (!shape.win.to || r.txn_date <= shape.win.to)));
    }
  }
}

// ===========================================================================
head("D · classifyCardRow over all 911 real card rows");
const liveCardRows = transactions.filter((t) => !t.deleted_at && cards.some((a) => a.id === t.account_id));
const dist = new Map();
for (const r of liveCardRows) {
  const k = `${classifyCardRow(r)}  ←  ${r.description}`;
  dist.set(k, (dist.get(k) || 0) + 1);
}
for (const [k, n] of [...dist.entries()].sort()) console.log(`   ${String(n).padStart(4)}  ${k}`);
ok("every live card row classifies into one of four kinds", liveCardRows.every((r) =>
  ["purchase", "payment", "balance_transfer", "adjustment"].includes(classifyCardRow(r))));
// Every dollar on a card ledger lands in exactly one component. Checked by
// partition rather than by sum, so a category in two sets would fail here.
const sets = [CARD_PAYMENT_CATEGORIES, CARD_TRANSFER_CATEGORIES, CARD_ARTIFACT_CATEGORIES];
ok("the three category sets are disjoint", sets.every((s, i) => [...s].every((c) => sets.every((o, j) => i === j || !o.has(c)))));
is("CARD_ARTIFACT_CATEGORIES agrees with csp.js's CSP_EXCLUDE", [...CARD_ARTIFACT_CATEGORIES].sort(), [...CSP_EXCLUDE].sort());

// ===========================================================================
head("E · statementCycle — null while unknown, correct once entered");
for (const a of cards) {
  const m = cardMeta(a);
  ok(`${a.id}: statementCycle is ${m.statementDay ? "built" : "null (statement_day unknown — T25 residual)"}`,
    m.statementDay ? !!statementCycle(a, TODAY) : statementCycle(a, TODAY) === null);
}
console.log("\n  synthetic cycles (the real cards have no statement_day yet)");
const cyc = (statement_day, due_day, ref) => statementCycle({ type: "credit_card", data: { statement_day, due_day } }, ref);
const CYCLES = [
  // [statement_day, due_day, ref, expected start, end, dueDate]
  [18, 15, "2026-10-08", "2026-09-19", "2026-10-18", "2026-11-15", "due day before close → next month"],
  [18, 15, "2026-10-18", "2026-09-19", "2026-10-18", "2026-11-15", "ref ON the close is inside the closing period"],
  [18, 15, "2026-10-19", "2026-10-19", "2026-11-18", "2026-12-15", "day after the close starts the next period"],
  [3, 28, "2026-10-08", "2026-10-04", "2026-11-03", "2026-11-28", "due day after close → same month"],
  [31, 25, "2026-02-10", "2026-02-01", "2026-02-28", "2026-03-25", "31st clamps to a short February, both ends"],
  [31, 25, "2026-03-01", "2026-03-01", "2026-03-31", "2026-04-25", "and the next period starts on Mar 1, not Feb 29"],
  [31, 31, "2026-04-15", "2026-04-01", "2026-04-30", "2026-05-31", "due 31st clamps too"],
  [1, 20, "2026-01-01", "2025-12-02", "2026-01-01", "2026-01-20", "the 1st, across a year boundary"],
  [15, 15, "2026-06-20", "2026-06-16", "2026-07-15", "2026-08-15", "same day for both → due next month"],
];
for (const [sd, dd, ref, wStart, wEnd, wDue, why] of CYCLES) {
  const c = cyc(sd, dd, ref);
  is(`close ${sd} / due ${dd} @ ${ref} — ${why}`, [c.start, c.end, c.dueDate], [wStart, wEnd, wDue]);
  ok(`   ref falls inside [start, end]`, ref >= c.start && ref <= c.end);
  ok(`   dueDate is strictly after the close`, c.dueDate > c.end);
}
is("no due_day → dueDate null, cycle still built", (() => { const c = cyc(18, null, "2026-10-08"); return [c.start, c.end, c.dueDate]; })(), ["2026-09-19", "2026-10-18", null]);
is("no statement_day → null", statementCycle({ type: "credit_card", data: {} }, TODAY), null);
is("junk statement_day (0 / 47) → null", [statementCycle({ data: { statement_day: 0 } }, TODAY), statementCycle({ data: { statement_day: 47 } }, TODAY)], [null, null]);
// Consecutive cycles must tile the calendar with no gap and no overlap.
console.log("\n  12 consecutive cycles tile the calendar (close on the 31st — the hard case)");
let gaps = 0, cursor = null;
for (let i = 0; i < 12; i++) {
  const ref = `2026-${String(i + 1).padStart(2, "0")}-05`;
  const c = cyc(31, 25, ref);
  if (cursor && c.start !== cursor) gaps++;
  cursor = nextDayOf(c.end);
}
ok("no gap or overlap between consecutive periods", gaps === 0, `${gaps} seam(s) wrong`);
function nextDayOf(iso) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

// ===========================================================================
head("F · minimumDue");
const card = (min_payment) => ({ type: "credit_card", opening_balance: 0, data: { min_payment } });
check("stated minimum wins", minimumDue(card(150), 4000), 150);
check("stated minimum capped at the balance owed", minimumDue(card(150), 40), 40);
check("no stated minimum → 2% of balance", minimumDue(card(null), 4000), 80);
check("…but never below the $25 floor", minimumDue(card(null), 600), MIN_PAYMENT_FLOOR);
check("…and never above the balance", minimumDue(card(null), 12), 12);
check("paid-off card owes nothing", minimumDue(card(null), 0), 0);
check("credit balance owes nothing", minimumDue(card(null), -150), 0);
check(`floor/pct crossover at $${MIN_PAYMENT_FLOOR / MIN_PAYMENT_PCT}`, minimumDue(card(null), MIN_PAYMENT_FLOOR / MIN_PAYMENT_PCT), MIN_PAYMENT_FLOOR);
// The rows form: derive the owed figure from the card's own ledger rather than
// being told it, which is the shape T35's drift row will call.
for (const a of cards.slice(0, 3)) {
  const rows = transactions.filter((t) => t.account_id === a.id && !t.deleted_at && t.txn_date <= TODAY);
  check(`${a.id}: minimumDue(rows) == minimumDue(number)`, minimumDue(a, rows), minimumDue(a, cardDebtAsOf(transactions, a, TODAY)));
  ok(`${a.id}: flagged as estimated (no stated min_payment)`, minimumDueEstimated(a));
}
ok("a stated minimum is not flagged estimated", !minimumDueEstimated(card(150)));

// ===========================================================================
head("G · statementBalance — the last CLOSED statement, not the accruing one");
// A real card with its statement_day stripped — not `cards[0]` itself, since
// every seeded card now carries one (T26b's statement loads populated it on
// all six; this used to hold incidentally, before that metadata existed).
is("null while statement_day is unknown", statementBalance(transactions, { ...cards[0], data: { ...cards[0].data, statement_day: null } }, TODAY), null);
// Give a real card a synthetic close date and check the figure against SQL.
for (const a of cards.filter((c) => c.id === "woody-apple-card" || c.id === "rajna-capital-one")) {
  const probe = { ...a, data: { ...a.data, statement_day: 18, due_day: 15 } };
  const sb = statementBalance(transactions, probe, TODAY);
  console.log(`\n ${a.id} with a synthetic close on the 18th`);
  console.log(`   billed period ${sb.cycle.start} → ${sb.cycle.end}, due ${sb.dueDate}; still accruing ${sb.accruing.start} → ${sb.accruing.end}`);
  console.log(`   statement balance ${fmt(sb.balance)}, minimum ${fmt(sb.minimumDue)}${sb.minimumEstimated ? " (estimated)" : ""}`);
  ok("the billed period has already closed", sb.cycle.end < TODAY);
  ok("the accruing period contains today", TODAY >= sb.accruing.start && TODAY <= sb.accruing.end);
  is("the two periods are adjacent", nextDayOf(sb.cycle.end), sb.accruing.start);
  check("balance == SQL debt as of the close", sb.balance, sqlDebtAsOf(a, sb.cycle.end));
  const o = sqlComponents(a.id, { from: sb.cycle.start, to: sb.cycle.end });
  check("movement.debtChange == SQL over the billed period", sb.movement.debtChange, o.debtChange);
  check("movement.charges == SQL", sb.movement.charges, o.charges);
  check("balance == debt before the period + its movement", sb.balance,
    cardDebtBefore(transactions.filter((t) => t.account_id === a.id), a, sb.cycle.start) + sb.movement.debtChange);
}

// ===========================================================================
// T32b. The only figure on the Credit subtab that makes a claim about the
// FUTURE, so it is checked the way an amortization schedule has to be: against
// tables computed by hand, outside this file, cent by cent — not against a
// second implementation that could be wrong in the same direction.
//
// The three tables below were worked out longhand from the stated recurrence
//
//     interest = round2(balance × apr/12)
//     gross    = round2(balance + interest + charges)
//     payment  = min(scheduled, gross)
//     balance  = round2(gross − payment)
//
// and every month's closing balance is asserted, not just the final answer: a
// schedule can land on the right payoff month by two errors cancelling.
head("I · T32b — payoffSchedule against hand-computed amortization tables");

// Table 1 — $1,000.00 at 24.00% APR (2.00%/mo), $100.00/mo, no new charges.
// Total paid 11 × $100.00 + $27.04 = $1,127.04 = principal + $127.04 interest.
const T1 = {
  input: { balance: 1000, apr: 0.24, payment: 100, from: "2026-10" },
  balances: [1000, 920, 838.40, 755.17, 670.27, 583.68, 495.35, 405.26, 313.37, 219.64, 124.03, 26.51, 0],
  payoffIndex: 12, payoffMonth: "2027-10", totalInterest: 127.04,
};
// Table 2 — $5,000.00 at 19.74% APR (1.645%/mo), $500.00/mo, no new charges.
// Total paid 11 × $500.00 + $7.62 = $5,507.62 = principal + $507.62 interest.
const T2 = {
  input: { balance: 5000, apr: 0.1974, payment: 500, from: "2026-10" },
  balances: [5000, 4582.25, 4157.63, 3726.02, 3287.31, 2841.39, 2388.13, 1927.41, 1459.12, 983.12, 499.29, 7.50, 0],
  payoffIndex: 12, payoffMonth: "2027-10", totalInterest: 507.62,
};
// Table 3 — DIVERGENT: $4,000.00 at 25.74% APR (2.145%/mo), $500.00/mo paid
// against $1,000.00/mo charged, $10,500.00 limit. Never pays off; the
// end-of-month balance first clears the limit in month 11.
const T3 = {
  input: { balance: 4000, apr: 0.2574, payment: 500, charges: 1000, limit: 10500, from: "2026-10" },
  balances: [4000, 4585.80, 5184.17, 5795.37, 6419.68, 7057.38, 7708.76, 8374.11, 9053.73, 9747.93, 10457.02, 11181.32],
  payoffIndex: null, payoffMonth: null, limitIndex: 11, limitMonth: "2027-09",
};

for (const [name, T] of [["table 1 (1000 / 24.00% / 100)", T1], ["table 2 (5000 / 19.74% / 500)", T2], ["table 3 (4000 / 25.74% / 500 + 1000, limit 10500)", T3]]) {
  console.log(` ${name}`);
  const r = payoffSchedule(T.input);
  is("   closing balance, every month", r.series.map((x) => x.balance), T.balances);
  is("   payoffIndex", r.payoffIndex, T.payoffIndex);
  is("   payoffMonth", r.payoffMonth, T.payoffMonth);
  is("   limitMonth", r.limitMonth, T.limitMonth ?? null);
  if (T.totalInterest != null) check("   totalInterest", r.totalInterest, T.totalInterest);
  // Month labels advance by exactly one month from the start, every row.
  is("   months are consecutive from the start month",
    r.series.map((x) => x.month),
    r.series.map((_, i) => shiftMonth(monthOf(T.input.from), i)));
  // Every row explains itself: this is the recurrence, re-applied row by row.
  ok("   every row satisfies balance = prev + interest + charges − payment",
    r.series.slice(1).every((x, i) => Math.abs(round2(r.series[i].balance + x.interest + x.charges - x.payment) - x.balance) < 0.005));
  // And the whole schedule closes: principal + interest = everything paid.
  const paid = round2(r.series.reduce((t, x) => t + x.payment, 0));
  const charged = round2(r.series.reduce((t, x) => t + x.charges, 0));
  check("   principal + charges + interest − paid == closing balance",
    round2(T.input.balance + charged + r.totalInterest - paid), r.series[r.series.length - 1].balance);
}

console.log(" refusals — the four things it must not invent");
{
  // A divergent schedule with no limit stops at the horizon cap and reports
  // `null`, rather than looping forever or naming a fabricated far-future date.
  const noLimit = payoffSchedule({ balance: 4000, apr: 0.2574, payment: 500, charges: 1000, months: 24, from: "2026-10" });
  is("   divergent, no limit → payoffMonth null", noLimit.payoffMonth, null);
  is("   divergent, no limit → limitMonth null", noLimit.limitMonth, null);
  ok("   divergent, no limit → stops at the cap, not forever", noLimit.hitCap && noLimit.series.length === 25,
    `series ${noLimit.series.length} rows, hitCap ${noLimit.hitCap}`);
  ok("   divergent → diverges flag set", noLimit.diverges);

  // A divergent schedule WITH a limit stops at the crossing — the month after
  // which the model's own premise (these charges keep going through) is false.
  const withLimit = payoffSchedule({ balance: 4000, apr: 0.2574, payment: 500, charges: 1000, limit: 10500, months: 360, from: "2026-10" });
  ok("   divergent, with limit → stops at the crossing, not the 360-month cap",
    withLimit.series.length === 12 && !withLimit.hitCap, `${withLimit.series.length} rows`);
  ok("   the crossing is the first month ABOVE the limit",
    withLimit.series[withLimit.limitIndex].balance > 10500 && withLimit.series[withLimit.limitIndex - 1].balance <= 10500);

  // No payment is "never", not "in 360 months".
  const unpaid = payoffSchedule({ balance: 500, apr: 0.2, payment: 0, months: 36, from: "2026-10" });
  is("   payment 0 → payoffMonth null", unpaid.payoffMonth, null);

  // No APR projects at 0% and SAYS so. It never guesses a plausible rate.
  const noApr = payoffSchedule({ balance: 1200, apr: null, payment: 100, from: "2026-10" });
  ok("   apr null → aprAssumed set", noApr.aprAssumed);
  check("   apr null → zero interest", noApr.totalInterest, 0);
  is("   apr null → straight line to payoff in balance/payment months", noApr.payoffIndex, 12);

  // Nothing owed is a payoff in month zero, not an empty chart.
  for (const [label, bal] of [["zero", 0], ["credit (overpaid)", -250]]) {
    const clear = payoffSchedule({ balance: bal, apr: 0.25, payment: 100, from: "2026-10" });
    is(`   ${label} balance → payoffIndex 0, single point`, [clear.payoffIndex, clear.series.length], [0, 1]);
  }
}

console.log(" decision #47 — a promotional 0% that ends");
{
  // 12 months at 0%, then 24.00%. The step is on the MONTH, so month 12 is
  // still free and month 13 is the first to accrue.
  const promo = payoffSchedule({
    balance: 2400, apr: 0, payment: 100, from: "2026-10",
    promoAprUntil: "2027-10", postPromoApr: 0.24,
  });
  check("   no interest through the promo month", round2(promo.series.slice(0, 13).reduce((t, x) => t + x.interest, 0)), 0);
  ok("   interest starts the month after it ends", promo.series[13].interest > 0);
  ok("   and the payoff is LATER than the 24 months 0% would have given", promo.payoffIndex > 24, `payoffIndex ${promo.payoffIndex}`);
  const unknown = payoffSchedule({ balance: 2400, apr: 0, payment: 100, from: "2026-10", promoAprUntil: "2027-10" });
  is("   post-promo rate unknown → promoUnknownFrom names the month", unknown.promoUnknownFrom, "2027-11");
  check("   and the projection holds the promo rate rather than guessing", unknown.totalInterest, 0);
}

// ---------------------------------------------------------------------------
// T32b's one cross-task obligation, stated precisely.
//
// The task text says T35's projected payoff month should equal scenario 2's
// "because both consume the same scheduled-payment series". As SHIPPED they do
// not, and should not: `cardPayoffDrift` measures the TRAILING ACTUAL payment
// (payments already made ÷ months elapsed) and carries NO interest term, while
// scenario 2 uses the payments the ledger has SCHEDULED and compounds at
// apr/12. Two different questions — "is this card moving?" versus "when does
// this balance retire?" — and forcing either to the other's answer would make
// one of them wrong.
//
// What must agree is the ARITHMETIC KERNEL, and that is asserted: strip the
// interest (apr 0) and the charges, hand both the same balance and the same
// monthly payment, and the two implementations must name the same month. Any
// divergence there is a real bug in one of them.
console.log(" agreement with T35's debt_payoff projection (shared kernel, apr 0)");
for (const [bal, pay] of [[1200, 100], [10421.38, 881.20], [173.05, 304.44], [17134.81, 2057.14], [999.99, 50]]) {
  const mine = payoffSchedule({ balance: bal, apr: 0, payment: pay, from: monthOf(TODAY) });
  const theirs = debtPayoffResult({ id: "x", name: "x", owner: "x", balance: bal, actualMonthly: pay, asOf: TODAY });
  const theirMonth = (theirs.detail.match(/payoff ~(\d{4}-\d{2})/) || [])[1] || null;
  is(`   balance ${bal} at ${pay}/mo`, mine.payoffMonth, theirMonth);
}

// ===========================================================================
head("J · T32b — the two ledger-derived scenarios, over the real cards");
console.log("card".padEnd(20), "balance".padStart(11), "sched/mo".padStart(10), "chg/mo".padStart(11), "pace".padStart(9), "limit@".padStart(9), "stop".padStart(9), "interest".padStart(11));
for (const a of cards) {
  const sc = payoffScenarios({ transactions, account: a, asOf: TODAY });
  console.log(
    a.id.padEnd(20), fmt(sc.balance), fmt(sc.payment).trim().padStart(10),
    (sc.chargeRate == null ? "unknown" : fmt(sc.chargeRate).trim()).padStart(11),
    String(sc.pace.payoffMonth || "never").padStart(9),
    String(sc.pace.limitMonth || "—").padStart(9),
    String(sc.stop.payoffMonth || "never").padStart(9),
    fmt(sc.stop.totalInterest),
  );
}
for (const a of cards) {
  console.log(` ${a.id}`);
  const mine = transactions.filter((t) => t.account_id === a.id && !t.deleted_at);
  const sc = payoffScenarios({ transactions, account: a, asOf: TODAY });
  const m = cardMeta(a);

  check("   starts from debt as of today, not end-of-ledger (#58)", sc.balance, sqlDebtAsOf(a, TODAY));
  is("   apr and limit are the card's, unaltered", [sc.apr, sc.limit], [m.apr, m.creditLimit]);

  // The charge pace, against an independent SQL sum over the same 3 months.
  const tc = trailingChargeRate(mine, a, TODAY);
  const sqlTrail = sqlComponents(a.id, { from: monthStart(tc.months[0]), to: monthEnd(tc.months[tc.months.length - 1]) });
  check("   3-month trailing net purchases == SQL", tc.net, sqlTrail.netPurchases);
  is("   trailing window is the 3 complete months before this one",
    tc.months, [3, 2, 1].map((k) => shiftMonth(monthOf(TODAY), -k)));
  if (tc.rate != null) check("   rate == net ÷ 3 (the full window, not the months with rows)", tc.rate, round2(tc.net / 3));
  else ok("   no rows in the trailing window → rate is null, never 0", tc.monthsWithRows === 0);

  // The scheduled payment side, against SQL over future-dated payment rows.
  const sp = scheduledPaymentRate(mine, a, TODAY);
  const sqlSched = one(`SELECT ROUND(COALESCE(SUM(deposit - withdrawal),0),2) net, COUNT(*) n FROM transactions
                        WHERE deleted_at IS NULL AND account_id = ? AND txn_date > ? AND description IN (${inList(PAY)})`,
    a.id, TODAY, ...PAY);
  check("   scheduled payments total == SQL", sp.total, sqlSched.net);
  is("   scheduled payment row count == SQL", sp.count, sqlSched.n);
  if (sp.span) check("   rate == total ÷ elapsed months of the plan", sp.rate, round2(sp.total / sp.span));

  // Scenario ordering: charging nothing can never retire a balance more slowly
  // than charging something. If the pace line pays off, the stop line must too,
  // no later and for no more interest.
  if (sc.pace.payoffMonth) {
    ok("   stop pays off no later than pace", sc.stop.payoffMonth != null && sc.stop.payoffMonth <= sc.pace.payoffMonth,
      `pace ${sc.pace.payoffMonth} vs stop ${sc.stop.payoffMonth}`);
    ok("   and for no more interest", sc.stop.totalInterest <= sc.pace.totalInterest + 0.005);
  }
  // A card with no limit recorded gets no crossing — never a guessed one.
  if (m.creditLimit == null) is("   no limit recorded → no limit month on either line", [sc.pace.limitMonth, sc.stop.limitMonth], [null, null]);
  // A card with no APR projects at 0% and is flagged as having done so.
  if (m.apr == null) ok("   no APR recorded → flagged, and zero interest", sc.stop.aprAssumed && sc.stop.totalInterest === 0);
}

console.log(" the degraded cards, forced: a synthetic card with neither apr nor limit");
{
  const bare = { id: "synthetic", name: "No metadata", owner: "woody", type: "credit_card", opening_balance: -3000, data: {} };
  const rows = [{ account_id: "synthetic", txn_date: "2026-08-15", description: "Food", withdrawal: 120, deposit: 0 }];
  const sc = payoffScenarios({ transactions: rows, account: bare, asOf: TODAY });
  check("   balance is still exact", sc.balance, 3120);
  is("   apr and limit both unknown", [sc.apr, sc.limit], [null, null]);
  ok("   projects at 0%, flagged, with no limit line", sc.pace.aprAssumed && sc.pace.limitMonth === null);
  is("   and with no scheduled payments it reports never, not a date", sc.stop.payoffMonth, null);
}

// ===========================================================================
head("H · the scope split — cashRows / cardRows, and the double count they close");
const liveAll = transactions.filter((t) => !t.deleted_at);
const cash = cashRows(liveAll, accounts), oncard = cardRows(liveAll, accounts);
is("cash + card == the whole ledger, no row in both", [cash.length + oncard.length, liveAll.length], [liveAll.length, liveAll.length]);
ok("no card row in the cash set", cash.every((t) => !cards.some((a) => a.id === t.account_id)));
ok("every card row is on a card account", oncard.every((t) => cards.some((a) => a.id === t.account_id)));
ok("an account list with no cards leaves the ledger whole", cashRows(liveAll, accounts.filter((a) => !isCardAccount(a))).length === liveAll.length);

console.log("\n  what the Dashboard's YTD tiles would read at each scope (the audit T27 owes):");
const yearStart = `${TODAY.slice(0, 4)}-01-01`;
console.log("  person  scope".padEnd(32), "income".padStart(12), "outflow".padStart(12), "spend".padStart(12), "debtPaid".padStart(12));
for (const p of people) {
  const visible = accounts.filter((a) => !a.deleted_at && (a.owner === p.id || a.owner === "shared"));
  const ids = new Set(visible.map((a) => a.id));
  const mine = liveAll.filter((t) => ids.has(t.account_id));
  for (const [label, rows] of [["whole ledger (was wrong)", mine], ["cash only (now)", cashRows(mine, visible)]]) {
    const s = summary(rows, { from: yearStart, to: TODAY });
    console.log(`  ${p.id.padEnd(7)} ${label}`.padEnd(32), fmt(s.income), fmt(s.outflow), fmt(s.spend), fmt(s.debtPaid));
  }
  const cashOnly = summary(cashRows(mine, visible), { from: yearStart, to: TODAY });
  const sqlCash = one(`SELECT ROUND(COALESCE(SUM(deposit),0),2) dep FROM transactions
                       WHERE deleted_at IS NULL AND txn_date BETWEEN ? AND ?
                         AND account_id IN (SELECT id FROM accounts WHERE deleted_at IS NULL AND type <> 'credit_card' AND (owner = ? OR owner = 'shared'))`,
    yearStart, TODAY, p.id);
  check(`  ${p.id} cash-scoped income == SQL over non-card accounts`, cashOnly.income, sqlCash.dep);
  ok(`  ${p.id} cash-scoped income excludes card-side payments`,
    cashOnly.income < summary(mine, { from: yearStart, to: TODAY }).income || !cardRows(mine, visible).length);
  const m = monthlySpend(cashRows(mine, visible)).find((x) => x.month === TODAY.slice(0, 7));
  const mAll = monthlySpend(mine).find((x) => x.month === TODAY.slice(0, 7));
  console.log(`   ·  ${p.id} monthlySpend ${TODAY.slice(0, 7)}: cash ${fmt(m?.amount ?? 0)} vs whole-ledger ${fmt(mAll?.amount ?? 0)}`);
}

// ===========================================================================
head("K · transfer pairing (T34) — assertions #3 and #8, live against the DB");
{
  const audit = auditTransfers({ transactions: liveAll, accounts });
  ok(`no mismatched groups (a pair whose ends disagree)`, audit.mismatched.length === 0, `${audit.mismatched.length} found`);
  ok(`no alias collisions (two cards claiming one source string)`, audit.aliasCollisions.length === 0, `${audit.aliasCollisions.length} found`);
  ok(`#8 — no same-date/amount unlinked PAYMENT pairs on one card (the T26b/T34 double-mirror failure)`,
    audit.doubleRisk.length === 0, `${audit.doubleRisk.length} found`);
  console.log(`   ·  card-side-only rows — valid, decision #48: ${audit.soloCardSide.length}`);
  console.log(`   ·  duplicate same-day charges — informational, genuine data: ${audit.duplicateCharges.length}`);

  // #3 — every `Credit Card Payment` row has a transfer_id and a live
  // counterpart of the opposite sign and an equal amount: zero unpaired,
  // zero mismatched. The real ledger carries a known, enumerated set of
  // exceptions (pre-anchor rows already absorbed into `opening_balance`, and
  // a handful of near-misses a human has to settle by hand) — asserted
  // against the SAME list `check:transfers` does, not a second copy of it.
  const unexpected = unexpectedUnpaired(audit.unpairedOutflow);
  ok(`#3 — every unpaired checking-side outflow is one of the ${KNOWN_UNPAIRED.length} enumerated, explained exceptions`,
    unexpected.length === 0,
    unexpected.length ? unexpected.map((u) => `${u.row.txn_date} ${u.row.source} ${u.row.withdrawal}`).join("; ") : "");
  const stale = staleKnownUnpaired(audit.unpairedOutflow);
  ok(`no stale exceptions (rows that have since been paired — the list would be lying by omission)`,
    stale.length === 0, stale.length ? `${stale.length} stale` : "");
}

// ===========================================================================
head("L · external_id is unique per account (T37 #4 — catches T29's dedupe)");
{
  const rows = one(`SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL AND external_id IS NOT NULL`).n;
  const dupes = all(`SELECT account_id, external_id, COUNT(*) n FROM transactions
                      WHERE deleted_at IS NULL AND external_id IS NOT NULL
                      GROUP BY account_id, external_id HAVING COUNT(*) > 1`);
  ok(`every external_id is unique within its account — ${rows} fingerprinted rows, 0 collisions`,
    dupes.length === 0, dupes.length ? dupes.map((d) => `${d.account_id}/${d.external_id} ×${d.n}`).join("; ") : "");
}

// ===========================================================================
head("M · the statement-period ladder (T37 #6) — computed balance vs. every stated closing balance");
{
  let anyPeriods = 0;
  for (const a of cards) {
    const periods = Array.isArray(a.data?.statements?.periods) ? a.data.statements.periods : [];
    if (!periods.length) {
      console.log(`   ·  ${a.id}: no issuer-stated periods yet (#45 — waiting on the user's per-period balances)`);
      continue;
    }
    const mine = transactions.filter((t) => t.account_id === a.id && !t.deleted_at);
    for (const p of periods) {
      anyPeriods++;
      check(`${a.id} · ${p.closing_date} computed balance == stated closing balance`,
        cardDebtAsOf(mine, a, p.closing_date), p.closing_balance);
    }
  }
  if (!anyPeriods) console.log(`   ·  no card has a stated period yet — the assertion exists and will bite the moment one arrives`);
}

// ===========================================================================
head("N · cardCoverage seeded_range semantics (T37 #9)");
{
  // Past a card's seeded_range, with no imported statement for that month:
  // the first mirrored payment T34 wrote still gives that one month a row, so
  // a window scoped to just that month reads "1 of 1 covered" even though no
  // statement backs it. Scoped to the single month of the first such row
  // (not a wider span) because payment cadence does not guarantee every
  // calendar month gets a row — a card with no scheduled payment left (paid
  // off, e.g. woody-chase-card) correctly has nothing to cover at all.
  for (const a of cards) {
    const meta = cardMeta(a);
    if (!meta.seededRange) continue;
    const mine = transactions.filter((t) => t.account_id === a.id && !t.deleted_at && t.txn_date > meta.seededRange.to);
    if (!mine.length) { console.log(`   ·  ${a.id}: no mirrored rows past seeded_range (ends ${meta.seededRange.to}) — nothing scheduled, nothing to cover`); continue; }
    const first = mine.map((t) => t.txn_date).sort()[0];
    const month = monthOf(first);
    const win = { from: monthStart(month), to: monthEnd(month) };
    const cov = cardCoverage({ transactions, accounts: [a], window: win });
    const periods = Array.isArray(a.data?.statements?.periods) ? a.data.statements.periods : [];
    const statementForMonth = periods.some((p) => monthOf(p.closing_date) === month);
    ok(`${a.id}: ${month} (first mirrored row past seeded_range ending ${meta.seededRange.to}) reads ${cov.covered} of ${cov.total} covered with no statement for that month`,
      cov.covered === cov.total && !statementForMonth, `covered ${cov.covered}/${cov.total}, statement exists: ${statementForMonth}`);
  }
  // computeCsp's cardCoverage is this same function, imported — shared/csp.js
  // does `import { cardCoverage as coverageOf } from "./cards.js"`, so there
  // is no second implementation left to drift against check:csp's figures.
  console.log(`   ·  shared/csp.js imports cardCoverage from shared/cards.js directly — no inlined copy to drift`);
}

console.log(`\n${"═".repeat(100)}`);
console.log(`${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`} — ${checks} assertions over ${cards.length} cards`);
process.exit(failures ? 1 : 0);
