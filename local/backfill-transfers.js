// T34 — backfill `transfer_id` across the payment history that pre-dates it.
//
// An explicit, hand-run script with a dry run as the DEFAULT, printing a
// before/after balance per card — NOT a migration inside db.js. A migration
// that silently rewrites 139 payment rows and moves five card balances is a
// migration nobody can review, and getting the T26b interaction wrong in either
// direction corrupts every card balance by roughly a month of payments.
//
//   node local/backfill-transfers.js                     # dry run, every card
//   node local/backfill-transfers.js --card rajna-chase  # dry run, one card
//   node local/backfill-transfers.js --card rajna-chase --commit
//   node local/backfill-transfers.js --revert <batch>    # undo one run
//   node local/backfill-transfers.js --window 10         # pairing date tolerance
//   node local/backfill-transfers.js --json              # machine-readable report
//   node local/backfill-transfers.js --audit             # READ-ONLY: assert the invariant
//
// WHAT IT DOES, per card, to each checking-side `Credit Card Payment` row whose
// `source` the card claims in `data.source_aliases`:
//
//   inside  data.seeded_range   →  PAIR it to the statement row T26b already
//                                  imported. Never mirror: the card-side row
//                                  exists, so a mirror makes it exist twice.
//   after   the reconciliation anchor (data.statements.as_of)
//                              →  MIRROR a card-side row. These are future-
//                                  dated projections on both sides, which is
//                                  correct and is the point of doing it.
//   at or before the anchor, outside the seeded range
//                              →  SKIP, reported. The payment is already
//                                  absorbed into the DERIVED opening_balance,
//                                  so mirroring double-counts it just as badly
//                                  as mirroring inside the seeded range. The
//                                  task's "mirror only payments outside the
//                                  seeded range" does not cover this case; the
//                                  real data has 12 such rows across two cards.
//
// IDEMPOTENT: a checking row that already carries a `transfer_id` is skipped
// outright, and every group key is DERIVED from the checking row's own id
// (`tr-<uuid>`), so a second run computes the same keys and pairs nothing twice.
// Every row it writes carries `import_batch` so one run is revertable as a unit.
//
// PAIRING IS NOT 1:1. One $888.12 checking withdrawal to Apple arrives on the
// card as four rows ($73.12 + $45.00 + $504.00 + $266.00); `transfer_id` is a
// group key, so that is five rows under one key netting to zero. The matcher
// therefore runs exact 1:1 first (strongest evidence), then bounded subset-sum,
// and accepts a subset ONLY when the solution is unique.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { accountBalance } from "../shared/metrics.js";
import {
  PAYMENT_CATEGORY, auditTransfers, cardAliasIndex, cardForSource, dayGap,
  magnitude, mirrorDraft, seededGuard, signed, transferKind,
  KNOWN_UNPAIRED, unexpectedUnpaired, staleKnownUnpaired,
} from "../shared/transfers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? ""; };
const COMMIT = argv.includes("--commit");
const JSON_OUT = argv.includes("--json");
const ONLY_CARD = flag("--card");
const REVERT = flag("--revert");
const AUDIT = argv.includes("--audit");
const AT = flag("--at") || new Date().toISOString();
// ±10 days. Not a guess: the widest pairing the real corpus actually needs is
// Rajna's Chase 2026-09-17 → 2026-09-27, and decision #44 records that card as
// five-of-five exact amount matches, so 10 is the floor that keeps all five.
// Loosening it further is what turned a $750.00 Apple payment into a match 75
// days away in the first draft of this matcher.
const WINDOW = Number(flag("--window") || 10);

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(10);
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));
const cents = (n) => Math.round(n * 100);
const say = (...a) => { if (!JSON_OUT) console.log(...a); };

const db = new DatabaseSync(join(ROOT, "local", "dashboard.db"));
const loadAccounts = () =>
  db.prepare("SELECT * FROM accounts WHERE deleted_at IS NULL").all()
    .map((a) => ({ ...a, data: (() => { try { return JSON.parse(a.data || "{}"); } catch { return {}; } })() }));
const loadLive = () => db.prepare("SELECT * FROM transactions WHERE deleted_at IS NULL").all();

// ---------------------------------------------------------------------------
// --revert
// ---------------------------------------------------------------------------

if (REVERT) {
  // What a run is undone FROM: the mirrors it inserted carry `import_batch`,
  // and the groups it created are listed on each card's
  // `data.transfer_backfill.transfer_ids`. Nothing is recovered from `note` —
  // see the comment on the write path for why that field is left alone.
  const mirrors = db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch = ?").get(REVERT).c;
  const ids = new Set();
  for (const a of loadAccounts()) {
    const tb = a.data.transfer_backfill;
    if (tb?.batch === REVERT) for (const t of tb.transfer_ids || []) ids.add(t);
  }
  if (!mirrors && !ids.size) {
    console.log(`Nothing recorded for batch '${REVERT}'. Nothing to revert.`);
    process.exit(1);
  }
  if (!COMMIT) {
    console.log(`Would hard-delete ${mirrors} mirrored row(s) and clear transfer_id on the rows in ${ids.size} group(s).`);
    console.log(`Re-run with --commit.`);
    process.exit(0);
  }
  const ts = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM transactions WHERE import_batch = ?").run(REVERT);
    const clear = db.prepare("UPDATE transactions SET transfer_id = NULL, updated_at = ? WHERE transfer_id = ?");
    for (const t of ids) clear.run(ts, t);
    for (const a of loadAccounts()) {
      if (a.data.transfer_backfill?.batch !== REVERT) continue;
      const { transfer_backfill, ...rest } = a.data;
      db.prepare("UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(rest), ts, a.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  console.log(`Reverted batch '${REVERT}': removed ${mirrors} mirror(s), unlinked ${ids.size} group(s).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The residual, enumerated
// ---------------------------------------------------------------------------
//
// T34's "done when" asks for ZERO unpaired payments. That is not reachable
// without inventing data, and inventing data is the failure this whole task is
// built to avoid — so the residual is enumerated instead, every row with the
// reason it cannot be paired. Three kinds, and they need three different
// things to clear:
//
//  (a) ~~`no-anchor` — `woody-chase-card`~~ **RESOLVED 2026-10-08.** The user
//      supplied a statement PDF and `Woody_Chase.csv`
//      (`local/load-woody-chase.js`), which anchored a real opening balance
//      of $7,567.17 — not the $6,068.99-plus-transfer guess this comment used
//      to carry, which assumed a $750.00 payment that the real data shows was
//      $567.17. Three of the five rows now pair exactly (below); the other
//      two move to group (c) as genuine in-window amount/date mismatches.
//
//  (b) `pre-anchor` — `rajna-discover`, 7 rows, $3,373.00, all 2026-01-05 →
//      2026-03-03, i.e. before its export begins. Already absorbed into the
//      DERIVED `opening_balance` (#50), so pairing them would double-count
//      them. These are correct as unpaired and will stay that way; they are
//      the one group that needs nothing.
//
//  (c) `in-window` — rows across five cards now, where the card side exists
//      but does not match. Several are near-misses the loader can see and
//      will not guess at: $750.00 against a $759.75 Apple row (off $9.75) AND
//      separately against Chase's real $567.17 payment on the very same date
//      (off $182.83 — two different cards, two different reasons, one
//      coincidental amount), $779.00 against $779.11, $856.17 against
//      $850.00, $303.00 against $303.66, $78.00 against $86.56. Chase's
//      second row ($250.00 on 2026-04-14) has no near-miss at all within the
//      window — the real card-side $250.00 payment landed 12 days earlier
//      (2026-04-02), one day outside this script's own ±10 day tolerance.
//      These are the ones a human can actually resolve, one look each, and
//      the ⚠ badge in the Ledger is how they surface.
// Moved to shared/transfers.js (KNOWN_UNPAIRED + unexpectedUnpaired/
// staleKnownUnpaired) so --audit here and T37's check-cards.js assert against
// the exact same list and the exact same tolerance, rather than two copies
// that can drift apart one entry at a time.

// ---------------------------------------------------------------------------
// --audit — the invariant, read-only
// ---------------------------------------------------------------------------
//
// T34's "done when" defers the standing assertion to T37's check-cards.js.
// This flag makes the same assertion runnable TODAY, against the live DB and
// through the identical `auditTransfers` the UI badges from, so the invariant
// is not resting on a checker that does not exist yet. T37 absorbs it by
// calling `auditTransfers` directly — the KNOWN_UNPAIRED list below is the set
// it must adopt as enumerated exceptions rather than delete the assertion over.
if (AUDIT) {
  const accts = loadAccounts();
  const txns = loadLive();
  const a = auditTransfers({ transactions: txns, accounts: accts });
  const byId = new Map(accts.map((x) => [x.id, x]));
  const label = (u) => `${u.row.txn_date} ${money(signed(u.row))} ${byId.get(u.row.account_id)?.name} → ${u.row.source}`;

  console.log(`${"═".repeat(86)}`);
  console.log(`T34 — paired-transfer audit (read-only)`);
  console.log(`${"═".repeat(86)}`);
  console.log(`  groups ${a.groups.size}   paired rows ${a.paired.length}`);
  const hard = [
    ["mismatched groups (a pair whose ends disagree)", a.mismatched.length],
    ["same-date/amount unlinked PAYMENT pairs on one card (T37 #8)", a.doubleRisk.length],
    ["alias collisions (two cards claiming one source string)", a.aliasCollisions.length],
  ];
  for (const [what, n] of hard) console.log(`  ${n === 0 ? "✅" : "✗ "} ${what}: ${n}`);
  console.log(`  ·  card-side-only rows — VALID, decision #48: ${a.soloCardSide.length}`);
  console.log(`  ·  checking-side inflows with no card leg — not money leaving: ${a.soloInflow.length}`);
  console.log(`  ·  duplicate same-day charges — informational, genuine data: ${a.duplicateCharges.length}`);

  console.log(`\n  unpaired checking-side outflows — the only asymmetric error (#48): ${a.unpairedOutflow.length}`);
  const unexpected = unexpectedUnpaired(a.unpairedOutflow);
  for (const u of a.unpairedOutflow) {
    const known = !unexpected.includes(u);
    console.log(`     ${known ? "·" : "✗"} ${label(u)}${known ? "" : "   ← NOT in the known-exceptions list"}`);
  }
  console.log(`\n  ${unexpected.length === 0 ? "✅" : "✗ "} every unpaired outflow is one of the ${KNOWN_UNPAIRED.length} enumerated, explained exceptions`);
  const stale = staleKnownUnpaired(a.unpairedOutflow);
  // A stale exception is as much a bug as a missing one: it means the list is
  // being carried forward past the thing it excused.
  console.log(`  ${stale.length === 0 ? "✅" : "⚠ "} no stale exceptions (rows that have since been paired): ${stale.length}`);
  for (const k of stale) console.log(`     ⚠  ${k.date} $${k.amount.toFixed(2)} ${k.source} — now paired; drop it from KNOWN_UNPAIRED`);

  const bad = a.mismatched.length + a.doubleRisk.length + a.aliasCollisions.length + unexpected.length;
  console.log(`\n${"─".repeat(86)}`);
  console.log(bad === 0 ? "✅ T34 AUDIT PASSED" : `✗ T34 AUDIT FAILED — ${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Exact 1:1 amount matches inside ±WINDOW days, assigned by SMALLEST date gap
 * first across the whole card rather than row-by-row in date order.
 *
 * The ordering matters and it is not cosmetic. Rajna's Chase has four $40.00
 * payments whose amounts cannot disambiguate them; walking the checking rows in
 * date order and taking the nearest free candidate mispairs the last two.
 * Taking the globally tightest gap first reproduces decision #44's documented
 * 5-of-5 exactly.
 */
function matchOneToOne(anchors, pool) {
  const edges = [];
  for (const a of anchors) {
    for (const p of pool) {
      if (cents(magnitude(a.row)) !== cents(magnitude(p))) continue;
      const gap = dayGap(a.row.txn_date, p.txn_date);
      if (Math.abs(gap) > WINDOW) continue;
      edges.push({ a, p, gap });
    }
  }
  edges.sort((x, y) => Math.abs(x.gap) - Math.abs(y.gap) || (x.a.row.txn_date < y.a.row.txn_date ? -1 : 1));
  const usedA = new Set(), usedP = new Set();
  const out = [];
  for (const e of edges) {
    if (usedA.has(e.a.row.id) || usedP.has(e.p.id)) continue;
    usedA.add(e.a.row.id); usedP.add(e.p.id);
    out.push({ anchor: e.a, peers: [e.p], gaps: [e.gap], how: `1:1 (${e.gap >= 0 ? "+" : ""}${e.gap}d)` });
  }
  return out;
}

/**
 * Bounded subset-sum: one checking row against 2..4 card rows inside the window
 * that sum to it exactly. Accepted ONLY when the solution is unique — two ways
 * to make $888.12 out of the same pile is not evidence, it is a coin flip, and
 * a coin flip here writes a wrong `transfer_id` that T37 then certifies as
 * correctly paired.
 */
function matchSubsets(anchors, pool) {
  const out = [];
  const used = new Set();
  for (const a of anchors) {
    const target = cents(magnitude(a.row));
    if (!target) continue;
    const cand = pool
      .filter((p) => !used.has(p.id) && Math.abs(dayGap(a.row.txn_date, p.txn_date)) <= WINDOW && cents(magnitude(p)) <= target)
      .slice(0, 20); // keeps the enumeration below ~5k combinations
    const found = [];
    const walk = (start, picked, total) => {
      if (found.length > 1) return;                 // already ambiguous — stop
      if (picked.length >= 2 && total === target) { found.push([...picked]); return; }
      if (picked.length >= 4 || total >= target) return;
      for (let i = start; i < cand.length; i++) {
        picked.push(cand[i]);
        walk(i + 1, picked, total + cents(magnitude(cand[i])));
        picked.pop();
        if (found.length > 1) return;
      }
    };
    walk(0, [], 0);
    if (found.length !== 1) {
      if (found.length > 1) a.ambiguous = true;
      continue;
    }
    const peers = found[0];
    for (const p of peers) used.add(p.id);
    const gaps = peers.map((p) => dayGap(a.row.txn_date, p.txn_date));
    out.push({ anchor: a, peers, gaps, how: `1:${peers.length} split (${peers.map((p) => p.txn_date).join(", ")})` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const accounts = loadAccounts();
const live = loadLive();
const accountById = new Map(accounts.map((a) => [a.id, a]));
const { index: aliasIndex, collisions } = cardAliasIndex(accounts);
const cards = accounts.filter((a) => a.type === "credit_card")
  .filter((a) => !ONLY_CARD || a.id === ONLY_CARD)
  .sort((a, b) => (a.id < b.id ? -1 : 1));

if (ONLY_CARD && !cards.length) {
  console.error(`No credit_card account with id '${ONLY_CARD}'.`);
  process.exit(1);
}

const BATCH = `t34-backfill-${AT}`;
const plan = [];     // { card, pairs:[{anchor,peers,how}], mirrors:[{row,draft}], skipped:[...] }
let fatal = false;

say(`${"═".repeat(86)}`);
say(`T34 — paired-transfer backfill  ${COMMIT ? "[COMMIT]" : "[dry run]"}`);
say(`batch:  ${BATCH}`);
say(`window: ±${WINDOW} days for amount-equal pairing`);
say(`${"═".repeat(86)}`);

if (collisions.length) {
  fatal = true;
  say(`\n✗ ALIAS COLLISIONS — two cards claim one source string. Fix the seed before running:`);
  for (const c of collisions) say(`   "${c.alias}" → ${c.cards.join(", ")}`);
}

for (const card of cards) {
  // Every checking-side row this card claims, oldest first.
  const claimed = live
    .filter((t) => {
      const acct = accountById.get(t.account_id);
      if (!acct || acct.type === "credit_card") return false;
      if (!transferKind(t, acct)) return false;      // skips $0.00 placeholders
      return cardForSource(aliasIndex, t.source)?.id === card.id;
    })
    .sort((a, b) => (a.txn_date < b.txn_date ? -1 : 1));

  const zeros = live.filter((t) => {
    const acct = accountById.get(t.account_id);
    return acct && acct.type !== "credit_card" && t.description === PAYMENT_CATEGORY
      && magnitude(t) < 0.005 && cardForSource(aliasIndex, t.source)?.id === card.id;
  });

  const already = claimed.filter((t) => t.transfer_id);
  const todo = claimed.filter((t) => !t.transfer_id);

  // Partition by what the card's own reconciliation allows at that date.
  const zoned = todo.map((row) => ({ row, guard: seededGuard(card, row.txn_date) }));
  const toPair = zoned.filter((z) => z.guard.zone === "seeded");
  const toMirror = zoned.filter((z) => z.guard.ok);
  const toSkip = zoned.filter((z) => !z.guard.ok && z.guard.zone !== "seeded");

  // The candidate pool on the card side: live, unpaired, and carrying the sign
  // the counterpart of a checking payment must have. Split by direction so an
  // outflow can never pair with a card charge.
  const cardRows = live.filter((t) => t.account_id === card.id && !t.transfer_id && magnitude(t) >= 0.005);
  const poolIn = cardRows.filter((t) => signed(t) < 0 && t.description === PAYMENT_CATEGORY); // deposits = debt down
  const poolOut = cardRows.filter((t) => signed(t) > 0);                                      // withdrawals = debt up

  const anchorsOut = toPair.filter((z) => signed(z.row) > 0);
  const anchorsIn = toPair.filter((z) => signed(z.row) < 0);

  const pairs = [
    ...matchOneToOne(anchorsOut, poolIn),
    ...matchOneToOne(anchorsIn, poolOut),
  ];
  const pairedAnchors = new Set(pairs.map((m) => m.anchor.row.id));
  const pairedPeers = new Set(pairs.flatMap((m) => m.peers.map((p) => p.id)));
  pairs.push(
    ...matchSubsets(anchorsOut.filter((z) => !pairedAnchors.has(z.row.id)), poolIn.filter((p) => !pairedPeers.has(p.id))),
    ...matchSubsets(anchorsIn.filter((z) => !pairedAnchors.has(z.row.id)), poolOut.filter((p) => !pairedPeers.has(p.id))),
  );
  for (const m of pairs) { pairedAnchors.add(m.anchor.row.id); m.peers.forEach((p) => pairedPeers.add(p.id)); }

  const unmatched = toPair.filter((z) => !pairedAnchors.has(z.row.id));
  const mirrors = toMirror.map((z) => ({
    row: z.row,
    transfer_id: `tr-${z.row.id}`,
    draft: mirrorDraft(z.row, {
      fromAccount: accountById.get(z.row.account_id),
      toAccount: card,
      transferId: `tr-${z.row.id}`,
      note: `mirrored from ${accountById.get(z.row.account_id)?.name || z.row.account_id} [${BATCH}]`,
    }),
  }));

  plan.push({ card, claimed, already, pairs, mirrors, unmatched, toSkip, zeros, poolIn, poolOut, pairedPeers });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

// Balances BEFORE, computed through production `accountBalance()` over the rows
// exactly as they sit in the DB — not through this script's own arithmetic.
const balBefore = new Map(accounts.map((a) => [a.id, accountBalance(live, a)]));

let totalPairs = 0, totalMirrors = 0, totalSkipped = 0, totalUnmatched = 0;

for (const p of plan) {
  const { card } = p;
  const g = seededGuard(card, "9999-12-31");
  say(`\n${"═".repeat(86)}`);
  say(`${card.id}  —  ${card.name}`);
  say(`${"═".repeat(86)}`);
  say(`  seeded_range ${card.data.seeded_range ? card.data.seeded_range.join(" → ") : "(none)"}`
    + `   anchor ${g.anchor || "(none)"}`);
  say(`  checking-side rows claimed: ${p.claimed.length}`
    + `  (already paired ${p.already.length}, $0.00 placeholders skipped ${p.zeros.length})`);

  if (p.pairs.length) {
    say(`\n  PAIR — inside the imported window, so the card-side row already exists:`);
    for (const m of p.pairs.sort((a, b) => (a.anchor.row.txn_date < b.anchor.row.txn_date ? -1 : 1))) {
      say(`   ${m.anchor.row.txn_date} ${money(signed(m.anchor.row))}  ${m.how}`);
      for (const q of m.peers) say(`        ↔ ${q.txn_date} ${money(signed(q))}  ${String(q.source).slice(0, 52)}`);
    }
  }
  if (p.unmatched.length) {
    say(`\n  ⚠ UNPAIRED — inside the imported window but no card-side row matches.`);
    say(`     Mirroring these would double-count them, so they are left unpaired and auditable:`);
    for (const z of p.unmatched) {
      // Name the nearest near-miss, because "no match" plus a $0.11 gap three
      // days away is a data-entry question a human can answer in one look.
      const near = p[signed(z.row) > 0 ? "poolIn" : "poolOut"]
        .filter((q) => !p.pairedPeers.has(q.id) && Math.abs(dayGap(z.row.txn_date, q.txn_date)) <= WINDOW)
        .sort((a, b) => Math.abs(magnitude(a) - magnitude(z.row)) - Math.abs(magnitude(b) - magnitude(z.row)))[0];
      say(`   ${z.row.txn_date} ${money(signed(z.row))}  ${String(z.row.source).slice(0, 30)}`
        + (near ? `   nearest card row ${near.txn_date} ${money(signed(near))} (off ${money(round2(magnitude(near) - magnitude(z.row)))})` : "   no card row within the window")
        + (z.ambiguous ? `   [subset-sum was AMBIGUOUS — more than one way to make this total]` : ""));
    }
  }
  if (p.mirrors.length) {
    const t = sum(p.mirrors.map((m) => magnitude(m.row)));
    const dates = p.mirrors.map((m) => m.row.txn_date).sort();
    say(`\n  MIRROR — after the anchor, so both ends are projections (${p.mirrors.length} rows, ${money(t)}, ${dates[0]} → ${dates[dates.length - 1]}):`);
    for (const m of p.mirrors.slice(0, 8)) say(`   ${m.row.txn_date} ${money(signed(m.row))} → card ${m.draft.deposit ? "deposit" : "withdrawal"} ${money(m.draft.deposit || -m.draft.withdrawal)}`);
    if (p.mirrors.length > 8) say(`   … and ${p.mirrors.length - 8} more`);
  }
  if (p.toSkip.length) {
    const t = sum(p.toSkip.map((z) => magnitude(z.row)));
    say(`\n  SKIP — ${p.toSkip.length} row(s), ${money(t)}. Not mirrored, on purpose:`);
    const byWhy = new Map();
    for (const z of p.toSkip) {
      const k = z.guard.zone;
      if (!byWhy.has(k)) byWhy.set(k, []);
      byWhy.get(k).push(z);
    }
    for (const [zone, zs] of byWhy) {
      say(`   ${zone}: ${zs.length} row(s) ${zs[0].guard.why}`);
      for (const z of zs) say(`      ${z.row.txn_date} ${money(signed(z.row))}  ${String(z.row.source).slice(0, 30)}`);
    }
  }

  // Before/after balance for the card, which is the whole point of the dry run:
  // only MIRRORS move a balance. Pairing stamps a key and moves nothing, and
  // that invariant is asserted below rather than asserted in prose.
  const before = balBefore.get(card.id);
  const delta = sum(p.mirrors.map((m) => (m.draft.deposit || 0) - (m.draft.withdrawal || 0)));
  const after = round2(before + delta);
  say(`\n  balance  before ${money(before)}  (debt ${money(-before)})`);
  say(`           mirrors ${money(delta)}`);
  say(`           after  ${money(after)}  (debt ${money(-after)})`);
  if (Math.abs(delta) > 0.005 && p.mirrors.every((m) => m.row.txn_date > (seededGuard(card, "9999-12-31").anchor || "")))
    say(`           every mirrored row is dated after the anchor, so TODAY's debt is unchanged.`);

  p._before = before; p._after = after; p._delta = delta;
  totalPairs += p.pairs.length; totalMirrors += p.mirrors.length;
  totalSkipped += p.toSkip.length; totalUnmatched += p.unmatched.length;
}

// --- household rollup ------------------------------------------------------

const cardAccts = accounts.filter((a) => a.type === "credit_card");
const debtBefore = sum(cardAccts.map((a) => -balBefore.get(a.id)));
const debtAfter = sum(cardAccts.map((a) => {
  const p = plan.find((x) => x.card.id === a.id);
  return -(p ? p._after : balBefore.get(a.id));
}));
// Debt AS OF a date, which after this backfill is the only reading that means
// anything. `accountBalance()` over the whole ledger now runs past every
// mirrored future payment, so a card's all-dates balance is its PROJECTED
// end-state, not its balance. Mirrors are all post-anchor, so the as-of figure
// must come out byte-identical before and after — that is check (4).
const TODAY = new Date().toISOString().slice(0, 10);
const debtAsOf = (txns, on) => sum(cardAccts.map((a) => -accountBalance(txns.filter((t) => t.txn_date <= on), a)));
// The plan applied in memory, so "after" is measured rather than predicted.
const projected = [
  ...live,
  ...plan.flatMap((p) => p.mirrors.map((m) => ({ ...m.draft, id: `plan-${m.transfer_id}`, deleted_at: null, created_at: AT }))),
];

say(`\n${"═".repeat(86)}`);
say(`household`);
say(`${"═".repeat(86)}`);
say(`  pairs ${totalPairs}   mirrors ${totalMirrors}   skipped ${totalSkipped}   unpaired-in-window ${totalUnmatched}`);
say(`  card debt as of ${TODAY}:  before ${money(debtAsOf(live, TODAY))}  after ${money(debtAsOf(projected, TODAY))}`);
say(`  card debt, ALL dates:      before ${money(debtBefore)}  after ${money(debtAfter)}  (Δ ${money(round2(debtAfter - debtBefore))})`);
if (cards.length === cardAccts.length && Math.abs(debtAfter - debtBefore) > 0.005) {
  say(``);
  say(`  ⚠ READ THAT SECOND LINE WITH CARE, AND PASS IT TO T27/T32b/T35.`);
  say(`    The all-dates drop is ${money(round2(debtBefore - debtAfter))} and it is NOT a forecast. The checking`);
  say(`    ledger carries planned PAYMENTS out to 2027-07 and the cards carry no planned`);
  say(`    CHARGES, so mirroring the payments produces the paydown half of a projection`);
  say(`    with no spending half. It is the right thing to write — both ends of a real`);
  say(`    planned movement — but it means an unbounded \`accountBalance()\` on a card is`);
  say(`    now a projected end-state. \`cardDebt()\` must take an as-of date and default`);
  say(`    it to today, or T35's debt tile reads ${money(debtAfter)} instead of ${money(debtBefore)}.`);
}

// ---------------------------------------------------------------------------
// Checks that can fail
// ---------------------------------------------------------------------------

const checks = [];
const check = (ok, label, detail = "") => { checks.push({ ok, label, detail }); if (!ok) fatal = true; };

// (1) Pairing writes no money. A pair stamps a key on rows that already exist.
for (const p of plan) {
  const moved = sum(p.pairs.flatMap((m) => [signed(m.anchor.row), ...m.peers.map(signed)]));
  check(Math.abs(moved) < 0.005, `${p.card.id}: every paired group nets to zero`, `net ${money(moved)}`);
}
// (2) No mirror lands on or before its card's anchor, nor inside seeded_range.
for (const p of plan) {
  const bad = p.mirrors.filter((m) => !seededGuard(p.card, m.row.txn_date).ok);
  check(bad.length === 0, `${p.card.id}: no mirror inside the reconciled window`, `${bad.length} would`);
}
// (3) One card-side row is never claimed by two groups.
const peerIds = plan.flatMap((p) => p.pairs.flatMap((m) => m.peers.map((q) => q.id)));
check(new Set(peerIds).size === peerIds.length, `no card-side row is claimed by two groups`, `${peerIds.length} claims, ${new Set(peerIds).size} distinct`);
// (4) The reconciled picture is untouched. Two parts, because they fail
//     differently: the as-of-today figure must not move AT ALL (a mirror that
//     landed in a reconciled month would move it), and the all-dates figure
//     must have started where T26b left it (if it did not, something else
//     already moved the ledger and this run's "after" means nothing).
check(Math.abs(debtAsOf(projected, TODAY) - debtAsOf(live, TODAY)) < 0.005,
  `card debt as of ${TODAY} is unchanged by the plan`,
  `${money(debtAsOf(live, TODAY))} → ${money(debtAsOf(projected, TODAY))}`);
// The T26b baseline is a PRE-condition, not an invariant: the all-dates figure
// legitimately moves to the projected end-state the moment the mirrors land, so
// asserting the literal on every run would make the second run fail — and a
// failing check refuses to write, which would turn idempotency into an error.
// Checked only before this backfill has ever run.
const alreadyRun = plan.some((p) => p.card.data.transfer_backfill);
if (alreadyRun) {
  checks.push({ ok: true, label: `all-dates card debt baseline`, detail: `skipped — a backfill already ran (${plan.find((p) => p.card.data.transfer_backfill).card.data.transfer_backfill.batch})` });
} else {
  check(cards.length !== cardAccts.length || Math.abs(debtBefore - 36314.92) < 0.005,
    `all-dates card debt started at T26b's $36,314.92`, money(debtBefore));
}
// (5) Idempotency, stated as a property of the plan rather than a promise:
//     nothing already carrying a transfer_id is in it.
check(plan.every((p) => p.already.every((t) => !p.mirrors.some((m) => m.row.id === t.id) && !p.pairs.some((m) => m.anchor.row.id === t.id))),
  `already-paired rows are excluded from the plan`, `${plan.reduce((n, p) => n + p.already.length, 0)} already paired`);

say(`\n  checks:`);
for (const c of checks) say(`   ${c.ok ? "✅" : "✗ "} ${c.label}${c.detail ? `   ${c.detail}` : ""}`);

if (JSON_OUT) {
  console.log(JSON.stringify({
    batch: BATCH, commit: COMMIT, window: WINDOW,
    cards: plan.map((p) => ({
      id: p.card.id, pairs: p.pairs.length, mirrors: p.mirrors.length,
      skipped: p.toSkip.length, unmatched: p.unmatched.length,
      balance_before: p._before, balance_after: p._after,
      unmatched_rows: p.unmatched.map((z) => ({ date: z.row.txn_date, amount: signed(z.row), source: z.row.source })),
      skipped_rows: p.toSkip.map((z) => ({ date: z.row.txn_date, amount: signed(z.row), zone: z.guard.zone })),
    })),
    totals: { pairs: totalPairs, mirrors: totalMirrors, skipped: totalSkipped, unmatched: totalUnmatched },
    checks,
  }, null, 2));
}

const nothingToDo = totalPairs === 0 && totalMirrors === 0;
if (!COMMIT) {
  say(`\n${"─".repeat(86)}`);
  if (fatal) say("✗ checks failed — nothing would be written");
  else if (nothingToDo) say(`✅ nothing to do — every claimed row is already paired or deliberately skipped. Re-running pairs nothing twice.`);
  else say(`✅ checks passed — re-run with --commit to write ${totalMirrors} mirror(s) and ${totalPairs} pairing(s)`);
  process.exit(fatal ? 1 : 0);
}
if (nothingToDo && !fatal) {
  console.log(`\n✅ nothing to do — every claimed row is already paired or deliberately skipped. No write.`);
  process.exit(0);
}
if (fatal) {
  console.error(`\n✗ refusing to write: a check failed above.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write — one transaction for the whole run
// ---------------------------------------------------------------------------

const ts = new Date().toISOString();
const insert = db.prepare(`INSERT INTO transactions
  (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, transfer_id, external_id, import_batch, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stampTransfer = db.prepare("UPDATE transactions SET transfer_id = ?, updated_at = ? WHERE id = ?");
const setAccountData = db.prepare("UPDATE accounts SET data = ?, updated_at = ? WHERE id = ?");

let wroteMirrors = 0, wrotePairs = 0, stampedRows = 0;
db.exec("BEGIN");
try {
  for (const p of plan) {
    const transferIds = [];
    for (const m of p.pairs) {
      const key = `tr-${m.anchor.row.id}`;
      // `transfer_id` ONLY. The first version of this also appended the batch
      // id to each row's `note` so --revert could find them, which rewrote the
      // note on 170 rows the user owns (and clobbered T26b's "Citi · Cleared").
      // A bookkeeping marker does not belong in a user-editable field — the
      // group keys are recorded on the card's `data` instead, below.
      for (const row of [m.anchor.row, ...m.peers]) { stampTransfer.run(key, ts, row.id); stampedRows++; }
      transferIds.push(key);
      wrotePairs++;
    }
    for (const m of p.mirrors) {
      const d = m.draft;
      insert.run(
        randomUUID(), d.account_id, d.owner, d.txn_date, d.description, d.source,
        d.deposit, d.withdrawal, d.note, d.transfer_id, null, BATCH, ts, ts,
      );
      // The checking row is the group's other end and needs the same key.
      stampTransfer.run(d.transfer_id, ts, m.row.id);
      transferIds.push(d.transfer_id);
      wroteMirrors++;
    }
    // Persisted so every card's post-backfill balance stays explained after
    // this run's console output is gone — the same reason T37 assertion #6
    // needs `data.statements` on the row rather than in a terminal scrollback.
    const mirrored = p.mirrors.map((m) => m.row.txn_date).sort();
    const data = {
      ...p.card.data,
      transfer_backfill: {
        task: "T34", batch: BATCH, at: ts, window: WINDOW,
        paired: p.pairs.length, mirrored: p.mirrors.length,
        skipped: p.toSkip.length, unpaired_in_window: p.unmatched.length,
        mirror_range: mirrored.length ? [mirrored[0], mirrored[mirrored.length - 1]] : null,
        balance_before: p._before, balance_after: p._after,
        // Every group key this run created on this card. This is what --revert
        // reads, and it is why nothing has to be smuggled into `note`.
        transfer_ids: transferIds,
      },
    };
    setAccountData.run(JSON.stringify(data), ts, p.card.id);
  }
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('dirty', '1')").run();
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

// --- post-write audit, re-read from the database ---------------------------

const after = loadLive();
const afterAccounts = loadAccounts();
const audit = auditTransfers({ transactions: after, accounts: afterAccounts });
console.log(`\n${"─".repeat(86)}`);
console.log(`✅ wrote ${wroteMirrors} mirror(s), stamped ${stampedRows} row(s) into ${wrotePairs} pairing(s).`);
console.log(`   batch ${BATCH}   (undo: node local/backfill-transfers.js --revert ${BATCH} --commit)`);
console.log(`\npost-write audit (re-read from dashboard.db):`);
console.log(`   groups ${audit.groups.size}   paired rows ${audit.paired.length}`);
console.log(`   ${audit.unpairedOutflow.length === 0 ? "✅" : "⚠ "} unpaired checking-side outflows: ${audit.unpairedOutflow.length}`);
console.log(`   ${audit.mismatched.length === 0 ? "✅" : "✗ "} mismatched groups: ${audit.mismatched.length}`);
console.log(`   ${audit.doubleRisk.length === 0 ? "✅" : "✗ "} same-date/amount unlinked payment pairs on one card: ${audit.doubleRisk.length}`);
console.log(`   ·  card-side-only rows (valid, decision #48): ${audit.soloCardSide.length}`);
console.log(`   ·  card debt as of ${TODAY}: ${money(debtAsOf(after, TODAY))}   (all dates ${money(sum(cardAccts.map((a) => -accountBalance(after, a))))})`);
if (audit.unpairedOutflow.length) {
  console.log(`\n   the residual unpaired outflows, which T37 assertion #3 will see:`);
  for (const u of audit.unpairedOutflow) console.log(`      ${u.row.txn_date} ${money(signed(u.row))}  ${u.account.name} → ${u.row.source}`);
}
