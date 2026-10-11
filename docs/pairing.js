// T34 — the Ledger's half of the paired-transfer flow.
//
// All the arithmetic and every pairing rule lives in /shared/transfers.js, which
// the backfill and T37's checker import too. This module is only the browser
// side: fetch the group index, badge the rows, and ask the question.
//
// Why a question at all. A card payment has two ends and the Ledger shows one
// account at a time, so the second end is always somewhere you are not looking.
// Writing it silently would be worse than not writing it: the row you cannot
// see is the row you cannot check. So every pairing decision is explicit, and
// DECLINING LEAVES A VISIBLY UNPAIRED ROW — never a half-updated pair. A $1,240
// withdrawal sitting against a $900 deposit under one `transfer_id` reconciles
// to nothing and looks joined; an unpaired row carries a ⚠ and T37 finds it.

import { PAYMENT_CATEGORY, cardAliasIndex, cardForSource, mirrorDraft, newTransferId, pairState, seededGuard, signed } from "./shared/transfers.js";

export { PAYMENT_CATEGORY, newTransferId, signed };

/**
 * The group index, or an inert one.
 *
 * `/api/transfers` does not exist on the published site (docs/mock-api.js 404s
 * unknown routes), and a published Ledger must still render. A 404 therefore
 * degrades to no badges and no offers rather than an exception — `readOnly`
 * tells the caller which world it is in.
 */
export async function loadTransferIndex() {
  try {
    const res = await fetch("/api/transfers");
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    return {
      groups: j.groups || {},
      unpaired: new Set(j.unpaired || []),
      cards: j.cards || [],
      summary: j.summary || null,
      readOnly: false,
    };
  } catch {
    return { groups: {}, unpaired: new Set(), cards: [], summary: null, readOnly: true };
  }
}

/** The group a row belongs to, as `{ net, rows }`, or null. */
export const groupOf = (index, row) => (row?.transfer_id ? index.groups[row.transfer_id] || null : null);

/**
 * The badge for one row: an element, or null when the row is not an end of a
 * movement. Three states, and the asymmetry between them is decision #48:
 *
 *   ↔  paired      — hover names the other account, the other date, the amount
 *   ⚠  unpaired    — ERROR, but only on money LEAVING checking toward a card
 *   ·  solo        — fine. A card-side payment with no checking counterpart is
 *                    real (Apple Cash pays Apple directly); so is a balance
 *                    transfer leg whose counterparty has no ledger (#47).
 */
// `pairState` wants a Map of transfer_id → rows; the index carries trimmed rows,
// which is all it reads. Built once per index rather than once per row: the
// naive version rebuilt 116 groups for each of ~2,000 grid rows on every render.
const groupMaps = new WeakMap();
const groupMapFor = (index) => {
  let m = groupMaps.get(index);
  if (!m) { m = new Map(Object.entries(index.groups).map(([k, g]) => [k, g.rows])); groupMaps.set(index, m); }
  return m;
};

export function pairBadge(row, { account, index, accountById }) {
  if (!account || !index) return null;
  // No index, no badges. Without the groups a PAIRED row is indistinguishable
  // from an unpaired one, and `pairState` would read every one of them as a
  // one-row group and flag it ⚠ — which is exactly what the published view did
  // before this guard: 11 correctly-paired payments, all marked broken. A
  // badge that cannot be computed must be absent, not wrong.
  if (index.readOnly) return null;
  const st = pairState(row, { account, groups: groupMapFor(index), accountById });
  if (st.state === "none") return null;

  const el = document.createElement("span");
  el.className = "pair-badge " + st.state;
  if (st.state === "paired") {
    const g = index.groups[row.transfer_id];
    el.textContent = g && g.rows.length > 2 ? `↔${g.rows.length - 1}` : "↔";
    const peers = (g?.rows || []).filter((r) => r.id !== row.id);
    el.title = "Paired with\n" + peers
      .map((p) => `  ${p.account_name} · ${p.txn_date} · ${money(p.deposit - p.withdrawal)}`)
      .join("\n") + (g && g.rows.length > 2 ? `\n\nA 1:${g.rows.length - 1} split — one payment that arrived as several rows.` : "");
  } else if (st.state === "mismatched") {
    el.textContent = "✗";
    el.title = `Half-updated pair: ${st.why}. Fix one side or break the link.`;
  } else if (st.state === "unpaired") {
    el.textContent = "⚠";
    el.title = st.why + "\nNothing on the card side received this. Pair it or fix the amount.";
  } else {
    el.textContent = "·";
    el.title = st.why;
  }
  return el;
}

const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => CURRENCY.format(Number(n) || 0);

/**
 * Would this row want a mirror, and where would it land?
 *
 * Composes the two halves the shared module keeps apart: which card claims the
 * `source`, and whether that card's reconciliation allows a row to be WRITTEN
 * at that date. The second half is the one that matters — a mirror inside a
 * card's imported window makes an already-imported payment exist twice, and the
 * only symptom is a card balance quietly off by about a month of payments.
 *
 * @returns {{ok:boolean, card?:object, draft?:object, why:string}}
 */
export function mirrorPlan(draft, { account, accounts, transferId }) {
  const row = { ...draft, deposit: Number(draft.deposit) || 0, withdrawal: Number(draft.withdrawal) || 0 };
  if (row.description !== PAYMENT_CATEGORY) return { ok: false, why: "not a card payment" };
  const amt = signed(row);
  if (Math.abs(amt) < 0.005) return { ok: false, why: "a $0.00 payment has no other end" };
  if (account?.type === "credit_card") return { ok: false, why: "card-side rows are paired from the checking side" };
  const { index } = cardAliasIndex(accounts);
  const card = cardForSource(index, row.source);
  if (!card) return { ok: false, why: `no card claims the source “${row.source || "—"}”` };
  const guard = seededGuard(card, row.txn_date);
  if (!guard.ok) return { ok: false, card, why: guard.why };
  return {
    ok: true, card, why: guard.why,
    draft: mirrorDraft(row, { fromAccount: account, toAccount: card, transferId }),
  };
}

// --- the question ----------------------------------------------------------

let modalEl = null;

/**
 * Ask, and resolve to the chosen option's `value`. Esc / scrim resolves to the
 * option flagged `cancel` (or null), so dismissing never commits anything.
 *
 * @param {{title:string, body:string, options:Array<{value:string,label:string,hint?:string,primary?:boolean,cancel?:boolean}>}} spec
 */
export function askPair({ title, body, options }) {
  if (!modalEl) {
    modalEl = document.createElement("div");
    modalEl.className = "modal pair-modal";
    modalEl.hidden = true;
    modalEl.innerHTML = `<div class="modal-card pair-card">
      <h2></h2><p class="pair-body"></p><div class="pair-options"></div></div>`;
    document.body.appendChild(modalEl);
  }
  const card = modalEl.querySelector(".pair-card");
  card.querySelector("h2").textContent = title;
  card.querySelector(".pair-body").innerHTML = body;
  const box = card.querySelector(".pair-options");
  box.innerHTML = "";
  modalEl.hidden = false;

  return new Promise((resolve) => {
    const close = (v) => {
      modalEl.hidden = true;
      document.removeEventListener("keydown", onKey);
      modalEl.removeEventListener("click", onScrim);
      resolve(v);
    };
    const cancelValue = options.find((o) => o.cancel)?.value ?? null;
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(cancelValue); } };
    const onScrim = (e) => { if (e.target === modalEl) close(cancelValue); };
    document.addEventListener("keydown", onKey);
    modalEl.addEventListener("click", onScrim);
    for (const o of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pair-opt" + (o.primary ? " primary" : "");
      btn.innerHTML = `<span class="pair-opt-label">${o.label}</span>` + (o.hint ? `<span class="pair-opt-hint">${o.hint}</span>` : "");
      btn.onclick = () => close(o.value);
      box.appendChild(btn);
    }
    box.querySelector("button")?.focus();
  });
}
