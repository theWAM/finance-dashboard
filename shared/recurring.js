// T30 — the recurring engine, in one place: the cadence arithmetic that
// generates future occurrences, the detector that finds a subscription in real
// statement history, and the supersede rule that keeps a projection from
// sitting beside the real row it predicted.
//
// Pure, zero-dependency apart from shared/paycycle.js, no DOM and no Node
// built-ins: this runs in the local app, in the published copy (publish copies
// shared/*.js into docs/shared), and in Node for local/check-rules.js.
//
// THREE PARTS, AND THE ORDER MATTERS.
//
//   (a) occurrences()  — lifted verbatim out of paycheck.js's
//       `generateRecurring`, which was correct but closed over `state.cadence`,
//       `state.anchor` and `pushNew`. Same four frequencies, same CAP, same
//       "skip a day that doesn't exist in a short month" rule. This is a
//       refactor of a working daily-use path, so the arithmetic below is
//       transcribed, not rewritten, and local/check-rules.js diffs it against a
//       copy of the original implementation across thousands of cases.
//
//   (b) detectRecurring() — "most payments on cards are repeating", measured.
//       Only testable because T26b loaded real history: the premise is ≥3
//       consecutive months of a merchant, so before the backfill there was
//       nothing to detect and no way to tell a true positive from a lucky
//       guess. What the real corpus taught, and what the task's spec alone
//       would have missed, is in the comment above detectRecurring: amount
//       tolerance is not enough on its own, because `CHICK FIL A` appears in 7
//       consecutive months too. **One charge per period** is the discriminator.
//
//   (c) supersedeProjections() — the hard part of (c), specced before coded.
//       See "THE SUPERSEDE CONTRACT" below.
//
// THE SUPERSEDE CONTRACT
// ----------------------
// A projection is a GUESS written into the ledger as a real future row, because
// that is the only way it can show up in a pay window, in the donut and in the
// CSP. When the statement for that month finally arrives, the guess and the
// fact must become ONE row, not two. The rules, in order:
//
//   1. A projection NEVER gets an `external_id`. The fingerprint is the
//      importer's identity for a row that came off a statement; minting one for
//      a row we invented would mean a real charge could collide with it and be
//      silently dropped as a duplicate. No fingerprint, no collision — the
//      guardrail is structural rather than a rule someone has to remember.
//   2. A projection is MARKED, in `transactions.projected`, with
//      `"<cadence>:<merchant stem>"`. The flag is what makes it recognizable as
//      a guess; the stem is what lets a real row find it even though the real
//      row's merchant string carries a store id the projection never had.
//   3. A real statement row SUPERSEDES a projection when the merchant stems are
//      equal and the dates are within half a cadence step of each other
//      (±15 days monthly, ±7 biweekly, ±3 weekly). The nearest projection by
//      date wins, one-to-one.
//   4. Amount is deliberately NOT part of the match. The projection's amount is
//      precisely the thing the statement is correcting — a subscription that
//      went from $9.99 to $12.99 must still supersede, and the alternative
//      failure (a leftover projection sitting beside the real charge, double
//      counting the money) is worse than the alternative success (consuming a
//      guess that was wrong about the amount). If a merchant genuinely charges
//      twice in one period, the first row consumes the projection and the
//      second lands as fresh, which is also right: the projection predicted one
//      of them.
//   5. Superseding is an UPDATE of the projection row, not a delete-and-insert:
//      `POST /api/transactions/bulk` with `update_id` overwrites the date,
//      amount, merchant, category and note, stamps the real `external_id`, and
//      clears `projected`. The row keeps its id, so anything pointing at it
//      (a transfer pair, a CSP drill-down the user has open) still resolves.
//   6. Nothing is ever auto-generated. Detection proposes; the user confirms;
//      the rows stage behind Save like every other add.
//
// What is deliberately NOT solved here: a projection whose statement never
// arrives (the subscription was cancelled) stays in the ledger as a past-dated
// guess. It cannot be auto-removed — only the user knows whether the charge is
// missing or the statement is late — so `staleProjections()` surfaces them for
// review instead, and the Credit subtab offers to delete them.

import { windowFor } from "./paycycle.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The frequencies the recurring modal offers, in its own order. */
export const FREQUENCIES = ["monthly", "period", "biweekly", "weekly"];

// Hard stop on generation. 300 weekly occurrences is ~5.7 years, which is well
// past any `until` a person picks by hand; it exists so a bad `until` cannot
// spin.
export const CAP = 300;

const shiftDay = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};
const daysBetween = (a, b) => {
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
};
const monthKey = (iso) => iso.slice(0, 7);
const dayOf = (iso) => Number(iso.slice(8, 10));

// ---------------------------------------------------------------------------
// (a) The cadence arithmetic
// ---------------------------------------------------------------------------

/**
 * The dates on which `base` repeats after it, up to and including `until`.
 *
 * The base date itself is NOT included: the caller has already staged the entry
 * for the period in view, and these are the FUTURE occurrences (paycheck.js's
 * `addRow()` adds the row, then offers to repeat it).
 *
 *   freq    "weekly" | "biweekly" | "monthly" | "period"
 *   until   ISO date, inclusive
 *   cadence/anchor  only read by `freq: "period"`, which steps by the person's
 *                   own pay window rather than by the calendar
 *
 * The subtle cases, both transcribed from the original and both covered by
 * check:rules:
 *   · "monthly" from a 31st SKIPS the months that have no 31st rather than
 *     sliding to the 30th — a payment due on the 31st does not become a payment
 *     due on the 1st, and silently moving it would mis-date every short month.
 *   · "period" keeps the same OFFSET inside each pay window (day 3 of the
 *     window stays day 3), which is not the same as adding 14 days when the
 *     cadence is semimonthly or monthly. A date that lands past the end of its
 *     window is skipped, not clamped.
 *
 * An unknown `freq` returns [] — the caller's "no occurrences in that range"
 * path, never a silent fallback to a different frequency.
 */
export function occurrenceDates(from, freq, until, { cadence = "biweekly", anchor = null, cap = CAP } = {}) {
  const out = [];
  if (!from || !until) return out;

  if (freq === "weekly" || freq === "biweekly") {
    const step = freq === "weekly" ? 7 : 14;
    for (let n = 1; n <= cap; n++) {
      const date = shiftDay(from, n * step);
      if (date > until) break;
      out.push(date);
    }
    return out;
  }

  if (freq === "monthly") {
    const [y, m, d] = from.split("-").map(Number);
    for (let n = 1; n <= cap; n++) {
      const t = y * 12 + (m - 1) + n, yy = Math.floor(t / 12), mm = (t % 12) + 1;
      // Compare the FIRST of the candidate month against `until` before the
      // day-of-month test, so a skipped 31st doesn't end the loop early.
      if (`${yy}-${String(mm).padStart(2, "0")}-01` > until) break;
      const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      if (d > dim) continue; // day doesn't exist this month — skip
      const date = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date > until) break;
      out.push(date);
    }
    return out;
  }

  if (freq === "period") {
    if (!anchor) return out;
    const cur = windowFor(cadence, anchor, from);
    const offset = daysBetween(cur.start, from); // same relative position each period
    let win = windowFor(cadence, anchor, cur.nextStart);
    for (let n = 0; n < cap; n++) {
      const date = shiftDay(win.start, offset);
      if (date > until) break;
      if (date <= win.end) out.push(date);
      win = windowFor(cadence, anchor, win.nextStart);
    }
    return out;
  }

  return out;
}

/**
 * The same thing as rows: `base` repeated on each future occurrence date.
 * Returns new objects and never mutates `base`.
 */
export function occurrences(base, freq, until, opts = {}) {
  return occurrenceDates(base.txn_date, freq, until, opts).map((txn_date) => ({ ...base, txn_date }));
}

/**
 * The recurring modal's default stop date: the target ledger's furthest date,
 * or a year out from `D` — whichever is later.
 *
 * Lifted here from paycheck.js so that the modal's default and the projection
 * guardrail ("never project past the existing recurring `until` default") are
 * the same function rather than two that agree today. Day is clamped to 28 so
 * "a year out" exists in every month.
 */
export function defaultUntil(D, txns) {
  const latest = (txns || []).reduce((mx, t) => (t.txn_date > mx ? t.txn_date : mx), D);
  const [y, m, d] = D.split("-").map(Number);
  const yearOut = `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
  return latest > yearOut ? latest : yearOut;
}

// ---------------------------------------------------------------------------
// Merchant stems — the identity used for DETECTION, not for rules
// ---------------------------------------------------------------------------

/**
 * Fold a merchant string to the "same merchant, different visit" form by
 * dropping the parts that change between charges: store and order ids, the
 * trailing state code, and Discover's `…GAAPPLE PAY ENDING IN 2877` tail (the
 * state code and `APPLE` are glued together once non-alphanumerics collapse,
 * which is why the pattern allows two leading letters).
 *
 *   `AMAZON PRIME 0Y44R18W3`              → `AMAZON PRIME`
 *   `CHICK FIL A 05542`                   → `CHICK FIL A`
 *   `EU KALDIS HSRB MO ATLANTA GAAPPLE PAY ENDING IN 2877` → `EU KALDIS HSRB MO ATLANTA`
 *
 * This is deliberately NOT `normalizeMerchant` from card-import-spec.js, and
 * the two must not be confused. That one keeps digits because the
 * `external_id` fingerprint needs two same-day Amazon charges to stay
 * distinguishable; this one drops them because `AMAZON PRIME 0Y44R18W3` and
 * `AMAZON PRIME R322G68P3` are the same $15.89 subscription three months
 * apart. A stem is for grouping a history; a fingerprint is for identifying a
 * row. Nothing here is ever written to `external_id`.
 *
 * Its limit, stated rather than hidden: it keeps city names, so
 * `CLIFTON CAFE EMORY U` and `CLIFTON CAFE EMORY U ATLANTA` stem apart. For
 * detection that costs a little recall on merchants whose descriptor changed
 * mid-history and nothing else; guessing which trailing word is a city is how
 * a stemmer starts merging merchants that are not the same.
 */
export function merchantStem(s) {
  let t = String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s*[A-Z]{0,2}APPLE PAY ENDING.*$/, "")
    .replace(/\s*(VISA|MASTERCARD) CREDIT.*$/, "");
  const toks = t.split(" ").filter((x) => x && !/[0-9]/.test(x));
  while (toks.length > 1 && US_STATES.has(toks[toks.length - 1])) toks.pop();
  // Everything-was-digits (a bare order number) keeps the collapsed original,
  // so two such rows still group with each other rather than all collapsing
  // into one empty-string merchant.
  return toks.join(" ") || t;
}

const US_STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR " +
   "PA RI SC SD TN TX UT VT VA WA WV WI WY DC US USA").split(" ")
);

// ---------------------------------------------------------------------------
// (b) Detection
// ---------------------------------------------------------------------------

/**
 * Categories a recurring charge is never DETECTED from, even though they do
 * repeat every month:
 *   · `Interest` repeats but is computed from the balance, so projecting last
 *     month's figure forward is just wrong — that is T32b's payoff projection,
 *     which models it from the APR.
 *   · `Credit Card Payment` is the transfer side of a pair (T34); projecting
 *     one would invent half a transfer.
 *   · `Transfer` / `Adjustment` are artifacts (a balance transfer, a returned
 *     payment, a rewards credit), already excluded from the CSP.
 */
export const NON_RECURRING_CATEGORIES = new Set([
  "Interest", "Credit Card Payment", "Transfer", "Adjustment", "Negative Balance",
]);

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : round2((s[mid - 1] + s[mid]) / 2);
};

/**
 * Find the merchants that look like subscriptions in a card's own history.
 *
 *   detectRecurring(rows, { months: 3, tolerance: 0.15 })
 *     → [{ merchant, label, cadence, typicalAmount, dayOfMonth, firstSeen,
 *          lastSeen, monthsRun, charges, spread, confidence, category, key }]
 *
 * WHAT THE REAL DATA FORCED. The spec was "merchants appearing in ≥3
 * consecutive months within ±15% of the same amount". Run over the 977 loaded
 * card rows, that alone returns `CHICK FIL A` (38 charges across 7 consecutive
 * months), `QT INSIDE` (37 across 7), `UBER TRIP` (53 across 8) and `PUBLIX`
 * (18 across 7) — every frequent-but-discretionary merchant in the ledger,
 * because "appears every month" is a statement about habits, not about
 * subscriptions. Projecting those forward would invent dozens of charges a
 * month that nobody agreed to.
 *
 * The discriminator the data shows is **one charge per period**. Every true
 * positive in the corpus (`AMAZON PRIME` $15.89×7, `GOOGLE` $26.99×7,
 * `UBER ONE MEMBERSHIP` $9.99, `APPLE SERVICES` $9.99, `LA FITNESS` $34.99,
 * `AHS AHS COM` $62.99, `TERMIUS CORPORATION` $15.00) bills exactly once in
 * each of its months; every false positive bills three to seven times. So a
 * month only counts toward the run if it holds exactly ONE charge from the
 * merchant, and only then is the ±tolerance amount test applied.
 *
 * Both tests are necessary and neither is sufficient: one-per-month alone would
 * nominate a quarterly dentist visit at a different amount each time;
 * tolerance alone nominates Chick-fil-A.
 *
 * `confidence` is a readable composite, not a probability. The weights are a
 * judgment call, written down so they can be argued with:
 *   0.50  base, for clearing both tests
 *   +0.10 per month of run beyond the minimum, to +0.30
 *   +0.20 / +0.12 / +0.05  amounts identical / within 5% / within tolerance
 *   +0.10 / +0.05  billing day stable within 2 / within 5 days
 *   −0.15 if the merchant ALSO has months with several charges — it repeats,
 *         but it is not purely a subscription, so the projection is a guess
 *         about a mixed merchant
 * capped at 0.99, because nothing here is certain.
 */
export function detectRecurring(rows, { months = 3, tolerance = 0.15, minAmount = 0.5 } = {}) {
  const charges = (rows || []).filter(
    (r) => !r.deleted_at && !r._deleted && !r.projected &&
      (Number(r.withdrawal) || 0) >= minAmount &&
      !NON_RECURRING_CATEGORIES.has(r.description || "")
  );

  const groups = new Map();
  for (const r of charges) {
    const key = merchantStem(r.source);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [stem, rs] of groups) {
    rs.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0));

    // Months holding exactly one charge are the only ones that can carry a run.
    const byMonth = new Map();
    for (const r of rs) {
      const k = monthKey(r.txn_date);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(r);
    }
    const mixed = [...byMonth.values()].some((v) => v.length > 1);
    const singles = [...byMonth.entries()].filter(([, v]) => v.length === 1)
      .map(([k, v]) => ({ month: k, row: v[0] }))
      .sort((a, b) => (a.month < b.month ? -1 : 1));

    const best = longestStableRun(singles, tolerance, months);
    if (best) {
      out.push(shape(stem, best.run.map((x) => x.row), { mixed, months, tolerance, kind: "monthly" }));
      continue;
    }

    // A weekly or biweekly subscription bills several times a month, so the
    // month-run test above can never see it. Its signature instead is a gap
    // that never varies: every consecutive charge 7±2 or 14±3 days apart, with
    // the amounts inside tolerance. Rare on a card, cheap to check, and without
    // it `cadence` would be a field that only ever says "monthly".
    const fixed = fixedGapRun(rs, tolerance, months);
    if (fixed) out.push(shape(stem, fixed.run, { mixed: false, months, tolerance, kind: fixed.cadence }));
  }

  return out.sort((a, b) => b.confidence - a.confidence || b.typicalAmount - a.typicalAmount);
}

// The longest run of CONSECUTIVE single-charge months whose amounts all sit
// within `tolerance` of that run's own median. Tried from every start so a
// price change part-way through history yields the later, stable stretch rather
// than nothing at all.
function longestStableRun(singles, tolerance, minMonths) {
  let best = null;
  for (let i = 0; i < singles.length; i++) {
    let run = [singles[i]];
    for (let j = i + 1; j < singles.length; j++) {
      if (!isNextMonth(singles[j - 1].month, singles[j].month)) break;
      const cand = run.concat(singles[j]);
      const med = median(cand.map((x) => Number(x.row.withdrawal) || 0));
      if (!med) break;
      if (cand.some((x) => Math.abs((Number(x.row.withdrawal) || 0) - med) > tolerance * med)) break;
      run = cand;
    }
    if (run.length >= minMonths && (!best || run.length > best.run.length)) best = { run };
  }
  return best;
}

function fixedGapRun(rs, tolerance, minMonths) {
  if (rs.length < minMonths) return null;
  const gaps = [];
  for (let i = 1; i < rs.length; i++) gaps.push(daysBetween(rs[i - 1].txn_date, rs[i].txn_date));
  const weekly = gaps.every((g) => Math.abs(g - 7) <= 2);
  const biweekly = gaps.every((g) => Math.abs(g - 14) <= 3);
  if (!weekly && !biweekly) return null;
  const amts = rs.map((r) => Number(r.withdrawal) || 0);
  const med = median(amts);
  if (!med || amts.some((a) => Math.abs(a - med) > tolerance * med)) return null;
  // Still require the ≥N-month premise: four weekly charges inside one month
  // is a habit, not a subscription.
  const span = new Set(rs.map((r) => monthKey(r.txn_date))).size;
  if (span < minMonths) return null;
  return { run: rs, cadence: weekly ? "weekly" : "biweekly" };
}

function shape(stem, run, { mixed, months, tolerance, kind }) {
  const amts = run.map((r) => Number(r.withdrawal) || 0);
  const typical = median(amts);
  const spread = typical ? Math.max(...amts.map((a) => Math.abs(a - typical))) / typical : 0;
  const days = run.map((r) => dayOf(r.txn_date));
  const medDay = median(days);
  const dayDrift = Math.max(...days.map((d) => Math.abs(d - medDay)));
  const monthsRun = new Set(run.map((r) => monthKey(r.txn_date))).size;

  let confidence = 0.5;
  confidence += Math.min(0.3, Math.max(0, monthsRun - months) * 0.1);
  if (spread <= 0.02) confidence += 0.2;
  else if (spread <= 0.05) confidence += 0.12;
  else if (spread <= tolerance) confidence += 0.05;
  if (kind === "monthly") {
    if (dayDrift <= 2) confidence += 0.1;
    else if (dayDrift <= 5) confidence += 0.05;
  } else {
    confidence += 0.1; // a fixed 7/14-day gap IS the stability test
  }
  if (mixed) confidence -= 0.15;

  const last = run[run.length - 1];
  return {
    merchant: stem,
    label: last.source || stem,
    accountId: last.account_id ?? null,
    category: modeOf(run.map((r) => r.description || "")),
    cadence: kind,
    typicalAmount: round2(typical),
    dayOfMonth: kind === "monthly" ? Math.round(medDay) : null,
    firstSeen: run[0].txn_date,
    lastSeen: last.txn_date,
    monthsRun,
    charges: run.length,
    spread: Math.round(spread * 1000) / 1000,
    mixed,
    confidence: Math.min(0.99, round2(confidence)),
    key: projectionMarker(stem, kind),
  };
}

function modeOf(xs) {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

const isNextMonth = (a, b) => {
  const [y1, m1] = a.split("-").map(Number), [y2, m2] = b.split("-").map(Number);
  return y2 * 12 + m2 === y1 * 12 + m1 + 1;
};

// ---------------------------------------------------------------------------
// (c) Projections, and the supersede rule
// ---------------------------------------------------------------------------

/** The value written to `transactions.projected`: `"<cadence>:<stem>"`. */
export const projectionMarker = (stem, cadence) => `${cadence}:${stem}`;

/** Read a marker back. Returns null for a row that is not a projection. */
export function parseProjection(value) {
  if (!value) return null;
  const s = String(value);
  const i = s.indexOf(":");
  if (i < 0) return { cadence: "monthly", stem: s };
  return { cadence: s.slice(0, i), stem: s.slice(i + 1) };
}

/** Half a cadence step, in days — how far a real charge may sit from its projection. */
export function matchWindowDays(cadence) {
  return cadence === "weekly" ? 3 : cadence === "biweekly" ? 7 : 15;
}

const STEP_DAYS = { weekly: 7, biweekly: 14 };

/**
 * The first date on or after `lastSeen + one step`.
 *
 * Monthly keeps the billing DAY, which is why it goes through
 * `occurrenceDates`: a subscription billed on the 31st must keep skipping the
 * months that have no 31st rather than drifting to the 1st.
 */
export function nextOccurrence(lastSeen, cadence, { cadence: payCadence, anchor } = {}) {
  if (STEP_DAYS[cadence]) return shiftDay(lastSeen, STEP_DAYS[cadence]);
  const far = `${Number(lastSeen.slice(0, 4)) + 2}-12-31`;
  if (cadence === "period") {
    return occurrenceDates(lastSeen, "period", far, { cadence: payCadence, anchor })[0] ?? null;
  }
  return occurrenceDates(lastSeen, "monthly", far, {})[0] ?? null;
}

/**
 * Turn one `detectRecurring` result into the rows that would be staged if the
 * user says "project it forward".
 *
 *   projectionRows(hit, { until, from, cadence, anchor })
 *
 * `until` is required and the caller is expected to pass `defaultUntil()`'s
 * answer — the guardrail is "never project past the recurring modal's own
 * default", and the way to keep that true is to use the same function the modal
 * uses rather than a second year-out calculation.
 *
 * Every row comes back with `projected` set, `external_id` absent, the
 * merchant's detected label, and the category the merchant's own history used —
 * never a guessed one. Nothing is written: these are rows for the Save button.
 */
export function projectionRows(hit, { until, from = null, cadence = "biweekly", anchor = null } = {}) {
  if (!until) throw new Error("projectionRows needs an `until` — pass defaultUntil()'s answer");
  const start = from || nextOccurrence(hit.lastSeen, hit.cadence, { cadence, anchor });
  if (!start || start > until) return [];
  const dates = [start, ...occurrenceDates(start, hit.cadence, until, { cadence, anchor })];
  return dates.map((txn_date) => ({
    txn_date,
    description: hit.category || "Misc",
    source: hit.label,
    withdrawal: round2(hit.typicalAmount),
    deposit: 0,
    projected: hit.key,
    note: `projected · ${hit.cadence} · detected from ${hit.monthsRun} months through ${hit.lastSeen}`,
  }));
}

/**
 * Match incoming statement rows against the projections already in the ledger.
 *
 *   supersedeProjections(incoming, existingRows)
 *     → { superseded: [{ row, projection, update_id, days_apart }],
 *         fresh: [rows that matched nothing],
 *         unmatched: [projections nothing claimed] }
 *
 * `unmatched` is every projection no incoming row claimed. Pass `today` to
 * narrow it to the ones whose date has already PASSED, which is the only
 * actionable subset: a projection dated next March is unclaimed by a March
 * statement nobody has written yet, and reporting it would be noise.
 *
 * Run this BEFORE `diffAgainstLedger`, and feed it `fresh` afterwards: a
 * projection carries no `external_id`, so the importer's own diff cannot see
 * it, and its date-plus-merchant conflict test cannot either (the projection's
 * date is a guess, usually a day or two off, and its merchant string has no
 * store id). Without this step the real charge lands as a brand-new row beside
 * the projection and the month is counted twice.
 *
 * Rules 3–5 of the supersede contract at the top of this file are implemented
 * here: equal stems, nearest date inside half a cadence step, one-to-one, no
 * amount test. `update_id` is what the confirm step posts to
 * `/api/transactions/bulk`, which overwrites the content and clears the flag.
 */
export function supersedeProjections(incoming, existingRows, { today = null } = {}) {
  const projections = (existingRows || [])
    .filter((r) => r.projected && !r.deleted_at)
    .map((r) => ({ row: r, ...parseProjection(r.projected) }));

  const claimed = new Set();
  const superseded = [];
  const fresh = [];

  // Nearest-first across ALL candidates, not per-row: a two-charge month must
  // not let whichever row happens to be first in the file consume the
  // projection that sits a day from the other one.
  const pairs = [];
  for (const row of incoming || []) {
    const stem = merchantStem(row.source);
    for (const p of projections) {
      if (p.stem !== stem) continue;
      const d = Math.abs(daysBetween(p.row.txn_date, row.txn_date));
      if (d > matchWindowDays(p.cadence)) continue;
      pairs.push({ row, p, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d || (a.row.txn_date < b.row.txn_date ? -1 : 1));

  const takenRows = new Set();
  for (const { row, p, d } of pairs) {
    if (takenRows.has(row) || claimed.has(p.row.id)) continue;
    takenRows.add(row);
    claimed.add(p.row.id);
    superseded.push({ row, projection: p.row, update_id: p.row.id, days_apart: d });
  }
  for (const row of incoming || []) if (!takenRows.has(row)) fresh.push(row);

  return {
    superseded,
    fresh,
    unmatched: projections.filter((p) => !claimed.has(p.row.id))
      .filter((p) => !today || p.row.txn_date <= today)
      .map((p) => p.row),
  };
}

/**
 * Projections whose date has passed with no statement row to supersede them —
 * most likely a cancelled subscription, possibly just a late statement. Only
 * the user knows which, so these are surfaced, never removed automatically.
 */
export function staleProjections(rows, today) {
  return (rows || []).filter((r) => r.projected && !r.deleted_at && !r._deleted && r.txn_date < today);
}
