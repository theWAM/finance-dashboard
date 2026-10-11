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
import { writeFileSync, readFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import db from "./db.js";
import { accountLedger, withRunningBalance, totals } from "../shared/metrics.js";
import { cardDebt, cardDebtAsOf, isCardAccount } from "../shared/cards.js";
import { auditTransfers, groupNet, signed } from "../shared/transfers.js";
import { buildSnapshot, parseSnapshot } from "../shared/snapshot.js";
import { isNewer } from "../shared/merge.js";
import { formatStamp } from "../shared/stamp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// Track unpublished local edits: any successful data mutation (not publish /
// refresh) marks the DB "dirty"; publish clears it. Drives hiding the Publish
// button when there's nothing new to push. Registered before the routes so its
// res.on("finish") hook is in the chain.
app.use((req, res, next) => {
  const mutating = req.method === "POST" || req.method === "PATCH" || req.method === "DELETE" || req.method === "PUT";
  // A theme write is a real profile mutation — it bumps updated_at so the LWW
  // merge carries it on the next Publish — but it must NOT mark the DB dirty.
  // Dirty drives the Publish button and the "unpublished changes" note, and a
  // cosmetic toggle has no business claiming there's data to push. It rides the
  // next Publish; it doesn't ask for one. Matched on the path, which is the
  // reason the theme has its own route instead of a field on PATCH /people/:id.
  const isData = mutating
    && !req.path.startsWith("/api/publish")
    && !req.path.startsWith("/api/refresh")
    && !/^\/api\/people\/[^/]+\/theme$/.test(req.path);
  if (isData) res.on("finish", () => {
    if (res.statusCode < 400) db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('dirty', '1')").run();
  });
  next();
});

const now = () => new Date().toISOString();
const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// --- Read helpers ----------------------------------------------------------

const allPeople = () =>
  db.prepare("SELECT * FROM people WHERE deleted_at IS NULL ORDER BY sort_order, name").all();
const allAccounts = () =>
  db.prepare("SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY name").all();
const getAccount = (id) =>
  db.prepare("SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL").get(id);
const parseAccount = (r) => r && { ...r, data: safeParse(r.data) };
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

// The current person's color theme. Profile data, not a machine preference, so
// it travels in snapshot.json and merges like any other field on the row. See
// local/public/theme-boot.js for the resolution rule the clients apply.
//
// The body is a PAIR as of T39: a family plus a mode. Both are validated and,
// as of T41, both are written — in the SAME `applyUpdate` call, so the two
// fields can't half-apply (T39's adopt-as-a-unit rule only holds if they
// can't). The pre-pair single-string body shape still works (mode omitted):
// a stale cached client gets its theme written and keeps whatever mode the
// row already had, rather than 400ing its way into losing the pick.
const FAMILIES = ["slate", "peach", "bordeaux", "lagoon", "orchid", "thicket"];
const MODES = ["light", "dark", "auto"];
const LEGACY_THEMES = { dark: "slate", peach: "peach" };
app.put("/api/people/:id/theme", (req, res) => {
  const person = db.prepare("SELECT * FROM people WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
  if (!person) return res.status(404).json({ error: "person not found" });
  const sent = String(req.body?.theme ?? "");
  const theme = FAMILIES.includes(sent) ? sent : LEGACY_THEMES[sent];
  const mode = req.body?.mode === undefined ? null : String(req.body.mode);
  // Reject rather than coerce: silently storing a theme nobody can render would
  // show up later as "my choice didn't stick" with nothing to point at.
  if (!theme) return res.status(400).json({ error: `theme must be one of ${FAMILIES.join(", ")}` });
  if (mode !== null && !MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` });
  applyUpdate("people", person.id, mode !== null ? { theme, theme_mode: mode } : { theme });
  res.json({ person: db.prepare("SELECT * FROM people WHERE id = ?").get(person.id) });
});

// GET /api/accounts?type=credit_card — e.g. the Cards tab's dropdown in one call.
app.get("/api/accounts", (req, res) => {
  const { type } = req.query;
  let accounts = allAccounts();
  if (type) accounts = accounts.filter((a) => a.type === type);
  const txns = liveTxns();
  const today = new Date().toISOString().slice(0, 10);
  // Attach each account's current computed balance for convenience.
  const withBalance = accounts.map((a) => {
    const parsed = parseAccount(a);
    const led = accountLedger(txns, a);
    return {
      ...parsed,
      txn_count: led.length,
      balance: led.length ? led[led.length - 1].running_balance : Number(a.opening_balance) || 0,
      // T26 left this field for T27 rather than re-deriving decision #22's sign
      // flip here and then again in shared/cards.js. `debt` is the flip, and it
      // comes from `cardDebtAsOf` — as of TODAY, not the end of the ledger,
      // because T34's paired transfers put every planned future payment on the
      // card side, so the whole-ledger figure is a projection. `projected_debt`
      // is that projection, named so nobody mistakes it for what is owed now.
      // Cards only: a checking account has a balance, not a debt.
      ...(isCardAccount(a) ? {
        debt: cardDebtAsOf(txns, parsed, today),
        projected_debt: cardDebt(txns, parsed),
      } : {}),
    };
  });
  res.json({ accounts: withBalance });
});

app.post("/api/accounts", (req, res) => {
  const { owner = "shared", type = "checking", name = "", opening_balance = 0, data = {} } = req.body ?? {};
  const ts = now();
  const id = req.body?.id || randomUUID();
  db.prepare(`INSERT INTO accounts (id, owner, type, name, opening_balance, data, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, owner, type, name, Number(opening_balance) || 0, JSON.stringify(data ?? {}), ts, ts);
  res.status(201).json({ account: parseAccount(getAccount(id)) });
});

app.patch("/api/accounts/:id", (req, res) => {
  const acct = getAccount(req.params.id);
  if (!acct) return res.status(404).json({ error: "account not found" });
  const fields = pick(req.body, ["owner", "type", "name", "opening_balance", "data"]);
  if (Object.keys(fields).length === 0) return res.json({ account: parseAccount(acct) });
  if ("opening_balance" in fields) fields.opening_balance = Number(fields.opening_balance) || 0;
  if ("data" in fields) fields.data = JSON.stringify(fields.data ?? {});
  applyUpdate("accounts", req.params.id, fields);
  res.json({ account: parseAccount(getAccount(req.params.id)) });
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
      (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, transfer_id, external_id, import_batch, projected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, b.account_id, b.owner || acct.owner, b.txn_date,
      b.description ?? "", b.source ?? "",
      Number(b.deposit) || 0, Number(b.withdrawal) || 0, b.note ?? "",
      // `projected` is set only by T30's "project it forward" flow, which posts
      // the marker shared/recurring.js minted. It is never defaulted to a value.
      b.transfer_id ?? null, b.external_id ?? null, b.import_batch ?? null, b.projected ?? null, ts, ts
    );
  res.status(201).json({ transaction: getTxn(id) });
});

// POST /api/transactions/bulk — the statement uploader's one write (T29).
//   { account_id, import_batch, rows: [{ txn_date, description, source,
//     deposit, withdrawal, note, external_id, transfer_id?, update_id? }] }
//   → { inserted, skipped, updated, import_batch }
//
// It takes ALREADY-PARSED rows. There is deliberately no `/api/import` endpoint
// that accepts a file: the page reads the statement with `FileReader`, parses it
// in the browser with shared/statement-import.js, and posts rows. So the file
// never reaches this process, never touches disk, and "the statement is never
// uploaded" is a property of the API's shape rather than of remembering to
// delete a temp file (decision #27). No parsing happens here and none should be
// added — a server-side parser would reintroduce the whole hazard.
//
// One manual BEGIN/COMMIT/ROLLBACK around the batch (node:sqlite has no
// .transaction() helper), so a bad row anywhere writes nothing at all. A
// half-imported statement is the worst outcome available: the diff that decides
// what is fresh is computed against the ledger, so a partial write makes the
// NEXT upload's answer wrong too.
app.post("/api/transactions/bulk", (req, res) => {
  const b = req.body ?? {};
  const acct = b.account_id && getAccount(b.account_id);
  if (!acct) return res.status(400).json({ error: "valid account_id is required" });
  if (!Array.isArray(b.rows)) return res.status(400).json({ error: "rows must be an array" });
  if (!b.rows.length) return res.status(400).json({ error: "rows is empty — nothing to import" });
  if (b.rows.length > 5000) return res.status(400).json({ error: "refusing a batch over 5000 rows" });
  if (!b.import_batch) return res.status(400).json({ error: "import_batch is required — it is what makes one bad import undoable as a unit" });

  // Validate the whole batch before opening the transaction, so the common
  // failure returns a 400 that names the offending row instead of a rollback.
  for (const [i, r] of b.rows.entries()) {
    if (!r || !r.txn_date) return res.status(400).json({ error: `row ${i}: txn_date is required` });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.txn_date)) return res.status(400).json({ error: `row ${i}: txn_date must be YYYY-MM-DD` });
    for (const f of ["deposit", "withdrawal"]) {
      if (r[f] != null && !Number.isFinite(Number(r[f]))) return res.status(400).json({ error: `row ${i}: ${f} is not a number` });
    }
    if (r.update_id) {
      const target = getTxn(r.update_id);
      if (!target || target.deleted_at) return res.status(400).json({ error: `row ${i}: update_id ${r.update_id} is not a live transaction` });
      if (target.account_id !== b.account_id) return res.status(400).json({ error: `row ${i}: update_id ${r.update_id} belongs to another account` });
      // Identity is not content (T26): an import may STAMP a fingerprint onto a
      // row that has none — that is the whole point of adopting a hand-entered
      // or T34-mirrored row — but it may never overwrite a different one.
      if (target.external_id && r.external_id && target.external_id !== r.external_id) {
        return res.status(409).json({ error: `row ${i}: refusing to overwrite the external_id on ${r.update_id}` });
      }
    }
  }

  // Belt and braces behind the client-side diff: skip any external_id that is
  // already on a LIVE row. Tombstones deliberately do not block a re-import —
  // the review modal's diff is computed against live rows too, so this keeps the
  // counts the user confirmed and what actually gets written in agreement. A row
  // the user deleted on purpose does come back on the next upload of the same
  // statement, where it shows as fresh and can be excluded again; the
  // alternative makes a mis-deleted row unrecoverable.
  const live = new Set(
    db.prepare("SELECT external_id FROM transactions WHERE external_id IS NOT NULL AND deleted_at IS NULL")
      .all().map((r) => r.external_id)
  );

  const insert = db.prepare(`INSERT INTO transactions
      (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, transfer_id, external_id, import_batch, projected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let inserted = 0, skipped = 0, updated = 0;
  const ts = now();
  db.exec("BEGIN");
  try {
    for (const r of b.rows) {
      if (r.update_id) {
        // A conflict confirmed in the review modal (a pending charge that
        // settled at a different amount), the adoption of a row that already
        // existed without a fingerprint, or T30's supersede: a real statement
        // row landing on the projection that predicted it.
        //
        // `projected = NULL` unconditionally, and that is the supersede rule's
        // whole implementation on the write side. Any row an import updates
        // with real statement content IS real afterwards — if the flag stayed,
        // the row would keep offering itself to the next statement's supersede
        // pass and a second charge from the same merchant would overwrite the
        // first instead of landing beside it.
        db.prepare(`UPDATE transactions SET txn_date = ?, description = ?, source = ?, deposit = ?, withdrawal = ?,
             note = ?, external_id = COALESCE(external_id, ?), import_batch = ?, projected = NULL, updated_at = ? WHERE id = ?`)
          .run(
            r.txn_date, r.description ?? "", r.source ?? "",
            Number(r.deposit) || 0, Number(r.withdrawal) || 0, r.note ?? "",
            r.external_id ?? null, b.import_batch, ts, r.update_id
          );
        if (r.external_id) live.add(r.external_id);
        updated++;
        continue;
      }
      if (r.external_id && live.has(r.external_id)) { skipped++; continue; }
      if (r.external_id) live.add(r.external_id);
      insert.run(
        randomUUID(), b.account_id, b.owner || acct.owner, r.txn_date,
        r.description ?? "", r.source ?? "",
        Number(r.deposit) || 0, Number(r.withdrawal) || 0, r.note ?? "",
        r.transfer_id ?? null, r.external_id ?? null, b.import_batch, r.projected ?? null, ts, ts
      );
      inserted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: `import rolled back — ${e.message}` });
  }
  res.status(201).json({ inserted, skipped, updated, import_batch: b.import_batch });
});

app.patch("/api/transactions/:id", (req, res) => {
  const txn = getTxn(req.params.id);
  if (!txn || txn.deleted_at) return res.status(404).json({ error: "transaction not found" });
  const fields = pick(req.body, ["account_id", "owner", "txn_date", "description", "source", "deposit", "withdrawal", "note", "projected"]);
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

// --- API: transfers (T34) --------------------------------------------------
//
// A card payment is one movement with two ends on two accounts, joined by
// `transactions.transfer_id`. These routes exist for one reason the ordinary
// transaction routes cannot provide: ATOMICITY. A pair whose two halves are
// POSTed one after another can leave a $1,240 withdrawal against a $900 deposit
// if the second call fails, which is the exact failure mode T37's checker is
// for. Everything here runs inside a single SQLite transaction.
//
// They are also the ONLY way `transfer_id` is written onto a row that already
// exists. `PATCH /api/transactions/:id` still refuses all three identity fields
// (T26's rule: identity, not content) — pairing is an operation on a movement,
// not an edit to a row, so it gets its own verb.

const CENT = 0.005;
const liveAccounts = () => allAccounts().map(parseAccount);
const groupRows = (id) =>
  db.prepare("SELECT * FROM transactions WHERE transfer_id = ? AND deleted_at IS NULL").all(id);

/**
 * The group index the Ledger badges rows from, plus the audit totals.
 * Compact on purpose: the alternative is shipping all ~2,000 transactions to
 * the client just to learn which of the visible rows has a counterpart.
 */
app.get("/api/transfers", (_req, res) => {
  const accounts = liveAccounts();
  const txns = liveTxns();
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const audit = auditTransfers({ transactions: txns, accounts });
  const groups = {};
  for (const [tid, rows] of audit.groups) {
    groups[tid] = {
      net: groupNet(rows),
      rows: rows.map((t) => ({
        id: t.id, account_id: t.account_id, account_name: nameById.get(t.account_id) || t.account_id,
        txn_date: t.txn_date, description: t.description,
        deposit: Number(t.deposit) || 0, withdrawal: Number(t.withdrawal) || 0,
      })),
    };
  }
  res.json({
    groups,
    // Rows whose MISSING pair is an error (#48's asymmetry): money left
    // checking toward a card in the inventory and nothing received it.
    unpaired: audit.unpairedOutflow.map((u) => u.row.id),
    cards: accounts.filter((a) => a.type === "credit_card")
      .map((a) => ({ id: a.id, name: a.name, owner: a.owner, source_aliases: a.data?.source_aliases || [] })),
    summary: {
      groups: audit.groups.size, paired: audit.paired.length,
      unpaired_outflow: audit.unpairedOutflow.length, mismatched: audit.mismatched.length,
      card_side_only: audit.soloCardSide.length, inflow_only: audit.soloInflow.length,
      double_risk: audit.doubleRisk.length, ok: audit.ok,
    },
  });
});

/**
 * Create / pair a movement, atomically.
 *
 *   { transfer_id?, rows?: [existingId], creates?: [draft], updates?: [{id, ...}] }
 *
 * `rows` get stamped with the key, `creates` are inserted carrying it, and
 * `updates` are ordinary field edits applied in the SAME transaction — so
 * "change this payment's amount AND mirror it" cannot half-apply either.
 *
 * REFUSES an unbalanced group. A `transfer_id` whose rows do not net to zero is
 * worse than no `transfer_id` at all: an unpaired row is visibly unpaired and
 * the checker finds it, whereas a mismatched pair looks joined and reconciles
 * to nothing. Declining to pair is a client-side choice that sends none of this.
 */
app.post("/api/transfers", (req, res) => {
  const b = req.body ?? {};
  const rowIds = Array.isArray(b.rows) ? b.rows : [];
  const creates = Array.isArray(b.creates) ? b.creates : [];
  const updates = Array.isArray(b.updates) ? b.updates : [];
  const transferId = b.transfer_id || `tr-${randomUUID()}`;
  if (!rowIds.length && !creates.length) {
    return res.status(400).json({ error: "rows and/or creates is required" });
  }

  const existing = [];
  for (const id of rowIds) {
    const t = getTxn(id);
    if (!t || t.deleted_at) return res.status(404).json({ error: `transaction ${id} not found` });
    if (t.transfer_id && t.transfer_id !== transferId) {
      return res.status(409).json({ error: `transaction ${id} is already in transfer ${t.transfer_id}` });
    }
    existing.push(t);
  }
  for (const d of creates) {
    if (!d?.account_id || !getAccount(d.account_id)) return res.status(400).json({ error: "each create needs a valid account_id" });
    if (!d.txn_date) return res.status(400).json({ error: "each create needs a txn_date" });
  }

  // Net the group as it WILL be, updates applied, before writing anything.
  const patched = existing.map((t) => ({ ...t, ...(updates.find((u) => u.id === t.id) || {}) }));
  const prior = groupRows(transferId).filter((t) => !rowIds.includes(t.id));
  const net = groupNet([...prior, ...patched, ...creates]);
  if (Math.abs(net) >= CENT) {
    return res.status(409).json({
      error: `a transfer must net to zero; this group is off by ${net.toFixed(2)}. ` +
        `Leave the row unpaired instead — an unpaired row is auditable, a mismatched pair is not.`,
    });
  }

  const ts = now();
  const created = [];
  db.exec("BEGIN");
  try {
    for (const u of updates) {
      const fields = pick(u, ["txn_date", "description", "source", "deposit", "withdrawal", "note"]);
      if ("deposit" in fields) fields.deposit = Number(fields.deposit) || 0;
      if ("withdrawal" in fields) fields.withdrawal = Number(fields.withdrawal) || 0;
      if (Object.keys(fields).length) applyUpdate("transactions", u.id, fields);
    }
    for (const t of existing) {
      db.prepare("UPDATE transactions SET transfer_id = ?, updated_at = ? WHERE id = ?").run(transferId, ts, t.id);
    }
    for (const d of creates) {
      const acct = getAccount(d.account_id);
      const id = d.id || randomUUID();
      db.prepare(`INSERT INTO transactions
          (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, transfer_id, external_id, import_batch, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, d.account_id, d.owner || acct.owner, d.txn_date, d.description ?? "", d.source ?? "",
          Number(d.deposit) || 0, Number(d.withdrawal) || 0, d.note ?? "", transferId, null, d.import_batch ?? null, ts, ts);
      created.push(id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: e.message }); }

  res.status(201).json({ transfer_id: transferId, created, rows: groupRows(transferId), net: groupNet(groupRows(transferId)) });
});

/**
 * Propagate a date or an amount across a movement's ends, atomically.
 *
 *   { txn_date?, amount? }   amount is a MAGNITUDE; each row keeps its own side
 *
 * `amount` is refused on a group that is not exactly two rows. The real data
 * holds 1:N splits — one $888.12 checking withdrawal against four card rows —
 * and there is no non-arbitrary way to push one new total across four rows.
 * Saying so is better than picking one and being silently wrong about it.
 */
app.patch("/api/transfers/:id", (req, res) => {
  const rows = groupRows(req.params.id);
  if (!rows.length) return res.status(404).json({ error: "transfer not found" });
  const b = req.body ?? {};
  const date = b.txn_date;
  const amount = b.amount === undefined || b.amount === null || b.amount === "" ? null : Math.abs(Number(b.amount));
  if (!date && amount === null) return res.json({ transfer_id: req.params.id, rows });
  if (amount !== null && !Number.isFinite(amount)) return res.status(400).json({ error: "amount must be a number" });
  if (amount !== null && rows.length !== 2) {
    return res.status(409).json({
      error: `transfer ${req.params.id} has ${rows.length} rows, so an amount cannot be propagated unambiguously. ` +
        `Edit the rows individually.`,
    });
  }
  db.exec("BEGIN");
  try {
    for (const t of rows) {
      const fields = {};
      if (date) fields.txn_date = date;
      if (amount !== null) {
        // Each end keeps its own direction; only the magnitude travels.
        const out = signed(t) > 0;
        fields.deposit = out ? 0 : amount;
        fields.withdrawal = out ? amount : 0;
      }
      applyUpdate("transactions", t.id, fields);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: e.message }); }
  const after = groupRows(req.params.id);
  res.json({ transfer_id: req.params.id, rows: after, net: groupNet(after) });
});

/** Soft-delete every end of a movement at once, so neither half survives alone. */
app.delete("/api/transfers/:id", (req, res) => {
  const rows = groupRows(req.params.id);
  if (!rows.length) return res.status(404).json({ error: "transfer not found" });
  const ts = now();
  db.exec("BEGIN");
  try {
    for (const t of rows) {
      db.prepare("UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, t.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, deleted: rows.length });
});

/** Break a movement apart WITHOUT deleting either end — the "unpair" verb. */
app.delete("/api/transfers/:id/link", (req, res) => {
  const rows = groupRows(req.params.id);
  if (!rows.length) return res.status(404).json({ error: "transfer not found" });
  const ts = now();
  db.exec("BEGIN");
  try {
    for (const t of rows) db.prepare("UPDATE transactions SET transfer_id = NULL, updated_at = ? WHERE id = ?").run(ts, t.id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, unpaired: rows.length });
});

// --- API: plan targets (incl. recurring_allocation templates) --------------

const getPlan = (id) => db.prepare("SELECT * FROM plan_targets WHERE id = ?").get(id);
const parsePlanTarget = (r) => ({ ...r, data: safeParse(r.data) });

// GET /api/plan-targets?owner=...&kind=...
app.get("/api/plan-targets", (req, res) => {
  const { owner, kind } = req.query;
  let rows = db.prepare("SELECT * FROM plan_targets WHERE deleted_at IS NULL").all();
  if (owner) rows = rows.filter((r) => r.owner === owner);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  res.json({ plan_targets: rows.map(parsePlanTarget) });
});

app.post("/api/plan-targets", (req, res) => {
  const b = req.body ?? {};
  if (!b.kind) return res.status(400).json({ error: "kind is required" });
  const ts = now();
  const id = b.id || randomUUID();
  db.prepare(`INSERT INTO plan_targets (id, owner, kind, name, data, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, b.owner || "shared", b.kind, b.name ?? "", JSON.stringify(b.data ?? {}), ts, ts);
  res.status(201).json({ plan_target: parsePlanTarget(getPlan(id)) });
});

app.patch("/api/plan-targets/:id", (req, res) => {
  const pt = getPlan(req.params.id);
  if (!pt || pt.deleted_at) return res.status(404).json({ error: "plan target not found" });
  const fields = pick(req.body, ["owner", "kind", "name", "data"]);
  if ("data" in fields) fields.data = JSON.stringify(fields.data ?? {});
  if (Object.keys(fields).length === 0) return res.json({ plan_target: parsePlanTarget(pt) });
  applyUpdate("plan_targets", req.params.id, fields);
  res.json({ plan_target: parsePlanTarget(getPlan(req.params.id)) });
});

app.delete("/api/plan-targets/:id", (req, res) => {
  const pt = getPlan(req.params.id);
  if (!pt || pt.deleted_at) return res.status(404).json({ error: "plan target not found" });
  const ts = now();
  db.prepare("UPDATE plan_targets SET deleted_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, req.params.id);
  res.json({ ok: true });
});

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

// --- Sync: publish / refresh (Phase 7) -------------------------------------

const ROOT = join(__dirname, "..");
const meta = (k) => db.prepare("SELECT value FROM sync_meta WHERE key = ?").get(k)?.value;
const setMeta = (k, v) => db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)").run(k, String(v));
const allRaw = (table) => db.prepare(`SELECT * FROM ${table}`).all(); // incl. tombstones

app.get("/api/sync-status", (_req, res) => {
  const local_version = Number(meta("local_version") || 0);
  const last_pulled_version = Number(meta("last_pulled_version") || 0);
  let snapshot_version = 0;
  try { snapshot_version = Number(JSON.parse(readFileSync(join(ROOT, "docs", "data", "snapshot.json"), "utf8")).version) || 0; } catch { /* no snapshot yet */ }
  const hasData = !!(db.prepare("SELECT 1 FROM transactions LIMIT 1").get() || db.prepare("SELECT 1 FROM plan_targets LIMIT 1").get());
  // Is the live site actually serving what's on disk? A publish whose git step
  // failed leaves docs/ written but uncommitted (or committed but unpushed),
  // which is exactly how the published view got stuck several versions back.
  let site_stale = false, site_note = "";
  try {
    const g = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim();
    const uncommitted = g("status", "--porcelain", "--", "docs");
    const unpushed = Number(g("rev-list", "--count", "@{upstream}..HEAD")) || 0;
    if (uncommitted) { site_stale = true; site_note = "docs/ has uncommitted changes - Publish to update the site"; }
    else if (unpushed > 0) { site_stale = true; site_note = `${unpushed} commit(s) not pushed - Publish to update the site`; }
  } catch { /* no git / no upstream - can't tell, so don't claim staleness */ }
  res.json({
    site_stale, site_note,
    local_version,
    last_published_at: meta("last_published_at") || null,
    published_by: meta("published_by") || null,
    last_pulled_version,
    last_pulled_at: meta("last_pulled_at") || null,
    snapshot_version,
    // Publish is useful only with local edits since the last publish (or never
    // published yet but there's data). Refresh only if the snapshot is ahead.
    has_unpublished: meta("dirty") === "1" || (local_version === 0 && hasData),
    has_unpulled: snapshot_version > Math.max(local_version, last_pulled_version),
  });
});

// Export SQLite → docs/data/snapshot.json (+ copy shared modules for the public
// view), then optionally git commit & push. Pass { push:false } to skip git.
app.post("/api/publish", (req, res) => {
  const publishedBy = req.body?.publishedBy || "";
  const doPush = req.body?.push !== false;
  const version = Number(meta("local_version") || 0) + 1;
  // One timestamp for the snapshot, the commit message, and the sync metadata,
  // so every surface reports the same "last updated" moment.
  const publishedAt = new Date().toISOString();
  const commitMsg = `Publish snapshot - ${formatStamp(publishedAt)}`;
  const snapshot = buildSnapshot({
    version, publishedBy, publishedAt,
    people: allRaw("people"),
    accounts: allRaw("accounts"),
    transactions: allRaw("transactions"),
    planTargets: allRaw("plan_targets").map((r) => ({ ...r, data: safeParse(r.data) })),
  });
  const dataDir = join(ROOT, "docs", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  // Copy shared/*.js into docs/shared so the published view runs the same logic.
  const sharedDst = join(ROOT, "docs", "shared");
  mkdirSync(sharedDst, { recursive: true });
  for (const f of readdirSync(join(ROOT, "shared"))) if (f.endsWith(".js")) copyFileSync(join(ROOT, "shared", f), join(sharedDst, f));
  // Copy profile photos so owner avatars resolve on the published view too.
  const avatarSrc = join(ROOT, "local", "public", "avatars");
  const avatarDst = join(ROOT, "docs", "avatars");
  try {
    mkdirSync(avatarDst, { recursive: true });
    for (const f of readdirSync(avatarSrc)) copyFileSync(join(avatarSrc, f), join(avatarDst, f));
  } catch { /* no avatars dir — fine */ }

  // Generate the read-only Ledger + This-Paycheck pages from the local app
  // files: same markup and logic, just rewrite the absolute /shared import to a
  // relative one and inject the snapshot-backed fetch shim (docs/mock-api.js).
  // Regenerated every publish so they never drift from the local app.
  const pub = join(__dirname, "public");
  const relImports = (s) => s.replace(/from "\/shared\//g, 'from "./shared/');
  // The shim must be installed before ANY script that touches /api/ — not just
  // the page's own. settings.js loads first and reads the current profile's
  // theme from /api/people, so anchoring on the page script (as this used to)
  // let that one call escape the shim and hit a real network path. Anchor on
  // the FIRST module script instead.
  const injectShim = (html) => html.replace('<script type="module"', '<script type="module" src="./mock-api.js"></script>\n<script type="module"');
  // Lists, not one line per file: every published page's script has to be
  // copied, including the shared UI modules a page imports (timeframe-ui.js),
  // or the published page 404s on an import and renders blank.
  for (const f of ["app.js", "paycheck.js", "csp.js", "timeframe-ui.js", "nav-plan.js", "view-switch.js", "pairing.js", "settings.js", "theme-boot.js"]) {
    writeFileSync(join(ROOT, "docs", f), relImports(readFileSync(join(pub, f), "utf8")));
  }
  // Stylesheets the pages <link> rather than import. theme.css carries both
  // color themes and the Settings panel's CSS, so a published page without it
  // renders unstyled, not just un-themed.
  for (const f of ["theme.css"]) copyFileSync(join(pub, f), join(ROOT, "docs", f));
  for (const { src, out } of [
    { src: "index.html", out: "ledger.html" },
    { src: "paycheck.html", out: "paycheck.html" },
    { src: "csp.html", out: "csp.html" },
  ]) {
    writeFileSync(join(ROOT, "docs", out), injectShim(readFileSync(join(pub, src), "utf8")));
  }

  // Commit + push docs/ so Pages actually serves the new snapshot. Each git
  // step runs on its own so we can report which one broke. This used to be one
  // chained `add && commit && push` whose failure was swallowed into a
  // console.warn while local_version advanced and `dirty` was cleared anyway --
  // that hid the Publish button, so a failed push froze the site silently (it
  // sat on v10 while this machine counted itself up to v14).
  let pushed = false, gitOut = "", gitStep = "";
  if (doPush) {
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    try {
      gitStep = "add"; git("add", "docs");
      gitStep = "commit";
      // Republishing byte-identical data stages nothing: success, not failure.
      if (git("status", "--porcelain", "--", "docs").trim()) git("commit", "-m", commitMsg);
      gitStep = "push"; git("push");
      pushed = true;
    } catch (e) {
      gitOut = `git ${gitStep} failed - ` + String(e.stderr || e.stdout || e.message).trim().slice(0, 600);
    }
  }

  // Only record a publish once the site really has it. If the push failed the
  // DB stays dirty at the previous version, so Publish stays visible and the
  // next click retries instead of the version quietly drifting ahead.
  if (pushed || !doPush) {
    setMeta("local_version", version);
    setMeta("last_published_at", publishedAt);
    setMeta("published_by", publishedBy);
    setMeta("dirty", "0"); // everything local is now published
  }
  res.json({
    ok: pushed || !doPush, version, pushed, gitOut,
    published_at: publishedAt, stamp: formatStamp(publishedAt),
    counts: { transactions: snapshot.transactions.length },
  });
});

// Pull a published snapshot (from `source` URL, else the local committed file)
// and merge it per-record last-writer-wins into SQLite.
app.post("/api/refresh", async (req, res) => {
  const source = req.body?.source;
  let raw;
  try {
    raw = source ? await (await fetch(source)).text() : readFileSync(join(ROOT, "docs", "data", "snapshot.json"), "utf8");
  } catch (e) { return res.status(400).json({ error: "could not read snapshot: " + e.message }); }
  let snap;
  try { snap = parseSnapshot(raw); } catch (e) { return res.status(400).json({ error: e.message }); }

  const merged = {
    people: mergeInto("people", snap.people),
    accounts: mergeInto("accounts", snap.accounts),
    transactions: mergeInto("transactions", snap.transactions),
    plan_targets: mergeInto("plan_targets", (snap.plan_targets || []).map((r) => ({ ...r, data: typeof r.data === "string" ? r.data : JSON.stringify(r.data || {}) }))),
  };
  setMeta("last_pulled_version", snap.version || 0);
  setMeta("last_pulled_at", new Date().toISOString());
  res.json({ ok: true, version: snap.version, merged });
});

// Per-record LWW upsert of `incoming` into `table` (newer updated_at wins).
function mergeInto(table, incoming = []) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const localById = new Map(allRaw(table).map((r) => [r.id, r]));
  const upsert = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  let applied = 0;
  db.exec("BEGIN");
  try {
    for (const rec of incoming) {
      const local = localById.get(rec.id);
      if (local && !isNewer(rec, local)) continue; // local is newer/equal — keep it
      upsert.run(...cols.map((c) => (rec[c] !== undefined ? rec[c] : local ? local[c] : null)));
      applied++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return applied;
}

// --- Editor UI -------------------------------------------------------------

app.use(express.static(join(__dirname, "public")));
// Serve the published docs/ site locally at /site for previewing the public view.
app.use("/site", express.static(join(ROOT, "docs")));
// Serve the shared/ modules (e.g. paycycle.js) so the browser can import them.
app.use("/shared", express.static(join(__dirname, "..", "shared")));

app.listen(PORT, () => {
  console.log(`Finance Dashboard (local) running at http://localhost:${PORT}`);
  console.log(`Serving from ${__dirname}`);
});
