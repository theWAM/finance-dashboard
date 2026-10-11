// Drift / sync detection — compares the plan (plan_targets) against reality
// (ledger transactions), producing a status per target. Pure and shared, so the
// local app and the published view show identical results. Browser + Node safe.

import { live } from "./merge.js";
import { cardAccounts, cardMeta, cardDebtAsOf, classifyCardRow } from "./cards.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ym = (iso) => { const [y, m] = String(iso).split("-").map(Number); return y * 12 + (m - 1); };
const monthsBetween = (a, b) => ym(b) - ym(a);
const addMonths = (iso, n) => {
  const [y, m] = String(iso).split("-").map(Number);
  const t = (y * 12 + (m - 1)) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

// Months of activity for a matched set, from its first transaction to `asOf`.
function spanMonths(matched, asOf) {
  if (!matched.length) return 1;
  const first = matched.reduce((mn, t) => (t.txn_date < mn ? t.txn_date : mn), matched[0].txn_date);
  return Math.max(1, monthsBetween(first, asOf) + 1);
}

/**
 * @param {Array} transactions  ledger rows (any accounts)
 * @param {Array} planTargets   plan_targets with parsed `data`
 * @param {{asOf:string}} opts  reference date (YYYY-MM-DD)
 * @returns {Array} one result per target: { kind, name, owner, planLabel, actualLabel, detail, status, progress? }
 */
const planSourcesOf = (d) => (Array.isArray(d.sources) && d.sources.length ? d.sources : (d.source ? [d.source] : []));

export function computeDrift(transactions, planTargets = [], { asOf }) {
  const liveRows = live(transactions);
  const rows = liveRows.filter((t) => t.txn_date <= asOf);
  // Savings goals need a cross-goal pass (rollover between goals sharing a
  // source), so compute them up front and emit from this map in input order.
  const savings = computeSavings(planTargets, liveRows, asOf);
  const out = [];
  for (const pt of planTargets) {
    if (pt.kind === "savings_goal") { if (savings.has(pt.id)) out.push(savings.get(pt.id)); continue; }
    const d = pt.data || {};
    // A plan can name several ledger sources (e.g. both people funding one goal
    // under different names); match a transaction if it hits any of them.
    // Debts/investments measure cadence to date, so they only see rows ≤ today.
    const srcSet = new Set(planSourcesOf(d));
    const matched = rows.filter((t) => srcSet.has(t.source || "") && (Number(t.withdrawal) || 0) > 0);
    const paid = round2(matched.reduce((s, t) => s + (Number(t.withdrawal) || 0), 0));

    if (pt.kind === "investment_cadence") {
      const months = spanMonths(matched, asOf);
      const actualMonthly = round2(paid / months);
      const targetM = Number(d.monthly_target) || 0;
      const ratio = targetM ? actualMonthly / targetM : 1;
      const status = ratio >= 0.95 ? "good" : ratio >= 0.75 ? "warn" : "bad";
      out.push({ id: pt.id, kind: pt.kind, name: pt.name, owner: pt.owner, owners: d.owners, planValue: targetM, actualValue: actualMonthly,
        detail: `$${actualMonthly}/mo actual vs $${targetM}/mo target`, status });
    } else if (pt.kind === "debt_payoff") {
      const months = spanMonths(matched, asOf);
      const actualMonthly = round2(paid / months);
      const planM = Number(d.monthly_payment) || 0;
      const bonuses = Array.isArray(d.one_time_payments) ? d.one_time_payments : [];
      out.push(debtPayoffResult({
        id: pt.id, name: pt.name, owner: pt.owner, owners: d.owners,
        balance: Number(d.balance) || 0, actualMonthly, planMonthly: planM,
        targetDate: d.target_date, bonuses, asOf,
      }));
    }
  }
  return out;
}

/**
 * The debt-payoff math itself, pulled out of `computeDrift`'s loop so T35's
 * per-card rows can run the identical projection against a card's real
 * balance instead of a hand-entered one. Planned one-time payments (bonuses)
 * still ahead of `asOf` shrink the balance there is left to chip away at
 * monthly, exactly as they did inline.
 *
 * @param {{id, kind?, name, owner, owners, balance:number, actualMonthly:number,
 *   planMonthly?:number, targetDate?:string|null, bonuses?:Array, asOf:string}} args
 */
export function debtPayoffResult({ id, kind = "debt_payoff", name, owner, owners, balance, actualMonthly, planMonthly = 0, targetDate = null, bonuses = [], asOf }) {
  const futureBonus = round2(bonuses.filter((p) => (p.date || "") >= asOf).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const bal = Math.max(0, (Number(balance) || 0) - futureBonus);
  const projMonths = actualMonthly > 0 ? Math.ceil(bal / actualMonthly) : null;
  const projected = projMonths != null ? addMonths(asOf, projMonths) : null;
  const targetMonth = targetDate ? String(targetDate).slice(0, 7) : null;
  let status = "bad";
  if (actualMonthly > 0 || bal <= 0) {
    if (bal <= 0 || !targetMonth || (projected && projected <= targetMonth)) status = "good";
    else status = actualMonthly >= planMonthly * 0.75 ? "warn" : "bad";
  }
  const bonusNote = futureBonus > 0 ? ` (incl. $${futureBonus} one-time)` : "";
  return {
    id, kind, name, owner, owners, planValue: planMonthly, actualValue: actualMonthly,
    detail: projected ? `$${actualMonthly}/mo → payoff ~${projected}${bonusNote} (target ${targetMonth || "—"})` : "no payments yet",
    status,
  };
}

/**
 * One payoff-drift row per real card (T35), run through the same
 * `debtPayoffResult` math as a hand-entered debt — but fed by the card's real
 * balance today (`cardDebtAsOf`) and its real average monthly payment, not a
 * number typed in once and left to go stale.
 *
 * A card whose issuer/name/alias overlaps a hand-entered `debt_payoff` plan
 * target's `sources` borrows that target's `monthly_payment` / `target_date`
 * / `one_time_payments` as the plan side of the comparison — the household
 * already committed to those, and this is the same card. `matchedPlanId`
 * rides along so a caller can drop the now-redundant hand-entered row rather
 * than show the same debt twice. A card with no matching target gets no plan
 * (`planValue: 0`), so its status is just "is it moving at all".
 *
 * @param {Array} transactions  full ledger (any accounts), raw or live
 * @param {Array} accounts      accounts, for the card set and its metadata
 * @param {Array} planTargets   plan_targets (any kind; only debt_payoff is used)
 * @param {{owner?:string, asOf:string}} opts
 */
export function cardPayoffDrift(transactions, accounts = [], planTargets = [], { owner = "", asOf }) {
  const cards = cardAccounts(accounts, { owner });
  const debtTargets = planTargets.filter((pt) => pt.kind === "debt_payoff" && !pt.deleted_at);
  const rows = live(transactions);

  return cards.map((a) => {
    const meta = cardMeta(a);
    const aliases = new Set([a.name, meta.issuer, ...meta.sourceAliases].filter(Boolean));
    const plan = debtTargets.find((pt) => planSourcesOf(pt.data || {}).some((s) => aliases.has(s)));
    const d = plan?.data || {};

    const cardRows = rows.filter((t) => t.account_id === a.id);
    const payments = cardRows
      .filter((t) => t.txn_date <= asOf && classifyCardRow(t) === "payment")
      .map((t) => ({ txn_date: t.txn_date, withdrawal: round2((Number(t.deposit) || 0) - (Number(t.withdrawal) || 0)) }))
      .filter((t) => t.withdrawal > 0);
    const months = spanMonths(payments, asOf);
    const paid = round2(payments.reduce((s, t) => s + t.withdrawal, 0));
    const actualMonthly = round2(paid / months);

    return {
      ...debtPayoffResult({
        id: `card:${a.id}`, name: a.name, owner: a.owner, owners: d.owners,
        balance: cardDebtAsOf(cardRows, a, asOf), actualMonthly,
        planMonthly: Number(d.monthly_payment) || 0, targetDate: d.target_date,
        bonuses: Array.isArray(d.one_time_payments) ? d.one_time_payments : [],
        asOf,
      }),
      matchedPlanId: plan?.id || null,
    };
  });
}

// Savings goals, with rollover. A goal sums the contributions inside its own
// [start, deadline] window (incl. future/projected ones — the ledger is a
// forward projection, so this answers "will the plan fund it by the deadline").
// Goals that draw from the SAME source pool (e.g. three trips funded from
// "Vacation HYSA") form a chain ordered by deadline: whatever overfunds an
// earlier goal rolls forward to the next. Returns Map<planTargetId, result>.
function computeSavings(planTargets, liveRows, asOf) {
  const goals = planTargets.filter((p) => p.kind === "savings_goal").map((pt) => {
    const d = pt.data || {};
    const srcSet = new Set(planSourcesOf(d));
    const inWin = liveRows.filter((t) => srcSet.has(t.source || "") && (Number(t.withdrawal) || 0) > 0 &&
      (!d.start_date || t.txn_date >= d.start_date) && (!d.end_date || t.txn_date <= d.end_date));
    return {
      pt, d, target: Number(d.target_amount) || 0,
      sig: [...srcSet].sort().join("|"),               // goals with the same source set share a pool
      windowPaid: round2(inWin.reduce((s, t) => s + (Number(t.withdrawal) || 0), 0)),
      toDate: round2(inWin.filter((t) => t.txn_date <= asOf).reduce((s, t) => s + (Number(t.withdrawal) || 0), 0)),
    };
  });

  const groups = new Map();
  for (const g of goals) { if (!groups.has(g.sig)) groups.set(g.sig, []); groups.get(g.sig).push(g); }

  const result = new Map();
  for (const [, group] of groups) {
    group.sort((a, b) => String(a.d.end_date || "").localeCompare(String(b.d.end_date || "")) ||
                         String(a.d.start_date || "").localeCompare(String(b.d.start_date || "")));
    const rolls = group.length > 1; // rollover only matters when goals share the pool
    let carry = 0;
    for (const g of group) {
      const carryIn = rolls ? round2(carry) : 0;
      const funded = round2(g.windowPaid + carryIn);
      carry = rolls && g.target > 0 && funded > g.target ? round2(funded - g.target) : 0;
      const pct = g.target ? funded / g.target : (funded > 0 ? 1 : 0);
      const status = pct >= 0.95 ? "good" : pct >= 0.75 ? "warn" : "bad";
      const rollNote = carryIn > 0 ? ` (incl. $${carryIn} rolled over)` : "";
      result.set(g.pt.id, {
        id: g.pt.id, kind: "savings_goal", name: g.pt.name, owner: g.pt.owner, owners: g.d.owners,
        sortOrder: g.d.sort_order, planValue: g.target, actualValue: funded,
        detail: `${Math.round(pct * 100)}% funded by plan${rollNote} · $${g.toDate} saved so far (by ${g.d.end_date})`,
        progress: g.target ? Math.min(1, funded / g.target) : 0, status,
      });
    }
  }
  return result;
}

/** Overall health from a set of drift results. */
export function overallStatus(results) {
  if (results.some((r) => r.status === "bad")) return "bad";
  if (results.some((r) => r.status === "warn")) return "warn";
  return results.length ? "good" : "good";
}
