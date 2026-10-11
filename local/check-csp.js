// Acceptance harness for shared/csp.js (Phase 10 / T2): run the Spending-Plan
// engine over the real local/dashboard.db and hand-reconcile every figure
// against independent SQL sums — one item per bucket, both people, four window
// shapes: two all-past (one day-precision, one snapped to whole months like the
// page's own presets), one crossing today, one fully open.
//
//   npm run check:csp
//
// Kept in the repo, not thrown away, because it is the reference the Spending
// Plan page's on-screen numbers are checked against: if the page and this
// disagree, the page is wrong. Read-only — it never writes to the database.
//
// It reads the CSP from local/csp-seed.json rather than the DB, so it works
// before `npm run seed:csp` has ever been run. Pass --db to read the seeded
// plan_targets rows instead and confirm the two agree.
//
// T28 widened what it polices. Since card accounts exist, the identity is
// decision #21's
//
//     bucketTotal + excluded === cashOutflow + cardPurchases
//
// and the SQL oracle had to learn the same three rules the engine follows: card
// charges count at their own category, card refunds count negatively, and card
// PAYMENT inflows count nowhere (the checking side already counted them in
// full). Every window is additionally re-run with the card accounts removed
// from scope, which is the only way to prove the T28 refactor is a no-op on the
// cash figures T0 verified to the cent.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  computeCsp, statusFor, thresholdsFor, worstStatus,
  CSP_EXCLUDE, CARD_PAYMENT_CATEGORIES, isCardAccount,
  FUND_GOOD, FUND_WARN,
} from "../shared/csp.js";
import { monthPresetWindow, DEFAULT_MONTH_PRESET } from "../shared/timeframe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(join(ROOT, "local", "dashboard.db"));
const all = (sql, ...a) => db.prepare(sql).all(...a);

const transactions = all("SELECT * FROM transactions");
const accounts = all("SELECT * FROM accounts");
const people = all("SELECT * FROM people");
const fromDb = process.argv.includes("--db");
let cspPlans, cspItems;
if (fromDb) {
  const pts = all("SELECT * FROM plan_targets WHERE deleted_at IS NULL")
    .map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
  cspPlans = pts.filter((r) => r.kind === "csp_plan");
  cspItems = pts.filter((r) => r.kind === "csp_item");
  if (!cspPlans.length) { console.error("No csp_plan rows in the DB — run `npm run seed:csp` first (or drop --db)."); process.exit(2); }
} else {
  const seed = JSON.parse(readFileSync(join(ROOT, "local", "csp-seed.json"), "utf8"));
  cspPlans = seed.plans; cspItems = seed.items;
}
console.log(`CSP source: ${fromDb ? "plan_targets (database)" : "local/csp-seed.json"} — ${cspPlans.length} plans, ${cspItems.length} items`);

const TODAY = "2026-10-06";
const fmt = (n) => (n == null ? "    —   " : (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(8));
const pct = (n) => (n == null ? "—" : n.toFixed(1) + "%");

// --- independent SQL oracle -------------------------------------------------
const EXCL = [...CSP_EXCLUDE];
const PAY_CATS = [...CARD_PAYMENT_CATEGORIES];
const marks = (xs) => xs.map(() => "?").join(",");

const CARD_IDS = accounts.filter((a) => !a.deleted_at && isCardAccount(a)).map((a) => a.id);
// Which `transfer_id`s are a real cash→card payment, as opposed to a card→card
// balance transfer? The ones with a leg on a non-card account. Resolved here in
// one query so the amount SQL below stays a flat predicate.
const PAY_XFERS = CARD_IDS.length
  ? all(`SELECT DISTINCT transfer_id FROM transactions
         WHERE deleted_at IS NULL AND transfer_id IS NOT NULL
           AND account_id NOT IN (${marks(CARD_IDS)})`, ...CARD_IDS).map((r) => r.transfer_id)
  : [];

/**
 * The oracle, restated for T28. A row counts, and with which sign:
 *   · any withdrawal, cash or card            → +withdrawal
 *   · a card deposit that is NOT a payment    → −deposit   (a refund, netting)
 *   · a card deposit that IS a payment        → not at all (counted on the
 *     checking side, in full, as `Debt Payments` — decision #21)
 *   · a cash deposit                          → not at all (income / transfer in)
 *
 * `scope` narrows to one half of the identity: "cash", "card", or both.
 */
function sqlOutflow({ owner, from, to, sources = [], categories = [], excludeArtifacts = true, scope = "all" }) {
  let acct = accounts.filter((a) => !a.deleted_at && a.owner === owner);
  if (scope === "cash") acct = acct.filter((a) => !isCardAccount(a));
  if (scope === "card") acct = acct.filter((a) => isCardAccount(a));
  const ids = acct.map((a) => a.id);
  if (!ids.length) return { total: 0, count: 0 };

  const cardIn = CARD_IDS.length ? `account_id IN (${marks(CARD_IDS)})` : "0";
  const notPaid =
    `description NOT IN (${marks(PAY_CATS)})` +
    (PAY_XFERS.length ? ` AND (transfer_id IS NULL OR transfer_id NOT IN (${marks(PAY_XFERS)}))` : "");
  const counts = `(withdrawal > 0 OR (${cardIn} AND deposit > 0 AND ${notPaid}))`;

  let sql = `SELECT ROUND(SUM(withdrawal - deposit),2) AS s, COUNT(*) AS n FROM transactions
             WHERE deleted_at IS NULL
               AND account_id IN (${marks(ids)})
               AND ${counts}`;
  const p = [...ids, ...(CARD_IDS.length ? CARD_IDS : []), ...PAY_CATS, ...PAY_XFERS];
  if (from) { sql += " AND txn_date >= ?"; p.push(from); }
  if (to) { sql += " AND txn_date <= ?"; p.push(to); }
  if (excludeArtifacts) { sql += ` AND description NOT IN (${marks(EXCL)})`; p.push(...EXCL); }
  if (sources.length || categories.length) {
    const parts = [];
    if (sources.length) { parts.push(`source IN (${marks(sources)})`); p.push(...sources); }
    if (categories.length) { parts.push(`description IN (${marks(categories)})`); p.push(...categories); }
    sql += ` AND (${parts.join(" OR ")})`;
  }
  const r = db.prepare(sql).get(...p);
  return { total: r.s || 0, count: r.n || 0 };
}

/** Card payment inflows: the figure the CSP deliberately does NOT count. */
function sqlCardPayments({ owner, from, to }) {
  const ids = accounts.filter((a) => !a.deleted_at && a.owner === owner && isCardAccount(a)).map((a) => a.id);
  if (!ids.length) return 0;
  const paid =
    `(description IN (${marks(PAY_CATS)})` +
    (PAY_XFERS.length ? ` OR transfer_id IN (${marks(PAY_XFERS)}))` : ")");
  let sql = `SELECT ROUND(SUM(deposit),2) AS s FROM transactions
             WHERE deleted_at IS NULL AND deposit > 0
               AND account_id IN (${marks(ids)}) AND ${paid}`;
  const p = [...ids, ...PAY_CATS, ...PAY_XFERS];
  if (from) { sql += " AND txn_date >= ?"; p.push(from); }
  if (to) { sql += " AND txn_date <= ?"; p.push(to); }
  return db.prepare(sql).get(...p).s || 0;
}

let failures = 0;
const check = (label, got, want, tol = 0.011) => {
  const ok = Math.abs((got ?? 0) - (want ?? 0)) <= tol;
  if (!ok) failures++;
  console.log(`   ${ok ? "✅" : "❌"} ${label}: got ${fmt(got)} want ${fmt(want)}`);
};

// --- window shapes ----------------------------------------------------------
const WINDOWS = [
  { name: "trailing 12 months (all past)", win: { from: "2025-10-07", to: TODAY } },
  { name: "Sep–Dec 2026 (crosses today)", win: { from: "2026-09-01", to: "2026-12-31" } },
  // The page's default. A month preset is person-independent (no pay-cycle
  // anchor), so unlike the `3paychecks` window this replaced it's one window
  // for both people — and a whole number of months, which is the point.
  { name: "Last 3 months (default preset)", win: monthPresetWindow(DEFAULT_MONTH_PRESET, { today: TODAY }) },
  { name: "All time (open window)", win: { from: "", to: "" } },
];

for (const shape of WINDOWS) {
  for (const owner of ["woody", "rajna"]) {
    const win = shape.win;
    const res = computeCsp({ transactions, accounts, people, cspPlans, cspItems, window: win, asOf: TODAY });
    const plan = res.plans.find((p) => p.owner === owner);

    console.log(`\n${"═".repeat(96)}\n${owner.toUpperCase()} · ${shape.name} · ${win.from || "(open)"} → ${win.to || "(open)"} · ${plan.months.toFixed(2)} months${plan.windowProjected ? ` · ${Math.round(plan.projectedShare * 100)}% projected` : ""}`);
    console.log(`take-home ${fmt(plan.takeHome)}/mo · cadence ${plan.cadence} · status ${plan.status} · net worth ${fmt(plan.netWorth.total)}`);
    console.log(`cash out ${fmt(plan.cashOutflow)} · card purchases ${fmt(plan.cardPurchases)} (${fmt(plan.cardCharges)} charged − ${fmt(plan.cardRefunds)} refunded) · card payments ${fmt(plan.cardPayments)} counted on the checking side only`);
    console.log(`${"─".repeat(96)}`);
    console.log("bucket / item".padEnd(42), "target/mo".padStart(10), "actual/mo".padStart(10), "Δ".padStart(10), " status");
    for (const b of plan.buckets) {
      console.log(`${("▸ " + b.label).padEnd(42)}${fmt(b.targetMonthly)}${fmt(b.actualMonthly)}${fmt(b.delta)}  ${b.status.padEnd(9)} ${pct(b.targetPct)} → ${pct(b.actualPct)}${b.recPct ? ` (rec ${b.recPct[0]}–${b.recPct[1]}%, ${b.recStatus})` : ""}`);
      for (const i of b.items) {
        const flag = !i.tracked ? "  ← target only, not tracked" : i.proposed ? "  (proposed)" : i.conflicts ? `  ⚠ ${i.conflicts} overlapping` : "";
        console.log(`${("    " + i.name).padEnd(42)}${fmt(i.targetMonthly)}${fmt(i.actualMonthly)}${fmt(i.delta)}  ${i.status.padEnd(9)}${flag}`);
      }
      if (b.unassigned) console.log(`${"    Unassigned".padEnd(42)}${"      —   "}${fmt(b.unassigned.actualMonthly)}${"      —   "}  (${b.unassigned.count} rows, ${b.unassigned.groups.length} groups)`);
    }
    console.log(`${"excluded (Adjustment / Negative Balance)".padEnd(42)}${"      —   "}${fmt(plan.excluded.actualMonthly)}   (${plan.excluded.count} rows)`);

    // ---- reconciliation: decision #21's identity, both halves --------------
    //   bucketTotal + excluded === cashOutflow + cardPurchases
    console.log("\n  reconciliation \u00b7 bucketTotal + excluded === cashOutflow + cardPurchases");
    const oracleAll = sqlOutflow({ owner, from: win.from, to: win.to, excludeArtifacts: false });
    const oracleCash = sqlOutflow({ owner, from: win.from, to: win.to, excludeArtifacts: false, scope: "cash" });
    const oracleCard = sqlOutflow({ owner, from: win.from, to: win.to, excludeArtifacts: false, scope: "card" });
    check("cash outflow (engine vs SQL)", plan.cashOutflow, oracleCash.total);
    check("card purchases, net of refunds (engine vs SQL)", plan.cardPurchases, oracleCard.total);
    check("cash + card == windowOutflow", plan.cashOutflow + plan.cardPurchases, plan.windowOutflow);
    check("windowed outflow (engine vs SQL)", plan.windowOutflow, oracleAll.total);
    check("Σ buckets + excluded == cash + card", plan.total + plan.excluded.total, oracleAll.total);
    console.log(`   ${plan.reconciles ? "✅" : "❌"} engine's own reconciles flag: ${plan.reconciles}`);
    if (!plan.reconciles) failures++;
    // Charges less refunds is the same number by a different route, and the
    // payments figure is the one the CSP must NOT have counted: if it ever
    // leaks into a bucket, `cashOutflow + cardPurchases` stops matching.
    check("card charges \u2212 refunds == card purchases", plan.cardCharges - plan.cardRefunds, plan.cardPurchases);
    check("card payment inflows (engine vs SQL, counted nowhere here)", plan.cardPayments, sqlCardPayments({ owner, from: win.from, to: win.to }));

    // ---- card coverage: does this window actually have card data? ----------
    const cov = plan.cardCoverage;
    if (!cov.anyCards) {
      console.log(`   \u00b7  no card accounts in this plan's scope \u2014 nothing to cover`);
    } else {
      console.log(
        `   ${cov.complete ? "\u2705" : "\u26a0 "} card data covers ${cov.covered} of ${cov.total} month(s)` +
        (cov.complete ? "" : ` \u2014 figures UNDER-report for ${cov.total - cov.covered} month(s)`),
      );
      for (const c of cov.cards) {
        console.log(`      ${c.name}: ${c.months.length}/${cov.total}${c.missing.length ? ` \u00b7 missing ${c.missing.join(", ")}` : ""}`);
      }
    }

    // ---- the T28 no-op proof ----------------------------------------------
    // Same engine, same window, with the card accounts taken out of scope: the
    // cash figures must be bit-for-bit what they were before cards existed. If
    // this ever drifts, T28 broke a number T0 verified to the cent.
    const cashOnly = computeCsp({
      transactions, accounts: accounts.filter((a) => !isCardAccount(a)),
      people, cspPlans, cspItems, window: win, asOf: TODAY,
    }).plans.find((p) => p.owner === owner);
    console.log("\n  cards out of scope \u2014 the pre-card figures, unchanged");
    check("cardPurchases == 0", cashOnly.cardPurchases, 0);
    check("windowOutflow == cash-only SQL", cashOnly.windowOutflow, oracleCash.total);
    check("\u03a3 buckets + excluded == cash-only SQL", cashOnly.total + cashOnly.excluded.total, oracleCash.total);
    console.log(`   ${cashOnly.reconciles ? "✅" : "❌"} reconciles with no cards in scope`);
    if (!cashOnly.reconciles) failures++;
    // Every tracked item, not a sample: this is the clause that would catch a
    // card dollar leaking into a cash-only figure. An item whose rows a more
    // specific item won legitimately undershoots its own naive SQL sum, so the
    // comparison is against the engine's full-scope figure minus its card rows,
    // which is a subtraction the engine never performs.
    let noopDrift = 0;
    for (const b of cashOnly.buckets) for (const i of b.items) {
      if (!i.tracked) continue;
      const full = plan.buckets.flatMap((x) => x.items).find((x) => x.itemId === i.itemId);
      const cardPart = full ? full.matched.filter((r) => CARD_IDS.includes(r.account_id)).reduce((t, r) => t + (r.withdrawal - r.deposit), 0) : 0;
      if (Math.abs(i.total - (full.total - cardPart)) > 0.011) {
        noopDrift++;
        console.log(`   ❌ ${b.label} / ${i.name}: cash-only ${fmt(i.total)} \u2260 full ${fmt(full.total)} \u2212 card ${fmt(cardPart)}`);
      }
    }
    failures += noopDrift;
    console.log(`   ${noopDrift === 0 ? "✅" : "❌"} every tracked item: cash-only total == full total \u2212 its card rows (${noopDrift} drifted)`);

    // ---- net worth: computed from the plan's own balance sheet -------------
    // Window-independent (it's a snapshot, not an average), so this re-checks
    // the same identity in every window shape — cheap, and it catches a sign
    // flip on `debt` immediately.
    const nwSrc = cspPlans.find((p) => p.owner === owner).data;
    const bs = (typeof nwSrc === "string" ? JSON.parse(nwSrc) : nwSrc).net_worth || {};
    check(
      "net worth == assets + investments + savings − debt",
      plan.netWorth.total,
      (bs.assets || 0) + (bs.investments || 0) + (bs.savings || 0) - (bs.debt || 0),
    );

    // ---- one item per bucket, checked against SQL --------------------------
    console.log("\n  per-item SQL cross-checks (one tracked item per bucket)");
    for (const b of plan.buckets) {
      const it = b.items.find((i) => i.tracked && i.total > 0) || b.items.find((i) => i.tracked);
      if (!it) { console.log(`   ·  ${b.label}: no tracked item to check`); continue; }
      const o = sqlOutflow({ owner, from: win.from, to: win.to, sources: it.sources, categories: it.categories });
      // An item whose rows another item won on precedence can legitimately come
      // in under its own naive SQL sum; flag that rather than calling it a fail.
      const exact = Math.abs(it.total - o.total) <= 0.011;
      console.log(`   ${exact ? "✅" : it.total < o.total && it.conflicts ? "⚠ " : "❌"} ${b.label} / ${it.name}: engine ${fmt(it.total)} vs SQL ${fmt(o.total)} (${it.matched.length} vs ${o.count} rows)${exact ? "" : it.conflicts ? ` — ${it.conflicts} rows lost to a more specific item` : ""}`);
      if (!exact && !(it.total < o.total && it.conflicts)) failures++;
      check(`   ${it.name} monthly == total / months`, it.actualMonthly, it.total / plan.months);
      check(`   ${it.name} toDate + projected == total`, it.toDate + it.projected, it.total);
      check(`   ${it.name} Σ groups == total`, it.groups.reduce((s, g) => s + g.amount, 0), it.total);
    }

    // ---- no double counting ------------------------------------------------
    const seen = new Map();
    for (const b of plan.buckets) for (const i of b.items) for (const r of i.matched) {
      seen.set(r.id, (seen.get(r.id) || 0) + 1);
    }
    const dupes = [...seen.values()].filter((n) => n > 1).length;
    console.log(`  ${dupes === 0 ? "✅" : "❌"} every matched row counted exactly once (${seen.size} rows, ${dupes} duplicated)`);
    if (dupes) failures++;
    const unassignedOverlap = plan.buckets.flatMap((b) => (b.unassigned ? b.unassigned.groups : [])).length;
    const catchAlls = plan.buckets.filter((b) => b.catchAll).length;
    console.log(`  ${catchAlls === 1 ? "✅" : "❌"} exactly one catch-all bucket (${catchAlls}), ${unassignedOverlap} unassigned groups`);
    if (catchAlls !== 1) failures++;
    if (plan.conflicts.length) {
      console.log(`  ⚠  ${plan.conflicts.length} rows matched by more than one item; sample:`);
      for (const c of plan.conflicts.slice(0, 3)) console.log(`      ${c.date} ${c.category}/${c.source} ${fmt(c.amount)} → "${c.wonBy}" (also: ${c.alsoMatched.join(", ")})`);
    }
  }
}

// --- direction-aware status spot checks ------------------------------------
// The shared bands, then decision #38's override: `Debt Payments` is `fund` at
// 1.0 / 0.8, stricter than the shared `fund` band at BOTH ends, which is the
// whole reason an item needs a threshold pair and not just a direction flip.
console.log(`\n${"═".repeat(96)}\ndirection-aware status`);
const DEBT = thresholdsFor("fund", { good_at: 1.0, warn_at: 0.8 });
const SHARED_FUND = thresholdsFor("fund", {});
const cases = [
  ["fixed  overspend 130%", statusFor(130, 100, "spend"), "bad"],
  ["fixed  overspend 110%", statusFor(110, 100, "spend"), "warn"],
  // Exactly on target is decision #38's fourth status, and it is not specific
  // to the overriding item: a Fixed Cost that lands on the cent is gray too.
  ["fixed  on target 100%", statusFor(100, 100, "spend"), "even"],
  ["fixed  underspend 60%", statusFor(60, 100, "spend"), "good"],
  ["saving underfund  60%", statusFor(60, 100, "fund"), "bad"],
  ["saving underfund  80%", statusFor(80, 100, "fund"), "warn"],
  ["saving on target 100%", statusFor(100, 100, "fund"), "even"],
  ["saving overfund  130%", statusFor(130, 100, "fund"), "good"],
  ["no target, nothing spent", statusFor(0, 0, "spend"), "good"],
  ["no target, money spent", statusFor(50, 0, "spend"), "warn"],

  // --- #38: the two bands disagree exactly where the decision says they do ---
  ["debt   96% \u00b7 shared fund says", statusFor(96, 100, "fund", SHARED_FUND), "good"],
  ["debt   96% \u00b7 1.0/0.8 says", statusFor(96, 100, "fund", DEBT), "warn"],
  ["debt   89.7% (the $1,793.33 case)", statusFor(1793.33, 2000, "fund", DEBT), "warn"],
  ["debt   80.0% \u00b7 boundary is still yellow", statusFor(1600, 2000, "fund", DEBT), "warn"],
  ["debt   79.9% \u00b7 just under is red", statusFor(1598, 2000, "fund", DEBT), "bad"],
  ["debt   79.9% \u00b7 shared fund says", statusFor(1598, 2000, "fund", SHARED_FUND), "warn"],
  ["debt  100.1% \u00b7 over target is green", statusFor(2002, 2000, "fund", DEBT), "good"],
  ["debt  100.0% \u00b7 on the nose is gray", statusFor(2000, 2000, "fund", DEBT), "even"],

  // --- the knock-on: a bucket reports the worst of its items ---------------
  ["bucket good+warn \u2192", worstStatus(["good", "warn"]), "warn"],
  ["bucket good+even \u2192", worstStatus(["good", "even"]), "good"],
  ["bucket all even \u2192", worstStatus(["even", "even"]), "even"],
  ["bucket warn+bad \u2192", worstStatus(["warn", "bad"]), "bad"],
  ["bucket ignores untracked", worstStatus(["untracked", "good"]), "good"],
];
for (const [label, got, want] of cases) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`   ${ok ? "✅" : "❌"} ${label.padEnd(38)} \u2192 ${String(got).padEnd(9)} (want ${want})`);
}
console.log(`   \u00b7  shared fund band ${FUND_GOOD} / ${FUND_WARN} \u00b7 Debt Payments band ${DEBT.good} / ${DEBT.warn}`);

// --- the per-item override, end to end -------------------------------------
// The engine has to actually read `data.direction` / `good_at` / `warn_at` off
// the item and hand them to statusFor — asserting statusFor alone would pass
// even if nothing wired it up.
console.log(`\n${"═".repeat(96)}\nper-item direction override, through the engine`);
{
  const win = { from: "2026-07-01", to: "2026-09-30" };
  for (const owner of ["woody", "rajna"]) {
    const plan = computeCsp({ transactions, accounts, people, cspPlans, cspItems, window: win, asOf: TODAY })
      .plans.find((p) => p.owner === owner);
    const fixed = plan.buckets.find((b) => b.bucket === "fixed");
    const debt = fixed?.items.find((i) => /debt payments/i.test(i.name));
    if (!debt) { console.log(`   \u00b7  ${owner}: no Debt Payments item`); continue; }
    const ratio = debt.targetMonthly ? debt.actualMonthly / debt.targetMonthly : 0;
    const want = statusFor(debt.actualMonthly, debt.targetMonthly, debt.direction, debt.thresholds);
    const ok = debt.direction === "fund" && debt.overridesDirection && debt.status === want;
    if (!ok) failures++;
    console.log(
      `   ${ok ? "✅" : "❌"} ${owner} Debt Payments: ${fmt(debt.actualMonthly)} / ${fmt(debt.targetMonthly)} = ${pct(ratio * 100)} ` +
      `\u2192 ${debt.status} (direction ${debt.direction}${debt.overridesDirection ? ", overrides bucket" : ", NOT overriding"}, band ${debt.thresholds.good}/${debt.thresholds.warn})`,
    );
    const bOk = fixed.statusFromItems && fixed.status === worstStatus(fixed.items.filter((i) => i.tracked).map((i) => i.status));
    if (!bOk) failures++;
    console.log(`   ${bOk ? "✅" : "❌"} ${owner} Fixed Costs header follows worstStatus of its items \u2192 ${fixed.status}${fixed.statusFromItems ? "" : " (still its own ratio \u2014 no item overrides)"}`);
  }
}

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
