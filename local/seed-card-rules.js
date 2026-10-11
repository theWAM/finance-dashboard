// Seed T30's merchant rules from local/card-rules-seed.json into plan_targets
// as the new kind, `card_rule`.
//
//   npm run seed:card-rules              insert anything missing, touch nothing else
//   npm run seed:card-rules -- --replace re-apply the file over the seeded rows
//   npm run seed:card-rules -- --dry-run show what would change, write nothing
//
// NO SCHEMA CHANGE, for the same reason `csp_plan` / `csp_item` needed none:
// `card_rule` is one more `plan_targets.kind`, so it rides the existing CRUD,
// the snapshot, and the per-record last-writer-wins merge without a line of new
// plumbing. The Plan page, the Spending Plan page and the Dashboard all filter
// by kind, so they stay unaffected.
//
// Ids are stable and content-addressed (`card-rule-<slug>`), so the same rule
// has the same id on both machines and the merge lines them up instead of
// duplicating them.
//
// OWNER IS `shared`, DELIBERATELY. "Walmart is groceries" is a fact about the
// household, not about a person, and Rajna's three cards are themselves
// `owner: 'shared'` (#43/#44). Rules the app LEARNS are created under the
// current user, which is the same owner-scoping the card dropdown uses
// (`owner === currentUser || 'shared'`); seeding them per-person would mean
// Woody's rules silently not applying to the cards he services for Rajna.
//
// Seeded rows are stamped `updated_at` = epoch so they ALWAYS lose the merge
// against real published data; the moment someone edits a rule in the app its
// timestamp jumps to now and it wins, as intended.
//
// This script writes RULES ONLY. Re-categorizing the rows the rules match is
// `npm run categorize:cards`, a separate, reversible, dry-run-by-default pass —
// one command that edits the strategy and 977 ledger rows at once is not a
// command anyone should have to trust.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";
import { RULE_KIND, compileRule, MATCH_TYPES } from "../shared/card-rules.js";

const SEED_TS = "1970-01-01T00:00:00.000Z";

const replace = process.argv.includes("--replace");
const dryRun = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, "card-rules-seed.json"), "utf8"));
const rules = seed.rules || [];

// --- validate before touching the database ---------------------------------
// Two failures worth being loud about: a duplicate id silently overwrites
// another rule, and an uncompilable rule (empty needle, bad regex) is a rule
// that either matches nothing or matches everything. The bulk pass rewrites
// hundreds of rows, so "matches everything" is the expensive one.
const problems = [];
const seen = new Set();
for (const r of rules) {
  if (!r.id) problems.push(`rule with no id: ${JSON.stringify(r.name)}`);
  if (seen.has(r.id)) problems.push(`duplicate id: ${r.id}`);
  seen.add(r.id);
  if (r.match_type && !MATCH_TYPES.includes(r.match_type)) problems.push(`${r.id}: unknown match_type ${r.match_type}`);
  const compiled = compileRule(toPlanTarget(r));
  if (compiled.error) problems.push(`${r.id}: ${compiled.error}`);
}
if (problems.length) {
  console.error(`card-rules-seed.json is not usable:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

function toPlanTarget(r) {
  return {
    id: r.id,
    owner: r.owner || "shared",
    kind: RULE_KIND,
    name: r.name ?? r.match,
    data: {
      match: r.match,
      match_type: r.match_type || "contains",
      account_id: r.account_id ?? null,
      description: r.description ?? "",
      source: r.source ?? "",
      priority: r.priority ?? 0,
      // The decision itself, carried with the rule. It is the reason this file
      // exists rather than a list of needles, and the editor shows it.
      why: r.why ?? "",
    },
  };
}

// --- plan the writes --------------------------------------------------------
const existing = new Map(
  db.prepare("SELECT id, name, owner, kind, data, deleted_at FROM plan_targets").all().map((r) => [r.id, r])
);

const inserts = [], updates = [];
for (const r of rules) {
  const pt = toPlanTarget(r);
  const data = JSON.stringify(pt.data);
  const cur = existing.get(pt.id);
  if (!cur) { inserts.push({ ...pt, data }); continue; }
  if (!replace) continue;
  const same = cur.name === pt.name && cur.owner === pt.owner && cur.kind === pt.kind && cur.data === data && !cur.deleted_at;
  if (!same) updates.push({ ...pt, data });
}

const summary = `${inserts.length} insert(s), ${updates.length} update(s), ${rules.length - inserts.length - updates.length} unchanged`;

if (dryRun) {
  console.log(`[dry run] ${summary}`);
  for (const r of inserts) console.log(`  + ${r.id.padEnd(30)} ${String(r.data && JSON.parse(r.data).match).padEnd(26)} → ${JSON.parse(r.data).description}`);
  for (const r of updates) console.log(`  ~ ${r.id.padEnd(30)} ${JSON.parse(r.data).match.padEnd(26)} → ${JSON.parse(r.data).description}`);
  if (!replace && rules.some((r) => existing.has(r.id))) {
    console.log("  (rules that already exist are left alone — pass --replace to re-apply the file)");
  }
  process.exit(0);
}

const insert = db.prepare(
  `INSERT INTO plan_targets (id, owner, kind, name, data, created_at, updated_at, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
);
// Clearing deleted_at on --replace is deliberate and matches seed:csp: replace
// means "make the database match this file", including resurrecting a seeded
// rule someone deleted. Without --replace a deleted rule stays deleted.
const update = db.prepare(
  `UPDATE plan_targets SET owner = ?, kind = ?, name = ?, data = ?, updated_at = ?, deleted_at = NULL WHERE id = ?`
);

db.exec("BEGIN");
try {
  for (const r of inserts) insert.run(r.id, r.owner, r.kind, r.name, r.data, SEED_TS, SEED_TS);
  for (const r of updates) update.run(r.owner, r.kind, r.name, r.data, SEED_TS, r.id);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

const live = db.prepare(`SELECT COUNT(*) AS n FROM plan_targets WHERE kind = ? AND deleted_at IS NULL`).get(RULE_KIND);
console.log(`Seeded card rules: ${summary}.`);
console.log(`Now in the database: ${live.n} live \`${RULE_KIND}\` row(s).`);
if (!inserts.length && !updates.length) {
  console.log("Nothing to do — pass --replace to re-apply card-rules-seed.json over the existing rules.");
} else {
  console.log("Next: `npm run categorize:cards` to see what they would change in the ledger (dry run by default).");
}
