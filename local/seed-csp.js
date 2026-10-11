// Seed the Conscious Spending Plans from local/csp-seed.json into plan_targets
// as the two new kinds, `csp_plan` and `csp_item`.
//
//   npm run seed:csp              insert anything missing, touch nothing else
//   npm run seed:csp -- --replace re-apply the file to every seeded row
//   npm run seed:csp -- --patch   add only `data` keys the row doesn't have yet
//   npm run seed:csp -- --dry-run show what would change, write nothing
//
// `--patch` exists because of T28. Decision #38 put three new keys on an item
// (`direction`, `good_at`, `warn_at`) that the page has no editor for, so they
// can only arrive from this file — but by then the targets in the database are
// the user's real, edited numbers, and `--replace` would reset them to the
// PDF's. So a patch merges in only the keys that are ABSENT, never overwriting
// a value someone has set. Unlike a seed it stamps `updated_at` with the real
// time: it is a genuine change and has to win the last-writer-wins merge.
//
// NO SCHEMA CHANGE. `csp_plan` / `csp_item` are just two more `plan_targets.kind`
// values, so they flow through the existing CRUD, the snapshot, and the
// last-writer-wins merge without a single line of new plumbing. The Plan tab and
// the Dashboard both ignore unknown kinds, so they stay unaffected.
//
// Ids are stable and content-addressed (`csp-<plan>`, `csp-<plan>-<slug>`),
// frozen by T0, so the same plan has the same id on every machine — which is
// what lets the per-record merge line them up instead of duplicating them.
//
// Seeded rows are stamped `updated_at` = epoch so they ALWAYS lose the LWW
// merge: a placeholder must never out-rank the real numbers in a published
// snapshot. The moment someone edits a value in the app its `updated_at` jumps
// to now and it wins, as intended.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";

const SEED_TS = "1970-01-01T00:00:00.000Z";
const KINDS = new Set(["csp_plan", "csp_item"]);

const replace = process.argv.includes("--replace");
const patch = process.argv.includes("--patch");
const dryRun = process.argv.includes("--dry-run");
if (replace && patch) { console.error("--replace and --patch mean opposite things; pick one."); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, "csp-seed.json"), "utf8"));
const rows = [...(seed.plans || []), ...(seed.items || [])];

// --- validate the payload before touching the database ---------------------
// A duplicate id would silently overwrite a real plan on a --replace, and an
// orphaned plan_id renders as an item nobody can see. Fail loudly instead.
const problems = [];
const seen = new Set();
for (const r of rows) {
  if (!r.id) problems.push(`row with no id: ${JSON.stringify(r.name)}`);
  if (seen.has(r.id)) problems.push(`duplicate id: ${r.id}`);
  seen.add(r.id);
  if (!KINDS.has(r.kind)) problems.push(`${r.id}: unexpected kind ${r.kind}`);
}
const planIds = new Set((seed.plans || []).map((p) => p.id));
for (const it of seed.items || []) {
  if (!planIds.has(it.data?.plan_id)) problems.push(`${it.id}: plan_id ${it.data?.plan_id} is not in this file`);
  const buckets = new Set((seed.plans.find((p) => p.id === it.data?.plan_id)?.data?.buckets || []).map((b) => b.bucket));
  if (!buckets.has(it.data?.bucket)) problems.push(`${it.id}: bucket ${it.data?.bucket} is not declared by its plan`);
}
for (const p of seed.plans || []) {
  const catchAlls = (p.data?.buckets || []).filter((b) => b.catch_all).length;
  // Decision #6: exactly one bucket absorbs the unmatched outflow. Zero means
  // money disappears from the comparison; two means it gets double-counted.
  if (catchAlls !== 1) problems.push(`${p.id}: ${catchAlls} catch-all buckets (expected exactly 1)`);
}
if (problems.length) {
  console.error(`csp-seed.json is not usable:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

// --- plan the writes --------------------------------------------------------
const existing = new Map(
  db.prepare("SELECT id, name, owner, data, created_at, deleted_at FROM plan_targets").all().map((r) => [r.id, r]),
);

const inserts = [], updates = [];
const patched = [];   // id -> which keys a --patch would add, for the dry-run log
for (const r of rows) {
  const cur = existing.get(r.id);
  const data = JSON.stringify(r.data ?? {});
  if (!cur) { inserts.push({ ...r, data }); continue; }
  if (patch) {
    // Absent keys only — a key the row already carries is the user's answer,
    // even when it differs from the file's.
    let curData = {};
    try { curData = JSON.parse(cur.data || "{}"); } catch { curData = {}; }
    const add = Object.keys(r.data ?? {}).filter((k) => !(k in curData));
    if (!add.length) continue;
    const merged = { ...curData };
    for (const k of add) merged[k] = r.data[k];
    patched.push({ id: r.id, keys: add });
    // Name and owner are left exactly as they are: this is a data patch.
    updates.push({ ...r, owner: cur.owner, name: cur.name, data: JSON.stringify(merged) });
    continue;
  }
  if (!replace) continue;
  // Only rewrite rows that actually differ, so a second --replace is a no-op
  // and the output tells you plainly that nothing moved.
  const same = cur.name === r.name && cur.owner === r.owner && cur.data === data && !cur.deleted_at;
  if (!same) updates.push({ ...r, data });
}

const summary = `${inserts.length} insert(s), ${updates.length} update(s)` +
  `, ${rows.length - inserts.length - updates.length} unchanged`;

if (dryRun) {
  console.log(`[dry run] ${summary}`);
  for (const r of inserts) console.log(`  + ${r.kind.padEnd(8)} ${r.id}  ${r.name}`);
  for (const r of updates) {
    const keys = patched.find((x) => x.id === r.id);
    console.log(`  ~ ${r.kind.padEnd(8)} ${r.id}  ${r.name}${keys ? `  + ${keys.keys.join(", ")}` : ""}`);
  }
  if (!replace && !patch && rows.some((r) => existing.has(r.id))) {
    console.log("  (rows that already exist are left alone — pass --replace to re-apply the file)");
  }
  process.exit(0);
}

// node:sqlite has no .transaction() helper, so drive the transaction by hand.
const insert = db.prepare(
  `INSERT INTO plan_targets (id, owner, kind, name, data, created_at, updated_at, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
);
// Clearing deleted_at is deliberate: --replace means "make the database match
// this file", including resurrecting a seeded row someone deleted.
const update = db.prepare(
  `UPDATE plan_targets SET owner = ?, kind = ?, name = ?, data = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`,
);

db.exec("BEGIN");
try {
  for (const r of inserts) insert.run(r.id, r.owner || "shared", r.kind, r.name ?? "", r.data, SEED_TS, SEED_TS);
  const stamp = patch ? new Date().toISOString() : SEED_TS;
  for (const r of updates) update.run(r.owner || "shared", r.kind, r.name ?? "", r.data, stamp, r.id);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

const counts = db.prepare(
  `SELECT kind, COUNT(*) AS n FROM plan_targets WHERE deleted_at IS NULL AND kind IN ('csp_plan','csp_item') GROUP BY kind ORDER BY kind`,
).all();
console.log(`Seeded CSPs: ${summary}.`);
console.log(`Now in the database: ${counts.map((c) => `${c.n} ${c.kind}`).join(", ") || "nothing"}.`);
for (const x of patched) console.log(`  patched ${x.id}: + ${x.keys.join(", ")}`);
if (!replace && !patch && updates.length === 0 && inserts.length === 0) {
  console.log("Nothing to do — pass --replace to re-apply csp-seed.json over the existing rows.");
}
