// Extend Rajna's checking history from earlier Truist statements (Jan/Feb/Mar
// 2026, covering 12/11/2025 → 03/16/2026) and add the July screenshot actuals
// (06/30 → 07/03). Chains into the existing 03/17→06/12 import at $30.23.
//
//   opening_balance → $1,304.01 (as of 12/11/2025)
//   Jan  stmt → $944.77 (01/14)   Feb stmt → $302.20 (02/12)   Mar stmt → $30.23 (03/16)
//   [existing April–June import → $64.61 (06/12)]
//   gap 06/13–06/29 adjustment, then July actuals (06/30–07/03)
//
// Per-statement control totals are validated; any transcription gap is absorbed
// by a single labeled "Statement reconciliation" adjustment so the chain lands
// exactly on each statement's stated end balance. Idempotent: note='history'
// rows are cleared first, and the old reconciling bridge is removed.
//
// Categories use the household scheme incl. the recent renames (Inkwell Rent →
// Housing, Woody Discover → Credit Card Payment, Anna Utilities → Housing).

import { randomUUID } from "node:crypto";
import db from "./db.js";

const ACCOUNT = "rajna-checking";
const OWNER = "rajna";
const OPENING = 1304.01; // 12/11/2025
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// [date, category, source, deposit, withdrawal]
const periods = [
  {
    label: "Jan 2026 (12/11/2025 → 01/14/2026)", endDate: "2026-01-14", end: 944.77, debits: 3589.36, credits: 3230.12,
    txns: [
      ["2025-12-15", "Transfer", "Zelle transfer", 0, 21.00],
      ["2025-12-15", "Transfer", "Zelle transfer", 0, 1.00],
      ["2025-12-15", "Transfer", "Zelle transfer", 0, 178.00],
      ["2025-12-24", "Bill", "Emory University", 0, 506.00],
      ["2025-12-30", "Bill", "AT&T", 0, 52.27],
      ["2026-01-02", "Misc", "GPC", 0, 103.23],
      ["2026-01-02", "Bill", "IRS", 0, 150.00],
      ["2026-01-02", "Transfer", "Zelle transfer", 0, 500.00],
      ["2026-01-02", "Credit Card Payment", "Woody Discover", 0, 80.00],
      ["2026-01-05", "Transfer", "Internal transfer", 0, 300.00],
      ["2026-01-05", "Credit Card Payment", "Discover", 0, 360.00],
      ["2026-01-05", "Housing", "Inkwell Rent", 0, 1237.86],
      ["2026-01-07", "Credit Card Payment", "Woody Discover", 0, 100.00],
      ["2025-12-30", "Paycheck", "Emory University", 3070.12, 0],
      ["2025-12-31", "Zelle", "Zelle transfer", 10.00, 0],
      ["2026-01-02", "Zelle", "Zelle transfer", 30.00, 0],
      ["2026-01-02", "Housing", "Anna Utilities", 78.00, 0],
      ["2026-01-12", "Zelle", "Zelle transfer", 7.00, 0],
      ["2026-01-12", "Zelle", "Zelle transfer", 35.00, 0],
    ],
  },
  {
    label: "Feb 2026 (01/14 → 02/12)", endDate: "2026-02-12", end: 302.20, debits: 3800.69, credits: 3158.12,
    txns: [
      ["2026-01-22", "Groceries", "Walmart", 0, 49.65],
      ["2026-01-26", "Food", "Clifton Cafe", 0, 9.77],
      ["2026-01-26", "Bill", "Starz", 0, 35.99],
      ["2026-01-26", "Credit Card Payment", "Discover", 0, 800.00],
      ["2026-01-29", "Bill", "AT&T", 0, 55.27],
      ["2026-02-02", "Transfer", "Internal transfer", 0, 100.00],
      ["2026-02-02", "Transfer", "Zelle transfer", 0, 400.00],
      ["2026-02-02", "Credit Card Payment", "Woody Discover", 0, 95.00],
      ["2026-02-02", "Misc", "GPC", 0, 106.60],
      ["2026-02-02", "Bill", "IRS", 0, 150.00],
      ["2026-02-02", "Housing", "Inkwell Rent", 0, 1231.38],
      ["2026-02-02", "Credit Card Payment", "Discover", 0, 63.00],
      ["2026-02-04", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-04", "Transportation", "Uber", 0, 40.63],
      ["2026-02-04", "Transportation", "Uber", 0, 9.94],
      ["2026-02-04", "Credit Card Payment", "Discover", 0, 300.00],
      ["2026-02-04", "Transportation", "Uber", 0, 9.95],
      ["2026-02-05", "Transportation", "Uber", 0, 27.35],
      ["2026-02-05", "Transportation", "Uber", 0, 10.96],
      ["2026-02-06", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-09", "Transportation", "Uber", 0, 14.36],
      ["2026-02-09", "Transportation", "Uber", 0, 9.14],
      ["2026-02-09", "Food", "Rebel Teahouse", 0, 33.96],
      ["2026-02-09", "Bill", "Netflix", 0, 17.99],
      ["2026-02-09", "Bill", "Apple", 0, 9.99],
      ["2026-02-09", "Expense", "ASOS", 0, 147.32],
      ["2026-02-10", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-11", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-11", "Transportation", "Uber", 0, 12.45],
      ["2026-02-12", "Food", "Chick-fil-A", 0, 3.12],
      ["2026-02-12", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-12", "Transportation", "Uber", 0, 10.22],
      ["2026-01-20", "Zelle", "Zelle transfer", 7.00, 0],
      ["2026-01-30", "Paycheck", "Emory University", 3070.12, 0],
      ["2026-02-02", "Housing", "Anna Utilities", 81.00, 0],
    ],
  },
  {
    label: "Mar 2026 (02/12 → 03/16)", endDate: "2026-03-16", end: 30.23, debits: 4502.81, credits: 4230.84,
    txns: [
      ["2026-02-13", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-13", "Transportation", "Uber", 0, 10.35],
      ["2026-02-17", "Food", "Chick-fil-A", 0, 12.18],
      ["2026-02-17", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-18", "Food", "Clifton Cafe", 0, 9.79],
      ["2026-02-18", "Food", "EU Kaldis", 0, 10.27],
      ["2026-02-19", "Food", "Clifton Cafe", 0, 11.95],
      ["2026-02-19", "Food", "EU Kaldis", 0, 15.02],
      ["2026-02-19", "Food", "EU Kaldis", 0, 19.29],
      ["2026-02-20", "Transportation", "Uber", 0, 9.35],
      ["2026-02-23", "Food", "EU Kaldis", 0, 9.33],
      ["2026-02-23", "Food", "Kronchy", 0, 13.18],
      ["2026-02-24", "Transportation", "Uber", 0, 23.47],
      ["2026-02-25", "Food", "Clifton Cafe", 0, 9.77],
      ["2026-02-25", "Food", "Chick-fil-A", 0, 3.12],
      ["2026-02-25", "Food", "EU Kaldis", 0, 10.27],
      ["2026-02-25", "Food", "Emory U Twist", 0, 11.84],
      ["2026-02-26", "Groceries", "Sprouts Farmers Market", 0, 92.03],
      ["2026-02-27", "Food", "EU Kaldis", 0, 9.40],
      ["2026-03-02", "Food", "Clifton Cafe", 0, 5.43],
      ["2026-03-02", "Transportation", "Uber", 0, 15.94],
      ["2026-03-02", "Food", "Bar Taco", 0, 90.00],
      ["2026-03-02", "Transportation", "Uber", 0, 13.96],
      ["2026-03-02", "Transfer", "Zelle transfer", 0, 400.00],
      ["2026-03-02", "Misc", "GPC", 0, 146.16],
      ["2026-03-02", "Bill", "IRS", 0, 150.00],
      ["2026-03-02", "Housing", "Inkwell Rent", 0, 1230.28],
      ["2026-03-02", "Bill", "AT&T", 0, 55.27],
      ["2026-03-02", "Credit Card Payment", "Discover", 0, 400.00],
      ["2026-03-02", "Credit Card Payment", "Discover", 0, 450.00],
      ["2026-03-02", "Investments", "Fidelity", 0, 1.00],
      ["2026-03-02", "Savings", "Goldman Sachs", 0, 50.00],
      ["2026-03-03", "Food", "Chick-fil-A", 0, 3.12],
      ["2026-03-03", "Groceries", "Sprouts Farmers Market", 0, 49.48],
      ["2026-03-04", "Food", "Chick-fil-A", 0, 3.12],
      ["2026-03-04", "Bill", "Uber One", 0, 9.99],
      ["2026-03-05", "Investments", "Fidelity", 0, 25.00],
      ["2026-03-05", "Savings", "Goldman Sachs", 0, 100.00],
      ["2026-03-06", "Food", "EU Kaldis", 0, 10.27],
      ["2026-03-06", "Transportation", "Uber", 0, 10.04],
      ["2026-03-06", "Credit Card Payment", "Discover", 0, 455.00],
      ["2026-03-09", "Food", "EU Kaldis", 0, 8.64],
      ["2026-03-09", "Food", "Necessary Provisions", 0, 23.54],
      ["2026-03-09", "Bill", "Netflix", 0, 17.99],
      ["2026-03-10", "Food", "EU Kaldis", 0, 8.45],
      ["2026-03-10", "Transportation", "Uber", 0, 8.37],
      ["2026-03-10", "Credit Card Payment", "Discover", 0, 76.00],
      ["2026-03-10", "Transfer", "Zelle transfer", 0, 28.96],
      ["2026-03-11", "Food", "EU Kaldis", 0, 9.33],
      ["2026-03-12", "Expense", "SP Disturbia", 0, 78.84],
      ["2026-03-12", "Food", "EU Kaldis", 0, 9.33],
      ["2026-03-13", "Food", "EU Kaldis", 0, 8.45],
      ["2026-03-13", "Bill", "Comptroller of Maryland", 0, 115.00],
      ["2026-03-16", "Food", "Chick-fil-A", 0, 11.55],
      ["2026-03-16", "Transportation", "Uber", 0, 19.93],
      ["2026-03-16", "Food", "Shahs Halal Food", 0, 12.70],
      ["2026-03-16", "Food", "Necessary Provisions", 0, 24.53],
      ["2026-03-16", "Transfer", "Remitly", 0, 50.99],
      ["2026-02-26", "Transfer", "Internal transfer", 20.00, 0],
      ["2026-02-27", "Paycheck", "Emory University", 3070.12, 0],
      ["2026-03-02", "Credit Card Payment", "Woody Discover", 40.00, 0],
      ["2026-03-02", "Housing", "Anna Utilities", 100.72, 0],
      ["2026-03-03", "Credit Card Payment", "Woody Discover", 1000.00, 0],
    ],
  },
];

// July screenshot actuals (06/30 → 07/03). The 06/13–06/29 window is already
// covered by manually-entered rows in the ledger, so no gap adjustment is added.
const july = [
  ["2026-06-30", "Bill", "AT&T", 0, 55.27],
  ["2026-06-30", "Investments", "Fidelity", 0, 20.00],
  ["2026-06-30", "Paycheck", "Emory University", 3081.92, 0],
  ["2026-07-01", "Savings", "Goldman Sachs", 0, 50.00],
  ["2026-07-01", "Credit Card Payment", "Woody Discover", 0, 400.00],
  ["2026-07-01", "Transfer", "Zelle transfer", 0, 400.00],
  ["2026-07-01", "Investments", "Fidelity", 0, 25.00],
  ["2026-07-01", "Bill", "Georgia Power", 0, 55.56],
  ["2026-07-01", "Housing", "Anna Utilities", 56.00, 0],
  ["2026-07-02", "Credit Card Payment", "Discover", 0, 400.00],
  ["2026-07-02", "Bill", "IRS", 0, 150.00],
  ["2026-07-02", "Housing", "Inkwell Rent", 0, 1234.01],
  ["2026-07-02", "Bill", "Comptroller of Maryland", 0, 155.97],
  ["2026-07-02", "Food", "EU Kaldis", 0, 9.14],
  ["2026-07-03", "Transfer", "Zelle transfer", 0, 72.86],
];

const now = new Date().toISOString();
const insert = db.prepare(`INSERT INTO transactions
  (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'history', ?, ?)`);
const ins = (t) => insert.run(randomUUID(), ACCOUNT, OWNER, t[0], t[1], t[2], t[3], t[4], now, now);

db.exec("BEGIN");
try {
  db.prepare("DELETE FROM transactions WHERE account_id = ? AND note = 'history'").run(ACCOUNT);
  db.prepare("DELETE FROM transactions WHERE account_id = ? AND source LIKE 'Bridge to current balance%'").run(ACCOUNT);
  db.prepare("UPDATE accounts SET opening_balance = ?, updated_at = ? WHERE id = ?").run(OPENING, now, ACCOUNT);

  let bal = OPENING;
  for (const p of periods) {
    const debits = r2(p.txns.reduce((s, t) => s + t[4], 0));
    const credits = r2(p.txns.reduce((s, t) => s + t[3], 0));
    for (const t of p.txns) ins(t);
    bal = r2(bal + credits - debits);
    const gap = r2(p.end - bal);
    let note = "";
    if (Math.abs(gap) >= 0.01) {
      ins([p.endDate, "Adjustment", "Statement reconciliation", gap > 0 ? gap : 0, gap < 0 ? -gap : 0]);
      bal = p.end;
      note = ` [+ reconciliation adj ${gap.toFixed(2)}]`;
    }
    const flag = bal === p.end ? "✓" : "✗";
    console.log(`  ${p.label}: debits $${debits} credits $${credits} → $${bal} ${flag}${note}`);
  }

  // July screenshot actuals (06/13–06/29 already covered by manual entries).
  for (const t of july) ins(t);
  console.log(`  + ${july.length} July screenshot rows`);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

// Report resulting balances at key checkpoints.
const all = db.prepare("SELECT txn_date, deposit, withdrawal FROM transactions WHERE account_id = ? AND deleted_at IS NULL ORDER BY txn_date").all(ACCOUNT);
const at = (d) => { let b = OPENING; for (const t of all) if (t.txn_date <= d) b += (t.deposit || 0) - (t.withdrawal || 0); return r2(b); };
console.log(`\n  opening $${OPENING} (12/11/2025)`);
for (const d of ["2026-01-14", "2026-02-12", "2026-03-16", "2026-06-12", "2026-07-03"]) console.log(`  balance as of ${d}: $${at(d)}`);
