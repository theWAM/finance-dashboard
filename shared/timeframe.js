// The timeframe vocabulary — one definition of "which date window am I looking
// at" and "how long is that window", shared by every surface that offers the
// picker (Ledger, Spending Plan, …) and by the compute engines that average
// over it. Pure: no DOM, no state, safe in both the browser and Node.
//
// Lifted verbatim out of local/public/app.js (Phase 10 / T1), where the preset
// math was tangled up with the Ledger's own state. The only change is that the
// reference date and the pay-cycle anchor are now parameters instead of
// closed-over state, so a second page can ask the same questions.

import { windowFor, previousWindowFor } from "./paycycle.js";

const DAY = 86400000;
// The average Gregorian month, in days (365.25 / 12). Dividing a window's real
// length by this is what makes "monthly average" comparable across windows that
// aren't month-shaped (a 3-paycheck window is 42 days, not 1 or 2 months).
export const DAYS_PER_MONTH = 30.4375;

/**
 * The timeframe presets, in the order they appear in the picker. `custom` is
 * first and hidden: it's the state the control falls into when From/To are
 * edited by hand, never something you pick.
 */
export const PRESETS = [
  { key: "custom", label: "Custom range", hidden: true },
  { key: "3paychecks", label: "3 paychecks" },
  { key: "last30", label: "Last 30 days" },
  { key: "next30", label: "Next 30 days" },
  { key: "last60", label: "Last 60 days" },
  { key: "next60", label: "Next 60 days" },
  { key: "last90", label: "Last 90 days" },
  { key: "next90", label: "Next 90 days" },
  { key: "last6mo", label: "Last 6 months" },
  { key: "next6mo", label: "Next 6 months" },
  { key: "thisyear", label: "This year" },
  { key: "lastyear", label: "Last year" },
  { key: "nextyear", label: "Next year" },
  { key: "all", label: "All time" },
];

/** The default timeframe every surface opens on. */
export const DEFAULT_PRESET = "3paychecks";

/**
 * The Spending Plan's presets. A Conscious Spending Plan *is* a monthly budget,
 * so its windows only ever step in whole calendar months: every preset here
 * starts on a 1st and ends on a month's last day. Two consequences are the
 * whole point. `monthsInWindow` comes out an exact integer, so every "/mo"
 * figure divides by a clean month count rather than 3.02 of them. And the
 * in-progress month is never silently folded into a trailing average, where
 * six days of October spending would divide by a whole month and read as a 75%
 * underspend. `This month` is the one way to look at the month in progress, and
 * it says so on the tin; every other preset is complete months only.
 *
 * Keys are deliberately distinct from PRESETS' (`last6months`, not `last6mo`)
 * wherever the window differs, so one key never means two things. The three
 * that ARE shared — `thisyear`/`lastyear`/`all` — are already month-aligned and
 * resolve identically either way.
 */
export const MONTH_PRESETS = [
  { key: "custom", label: "Custom range", hidden: true },
  { key: "thismonth", label: "This month" },
  { key: "lastmonth", label: "Last month" },
  { key: "last3months", label: "Last 3 months" },
  { key: "last6months", label: "Last 6 months" },
  { key: "last12months", label: "Last 12 months" },
  { key: "nextmonth", label: "Next month" },
  { key: "next3months", label: "Next 3 months" },
  { key: "next6months", label: "Next 6 months" },
  { key: "thisyear", label: "This year" },
  { key: "lastyear", label: "Last year" },
  { key: "all", label: "All time" },
];

/** The default timeframe the month-granularity surfaces open on. */
export const DEFAULT_MONTH_PRESET = "last3months";

export const presetLabel = (key) =>
  (PRESETS.find((p) => p.key === key) || MONTH_PRESETS.find((p) => p.key === key))?.label || "Timeframe";

const todayISO = () => new Date().toISOString().slice(0, 10);
const parseISO = (s) => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, m - 1, d); };
const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);

// --- whole-calendar-month arithmetic ---------------------------------------
// A month is addressed as "YYYY-MM" (what an <input type="month"> speaks); the
// helpers below turn that into the real dates a window needs. Counting in a
// single y*12+m index keeps the year rollover out of every call site.
const monthIndex = (ym) => { const [y, m] = String(ym).split("-").map(Number); return y * 12 + (m - 1); };
const monthFromIndex = (i) =>
  `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

/** The YYYY-MM a YYYY-MM-DD falls in (`""` stays `""`). */
export const monthOf = (iso) => String(iso || "").slice(0, 7);
/** Shift a YYYY-MM by n months, either direction. */
export const shiftMonth = (ym, n) => monthFromIndex(monthIndex(ym) + n);
/** First day of a YYYY-MM. */
export const monthStart = (ym) => `${ym}-01`;
/** Last day of a YYYY-MM — 28, 29, 30 or 31, whichever it really is. */
export const monthEnd = (ym) => {
  const i = monthIndex(ym);
  return toISO(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)); // day 0 of next month
};

/**
 * Map a preset key to a `{ from, to }` date window. `""` means open-ended, so
 * `all` is `{ from: "", to: "" }` — the same convention the Ledger filter uses.
 *
 * @param {string} key                 a PRESETS key
 * @param {object} [ctx]
 * @param {string} [ctx.today]         reference date (YYYY-MM-DD); defaults to now
 * @param {string} [ctx.cadence]       pay cadence for the `3paychecks` preset
 * @param {string} [ctx.anchor]        a known payday to anchor the pay grid to
 */
export function presetWindow(key, { today = todayISO(), cadence = "biweekly", anchor } = {}) {
  const t = today;
  const ms = parseISO(t);
  const addDays = (n) => toISO(ms + n * DAY);
  // Calendar-month arithmetic, clamping the day to the target month's length
  // (Mar 31 − 1mo → Feb 28), matching Date#setMonth.
  const addMonths = (n) => {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    const tgt = y * 12 + m + n;
    const ty = Math.floor(tgt / 12), tm = ((tgt % 12) + 12) % 12;
    const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return toISO(Date.UTC(ty, tm, Math.min(day, dim)));
  };
  const y = Number(t.slice(0, 4));

  switch (key) {
    case "3paychecks": {
      // prev · current · next pay period, so you always see the paycheck you
      // just got, the one you're in, and the one coming.
      const a = anchor || t;
      const prev = previousWindowFor(cadence, a, t);
      const cur = windowFor(cadence, a, t);
      const next = windowFor(cadence, a, cur.nextStart);
      return { from: prev.start, to: next.nextStart };
    }
    case "last30": return { from: addDays(-30), to: t };
    case "next30": return { from: t, to: addDays(30) };
    case "last60": return { from: addDays(-60), to: t };
    case "next60": return { from: t, to: addDays(60) };
    case "last90": return { from: addDays(-90), to: t };
    case "next90": return { from: t, to: addDays(90) };
    case "last6mo": return { from: addMonths(-6), to: t };
    case "next6mo": return { from: t, to: addMonths(6) };
    case "thisyear": return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "lastyear": return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "nextyear": return { from: `${y + 1}-01-01`, to: `${y + 1}-12-31` };
    case "all": return { from: "", to: "" };
    default: return { from: "", to: "" };
  }
}

/**
 * Map a MONTH_PRESETS key to a `{ from, to }` window snapped to whole calendar
 * months — a 1st through a month's last day. Anything not listed here falls
 * through to `presetWindow`, which covers the three keys the two lists share
 * (`thisyear`/`lastyear`/`all`) because those are month-aligned already.
 *
 * No pay-cycle context: unlike `presetWindow`, every window below is a pure
 * function of the reference date.
 */
export function monthPresetWindow(key, { today = todayISO() } = {}) {
  const cur = monthOf(today);
  // [a, b] as month offsets from the current month, both ends inclusive.
  const span = (a, b) => ({ from: monthStart(shiftMonth(cur, a)), to: monthEnd(shiftMonth(cur, b)) });

  switch (key) {
    case "thismonth": return span(0, 0);
    case "lastmonth": return span(-1, -1);
    // Trailing windows stop at last month: the month in progress is a partial
    // one, and averaging it in would understate every actual on the page.
    case "last3months": return span(-3, -1);
    case "last6months": return span(-6, -1);
    case "last12months": return span(-12, -1);
    case "nextmonth": return span(1, 1);
    case "next3months": return span(1, 3);
    case "next6months": return span(1, 6);
    default: return presetWindow(key, { today });
  }
}

/**
 * Pick the pay cadence + anchor payday the `3paychecks` preset needs, from the
 * same inputs every page already has. The anchor is the person's most recent
 * paycheck on or before `today`; with no paycheck yet we fall back to the
 * earliest future one, and with none at all to `today` itself (so the preset
 * still yields a sane three-period window on a fresh ledger).
 *
 * @param {Array<object>} transactions  ledger rows (any accounts)
 * @param {object} [opts]
 * @param {object} [opts.person]        the current person (for pay_cadence)
 * @param {string} [opts.today]
 */
export function payAnchor(transactions = [], { person, today = todayISO() } = {}) {
  const cadence = person?.pay_cadence || "biweekly";
  const pays = transactions
    .filter((t) => /paycheck/i.test(t.description || "") && (Number(t.deposit) || 0) > 0)
    .map((t) => t.txn_date)
    .sort();
  let anchor = today;
  if (pays.length) {
    const past = pays.filter((d) => d <= today);
    anchor = past.length ? past[past.length - 1] : pays[pays.length - 1];
  }
  return { cadence, anchor, today };
}

/** Inclusive length of a window in days; 0 if it can't be determined. */
export function daysInWindow({ from, to } = {}, { fallbackFrom, fallbackTo } = {}) {
  const f = from || fallbackFrom || "";
  const t = to || fallbackTo || "";
  if (!f || !t) return 0;
  return Math.floor((parseISO(t) - parseISO(f)) / DAY) + 1; // [from, to] inclusive
}

/**
 * How many months long is this window — the divisor behind every "per month"
 * figure in the app. Fractional on purpose: a 42-day paycheck window is 1.38
 * months, and rounding it to 1 or 2 would bias every average built on it.
 *
 * An open-ended window (`all`, or a half-filled custom range) falls back to the
 * caller's own data extent — pass the ledger's first/last dates.
 *
 * Clamped to MIN_MONTHS so a one-day window can't multiply its single
 * transaction into a 30× monthly "average".
 */
export const MIN_MONTHS = 0.25; // ~a week: below this, "per month" is noise

/**
 * The number of whole months a window spans, but only if it is actually snapped
 * to calendar months (a 1st through a month's last day) — `null` otherwise, so
 * the caller falls back to the day-based estimate. This is what makes a
 * month-granularity window divide by an exact 3 instead of 92 / 30.4375 = 3.02.
 */
export function wholeMonthsIn({ from, to } = {}) {
  if (!from || !to) return null;
  if (from.slice(8) !== "01" || to !== monthEnd(monthOf(to))) return null;
  const n = monthIndex(monthOf(to)) - monthIndex(monthOf(from)) + 1;
  return n > 0 ? n : null;
}

export function monthsInWindow(win, bounds = {}) {
  const { from, to } = win || {};
  const exact = wholeMonthsIn({ from: from || bounds.fallbackFrom, to: to || bounds.fallbackTo });
  if (exact) return exact;
  const days = daysInWindow(win, bounds);
  if (!days) return 1; // nothing to go on: treat as a single month
  return Math.max(MIN_MONTHS, days / DAYS_PER_MONTH);
}
