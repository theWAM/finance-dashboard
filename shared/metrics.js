// Metric + sync computations shared by the local app and the published view,
// so both show identical numbers. Phase 0 provides the running-balance
// foundation; later phases add net worth, debt paydown, and the plan-vs-actual
// sync checks on top of these same helpers.

import { live } from "./merge.js";

/**
 * Compute the running balance over a ledger, oldest → newest.
 * Returns live transactions sorted by date, each with a `running_balance`.
 * @param {Array<object>} transactions
 * @param {number} openingBalance
 */
export function withRunningBalance(transactions = [], openingBalance = 0) {
  const sorted = live(transactions)
    .slice()
    .sort((a, b) => cmp(a.txn_date, b.txn_date) || cmp(a.created_at, b.created_at));

  let balance = openingBalance;
  return sorted.map((t) => {
    balance += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
    return { ...t, running_balance: round2(balance) };
  });
}

/** Total in / out / net across the given transactions. */
export function totals(transactions = []) {
  const rows = live(transactions);
  const deposits = sum(rows.map((t) => Number(t.deposit) || 0));
  const withdrawals = sum(rows.map((t) => Number(t.withdrawal) || 0));
  return { deposits: round2(deposits), withdrawals: round2(withdrawals), net: round2(deposits - withdrawals) };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
