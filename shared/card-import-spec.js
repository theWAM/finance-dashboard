// The parts of the statement-import contract that the one-time hand load
// (T26b, `local/load-card-statements.js`) and the app's uploader (T29,
// `shared/statement-import.js`) MUST share byte-for-byte.
//
// Why this file exists at all: T26b loads every card ledger by hand, and T29's
// only verification is to run the uploader over an already-loaded month and
// expect **zero fresh rows and identical categorization** (decision #27). That
// test is only possible if both paths compute the same `external_id` and reach
// the same first-pass `description`. Writing the formula down in prose and
// re-implementing it twice is exactly how the two drift; importing it is how
// they cannot. T29 imports from here rather than re-deriving — resolved
// decision #46 is binding on both.
//
// Pure, zero-dependency, no DOM, no Node built-ins: this runs in the browser
// during T29's import preview and in Node during the hand load.

// ---------------------------------------------------------------------------
// Merchant normalization
// ---------------------------------------------------------------------------

/**
 * Fold a merchant/description string to its identity form: accents stripped,
 * uppercased, every run of non-alphanumerics collapsed to one space, trimmed.
 *
 * Digits are deliberately KEPT — `DUNKIN #354365` and `DUNKIN #354366` are
 * different stores, and `AMAZON MKTPL*BF9ZD2HW0` carries the order id that
 * makes two same-day same-amount Amazon charges distinguishable. Stripping
 * them would collapse genuinely distinct rows into one `external_id` group and
 * silently drop the second on re-upload.
 */
export function normalizeMerchant(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Citi (and only Citi) appends the card number the charge was made on to every
 * purchase description: `DUNKIN #354365 DACULA GA null XXXXXXXXXXXX3676`. The
 * literal `null` is Citi's own, not ours. Three different numbers appear across
 * 26 rows (3676 / 0164 / 8038 — one account, several physical or virtual
 * cards), so the suffix is noise in the ledger AND a stability risk: a reissued
 * card changes it and every `external_id` on that merchant with it.
 *
 * Returns `{ merchant, last4 }`. Applied before normalization, by the Citi
 * adapter only.
 */
export function stripCitiCardSuffix(description) {
  const m = String(description ?? "").match(/\s+(?:null\s+)?X{4,}(\d{4})\s*$/i);
  if (!m) return { merchant: String(description ?? "").trim(), last4: null };
  return { merchant: String(description).slice(0, m.index).trim(), last4: m[1] };
}

// ---------------------------------------------------------------------------
// external_id — the import fingerprint (resolved decision #46)
// ---------------------------------------------------------------------------

/**
 * The canonical key string, which is the actual spec. Five components, joined
 * by `|`:
 *
 *   accountId | txnDate | amount | normalizedMerchant | occurrence
 *
 *   accountId   the `accounts.id` the row lands on. Keeps the same charge on
 *               two different cards from colliding.
 *   txnDate     ISO `YYYY-MM-DD`, the **transaction** date — NEVER the post or
 *               clearing date (#46). Three of five exports carry a second date
 *               and two carry a mutable status; Chase's export already holds a
 *               future-dated `Pending` row. A pending charge keeps its
 *               transaction date when it settles but may move its post date, so
 *               keying on the post date re-imports it as a new row.
 *   amount      `(withdrawal - deposit).toFixed(2)` — one signed field in the
 *               ledger's own convention (a charge is positive, a payment or
 *               refund negative), so the issuer's wildly different sign
 *               conventions cannot reach the fingerprint.
 *   merchant    `normalizeMerchant()` of the row's merchant/description.
 *   occurrence  0-based index among rows sharing all four components above.
 *
 * On the occurrence index being order-independent: rows inside one group are by
 * construction indistinguishable on every component of the key, so which member
 * gets 0 and which gets 1 cannot be observed — the resulting *set* of
 * `external_id`s is identical no matter what order the rows arrived in. That is
 * what makes two genuine same-day same-amount Starbucks runs both survive while
 * a re-uploaded statement dedupes to nothing.
 */
export function externalIdKey({ accountId, txnDate, amount, merchant, occurrence }) {
  const signed = Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
  return [
    String(accountId),
    String(txnDate),
    signed.toFixed(2),
    normalizeMerchant(merchant),
    String(occurrence),
  ].join("|");
}

// FNV-1a, 64-bit, over the UTF-16 code units of the key (low byte then high
// byte, so non-ASCII merchants still contribute every bit they carry). Two passes with
// different offset bases (the second over the reversed string) concatenate to
// 128 bits / 32 hex chars. Chosen over SHA-256 because it is synchronous (the
// WebCrypto digest available in both runtimes is async, which would force
// T29's `normalize()` to return a promise), short enough to read in a SQL
// dump, and auditable in twenty lines rather than sixty of bit-twiddling.
// Collision-freedom is asserted over the real corpus, not assumed.
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(str, basis) {
  let h = basis;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME) & MASK64;
    // Mix the high byte of multi-byte code units too, so two merchant strings
    // differing only above U+00FF cannot hash the same.
    const hi = str.charCodeAt(i) >> 8;
    if (hi) {
      h ^= BigInt(hi);
      h = (h * FNV_PRIME) & MASK64;
    }
  }
  return h;
}

const hex16 = (n) => n.toString(16).padStart(16, "0");

/** The fingerprint itself: 32 lowercase hex chars. */
export function externalId(parts) {
  const key = externalIdKey(parts);
  const a = fnv1a64(key, 0xcbf29ce484222325n);
  const b = fnv1a64([...key].reverse().join(""), 0x9e3779b97f4a7c15n);
  return hex16(a) + hex16(b);
}

/**
 * Assign `external_id` to a list of normalized rows for one account, computing
 * each row's occurrence index. Rows need `{ txn_date, deposit, withdrawal }`
 * plus a merchant in `source`. Returns a new array; does not mutate.
 */
export function assignExternalIds(rows, accountId) {
  const seen = new Map();
  return rows.map((r) => {
    const amount = (Number(r.withdrawal) || 0) - (Number(r.deposit) || 0);
    const base = externalIdKey({
      accountId,
      txnDate: r.txn_date,
      amount,
      merchant: r.source,
      occurrence: "",
    });
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      ...r,
      external_id: externalId({
        accountId,
        txnDate: r.txn_date,
        amount,
        merchant: r.source,
        occurrence,
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Issuer category → ledger category (the first-pass guess)
// ---------------------------------------------------------------------------

/**
 * The ledger's existing `description` vocabulary, plus the one addition this
 * data forces: `Interest`.
 *
 * `Interest` is new and deliberate. Apple bills $207.35 in a single month and
 * Discover bills **two** interest rows a month ($2,178.41 across the window);
 * it is not discretionary spending and reads wrong inside a catch-all, which is
 * why TASKS.md's "which card categories need their own CSP items" recommends it
 * its own Fixed Costs item. Until that item exists it lands in Unassigned,
 * which is the expected and visible first-run state — not a silent loss.
 *
 * Nothing else here is invented. Where an issuer category has no honest home in
 * the existing vocabulary (`Airlines`, `Hotels`, `Medical`, `Shopping`,
 * `Merchandise`), it maps to `Misc` AND the issuer's own raw category is
 * preserved verbatim on the row's `note`, so T30's bulk categorize pass can
 * mine it rather than re-deriving it from the merchant string alone.
 */
export const ISSUER_CATEGORY_MAP = {
  "Apple Card": {
    Restaurants: "Food",
    Alcohol: "Fun",
    Grocery: "Groceries",
    Gas: "Transportation",
    Transportation: "Transportation",
    Airlines: "Transportation",
    "Govt-services-parking": "Transportation",
    Entertainment: "Fun",
    Hotels: "Misc",
    Medical: "Misc",
    Shopping: "Misc",
    Insurance: "Bill",
    Utilities: "Bill",
    Other: "Misc",
    Interest: "Interest",
    Payment: "Credit Card Payment",
    Credit: "Misc",
    Debit: "Misc",
  },
  "Capital One": {
    Dining: "Food",
    Merchandise: "Misc",
    "Other Travel": "Transportation",
    "Gas/Automotive": "Transportation",
    Entertainment: "Fun",
    Internet: "Bill",
    "Phone/Cable": "Bill",
    "Health Care": "Misc",
    "Other Services": "Misc",
    "Fee/Interest Charge": "Bill",
    "Payment/Credit": "Credit Card Payment",
    "": "Misc",
  },
  Discover: {
    Restaurants: "Food",
    Supermarkets: "Groceries",
    Gasoline: "Transportation",
    "Travel/ Entertainment": "Fun",
    Merchandise: "Misc",
    "Medical Services": "Misc",
    Services: "Misc",
    Interest: "Interest",
    Fees: "Bill",
    "Payments and Credits": "Credit Card Payment",
    "Awards and Rebate Credits": "Misc",
  },
  // Citi exports no category column at all (26 rows, zero categories), so every
  // Citi purchase is `Misc` until T30's merchant rules run. That is not a gap
  // in this table — it is the input.
  Citi: {},
  // Chase's export is a payment history: no purchases, no categories, nothing
  // to map (decision #49).
  Chase: {},
};

/** Issuer category → ledger category, falling back to `Misc`. */
export function mapIssuerCategory(issuer, rawCategory) {
  const table = ISSUER_CATEGORY_MAP[issuer] || {};
  return table[String(rawCategory ?? "").trim()] || "Misc";
}
