// The snapshot.json contract — the single, versioned, PUBLIC data file
// (committed at docs/data/snapshot.json, served by GitHub Pages) that bridges
// the two people's local databases and feeds the published view.
//
// Shape:
// {
//   "schema_version": 1,          // bumped only on breaking structural changes
//   "version": 12,                // monotonically increasing per publish
//   "published_at": "2026-07-06T20:00:00.000Z",
//   "published_by": "woody",      // which person published this version
//   "people":       [ { id, name, created_at, updated_at, deleted_at }, ... ],
//   "accounts":     [ { id, owner, type, name, opening_balance, created_at, updated_at, deleted_at }, ... ],
//   "transactions": [ { id, account_id, owner, txn_date, description, source, deposit,
//                        withdrawal, note, created_at, updated_at, deleted_at }, ... ],
//   "plan_targets": [ { id, owner, kind, name, data, created_at, updated_at, deleted_at }, ... ]
// }
//
// Tombstoned (deleted_at != null) records ARE included so deletions propagate
// through the per-record merge on the other machine.

export const SCHEMA_VERSION = 1;

/** Build a snapshot object ready to be written to data/snapshot.json. */
export function buildSnapshot({ version, publishedBy, people = [], accounts = [], transactions = [], planTargets = [] }) {
  return {
    schema_version: SCHEMA_VERSION,
    version,
    published_at: new Date().toISOString(),
    published_by: publishedBy ?? "",
    people,
    accounts,
    transactions,
    plan_targets: planTargets,
  };
}

/** Parse/validate a snapshot fetched over HTTP or read from disk. Throws on obvious corruption. */
export function parseSnapshot(raw) {
  const snap = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof snap !== "object" || snap === null) throw new Error("snapshot is not an object");
  if (!Array.isArray(snap.transactions)) throw new Error("snapshot.transactions must be an array");
  if (!Array.isArray(snap.plan_targets)) throw new Error("snapshot.plan_targets must be an array");
  if (typeof snap.version !== "number") throw new Error("snapshot.version must be a number");
  // people/accounts were added in Phase 1; tolerate older snapshots that omit them.
  if (!Array.isArray(snap.people)) snap.people = [];
  if (!Array.isArray(snap.accounts)) snap.accounts = [];
  return snap;
}

/** The empty starting snapshot committed before anyone has published real data. */
export function emptySnapshot() {
  return {
    schema_version: SCHEMA_VERSION,
    version: 0,
    published_at: null,
    published_by: null,
    people: [],
    accounts: [],
    transactions: [],
    plan_targets: [],
  };
}
