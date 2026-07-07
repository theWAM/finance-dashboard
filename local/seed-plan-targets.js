// Seed the migrated fin_plan.html strategy as editable plan_targets:
// debt-payoff targets, savings goals (with variable start/end dates), and
// investment cadence. Idempotent by (kind,name): only inserts missing ones, so
// edits made in the app are preserved. Values are sensible starting points —
// they're meant to be edited in the Plan tab.
//
// `source` links a target to the ledger rows that fund it (matched by the
// transaction's Source/Recipient), so drift detection can compare plan vs actual.

import { randomUUID } from "node:crypto";
import db from "./db.js";

const TARGETS = [
  // Debts — balance, APR (fraction), monthly payment, target payoff date.
  { owner: "woody", kind: "debt_payoff", name: "Apple Card", data: { balance: 4200, apr: 0.2624, monthly_payment: 1050, target_date: "2026-12-31", source: "Apple Card" } },
  { owner: "rajna", kind: "debt_payoff", name: "Discover", data: { balance: 6800, apr: 0.2299, monthly_payment: 800, target_date: "2027-03-31", source: "Discover" } },

  // Savings goals — target amount + variable window; source matches the HYSA rows.
  { owner: "shared", kind: "savings_goal", name: "Emergency", data: { target_amount: 10000, start_date: "2026-01-01", end_date: "2026-12-31", source: "Emergency HYSA" } },
  { owner: "shared", kind: "savings_goal", name: "Vacation", data: { target_amount: 5000, start_date: "2026-01-01", end_date: "2026-12-31", source: "Vacation HYSA" } },
  { owner: "shared", kind: "savings_goal", name: "Apartment", data: { target_amount: 8000, start_date: "2026-01-01", end_date: "2027-06-30", source: "Apartment HYSA" } },
  { owner: "shared", kind: "savings_goal", name: "Wedding", data: { target_amount: 20000, start_date: "2026-01-01", end_date: "2027-12-31", source: "Wedding HYSA" } },

  // Investment cadence — monthly target + source it maps to.
  { owner: "woody", kind: "investment_cadence", name: "Roth IRA", data: { monthly_target: 636, source: "Fidelity Roth IRA" } },
  { owner: "woody", kind: "investment_cadence", name: "Brokerage", data: { monthly_target: 364, source: "Fidelity Individual" } },
];

const now = new Date().toISOString();
const existing = db.prepare("SELECT kind, name FROM plan_targets WHERE deleted_at IS NULL").all();
const has = (k, n) => existing.some((r) => r.kind === k && r.name === n);
const insert = db.prepare(`INSERT INTO plan_targets (id, owner, kind, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);

let added = 0;
db.exec("BEGIN");
try {
  for (const t of TARGETS) {
    if (has(t.kind, t.name)) continue;
    insert.run(randomUUID(), t.owner, t.kind, t.name, JSON.stringify(t.data), now, now);
    added++;
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
console.log(`Seeded ${added} plan target(s) (${TARGETS.length - added} already present).`);
