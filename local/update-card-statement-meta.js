// One-time backfill of per-card statement metadata (statement_day, due_day,
// current APR) from the five PDF statements the user supplied in
// ~/Downloads/Statements (residual, non-blocking gap left open by T25/T35).
// `last4` is set where the statement shows it; Apple Card never prints a card
// number, so it stays null.
//
// Direct overwrite, not merge-only like seed-cards.js's backfill: these are
// confirmed values superseding nulls or stale guesses, not a re-seed that
// should defer to anything the app already wrote. Each `statement_day`/
// `due_day` reproduces its own statement's observed close/due date exactly
// through shared/cards.js's `statementCycle()` — verified by hand before
// this ran. APR corrections move the OLD seeded guess to the CURRENT
// go-forward rate the statement states (a card mid-promo, e.g. Rajna — Chase
// at 0% until 2027-07, is left alone: the promo rate IS the current rate).
//
// Idempotent: re-running applies the same values again.

import db from "./db.js";

const UPDATES = [
  { id: "woody-apple-card", patch: { statement_day: 31, due_day: 31, apr: 0.2549 } },
  { id: "woody-citi-card", patch: { last4: "3757", statement_day: 14, due_day: 10 } },
  { id: "rajna-capital-one", patch: { statement_day: 14, due_day: 9, apr: 0.2824 } },
  { id: "rajna-chase", patch: { last4: "1913", statement_day: 2, due_day: 27 } },
  { id: "rajna-discover", patch: { last4: "2321", statement_day: 4, due_day: 1, apr: 0.1799 } },
];

const get = db.prepare("SELECT data FROM accounts WHERE id = ? AND deleted_at IS NULL");
const upd = db.prepare("UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?");
const now = new Date().toISOString();

db.exec("BEGIN");
try {
  for (const { id, patch } of UPDATES) {
    const row = get.get(id);
    if (!row) { console.log(`→ ${id}: not found, skipped`); continue; }
    let data; try { data = JSON.parse(row.data || "{}"); } catch { data = {}; }
    const merged = { ...data, ...patch };
    upd.run(JSON.stringify(merged), now, id);
    console.log(`→ ${id}: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
