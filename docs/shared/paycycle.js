// Pure pay-cycle math, safe to import in both Node and the browser (no deps).
//
// A pay window is [start, nextStart): `start` is the payday, `end` is the day
// before the next payday (inclusive display end). Cadence is one of
// 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'. For weekly/biweekly the
// grid is anchored to a known payday (`anchorISO`); for monthly/semimonthly the
// day(s) of the month come from the anchor.

const DAY = 86400000;
const parseISO = (s) => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, m - 1, d); };
const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (ms, n) => ms + n * DAY;
const clampDay = (y, m, day) => { const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Date.UTC(y, m, Math.min(day, dim)); };

/** The pay window containing `refISO`, for the given cadence + anchor payday. */
export function windowFor(cadence, anchorISO, refISO) {
  const ref = parseISO(refISO);
  const anchor = parseISO(anchorISO);

  if (cadence === "weekly" || cadence === "biweekly") {
    const period = cadence === "weekly" ? 7 : 14;
    const k = Math.floor((ref - anchor) / DAY / period);
    const start = addDays(anchor, k * period);
    const nextStart = addDays(start, period);
    return frame(start, nextStart);
  }

  // monthly (semimonthly falls back to monthly-on-anchor-day for now)
  const day = new Date(anchor).getUTCDate();
  const r = new Date(ref);
  let y = r.getUTCFullYear(), m = r.getUTCMonth();
  let start = clampDay(y, m, day);
  if (ref < start) { m--; if (m < 0) { m = 11; y--; } start = clampDay(y, m, day); }
  let ny = y, nm = m + 1; if (nm > 11) { nm = 0; ny++; }
  const nextStart = clampDay(ny, nm, day);
  return frame(start, nextStart);
}

/** The window immediately before the one containing `refISO`. */
export function previousWindowFor(cadence, anchorISO, refISO) {
  const cur = windowFor(cadence, anchorISO, refISO);
  return windowFor(cadence, anchorISO, toISO(addDays(parseISO(cur.start), -1)));
}

function frame(startMs, nextStartMs) {
  return { start: toISO(startMs), end: toISO(addDays(nextStartMs, -1)), nextStart: toISO(nextStartMs) };
}

/** True if an ISO date falls within [win.start, win.nextStart). */
export function inWindow(dateISO, win) {
  return dateISO >= win.start && dateISO < win.nextStart;
}
