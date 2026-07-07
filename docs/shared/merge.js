// Per-record last-writer-wins merge — the core of the two-person sync model.
//
// Given the local set of records and an incoming set (e.g. from a pulled
// snapshot), produce the merged set. For each id, the record with the newer
// `updated_at` wins. `deleted_at` is just another field on the record, so a
// newer tombstone deletes and a newer live edit resurrects — whichever was
// touched last. This is pure and shared so the local app and any tooling
// resolve conflicts identically.

/**
 * @param {Array<{id:string, updated_at:string}>} local
 * @param {Array<{id:string, updated_at:string}>} incoming
 * @returns {Array<object>} merged records, one per id
 */
export function mergeRecords(local = [], incoming = []) {
  const byId = new Map();
  for (const rec of local) byId.set(rec.id, rec);
  for (const rec of incoming) {
    const existing = byId.get(rec.id);
    if (!existing || isNewer(rec, existing)) byId.set(rec.id, rec);
  }
  return [...byId.values()];
}

/** True when `a` was updated strictly later than `b` (ties keep the existing record). */
export function isNewer(a, b) {
  return String(a.updated_at ?? "") > String(b.updated_at ?? "");
}

/** Filter out tombstoned records for display/metric purposes. */
export function live(records = []) {
  return records.filter((r) => !r.deleted_at);
}
