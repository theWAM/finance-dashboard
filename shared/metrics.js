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

/**
 * Compute the running balance for a single account: filter the ledger to that
 * account, then run the balance from the account's opening_balance. Returns the
 * account's live transactions (oldest → newest) each with a `running_balance`.
 * @param {Array<object>} transactions  full ledger (any accounts)
 * @param {{id:string, opening_balance?:number}} account
 */
export function accountLedger(transactions = [], account) {
  if (!account) return [];
  const rows = transactions.filter((t) => t.account_id === account.id);
  return withRunningBalance(rows, Number(account.opening_balance) || 0);
}

/** Current (latest) running balance for an account, given the full ledger. */
export function accountBalance(transactions = [], account) {
  const led = accountLedger(transactions, account);
  return led.length ? led[led.length - 1].running_balance : round2(Number(account?.opening_balance) || 0);
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
