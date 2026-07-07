// Drift / sync detection — compares the plan (plan_targets) against reality
// (ledger transactions), producing a status per target. Pure and shared, so the
// local app and the published view show identical results. Browser + Node safe.

import { live } from "./merge.js";

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
export function computeDrift(transactions, planTargets = [], { asOf }) {
  const rows = live(transactions).filter((t) => t.txn_date <= asOf);
  const out = [];
  for (const pt of planTargets) {
    const d = pt.data || {};
    // A plan can name several ledger sources (e.g. both people funding one goal
    // under different names); match a transaction if it hits any of them.
    const planSources = Array.isArray(d.sources) && d.sources.length ? d.sources : (d.source ? [d.source] : []);
    const srcSet = new Set(planSources);
    let matched = rows.filter((t) => srcSet.has(t.source || "") && (Number(t.withdrawal) || 0) > 0);
    // A savings goal only counts contributions made inside its own window. This
    // is what lets several goals share one account/source (e.g. three trips all
    // funded from "Vacation HYSA"): each goal sums the deposits between its own
    // start and deadline instead of the whole running balance.
    if (pt.kind === "savings_goal") {
      matched = matched.filter((t) => (!d.start_date || t.txn_date >= d.start_date) &&
                                      (!d.end_date || t.txn_date <= d.end_date));
    }
    const paid = round2(matched.reduce((s, t) => s + (Number(t.withdrawal) || 0), 0));

    if (pt.kind === "savings_goal") {
      const target = Number(d.target_amount) || 0;
      const totalMonths = Math.max(1, monthsBetween(d.start_date, d.end_date));
      const elapsed = Math.min(totalMonths, Math.max(0, monthsBetween(d.start_date, asOf)));
      const requiredByNow = round2(target * (elapsed / totalMonths));
      const pace = requiredByNow > 0 ? paid / requiredByNow : (paid >= target ? 1 : 0);
      const status = paid >= target ? "good" : pace >= 0.95 ? "good" : pace >= 0.75 ? "warn" : "bad";
      out.push({ id: pt.id, kind: pt.kind, name: pt.name, owner: pt.owner, planValue: target, actualValue: paid,
        detail: `${Math.round((paid / (target || 1)) * 100)}% of goal · on-pace ${Math.round(pace * 100)}% (by ${d.end_date})`,
        progress: target ? Math.min(1, paid / target) : 0, status });
    } else if (pt.kind === "investment_cadence") {
      const months = spanMonths(matched, asOf);
      const actualMonthly = round2(paid / months);
      const targetM = Number(d.monthly_target) || 0;
      const ratio = targetM ? actualMonthly / targetM : 1;
      const status = ratio >= 0.95 ? "good" : ratio >= 0.75 ? "warn" : "bad";
      out.push({ id: pt.id, kind: pt.kind, name: pt.name, owner: pt.owner, planValue: targetM, actualValue: actualMonthly,
        detail: `$${actualMonthly}/mo actual vs $${targetM}/mo target`, status });
    } else if (pt.kind === "debt_payoff") {
      const months = spanMonths(matched, asOf);
      const actualMonthly = round2(paid / months);
      const planM = Number(d.monthly_payment) || 0;
      // Planned one-time payments (bonuses) still ahead of us shrink the balance
      // we have to chip away at monthly, so the payoff projection pulls in.
      const bonuses = Array.isArray(d.one_time_payments) ? d.one_time_payments : [];
      const futureBonus = round2(bonuses.filter((p) => (p.date || "") >= asOf).reduce((s, p) => s + (Number(p.amount) || 0), 0));
      const balance = Math.max(0, (Number(d.balance) || 0) - futureBonus);
      const projMonths = actualMonthly > 0 ? Math.ceil(balance / actualMonthly) : null;
      const projected = projMonths != null ? addMonths(asOf, projMonths) : null;
      const targetMonth = d.target_date ? String(d.target_date).slice(0, 7) : null;
      let status = "bad";
      if (actualMonthly > 0 || balance <= 0) {
        if (balance <= 0 || !targetMonth || (projected && projected <= targetMonth)) status = "good";
        else status = actualMonthly >= planM * 0.75 ? "warn" : "bad";
      }
      const bonusNote = futureBonus > 0 ? ` (incl. $${futureBonus} one-time)` : "";
      out.push({ id: pt.id, kind: pt.kind, name: pt.name, owner: pt.owner, planValue: planM, actualValue: actualMonthly,
        detail: projected ? `$${actualMonthly}/mo → payoff ~${projected}${bonusNote} (target ${targetMonth || "—"})` : "no payments yet",
        status });
    }
  }
  return out;
}

/** Overall health from a set of drift results. */
export function overallStatus(results) {
  if (results.some((r) => r.status === "bad")) return "bad";
  if (results.some((r) => r.status === "warn")) return "warn";
  return results.length ? "good" : "good";
}
