// T29 — the statement importer. Takes CSV **text** and returns normalized
// ledger rows.
//
// It never sees a path, a `File` or the network. That is deliberate and it is
// the whole architecture of the no-leak guarantee (decision #27): the page
// reads the file with `FileReader`, hands the text to `readStatement()`, shows
// the review modal, and POSTs already-parsed rows. There is no `/api/import`
// endpoint that accepts a file, so "the statement never hits disk" is a
// property of the shape of the code rather than of remembering to delete
// something afterwards.
//
//   const r = readStatement(text, { accountId: "woody-apple-card" });
//   if (r.needsMapping) askTheUser(r.columns);        // generic fallback
//   const d = diffAgainstLedger(r.rows, existingRows);
//   // → { fresh, duplicates, conflicts }  — the review modal's three counts
//
// WHAT IS TRANSCRIBED AND WHAT IS INFERRED. Every per-issuer convention below
// comes from T25's audit of the real exports (TASKS.md, "T25 findings",
// 2026-10-08) — header rows, amount conventions, date columns and date formats
// were read off the files, not guessed. The three that would have been guessed
// wrong:
//   * **Citi's `Credit` column is itself negative** (`-66`, not `66`), so
//     `amount = Debit + Credit`.
//   * **Capital One's is positive**, so `amount = Debit − Credit`. The two
//     split-column issuers use OPPOSITE conventions and deliberately do not
//     share an adapter.
//   * **Apple's refunds are negative rows that are not payments**, so payments
//     are filtered on `Type === 'Payment'` and never on the sign.
// Each of those is now also an ASSERTION (`checkConvention`), so a file whose
// signs are inverted throws instead of importing refunds as purchases.
//
// `external_id`, merchant normalization and the issuer→ledger category map are
// NOT defined here — they are imported from shared/card-import-spec.js, which
// T26b's hand load also imports. Two paths, one formula, by construction
// (resolved decision #51): re-uploading an already-loaded month must dedupe to
// nothing, and that is only a meaningful test if neither path can drift.

import { parseCsvRecords, cleanHeader, cleanCell, parseAmount, toIsoDate, sniffDateFormat } from "./csv.js";
import {
  assignExternalIds,
  mapIssuerCategory,
  normalizeMerchant,
  stripCitiCardSuffix,
  ISSUER_CATEGORY_MAP,
} from "./card-import-spec.js";

export { ISSUER_CATEGORY_MAP as issuerCategoryMap, mapIssuerCategory };

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Thrown when a file cannot be imported safely. `code` is machine-readable. */
export class StatementImportError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "StatementImportError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Amount conventions
// ---------------------------------------------------------------------------
//
// Three shapes cover all five issuers plus the generic mapper:
//
//   signed  one column, sign carries the direction. `purchaseSign: 1` means a
//           purchase is positive (Apple, Discover); -1 would mean the reverse.
//   split   two columns. `creditSign` declares the sign the issuer's CREDIT
//           VALUES THEMSELVES carry: -1 for Citi (`-66`, not `66`) and +1 for
//           Capital One. It is not a multiplier — a credit always reduces what
//           is owed, so it must contribute negatively to the amount, and the
//           arithmetic therefore ADDS a column that is already negative and
//           SUBTRACTS one that is positive. Writing it as "what the column
//           carries" is what lets `checkConvention` assert the same field
//           against the file and catch the two issuers being swapped.
//   outflow one column, always money out regardless of what sign it carries —
//           Chase's payment history, where `$40.00 ` means $40 paid.
//
// `amountOf` returns the amount in the LEDGER's convention: a charge is
// positive, a payment or refund negative. Every issuer's sign weirdness is
// confined to this function, which is why the fingerprint in
// card-import-spec.js can take a single signed amount and be stable.

function amountOf(conv, rec) {
  if (conv.kind === "signed") return round2(parseAmount(rec[conv.column]) * (conv.purchaseSign ?? 1));
  if (conv.kind === "split") {
    // No default for `creditSign`: the two real split-column issuers disagree
    // on it, so a missing declaration is a question, not a convention.
    if (conv.creditSign !== 1 && conv.creditSign !== -1) {
      throw new StatementImportError(
        "bad-convention",
        "a split-column adapter must declare `creditSign` as +1 (credits are positive) or -1 (credits are already negative)",
        { convention: conv }
      );
    }
    return round2(parseAmount(rec[conv.debit]) - conv.creditSign * parseAmount(rec[conv.credit]));
  }
  if (conv.kind === "outflow") return round2(-Math.abs(parseAmount(rec[conv.column])));
  throw new StatementImportError("bad-convention", `unknown amount convention ${conv.kind}`);
}

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------
//
// Each declares its date column (the TRANSACTION date, never the post or
// clearing date — resolved #46), merchant column, issuer-category column, its
// amount convention, and a `classify` that assigns the row a `kind` and a
// first-pass ledger `description`.
//
// `kind` is this importer's own classification — `purchase` | `payment` |
// `refund` | `interest` | `fee` | `balance_transfer` | `adjustment` — and is
// not a database column. It drives the review modal's grouping, the
// convention assertions, and T34's pairing.
//
// `description` is the ledger category: the first-pass guess that T30's
// learned merchant rules then override. `note` keeps `issuer · <what the
// issuer actually said>` so nothing the file carried is lost before T30's bulk
// categorize pass can mine it.

const noteFor = (issuer, raw) => `${issuer} · ${raw && String(raw).trim() ? String(raw).trim() : "uncategorized"}`;

/**
 * Apple Card. Single signed `Amount (USD)`: purchase POSITIVE, payment/refund
 * NEGATIVE.
 *
 * The `Type` column is load-bearing and is NOT `Category`: Purchase 506 /
 * Payment 37 / Interest 8 / Debit 7 / Credit 7 / Other 2. **Payments are
 * filtered on `Type === 'Payment'` and never on the sign** (#46) — the 7
 * `Credit` rows are negative `(RETURN)` refunds and the 7 `Debit` rows are the
 * positive `DAILY CASH ADJUSTMENT` clawbacks of the cashback those returns
 * earned. Filtering on the sign reads every refund as a payment, which inflates
 * `Debt Payments` and sends T34 hunting for checking rows that do not exist.
 */
const APPLE = {
  issuer: "Apple Card",
  // `Amount (USD)` alone identifies this export; `Type` and `Merchant` are
  // required because `classify` cannot work without them, so a lookalike
  // export missing either must fall to the generic mapper rather than be
  // silently misread.
  signature: ["Transaction Date", "Merchant", "Type", "Amount (USD)"],
  date: { column: "Transaction Date", format: "mdy" },
  merchantColumn: "Merchant",
  merchantFallback: "Description",
  categoryColumn: "Category",
  amount: { kind: "signed", column: "Amount (USD)", purchaseSign: 1 },
  typeColumn: "Type",
  rawNote: (rec) => `${rec.Category}/${rec.Type}`,
  classify(rec, { amount, merchant }) {
    if (rec.Type === "Payment") {
      // `Bill Payment` is Apple's merchant string for the one balance transfer
      // on this card (2026-05-12, −$4,000.00 → Citi). Every other payment is an
      // ACH from a bank account or an Apple Cash payment and carries the bank's
      // name, so the merchant string identifies it exactly. It moved debt
      // between two cards and no money left checking (#47), so it is a
      // `Transfer`, not a `Credit Card Payment` — counting it as a payment
      // would overstate Debt Payments by $4,000 in a single month.
      if (merchant === "Bill Payment") return { kind: "balance_transfer", description: "Transfer" };
      return { kind: "payment", description: "Credit Card Payment" };
    }
    if (rec.Type === "Interest") return { kind: "interest", description: "Interest" };
    if (rec.Type === "Other" && /reversal/i.test(merchant)) {
      // The reversal of a payment that bounced for insufficient funds: a charge
      // in form, a bookkeeping correction in substance. Counting it as spending
      // would invent $850 of purchases that never happened, so it takes
      // `Adjustment` — which shared/csp.js already excludes outright and
      // reports on its own line.
      return { kind: "adjustment", description: "Adjustment" };
    }
    let description = mapIssuerCategory("Apple Card", rec.Category);
    // Apple also has a `Category: Payment`, which appears WITHOUT
    // `Type: Payment` on rows that are not payments. The Type column already
    // settled it above, so the category must not be allowed to re-open it.
    if (description === "Credit Card Payment") description = "Misc";
    return { kind: amount < 0 ? "refund" : "purchase", description };
  },
};

/**
 * Citi. Split `Debit`/`Credit`, but **`Credit` is itself negative** (`-66`, not
 * `66`), so `amount = Debit + Credit` and NEVER `Debit − Credit`.
 *
 * This is the trap T25 was written to catch and it is a real one: the natural
 * reading — and the convention Capital One actually uses — implies an opening
 * balance of −$538.00, a card that started with money on it. Corrected, Citi
 * reconciles to the cent from exactly $0.00.
 *
 * **No category column at all** (26 rows, zero categories), so every Citi
 * purchase is `Misc` until T30's merchant rules run. No type column either, so
 * payments are identified on the description, which is 4 of 4 on the real file.
 */
const CITI = {
  issuer: "Citi",
  signature: ["Status", "Date", "Description", "Debit", "Credit"],
  date: { column: "Date", format: "mdy" },
  merchantColumn: "Description",
  categoryColumn: null,
  amount: { kind: "split", debit: "Debit", credit: "Credit", creditSign: -1 },
  // Citi (and only Citi) appends the card number a charge was made on to every
  // description. Three numbers appear across one account, so it is noise in the
  // ledger AND a stability risk — a reissued card would change every
  // `external_id` on that merchant.
  preprocessMerchant: stripCitiCardSuffix,
  rawNote: (rec) => rec.Status,
  classify(rec, { amount, merchant }) {
    if (/AUTO-?PMT|AUTOPAY|ONLINE PAYMENT/i.test(merchant)) {
      return { kind: "payment", description: "Credit Card Payment" };
    }
    // $5,862.14 of balance transfers IN to this card: $4,000.00 from Apple and
    // $1,862.14 from Woody's Chase (which is how that card got closed out).
    // Debt arriving, not money spent (#47).
    if (/^BAL XFR\./i.test(merchant)) return { kind: "balance_transfer", description: "Transfer" };
    if (/BALANCE TRANSFER FEE|MEMBERSHIP FEE/i.test(merchant)) return { kind: "fee", description: "Bill" };
    return { kind: amount < 0 ? "refund" : "purchase", description: mapIssuerCategory("Citi", "") };
  },
};

/**
 * Capital One. Split `Debit`/`Credit`, both columns **positive**, so
 * `amount = Debit − Credit` — the OPPOSITE of Citi.
 *
 * `Category === 'Payment/Credit'` is 22 rows but only 19 are payments: three
 * are `CREDIT-CASH BACK REWARD` / `CREDIT-REWARD REDEMPTION` statement credits.
 * Filtering on the category alone reports $57.46 of rewards as debt payments.
 */
const CAPITAL_ONE = {
  issuer: "Capital One",
  signature: ["Transaction Date", "Posted Date", "Card No.", "Debit", "Credit"],
  date: { column: "Transaction Date", format: "iso" },
  merchantColumn: "Description",
  categoryColumn: "Category",
  amount: { kind: "split", debit: "Debit", credit: "Credit", creditSign: 1 },
  cardColumn: "Card No.",
  rawNote: (rec) => rec.Category,
  classify(rec, { amount, merchant }) {
    if (rec.Category === "Payment/Credit") {
      if (/\bPYMT\b|PAYMENT/i.test(merchant) && !/^CREDIT-/i.test(merchant)) {
        return { kind: "payment", description: "Credit Card Payment" };
      }
      return { kind: "refund", description: "Misc" };
    }
    if (rec.Category === "Fee/Interest Charge") {
      return /INTEREST/i.test(merchant)
        ? { kind: "interest", description: "Interest" }
        : { kind: "fee", description: "Bill" };
    }
    return { kind: amount < 0 ? "refund" : "purchase", description: mapIssuerCategory("Capital One", rec.Category) };
  },
};

/**
 * Discover. Single signed `Amount`: charge POSITIVE, payment/credit NEGATIVE.
 *
 * Two traps, both live in the real file:
 *   - `Category === 'Payments and Credits'` holds 17 rows, one of which
 *     (`ADORE ME INC … −39.95`) is a **merchant refund Discover filed under
 *     payments**. Classifying on the category inflates payments by $39.95;
 *     classifying on `/PAYMENT/` in the description gets all 16 real ones.
 *   - `FIRST LATE PAYMENT - NO FEE` is a real row at **$0.00**, which both an
 *     `if (!amount) continue` guard and a naive `/PAYMENT/` test get wrong —
 *     hence the `amount < 0` conjunct.
 * Discover also bills **two** interest rows a month (a legacy pre-2025 tranche
 * plus the current one): 16 rows, $2,178.41 across the window.
 */
const DISCOVER = {
  issuer: "Discover",
  signature: ["Trans. Date", "Post Date", "Description", "Amount", "Category"],
  date: { column: "Trans. Date", format: "mdy" },
  merchantColumn: "Description",
  categoryColumn: "Category",
  amount: { kind: "signed", column: "Amount", purchaseSign: 1 },
  rawNote: (rec) => rec.Category,
  classify(rec, { amount, merchant }) {
    if (amount < 0 && /PAYMENT/i.test(merchant)) return { kind: "payment", description: "Credit Card Payment" };
    if (rec.Category === "Interest") return { kind: "interest", description: "Interest" };
    if (rec.Category === "Fees") return { kind: "fee", description: "Bill" };
    let description = mapIssuerCategory("Discover", rec.Category);
    if (description === "Credit Card Payment") description = "Misc"; // the Adore Me refund
    return { kind: amount < 0 ? "refund" : "purchase", description };
  },
};

/**
 * Chase. Not a statement — a **payment history** (decision #49): six payments,
 * no purchases, no interest, nothing to categorize. `Amount` is `$40.00 ` with
 * a currency symbol and a trailing space, and is **always an outflow**, so the
 * sign is APPLIED here rather than read from the file.
 *
 * Note the header's double space (`Payment date  and details`) — collapsed by
 * `cleanHeader` — and that one row is dated 2026-10-27 and marked `Pending`
 * with a trailing U+00A0 in the value. Pending rows are kept, future-dated, the
 * same way the checking ledger already carries projected rows, and their
 * pending-ness goes on the note so it is visible rather than implied. Keying
 * `external_id` on the transaction date is what lets that row be re-exported
 * later as `Completed` without duplicating (#46) — Chase's export is the proof
 * that mutable post dates are not hypothetical.
 */
const CHASE = {
  issuer: "Chase",
  signature: ["Payment date and details", "Status", "Amount"],
  date: { column: "Payment date and details", format: "dmony" },
  // The date column is also the only description this export has, and it is a
  // date, so a per-row merchant would be noise. Every row is a payment on a
  // dormant card; `source: "Payment"` is the honest label.
  merchantColumn: null,
  merchantConstant: "Payment",
  categoryColumn: null,
  amount: { kind: "outflow", column: "Amount" },
  rawNote: (rec) => (rec.Status ? rec.Status.toLowerCase() : "payment history"),
  // A payments-only export: the aggregate "mostly charges" check would fail on
  // correct data, so it is skipped. The polarity check still applies and still
  // catches an inverted file.
  expectMostlyCharges: false,
  classify() {
    return { kind: "payment", description: "Credit Card Payment" };
  },
};

export const ADAPTERS = [APPLE, CITI, CAPITAL_ONE, DISCOVER, CHASE];

// ---------------------------------------------------------------------------
// detectIssuer — on the header SIGNATURE, not the filename
// ---------------------------------------------------------------------------

/**
 * Which adapter (if any) handles a file with this header row.
 *
 * Matched on the header's column names, never on the filename: the real files
 * are called `Woody_Apple.csv` and `Woody_Citi.CSV` only because of how they
 * were saved, and a browser `File` the user picked from their Downloads folder
 * can be called anything. The signature is the subset of columns the adapter
 * cannot work without, so a lookalike export missing one falls to the generic
 * mapper rather than being half-read.
 *
 * Returns `{ issuer, adapter, matched }` or `null`. Accepts either an array of
 * header cells or an already-parsed `{ header }`.
 */
export function detectIssuer(headerRow) {
  const cells = (Array.isArray(headerRow) ? headerRow : headerRow?.header ?? []).map(cleanHeader);
  const have = new Set(cells.map((c) => c.toLowerCase()));
  const hits = ADAPTERS.filter((a) => a.signature.every((c) => have.has(c.toLowerCase())));
  if (!hits.length) return null;
  // Most specific wins. A tie would mean two adapters are indistinguishable on
  // their own signatures, which is a bug in this file, not in the file being
  // imported — so say so rather than picking one.
  hits.sort((a, b) => b.signature.length - a.signature.length);
  if (hits.length > 1 && hits[0].signature.length === hits[1].signature.length) {
    throw new StatementImportError(
      "ambiguous-issuer",
      `header matches ${hits.map((h) => h.issuer).join(" and ")} equally well`,
      { issuers: hits.map((h) => h.issuer) }
    );
  }
  return { issuer: hits[0].issuer, adapter: hits[0], matched: hits[0].signature };
}

// ---------------------------------------------------------------------------
// The generic fallback (the fifth issuer nobody planned for)
// ---------------------------------------------------------------------------

/**
 * What the UI needs to ask the user to map a header it doesn't recognize:
 * every column, a few sample values each, and a guess per column. The guesses
 * are suggestions for a form, not decisions — the mapping is confirmed once and
 * saved to `accounts.data.column_map` for that card, so being wrong here costs
 * a click rather than an import.
 */
export function inspectColumns(text, { sampleSize = 3 } = {}) {
  const { header, records } = parseCsvRecords(text);
  const columns = header.map((name) => {
    const samples = records.slice(0, sampleSize).map((r) => r[name]).filter((v) => v !== "");
    const all = records.map((r) => r[name]);
    const numeric = all.filter(Boolean).length > 0 && all.filter(Boolean).every((v) => {
      try { parseAmount(v); return /\d/.test(v); } catch { return false; }
    });
    const dateFormat = sniffDateFormat(all.slice(0, 20));
    let guess = null;
    if (dateFormat && dateFormat !== "ambiguous") guess = "date";
    else if (dateFormat === "ambiguous") guess = "date?";
    else if (numeric) guess = /credit/i.test(name) ? "credit" : /debit/i.test(name) ? "debit" : "amount";
    else if (/merchant|description|payee|name/i.test(name)) guess = "merchant";
    else if (/categ/i.test(name)) guess = "category";
    return { name, samples, guess, dateFormat: dateFormat ?? null };
  });
  return { columns, rowCount: records.length, header };
}

/**
 * Build an adapter from a saved `accounts.data.column_map`. Shape:
 *
 *   { date: "Txn Date", date_format: "mdy" | "iso" | "dmy" | "dmony",
 *     merchant: "Description", category: "Category" | null,
 *     amount: { kind: "signed", column: "Amount", purchaseSign: 1 }
 *            | { kind: "split", debit: "Debit", credit: "Credit", creditSign: -1 }
 *            | { kind: "outflow", column: "Amount" },
 *     payment_match: "AUTOPAY|ONLINE PAYMENT",   // optional, regex source
 *     category_map: { "Groceries": "Groceries" } // optional
 *     issuer: "Some Bank" }
 *
 * No category table is invented for an unknown issuer: without `category_map`
 * every purchase lands at `Misc` and the issuer's own category string is kept
 * on the note, which is exactly the state Citi is in and exactly what T30's
 * rules exist to fix. Guessing a mapping for a vocabulary nobody has seen
 * would be worse than leaving it visible.
 */
export function adapterFromColumnMap(map) {
  if (!map || !map.date || !map.amount) {
    throw new StatementImportError("incomplete-column-map", "a column map needs at least `date` and `amount`", { map });
  }
  const issuer = map.issuer || "Generic";
  const paymentRe = map.payment_match ? new RegExp(map.payment_match, "i") : null;
  const table = map.category_map || null;
  return {
    issuer,
    generic: true,
    signature: [],
    date: { column: map.date, format: map.date_format || "auto" },
    merchantColumn: map.merchant || null,
    merchantConstant: map.merchant ? null : issuer,
    categoryColumn: map.category || null,
    amount: map.amount,
    rawNote: (rec) => (map.category ? rec[map.category] : ""),
    expectMostlyCharges: map.amount.kind !== "outflow",
    classify(rec, { amount, merchant }) {
      if (paymentRe && amount < 0 && paymentRe.test(merchant)) {
        return { kind: "payment", description: "Credit Card Payment" };
      }
      const raw = map.category ? rec[map.category] : "";
      const description = (table && table[String(raw).trim()]) || "Misc";
      return { kind: amount < 0 ? "refund" : "purchase", description };
    },
  };
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * Parsed records + an adapter → ledger rows, fingerprinted.
 *
 * Output per row: `{ txn_date, source, description, deposit, withdrawal,
 * external_id, note, kind, raw }`. A purchase becomes a `withdrawal`; a
 * **refund, statement credit or payment becomes a `deposit`** (decision #22 —
 * debt is a negative balance, so money owed going down is a deposit).
 *
 * `external_id` comes from `assignExternalIds` in card-import-spec.js, which
 * T26b's hand load also used. Verbatim reuse, not a re-derivation: the
 * uploader's only real test is that re-reading an already-loaded month produces
 * zero fresh rows, and a second implementation of the formula would turn that
 * test into a duplicate load.
 */
export function normalize(records, adapter, { accountId } = {}) {
  if (!accountId) throw new StatementImportError("no-account", "normalize() needs an accountId to fingerprint rows");

  // `auto` is only reachable through the generic mapper: a recognized issuer
  // declares its format because `03/04/2026` is genuinely ambiguous between
  // M/D and D/M, and sniffing it would read a European export as March.
  let format = adapter.date.format;
  if (format === "auto") {
    const sniffed = sniffDateFormat(records.map((r) => r[adapter.date.column]));
    if (!sniffed || sniffed === "ambiguous") {
      throw new StatementImportError(
        "ambiguous-date-format",
        `cannot tell what date format \`${adapter.date.column}\` is in — the column map must say`,
        { column: adapter.date.column, sniffed }
      );
    }
    format = sniffed;
  }

  const cardsSeen = new Set();
  const rows = records.map((rec, i) => {
    const amount = amountOf(adapter.amount, rec);
    let merchant = adapter.merchantConstant
      ?? cleanCell(rec[adapter.merchantColumn] || rec[adapter.merchantFallback] || "");
    let last4 = null;
    if (adapter.preprocessMerchant) {
      const pre = adapter.preprocessMerchant(merchant);
      merchant = pre.merchant;
      last4 = pre.last4;
    }
    if (last4) cardsSeen.add(last4);
    if (adapter.cardColumn && rec[adapter.cardColumn]) cardsSeen.add(rec[adapter.cardColumn]);

    let txn_date;
    try {
      txn_date = toIsoDate(rec[adapter.date.column], format);
    } catch (e) {
      throw new StatementImportError("bad-date", `row ${i + 2}: ${e.message}`, { row: i + 2, record: { ...rec } });
    }

    const { kind, description } = adapter.classify(rec, { amount, merchant });
    return {
      txn_date,
      source: merchant,
      description,
      // A zero-amount row is REAL and is kept: Citi's `MEMBERSHIP FEE MAY
      // 26-APR 27` is $0.00 and so is Discover's `FIRST LATE PAYMENT - NO FEE`.
      // An `if (!amount) continue` guard silently drops both.
      deposit: amount < 0 ? round2(-amount) : 0,
      withdrawal: amount > 0 ? round2(amount) : 0,
      note: noteFor(adapter.issuer, adapter.rawNote ? adapter.rawNote(rec) : ""),
      kind,
      raw: { ...rec },
    };
  });

  const out = assignExternalIds(rows, accountId);
  out.cardsSeen = [...cardsSeen].sort();
  return out;
}

// ---------------------------------------------------------------------------
// The convention assertions
// ---------------------------------------------------------------------------
//
// A sign-flipped file must FAIL, loudly, rather than import refunds as
// purchases — which is both silent and expensive: it inverts the sign of every
// charge, so the donut, the debt change and the CSP's Debt Payments are all
// wrong in the same direction and nothing on screen looks obviously broken.
//
// The checks are deliberately categorical rather than statistical where they
// can be. Each one is evidence the issuer gave us that is INDEPENDENT of the
// amount's sign:
//
//   (1) the declared split-column sign. Citi's `Credit` values must all be
//       negative and Capital One's must all be positive. This is the one that
//       catches the two split-column adapters being swapped — the single most
//       likely way to get this file wrong, since the natural reading of a
//       split export is Capital One's.
//   (2) polarity. A row the issuer's own type/description column says is a
//       PAYMENT must come out as a deposit, and interest must come out as a
//       charge. Apple labels payments in a `Type` column that carries no sign
//       at all, so a flipped Apple file is caught here with certainty.
//   (3) charge majority. The backstop for the issuers with no type column: a
//       credit card export whose rows are mostly credits is inverted. Only
//       reached when (1) and (2) have no evidence to work with.

/** @returns {Array<{code: string, message: string, detail: object}>} */
export function checkConvention(rows, adapter) {
  const problems = [];
  const sample = (rs) => rs.slice(0, 3).map((r) => ({ txn_date: r.txn_date, source: r.source, deposit: r.deposit, withdrawal: r.withdrawal }));

  // (1) The declared split-column sign.
  if (adapter.amount.kind === "split") {
    const want = adapter.amount.creditSign ?? -1;
    const wrong = rows.filter((r) => {
      const v = parseAmount(r.raw?.[adapter.amount.credit]);
      return v !== 0 && Math.sign(v) !== Math.sign(want);
    });
    if (wrong.length) {
      problems.push({
        code: "credit-column-sign",
        message:
          `${adapter.issuer}'s \`${adapter.amount.credit}\` column is declared ` +
          `${want < 0 ? "negative" : "positive"}, but ${wrong.length} row(s) carry the other sign. ` +
          `The two split-column issuers use opposite conventions — Citi's credits are already negative ` +
          `(so the columns add), Capital One's are positive (so they subtract). This looks like the wrong adapter.`,
        detail: { rows: sample(wrong) },
      });
    }
    // Both columns populated on one row means the split is not a split.
    const both = rows.filter(
      (r) => parseAmount(r.raw?.[adapter.amount.debit]) !== 0 && parseAmount(r.raw?.[adapter.amount.credit]) !== 0
    );
    if (both.length) {
      problems.push({
        code: "split-columns-overlap",
        message: `${both.length} row(s) carry both \`${adapter.amount.debit}\` and \`${adapter.amount.credit}\` — these are not exclusive split columns`,
        detail: { rows: sample(both) },
      });
    }
  }

  // (2) Polarity, against the issuer's own non-numeric evidence.
  const flippedPayments = rows.filter((r) => r.kind === "payment" && r.withdrawal > 0);
  if (flippedPayments.length) {
    problems.push({
      code: "payment-is-a-charge",
      message:
        `${flippedPayments.length} row(s) the ${adapter.issuer} export itself labels a payment came out as a CHARGE. ` +
        `The amount convention is inverted — importing this would read every refund as a purchase.`,
      detail: { rows: sample(flippedPayments) },
    });
  }
  const flippedInterest = rows.filter((r) => (r.kind === "interest" || r.kind === "fee") && r.deposit > 0);
  if (flippedInterest.length) {
    problems.push({
      code: "interest-is-a-credit",
      message:
        `${flippedInterest.length} interest/fee row(s) came out as a CREDIT. A card does not pay you interest — ` +
        `the amount convention is inverted.`,
      detail: { rows: sample(flippedInterest) },
    });
  }

  // (3) Charge majority — the backstop where (1) and (2) are blind.
  if (adapter.expectMostlyCharges !== false && rows.length >= 10) {
    const charges = rows.filter((r) => r.withdrawal > 0).length;
    const credits = rows.filter((r) => r.deposit > 0).length;
    if (credits > charges) {
      problems.push({
        code: "mostly-credits",
        message:
          `${credits} of ${rows.length} rows are credits and only ${charges} are charges. A card statement is ` +
          `mostly purchases; this one reads as mostly refunds, which is what an inverted sign convention looks like.`,
        detail: { charges, credits, rows: rows.length },
      });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// readStatement — the one entry point the page calls
// ---------------------------------------------------------------------------

/**
 * CSV text → `{ issuer, rows, … }`, or `{ needsMapping: true, columns }` when
 * the header is unrecognized and no saved column map applies.
 *
 * Throws `StatementImportError` when the file parses but cannot be trusted:
 * an inverted sign convention, an unparseable date, an ambiguous header. Pass
 * `{ force: true }` to downgrade the convention assertions to a reported
 * warning — the review modal offers it for the case where the issuer genuinely
 * changed their export, and it is deliberately a choice the user has to make
 * rather than a fallback the code takes silently.
 */
export function readStatement(text, { accountId, columnMap = null, issuer = null, force = false } = {}) {
  const { header, records } = parseCsvRecords(text);
  if (!header.length) throw new StatementImportError("empty-file", "the file has no header row");
  if (!records.length) throw new StatementImportError("no-rows", "the file has a header but no data rows", { header });

  let adapter = null;
  let detected = null;
  if (issuer) {
    adapter = ADAPTERS.find((a) => a.issuer === issuer) || null;
    if (!adapter) throw new StatementImportError("unknown-issuer", `no adapter named '${issuer}'`);
  } else {
    detected = detectIssuer(header);
    adapter = detected?.adapter ?? null;
  }

  if (!adapter) {
    // An unrecognized header is not an error — it is the fifth issuer nobody
    // planned for. Return the column list so the UI can ask once, and the
    // mapping gets saved to `accounts.data.column_map` for that card.
    if (!columnMap) {
      return { needsMapping: true, issuer: null, header, ...inspectColumns(text), rows: [] };
    }
    adapter = adapterFromColumnMap(columnMap);
    // A saved map that names columns this file doesn't have is a changed export,
    // not a mystery: say which columns are missing instead of normalizing
    // everything to undefined.
    const missing = [adapter.date.column, adapter.merchantColumn, adapter.categoryColumn,
      adapter.amount.column, adapter.amount.debit, adapter.amount.credit]
      .filter(Boolean)
      .filter((c) => !header.includes(c));
    if (missing.length) {
      throw new StatementImportError("column-map-stale", `the saved column map names columns this file doesn't have: ${missing.join(", ")}`, { missing, header });
    }
  }

  const rows = normalize(records, adapter, { accountId });
  const problems = checkConvention(rows, adapter);
  if (problems.length && !force) {
    throw new StatementImportError(
      "convention",
      `${adapter.issuer}: ${problems.map((p) => p.message).join(" ")}`,
      { problems, issuer: adapter.issuer }
    );
  }

  const mapped = new Set([adapter.date.column, adapter.merchantColumn, adapter.merchantFallback,
    adapter.categoryColumn, adapter.typeColumn, adapter.cardColumn,
    adapter.amount.column, adapter.amount.debit, adapter.amount.credit].filter(Boolean));

  return {
    issuer: adapter.issuer,
    adapter,
    generic: !!adapter.generic,
    rows,
    rowCount: rows.length,
    header,
    // Columns this adapter never reads. Not a failure — Apple's `Purchased By`
    // and `Clearing Date` are both deliberately unread — but the review modal
    // shows them so an issuer quietly adding a column is visible. Nothing is
    // lost either way: every row keeps its whole record on `raw`.
    unmapped: header.filter((h) => !mapped.has(h)),
    cardsSeen: rows.cardsSeen ?? [],
    warnings: problems,
    span: (() => {
      const d = rows.map((r) => r.txn_date).sort();
      return d.length ? [d[0], d[d.length - 1]] : [];
    })(),
  };
}

// ---------------------------------------------------------------------------
// diffAgainstLedger
// ---------------------------------------------------------------------------

const signedAmount = (r) => round2((Number(r.withdrawal) || 0) - (Number(r.deposit) || 0));
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Normalized rows + the account's existing ledger rows → the review modal's
 * three buckets.
 *
 *   fresh       insert these.
 *   duplicates  already in the ledger. `matched_by` says how.
 *   conflicts   the same charge at a different amount — surfaced as an
 *               **update**, not a duplicate.
 *
 * On conflicts, and why they are not what the task text literally describes.
 * T29's spec says a conflict is *"a matching `external_id` whose amount
 * differs"* — but the fingerprint (#46) HAS the amount in it, so a pending
 * charge that settles at a different amount gets a different `external_id` by
 * construction and can never collide. Implementing the sentence as written
 * would produce a bucket that is provably always empty, and the real case it
 * was written for — a $1.00 gas hold settling at $45.12 — would silently land
 * as a second row next to the stale one.
 *
 * So a conflict is detected one component looser: same account, same
 * TRANSACTION date, same normalized merchant, different amount, and neither
 * side already matched exactly. Candidates are paired greedily by closest
 * amount, which keeps two genuinely different same-day charges at one merchant
 * (an $8 coffee and a $40 lunch at the same chain) from being mistaken for one
 * amended charge, and is order-independent.
 *
 * It can still be wrong — a genuinely new charge at a merchant that already has
 * an unmatched same-day row looks like an amendment. That is why it is an
 * *update proposal* rather than an update: the review modal shows both amounts
 * and the user can reject it, which moves the row to `fresh`.
 *
 * Payments already mirrored by T34 are the other half of this. If T34 created
 * the card-side `deposit` for a payment, it carries a `transfer_id` and no
 * `external_id`, so an exact match is impossible and the importer would add a
 * second copy of a payment that is already there. Those are matched on
 * `transfer_id` + amount + a date window (the two legs of a transfer are
 * usually a day or two apart) and reported as duplicates with
 * `matched_by: "transfer_id"`, carrying `adopt_id` so the confirm step can
 * stamp the fingerprint onto the row that already exists — after which the
 * match is exact forever.
 */
export function diffAgainstLedger(normalized, existingRows, { transferDays = 3 } = {}) {
  const live = (existingRows || []).filter((r) => !r.deleted_at);
  const byExternal = new Map();
  for (const r of live) if (r.external_id) byExternal.set(r.external_id, r);

  const claimed = new Set();
  const fresh = [];
  const duplicates = [];

  for (const row of normalized) {
    const hit = byExternal.get(row.external_id);
    if (hit) {
      claimed.add(hit.id ?? hit);
      duplicates.push({ row, existing: hit, matched_by: "external_id" });
    } else {
      fresh.push(row);
    }
  }

  // T34's mirrored payments: a card-side deposit with a transfer_id and no
  // fingerprint of its own.
  const mirrored = live.filter((r) => r.transfer_id && !r.external_id && !claimed.has(r.id ?? r));
  const stillFresh = [];
  for (const row of fresh) {
    if (row.kind !== "payment" && row.kind !== "balance_transfer") { stillFresh.push(row); continue; }
    const amount = signedAmount(row);
    const cand = mirrored
      .filter((r) => !claimed.has(r.id ?? r) && Math.abs(signedAmount(r) - amount) < 0.005)
      .map((r) => ({ r, d: Math.abs(dayDiff(row.txn_date, r.txn_date)) }))
      .filter(({ d }) => d <= transferDays)
      .sort((a, b) => a.d - b.d)[0];
    if (cand) {
      claimed.add(cand.r.id ?? cand.r);
      duplicates.push({ row, existing: cand.r, matched_by: "transfer_id", adopt_id: cand.r.id, days_apart: cand.d });
    } else {
      stillFresh.push(row);
    }
  }

  // Conflicts: same date + merchant, different amount, neither side matched.
  const key = (r) => `${r.txn_date}|${normalizeMerchant(r.source)}`;
  const unmatched = new Map();
  for (const r of live) {
    if (claimed.has(r.id ?? r)) continue;
    const k = key(r);
    if (!unmatched.has(k)) unmatched.set(k, []);
    unmatched.get(k).push(r);
  }

  const conflicts = [];
  const reallyFresh = [];
  for (const row of stillFresh) {
    const pool = (unmatched.get(key(row)) || []).filter((r) => !claimed.has(r.id ?? r));
    if (!pool.length) { reallyFresh.push(row); continue; }
    const amount = signedAmount(row);
    const best = pool
      .map((r) => ({ r, delta: round2(amount - signedAmount(r)) }))
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    // Identical amount with no external_id on the existing row: the same charge
    // recorded by hand before any import ever ran. A duplicate, not a conflict —
    // and adoptable, so the next upload matches it exactly.
    if (Math.abs(best.delta) < 0.005) {
      claimed.add(best.r.id ?? best.r);
      duplicates.push({ row, existing: best.r, matched_by: "date-merchant-amount", adopt_id: best.r.id });
      continue;
    }
    claimed.add(best.r.id ?? best.r);
    conflicts.push({
      row,
      existing: best.r,
      update_id: best.r.id,
      from: signedAmount(best.r),
      to: amount,
      delta: best.delta,
    });
  }

  return {
    fresh: reallyFresh,
    duplicates,
    conflicts,
    counts: { fresh: reallyFresh.length, duplicates: duplicates.length, conflicts: conflicts.length },
    // What the review modal's "totals must match the statement" line needs.
    totals: {
      charges: round2(normalized.reduce((a, r) => a + (Number(r.withdrawal) || 0), 0)),
      credits: round2(normalized.reduce((a, r) => a + (Number(r.deposit) || 0), 0)),
      fresh_charges: round2(reallyFresh.reduce((a, r) => a + (Number(r.withdrawal) || 0), 0)),
      fresh_credits: round2(reallyFresh.reduce((a, r) => a + (Number(r.deposit) || 0), 0)),
    },
  };
}

/**
 * What the confirm step POSTs to `/api/transactions/bulk`: the identity and
 * content columns only. `kind` and `raw` are review-modal state and stay in the
 * browser — `kind` is derivable from the row and `raw` is a copy of a file the
 * user did not ask us to keep.
 */
export function toBulkRow(row, extra = {}) {
  return {
    txn_date: row.txn_date,
    description: row.description,
    source: row.source,
    deposit: round2(Number(row.deposit) || 0),
    withdrawal: round2(Number(row.withdrawal) || 0),
    note: row.note ?? "",
    external_id: row.external_id,
    ...extra,
  };
}
