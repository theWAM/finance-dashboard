// Published read-only shim. The Ledger and This-Paycheck pages are the *same*
// files as the local app; they talk to the server exclusively through
// fetch("/api/…"). On the static GitHub Pages site there is no server, so this
// module (loaded before the page's own script) replaces window.fetch with a
// handler backed by the published snapshot.json.
//
// Reads mirror the local server's response shapes exactly (computed with the
// same shared/metrics.js). Writes are accepted into an in-memory copy so inline
// edits still recompute live — but nothing is persisted, and the page hides its
// Save/Publish/Refresh controls and shows a banner saying so.

import { accountLedger, withRunningBalance, totals } from "./shared/metrics.js";

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2));
const nowISO = () => new Date().toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// In-memory store, populated from the snapshot.
const db = { people: [], accounts: [], transactions: [], plan_targets: [], version: 0, published_at: null, published_by: null };
const relAvatar = (p) => (p ? String(p).replace(/^\//, "") : p); // "/avatars/x" → "avatars/x" (resolves under /finance-dashboard/)

const ready = (async () => {
  const snap = await (await fetch("./data/snapshot.json", { cache: "no-store" })).json();
  db.version = snap.version || 0;
  db.published_at = snap.published_at || null;
  db.published_by = snap.published_by || null;
  const live = (rows) => (rows || []).filter((r) => !r.deleted_at);
  db.people = live(snap.people).map((p) => ({ ...p, avatar: relAvatar(p.avatar) }));
  db.accounts = live(snap.accounts);
  db.transactions = live(snap.transactions);
  db.plan_targets = live(snap.plan_targets).map((r) => ({ ...r, data: typeof r.data === "string" ? safeParse(r.data) : (r.data || {}) }));
})();

const safeParse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const getAccount = (id) => db.accounts.find((a) => a.id === id);
const getTxn = (id) => db.transactions.find((t) => t.id === id);

function handle(route, method, body) {
  const [path, qs] = route.split("?");
  const q = new URLSearchParams(qs || "");

  // ---- people / accounts ----
  if (path === "/api/people" && method === "GET") {
    const people = [...db.people].sort((a, b) => (a.sort_order - b.sort_order) || String(a.name).localeCompare(b.name));
    return json({ people });
  }
  if (path === "/api/accounts" && method === "GET") {
    const accounts = db.accounts.map((a) => {
      const led = accountLedger(db.transactions, a);
      return { ...a, txn_count: led.length, balance: led.length ? led[led.length - 1].running_balance : Number(a.opening_balance) || 0 };
    });
    return json({ accounts });
  }

  // ---- transactions ----
  if (path === "/api/transactions" && method === "GET") {
    const accountId = q.get("account_id"), owner = q.get("owner");
    let rows = db.transactions;
    if (owner) rows = rows.filter((t) => t.owner === owner);
    if (accountId) {
      const acct = getAccount(accountId);
      if (!acct) return json({ error: "account not found" }, 404);
      const ledger = accountLedger(rows, acct);
      return json({ account: acct, transactions: ledger, totals: totals(ledger) });
    }
    return json({ transactions: withRunningBalance(rows), totals: totals(rows) });
  }
  if (path === "/api/transactions" && method === "POST") {
    const acct = getAccount(body?.account_id);
    if (!acct) return json({ error: "valid account_id is required" }, 400);
    const ts = nowISO();
    const rec = { id: body.id || uuid(), account_id: body.account_id, owner: body.owner || acct.owner, txn_date: body.txn_date,
      description: body.description ?? "", source: body.source ?? "", deposit: Number(body.deposit) || 0,
      withdrawal: Number(body.withdrawal) || 0, note: body.note ?? "", created_at: ts, updated_at: ts, deleted_at: null };
    db.transactions.push(rec);
    return json({ transaction: rec }, 201);
  }
  const txMatch = path.match(/^\/api\/transactions\/(.+)$/);
  if (txMatch) {
    const t = getTxn(txMatch[1]);
    if (!t) return json({ error: "transaction not found" }, 404);
    if (method === "PATCH") {
      for (const k of ["account_id", "owner", "txn_date", "description", "source", "note"]) if (k in (body || {})) t[k] = body[k];
      if ("deposit" in (body || {})) t.deposit = Number(body.deposit) || 0;
      if ("withdrawal" in (body || {})) t.withdrawal = Number(body.withdrawal) || 0;
      t.updated_at = nowISO();
      return json({ transaction: t });
    }
    if (method === "DELETE") { db.transactions = db.transactions.filter((x) => x.id !== t.id); return json({ ok: true }); }
  }

  // ---- plan targets ----
  if (path === "/api/plan-targets" && method === "GET") {
    let rows = db.plan_targets;
    if (q.get("owner")) rows = rows.filter((r) => r.owner === q.get("owner"));
    if (q.get("kind")) rows = rows.filter((r) => r.kind === q.get("kind"));
    return json({ plan_targets: rows });
  }
  if (path === "/api/plan-targets" && method === "POST") {
    const ts = nowISO();
    const rec = { id: body.id || uuid(), owner: body.owner || "shared", kind: body.kind, name: body.name ?? "", data: body.data ?? {}, created_at: ts, updated_at: ts, deleted_at: null };
    db.plan_targets.push(rec);
    return json({ plan_target: rec }, 201);
  }
  const ptMatch = path.match(/^\/api\/plan-targets\/(.+)$/);
  if (ptMatch) {
    const pt = db.plan_targets.find((r) => r.id === ptMatch[1]);
    if (!pt) return json({ error: "plan target not found" }, 404);
    if (method === "PATCH") { for (const k of ["owner", "kind", "name", "data"]) if (k in (body || {})) pt[k] = body[k]; pt.updated_at = nowISO(); return json({ plan_target: pt }); }
    if (method === "DELETE") { db.plan_targets = db.plan_targets.filter((r) => r.id !== pt.id); return json({ ok: true }); }
  }

  // ---- sync (no-ops on the static site) ----
  if (path === "/api/sync-status") return json({ local_version: db.version, last_published_at: db.published_at, published_by: db.published_by, last_pulled_version: db.version, last_pulled_at: db.published_at });
  if (path === "/api/publish" || path === "/api/refresh") return json({ ok: true, version: db.version, pushed: false, readonly: true });
  if (path === "/api/health") return json({ ok: true, meta: {} });

  return json({ error: "not available on the published site" }, 404);
}

// Install the shim: intercept /api/* only, pass everything else through.
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  const idx = url.indexOf("/api/");
  if (idx === -1) return realFetch(input, init);
  await ready;
  const method = (init.method || "GET").toUpperCase();
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
  return handle(url.slice(idx), method, body);
};

// --- read-only chrome: banner, published nav, hide save/publish controls -----
function decorate() {
  if (document.getElementById("ro-banner")) return;
  const style = document.createElement("style");
  style.textContent = `
    #ro-banner { position: sticky; top: 0; z-index: 30; background: var(--accent-weak, #24304b); color: var(--text, #e7e9ee);
      border-bottom: 1px solid var(--line, #2a2f3a); padding: 8px 16px; font-size: 13px; text-align: center; }
    #ro-banner b { color: var(--warn, #e0a336); }
    #saveBtn, #discardBtn, #publishBtn, #refreshBtn, #dirtyNote, #lowPowerBtn { display: none !important; }`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "ro-banner";
  bar.innerHTML = `🔒 <b>Read-only published view.</b> Edit any value to explore the math — nothing here is saved.`;
  document.body.prepend(bar);

  // Rewrite the nav to the published pages only (Plan editing stays local).
  const nav = document.querySelector(".nav");
  if (nav) {
    const here = location.pathname.split("/").pop() || "index.html";
    const links = [["index.html", "Dashboard"], ["ledger.html", "Ledger"], ["paycheck.html", "This Paycheck"]];
    nav.innerHTML = links.map(([href, label]) =>
      `<a href="./${href}"${(here === href || (here === "" && href === "index.html")) ? ' class="active"' : ""}>${label}</a>`).join("");
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorate);
else decorate();
