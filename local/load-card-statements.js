// T26b — load the card ledgers directly from the supplied statements.
//
// A data task, not a feature. This is a hand-run direct SQLite write against
// files staged OUTSIDE the repo; it is deliberately NOT the app's uploader
// (resolved decisions #26/#27). The uploader is a real feature built and tested
// on its own in T29/T30 — its verification is to run over a month this script
// already loaded and find **zero fresh rows**, which is only a meaningful test
// because the answer was established by hand first.
//
//   node local/load-card-statements.js                      # dry run, all cards
//   node local/load-card-statements.js --card rajna-chase   # dry run, one card
//   node local/load-card-statements.js --card rajna-chase --commit
//   node local/load-card-statements.js --revert <import_batch>
//   node local/load-card-statements.js --ladder ladder.json # per-period checks
//
// Dry run is the DEFAULT and prints the full reconciliation before anything is
// written: load one card, read its ladder, fix, move on. Five cards at once
// with one wrong sign convention yields five wrong ledgers and no signal about
// which is at fault.
//
// Idempotent: every row carries an `external_id` (the formula lives in
// shared/card-import-spec.js so T29 adopts it verbatim) and an `import_batch`
// keyed per card, so a re-run inserts 0 rows and one bad card is undoable as a
// unit via --revert.
//
// Sign convention throughout (decision #22): debt is a NEGATIVE balance. A
// purchase/charge/interest/fee is a `withdrawal`; a payment, refund or
// statement credit is a `deposit`. `opening_balance` is negative.
//
// The parsing here is expedient by design — five issuers, five formats, one
// adapter apiece, in one file. What is NOT expedient is the arithmetic: every
// derived opening balance is replayed against a stated balance to the cent.
//
// T29 (2026-10-08) now has its own five adapters in
// shared/statement-import.js, and **these two sets are deliberately NOT
// collapsed into one.** It looks like the duplication resolved decision #51
// warns about, and it is not: #51 is about the import CONTRACT — the
// `external_id` formula and the issuer→ledger category table — which both
// paths import from shared/card-import-spec.js and therefore cannot drift on.
// The adapters are different: they are two independent readings of the same
// five files, and that independence IS T29's test. `npm run check:import`
// diffs T29's adapters against the 911 rows this script wrote and expects zero
// fresh rows and identical categorization; if the uploader imported from here,
// that check would be comparing a function to itself. This script is also
// one-time and already run, so there is no future drift to prevent — it exists
// now as the frozen oracle. shared/statement-import.js is the canonical
// adapter for anything new.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCsv } from "./import-csv.js";
import {
  assignExternalIds,
  mapIssuerCategory,
  stripCitiCardSuffix,
} from "../shared/card-import-spec.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = join(process.env.HOME || "", "Downloads", "CSVs");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? "";
};
const COMMIT = argv.includes("--commit");
const ONLY_CARD = flag("--card");
const REVERT = flag("--revert");
const LADDER_FILE = flag("--ladder");

// A fixed stamp, passed in rather than read from the clock, so a --commit of
// one card and a later --commit of the next produce comparable batch ids and a
// re-run of this script is reproducible in the journal.
const LOADED_AT = flag("--at") || new Date().toISOString();

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => (n < 0 ? "-" : " ") + "$" + Math.abs(n).toFixed(2).padStart(10);
const sum = (xs) => round2(xs.reduce((a, b) => a + b, 0));

// ---------------------------------------------------------------------------
// CSV plumbing
// ---------------------------------------------------------------------------

/**
 * Read a staged CSV into objects keyed by trimmed header.
 *
 * Three real hazards here, all found in these six files and none of them
 * cosmetic:
 *   - a **UTF-8 BOM** on Card_Totals.csv and Rajna_Chase.csv, which keys the
 *     first column as "﻿Card" and makes a lookup by name return undefined;
 *   - **CRLF** on five of six files (Rajna_Capital_One.csv alone is LF) — the
 *     `\r` would otherwise land inside the LAST column's header and value;
 *   - **non-breaking spaces** (U+00A0) inside Chase's header and inside its
 *     `Pending` status value, so `status === "Pending"` fails on a byte-exact
 *     comparison.
 * `parseCsv` already normalizes line endings; the BOM and the NBSPs are handled
 * here by replacing every Unicode space with an ASCII one before keying.
 */
function readCsvObjects(file) {
  const text = readFileSync(join(STAGING, file), "utf8").replace(/^\ufeff/, "");
  const rows = parseCsv(text);
  // Every Unicode space (NBSP included) → ASCII space, then trim.
  const clean = (s) => String(s ?? "").replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, " ").trim();
  // Header keys additionally collapse internal runs, so Chase's
  // `Payment date\u00a0\u00a0and details` keys as `Payment date and details`.
  const header = rows[0].map((h) => clean(h).replace(/\s+/g, " "));
  return rows
    .slice(1)
    .filter((r) => r.some((c) => clean(c) !== ""))
    .map((r) => Object.fromEntries(header.map((k, i) => [k, clean(r[i])])));
}

/** `$40.00 `, `-66`, `91.9`, `` → a finite number (blank is 0, not NaN). */
const num = (s) => {
  const v = String(s ?? "").replace(/[$,\s]/g, "");
  if (v === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`unparseable amount: ${JSON.stringify(s)}`);
  return n;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Five issuers, FIVE date formats — none of which T25's convention table
 * recorded, and every one of which fails silently if assumed:
 *   Apple / Citi / Discover  M/D/YY      (10/7/26)
 *   Capital One              YYYY-MM-DD  (2026-10-06)
 *   Chase                    D-Mon-YY    (27-Oct-26)
 * The two-digit years are all 20xx in this corpus; anything outside 2000-2099
 * throws rather than guessing a century.
 */
function toIso(s, fmt) {
  const v = String(s ?? "").trim();
  if (fmt === "iso") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`bad iso date: ${JSON.stringify(s)}`);
    return v;
  }
  if (fmt === "mdy") {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) throw new Error(`bad m/d/y date: ${JSON.stringify(s)}`);
    const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
    return iso(y, +m[1], +m[2]);
  }
  if (fmt === "dmony") {
    const m = v.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
    if (!m) throw new Error(`bad d-mon-y date: ${JSON.stringify(s)}`);
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) throw new Error(`bad month name: ${JSON.stringify(s)}`);
    const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
    return iso(y, mo, +m[1]);
  }
  throw new Error(`unknown date format ${fmt}`);
}

// ---------------------------------------------------------------------------
// Per-issuer adapters
// ---------------------------------------------------------------------------
//
// Each returns rows shaped `{ txn_date, source, description, deposit,
// withdrawal, note, kind }` where `kind` is this script's own classification
// (`purchase` | `payment` | `refund` | `interest` | `fee` | `balance_transfer`
// | `adjustment`), used for the reconciliation report and for pairing — it is
// not persisted.
//
// `description` is the ledger category (the first-pass guess, from
// shared/card-import-spec.js) and `note` preserves `issuer · raw category` so
// nothing the issuer said is lost before T30's bulk categorize pass runs.

const note = (issuer, raw) => `${issuer} · ${raw && raw.trim() ? raw.trim() : "uncategorized"}`;

/**
 * Apple Card. Single signed `Amount (USD)`: purchase POSITIVE, payment/refund
 * NEGATIVE. The `Type` column is load-bearing and is NOT `Category`:
 * Purchase 506 / Payment 37 / Interest 8 / Debit 7 / Credit 7 / Other 2.
 * Payments are filtered on `Type === 'Payment'` and never on the sign (#46) —
 * the 7 `Credit` rows are negative `(RETURN)` refunds and the 7 `Debit` rows
 * are positive `DAILY CASH ADJUSTMENT` clawbacks of the cashback those returns
 * earned.
 */
function adaptApple(file) {
  const ISSUER = "Apple Card";
  return readCsvObjects(file).map((r) => {
    const amount = num(r["Amount (USD)"]);
    const raw = r.Category;
    const merchant = r.Merchant || r.Description;
    let kind;
    let description;
    if (r.Type === "Payment") {
      // The ONE balance transfer on this card: 2026-05-12 -4000.00, merchant
      // `Bill Payment`. Every other payment is an ACH from a bank account or an
      // Apple Cash payment, so the merchant string identifies it exactly. It
      // moved $4,000 of debt to Citi and no money left checking (#47), so it is
      // a card-to-card `Transfer`, not a `Credit Card Payment`.
      if (merchant === "Bill Payment") {
        kind = "balance_transfer";
        description = "Transfer";
      } else {
        kind = "payment";
        description = "Credit Card Payment";
      }
    } else if (r.Type === "Interest") {
      kind = "interest";
      description = "Interest";
    } else if (r.Type === "Other" && /reversal/i.test(merchant)) {
      // 2026-06-03 +850.00, the reversal of a 2026-05-29 -850.00 payment that
      // bounced for insufficient funds. A charge in form but a bookkeeping
      // correction in substance: counting it as $850 of purchases would invent
      // spending that never happened, so it takes `Adjustment` — which
      // shared/csp.js already excludes outright and reports on its own line.
      kind = "adjustment";
      description = "Adjustment";
    } else {
      kind = amount < 0 ? "refund" : "purchase";
      description = mapIssuerCategory(ISSUER, raw);
      if (description === "Credit Card Payment") description = "Misc"; // Category=Payment w/o Type=Payment
    }
    return {
      txn_date: toIso(r["Transaction Date"], "mdy"),
      source: merchant,
      description,
      deposit: amount < 0 ? round2(-amount) : 0,
      withdrawal: amount > 0 ? round2(amount) : 0,
      note: note(ISSUER, `${raw}/${r.Type}`),
      kind,
    };
  });
}

/**
 * Citi. Split `Debit`/`Credit`, but **`Credit` is itself negative** (`-66`, not
 * `66`), so `amount = Debit + Credit` and NEVER `Debit − Credit`. This is the
 * trap T25 was written to catch: the natural reading implies an opening balance
 * of −$538.00 (a card that started with money on it); corrected, Citi
 * reconciles to the cent from exactly $0.00.
 *
 * No category column at all — every purchase is `Misc` until T30's rules run.
 * No type column either, so payments are identified on the description
 * (`AUTOPAY`/`AUTO-PMT`/`ONLINE PAYMENT`), which is 4 of 4 here.
 */
function adaptCiti(file) {
  const ISSUER = "Citi";
  const last4Seen = new Set();
  const rows = readCsvObjects(file).map((r) => {
    const amount = round2(num(r.Debit) + num(r.Credit));
    const { merchant, last4 } = stripCitiCardSuffix(r.Description);
    if (last4) last4Seen.add(last4);
    let kind;
    let description;
    if (/AUTO-?PMT|AUTOPAY|ONLINE PAYMENT/i.test(merchant)) {
      kind = "payment";
      description = "Credit Card Payment";
    } else if (/^BAL XFR\./i.test(merchant)) {
      // $5,862.14 of balance transfers IN to this card: $4,000.00 from Apple
      // (2026-05-12) and $1,862.14 from Woody's Chase (2026-05-05, which is how
      // that card got closed out). Debt arriving, not money spent (#47).
      kind = "balance_transfer";
      description = "Transfer";
    } else if (/BALANCE TRANSFER FEE|MEMBERSHIP FEE/i.test(merchant)) {
      kind = "fee";
      description = "Bill";
    } else {
      kind = amount < 0 ? "refund" : "purchase";
      description = mapIssuerCategory(ISSUER, "");
    }
    return {
      txn_date: toIso(r.Date, "mdy"),
      source: merchant,
      description,
      deposit: amount < 0 ? round2(-amount) : 0,
      withdrawal: amount > 0 ? round2(amount) : 0,
      note: note(ISSUER, r.Status ? `${r.Status}` : ""),
      kind,
    };
  });
  rows.last4Seen = [...last4Seen].sort();
  return rows;
}

/**
 * Capital One. Split `Debit`/`Credit`, both columns **positive**, so
 * `amount = Debit − Credit` — the OPPOSITE of Citi. The two split-column
 * issuers must never share an adapter.
 *
 * `Category === 'Payment/Credit'` is 22 rows but only 19 are payments: three
 * are `CREDIT-CASH BACK REWARD` / `CREDIT-REWARD REDEMPTION` statement credits.
 * Filtering on the category alone would report $57.46 of rewards as debt
 * payments and send T34 hunting for checking rows that do not exist.
 */
function adaptCapitalOne(file) {
  const ISSUER = "Capital One";
  const cardsSeen = new Set();
  const rows = readCsvObjects(file).map((r) => {
    const amount = round2(num(r.Debit) - num(r.Credit));
    const raw = r.Category;
    const merchant = r.Description;
    if (r["Card No."]) cardsSeen.add(r["Card No."]);
    let kind;
    let description;
    if (raw === "Payment/Credit") {
      if (/\bPYMT\b|PAYMENT/i.test(merchant) && !/^CREDIT-/i.test(merchant)) {
        kind = "payment";
        description = "Credit Card Payment";
      } else {
        kind = "refund";
        description = "Misc";
      }
    } else if (raw === "Fee/Interest Charge") {
      kind = /INTEREST/i.test(merchant) ? "interest" : "fee";
      description = kind === "interest" ? "Interest" : "Bill";
    } else {
      kind = amount < 0 ? "refund" : "purchase";
      description = mapIssuerCategory(ISSUER, raw);
    }
    return {
      txn_date: toIso(r["Transaction Date"], "iso"),
      source: merchant,
      description,
      deposit: amount < 0 ? round2(-amount) : 0,
      withdrawal: amount > 0 ? round2(amount) : 0,
      note: note(ISSUER, raw),
      kind,
    };
  });
  rows.last4Seen = [...cardsSeen].sort();
  return rows;
}

/**
 * Discover. Single signed `Amount`: charge POSITIVE, payment/credit NEGATIVE.
 *
 * Two traps, both live in this file:
 *   - `Category === 'Payments and Credits'` holds 17 rows, one of which
 *     (`ADORE ME INC ... -39.95`) is a **merchant refund Discover filed under
 *     payments**. Classifying on the category would inflate payments by $39.95;
 *     classifying on `/PAYMENT/` in the description gets all 16 real ones.
 *   - `FIRST LATE PAYMENT - NO FEE` is a real row at **$0.00**, which both a
 *     `if (!amount) continue` guard and a naive `/PAYMENT/` test would get
 *     wrong — hence the `amount < 0` conjunct.
 * Also note Discover bills **two** interest rows a month (a legacy pre-2025
 * tranche plus the current one), 16 rows and $2,178.41 across the window.
 */
function adaptDiscover(file) {
  const ISSUER = "Discover";
  return readCsvObjects(file).map((r) => {
    const amount = num(r.Amount);
    const raw = r.Category;
    const merchant = r.Description;
    let kind;
    let description;
    if (amount < 0 && /PAYMENT/i.test(merchant)) {
      kind = "payment";
      description = "Credit Card Payment";
    } else if (raw === "Interest") {
      kind = "interest";
      description = "Interest";
    } else if (raw === "Fees") {
      kind = "fee";
      description = "Bill";
    } else {
      kind = amount < 0 ? "refund" : "purchase";
      description = mapIssuerCategory(ISSUER, raw);
      if (description === "Credit Card Payment") description = "Misc"; // the Adore Me refund
    }
    return {
      txn_date: toIso(r["Trans. Date"], "mdy"),
      source: merchant,
      description,
      deposit: amount < 0 ? round2(-amount) : 0,
      withdrawal: amount > 0 ? round2(amount) : 0,
      note: note(ISSUER, raw),
      kind,
    };
  });
}

/**
 * Chase. Not a statement — a **payment history** (decision #49): six payments,
 * no purchases, no interest, nothing to categorize. `Amount` is `$40.00 ` with
 * a currency symbol and a trailing space and is **always an outflow**, so the
 * sign is applied here rather than read from the file.
 *
 * One row is dated 2026-10-27 and marked `Pending` (the status value carries a
 * trailing U+00A0, handled in `readCsvObjects`). It is kept, future-dated, the
 * same way the checking ledger already carries projected rows — and its
 * pending-ness is recorded on the note so it is visible rather than implied.
 */
function adaptChase(file) {
  const ISSUER = "Chase";
  return readCsvObjects(file).map((r) => {
    const detail = r["Payment date and details"] ?? r[Object.keys(r)[0]];
    const amount = Math.abs(num(r.Amount));
    return {
      txn_date: toIso(detail, "dmony"),
      source: "Payment",
      description: "Credit Card Payment",
      deposit: round2(amount),
      withdrawal: 0,
      note: note(ISSUER, r.Status ? r.Status.toLowerCase() : "payment history"),
      kind: "payment",
    };
  });
}

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------
//
// `stated` is `Card_Totals.csv`'s `Current Balance` as DEBT (positive). It is
// read from the file at run time rather than hardcoded, so the two cannot drift.

// `anchorDebt` is an opening balance known INDEPENDENTLY of Card_Totals.csv.
// It matters more than it looks: the derived opening is computed as
// `stated − net`, so replaying it forward lands on `stated` *as an identity* —
// that aggregate check cannot fail, and for a card with no anchor it tests
// nothing at all. Only an anchor (or the per-period ladder) can falsify
// anything. Stated plainly here because T25's write-up reads as though the
// aggregate replay were itself a proof of the sign convention; it is not.
const CARDS = [
  {
    id: "woody-apple-card", issuer: "Apple Card", totalsKey: "Woody Apple", file: "Woody_Apple.csv", adapt: adaptApple,
    anchorDebt: null,
    anchorWhy: "UNANCHORED — mid-history, and Card_Totals.csv's balance is the only stated figure. Needs the ladder.",
  },
  {
    id: "woody-citi-card", issuer: "Citi", totalsKey: "Woody Citi", file: "Woody_Citi.CSV", adapt: adaptCiti,
    anchorDebt: 0,
    anchorWhy: "the export is the card's COMPLETE history from account opening, so the opening must be exactly $0.00",
  },
  {
    id: "rajna-capital-one", issuer: "Capital One", totalsKey: "Rajna Capital One", file: "Rajna_Capital_One.csv", adapt: adaptCapitalOne,
    anchorDebt: 337.9,
    anchorWhy: "the first row is a $337.90 CAPITAL ONE MOBILE PYMT that zeroes the card, and the checking ledger's own 2026-03-03 withdrawal is also $337.90",
  },
  {
    id: "rajna-discover", issuer: "Discover", totalsKey: "Rajna Discover", file: "Rajna_Discover.csv", adapt: adaptDiscover,
    anchorDebt: null,
    anchorWhy: "UNANCHORED — mid-history, and Card_Totals.csv's balance is the only stated figure. Needs the ladder.",
  },
  {
    id: "rajna-chase", issuer: "Chase", totalsKey: "Rajna Chase", file: "Rajna_Chase.csv", adapt: adaptChase, exemptFromLadder: true,
    anchorDebt: 2125.15,
    anchorWhy: "decision #49 — a dormant 0% card with no purchases and no interest, so $2,125.15 − $290.00 = $1,835.15 is forced",
  },
  // woody-chase-card deliberately gets NO rows: it has no statement export at
  // all, so there is no anchor to derive an opening balance from and a lone
  // balance-transfer row would make its ledger nonsense. It is closed out at
  // $0.00 and absent from Card_Totals.csv. Everything on it is T34's to mirror
  // from the checking side, which is exactly what `seeded_range: null` tells
  // T34's guard.
];

function readCardTotals() {
  const out = {};
  for (const r of readCsvObjects("Card_Totals.csv")) {
    out[r.Card] = {
      balance: num(r["Current Balance"]),
      credit_limit: num(r["Credit Limit"]),
      apr: round2(num(r["APR (%)"])) / 100,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Replay every row from a derived opening and confirm it lands on the stated
 * balance. Per decision #45 this is **one aggregate check per card**, not the
 * N-checks-per-card ladder the task was designed around: `Card_Totals.csv`
 * states one current balance per card and no transaction export carries a
 * running-balance column. It proves the sign convention, the date-column choice
 * and aggregate completeness; it cannot localize a miss to a month.
 *
 * Pass `--ladder <file>` once the per-period closing balances arrive to get the
 * real thing. Shape, per card id:
 *   { "woody-apple-card": [{ "closing_date": "2026-03-31", "closing_balance": 8500.12 }, ...] }
 * `closing_balance` is DEBT (positive), as the issuer prints it. Each period's
 * computed running balance must then equal the stated one to the cent.
 */
function reconcile(rows, openingDebt, statedDebt, ladder) {
  const charges = sum(rows.map((r) => r.withdrawal));
  const credits = sum(rows.map((r) => r.deposit));
  const computed = round2(openingDebt + charges - credits);
  const checks = [
    {
      label: `aggregate — replay all ${rows.length} rows from opening`,
      computed,
      stated: statedDebt,
      delta: round2(computed - statedDebt),
    },
  ];
  if (ladder && ladder.length) {
    const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
    for (const period of [...ladder].sort((a, b) => a.closing_date.localeCompare(b.closing_date))) {
      const upTo = sorted.filter((r) => r.txn_date <= period.closing_date);
      const bal = round2(openingDebt + sum(upTo.map((r) => r.withdrawal)) - sum(upTo.map((r) => r.deposit)));
      checks.push({
        label: `period ending ${period.closing_date} (${upTo.length} rows)`,
        computed: bal,
        stated: round2(period.closing_balance),
        delta: round2(bal - period.closing_balance),
      });
    }
  }
  return { charges, credits, net: round2(charges - credits), checks };
}

/** Derived month-end debt, so the ladder stays constructible after the CSVs go. */
function monthEndLadder(rows, openingDebt) {
  const sorted = [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  const months = [...new Set(sorted.map((r) => r.txn_date.slice(0, 7)))].sort();
  let bal = openingDebt;
  let i = 0;
  const out = [];
  for (const m of months) {
    while (i < sorted.length && sorted[i].txn_date.slice(0, 7) <= m) {
      bal = round2(bal + sorted[i].withdrawal - sorted[i].deposit);
      i++;
    }
    out.push({ month: m, closing_balance: bal });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const db = new DatabaseSync(join(ROOT, "local", "dashboard.db"));

if (REVERT) {
  const n = db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch = ?").get(REVERT).c;
  if (!n) {
    console.error(`No rows carry import_batch '${REVERT}'.`);
    process.exit(2);
  }
  if (!COMMIT) {
    console.log(`Would hard-delete ${n} row(s) with import_batch '${REVERT}'. Re-run with --commit.`);
    process.exit(0);
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM transactions WHERE import_batch = ?").run(REVERT);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  // A hard DELETE, not the app's soft delete: these rows were never published
  // and never user-edited, so there is no tombstone worth keeping and leaving
  // them soft-deleted would make a re-run see them as already present.
  console.log(`Reverted ${n} row(s) (import_batch '${REVERT}'). Re-run the load to redo it.`);
  process.exit(0);
}

if (!existsSync(STAGING)) {
  console.error(`Staging directory not found: ${STAGING}`);
  console.error("The statements are staged outside the repo by design (decision #26/#27).");
  process.exit(2);
}

const ladders = LADDER_FILE ? JSON.parse(readFileSync(LADDER_FILE, "utf8")) : {};
const totals = readCardTotals();
const accounts = Object.fromEntries(
  db.prepare("SELECT * FROM accounts WHERE deleted_at IS NULL").all().map((a) => [a.id, a])
);

const selected = ONLY_CARD ? CARDS.filter((c) => c.id === ONLY_CARD) : CARDS;
if (!selected.length) {
  console.error(`Unknown --card '${ONLY_CARD}'. Known: ${CARDS.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

console.log(`T26b — card ledger load  ${COMMIT ? "[COMMIT]" : "[dry run]"}`);
console.log(`staging: ${STAGING}`);
console.log(`ladder:  ${LADDER_FILE || "(none supplied — aggregate check only, per decision #45)"}`);

let allOk = true;
const perCard = [];
const seenExternalIds = new Map();

for (const card of selected) {
  const acct = accounts[card.id];
  if (!acct) {
    console.error(`\n✗ ${card.id}: no such account. Run \`npm run seed:cards\` first.`);
    allOk = false;
    continue;
  }
  const stated = totals[card.totalsKey];
  if (!stated) {
    console.error(`\n✗ ${card.id}: no '${card.totalsKey}' row in Card_Totals.csv.`);
    allOk = false;
    continue;
  }

  let rows = card.adapt(card.file);
  const last4Seen = rows.last4Seen || [];
  // Derive the opening by replaying backwards from the stated balance: the card
  // ledgers start mid-history, so this is the only anchor there is for three of
  // the five (Citi's $0.00 and Capital One's $337.90 are independently
  // corroborated; Chase's is exact by #49).
  const charges = sum(rows.map((r) => r.withdrawal));
  const credits = sum(rows.map((r) => r.deposit));
  const openingDebt = round2(stated.balance - round2(charges - credits));

  rows = assignExternalIds(rows, card.id);

  const rec = reconcile(rows, openingDebt, stated.balance, ladders[card.id]);
  const dates = rows.map((r) => r.txn_date).sort();
  const range = [dates[0], dates[dates.length - 1]];

  // --- external_id integrity: unique within the card AND across the load -----
  const dupWithin = rows.length - new Set(rows.map((r) => r.external_id)).size;
  for (const r of rows) {
    const prev = seenExternalIds.get(r.external_id);
    if (prev && prev !== card.id) {
      console.error(`✗ external_id collision across cards: ${r.external_id} (${prev} vs ${card.id})`);
      allOk = false;
    }
    seenExternalIds.set(r.external_id, card.id);
  }

  const byKind = {};
  for (const r of rows) byKind[r.kind] = round2((byKind[r.kind] || 0) + r.withdrawal - r.deposit);
  const countByKind = {};
  for (const r of rows) countByKind[r.kind] = (countByKind[r.kind] || 0) + 1;

  console.log(`\n${"═".repeat(84)}`);
  console.log(`${card.id}  —  ${card.issuer}  (${card.file})`);
  console.log(`${"═".repeat(84)}`);
  console.log(`  rows ${String(rows.length).padStart(4)}   span ${range[0]} → ${range[1]}`);
  console.log(`  charges ${money(charges)}   credits ${money(-credits)}   net ${money(rec.net)}`);
  console.log(`  stated balance (Card_Totals.csv) ${money(stated.balance)}`);
  console.log(`  DERIVED opening_balance          ${money(-openingDebt)}   (debt ${money(openingDebt)})`);
  if (last4Seen.length) console.log(`  card numbers seen in the export: ${last4Seen.join(", ")}`);
  console.log(`  by kind:`);
  for (const k of Object.keys(byKind).sort()) {
    console.log(`     ${k.padEnd(18)} ${String(countByKind[k]).padStart(4)} rows   net ${money(byKind[k])}`);
  }
  if (dupWithin) {
    console.error(`  ✗ ${dupWithin} duplicate external_id(s) within this card — the fingerprint is not unique`);
    allOk = false;
  } else {
    console.log(`  ✅ ${rows.length} unique external_id(s), no collisions`);
  }

  console.log(`  reconciliation${card.exemptFromLadder ? "  (exempt from the per-period ladder — decision #49: no charges, no periods)" : ""}:`);
  if (!card.exemptFromLadder && !(ladders[card.id] || []).length) {
    console.log(`     ⚠  no per-period closing balances supplied — aggregate check only (decision #45)`);
  }
  for (const c of rec.checks) {
    const ok = Math.abs(c.delta) < 0.005;
    if (!ok) allOk = false;
    console.log(`     ${ok ? "✅" : "✗ "} ${c.label}`);
    console.log(`        computed ${money(c.computed)}   stated ${money(c.stated)}   delta ${money(c.delta)}`);
  }

  // --- the checks that can actually FAIL --------------------------------------
  //
  // The aggregate replay above is an identity when the opening is derived from
  // the same stated balance (opening := stated − net ⟹ opening + net ≡ stated).
  // These are the independent ones.
  console.log(`  falsifiable checks:`);

  // (1) Sign-convention guard. A credit card cannot open with money ON it, so a
  //     negative opening debt means the amount convention is inverted. This is
  //     the check that actually catches Citi: reading its split columns as
  //     `Debit − Credit` (Capital One's convention) implies an opening of
  //     −$538.00, and it is the only automatic signal that anything is wrong.
  {
    const ok = openingDebt >= -0.005;
    if (!ok) allOk = false;
    console.log(
      `     ${ok ? "✅" : "✗ "} derived opening debt is not negative (a card does not open with a credit balance)` +
        `\n        ${money(openingDebt)}${ok ? "" : "  ← the issuer's amount convention is almost certainly inverted"}`
    );
  }

  // (2) The independent opening anchor, where one exists.
  if (card.anchorDebt == null) {
    console.log(`     ⚠  no independent opening anchor — ${card.anchorWhy}`);
    console.log(`        the aggregate replay above is an IDENTITY for this card, not a test.`);
  } else {
    const ok = Math.abs(openingDebt - card.anchorDebt) < 0.005;
    if (!ok) allOk = false;
    console.log(`     ${ok ? "✅" : "✗ "} opening matches its independent anchor — ${card.anchorWhy}`);
    console.log(`        derived ${money(openingDebt)}   anchor ${money(card.anchorDebt)}   delta ${money(round2(openingDebt - card.anchorDebt))}`);
  }

  // (3) Card-side payments vs. the checking ledger. A genuinely independent
  //     oracle: the checking rows came from the user's own sheet months ago and
  //     share nothing with these CSVs, so agreement tests the payment
  //     classification AND the transaction-date choice. It is reported, not
  //     enforced — decision #48 establishes that an unpaired CARD-side payment
  //     is valid data (Apple Cash pays part of Apple's balance; one Apple
  //     payment is a $4,000 balance transfer with no cash behind it at all).
  {
    const aliases = (() => {
      try { return JSON.parse(acct.data || "{}").source_aliases || []; } catch { return []; }
    })();
    const cardSide = sum(rows.filter((r) => r.kind === "payment").map((r) => r.deposit));
    let checkingSide = 0;
    let checkingRows = 0;
    if (aliases.length) {
      const q = db.prepare(
        `SELECT ROUND(SUM(withdrawal),2) s, COUNT(*) n FROM transactions t
          JOIN accounts a ON a.id = t.account_id
         WHERE t.deleted_at IS NULL AND a.type = 'checking' AND t.withdrawal > 0
           AND t.txn_date >= ? AND t.txn_date <= ?
           AND t.source IN (${aliases.map(() => "?").join(",")})`
      ).get(range[0], range[1], ...aliases);
      checkingSide = q.s || 0;
      checkingRows = q.n || 0;
    }
    const gap = round2(cardSide - checkingSide);
    console.log(`     ·  card-side payments ${money(cardSide)} vs. checking \`${aliases.join("\` / \`")}\` ${money(checkingSide)} (${checkingRows} rows) — gap ${money(gap)}`);
  }

  console.log(`  derived month-end debt (persisted, so the ladder survives the files being deleted):`);
  const mel = monthEndLadder(rows, openingDebt);
  console.log(`     ${mel.map((m) => `${m.month} ${m.closing_balance.toFixed(2)}`).join("   ")}`);

  perCard.push({ card, acct, rows, openingDebt, stated, range, last4Seen, monthEnd: mel, rec });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// --- cross-card: the balance transfers (decision #47) -----------------------
// Only meaningful when both legs are in the same run, so it is skipped under
// --card rather than silently reported as absent.
if (selected.length === CARDS.length) {
  console.log(`\n${"═".repeat(84)}`);
  console.log(`cross-card — balance transfers (decision #47)`);
  console.log(`${"═".repeat(84)}`);
  const legs = perCard.flatMap(({ card, rows }) =>
    rows.filter((r) => r.kind === "balance_transfer").map((r) => ({ card: card.id, r }))
  );
  // Count one side only (the debt arriving), or the pair double-counts itself.
  const arrived = sum(legs.filter(({ r }) => r.withdrawal > 0).map(({ r }) => r.withdrawal));
  for (const { card, r } of legs) {
    console.log(`   ${r.txn_date}  ${card.padEnd(18)} ${money(r.withdrawal - r.deposit)}  ${r.source}`);
  }
  // The Apple→Citi $4,000 on 2026-05-12 has both legs here and must net to zero
  // across the two ledgers: debt left Apple and arrived at Citi, dollar for
  // dollar, with no cash involved.
  const apple = legs.find((l) => l.card === "woody-apple-card" && l.r.txn_date === "2026-05-12");
  const citi = legs.find((l) => l.card === "woody-citi-card" && l.r.txn_date === "2026-05-12");
  const paired = apple && citi && Math.abs(apple.r.deposit - citi.r.withdrawal) < 0.005;
  if (!paired) allOk = false;
  console.log(
    `   ${paired ? "✅" : "✗ "} Apple→Citi 2026-05-12 pairs to the cent: ` +
      `${apple ? money(apple.r.deposit) : "(missing)"} off Apple = ${citi ? money(citi.r.withdrawal) : "(missing)"} onto Citi`
  );
  // The Chase→Citi $1,862.14 leg is deliberately one-sided: Woody's Chase card
  // has no statement export, so there is no ledger to put the other half on.
  // Inventing it would mean inventing an opening balance for that card too.
  console.log(
    `   ·  Chase→Citi 2026-05-05 is one-legged by design — \`woody-chase-card\` has no statement, so no opening anchor and no ledger.`
  );
  console.log(`   ·  ${money(arrived)} of debt arrived on Citi this way; T28 must NOT count any of it as Debt Payments — no cash left checking.`);
}

if (!COMMIT) {
  console.log(`\n${"─".repeat(84)}`);
  console.log(allOk ? "✅ every check passed — re-run with --commit to write" : "✗ checks failed — nothing would be written");
  process.exit(allOk ? 0 : 1);
}

if (!allOk) {
  console.error("\n✗ refusing to write: a check failed above.");
  process.exit(1);
}

const insert = db.prepare(`INSERT INTO transactions
    (id, account_id, owner, txn_date, description, source, deposit, withdrawal, note,
     transfer_id, external_id, import_batch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const existingIds = new Set(
  db.prepare("SELECT external_id FROM transactions WHERE external_id IS NOT NULL").all().map((r) => r.external_id)
);
const updateAccount = db.prepare("UPDATE accounts SET opening_balance = ?, data = ?, updated_at = ? WHERE id = ?");

// Pair the one card-to-card balance transfer whose BOTH sides are in this load:
// Apple -4000.00 and Citi +4000.00 on 2026-05-12 (#47). The Citi +1862.14 leg
// has no counterpart ledger (Woody's Chase has no statement), so it stays
// unpaired and visible rather than being invented.
const TRANSFER_PAIRS = [
  { id: "bt-2026-05-12-apple-citi", legs: [["woody-apple-card", "2026-05-12", 4000], ["woody-citi-card", "2026-05-12", 4000]] },
];
const transferIdFor = (cardId, row) => {
  if (row.kind !== "balance_transfer") return null;
  const amount = round2(row.withdrawal - row.deposit);
  for (const p of TRANSFER_PAIRS) {
    if (p.legs.some(([c, d, a]) => c === cardId && d === row.txn_date && Math.abs(Math.abs(amount) - a) < 0.005)) return p.id;
  }
  return null;
};

let totalInserted = 0;
let totalSkipped = 0;

for (const { card, acct, rows, openingDebt, stated, range, last4Seen, monthEnd } of perCard) {
  const batch = `t26b-${card.id}-${LOADED_AT}`;
  db.exec("BEGIN");
  try {
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      if (existingIds.has(r.external_id)) {
        skipped++;
        continue;
      }
      existingIds.add(r.external_id);
      insert.run(
        // A deterministic row id, so a revert-and-reload produces the same ids
        // instead of a fresh set the published snapshot would merge as new rows.
        `t26b-${r.external_id}`,
        card.id,
        acct.owner,
        r.txn_date,
        r.description,
        r.source,
        r.deposit,
        r.withdrawal,
        r.note,
        transferIdFor(card.id, r),
        r.external_id,
        batch,
        LOADED_AT,
        LOADED_AT
      );
      inserted++;
    }

    const prev = (() => {
      try {
        return JSON.parse(acct.data || "{}");
      } catch {
        return {};
      }
    })();
    const data = {
      ...prev,
      issuer: prev.issuer ?? card.issuer,
      credit_limit: prev.credit_limit ?? (stated.credit_limit || null),
      apr: prev.apr ?? stated.apr,
      last4: prev.last4 ?? (last4Seen.length === 1 ? last4Seen[0] : null),
      // Several physical/virtual card numbers per account in two of the exports
      // (Citi 3676/0164/8038, Capital One 4993/9937), so `last4` cannot be a
      // single value for them without picking one arbitrarily.
      last4_seen: last4Seen.length ? last4Seen : undefined,
      seeded_range: range,
      statements: {
        // What the issuer actually STATED. Per decision #45 the export carried
        // one current balance per card and no per-period closing balances, so
        // `periods` is empty until they arrive — deliberately empty rather than
        // filled with our own derived numbers dressed up as the issuer's.
        source: "Card_Totals.csv",
        as_of: "2026-10-08",
        current_balance: round2(stated.balance),
        periods: (ladders[card.id] || []).map((p) => ({
          closing_date: p.closing_date,
          closing_balance: round2(p.closing_balance),
        })),
        // DERIVED, not stated: this ledger replayed from `opening_balance` to
        // each month end. It is what keeps the per-period ladder constructible
        // after the CSVs are deleted — compare it to the issuer's statement
        // pages whenever those numbers arrive. Never cite it as a check: it is
        // the thing being checked.
        derived_month_end: monthEnd,
      },
      load: { task: "T26b", batch, loaded_at: LOADED_AT, rows: rows.length, file: card.file },
    };
    updateAccount.run(round2(-openingDebt), JSON.stringify(data), LOADED_AT, card.id);
    db.exec("COMMIT");
    totalInserted += inserted;
    totalSkipped += skipped;
    console.log(
      `\n${card.id}: inserted ${inserted}, skipped ${skipped} (already present)` +
        `\n   opening_balance → ${(-openingDebt).toFixed(2)}   seeded_range → ${range[0]}..${range[1]}` +
        `\n   import_batch → ${batch}`
    );
  } catch (e) {
    db.exec("ROLLBACK");
    console.error(`\n✗ ${card.id}: rolled back — ${e.message}`);
    throw e;
  }
}

console.log(`\n${"─".repeat(84)}`);
console.log(`✅ inserted ${totalInserted}, skipped ${totalSkipped}. Re-running inserts 0.`);
