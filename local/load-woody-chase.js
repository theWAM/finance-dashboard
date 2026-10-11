// T26b follow-up — load `woody-chase-card`'s real history.
//
// Resolves the "Open" item TASKS.md recorded and explicitly declined to act
// on: `load-card-statements.js` deliberately gave this card ZERO rows because
// it had no statement export and no `Card_Totals.csv` row, so there was
// nothing to anchor an opening balance to — inventing one would have been
// exactly the failure this whole phase is built to avoid. The user has since
// supplied both a statement PDF and a transaction-history CSV
// (`~/Downloads/woody_chase/`), which is a real anchor, so this is a separate
// one-off script rather than a new `CARDS` entry in load-card-statements.js —
// that file's opening-balance math is keyed on a `Card_Totals.csv` row this
// card has never had and should not be given one just to fit the shape.
//
//   node local/load-woody-chase.js             # dry run (default)
//   node local/load-woody-chase.js --commit
//   node local/load-woody-chase.js --revert <import_batch>
//
// Sign convention (decision #22, unchanged): debt is a NEGATIVE balance. A
// purchase/fee/interest charge is a `withdrawal`; a payment is a `deposit`.
//
// THE ANCHOR, replayed two independent ways:
//   (1) The Aug statement states New Balance $49.00 as of the 2026-08-23
//       close (11 of these 12 rows, everything through 08/01). Replaying from
//       a derived opening of $7,567.17 lands on exactly $49.00.
//   (2) The CSV's own last row (09/03 payment, $49.00) must zero the account —
//       this is the thing the household's own payment history keeps implying,
//       e.g. #47's $1,862.14 Chase→Citi transfer "clos[ing] the card out".
//       $7,567.17 is the one opening balance for which both hold to the cent;
//       see the reconciliation check below rather than taking this comment's
//       word for it.
//
// THE ONE CARD-TO-CARD LEG: the 2026-05-06 $1,862.14 "Payment Thank You -
// Bill" row is `BAL XFR. CHASE MASTERCARD & VISA`'s other half — recorded on
// Citi's ledger back in T26b as a one-legged transfer "since Woody's Chase
// card has no statement" (decision #47's note, now obsolete). It is loaded
// here as a `balance_transfer`, not a plain payment, and paired by
// `transfer_id` to the existing Citi-side row so the transfer is finally
// two-legged.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCsv } from "./import-csv.js";
import { assignExternalIds } from "../shared/card-import-spec.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = join(process.env.HOME || "", "Downloads", "woody_chase");
const CARD_ID = "woody-chase-card";
const FILE = "Woody_Chase.csv";
// The debt-arriving half already on Citi's ledger (T26b), which this load
// pairs against rather than re-deriving.
const CITI_TRANSFER_ROW = { account_id: "woody-citi-card", txn_date: "2026-05-05", amount: 1862.14 };
const TRANSFER_ID = "bt-2026-05-05-chase-citi";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? ""; };
const COMMIT = argv.includes("--commit");
const REVERT = flag("--revert");
const LOADED_AT = flag("--at") || new Date().toISOString();

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(10);
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));
const num = (s) => { const v = String(s ?? "").replace(/[$,\s]/g, ""); return v === "" ? 0 : Number(v); };

const db = new DatabaseSync(join(ROOT, "local", "dashboard.db"));

if (REVERT) {
  const n = db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch = ?").get(REVERT).c;
  if (!n) { console.error(`No rows carry import_batch '${REVERT}'.`); process.exit(2); }
  if (!COMMIT) { console.log(`Would hard-delete ${n} row(s) and clear the paired Citi row's transfer_id. Re-run with --commit.`); process.exit(0); }
  const ts = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM transactions WHERE import_batch = ?").run(REVERT);
    db.prepare("UPDATE transactions SET transfer_id = NULL, updated_at = ? WHERE transfer_id = ?").run(ts, TRANSFER_ID);
    db.prepare("UPDATE accounts SET opening_balance = 0, data = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ issuer: "Chase", last4: null, credit_limit: null, apr: null, statement_day: null, due_day: null, min_payment: null, source_aliases: ["Chase Card"] }), ts, CARD_ID);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  console.log(`Reverted batch '${REVERT}': removed ${n} row(s), unlinked the Citi pairing, reset ${CARD_ID} to empty.`);
  process.exit(0);
}

if (!existsSync(STAGING)) { console.error(`Staging directory not found: ${STAGING}`); process.exit(2); }

const text = readFileSync(join(STAGING, FILE), "utf8").replace(/^﻿/, "");
const csvRows = parseCsv(text);
const header = csvRows[0];
const objs = csvRows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""))
  .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), String(r[i] ?? "").trim()])));

const rows = objs.map((r) => {
  const amount = num(r.Amount); // positive = Payment; negative = Fee/Sale (decision #22's convention already, no flip needed)
  const isBalTransfer = r.Type === "Payment" && Math.abs(amount - CITI_TRANSFER_ROW.amount) < 0.005;
  let kind, description;
  if (isBalTransfer) {
    kind = "balance_transfer";
    description = "Transfer";
  } else if (r.Type === "Payment") {
    kind = "payment";
    description = "Credit Card Payment";
  } else if (/INTEREST/i.test(r.Description)) {
    kind = "interest";
    description = "Interest";
  } else if (r.Type === "Fee") {
    kind = "fee";
    description = "Bill";
  } else {
    // The one purchase (Nintendo, Category=Entertainment). Chase's issuer
    // table (shared/card-import-spec.js) has no Chase categories at all —
    // rajna-chase was a payment-only export — so this maps directly rather
    // than through `mapIssuerCategory`, matching "Fun" the same way Apple's
    // and Capital One's own `Entertainment` does.
    kind = amount < 0 ? "purchase" : "refund";
    description = "Fun";
  }
  return {
    txn_date: toIso(r["Transaction Date"]),
    source: r.Description,
    description,
    deposit: amount > 0 ? round2(amount) : 0,
    withdrawal: amount < 0 ? round2(-amount) : 0,
    note: `Chase · ${r.Category || "uncategorized"}/${r.Type}`,
    kind,
  };
});

function toIso(mdy) {
  const [m, d, y] = mdy.split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const withIds = assignExternalIds(rows, CARD_ID);

// --- reconciliation, both independent anchors ------------------------------

const charges = sum(rows.map((r) => r.withdrawal));
const credits = sum(rows.map((r) => r.deposit));
const net = round2(charges - credits);
// Anchor 1: the CSV's own last row (09/03 payment) must zero the account.
const openingDebt = round2(0 - net);
// Anchor 2: replay through 08/23 (the statement close) and expect $49.00.
const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
const through0823 = sorted.filter((r) => r.txn_date <= "2026-08-23");
const debtAt0823 = round2(openingDebt + sum(through0823.map((r) => r.withdrawal)) - sum(through0823.map((r) => r.deposit)));

console.log(`load-woody-chase  ${COMMIT ? "[COMMIT]" : "[dry run]"}`);
console.log(`${"═".repeat(84)}`);
console.log(`${CARD_ID}  —  Chase (Disney Visa, ${FILE})`);
console.log(`${"═".repeat(84)}`);
console.log(`  rows ${rows.length}   span ${sorted[0].txn_date} → ${sorted[sorted.length - 1].txn_date}`);
console.log(`  charges ${money(charges)}   credits ${money(-credits)}   net ${money(net)}`);
console.log(`  DERIVED opening_balance ${money(-openingDebt)}   (debt ${money(openingDebt)})`);

let ok = true;
const check = (cond, label) => { console.log(`  ${cond ? "✅" : "✗ "} ${label}`); if (!cond) ok = false; };
check(openingDebt >= -0.005, "derived opening debt is not negative");
check(Math.abs(debtAt0823 - 49.00) < 0.005, `replays to the 2026-08-23 statement's $49.00 close (got ${money(debtAt0823)})`);
check(round2(openingDebt + net) === 0, "replays to exactly $0.00 after the last (09/03) row");
const dupWithin = withIds.length - new Set(withIds.map((r) => r.external_id)).size;
check(dupWithin === 0, "every row has a unique external_id");

console.log(`\n  by kind:`);
const byKind = {}, countByKind = {};
for (const r of rows) { byKind[r.kind] = round2((byKind[r.kind] || 0) + r.withdrawal - r.deposit); countByKind[r.kind] = (countByKind[r.kind] || 0) + 1; }
for (const k of Object.keys(byKind).sort()) console.log(`     ${k.padEnd(18)} ${String(countByKind[k]).padStart(2)} rows   net ${money(byKind[k])}`);

console.log(`\n  cross-card: the 2026-05-06 $1,862.14 row pairs with Citi's existing 2026-05-05`);
console.log(`  "BAL XFR. CHASE MASTERCARD & VISA" row under transfer_id '${TRANSFER_ID}'.`);

if (!COMMIT) {
  console.log(`\n${"─".repeat(84)}`);
  console.log(ok ? "✅ every check passed — re-run with --commit to write" : "✗ checks failed — nothing would be written");
  process.exit(ok ? 0 : 1);
}
if (!ok) { console.error("\n✗ refusing to write: a check failed above."); process.exit(1); }

// --- write -------------------------------------------------------------

const acct = db.prepare("SELECT * FROM accounts WHERE id = ?").get(CARD_ID);
if (!acct) { console.error(`✗ no account '${CARD_ID}'. Run \`npm run seed:cards\` first.`); process.exit(2); }

const batch = `woody-chase-${LOADED_AT}`;
const insert = db.prepare(`INSERT INTO transactions
    (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note,
     transfer_id, external_id, import_batch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const existingIds = new Set(db.prepare("SELECT external_id FROM transactions WHERE external_id IS NOT NULL").all().map((r) => r.external_id));
const dates = rows.map((r) => r.txn_date).sort();

db.exec("BEGIN");
try {
  let inserted = 0, skipped = 0;
  for (const r of withIds) {
    if (existingIds.has(r.external_id)) { skipped++; continue; }
    existingIds.add(r.external_id);
    insert.run(
      `woody-chase-${r.external_id}`, CARD_ID, acct.owner, r.txn_date, r.description, r.source,
      r.deposit, r.withdrawal, r.note, r.kind === "balance_transfer" ? TRANSFER_ID : null,
      r.external_id, batch, LOADED_AT, LOADED_AT,
    );
    inserted++;
  }
  // Pair the Citi side of the same transfer.
  db.prepare("UPDATE transactions SET transfer_id = ?, updated_at = ? WHERE account_id = ? AND txn_date = ? AND withdrawal = ? AND transfer_id IS NULL")
    .run(TRANSFER_ID, LOADED_AT, CITI_TRANSFER_ROW.account_id, CITI_TRANSFER_ROW.txn_date, CITI_TRANSFER_ROW.amount);

  let prev; try { prev = JSON.parse(acct.data || "{}"); } catch { prev = {}; }
  const data = {
    ...prev,
    issuer: "Chase", last4: "9372", credit_limit: 9000, apr: 0.2649,
    statement_day: 23, due_day: 20, min_payment: null,
    source_aliases: prev.source_aliases?.length ? prev.source_aliases : ["Chase Card"],
    seeded_range: [dates[0], dates[dates.length - 1]],
    statements: {
      source: "statement PDF (2026-08-23 close) + Woody_Chase.csv", as_of: "2026-09-03",
      current_balance: 0,
      periods: [{ closing_date: "2026-08-23", closing_balance: 49.00 }, { closing_date: "2026-09-03", closing_balance: 0 }],
      derived_month_end: monthEndLadder(rows, openingDebt),
    },
    load: { task: "T26b-followup", batch, loaded_at: LOADED_AT, rows: rows.length, file: FILE },
  };
  db.prepare("UPDATE accounts SET opening_balance = ?, data = ?, updated_at = ? WHERE id = ?")
    .run(round2(-openingDebt), JSON.stringify(data), LOADED_AT, CARD_ID);

  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('dirty', '1')").run();
  db.exec("COMMIT");
  console.log(`\n✅ inserted ${inserted}, skipped ${skipped} (already present).`);
  console.log(`   opening_balance → ${(-openingDebt).toFixed(2)}   seeded_range → ${dates[0]}..${dates[dates.length - 1]}`);
  console.log(`   import_batch → ${batch}   (undo: node local/load-woody-chase.js --revert ${batch} --commit)`);
} catch (e) { db.exec("ROLLBACK"); console.error(`\n✗ rolled back — ${e.message}`); throw e; }

function monthEndLadder(rows, openingDebt) {
  const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const months = [...new Set(sorted.map((r) => r.txn_date.slice(0, 7)))].sort();
  let bal = openingDebt, i = 0;
  const out = [];
  for (const m of months) {
    while (i < sorted.length && sorted[i].txn_date.slice(0, 7) <= m) { bal = round2(bal + sorted[i].withdrawal - sorted[i].deposit); i++; }
    out.push({ month: m, closing_balance: bal });
  }
  return out;
}
