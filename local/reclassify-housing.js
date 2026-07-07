// One-time reclassification of Rajna's recurring counterparties.
// Idempotent: maps both the old and already-renamed source names to the final
// source + category, so partially-renamed rows converge too.
//   Bilt Rent      → Inkwell Rent (Housing)
//   Zelle — Woody  → Woody Discover (Credit Card Payment)
//   Zelle — Anna   → Anna Utilities (Housing)

import db from "./db.js";

const MAPS = [
  { from: ["Bilt Rent", "Inkwell Rent"], source: "Inkwell Rent", description: "Housing" },
  { from: ["Zelle — Woody", "Woody Discover"], source: "Woody Discover", description: "Credit Card Payment" },
  { from: ["Zelle — Anna", "Anna Utilities"], source: "Anna Utilities", description: "Housing" },
];

const now = new Date().toISOString();
const upd = db.prepare("UPDATE transactions SET source = ?, description = ?, updated_at = ? WHERE source = ? AND deleted_at IS NULL AND NOT (source = ? AND description = ?)");
db.exec("BEGIN");
try {
  for (const m of MAPS) {
    let changed = 0;
    for (const name of m.from) changed += upd.run(m.source, m.description, now, name, m.source, m.description).changes;
    console.log(`→ ${m.source} / ${m.description}: ${changed} row(s) updated`);
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
