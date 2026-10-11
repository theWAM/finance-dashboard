// T34 — the paired-transfer engine: one payment, two (or more) ledger rows.
//
// A card payment is not one transaction, it is a MOVEMENT with two ends, and
// the two ends live on different accounts. `transactions.transfer_id` (T26) is
// the join. This module is the single place that decides what pairs with what,
// so the three consumers can't drift:
//
//   - local/public/app.js        offers the mirror / propagates edits + deletes
//   - local/backfill-transfers.js  pairs + mirrors the history that pre-dates T34
//   - local/check-cards.js (T37)   asserts the result (#3, #8)
//
// Pure, zero-dep, browser + Node, no DOM — same contract as
// shared/card-import-spec.js, and for the same reason (#51): a rule
// re-implemented twice is a rule that will eventually disagree with itself.
//
// SIGN CONVENTION (#22). A card's debt is a NEGATIVE balance. On a card a
// charge is a `withdrawal` and a payment/refund/credit is a `deposit`; on
// checking money leaving is a `withdrawal`. So the two ends of one movement
// always carry OPPOSITE signs and equal magnitude, and a well-formed group
// nets to exactly zero.
//
// `transfer_id` IS A GROUP KEY, NOT A POINTER — which matters, because the real
// data is not 1:1. One $888.12 checking withdrawal to Apple arrives on the card
// as four rows ($73.12 + $45.00 + $504.00 + $266.00). Any number of rows may
// share a `transfer_id`; what must hold is that the group nets to zero.

export const PAYMENT_CATEGORY = "Credit Card Payment";
export const TRANSFER_CATEGORY = "Transfer";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const CENT = 0.005; // half a cent: the tolerance for "equal to the cent"
const lower = (s) => String(s ?? "").trim().toLowerCase();

/**
 * One row as a single signed number, in the ledger's own convention:
 * POSITIVE = value left this account (a checking withdrawal, a card charge),
 * NEGATIVE = value arrived (a checking deposit, a card payment).
 */
export const signed = (t) => round2((Number(t?.withdrawal) || 0) - (Number(t?.deposit) || 0));
export const magnitude = (t) => Math.abs(signed(t));
export const isLive = (t) => !t?.deleted_at;

/** Days from `a` to `b` (both ISO dates); negative when `b` is earlier. */
export const dayGap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// --- the alias map ---------------------------------------------------------

/**
 * Index every card's `data.source_aliases` (T25(a)'s map, stored on the card by
 * T26) so an inbound checking row can be recognized by its `source` string.
 *
 * Collisions are RETURNED, not thrown and not silently last-wins: two cards
 * claiming one alias means every payment on that string lands on whichever card
 * the account query happened to return second, which is a wrong balance with no
 * error anywhere. The caller decides how loud to be.
 *
 * @param {Array<object>} accounts  accounts rows, `data` already parsed
 * @returns {{ index: Map<string, object>, collisions: Array<{alias:string, cards:string[]}> }}
 */
export function cardAliasIndex(accounts = []) {
  const index = new Map();
  const claims = new Map();
  for (const a of accounts) {
    if (a?.type !== "credit_card") continue;
    const data = a.data && typeof a.data === "object" ? a.data : {};
    for (const alias of data.source_aliases || []) {
      const key = lower(alias);
      if (!key) continue;
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push(a.id);
      index.set(key, a);
    }
  }
  const collisions = [...claims.entries()]
    .filter(([, ids]) => new Set(ids).size > 1)
    .map(([alias, ids]) => ({ alias, cards: [...new Set(ids)] }));
  return { index, collisions };
}

/** The card a checking row's `source` names, or null. */
export const cardForSource = (index, source) => index.get(lower(source)) || null;

// --- classifying one row ---------------------------------------------------

/**
 * What kind of end-of-a-movement is this row, if any?
 *
 *   "outflow"       checking-side money leaving toward a card — the ONLY kind
 *                   whose absence of a pair is an error (#48)
 *   "inflow"        checking-side money arriving FROM a card (a refund or a
 *                   cash-back redemption paid out to the bank)
 *   "card_payment"  the card-side end of either of the above
 *   "card_transfer" a card-to-card balance transfer leg (#47) — no cash moved
 *   null            an ordinary row
 *
 * @param {object} row
 * @param {object} account  the row's own account (needs `type`)
 */
export function transferKind(row, account) {
  if (!row || !account) return null;
  const amt = signed(row);
  if (account.type === "credit_card") {
    if (row.description === TRANSFER_CATEGORY) return "card_transfer";
    return row.description === PAYMENT_CATEGORY ? "card_payment" : null;
  }
  if (row.description !== PAYMENT_CATEGORY) return null;
  return amt > 0 ? "outflow" : amt < 0 ? "inflow" : null; // a $0.00 row is a placeholder, not a movement
}

/** A fresh group key. Deterministic from `seed` when one is given (see the backfill). */
export function newTransferId(seed) {
  if (seed) return `tr-${seed}`;
  const rnd = globalThis.crypto?.randomUUID?.();
  return `tr-${rnd || Math.abs(Date.parse(new Date().toISOString())).toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36)}`;
}

// --- building the other end ------------------------------------------------

/**
 * The opposite end of `row`, as a draft transaction for `toAccount`.
 *
 * The mirror's sign is always the inverse of the source row's, which is what
 * makes the group net to zero. Its `description` is NOT copied blindly: a
 * card-side row that reduces debt is a `Credit Card Payment`, but a card-side
 * row that INCREASES debt because money went back to the bank is a `Transfer`.
 * Labelling that second case `Credit Card Payment` would hand T27/T32 a
 * "payment" with a charge's sign.
 *
 * @param {object} row          the end that already exists
 * @param {object} fromAccount  the account `row` sits on
 * @param {object} toAccount    the account the mirror belongs on
 * @param {string} transferId   the group key both ends share
 */
export function mirrorDraft(row, { fromAccount, toAccount, transferId, note } = {}) {
  const amt = signed(row);
  if (!toAccount) throw new Error("mirrorDraft: toAccount is required");
  if (Math.abs(amt) < CENT) throw new Error("mirrorDraft: a $0.00 row has no other end");
  const intoCard = toAccount.type === "credit_card";
  const reducesDebt = amt > 0; // value left `fromAccount`, so it arrives here
  return {
    account_id: toAccount.id,
    owner: toAccount.owner,
    txn_date: row.txn_date,
    description: intoCard && !reducesDebt ? TRANSFER_CATEGORY : row.description,
    source: fromAccount?.name || row.source || "",
    deposit: reducesDebt ? Math.abs(amt) : 0,
    withdrawal: reducesDebt ? 0 : Math.abs(amt),
    note: note ?? (fromAccount?.name ? `paired with ${fromAccount.name}` : ""),
    transfer_id: transferId,
  };
}

/**
 * Given a row the user just entered or edited, what should happen?
 *
 * Returns `{ action, card, reason }` where `action` is:
 *   "mirror"  — offer to create the other end on `card`
 *   "none"    — nothing to offer, with `reason` saying why (shown in the UI,
 *               because "it didn't ask me" is otherwise indistinguishable from
 *               "it asked and I said no")
 *
 * Deliberately NOT decided here: whether the mirror would land inside a card's
 * already-imported window. That needs the whole ledger, so it lives in
 * `seededGuard` below and the caller composes the two.
 */
export function proposeMirror(row, { account, accounts = [], aliasIndex } = {}) {
  const kind = transferKind(row, account);
  if (!kind) {
    if (row?.description === PAYMENT_CATEGORY && Math.abs(signed(row)) < CENT) {
      return { action: "none", card: null, reason: "a $0.00 payment has no other end" };
    }
    return { action: "none", card: null, reason: "not a card payment" };
  }
  if (row.transfer_id) return { action: "none", card: null, reason: "already paired" };
  const { index } = aliasIndex || cardAliasIndex(accounts);
  if (kind === "card_payment" || kind === "card_transfer") {
    // From the card side the counterparty is not derivable from the row: every
    // issuer writes its own opaque string ("AUTOPAY 2606030…", "Bill Payment").
    // The caller picks the account; we only say that a pair is wanted.
    return { action: "mirror", card: null, reason: "card-side row — pick the other account" };
  }
  const card = cardForSource(index, row.source);
  if (!card) return { action: "none", card: null, reason: `no card claims the source "${row.source}"` };
  return { action: "mirror", card, reason: "" };
}

/**
 * May a mirror be WRITTEN onto `card` at `date`, or must it pair with a row
 * that is already there?
 *
 * This is the phase's one silent-corruption guard. T26b loaded real statement
 * rows onto the card side for the months it covered, and each card's
 * `opening_balance` was then DERIVED so the replay lands on a stated balance to
 * the cent. Two consequences, in opposite directions, and both of them wrong by
 * about a month of payments:
 *
 *   - inside `data.seeded_range` the card-side row already exists, so mirroring
 *     creates a SECOND one;
 *   - at or before the reconciliation anchor (`data.statements.as_of`) but
 *     outside the seeded range, the payment is already absorbed INTO the
 *     derived `opening_balance`, so mirroring double-counts it there instead.
 *     (The task's "mirror only payments outside the seeded range" misses this
 *     second case — see T34's write-up.)
 *
 * Only dates strictly after the anchor are safe: those are projections, beyond
 * every figure that was reconciled. A card with no anchor at all has nothing
 * holding its balance in place, so it gets no mirrors either.
 *
 * @returns {{ ok: boolean, zone: "seeded"|"pre-anchor"|"post-anchor"|"no-anchor", anchor: string|null, why: string }}
 */
export function seededGuard(card, date) {
  const data = card?.data && typeof card.data === "object" ? card.data : {};
  const range = Array.isArray(data.seeded_range) ? data.seeded_range : null;
  const anchor = data.statements?.as_of || (range ? range[1] : null) || null;
  if (range && date >= range[0] && date <= range[1]) {
    return { ok: false, zone: "seeded", anchor, why: `${date} is inside the imported range ${range[0]}..${range[1]} — pair with the row that is already there, don't mirror` };
  }
  if (!anchor) {
    return { ok: false, zone: "no-anchor", anchor: null, why: `${card?.id} has no imported ledger and no stated balance — a mirror would move a balance nothing is holding in place` };
  }
  if (date <= anchor) {
    return { ok: false, zone: "pre-anchor", anchor, why: `${date} is at or before the reconciliation anchor ${anchor} — already absorbed into the derived opening_balance` };
  }
  return { ok: true, zone: "post-anchor", anchor, why: `${date} is after the anchor ${anchor} — a projection on both sides` };
}

// --- reading what is already there ----------------------------------------

/** Map transfer_id → its live rows. Rows without one are not in any group. */
export function transferGroups(transactions = []) {
  const groups = new Map();
  for (const t of transactions) {
    if (!isLive(t) || !t.transfer_id) continue;
    if (!groups.has(t.transfer_id)) groups.set(t.transfer_id, []);
    groups.get(t.transfer_id).push(t);
  }
  return groups;
}

/** Does a group balance? `net` is the signed sum; a sound group nets to 0. */
export function groupNet(rows = []) {
  return round2(rows.reduce((s, t) => s + signed(t), 0));
}

/**
 * One row's pairing state, for the badge in the grid and for T37.
 *
 * The asymmetry is the whole point (#48): Apple's 2026-09 holds $2,382.00 of
 * card-side payments against $2,358.17 of checking withdrawals, and the $23.83
 * gap is two `Apple Cash Payment` rows paid from Apple Cash. An unpaired
 * card-side deposit is real data. An unpaired checking-side withdrawal is money
 * that left the household with no record of where it went.
 *
 * @returns {{ state: "paired"|"unpaired"|"mismatched"|"solo-ok"|"none",
 *             severity: "ok"|"info"|"error", kind: string|null,
 *             net: number, peers: Array<object>, why: string }}
 */
export function pairState(row, { account, groups, accountById } = {}) {
  const kind = transferKind(row, account);
  const none = { state: "none", severity: "ok", kind: null, net: 0, peers: [], why: "" };
  if (!kind) return none;

  if (row.transfer_id) {
    const all = groups?.get(row.transfer_id) || [row];
    const peers = all.filter((t) => t.id !== row.id);
    const net = groupNet(all);
    if (!peers.length) {
      return { state: "unpaired", severity: "error", kind, net, peers, why: `transfer_id ${row.transfer_id} has only this row` };
    }
    if (Math.abs(net) >= CENT) {
      return {
        state: "mismatched", severity: "error", kind, net, peers,
        why: `group ${row.transfer_id} is off by ${net.toFixed(2)} across ${all.length} rows — a half-updated pair`,
      };
    }
    const where = peers.map((p) => accountById?.get(p.account_id)?.name || p.account_id);
    return { state: "paired", severity: "ok", kind, net, peers, why: `paired with ${[...new Set(where)].join(", ")}` };
  }

  if (kind === "outflow") {
    return { state: "unpaired", severity: "error", kind, net: signed(row), peers: [], why: "money left checking with no card-side counterpart" };
  }
  return {
    state: "solo-ok", severity: "info", kind, net: signed(row), peers: [],
    why: kind === "card_payment"
      ? "card-side payment with no checking counterpart — valid (paid from a non-ledger source, decision #48)"
      : kind === "card_transfer"
        ? "balance-transfer leg with no counterparty ledger (decision #47)"
        : "money arrived from a card with no card-side counterpart",
  };
}

/**
 * The whole-ledger audit, shared by the backfill's assertion and T37's #3/#8.
 *
 * @param {{transactions: Array<object>, accounts: Array<object>}} input
 *        `accounts[].data` must already be parsed.
 */
export function auditTransfers({ transactions = [], accounts = [] } = {}) {
  const live = transactions.filter(isLive);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const groups = transferGroups(live);
  const { collisions } = cardAliasIndex(accounts);

  const unpairedOutflow = [], mismatched = [], soloCardSide = [], soloInflow = [], paired = [];
  for (const row of live) {
    const account = accountById.get(row.account_id);
    const st = pairState(row, { account, groups, accountById });
    if (st.state === "none") continue;
    const rec = { row, account, ...st };
    if (st.state === "mismatched") mismatched.push(rec);
    else if (st.state === "unpaired") (st.kind === "outflow" ? unpairedOutflow : soloCardSide).push(rec);
    else if (st.state === "solo-ok") (st.kind === "inflow" ? soloInflow : soloCardSide).push(rec);
    else paired.push(rec);
  }

  // T37 assertion #8 / the T26b+T34 double-mirror failure: on ONE card, two
  // live rows sharing a date and a magnitude with no transfer_id tying them
  // together is what "mirrored a payment that was already imported" looks like
  // from the outside. Rows already in the same group are excluded — a genuine
  // pair is allowed to look identical.
  //
  // Scoped to rows that could BE a transfer end (`Credit Card Payment` /
  // `Transfer`), which is narrower than the task's wording and deliberately so.
  // Two same-day same-amount PURCHASES are routine real-world data, and this
  // corpus holds seven of them — two $16.34 Pisces, two $5.00 Ventra, two
  // Delta pairs — all genuine, all preserved on purpose by the `occurrence`
  // component of #51's `external_id`. Flagging those would make the assertion
  // fire on correct data, which is how an assertion gets switched off. They are
  // reported separately as `duplicateCharges`, informational.
  const doubleRisk = [], duplicateCharges = [];
  const byCard = new Map();
  for (const t of live) {
    const a = accountById.get(t.account_id);
    if (a?.type !== "credit_card") continue;
    const key = `${t.account_id}|${t.txn_date}|${magnitude(t).toFixed(2)}|${signed(t) > 0 ? "out" : "in"}`;
    if (!byCard.has(key)) byCard.set(key, []);
    byCard.get(key).push(t);
  }
  const couldPair = (t) => t.description === PAYMENT_CATEGORY || t.description === TRANSFER_CATEGORY;
  for (const [key, rows] of byCard) {
    if (rows.length < 2 || magnitude(rows[0]) < CENT) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (a.transfer_id && a.transfer_id === b.transfer_id) continue;
        (couldPair(a) && couldPair(b) ? doubleRisk : duplicateCharges).push({ key, rows: [a, b] });
      }
    }
  }

  return {
    groups, paired, unpairedOutflow, mismatched, soloCardSide, soloInflow,
    aliasCollisions: collisions, doubleRisk, duplicateCharges,
    // The two that are errors, and the two that are not. Keeping them apart in
    // the return shape is how the asymmetry survives the next caller.
    errors: unpairedOutflow.length + mismatched.length + collisions.length + doubleRisk.length,
    ok: unpairedOutflow.length === 0 && mismatched.length === 0 && collisions.length === 0 && doubleRisk.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The enumerated, human-explained exceptions to "every checking-side payment
// pairs." Lives here (not in local/backfill-transfers.js) so `--audit` and
// T37's check-cards.js assert against the exact same list rather than two
// copies that can drift apart one entry at a time.
// ---------------------------------------------------------------------------
export const KNOWN_UNPAIRED = [
  // (a) woody-chase-card in-window mismatches (see backfill-transfers.js's
  // "RESOLVED" note) — the other 3 of 5 now pair exactly and are no longer
  // exceptions.
  { date: "2026-03-19", amount: 750.00, source: "Chase Card", why: "card row 2026-03-19 is $567.17 — off $182.83 (unrelated to the Apple Card $750.00 same-day entry below)" },
  { date: "2026-04-14", amount: 250.00, source: "Chase Card", why: "nearest card row is 2026-04-02 at $250.00 (exact) but 12 days away — one day outside this script's ±10d window" },
  // (b) rajna-discover — before the export begins, already in opening_balance
  { date: "2026-01-05", amount: 360.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-01-26", amount: 800.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-02-02", amount: 63.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-02-04", amount: 300.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-03-02", amount: 400.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-03-02", amount: 450.00, source: "Discover", why: "pre-anchor" },
  { date: "2026-03-03", amount: 1000.00, source: "Rajna Discover", why: "pre-anchor" },
  // (c) in-window near-misses — a human can settle each of these in one look
  { date: "2026-03-19", amount: 750.00, source: "Apple Card", why: "card row 2026-03-19 is $759.75 — off $9.75" },
  { date: "2026-04-29", amount: 779.00, source: "Apple Card", why: "card row 2026-04-24 is $779.11 — off $0.11" },
  { date: "2026-05-28", amount: 856.17, source: "Apple Card", why: "card row 2026-05-29 is $850.00 — off $6.17" },
  { date: "2026-04-16", amount: 303.00, source: "Capital One", why: "card row 2026-04-16 is $303.66 — off $0.66" },
  { date: "2026-05-09", amount: 405.78, source: "Capital One", why: "no card row sums to it within ±10d" },
  { date: "2026-07-09", amount: 78.00, source: "Rajna Discover", why: "card row 2026-07-09 is $86.56 — off $8.56" },
  // (c) in-window with no card row within the window at all
  { date: "2026-05-14", amount: 100.00, source: "Rajna Discover", why: "no card row within ±10d" },
  { date: "2026-06-11", amount: 120.00, source: "Rajna Discover", why: "no card row within ±10d" },
  { date: "2026-09-03", amount: 200.00, source: "Rajna Discover", why: "no card row within ±10d" },
  { date: "2026-09-03", amount: 200.00, source: "Discover", why: "no card row within ±10d" },
  { date: "2026-10-01", amount: 200.00, source: "Rajna Discover", why: "no card row within ±10d" },
  { date: "2026-10-15", amount: 60.00, source: "Rajna Chase", why: "nearest card row is the 2026-10-27 autopay at $40.00" },
];

const sameUnpaired = (u, k) => u.row.txn_date === k.date && Math.abs(magnitude(u.row) - k.amount) < CENT && u.row.source === k.source;

/** Unpaired outflows NOT covered by an enumerated exception — a real failure. */
export const unexpectedUnpaired = (unpairedOutflow, known = KNOWN_UNPAIRED) =>
  unpairedOutflow.filter((u) => !known.some((k) => sameUnpaired(u, k)));

/** Enumerated exceptions that no longer describe any unpaired row — the list has gone stale. */
export const staleKnownUnpaired = (unpairedOutflow, known = KNOWN_UNPAIRED) =>
  known.filter((k) => !unpairedOutflow.some((u) => sameUnpaired(u, k)));
