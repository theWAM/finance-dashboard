// Human-facing "when was this data last updated" formatting.
//
// The snapshot still carries a monotonic `version` counter — the merge/refresh
// logic needs it to decide who is behind whom — but people don't think in
// version numbers, and a bare "v10" gave no hint that the number had stopped
// moving. Everything shown to a person is therefore a timestamp instead.

/** "2026-09-30T12:13:05Z" → "8:13am 9/30/26" (viewer's local time). */
export function formatStamp(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  const ampm = d.getHours() < 12 ? "am" : "pm";
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}${ampm} ${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

/** The standard label, e.g. "Last Updated: 8:13am 9/30/26". */
export function lastUpdated(iso) {
  return `Last Updated: ${formatStamp(iso)}`;
}
