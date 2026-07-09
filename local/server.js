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
import { execSync } from "node:child_process";
import db from "./db.js";
import { accountLedger, withRunningBalance, totals } from "../shared/metrics.js";
import { buildSnapshot, parseSnapshot } from "../shared/snapshot.js";
import { isNewer } from "../shared/merge.js";

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
  const isData = mutating && !req.path.startsWith("/api/publish") && !req.path.startsWith("/api/refresh");
  if (isData) res.on("finish", () => {
    if (res.statusCode < 400) db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('dirty', '1')").run();
  });
  next();
});

const now = () => new Date().toISOString();

// --- Read helpers ----------------------------------------------------------

const allPeople = () =>
  db.prepare("SELECT * FROM people WHERE deleted_at IS NULL ORDER BY sort_order, name").all();
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

// --- API: plan targets (incl. recurring_allocation templates) --------------

const getPlan = (id) => db.prepare("SELECT * FROM plan_targets WHERE id = ?").get(id);
const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
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
  res.json({
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
  const snapshot = buildSnapshot({
    version, publishedBy,
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
  const injectShim = (html, src) => html.replace(`<script type="module" src="${src}">`, `<script type="module" src="./mock-api.js"></script>\n<script type="module" src="${src}">`);
  writeFileSync(join(ROOT, "docs", "app.js"), relImports(readFileSync(join(pub, "app.js"), "utf8")));
  writeFileSync(join(ROOT, "docs", "paycheck.js"), relImports(readFileSync(join(pub, "paycheck.js"), "utf8")));
  writeFileSync(join(ROOT, "docs", "ledger.html"), injectShim(readFileSync(join(pub, "index.html"), "utf8"), "./app.js"));
  writeFileSync(join(ROOT, "docs", "paycheck.html"), injectShim(readFileSync(join(pub, "paycheck.html"), "utf8"), "./paycheck.js"));

  setMeta("local_version", version);
  setMeta("last_published_at", new Date().toISOString());
  setMeta("published_by", publishedBy);
  setMeta("dirty", "0"); // everything local is now published

  let pushed = false, gitOut = "";
  if (doPush) {
    try {
      execSync(`git add docs && git commit -m "Publish snapshot v${version}" && git push`, { cwd: ROOT, stdio: "pipe" });
      pushed = true;
    } catch (e) { gitOut = String(e.stderr || e.stdout || e.message).slice(0, 600); }
  }
  res.json({ ok: true, version, pushed, gitOut, counts: { transactions: snapshot.transactions.length } });
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
