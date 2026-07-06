// Local authoring server — runs on each person's machine only (localhost, no auth).
// Phase 0 stands up the server, the SQLite schema, and a minimal read API plus a
// placeholder editor page. The editable ledger grid (Phase 1), plan-target editor
// (Phase 2), sync checks (Phase 3), and publish/refresh loop (Phase 4) build on this.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import db from "./db.js";
import { withRunningBalance, totals } from "../shared/metrics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

// --- API ---------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  const meta = Object.fromEntries(
    db.prepare("SELECT key, value FROM sync_meta").all().map((r) => [r.key, r.value])
  );
  res.json({ ok: true, meta });
});

app.get("/api/transactions", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM transactions WHERE deleted_at IS NULL")
    .all();
  res.json({ transactions: withRunningBalance(rows), totals: totals(rows) });
});

app.get("/api/plan-targets", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM plan_targets WHERE deleted_at IS NULL")
    .all();
  res.json({ plan_targets: rows });
});

// --- Editor UI (placeholder until Phase 1) -----------------------------

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Finance Dashboard — Local</title>
<style>body{font-family:system-ui,Arial;margin:40px;color:#222}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Finance Dashboard — local authoring app</h1>
<p>Phase 0 scaffold is running. The editable ledger and dashboard land in later phases.</p>
<ul>
  <li><a href="/api/health">/api/health</a></li>
  <li><a href="/api/transactions">/api/transactions</a></li>
  <li><a href="/api/plan-targets">/api/plan-targets</a></li>
</ul>
</body></html>`);
});

app.listen(PORT, () => {
  console.log(`Finance Dashboard (local) running at http://localhost:${PORT}`);
  console.log(`Serving from ${__dirname}`);
});
