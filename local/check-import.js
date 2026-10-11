// Acceptance harness for shared/statement-import.js (Phase 13 / T29).
//
//   npm run check:import
//
// READ-ONLY. It never writes to the database and never writes a file; the
// statements it reads are staged outside the repo (decision #26/#27).
//
// The headline test is the **known-good diff**, and it is only possible because
// T26b loaded the card ledgers by hand and reconciled every card to the cent
// first. So the correct answer for each statement is already sitting in
// `dashboard.db`, established independently of this parser, and the test is:
//
//     run the uploader over an already-loaded statement
//       → 0 fresh rows, 0 conflicts, and identical categorization
//         (first pass + T30's card_rules — see `cardRules` below)
//
// Any difference is unambiguously an adapter bug rather than a question about
// the input, which is the whole reason the bootstrap was decoupled from the
// feature. The 911 rows it diffs against were written by T26b's own adapters,
// so agreement is a genuine cross-check of two implementations and not a
// tautology — T29's adapters were written from T25's recorded header table, in
// a different file, with a different structure.
//
// Then four tests that do not depend on the real data being present:
//   2. overlap        — a statement overlapping a loaded period by two weeks
//                       inserts only the genuinely new rows.
//   3. sign flip      — a deliberately inverted fixture is caught by an adapter
//                       assertion rather than silently importing refunds as
//                       purchases. Run per issuer, because each one is caught
//                       by a DIFFERENT assertion.
//   4. generic mapper — an unrecognized header round-trips through a column map
//                       with no data loss.
//   5. diff mechanics — pending→settled becomes an update, a T34-mirrored
//                       payment is matched rather than duplicated, and two
//                       same-day same-amount charges both survive.
//
// Tests 3–5 are synthetic by necessity and say so. Test 1 is the real one.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readStatement,
  detectIssuer,
  diffAgainstLedger,
  StatementImportError,
  ADAPTERS,
} from "../shared/statement-import.js";
import { parseCsvRecords } from "../shared/csv.js";
import { RULE_KIND, compileRules, applyRules } from "../shared/card-rules.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = join(process.env.HOME || "", "Downloads", "CSVs");
const DB_FILE = join(ROOT, "local", "dashboard.db");

const money = (n) => (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(10);
let failures = 0;
const pass = (msg) => console.log(`     ✅ ${msg}`);
const fail = (msg, detail) => {
  failures++;
  console.log(`     ✗  ${msg}`);
  if (detail) console.log(detail.split("\n").map((l) => `        ${l}`).join("\n"));
};
const check = (ok, msg, detail) => (ok ? pass(msg) : fail(msg, detail));
const head = (title) => console.log(`\n${"═".repeat(84)}\n${title}\n${"═".repeat(84)}`);

// Which account each staged file belongs to. The mapping is T25(a)'s, proven by
// matching every checking-side payment against the card-side payment rows; it
// is not a guess and it is not derived from the filename inside the importer —
// `detectIssuer` works off the header signature alone, which test 1 asserts.
const FILES = [
  { file: "Woody_Apple.csv", accountId: "woody-apple-card", issuer: "Apple Card" },
  { file: "Woody_Citi.CSV", accountId: "woody-citi-card", issuer: "Citi" },
  { file: "Rajna_Capital_One.csv", accountId: "rajna-capital-one", issuer: "Capital One" },
  { file: "Rajna_Discover.csv", accountId: "rajna-discover", issuer: "Discover" },
  { file: "Rajna_Chase.csv", accountId: "rajna-chase", issuer: "Chase" },
];

const haveStatements = existsSync(STAGING);
const haveDb = existsSync(DB_FILE);
const db = haveDb ? new DatabaseSync(DB_FILE, { readOnly: true }) : null;
const ledgerFor = (accountId) =>
  db ? db.prepare("SELECT * FROM transactions WHERE account_id = ? AND deleted_at IS NULL").all(accountId) : [];

// T30's merchant rules, read from the database the same way the app reads them.
//
// WHY THIS IS HERE. Test 1(c) compares the importer's category against the
// ledger's, row by row — and T30's bulk pass deliberately re-categorized 153 of
// the loaded rows in place (`Misc` → Groceries / Transportation / Bill / Fun /
// Adjustment). So the ledger is no longer the importer's FIRST-PASS answer; it
// is the first pass with the rules applied on top. Comparing against the raw
// first pass would fail on every row a rule touched, which is the rules working
// rather than an adapter regression.
//
// This is the same amendment, for the same reason, that turned the `note` check
// into a prefix check when T34 started annotating notes: the test has to police
// what the importer owns, and the importer owns the issuer's category, not the
// household's final word on a merchant. So the comparison is
//
//     importer first pass + card_rules  ===  ledger
//
// which still fails loudly if an adapter maps the wrong raw category, because
// no rule exists for most merchants and a wrong issuer category is still a
// wrong ledger category. With no rules seeded, `rules` is empty and this is
// exactly the original assertion.
const cardRules = db
  ? compileRules(
      db.prepare("SELECT * FROM plan_targets WHERE kind = ? AND deleted_at IS NULL").all(RULE_KIND)
        .map((r) => ({ ...r, data: JSON.parse(r.data || "{}") }))
    )
  : [];

// ---------------------------------------------------------------------------
// 1. The known-good diff
// ---------------------------------------------------------------------------

head("1. known-good diff — the uploader over an already-loaded statement");

if (!haveStatements || !haveDb) {
  console.log(
    `  ⚠  skipped: ${!haveDb ? "no local/dashboard.db" : `no staged statements at ${STAGING}`}.\n` +
      `     This is the only test that uses real data; the rest run regardless.\n` +
      `     The statements live outside the repo by design (decision #26/#27).`
  );
} else {
  for (const { file, accountId, issuer } of FILES) {
    const path = join(STAGING, file);
    if (!existsSync(path)) { console.log(`\n  ⚠  ${file} not staged — skipped`); continue; }
    const text = readFileSync(path, "utf8");

    console.log(`\n  ${file}  →  ${accountId}`);

    // (a) The issuer is detected off the header SIGNATURE, not the filename.
    let det = null;
    try {
      det = detectIssuer(parseCsvRecords(text).header);
    } catch (e) {
      fail(`detectIssuer threw: ${e.message}`);
    }
    check(det?.issuer === issuer, `detected as ${det?.issuer ?? "(nothing)"} from the header alone (expected ${issuer})`);

    let r;
    try {
      r = readStatement(text, { accountId });
    } catch (e) {
      fail(`readStatement threw ${e.code ?? ""}: ${e.message}`);
      continue;
    }
    if (r.needsMapping) { fail("fell through to the generic mapper — detectIssuer missed it"); continue; }

    const existing = ledgerFor(accountId);
    const d = diffAgainstLedger(r.rows, existing);

    console.log(
      `     ${r.rowCount} rows parsed  ·  span ${r.span.join(" → ")}  ·  ledger has ${existing.length}` +
        `\n     charges ${money(d.totals.charges)}   credits ${money(d.totals.credits)}` +
        `\n     fresh ${d.counts.fresh}   duplicates ${d.counts.duplicates}   conflicts ${d.counts.conflicts}`
    );

    // (b) The headline assertion.
    check(
      d.counts.fresh === 0,
      `0 fresh rows against the loaded ledger`,
      d.counts.fresh
        ? d.fresh.slice(0, 5).map((f) => `${f.txn_date}  ${money(f.withdrawal - f.deposit)}  ${f.source}  [${f.external_id.slice(0, 12)}…]`).join("\n")
        : null
    );
    check(
      d.counts.conflicts === 0,
      `0 conflicts`,
      d.counts.conflicts
        ? d.conflicts.slice(0, 5).map((c) => `${c.row.txn_date}  ${c.row.source}  ${money(c.from)} → ${money(c.to)}`).join("\n")
        : null
    );
    check(d.counts.duplicates === r.rowCount, `all ${r.rowCount} rows matched an existing row`);

    // (c) Identical categorization — the half of the test that a pure
    //     external_id match cannot see. The fingerprint covers date, amount and
    //     merchant; it does NOT cover `description`, so an adapter could map
    //     every category wrong and still dedupe perfectly. Compared row by row
    //     against what T26b wrote, including `note`, which carries the issuer's
    //     own raw category and is what T30's bulk pass mined.
    //
    //     The category being compared is the first pass WITH T30's merchant
    //     rules applied — see `cardRules` above for why. `ruledCategory` is
    //     keyed by external_id, which is unique per row inside a file (asserted
    //     in (d) below), so the lookup cannot cross rows.
    const ruled = applyRules(r.rows, cardRules, { accountId });
    const ruledCategory = new Map(ruled.map((x) => [x.external_id, x.description]));
    const catMismatch = [];
    const noteMismatch = [];
    let ruleAdjusted = 0;
    for (const { row, existing: ex, matched_by } of d.duplicates) {
      if (matched_by !== "external_id") continue;
      const expected = ruledCategory.get(row.external_id) ?? row.description;
      if (expected !== row.description) ruleAdjusted++;
      if (expected !== ex.description) catMismatch.push({ row, ex, expected });
      // A PREFIX, not an equality. The importer's note is
      // `issuer · <raw category>` and that part must match exactly — it is the
      // issuer's own words, and getting it wrong means T30's bulk categorize
      // pass mines the wrong string. What a later task APPENDS is legitimately
      // not the importer's business: T34 stamps `[t34-backfill-…]` onto the
      // card-side payments it pairs, and asserting byte equality here would
      // turn every downstream annotation into a failure of this adapter.
      if (!(ex.note ?? "").startsWith(row.note ?? "")) noteMismatch.push({ row, ex });
    }
    check(
      catMismatch.length === 0,
      `identical categorization on all ${d.counts.duplicates} rows` +
        (ruleAdjusted ? ` (${ruleAdjusted} via a card_rule)` : ""),
      catMismatch.length
        ? catMismatch.slice(0, 5).map((m) => `${m.row.txn_date}  ${m.row.source}: T29 + rules say '${m.expected}' (first pass '${m.row.description}'), ledger says '${m.ex.description}'`).join("\n")
        : null
    );
    check(
      noteMismatch.length === 0,
      `the issuer raw category is intact on all ${d.counts.duplicates} rows (later annotations allowed)`,
      noteMismatch.length
        ? noteMismatch.slice(0, 5).map((m) => `${m.row.txn_date}  ${m.row.source}: '${m.row.note}' vs '${m.ex.note}'`).join("\n")
        : null
    );

    // (d) Fingerprint uniqueness within the file.
    const uniq = new Set(r.rows.map((x) => x.external_id)).size;
    check(uniq === r.rowCount, `${r.rowCount} unique external_id(s) — the fingerprint separates every row`);

    // (e) Re-reading the same text is byte-identical. Cheap, and it is what
    //     makes "re-uploading dedupes to nothing" an invariant rather than an
    //     observation: the occurrence index must not depend on anything but the
    //     rows themselves.
    const again = readStatement(text, { accountId });
    check(
      again.rows.every((x, i) => x.external_id === r.rows[i].external_id),
      `deterministic — a second parse produces the same fingerprints`
    );
    if (r.unmapped.length) console.log(`     ·  columns this adapter never reads: ${r.unmapped.join(", ")}`);
    if (r.cardsSeen.length) console.log(`     ·  card numbers seen in the export: ${r.cardsSeen.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Overlap — two weeks of an already-loaded statement plus genuinely new rows
// ---------------------------------------------------------------------------

head("2. overlap — a statement overlapping a loaded period by two weeks");

if (!haveStatements || !haveDb) {
  console.log("  ⚠  skipped (needs the staged statements and the loaded ledger)");
} else {
  // Built from the real Apple file: keep its last 14 days, then append three
  // invented rows. The expected answer is exactly 3 fresh — the overlap must
  // dedupe to nothing even though those rows are re-read from a file that looks
  // new, which is the actual mechanic a monthly upload depends on.
  const text = readFileSync(join(STAGING, "Woody_Apple.csv"), "utf8");
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(Boolean);
  const header = lines[0];
  const body = lines.slice(1);
  const dateOf = (line) => {
    const m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})/);
    return m ? `20${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  };
  const dates = body.map(dateOf).filter(Boolean).sort();
  const last = dates[dates.length - 1];
  const cutoff = new Date(Date.parse(last) - 14 * 86400000).toISOString().slice(0, 10);
  const kept = body.filter((l) => { const d = dateOf(l); return d && d >= cutoff; });

  const NEW_ROWS = [
    "10/8/26,10/9/26,A NEW MERCHANT THAT DOES NOT EXIST,A NEW MERCHANT THAT DOES NOT EXIST,Restaurants,Purchase,41.17,Woody",
    "10/8/26,10/9/26,ANOTHER BRAND NEW ONE,ANOTHER BRAND NEW ONE,Grocery,Purchase,112.40,Woody",
    "10/9/26,10/10/26,A REFUND THAT NEVER HAPPENED,A REFUND THAT NEVER HAPPENED,Shopping,Credit,-19.99,Woody",
  ];
  const fixture = [header, ...kept, ...NEW_ROWS].join("\r\n");

  const r = readStatement(fixture, { accountId: "woody-apple-card" });
  const d = diffAgainstLedger(r.rows, ledgerFor("woody-apple-card"));
  console.log(
    `  overlap window ${cutoff} → ${last}: ${kept.length} already-loaded rows + ${NEW_ROWS.length} invented` +
      `\n  fresh ${d.counts.fresh}   duplicates ${d.counts.duplicates}   conflicts ${d.counts.conflicts}`
  );
  check(d.counts.fresh === NEW_ROWS.length, `exactly the ${NEW_ROWS.length} genuinely new rows are fresh`,
    d.counts.fresh !== NEW_ROWS.length ? d.fresh.map((f) => `${f.txn_date} ${f.source} ${money(f.withdrawal - f.deposit)}`).join("\n") : null);
  check(d.counts.duplicates === kept.length, `the ${kept.length} overlapping rows all dedupe`);
  check(d.counts.conflicts === 0, `no spurious conflicts in the overlap`);
  check(
    d.fresh.every((f) => /NEW MERCHANT|BRAND NEW|NEVER HAPPENED/.test(f.source)),
    `the fresh rows are the invented ones, by name`
  );
  // The refund among them must be a deposit, not a purchase: `Type: Credit`
  // with a negative amount is a refund and decision #22 makes it a deposit.
  const refund = d.fresh.find((f) => /NEVER HAPPENED/.test(f.source));
  check(refund && refund.deposit === 19.99 && refund.withdrawal === 0, `the invented refund lands as a $19.99 deposit`);
}

// ---------------------------------------------------------------------------
// 3. Sign-flipped fixtures — one per issuer
// ---------------------------------------------------------------------------

head("3. sign flip — an inverted fixture must be CAUGHT, not imported");

// Synthetic, and small on purpose: each fixture is the minimum number of rows
// that exercises the assertion that catches that issuer. The point is not
// volume, it is that each issuer is caught by an assertion grounded in evidence
// the issuer itself gave us, independent of the amount's sign:
//
//   Apple        `Type: Payment` on a row that came out as a charge
//   Citi         its `Credit` column carrying a positive value
//   Capital One  its `Credit` column carrying a negative value
//   Discover     an `Interest` row that came out as a credit
//   Chase        unflippable by construction — the sign is applied, not read
//
// Flipping Discover is the interesting case: its payments are identified by
// `amount < 0 && /PAYMENT/`, so a flipped file's payments stop being recognized
// as payments and the polarity check on PAYMENTS goes blind. Interest is what
// catches it — a card does not pay you interest.

const FIXTURES = {
  "Apple Card": {
    good:
      "Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n" +
      "9/1/26,9/2/26,COFFEE,COFFEE,Restaurants,Purchase,12.50,Woody\n" +
      "9/2/26,9/3/26,RETURN,COFFEE,Restaurants,Credit,-12.50,Woody\n" +
      "9/5/26,9/6/26,ACH DEPOSIT INTERNET TRANSFER,ACH Deposit Internet Transfer,Payment,Payment,-400.00,Woody\n" +
      "9/30/26,9/30/26,INTEREST CHARGE,Interest Charge,Interest,Interest,207.35,Woody\n",
    expect: "payment-is-a-charge",
  },
  Citi: {
    good:
      "Status,Date,Description,Debit,Credit\n" +
      "Cleared,9/1/26,DUNKIN #354365 DACULA GA null XXXXXXXXXXXX3676,8.46,\n" +
      "Cleared,9/2/26,PUBLIX SUPER MAR null XXXXXXXXXXXX3676,91.90,\n" +
      "Cleared,9/18/26,AUTOPAY 000000731685743 AUTO-PMT,,-66.00\n",
    expect: "credit-column-sign",
  },
  "Capital One": {
    good:
      "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n" +
      "2026-09-01,2026-09-02,4993,UBER *ONE MEMBERSHIP,Fee/Interest Charge,9.99,\n" +
      "2026-09-02,2026-09-03,4993,PUBLIX,Merchandise,42.17,\n" +
      "2026-09-15,2026-09-16,4993,CAPITAL ONE MOBILE PYMT,Payment/Credit,,415.33\n",
    expect: "credit-column-sign",
  },
  Discover: {
    good:
      "Trans. Date,Post Date,Description,Amount,Category\n" +
      "9/1/26,9/2/26,WALMART,64.12,Merchandise\n" +
      "9/2/26,9/3/26,KROGER,88.40,Supermarkets\n" +
      "9/3/26,9/4/26,INTERNET PAYMENT - THANK YOU,-400.00,Payments and Credits\n" +
      "9/30/26,9/30/26,03/04/2025 AND AFTER - INTEREST CHARGE ON PURCHASES,121.44,Interest\n",
    expect: "interest-is-a-credit",
  },
};

// Negate every amount in the fixture — the exact mistake the assertions exist
// to catch, and the one a hand-written adapter makes by reading a split export
// with the other issuer's convention.
const flipSigned = (csv, col) => {
  const { header } = parseCsvRecords(csv);
  const idx = header.indexOf(col);
  return csv
    .split("\n")
    .map((line, i) => {
      if (i === 0 || !line.trim()) return line;
      const cells = line.split(",");
      const v = cells[idx];
      if (v && v.trim()) cells[idx] = v.trim().startsWith("-") ? v.trim().slice(1) : `-${v.trim()}`;
      return cells.join(",");
    })
    .join("\n");
};
// For a split export, "flipped" means read with the OTHER issuer's convention,
// which is equivalent to negating its credit column.
const flipSplit = (csv) => flipSigned(csv, "Credit");

for (const [issuer, { good, expect }] of Object.entries(FIXTURES)) {
  console.log(`\n  ${issuer}`);
  // The good fixture must import cleanly first, or the test proves nothing.
  try {
    const r = readStatement(good, { accountId: "fixture-account" });
    check(r.issuer === issuer, `the honest fixture parses as ${issuer} with no complaint (${r.rowCount} rows)`);
    check(r.warnings.length === 0, `no assertion fires on correct data`);
  } catch (e) {
    fail(`the honest fixture was rejected: ${e.code ?? ""} ${e.message}`);
    continue;
  }

  const adapter = ADAPTERS.find((a) => a.issuer === issuer);
  const flipped = adapter.amount.kind === "split" ? flipSplit(good) : flipSigned(good, adapter.amount.column);
  let caught = null;
  try {
    readStatement(flipped, { accountId: "fixture-account" });
  } catch (e) {
    caught = e;
  }
  check(caught instanceof StatementImportError, `the flipped fixture throws rather than importing`);
  const codes = (caught?.detail?.problems ?? []).map((p) => p.code);
  check(codes.includes(expect), `caught by the \`${expect}\` assertion`, caught ? `codes: ${codes.join(", ") || "(none)"}\n${caught.message}` : null);

  // ... and `force` is the only way past it, deliberately: the review modal
  // offers it for a genuine export change, as a choice the user makes.
  let forced = null;
  try { forced = readStatement(flipped, { accountId: "fixture-account", force: true }); } catch (e) { /* ignore */ }
  check(!!forced && forced.warnings.length > 0, `--force imports it but keeps the warning attached`);
}

console.log(`\n  Chase`);
{
  // Chase's amount is `$40.00 ` and is ALWAYS an outflow, so the sign is
  // applied rather than read. Negating the column must change nothing: there is
  // no sign to get wrong, which is why this adapter has no flip test to pass —
  // it has an invariant to demonstrate.
  const good =
    "Payment date  and details,Status,Amount\n" +
    "14-May-26,Completed,$90.00 \n" +
    "14-Jun-26,Completed,$40.00 \n" +
    "27-Oct-26,Pending ,$40.00 \n";
  const r = readStatement(good, { accountId: "fixture-account" });
  check(r.issuer === "Chase", `detected despite the double space in \`Payment date  and details\``);
  check(r.rows.every((x) => x.deposit > 0 && x.withdrawal === 0), `all three rows are payments (deposits)`);
  const flipped = flipSigned(good, "Amount");
  const r2 = readStatement(flipped, { accountId: "fixture-account" });
  check(
    r2.rows.every((x, i) => x.external_id === r.rows[i].external_id),
    `negating its Amount column changes nothing — the sign is applied, not read`
  );
  check(r.rows[2].txn_date === "2026-10-27", `the future-dated Pending row is kept at its transaction date`);
  check(/pending/.test(r.rows[2].note), `and its pending-ness is on the note, visible rather than implied`);
}

// ---------------------------------------------------------------------------
// 4. The generic mapper
// ---------------------------------------------------------------------------

head("4. generic mapper — the fifth issuer nobody planned for");

{
  const unknown =
    "Posting Day,Payee Name,Merchant Type,Money Out,Money In,Reference\n" +
    "2026-09-01,TESCO EXPRESS,Groceries,43.19,,REF-001\n" +
    "2026-09-02,SHELL FORECOURT,Fuel,61.00,,REF-002\n" +
    "2026-09-14,DIRECT DEBIT PAYMENT,Payment,,250.00,REF-003\n";

  const det = detectIssuer(parseCsvRecords(unknown).header);
  check(det === null, `an unrecognized header is not force-matched to an adapter`);

  const r1 = readStatement(unknown, { accountId: "some-card" });
  check(r1.needsMapping === true, `it asks for a mapping instead of throwing`);
  check(r1.rows.length === 0, `and returns no rows until it has one`);
  const names = r1.columns.map((c) => c.name);
  check(
    names.length === 6 && names.join(",") === "Posting Day,Payee Name,Merchant Type,Money Out,Money In,Reference",
    `every column is reported back for the UI to map (${names.length})`
  );
  const guesses = Object.fromEntries(r1.columns.map((c) => [c.name, c.guess]));
  console.log(`  column guesses: ${r1.columns.map((c) => `${c.name}→${c.guess ?? "?"}`).join("  ")}`);
  check(guesses["Posting Day"] === "date", `the date column is guessed`);
  check(guesses["Payee Name"] === "merchant", `the merchant column is guessed`);
  check(guesses["Money In"] === "credit" || guesses["Money In"] === "amount", `the money columns are recognized as numeric`);

  // The map the user confirms once, saved to accounts.data.column_map.
  const column_map = {
    issuer: "Some Bank",
    date: "Posting Day",
    date_format: "iso",
    merchant: "Payee Name",
    category: "Merchant Type",
    amount: { kind: "split", debit: "Money Out", credit: "Money In", creditSign: 1 },
    payment_match: "DIRECT DEBIT|PAYMENT",
    category_map: { Groceries: "Groceries", Fuel: "Transportation" },
  };
  const r2 = readStatement(unknown, { accountId: "some-card", columnMap: column_map });
  check(!r2.needsMapping && r2.rows.length === 3, `with the map, all 3 rows normalize`);
  check(r2.generic === true && r2.issuer === "Some Bank", `the rows are attributed to the mapped issuer`);
  const [a, b, c] = r2.rows;
  check(a.txn_date === "2026-09-01" && a.withdrawal === 43.19 && a.description === "Groceries", `row 1: date, amount and mapped category`);
  check(b.description === "Transportation", `row 2: the mapped category table is used`);
  check(c.deposit === 250 && c.kind === "payment" && c.description === "Credit Card Payment", `row 3: the payment is a deposit`);
  check(r2.rows.every((x) => !!x.external_id), `every row is fingerprinted like any other import`);
  // No data loss: the unread columns are reported AND every original cell is
  // still on the row for the review modal to show.
  check(r2.unmapped.includes("Reference"), `the column the map never names is reported as unmapped, not dropped`);
  check(r2.rows.every((x) => x.raw.Reference && Object.keys(x.raw).length === 6), `and every original cell survives on the row`);
  check(
    r2.rows.every((x) => /^Some Bank · /.test(x.note)),
    `the issuer's own category is preserved on the note for T30 to mine`
  );

  // A map that no longer fits the file says which column went missing.
  let stale = null;
  try {
    readStatement(unknown.replace("Payee Name", "Payee"), { accountId: "some-card", columnMap: column_map });
  } catch (e) { stale = e; }
  check(stale?.code === "column-map-stale", `a stale saved map names the missing column instead of importing blanks`,
    stale ? stale.message : "no error thrown");

  // An ambiguous date column must be asked about, not guessed. 03/04/2026 is
  // March 4th or April 3rd depending on which side of the Atlantic wrote it.
  const ambiguous = "D,Payee,Out\n03/04/2026,X,10.00\n05/06/2026,Y,11.00\n";
  let amb = null;
  try {
    readStatement(ambiguous, {
      accountId: "some-card",
      columnMap: { date: "D", date_format: "auto", merchant: "Payee", amount: { kind: "signed", column: "Out", purchaseSign: 1 } },
    });
  } catch (e) { amb = e; }
  check(amb?.code === "ambiguous-date-format", `an ambiguous M/D vs D/M column is refused rather than guessed`);
}

// ---------------------------------------------------------------------------
// 5. Diff mechanics
// ---------------------------------------------------------------------------

head("5. diff mechanics — updates, mirrored payments, and same-day collisions");

{
  const ACC = "fixture-card";
  const csv = (rows) => "Trans. Date,Post Date,Description,Amount,Category\n" + rows.join("\n") + "\n";
  const asLedger = (rows, extra = {}) =>
    rows.map((r, i) => ({
      id: `row-${i}`,
      account_id: ACC,
      txn_date: r.txn_date,
      description: r.description,
      source: r.source,
      deposit: r.deposit,
      withdrawal: r.withdrawal,
      note: r.note,
      external_id: r.external_id,
      transfer_id: null,
      deleted_at: null,
      ...extra,
    }));

  // (a) Two genuine same-day same-amount charges at one merchant both survive a
  //     re-upload. This is what the occurrence index is FOR: without it the
  //     second Starbucks run is indistinguishable from a duplicate and gets
  //     dropped forever.
  const twice = csv(["9/1/26,9/2/26,STARBUCKS #1234,5.75,Restaurants", "9/1/26,9/2/26,STARBUCKS #1234,5.75,Restaurants"]);
  const first = readStatement(twice, { accountId: ACC });
  check(first.rows.length === 2, `two same-day same-amount charges parse as two rows`);
  check(first.rows[0].external_id !== first.rows[1].external_id, `and get different fingerprints (the occurrence index)`);
  const reupload = diffAgainstLedger(readStatement(twice, { accountId: ACC }).rows, asLedger(first.rows));
  check(reupload.counts.duplicates === 2 && reupload.counts.fresh === 0, `re-uploading the same file dedupes BOTH to nothing`);

  // (b) A pending charge that settles at a different amount is an UPDATE, not a
  //     duplicate and not a second row. The fingerprint contains the amount, so
  //     this can only be found on the looser date+merchant key.
  const pending = readStatement(csv(["9/3/26,9/4/26,SHELL OIL 12345678,1.00,Gasoline"]), { accountId: ACC });
  const settled = readStatement(csv(["9/3/26,9/5/26,SHELL OIL 12345678,45.12,Gasoline"]), { accountId: ACC });
  const d1 = diffAgainstLedger(settled.rows, asLedger(pending.rows));
  check(d1.counts.conflicts === 1 && d1.counts.fresh === 0, `a $1.00 hold settling at $45.12 is 1 conflict, 0 fresh`);
  check(
    d1.conflicts[0]?.from === 1 && d1.conflicts[0]?.to === 45.12 && d1.conflicts[0]?.update_id === "row-0",
    `and it carries the before/after amounts and the row id to update`
  );

  // (c) A T34-mirrored payment: the card-side deposit already exists with a
  //     transfer_id and no external_id, two days off. It must be MATCHED, not
  //     duplicated — a second copy would double-count a payment and make the
  //     card's balance wrong in the one place it is most visible.
  const payment = readStatement(csv(["9/15/26,9/16/26,INTERNET PAYMENT - THANK YOU,-400.00,Payments and Credits"]), { accountId: ACC });
  const mirrored = [{
    id: "mirror-1", account_id: ACC, txn_date: "2026-09-13", description: "Credit Card Payment",
    source: "Discover", deposit: 400, withdrawal: 0, note: "", external_id: null,
    transfer_id: "tr-1", deleted_at: null,
  }];
  const d2 = diffAgainstLedger(payment.rows, mirrored);
  check(d2.counts.fresh === 0 && d2.counts.duplicates === 1, `a payment T34 already mirrored is not re-inserted`);
  check(d2.duplicates[0]?.matched_by === "transfer_id", `matched on transfer_id + amount + a date window`);
  check(d2.duplicates[0]?.adopt_id === "mirror-1", `and offers to stamp the fingerprint onto the row that exists`);
  // Outside the window it is a real row again, not a silent match.
  const far = [{ ...mirrored[0], txn_date: "2026-08-01" }];
  check(diffAgainstLedger(payment.rows, far).counts.fresh === 1, `a transfer three weeks away is NOT matched`);

  // (d) A hand-entered row with the same date, merchant and amount but no
  //     fingerprint is a duplicate — the ledger existed before the uploader did.
  const hand = asLedger(first.rows).map((r) => ({ ...r, external_id: null }));
  const d3 = diffAgainstLedger(first.rows, hand);
  check(d3.counts.duplicates === 2 && d3.counts.fresh === 0, `hand-entered rows with no external_id still match`);
  check(d3.duplicates.every((x) => x.matched_by === "date-merchant-amount" && x.adopt_id), `on date+merchant+amount, adoptably`);

  // (e) A tombstoned row must not block a re-import: deleting a row and
  //     re-uploading the statement has to bring it back.
  const tomb = asLedger(first.rows).map((r) => ({ ...r, deleted_at: "2026-10-01T00:00:00Z" }));
  check(diffAgainstLedger(first.rows, tomb).counts.fresh === 2, `a soft-deleted row does not shadow a re-import`);
}

// ---------------------------------------------------------------------------

head(failures === 0 ? "✅ every check passed" : `✗ ${failures} check(s) failed`);
console.log(
  failures === 0
    ? "The uploader agrees with T26b's hand-loaded ledgers row for row, including categorization."
    : "Read the ✗ lines above — a difference here is an adapter bug, not a question about the input."
);
process.exit(failures === 0 ? 0 : 1);
