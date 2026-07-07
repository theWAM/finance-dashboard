// Seed Rajna's forecast: her recurring monthly items projected forward through
// the end of 2026 — paydays plus regular payments (rent, bills), savings, and
// incoming transfers from Woody and Anna. Amounts mirror her Truist history.
//
// Only inserts dates strictly AFTER today (so it never conflicts with the
// reconciling bridge adjustment on 2026-07-06). Idempotent: rows carry
// note='forecast' and are cleared before re-inserting.
//
// Usage: node local/seed-rajna-forecast.js

import { randomUUID } from "node:crypto";
import db from "./db.js";

const ACCOUNT = "rajna-checking";
const OWNER = "rajna";
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR_END = "2026-12-31";

// Recurring monthly template. `day` is a day-of-month, or "last-business" for the
// paycheck (Emory pays the last business day). flow is deposit (+) or withdrawal.
const TEMPLATE = [
  { day: "last-business", category: "Paycheck", source: "Emory University", deposit: 3081.92 },
  { day: 1, category: "Zelle", source: "Zelle — Anna", deposit: 70 },
  { day: 6, category: "Zelle", source: "Zelle — Woody", deposit: 150 },
  { day: 20, category: "Zelle", source: "Zelle — Woody", deposit: 100 },
  { day: 1, category: "Bill", source: "Bilt Rent", withdrawal: 1240 },
  { day: 1, category: "Bill", source: "AT&T", withdrawal: 55.27 },
  { day: 1, category: "Credit Card Payment", source: "Discover", withdrawal: 800 },
  { day: 1, category: "Investments", source: "Fidelity", withdrawal: 25 },
  { day: 1, category: "Savings", source: "Goldman Sachs", withdrawal: 50 },
  { day: 2, category: "Bill", source: "IRS", withdrawal: 150 },
  { day: 3, category: "Bill", source: "Comptroller of Maryland", withdrawal: 155.97 },
  { day: 3, category: "Bill", source: "OpenAI", withdrawal: 20 },
  { day: 9, category: "Bill", source: "Netflix", withdrawal: 19.99 },
  { day: 13, category: "Bill", source: "Apple", withdrawal: 9.99 },
];

const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
function lastBusinessDay(y, m) {
  let d = daysIn(y, m);
  while (true) {
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) return d; // skip Sun(0)/Sat(6)
    d--;
  }
}

// Build the list of (date, item) for Jul–Dec 2026, only dates after today.
const rows = [];
for (let m = 6; m <= 11; m++) { // July (6) … December (11), 2026
  const y = 2026;
  for (const item of TEMPLATE) {
    const day = item.day === "last-business" ? lastBusinessDay(y, m) : Math.min(item.day, daysIn(y, m));
    const date = iso(y, m, day);
    if (date <= TODAY || date > YEAR_END) continue;
    rows.push({ date, ...item });
  }
}
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const now = new Date().toISOString();
db.exec("BEGIN");
try {
  const cleared = db.prepare("DELETE FROM transactions WHERE account_id = ? AND note = 'forecast'").run(ACCOUNT).changes;
  const insert = db.prepare(`
    INSERT INTO transactions (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'forecast', ?, ?)`);
  for (const r of rows) insert.run(randomUUID(), ACCOUNT, OWNER, r.date, r.category, r.source, r.deposit || 0, r.withdrawal || 0, now, now);
  db.exec("COMMIT");
  console.log(`Cleared ${cleared} prior forecast rows; inserted ${rows.length} forecast transactions (${rows[0]?.date} → ${rows.at(-1)?.date}).`);
} catch (e) { db.exec("ROLLBACK"); throw e; }

// Show the resulting balance projection endpoint.
const all = db.prepare("SELECT deposit, withdrawal FROM transactions WHERE account_id = ? AND deleted_at IS NULL").all(ACCOUNT);
const acct = db.prepare("SELECT opening_balance FROM accounts WHERE id = ?").get(ACCOUNT);
let bal = acct.opening_balance;
for (const t of all) bal += (t.deposit || 0) - (t.withdrawal || 0);
console.log(`  projected end-of-set balance (all rows): $${(Math.round(bal * 100) / 100).toFixed(2)}`);
