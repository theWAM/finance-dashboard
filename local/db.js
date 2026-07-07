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
//
// Phase 1 adds the people/accounts model: transactions and plan targets carry
// an `owner` (a person id or 'shared'), transactions belong to an `account_id`,
// and the running balance is computed per account (each checking account has
// its own opening_balance). People and accounts are configuration data — a
// list, never a hardcoded count of two — so the same code serves one person,
// a couple, or an N-person household.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Private local database, kept beside the server code and gitignored.
const DB_PATH = join(__dirname, "dashboard.db");

// Uses Node's built-in SQLite (node:sqlite) — no native module to compile.
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  -- People / household members. Configuration, NOT an auth boundary: the
  -- current user is chosen client-side. A single-person setup is just one row.
  CREATE TABLE IF NOT EXISTS people (
    id          TEXT PRIMARY KEY,           -- stable slug, e.g. 'woody'
    name        TEXT NOT NULL,              -- display name
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
  );

  -- Accounts. Each transaction moves one account's balance; the running balance
  -- is computed per account, starting from opening_balance. A future joint
  -- account is just another row with owner = 'shared'.
  CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    owner           TEXT NOT NULL DEFAULT 'shared',  -- person id or 'shared'
    type            TEXT NOT NULL DEFAULT 'checking', -- checking|credit_card|savings|investment|loan
    name            TEXT NOT NULL DEFAULT '',
    opening_balance REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_updated ON accounts(updated_at);

  -- Ledger: one row per deposit/withdrawal. Running balance is COMPUTED per
  -- account (see shared/metrics.js), not stored.
  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    account_id  TEXT,                        -- which account's balance this moves
    owner       TEXT NOT NULL DEFAULT 'shared',
    txn_date    TEXT NOT NULL,               -- ISO date (YYYY-MM-DD)
    description TEXT NOT NULL DEFAULT '',     -- category, e.g. Paycheck / Bill / Credit Card Payment
    source      TEXT NOT NULL DEFAULT '',     -- Source/Recipient, e.g. Apple Card, Direct Deposit
    deposit     REAL NOT NULL DEFAULT 0,      -- money in (+)
    withdrawal  REAL NOT NULL DEFAULT 0,      -- money out (-)
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT                          -- tombstone; NULL = live
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(txn_date);
  CREATE INDEX IF NOT EXISTS idx_transactions_updated ON transactions(updated_at);
  CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);

  -- Plan targets: the strategy migrated out of fin_plan.html into editable data.
  -- 'kind' distinguishes debt_payoff / savings_goal / investment_cadence / income / coast_fire.
  -- 'data' is a JSON blob of kind-specific fields (e.g. balance, apr, monthly_payment, target_date).
  CREATE TABLE IF NOT EXISTS plan_targets (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL DEFAULT 'shared',
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

// --- Additive migrations for databases created before Phase 1 --------------
// CREATE TABLE IF NOT EXISTS never alters an existing table, so add any columns
// introduced later here. Each is a no-op once the column exists.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("transactions", "account_id", "account_id TEXT");
ensureColumn("transactions", "owner", "owner TEXT NOT NULL DEFAULT 'shared'");
ensureColumn("plan_targets", "owner", "owner TEXT NOT NULL DEFAULT 'shared'");
ensureColumn("people", "avatar", "avatar TEXT NOT NULL DEFAULT ''"); // URL/path to a profile image

const now = new Date().toISOString();

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

// Seed the initial household. These are defaults for this instance, not
// hardcoded assumptions: they can be renamed/added/removed like any other row.
const seedPerson = db.prepare(
  "INSERT OR IGNORE INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)"
);
seedPerson.run("woody", "Woody", now, now);
seedPerson.run("rajna", "Rajna", now, now);

// Backfill default avatars for the seeded people without clobbering a chosen one.
// (Served statically from local/public/avatars/.)
const setAvatar = db.prepare(
  "UPDATE people SET avatar = ? WHERE id = ? AND (avatar IS NULL OR avatar = '')"
);
setAvatar.run("/avatars/woody.jpg", "woody");
setAvatar.run("/avatars/rajna.jpg", "rajna");

// One checking account per person to start (the CSV ledger is Woody's account).
// A joint account later is just another row with owner = 'shared'.
const seedAccount = db.prepare(
  `INSERT OR IGNORE INTO accounts (id, owner, type, name, opening_balance, created_at, updated_at)
   VALUES (?, ?, 'checking', ?, 0, ?, ?)`
);
seedAccount.run("woody-checking", "woody", "Woody — Checking", now, now);
seedAccount.run("rajna-checking", "rajna", "Rajna — Checking", now, now);

export default db;
