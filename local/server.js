// Local authoring server — runs on each person's machine only (localhost, no auth).
// Phase 1 adds the people/accounts data model and a full CRUD API behind the
// editable ledger grid: list people & accounts, and create/update/delete
// transactions (soft-delete via tombstone) with per-account running balances.
// Every write stamps the sync metadata (id / created_at / updated_at /
// deleted_at) that the two-person last-writer-wins merge relies on.

import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";
import { accountLedger, withRunningBalance, totals } from "../shared/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

const now = () => new Date().toISOString();

// --- Read helpers ----------------------------------------------------------

const allPeople = () =>
  db.prepare("SELECT * FROM people WHERE deleted_at IS NULL ORDER BY name").all();
const allAccounts = () =>
  db.prepare("SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY name").all();
const getAccount = (id) =>
  db.prepare("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL").get(id);
const liveTxns = () =>
  db.prepare("SELECT * FROM transactions WHERE deleted_at IS NULL").all();

// --- API: people & accounts ------------------------------------------------

app.get("/api/health", (_req, res) => {
  const meta = Object.fromEntries(
    db.prepare("SELECT key, value FROM sync_meta").all().map((r) => [r.key, r.value])
  );
  res.json({ ok: true, meta });
});

app.get("/api/people", (_req, res) => {
  res.json({ people: allPeople() });
});

app.get("/api/accounts", (_req, res) => {
  const accounts = allAccounts();
  const txns = liveTxns();
  // Attach each account's current computed balance for convenience.
  const withBalance = accounts.map((a) => {
    const led = accountLedger(txns, a);
    return {
      ...a,
      txn_count: led.length,
      balance: led.length ? led[led.length - 1].running_balance : Number(a.opening_balance) || 0,
    };
  });
  res.json({ accounts: withBalance });
});

app.post("/api/accounts", (req, res) => {
  const { owner = "shared", type = "checking", name = "", opening_balance = 0 } = req.body ?? {};
  const ts = now();
  const id = req.body?.id || randomUUID();
  db.prepare(`INSERT INTO accounts (id, owner, type, name, opening_balance, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, owner, type, name, Number(opening_balance) || 0, ts, ts);
  res.status(201).json({ account: getAccount(id) });
});

app.patch("/api/accounts/:id", (req, res) => {
  const acct = getAccount(req.params.id);
  if (!acct) return res.status(404).json({ error: "account not found" });
  const fields = pick(req.body, ["owner", "type", "name", "opening_balance"]);
  if (Object.keys(fields).length === 0) return res.json({ account: acct });
  if ("opening_balance" in fields) fields.opening_balance = Number(fields.opening_balance) || 0;
  applyUpdate("accounts", req.params.id, fields);
  res.json({ account: getAccount(req.params.id) });
});

// --- API: transactions -----------------------------------------------------

// GET /api/transactions?account_id=...&owner=...
// With account_id: returns that account's ledger with a per-account running
// balance (starting from its opening_balance). Without: the whole ledger with a
// naive running balance (no single opening balance applies across accounts).
app.get("/api/transactions", (req, res) => {
  const { account_id, owner } = req.query;
  let rows = liveTxns();
  if (owner) rows = rows.filter((t) => t.owner === owner);

  if (account_id) {
    const acct = getAccount(account_id);
    if (!acct) return res.status(404).json({ error: "account not found" });
    const ledger = accountLedger(rows, acct);
    return res.json({ account: acct, transactions: ledger, totals: totals(ledger) });
  }
  res.json({ transactions: withRunningBalance(rows), totals: totals(rows) });
});

app.post("/api/transactions", (req, res) => {
  const b = req.body ?? {};
  if (!b.account_id || !getAccount(b.account_id)) {
    return res.status(400).json({ error: "valid account_id is required" });
  }
  if (!b.txn_date) return res.status(400).json({ error: "txn_date is required" });
  const acct = getAccount(b.account_id);
  const ts = now();
  const id = b.id || randomUUID();
  db.prepare(`INSERT INTO transactions
      (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, b.account_id, b.owner || acct.owner, b.txn_date,
      b.description ?? "", b.source ?? "",
      Number(b.deposit) || 0, Number(b.withdrawal) || 0, b.note ?? "", ts, ts
    );
  res.status(201).json({ transaction: getTxn(id) });
});

app.patch("/api/transactions/:id", (req, res) => {
  const txn = getTxn(req.params.id);
  if (!txn || txn.deleted_at) return res.status(404).json({ error: "transaction not found" });
  const fields = pick(req.body, ["account_id", "owner", "txn_date", "description", "source", "deposit", "withdrawal", "note"]);
  if ("deposit" in fields) fields.deposit = Number(fields.deposit) || 0;
  if ("withdrawal" in fields) fields.withdrawal = Number(fields.withdrawal) || 0;
  if ("account_id" in fields && !getAccount(fields.account_id)) {
    return res.status(400).json({ error: "unknown account_id" });
  }
  if (Object.keys(fields).length === 0) return res.json({ transaction: txn });
  applyUpdate("transactions", req.params.id, fields);
  res.json({ transaction: getTxn(req.params.id) });
});

// Soft delete: set a tombstone so the deletion propagates through sync.
app.delete("/api/transactions/:id", (req, res) => {
  const txn = getTxn(req.params.id);
  if (!txn || txn.deleted_at) return res.status(404).json({ error: "transaction not found" });
  const ts = now();
  db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, req.params.id);
  res.json({ ok: true });
});

const getTxn = (id) => db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);

// --- shared write helpers --------------------------------------------------

function pick(obj, keys) {
  const out = {};
  if (obj) for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** Apply a partial update + bump updated_at, in one statement. */
function applyUpdate(table, id, fields) {
  const cols = Object.keys(fields);
  const setSql = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => fields[c]);
  db.prepare(`UPDATE ${table} SET ${setSql}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
}

// --- Editor UI -------------------------------------------------------------

app.use(express.static(join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Finance Dashboard (local) running at http://localhost:${PORT}`);
  console.log(`Serving from ${__dirname}`);
});
