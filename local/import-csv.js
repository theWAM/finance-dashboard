// One-time importer: seed a checking account's ledger from an exported Google
// Sheet CSV (Date, Description, Source/Recipient, Deposit (+), Withdrawal (-),
// Running Balance). Every imported row becomes a transaction owned by the
// target account's owner; the account's opening_balance is derived so the
// computed running balance reconstructs the sheet's.
//
// Usage:
//   node local/import-csv.js "<path-to.csv>" [--account woody-checking] [--replace]
//
//   --account   id of an existing account to import into (default: woody-checking)
//   --replace   hard-delete that account's existing transactions first (fresh import)
//
// Idempotency: without --replace the script refuses to run if the account
// already has transactions, so it can't silently double-import.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import db from "./db.js";
import { accountBalance } from "../shared/metrics.js";

// --- CSV parsing -----------------------------------------------------------

/** Parse CSV text into rows of string cells. Handles quoted fields, escaped
 *  double-quotes ("") and commas/newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n"); // normalize line endings
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // flush trailing field/row (files may not end in a newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** M/D/YYYY (the sheet's format) -> ISO YYYY-MM-DD. Returns "" if unparseable. */
export function toIsoDate(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const num = (s) => {
  const n = Number(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Convert parsed CSV rows into ledger transaction inputs.
 * Skips the header and pure annotation rows (no date, or no amounts AND no
 * description/source — the sheet's balance-restating spacer rows), which carry
 * a running balance but no real transaction.
 * Returns { txns, sheetRunning, firstRunning } where sheetRunning is the last
 * running-balance value in the sheet and firstRunning is the running balance of
 * the first KEPT transaction (both used to derive/reconcile opening_balance).
 */
export function rowsToTransactions(rows) {
  const txns = [];
  let sheetRunning = null;
  let firstRunning = null;
  for (let i = 1; i < rows.length; i++) { // skip header row 0
    const [dateRaw, descRaw = "", srcRaw = "", depRaw = "", wdRaw = "", runRaw = ""] = rows[i];
    const txn_date = toIsoDate(dateRaw);
    const description = String(descRaw).trim();
    const source = String(srcRaw).trim();
    const deposit = round2(num(depRaw));
    const withdrawal = round2(num(wdRaw));
    const hasRun = String(runRaw).trim() !== "";
    if (hasRun) sheetRunning = round2(num(runRaw));

    // Skip annotation/spacer rows: no usable date, or a row with no money and
    // no description/source (a bare running-balance restatement).
    if (!txn_date) continue;
    if (deposit === 0 && withdrawal === 0 && !description && !source) continue;

    if (firstRunning === null && hasRun) firstRunning = round2(num(runRaw));
    // `stated` = the row's own running balance (or null), used to detect and
    // reconcile any balance discontinuities the sheet had.
    txns.push({ txn_date, description, source, deposit, withdrawal, stated: hasRun ? round2(num(runRaw)) : null });
  }
  return { txns, sheetRunning, firstRunning };
}

/**
 * Walk the kept transactions from openingBalance and, wherever a row's stated
 * running balance diverges from what the transactions explain, splice in an
 * explicit "Adjustment" transaction to close the gap. This makes the imported
 * ledger reconstruct the sheet's running balance exactly, while keeping every
 * unexplained change visible and editable rather than silently dropped.
 * @returns {{ rows: Array<object>, adjustments: number, adjustmentTotal: number }}
 */
export function reconcile(txns, openingBalance) {
  let bal = round2(openingBalance);
  const rows = [];
  let adjustments = 0;
  let adjustmentTotal = 0;
  for (const t of txns) {
    bal = round2(bal + t.deposit - t.withdrawal);
    rows.push(t);
    if (t.stated != null) {
      const gap = round2(t.stated - bal);
      if (Math.abs(gap) >= 0.01) {
        rows.push({
          txn_date: t.txn_date,
          description: "Adjustment",
          source: "Imported balance correction",
          deposit: gap > 0 ? gap : 0,
          withdrawal: gap < 0 ? -gap : 0,
          stated: t.stated,
        });
        adjustments++;
        adjustmentTotal = round2(adjustmentTotal + gap);
        bal = t.stated;
      }
    }
  }
  return { rows, adjustments, adjustmentTotal };
}

// --- Import ----------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  const accountId = argValue(args, "--account") || "woody-checking";
  const replace = args.includes("--replace");

  if (!csvPath) {
    console.error('Usage: node local/import-csv.js "<path-to.csv>" [--account <id>] [--replace]');
    process.exit(1);
  }

  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!account) {
    console.error(`No account with id "${accountId}". Known accounts:`);
    for (const a of db.prepare("SELECT id, name FROM accounts").all()) console.error(`  ${a.id}  (${a.name})`);
    process.exit(1);
  }

  const existing = db.prepare(
    "SELECT COUNT(*) n FROM transactions WHERE account_id = ? AND deleted_at IS NULL"
  ).get(accountId).n;
  if (existing > 0 && !replace) {
    console.error(`Account "${accountId}" already has ${existing} transactions. Re-run with --replace to reimport.`);
    process.exit(1);
  }

  const { txns, sheetRunning, firstRunning } = rowsToTransactions(parseCsv(readFileSync(csvPath, "utf8")));
  if (txns.length === 0) {
    console.error("No transactions parsed from CSV — nothing to import.");
    process.exit(1);
  }

  // Derive opening_balance so the first kept row's computed running balance
  // matches the sheet: the sheet's running balance is post-transaction, so
  // opening = (first kept row's running balance) − (that row's net).
  const firstNet = txns[0].deposit - txns[0].withdrawal;
  const openingBalance = round2((firstRunning ?? firstNet) - firstNet);

  // Splice in adjustment transactions wherever the sheet's balance jumped.
  const { rows: ledgerRows, adjustments, adjustmentTotal } = reconcile(txns, openingBalance);

  const now = new Date().toISOString();
  // node:sqlite has no .transaction() helper — wrap manually so a failure rolls back.
  db.exec("BEGIN");
  try {
    if (replace) db.prepare("DELETE FROM transactions WHERE account_id = ?").run(accountId);
    db.prepare("UPDATE accounts SET opening_balance = ?, updated_at = ? WHERE id = ?")
      .run(openingBalance, now, accountId);
    const insert = db.prepare(`
      INSERT INTO transactions
        (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
    `);
    for (const t of ledgerRows) {
      insert.run(randomUUID(), accountId, account.owner, t.txn_date, t.description, t.source, t.deposit, t.withdrawal, now, now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // Reconcile: our computed balance vs. the sheet's final running balance.
  const all = db.prepare("SELECT * FROM transactions WHERE account_id = ? AND deleted_at IS NULL").all(accountId);
  const computed = accountBalance(all, { ...account, opening_balance: openingBalance });

  console.log(`Imported ${ledgerRows.length} transactions into "${accountId}" (${account.name}).`);
  console.log(`  from CSV rows   : ${txns.length}`);
  if (adjustments > 0) {
    console.log(`  + adjustments   : ${adjustments} (net $${adjustmentTotal.toFixed(2)}) — spliced in where the sheet's balance jumped without a transaction`);
  }
  console.log(`  opening_balance : $${openingBalance.toFixed(2)}`);
  console.log(`  computed balance: $${computed.toFixed(2)}`);
  if (sheetRunning != null) {
    const diff = round2(computed - sheetRunning);
    const ok = Math.abs(diff) < 0.01;
    console.log(`  sheet balance   : $${sheetRunning.toFixed(2)}  ${ok ? "✓ matches" : `✗ off by $${diff.toFixed(2)}`}`);
    if (!ok) process.exitCode = 2;
  }
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// Only run the import when invoked directly (not when imported for its parsers).
if (import.meta.url === `file://${process.argv[1]}`) main();
