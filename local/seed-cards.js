// Seed the six card accounts from the T25 inventory (TASKS.md decisions #43/#44).
// Idempotent by id: only inserts missing rows, so edits made in the app are
// preserved. `opening_balance` is left at the column default (0) here — T26b
// derives the real per-card opening from the statements and overwrites it when
// it loads each ledger; this task only establishes identity and metadata.
//
// Stamped at the epoch, same convention as the checking accounts in db.js: a
// seed must always lose to real published data in the last-writer-wins merge.

import db from "./db.js";

const SEED_TS = "1970-01-01T00:00:00.000Z";

// apr is a fraction (0.2574 = 25.74%), matching seed-plan-targets.js's convention.
// statement_day / due_day / last4 / apr below reflect the five statements the
// user supplied in ~/Downloads/Statements (2026-10-08) — see
// `update-card-statement-meta.js`, which backfilled the live DB from the same
// read since this file's own backfill only resyncs rows still stamped at the
// seed epoch. Apple Card never prints a card number, so its last4 stays null.
// `woody-chase-card`'s row below instead reflects `local/load-woody-chase.js`
// (2026-10-08) — it turned out NOT to be closed with no export; the user
// supplied a real statement + history and it is now a live, loaded ledger.
// min_payment stays null everywhere else — every stated minimum this round (Apple $310 on
// $10,238.98, Discover $343 on $17,138.92, Capital One $25 floor on $376.02)
// is balance-dependent, not a flat policy, and already tracks `minimumDue()`'s
// own 2%-or-$25-floor fallback to within a few dollars.
const CARDS = [
  {
    id: "woody-apple-card", owner: "woody", name: "Woody — Apple Card",
    data: { issuer: "Apple Card", last4: null, credit_limit: 10500, apr: 0.2549, statement_day: 31, due_day: 31, min_payment: null, source_aliases: ["Apple Card", "Vacation Apple Card"] },
  },
  {
    id: "woody-citi-card", owner: "woody", name: "Woody — Citi Card",
    data: { issuer: "Citi", last4: "3757", credit_limit: 6800, apr: 0, statement_day: 14, due_day: 10, min_payment: null, source_aliases: ["Citi Card"] },
  },
  {
    // A Disney Visa, paid off by 2026-09-03 (via, among other payments, the
    // Citi balance-transfer leg of decision #47) — but NOT closed-with-no-
    // export as originally assumed; see `local/load-woody-chase.js`.
    id: "woody-chase-card", owner: "woody", name: "Woody — Chase Card",
    data: { issuer: "Chase", last4: "9372", credit_limit: 9000, apr: 0.2649, statement_day: 23, due_day: 20, min_payment: null, source_aliases: ["Chase Card"] },
  },
  {
    // Rajna's three cards are owner: 'shared' per decision #44 — both people
    // service them, so both Credit subtabs show them (decision #24's mechanism).
    // The card is in Woody's legal name (he's the statement's primary
    // cardholder, last4 4993) with Rajna an authorized user (last4 9937) who
    // has used it exclusively for months and will keep doing so (per the
    // user, 2026-10-08) — that's a usage fact, not a reason to change `owner`
    // away from decision #44's payment-responsibility predicate.
    id: "rajna-capital-one", owner: "shared", name: "Rajna — Capital One",
    data: { issuer: "Capital One", last4: null, credit_limit: 400, apr: 0.2824, statement_day: 14, due_day: 9, min_payment: null, source_aliases: ["Capital One", "Rajna Capital One"] },
  },
  {
    // Dormant, balance-only, no purchases ever (decision #49).
    id: "rajna-chase", owner: "shared", name: "Rajna — Chase",
    data: { issuer: "Chase", last4: "1913", credit_limit: 2100, apr: 0, statement_day: 2, due_day: 27, min_payment: null, source_aliases: ["Rajna Chase"] },
  },
  {
    // `source_aliases` is TWO strings, not three. T26 originally listed
    // `"Woody Discover"` as well, citing decision #43's "there is one Discover
    // card" — but #43 resolves how many CARDS exist, not which SOURCE strings
    // are payments to one. #41 identifies `Woody Discover` (on Rajna's ledger,
    // 22 rows / $300) as the person-to-person mirror, and #44 explicitly names
    // it among the rows that STAY `Partner Transfer`. Listing it here would
    // have T34 trying to pair inter-person transfers onto a card ledger and
    // T37's assertion #3 demanding a card counterpart that does not exist.
    id: "rajna-discover", owner: "shared", name: "Rajna — Discover",
    data: { issuer: "Discover", last4: "2321", credit_limit: 25500, apr: 0.1799, statement_day: 4, due_day: 1, min_payment: null, source_aliases: ["Discover", "Rajna Discover"] },
  },
];

const existing = new Map(
  db.prepare("SELECT id, data, updated_at FROM accounts WHERE deleted_at IS NULL").all().map((r) => [r.id, r])
);
const insert = db.prepare(
  `INSERT INTO accounts (id, owner, type, name, opening_balance, data, created_at, updated_at)
   VALUES (?, ?, 'credit_card', ?, 0, ?, ?, ?)`
);
// Backfill only — `updated_at` is deliberately NOT touched, so a backfilled row
// still loses the last-writer-wins merge to real published data exactly as a
// freshly inserted seed row does.
const backfill = db.prepare("UPDATE accounts SET data = ? WHERE id = ?");

let added = 0;
let patched = 0;
db.exec("BEGIN");
try {
  for (const c of CARDS) {
    const row = existing.get(c.id);
    if (!row) {
      insert.run(c.id, c.owner, c.name, JSON.stringify(c.data), SEED_TS, SEED_TS);
      added++;
      continue;
    }
    // Fill in keys the row is MISSING, never overwrite ones it has. Insert-only
    // idempotency was not enough: `woody-apple-card` survived T26 with
    // `data = '{}'` (a casualty of that task's publish round-trip verification),
    // which silently cost it `source_aliases` — the map T34 matches inbound
    // payments against, so a missing one is a pairing failure, not cosmetics.
    let prev;
    try { prev = JSON.parse(row.data || "{}"); } catch { prev = {}; }
    const merged = { ...prev };
    let changed = false;
    // A row still stamped at the epoch has never been written by the app or by
    // a merge, so its seeded keys are safe to RE-SYNC, not just fill in — which
    // is how a correction to this file (see `rajna-discover`'s source_aliases)
    // reaches a database that already has the wrong value. Any row with a real
    // `updated_at` gets missing keys filled and nothing overwritten.
    const untouched = row.updated_at === SEED_TS;
    for (const [k, v] of Object.entries(c.data)) {
      const stale = untouched && JSON.stringify(merged[k]) !== JSON.stringify(v);
      if (!(k in merged) || stale) { merged[k] = v; changed = true; }
    }
    if (changed) { backfill.run(JSON.stringify(merged), c.id); patched++; }
  }
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
console.log(
  `Seeded ${added} card account(s); backfilled missing data keys on ${patched}; ` +
  `${CARDS.length - added - patched} already complete.`
);
