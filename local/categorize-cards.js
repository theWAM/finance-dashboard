// T30(b)'s bulk categorize pass: run the `card_rule` set over every card row
// already in the ledger and re-categorize what it claims, in place.
//
//   npm run categorize:cards                 dry run — print the whole plan, write nothing
//   npm run categorize:cards -- --apply      write it (takes a backup first)
//   npm run categorize:cards -- --report     just the merchant worklist, by spend
//   npm run categorize:cards -- --account=woody-apple-card   scope to one card
//
// WHY A BULK PASS AND NOT ONLY PER-ROW LEARNING IN THE REVIEW MODAL. T26b
// loaded several months × five cards by hand, so the entire training corpus is
// already sitting in the database — and this is the only cheap moment to mine
// it. Categorizing those merchants once, in bulk, produces the rules that make
// every later single-statement upload near-automatic; doing it one upload at a
// time means hand-categorizing the same merchants over and over. The ordering
// falls out of that: T26b ran long before any rule existed, its rows landed
// with whatever first-pass category the issuer gave them, and this pass
// re-categorizes them afterwards. That is the better sequence anyway — you can
// only see which merchants are worth a rule once the real data is in front of
// you.
//
// GUARDRAILS, because this edits hundreds of real rows at once:
//   · Dry run by default. `--apply` is the only thing that writes, and it takes
//     a timestamped backup (the same one `npm run backup` makes) first.
//   · Card accounts only (`type = 'credit_card'`). A rule set written from
//     statement merchant strings has no business rewriting a checking ledger
//     whose `source` column holds payees like "Direct Deposit".
//   · IDENTITY ROWS ARE NEVER TOUCHED. A row already categorized
//     `Credit Card Payment`, `Transfer`, `Interest`, `Adjustment` or
//     `Negative Balance` is skipped whatever the rules say: those categories
//     are what the transfer pairing (T34), the CSP's exclude set and T32b's
//     interest model key off, and a merchant rule turning a payment into
//     Groceries would silently break the reconciliation identity.
//   · CATEGORY ONLY. A rule's optional `source` rename is deliberately NOT
//     applied to rows that already exist — the merchant string on a loaded row
//     is what the issuer actually said, it is what `diffAgainstLedger` matches
//     a hand-entered row against, and rewriting history to read more nicely is
//     not worth that. Renames apply to NEW rows at import time.
//   · `updated_at` is stamped with the real time, not the epoch: this is a
//     genuine change to real data and it has to WIN the last-writer-wins merge
//     on the other machine.
//   · Idempotent. A second run finds nothing to do.
//
// It also prints what the rules DON'T cover, by spend. That list is the actual
// worklist — the next rule worth writing is always at the top of it.

import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";
import { RULE_KIND, compileRulesWithErrors, applyRules, ruleCoverage } from "../shared/card-rules.js";
import { merchantStem, NON_RECURRING_CATEGORIES } from "../shared/recurring.js";

const here = dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const reportOnly = process.argv.includes("--report");
const only = (process.argv.find((a) => a.startsWith("--account=")) || "").split("=")[1] || null;
const limit = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 40;

// The categories a merchant rule may never overwrite. Same set the detector
// refuses to project, and for the same reason: these are not merchant
// categories, they are structural ones.
const PROTECTED = NON_RECURRING_CATEGORIES;

const money = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const cards = db.prepare("SELECT * FROM accounts WHERE type = 'credit_card' AND deleted_at IS NULL ORDER BY id").all()
  .filter((a) => !only || a.id === only);
if (!cards.length) {
  console.error(only ? `No live credit_card account with id ${only}.` : "No credit_card accounts — nothing to categorize.");
  process.exit(1);
}
const cardIds = cards.map((c) => c.id);
const rows = db.prepare(
  `SELECT * FROM transactions WHERE deleted_at IS NULL AND account_id IN (${cardIds.map(() => "?").join(",")})`
).all(...cardIds);

const planTargets = db.prepare("SELECT * FROM plan_targets WHERE kind = ? AND deleted_at IS NULL").all(RULE_KIND)
  .map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }));
const { rules, invalid } = compileRulesWithErrors(planTargets);

console.log(`${rows.length} live row(s) across ${cards.length} card(s); ${rules.length} usable rule(s)${invalid.length ? `, ${invalid.length} unusable` : ""}.`);
for (const r of invalid) console.log(`  ✗ ${r.id}: ${r.error}`);
if (!rules.length && !reportOnly) {
  console.error("No usable `card_rule` rows — run `npm run seed:card-rules` first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// --report: the merchant worklist these decisions were made from
// ---------------------------------------------------------------------------

if (reportOnly) {
  const groups = new Map();
  for (const r of rows) {
    const k = merchantStem(r.source);
    if (!groups.has(k)) groups.set(k, { rows: 0, spend: 0, cats: new Map(), raw: new Map(), notes: new Set() });
    const g = groups.get(k);
    g.rows++;
    g.spend = round2(g.spend + (Number(r.withdrawal) || 0) - (Number(r.deposit) || 0));
    g.cats.set(r.description, (g.cats.get(r.description) || 0) + 1);
    g.raw.set(r.source, (g.raw.get(r.source) || 0) + 1);
    // The importer preserved `issuer · <raw category>` on every loaded row
    // precisely so this pass could mine it instead of re-deriving intent from
    // the merchant string alone.
    if (r.note) g.notes.add(String(r.note).replace(/ \[[^\]]*\]\s*$/, ""));
  }
  const applied = applyRules(rows, rules);
  const claimedStems = new Set(applied.filter((r) => r._rule).map((r) => merchantStem(r.source)));

  const list = [...groups.entries()].sort((a, b) => b[1].spend - a[1].spend);
  const show = (filter, title) => {
    const sel = list.filter(([k]) => filter(k)).slice(0, limit);
    console.log(`\n${title} (top ${sel.length})`);
    console.log(`  ${pad("spend", 11)}${pad("rows", 5)}${pad("categories now", 24)}${pad("merchant stem", 34)}issuer said`);
    for (const [k, g] of sel) {
      const cats = [...g.cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(" ");
      console.log(`  ${pad(money(g.spend), 11)}${pad(g.rows, 5)}${pad(cats.slice(0, 23), 24)}${pad(k.slice(0, 33), 34)}${[...g.notes].join(" / ").slice(0, 40)}`);
    }
  };
  show((k) => !claimedStems.has(k), "UNCOVERED — no rule claims these, by spend. This is the worklist.");
  show((k) => claimedStems.has(k), "COVERED by a rule");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const coverage = ruleCoverage(rows, rules);
const byId = new Map(rows.map((r) => [r.id, r]));

const changes = [];
const blocked = [];
for (const r of coverage.rows) {
  const before = byId.get(r.id);
  if (!r._rule || !r._rule.id) continue;
  if (r.description === before.description) continue;
  if (PROTECTED.has(before.description || "")) { blocked.push({ row: before, to: r.description, rule: r._rule }); continue; }
  changes.push({ row: before, from: before.description, to: r.description, rule: r._rule });
}

// Net dollar movement per category, so the plan can be read as "this much
// money moves out of Misc and into Groceries" rather than as a row count.
const delta = new Map();
const bump = (cat, amt) => delta.set(cat, round2((delta.get(cat) || 0) + amt));
for (const c of changes) {
  const amt = (Number(c.row.withdrawal) || 0) - (Number(c.row.deposit) || 0);
  bump(c.from || "(blank)", -amt);
  bump(c.to, amt);
}

console.log(`\n${changes.length} row(s) would change category; ${coverage.matched} row(s) matched a rule; ${coverage.needsCategory} row(s) remain unanswered (${money(coverage.needsCategoryAmount)}).`);

if (blocked.length) {
  console.log(`\n${blocked.length} row(s) a rule claimed but which are PROTECTED identity rows — skipped:`);
  for (const b of blocked.slice(0, 10)) {
    console.log(`  · ${b.row.txn_date} ${pad(b.row.description, 20)} ${pad(money((b.row.withdrawal || 0) - (b.row.deposit || 0)), 11)} ${b.row.source.slice(0, 40)}  (rule "${b.rule.name}" wanted ${b.to})`);
  }
  console.log("  A rule that keeps hitting these is a rule with too broad a needle — check it.");
}

if (delta.size) {
  console.log("\nNet movement by category:");
  for (const [cat, amt] of [...delta.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(cat, 22)} ${amt > 0 ? "+" : ""}${money(amt)}`);
  }
}

console.log("\nPer rule:");
for (const e of coverage.perRule) {
  const n = changes.filter((c) => c.rule.id === e.rule.id).length;
  console.log(`  ${pad(e.rule.name || e.rule.id, 26)} ${pad(e.rule.match, 26)} → ${pad(e.rule.description, 16)} ${pad(e.rows + " row(s)", 11)} ${pad(money(e.amount), 11)} ${n ? `${n} change(s)` : "already correct"}`);
}
if (coverage.unused.length) {
  console.log(`\n${coverage.unused.length} rule(s) match NOTHING in this ledger — a typo'd needle, or a merchant that never recurred:`);
  for (const r of coverage.unused) console.log(`  ? ${pad(r.name || r.id, 26)} ${r.match}`);
}

if (!apply) {
  console.log(`\n[dry run] nothing written. ${changes.length} change(s) ready — re-run with --apply.`);
  const sample = changes.slice(0, 25);
  if (sample.length) {
    console.log("\nFirst changes:");
    for (const c of sample) {
      console.log(`  ${c.row.txn_date}  ${pad(c.from, 16)} → ${pad(c.to, 16)} ${pad(money((c.row.withdrawal || 0) - (c.row.deposit || 0)), 11)} ${c.row.source.slice(0, 44)}`);
    }
    if (changes.length > sample.length) console.log(`  … and ${changes.length - sample.length} more`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------

if (!changes.length) {
  console.log("\nNothing to apply — every row the rules claim already carries that category.");
  process.exit(0);
}

// Backup before a bulk rewrite, the same shape `npm run backup` produces.
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const dir = join(here, "backups");
mkdirSync(dir, { recursive: true });
const dest = join(dir, `dashboard-pre-categorize-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
copyFileSync(join(here, "dashboard.db"), dest);
console.log(`\nBacked up → ${dest}`);

const ts = new Date().toISOString();
const update = db.prepare("UPDATE transactions SET description = ?, updated_at = ? WHERE id = ?");
db.exec("BEGIN");
try {
  for (const c of changes) update.run(c.to, ts, c.row.id);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}

console.log(`Applied ${changes.length} re-categorization(s) at ${ts}.`);
const after = db.prepare(
  `SELECT description, COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL AND account_id IN (${cardIds.map(() => "?").join(",")}) GROUP BY description ORDER BY n DESC`
).all(...cardIds);
console.log(`Card categories now: ${after.map((r) => `${r.description} ${r.n}`).join(", ")}`);
console.log("Next: `npm run check:cards`, `npm run check:csp` and `npm run check:import` — the last one is the one this pass moves.");
