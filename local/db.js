// SQLite connection + schema for the local authoring app.
//
// The database is the single source of truth on each person's machine. It is
// intentionally NOT committed (see .gitignore); the committed, public bridge
// between the two people's databases is data/snapshot.json.
//
// Every user-editable row carries the sync metadata required for the
// per-record last-writer-wins merge described in the README:
//   - id         stable identifier, shared across both machines
//   - created_at / updated_at   ISO-8601 UTC timestamps
//   - deleted_at ISO-8601 UTC tombstone (NULL = live row)

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "dashboard.db");

// Uses Node's built-in SQLite (node:sqlite) — no native module to compile.
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  -- Ledger: one row per deposit/withdrawal. Running balance is COMPUTED, not stored.
  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    txn_date    TEXT NOT NULL,              -- ISO date (YYYY-MM-DD)
    description TEXT NOT NULL DEFAULT '',    -- category, e.g. Paycheck / Bill / Credit Card Payment
    source      TEXT NOT NULL DEFAULT '',    -- Source/Recipient, e.g. Apple Card, Direct Deposit
    deposit     REAL NOT NULL DEFAULT 0,     -- money in (+)
    withdrawal  REAL NOT NULL DEFAULT 0,     -- money out (-)
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT                          -- tombstone; NULL = live
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
  CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at);

  -- Plan targets: the strategy migrated out of fin_plan.html into editable data.
  -- 'kind' distinguishes debt_payoff / savings_goal / investment_cadence / income / coast_fire.
  -- 'data' is a JSON blob of kind-specific fields (e.g. balance, apr, monthly_payment, target_date).
  CREATE TABLE IF NOT EXISTS plan_targets (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL DEFAULT '{}',   -- JSON
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plan_targets_updated ON plan_targets(updated_at);

  -- Key/value store for local sync bookkeeping (versions, last pull/publish timestamps, device id).
  CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Seed default sync bookkeeping the first time the DB is created.
const seedMeta = db.prepare(
  "INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)"
);
seedMeta.run("schema_version", "1");
seedMeta.run("local_version", "0");
seedMeta.run("last_pulled_version", "0");
seedMeta.run("last_pulled_at", "");
seedMeta.run("last_published_at", "");
seedMeta.run("published_by", "");

export default db;
