// CSV reading, shared by every path that touches a delimited file: the
// one-time Google-Sheet checking importer (local/import-csv.js), the hand card
// load (local/load-card-statements.js) and the app's statement uploader
// (shared/statement-import.js, T29).
//
// `parseCsv` was written for local/import-csv.js in Phase 1 and is already
// correct on quoted fields, escaped `""` and commas/newlines inside quotes.
// T29 moved it here rather than writing a second one; `import-csv.js` re-exports
// it so its own callers are unaffected.
//
// Pure, zero-dependency, no DOM and no Node built-ins — this runs in the
// browser (the uploader parses the file with FileReader and never uploads it)
// and in Node (the loader and the check harness).

/** Parse CSV text into rows of string cells. Handles quoted fields, escaped
 *  double-quotes ("") and commas/newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, "\n"); // normalize line endings
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  // flush trailing field/row (files may not end in a newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Every Unicode space the real exports actually contain — NBSP included —
// folded to an ASCII space. Chase's header carries U+00A0 between
// `Payment date` and `and details`, and its `Pending` status value carries a
// trailing one, so `status === "Pending"` fails a byte-exact comparison.
const UNICODE_SPACE = /[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g;

/** A data cell: Unicode spaces → ASCII, then trimmed. */
export const cleanCell = (s) => String(s ?? "").replace(UNICODE_SPACE, " ").trim();

/**
 * A header cell: `cleanCell` plus internal runs collapsed, so Chase's
 * `Payment date  and details` keys as `Payment date and details`.
 * Header hygiene is not cosmetic: the audit that produced T25's convention
 * table scored Citi 0/4 before stripping `\r` from the last header cell and
 * 4/4 after, because a lookup by name silently returned `undefined` and every
 * payment read as zero. `parseCsv` handles the `\r`; the BOM and the NBSPs are
 * handled here.
 */
export const cleanHeader = (s) => cleanCell(s).replace(/\s+/g, " ");

/**
 * Parse CSV text into `{ header, records }`, where `header` is the cleaned
 * first row and each record is an object keyed by it. Blank rows are dropped;
 * every value is `cleanCell`ed. A UTF-8 BOM (present on two of the six real
 * files) is stripped before parsing, since it would otherwise key the first
 * column as `"﻿Card"`.
 *
 * `raw` on each record is the original cell array, so nothing the file said is
 * lost — the generic column mapper (T29) depends on that.
 */
export function parseCsvRecords(text) {
  const rows = parseCsv(String(text ?? "").replace(/^\ufeff/, ""));
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map(cleanHeader);
  const records = rows
    .slice(1)
    .filter((r) => r.some((c) => cleanCell(c) !== ""))
    .map((r) => {
      const rec = Object.fromEntries(header.map((k, i) => [k, cleanCell(r[i])]));
      return Object.defineProperty(rec, "raw", { value: r, enumerable: false });
    });
  return { header, records };
}

/** `$40.00 `, `-66`, `91.9`, `(12.34)`, `` → a finite number. Blank is 0, not NaN. */
export function parseAmount(s) {
  let v = String(s ?? "").replace(/[$,\s]/g, "");
  if (v === "") return 0;
  // Accounting-style negatives, which no file in this corpus uses but every
  // fifth issuer eventually does.
  let sign = 1;
  const paren = v.match(/^\((.*)\)$/);
  if (paren) { sign = -1; v = paren[1]; }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`unparseable amount: ${JSON.stringify(s)}`);
  return sign * n;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Five issuers, FIVE date formats — none of which T25's convention table
 * recorded, and every one of which fails silently if assumed:
 *   Apple / Citi / Discover  M/D/YY      (10/7/26)
 *   Capital One              YYYY-MM-DD  (2026-10-06)
 *   Chase                    D-Mon-YY    (27-Oct-26)
 * Two-digit years are read as 20xx; anything that doesn't match the declared
 * format throws rather than guessing.
 */
export function toIsoDate(s, fmt) {
  const v = cleanCell(s);
  if (fmt === "iso") {
    const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) throw new Error(`bad iso date: ${JSON.stringify(s)}`);
    return iso(+m[1], +m[2], +m[3]);
  }
  if (fmt === "mdy" || fmt === "dmy") {
    const m = v.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
    if (!m) throw new Error(`bad ${fmt} date: ${JSON.stringify(s)}`);
    const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
    return fmt === "mdy" ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
  }
  if (fmt === "dmony") {
    const m = v.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2}|\d{4})$/);
    if (!m) throw new Error(`bad d-mon-y date: ${JSON.stringify(s)}`);
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mo) throw new Error(`bad month name: ${JSON.stringify(s)}`);
    const y = m[3].length === 4 ? +m[3] : 2000 + +m[3];
    return iso(y, mo, +m[1]);
  }
  throw new Error(`unknown date format ${fmt}`);
}

/**
 * Which of the four formats a sample of date strings is in, or `null` if they
 * don't all agree. Only the generic mapper uses this: a recognized issuer
 * declares its format, because a column of `03/04/2026` is genuinely ambiguous
 * between M/D and D/M and sniffing it would guess March for a European export.
 * Reported to the UI (which asks) rather than resolved silently — except where
 * some value's first component exceeds 12, which settles it.
 */
export function sniffDateFormat(samples) {
  const vals = samples.map(cleanCell).filter(Boolean);
  if (!vals.length) return null;
  const all = (fmt) => vals.every((v) => { try { toIsoDate(v, fmt); return true; } catch { return false; } });
  if (all("iso")) return "iso";
  if (all("dmony")) return "dmony";
  if (all("mdy") || all("dmy")) {
    const slashed = vals.map((v) => v.match(/^(\d{1,2})[/.](\d{1,2})/)).filter(Boolean);
    if (slashed.some((m) => +m[1] > 12)) return "dmy";
    if (slashed.some((m) => +m[2] > 12)) return "mdy";
    return "ambiguous"; // M/D vs D/M — the caller must ask
  }
  return null;
}
