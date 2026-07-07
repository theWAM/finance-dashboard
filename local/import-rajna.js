// One-time importer for Rajna's checking ledger, transcribed from her Truist
// statements (Apr/May/Jun 2026). Unlike Woody's Google-Sheet import, this data
// is ACTUALS (bank history), not a forward projection, and the source is PDF
// statements rather than a CSV — so the transactions are inlined here.
//
// Design choices (per the user's decisions):
//   - Categories are mapped to Woody's scheme (Paycheck/Bill/Savings/Investments/
//     Credit Card Payment/Loan Payment/Tax Refund/Zelle/Transfer/Misc/Fun/Expense)
//     so the two accounts are comparable AND merchant/person detail is sanitized
//     before it can ever reach the PUBLIC snapshot.
//   - Individual people are anonymized in `source` ("Zelle transfer"); household
//     member Woody and institutions (Emory, Discover, Bilt, IRS, Netflix, …) are
//     kept, as they aren't sensitive.
//   - Each statement period is validated against the statement's own start/end
//     balance and total debits/credits, so any transcription error is caught.
//   - History runs 03/16→06/12/2026 (the statement window). The 06/13→today gap
//     isn't in the statements, so a single dated "Adjustment" bridges the known
//     06/12 balance ($64.61) to today's actual balance ($54.42).
//
// Usage: node local/import-rajna.js [--account rajna-checking] [--replace]

import { randomUUID } from "node:crypto";
import db from "./db.js";
import { accountBalance } from "../shared/metrics.js";

const OPENING = 30.23;            // Truist checking balance as of 03/16/2026
const CURRENT_BALANCE = 54.42;    // actual balance today (2026-07-06)
const TODAY = "2026-07-06";
const OWNER = "rajna";

// Each period: transactions + the statement's own control totals for validation.
const periods = [
  {
    label: "Apr 2026 statement (03/16 → 04/15)",
    endBalance: 58.15, totalDebits: 3518.29, totalCredits: 3546.21,
    txns: [
      // withdrawals
      ["2026-03-17", "Fun", "EU Kaldis", 0, 12.52],
      ["2026-03-18", "Fun", "Emory U Twist", 0, 16.31],
      ["2026-03-19", "Bill", "Apple", 0, 9.99],
      ["2026-03-26", "Transfer", "Remitly", 0, 25.99],
      ["2026-03-30", "Fun", "Clifton Cafe", 0, 9.79],
      ["2026-03-30", "Fun", "Clifton Cafe", 0, 1.51],
      ["2026-03-30", "Bill", "AT&T", 0, 55.27],
      ["2026-03-31", "Transfer", "Zelle transfer", 0, 400.00],
      ["2026-04-01", "Fun", "EU Kaldis", 0, 10.65],
      ["2026-04-01", "Fun", "EU Kaldis", 0, 8.07],
      ["2026-04-01", "Misc", "GPC", 0, 109.88],
      ["2026-04-01", "Investments", "Fidelity", 0, 25.00],
      ["2026-04-01", "Credit Card Payment", "Discover", 0, 97.00],
      ["2026-04-01", "Bill", "Bilt Rent", 0, 1238.10],
      ["2026-04-01", "Savings", "Goldman Sachs", 0, 50.00],
      ["2026-04-02", "Fun", "Tropical Smoothie", 0, 13.03],
      ["2026-04-02", "Bill", "Comptroller of Maryland", 0, 155.97],
      ["2026-04-02", "Bill", "IRS", 0, 150.00],
      ["2026-04-02", "Credit Card Payment", "Discover", 0, 500.00],
      ["2026-04-03", "Bill", "OpenAI", 0, 20.00],
      ["2026-04-03", "Expense", "Gemini Jewels", 0, 96.22],
      ["2026-04-03", "Credit Card Payment", "Discover", 0, 100.00],
      ["2026-04-06", "Credit Card Payment", "Discover", 0, 63.00],
      ["2026-04-07", "Expense", "Emory SGS Office", 0, 25.00],
      ["2026-04-07", "Expense", "Dernholt", 0, 51.80],
      ["2026-04-07", "Expense", "Intl service fee", 0, 1.55],
      ["2026-04-08", "Expense", "Amazon", 0, 105.65],
      ["2026-04-08", "Credit Card Payment", "Discover", 0, 133.00],
      ["2026-04-09", "Bill", "Netflix", 0, 17.99],
      ["2026-04-09", "Transfer", "Zelle transfer", 0, 15.00],
      // deposits
      ["2026-03-25", "Zelle", "Zelle transfer", 25.00, 0],
      ["2026-03-25", "Zelle", "Zelle — Woody", 60.00, 0],
      ["2026-03-31", "Zelle", "Zelle transfer", 82.54, 0],
      ["2026-03-31", "Paycheck", "Emory University", 3070.12, 0],
      ["2026-04-02", "Zelle", "Zelle — Woody", 100.00, 0],
      ["2026-04-07", "Zelle", "Zelle — Woody", 12.00, 0],
      ["2026-04-07", "Transfer", "Venmo", 30.42, 0],
      ["2026-04-07", "Zelle", "Zelle transfer", 35.00, 0],
      ["2026-04-07", "Zelle", "Zelle transfer", 40.13, 0],
      ["2026-04-08", "Transfer", "Venmo", 30.00, 0],
      ["2026-04-09", "Zelle", "Zelle — Woody", 11.00, 0],
      ["2026-04-13", "Zelle", "Zelle transfer", 50.00, 0],
    ],
  },
  {
    label: "May 2026 statement (04/15 → 05/14)",
    endBalance: 19.85, totalDebits: 3684.98, totalCredits: 3646.68,
    txns: [
      // withdrawals
      ["2026-04-17", "Zelle", "Zelle — Woody", 0, 25.00],
      ["2026-04-29", "Fun", "Tropical Smoothie", 0, 13.87],
      ["2026-04-29", "Bill", "AT&T", 0, 55.27],
      ["2026-04-29", "Transfer", "Zelle transfer", 0, 11.00],
      ["2026-04-30", "Fun", "Clifton Cafe", 0, 11.95],
      ["2026-04-30", "Fun", "EU Kaldis", 0, 11.02],
      ["2026-04-30", "Misc", "GPC", 0, 88.19],
      ["2026-04-30", "Transfer", "Zelle transfer", 0, 20.00],
      ["2026-04-30", "Transfer", "Zelle transfer", 0, 400.00],
      ["2026-05-01", "Fun", "EU Kaldis", 0, 23.84],
      ["2026-05-01", "Bill", "Bilt Rent", 0, 1240.00],
      ["2026-05-01", "Investments", "Fidelity", 0, 25.00],
      ["2026-05-01", "Savings", "Goldman Sachs", 0, 50.00],
      ["2026-05-04", "Fun", "Emory U Twist", 0, 16.31],
      ["2026-05-04", "Fun", "Emory Kaldis", 0, 7.95],
      ["2026-05-04", "Misc", "GoFundMe", 0, 26.25],
      ["2026-05-04", "Bill", "OpenAI", 0, 20.00],
      ["2026-05-04", "Expense", "Scissor Hands", 0, 67.93],
      ["2026-05-04", "Fun", "FifthGroup", 0, 128.60],
      ["2026-05-04", "Credit Card Payment", "Discover", 0, 131.71],
      ["2026-05-04", "Bill", "IRS", 0, 150.00],
      ["2026-05-04", "Bill", "Comptroller of Maryland", 0, 155.97],
      ["2026-05-04", "Credit Card Payment", "Discover", 0, 500.00],
      ["2026-05-05", "Bill", "Dramawave", 0, 14.99],
      ["2026-05-05", "Expense", "Intl service fee", 0, 0.45],
      ["2026-05-06", "Fun", "EU Kaldis", 0, 9.58],
      ["2026-05-06", "Fun", "Little Spirit", 0, 39.16],
      ["2026-05-06", "Fun", "Little Spirit", 0, 19.59],
      ["2026-05-06", "Fun", "Bartaco", 0, 18.52],
      ["2026-05-07", "Fun", "Burle's Bar", 0, 42.20],
      ["2026-05-08", "Fun", "EU Kaldis", 0, 8.83],
      ["2026-05-08", "Bill", "Emory University", 0, 297.00],
      ["2026-05-11", "Bill", "Netflix", 0, 19.99],
      ["2026-05-12", "Bill", "Dramawave", 0, 19.99],
      ["2026-05-12", "Expense", "Intl service fee", 0, 0.60],
      ["2026-05-13", "Bill", "Apple", 0, 14.22],
      // deposits
      ["2026-04-17", "Zelle", "Zelle transfer", 15.00, 0],
      ["2026-04-21", "Tax Refund", "Georgia DOR", 47.00, 0],
      ["2026-04-22", "Zelle", "Zelle transfer", 10.00, 0],
      ["2026-04-24", "Zelle", "Zelle transfer", 20.00, 0],
      ["2026-04-30", "Transfer", "Internal transfer", 0.76, 0],
      ["2026-04-30", "Zelle", "Zelle transfer", 72.00, 0],
      ["2026-04-30", "Zelle", "Zelle — Woody", 150.00, 0],
      ["2026-04-30", "Paycheck", "Emory University", 3081.92, 0],
      ["2026-05-06", "Zelle", "Zelle — Woody", 150.00, 0],
      ["2026-05-14", "Zelle", "Zelle — Woody", 100.00, 0],
    ],
  },
  {
    label: "Jun 2026 statement (05/14 → 06/12)",
    endBalance: 64.61, totalDebits: 3225.66, totalCredits: 3270.42,
    txns: [
      // withdrawals
      ["2026-05-29", "Transfer", "Venmo", 0, 16.00],
      ["2026-06-01", "Transfer", "Zelle transfer", 0, 300.00],
      ["2026-06-01", "Investments", "Fidelity", 0, 25.00],
      ["2026-06-01", "Bill", "AT&T", 0, 55.27],
      ["2026-06-01", "Bill", "Bilt Rent", 0, 1240.50],
      ["2026-06-01", "Credit Card Payment", "Discover", 0, 800.00],
      ["2026-06-01", "Investments", "Fidelity", 0, 20.00],
      ["2026-06-01", "Savings", "Goldman Sachs", 0, 50.00],
      ["2026-06-02", "Fun", "EU Kaldis", 0, 9.58],
      ["2026-06-02", "Misc", "GPC", 0, 81.32],
      ["2026-06-02", "Bill", "IRS", 0, 150.00],
      ["2026-06-03", "Bill", "Comptroller of Maryland", 0, 155.97],
      ["2026-06-03", "Savings", "Goldman Sachs", 0, 12.35],
      ["2026-06-03", "Savings", "Goldman Sachs", 0, 54.95],
      ["2026-06-05", "Expense", "Urban Outfitters", 0, 52.87],
      ["2026-06-09", "Bill", "Netflix", 0, 19.99],
      ["2026-06-10", "Expense", "Urban Outfitters", 0, 181.86],
      // deposits
      ["2026-05-29", "Paycheck", "Emory University", 3081.92, 0],
      ["2026-06-01", "Zelle", "Zelle transfer", 68.50, 0],
      ["2026-06-11", "Zelle", "Zelle — Woody", 120.00, 0],
    ],
  },
];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function validate() {
  let bal = OPENING;
  for (const p of periods) {
    const debits = round2(p.txns.reduce((s, t) => s + t[4], 0));
    const credits = round2(p.txns.reduce((s, t) => s + t[3], 0));
    bal = round2(bal + credits - debits);
    const problems = [];
    if (debits !== p.totalDebits) problems.push(`debits ${debits} ≠ statement ${p.totalDebits}`);
    if (credits !== p.totalCredits) problems.push(`credits ${credits} ≠ statement ${p.totalCredits}`);
    if (bal !== p.endBalance) problems.push(`running ${bal} ≠ statement end ${p.endBalance}`);
    if (problems.length) throw new Error(`${p.label}: ${problems.join("; ")}`);
    console.log(`  ✓ ${p.label}: debits $${debits}, credits $${credits}, end $${bal}`);
  }
  return bal; // 64.61
}

function main() {
  const args = process.argv.slice(2);
  const accountId = argValue(args, "--account") || "rajna-checking";
  const replace = args.includes("--replace");

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!account) { console.error(`No account "${accountId}".`); process.exit(1); }

  const existing = db.prepare(
    "SELECT COUNT(*) n FROM transactions WHERE account_id = ? AND deleted_at IS NULL"
  ).get(accountId).n;
  if (existing > 0 && !replace) {
    console.error(`Account "${accountId}" already has ${existing} transactions. Re-run with --replace.`);
    process.exit(1);
  }

  console.log("Validating against statement control totals:");
  const endBalance = validate(); // throws on any mismatch
  const bridge = round2(CURRENT_BALANCE - endBalance);

  // Flatten periods + append the bridge adjustment to reach today's balance.
  const rows = periods.flatMap((p) => p.txns);
  rows.push([TODAY, "Adjustment", "Bridge to current balance (statements thru 06/12)", bridge > 0 ? bridge : 0, bridge < 0 ? -bridge : 0]);

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    if (replace) db.prepare("DELETE FROM transactions WHERE account_id = ?").run(accountId);
    db.prepare("UPDATE accounts SET opening_balance = ?, updated_at = ? WHERE id = ?").run(OPENING, now, accountId);
    const insert = db.prepare(`
      INSERT INTO transactions
        (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`);
    for (const [date, cat, src, dep, wd] of rows) {
      insert.run(randomUUID(), accountId, OWNER, date, cat, src, dep, wd, now, now);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  const all = db.prepare("SELECT * FROM transactions WHERE account_id = ? AND deleted_at IS NULL").all(accountId);
  const computed = accountBalance(all, { ...account, opening_balance: OPENING });

  console.log(`\nImported ${rows.length} transactions into "${accountId}" (${account.name}).`);
  console.log(`  opening_balance : $${OPENING.toFixed(2)} (03/16/2026)`);
  console.log(`  statements end  : $${endBalance.toFixed(2)} (06/12/2026)`);
  console.log(`  bridge adj.     : $${bridge.toFixed(2)} (to today's actual)`);
  console.log(`  computed balance: $${computed.toFixed(2)}`);
  const ok = Math.abs(computed - CURRENT_BALANCE) < 0.01;
  console.log(`  current balance : $${CURRENT_BALANCE.toFixed(2)}  ${ok ? "✓ matches" : "✗ MISMATCH"}`);
  if (!ok) process.exitCode = 2;
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
