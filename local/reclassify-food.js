// One-time reclassification: tag dining/food transactions with the Food category.
// Matches by source (merchant) across all accounts; safe to re-run (only touches
// rows not already "Food"). Restaurants/cafes from the imported statements, e.g.
// EU Kaldis, Emory U Twist, Clifton Cafe, Tropical Smoothie, Little Spirit,
// Bartaco, Burle's Bar, FifthGroup.

import db from "./db.js";

const FOOD = /kaldis|kaldi's|\btwist\b|clifton cafe|tropical smoothie|little spirit|bartaco|burle|fifthgroup/i;

const rows = db.prepare("SELECT id, owner, txn_date, description, source FROM transactions WHERE deleted_at IS NULL").all();
const hits = rows.filter((r) => FOOD.test(r.source || "") && r.description !== "Food");

const now = new Date().toISOString();
const upd = db.prepare("UPDATE transactions SET description = 'Food', updated_at = ? WHERE id = ?");
db.exec("BEGIN");
try { for (const h of hits) upd.run(now, h.id); db.exec("COMMIT"); }
catch (e) { db.exec("ROLLBACK"); throw e; }

console.log(`Reclassified ${hits.length} transaction(s) to "Food".`);
const summary = {};
for (const h of hits) { const k = `${h.owner} · ${h.source} (was ${h.description || "—"})`; summary[k] = (summary[k] || 0) + 1; }
for (const [k, n] of Object.entries(summary).sort()) console.log(`  ${k}: ${n}`);
