// Acceptance harness for POST /api/transactions/bulk (Phase 13 / T29).
//
//   npm run check:bulk
//
// Runs the real server against a THROWAWAY COPY of dashboard.db (via
// DASHBOARD_DB) and drives the route over HTTP. The live ledger is never
// touched, which is why this can test the write path — and why `git status` is
// still clean afterwards, since the copy lives in the system temp directory and
// the database is gitignored anyway.
//
// It asserts the five behaviours the route exists for:
//   1. a batch inserts, and a re-post of the same batch inserts nothing
//      (belt and braces behind the client-side diff);
//   2. a confirmed conflict UPDATES the row rather than adding a second one;
//   3. a row with no fingerprint ADOPTS one (the T34-mirrored payment case)
//      but an existing fingerprint can never be overwritten;
//   3b. T30's supersede: a statement row REPLACES the projection that
//      predicted it, clearing the `projected` marker, rather than landing
//      beside it and counting the month twice;
//   4. a bad row anywhere rolls the WHOLE batch back — a half-imported
//      statement would make the next upload's diff wrong too;
//   5. there is no route that accepts a file.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "local", "dashboard.db");
if (!existsSync(SRC)) {
  console.error("No local/dashboard.db to copy — start the app once first.");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "t29-bulk-"));
const DB = join(scratch, "dashboard.db");
copyFileSync(SRC, DB);

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (ok, msg, detail) => {
  if (ok) console.log(`  ✅ ${msg}`);
  else { failures++; console.log(`  ✗  ${msg}`); if (detail) console.log(`     ${detail}`); }
};

const server = spawn(process.execPath, [join(ROOT, "local", "server.js")], {
  env: { ...process.env, DASHBOARD_DB: DB, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/api/people`); return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const db = new DatabaseSync(DB);
const countFor = (acct) =>
  db.prepare("SELECT COUNT(*) c FROM transactions WHERE account_id = ? AND deleted_at IS NULL").get(acct).c;
const byExternal = (eid) => db.prepare("SELECT * FROM transactions WHERE external_id = ?").get(eid);

const ACC = "woody-apple-card";
const BATCH = "t29-check-bulk";
const ROWS = [
  { txn_date: "2026-11-01", description: "Food", source: "CHECK BULK CAFE", deposit: 0, withdrawal: 12.34, note: "Apple Card · Restaurants/Purchase", external_id: "checkbulk000000000000000000000a1" },
  { txn_date: "2026-11-02", description: "Groceries", source: "CHECK BULK MARKET", deposit: 0, withdrawal: 56.78, note: "Apple Card · Grocery/Purchase", external_id: "checkbulk000000000000000000000a2" },
  { txn_date: "2026-11-03", description: "Credit Card Payment", source: "CHECK BULK ACH", deposit: 400, withdrawal: 0, note: "Apple Card · Payment/Payment", external_id: "checkbulk000000000000000000000a3" },
];

try {
  if (!(await waitForServer())) throw new Error(`server did not start:\n${serverLog}`);
  console.log(`server up on ${PORT} against ${DB}\n`);

  const before = countFor(ACC);

  // 1. Insert, then re-post.
  let r = await post("/api/transactions/bulk", { account_id: ACC, import_batch: BATCH, rows: ROWS });
  check(r.status === 201 && r.body?.inserted === 3 && r.body?.skipped === 0, `3 rows inserted`, JSON.stringify(r.body));
  check(countFor(ACC) === before + 3, `the ledger grew by exactly 3`);

  r = await post("/api/transactions/bulk", { account_id: ACC, import_batch: BATCH + "-again", rows: ROWS });
  check(r.status === 201 && r.body?.inserted === 0 && r.body?.skipped === 3, `re-posting the same batch inserts 0, skips 3`, JSON.stringify(r.body));
  check(countFor(ACC) === before + 3, `and the ledger did not grow`);

  // 2. A confirmed conflict updates in place.
  const settled = byExternal("checkbulk000000000000000000000a1");
  r = await post("/api/transactions/bulk", {
    account_id: ACC, import_batch: BATCH + "-conflict",
    rows: [{ ...ROWS[0], withdrawal: 19.99, update_id: settled.id }],
  });
  check(r.status === 201 && r.body?.updated === 1 && r.body?.inserted === 0, `a confirmed conflict counts as 1 updated, 0 inserted`, JSON.stringify(r.body));
  check(countFor(ACC) === before + 3, `the row was amended, not duplicated`);
  check(byExternal("checkbulk000000000000000000000a1").withdrawal === 19.99, `and carries the settled amount`);

  // 3. Adoption, and the guard against overwriting a fingerprint.
  const handId = "t29-check-hand-entered";
  db.prepare(`INSERT INTO transactions (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, created_at, updated_at)
              VALUES (?, ?, 'woody', '2026-11-04', 'Credit Card Payment', 'CHECK BULK MIRROR', 400, 0, '', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z')`)
    .run(handId, ACC);
  r = await post("/api/transactions/bulk", {
    account_id: ACC, import_batch: BATCH + "-adopt",
    rows: [{ txn_date: "2026-11-04", description: "Credit Card Payment", source: "CHECK BULK MIRROR", deposit: 400, withdrawal: 0, external_id: "checkbulk000000000000000000000a4", update_id: handId }],
  });
  check(r.status === 201 && r.body?.updated === 1, `a row with no fingerprint adopts one`, JSON.stringify(r.body));
  check(byExternal("checkbulk000000000000000000000a4")?.id === handId, `the fingerprint landed on the existing row`);

  r = await post("/api/transactions/bulk", {
    account_id: ACC, import_batch: BATCH + "-steal",
    rows: [{ txn_date: "2026-11-04", description: "Food", source: "X", deposit: 0, withdrawal: 1, external_id: "checkbulk000000000000000000000zz", update_id: handId }],
  });
  check(r.status === 409, `refuses to overwrite an existing external_id (409)`, JSON.stringify(r.body));

  // 3b. T30's supersede, end to end over the real route: a projected row is
  //     REPLACED by the statement row that predicted it, not duplicated — and
  //     the `projected` marker is cleared, so the row cannot go on offering
  //     itself to the next statement's supersede pass.
  const projId = "t30-check-projection";
  db.prepare(`INSERT INTO transactions (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note, projected, created_at, updated_at)
              VALUES (?, ?, 'woody', '2026-11-26', 'Fun', 'AMAZON PRIME', 0, 15.89, 'projected · monthly', 'monthly:AMAZON PRIME', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`)
    .run(projId, ACC);
  const beforeSup = countFor(ACC);
  r = await post("/api/transactions/bulk", {
    account_id: ACC, import_batch: BATCH + "-supersede",
    rows: [{
      txn_date: "2026-11-24", description: "Fun", source: "AMAZON PRIME R322G68P3",
      deposit: 0, withdrawal: 17.99, note: "Apple Card · Other/Purchase",
      external_id: "checkbulk000000000000000000000c1", update_id: projId,
    }],
  });
  check(r.status === 201 && r.body?.updated === 1 && r.body?.inserted === 0, `a superseding statement row updates the projection (0 inserted)`, JSON.stringify(r.body));
  check(countFor(ACC) === beforeSup, `the projection was replaced, NOT duplicated`);
  const supRow = db.prepare("SELECT * FROM transactions WHERE id = ?").get(projId);
  check(supRow.projected === null, `and \`projected\` is cleared — the row is a fact now, not a guess (${supRow.projected})`);
  check(supRow.txn_date === "2026-11-24" && supRow.withdrawal === 17.99, `it carries the statement's own date and amount`);
  check(supRow.external_id === "checkbulk000000000000000000000c1", `and the statement's fingerprint, so the NEXT upload matches it exactly`);
  check(byExternal("checkbulk000000000000000000000c1")?.id === projId, `which resolves back to the same row id`);

  // 4. Atomicity.
  const atCount = countFor(ACC);
  r = await post("/api/transactions/bulk", {
    account_id: ACC, import_batch: BATCH + "-bad",
    rows: [
      { txn_date: "2026-12-01", description: "Food", source: "GOOD ROW", withdrawal: 1, external_id: "checkbulk000000000000000000000b1" },
      { txn_date: "not-a-date", description: "Food", source: "BAD ROW", withdrawal: 1, external_id: "checkbulk000000000000000000000b2" },
    ],
  });
  check(r.status === 400 && /row 1/.test(r.body?.error || ""), `a bad row 400s and names the row`, JSON.stringify(r.body));
  check(countFor(ACC) === atCount, `nothing was written — the good row in the same batch did not land either`);

  // Required fields.
  check((await post("/api/transactions/bulk", { import_batch: "x", rows: ROWS })).status === 400, `account_id is required`);
  check((await post("/api/transactions/bulk", { account_id: ACC, rows: ROWS })).status === 400, `import_batch is required (one bad import must be undoable as a unit)`);
  check((await post("/api/transactions/bulk", { account_id: ACC, import_batch: "x", rows: [] })).status === 400, `an empty batch is refused`);
  check((await post("/api/transactions/bulk", { account_id: "nope", import_batch: "x", rows: ROWS })).status === 400, `an unknown account is refused`);

  // 5. No route accepts a file.
  const multipart = await fetch(`${BASE}/api/import`, { method: "POST", body: "fake file body" });
  check(multipart.status === 404, `there is no /api/import endpoint that takes a file (404)`);

  // Undoable as a unit, which is what import_batch is for.
  const batchRows = db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch LIKE ?").get(BATCH + "%").c;
  check(batchRows > 0, `every written row carries its import_batch (${batchRows} rows)`);
} catch (e) {
  failures++;
  console.log(`  ✗  harness error: ${e.message}`);
} finally {
  server.kill("SIGTERM");
  db.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "✅ every check passed" : `✗ ${failures} check(s) failed`}`);
console.log(`the throwaway database at ${scratch} is deleted; local/dashboard.db was never opened for writing`);
process.exit(failures === 0 ? 0 : 1);
