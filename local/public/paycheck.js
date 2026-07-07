// This Paycheck — a per-person planner for the current pay window.
//
// The window comes from the person's pay cadence (config) anchored to their most
// recent paycheck in the ledger. Allocations are seeded from a recurring template
// (plan_targets kind=recurring_allocation). We project the running balance from
// the account's balance at the window start, flag any point it goes negative, and
// warn before applying. "Save template" persists the recurring plan; "Apply to
// ledger" materializes this window's entries as (projected) transactions.

import { windowFor, previousWindowFor, inWindow } from "/shared/paycycle.js";

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const params = new URLSearchParams(location.search);

const state = {
  people: [],
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,
  cadence: "biweekly",
  window: null,
  prevWindow: null,
  txns: [],
  startBal: 0,
  rows: [],               // working allocation rows
  removedPlanIds: new Set(),
  tplDirty: false,
};

let tempId = 0;

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) { const m = await res.json().catch(() => ({})); throw new Error(m.error || `${res.status} ${res.statusText}`); }
  return res.status === 204 ? null : res.json();
}
let toastTimer;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800); }

// --- current user ----------------------------------------------------------

const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
const currentPerson = () => state.people.find((p) => p.id === state.currentUser) || null;

function renderUserChip() {
  const chip = $("#userChip"); const p = currentPerson();
  if (!p || state.people.length <= 1) { chip.hidden = true; return; }
  const av = $("#userAvatar");
  av.innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  $("#userName").textContent = p.name;
  chip.hidden = false;
}
function showWho() {
  const box = $("#whoOptions"); box.innerHTML = "";
  for (const p of state.people) {
    const b = document.createElement("button");
    b.className = "who-card";
    b.innerHTML = (p.avatar ? `<img class="who-photo" src="${p.avatar}" alt="${p.name}">` : `<span class="who-photo initials">${initials(p.name)}</span>`) + `<span class="name">${p.name}</span>`;
    b.onclick = () => { localStorage.setItem("currentUser", p.id); location.href = "./paycheck.html"; };
    box.appendChild(b);
  }
  $("#who").hidden = false;
}
$("#userChip").addEventListener("click", showWho);

// --- load ------------------------------------------------------------------

async function init() {
  try {
    state.people = (await api("/api/people")).people;
    if (state.people.length <= 1) state.currentUser = state.people[0]?.id ?? null;
    else if (!state.people.some((p) => p.id === state.currentUser)) { showWho(); return; }
    renderUserChip();

    const person = currentPerson();
    state.cadence = person?.pay_cadence || "biweekly";

    const { accounts } = await api("/api/accounts");
    state.account = accounts.find((a) => a.owner === state.currentUser && a.type === "checking")
                 || accounts.find((a) => a.owner === state.currentUser) || null;
    if (!state.account) { $("main").innerHTML = `<div class="empty">No checking account for ${person?.name || "this person"} yet.</div>`; return; }

    const { transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.account.id)}`);
    state.txns = transactions;

    const today = new Date().toISOString().slice(0, 10);
    const anchor = anchorPaycheck(transactions, today);
    state.window = windowFor(state.cadence, anchor, today);
    state.prevWindow = previousWindowFor(state.cadence, anchor, today);
    state.startBal = balanceBefore(state.window.start);

    await loadTemplate();
    render();
  } catch (e) {
    $("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
  }
}

// Anchor = most recent paycheck deposit on/before today; else the latest/only one; else today.
function anchorPaycheck(txns, today) {
  const pays = txns.filter((t) => /paycheck/i.test(t.description || "") && Number(t.deposit) > 0).map((t) => t.txn_date).sort();
  if (!pays.length) return today;
  const past = pays.filter((d) => d <= today);
  return (past.length ? past[past.length - 1] : pays[pays.length - 1]);
}

// Account balance as of the day before `startISO` (opening + all prior net).
function balanceBefore(startISO) {
  let bal = Number(state.account.opening_balance) || 0;
  for (const t of state.txns) {
    if (t.txn_date < startISO) bal += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
  }
  return round2(bal);
}

async function loadTemplate() {
  const { plan_targets } = await api(`/api/plan-targets?owner=${encodeURIComponent(state.currentUser)}&kind=recurring_allocation`);
  state.rows = plan_targets.map((pt) => ({
    _id: "t" + (++tempId),
    planId: pt.id,
    category: pt.data.category ?? pt.name ?? "",
    source: pt.data.source ?? pt.name ?? "",
    amount: pt.data.amount ?? 0,
    flow: pt.data.flow === "in" ? "in" : "out",
  }));
  state.removedPlanIds = new Set();
  state.tplDirty = false;
}

// --- render ----------------------------------------------------------------

function project() {
  let bal = state.startBal, income = 0, out = 0, min = bal, minAt = null;
  const projById = new Map();
  for (const r of state.rows) {
    const amt = Number(r.amount) || 0;
    if (r.flow === "in") { bal = round2(bal + amt); income += amt; }
    else { bal = round2(bal - amt); out += amt; }
    projById.set(r._id, bal);
    if (bal < min) { min = bal; minAt = r; }
  }
  return { projById, income: round2(income), out: round2(out), endBal: bal, min: round2(min), minAt };
}

function render() {
  const p = project();
  $("#winTitle").textContent = `This Paycheck — ${state.account.name}`;
  $("#winSub").textContent = state.window
    ? `${state.cadence} · ${state.window.start} → ${state.window.end}`
    : "";
  $("#startBal").textContent = fmt(state.startBal);
  $("#incomeTotal").textContent = fmt(p.income);
  $("#outTotal").textContent = fmt(p.out);
  const endEl = $("#endBal"); endEl.textContent = fmt(p.endBal); endEl.classList.toggle("neg", p.endBal < 0); endEl.classList.toggle("pos", p.endBal >= 0);

  const banner = $("#banner");
  if (p.min < 0) {
    banner.className = "banner warn"; banner.hidden = false;
    banner.textContent = `⚠ This plan dips to ${fmt(p.min)} (at “${p.minAt?.source || p.minAt?.category || "an allocation"}”). Adjust amounts or you’ll overdraw.`;
  } else {
    banner.className = "banner ok"; banner.hidden = false;
    banner.textContent = `On track — ends the window at ${fmt(p.endBal)}.`;
  }

  const tbody = $("#rows"); tbody.innerHTML = "";
  $("#empty").hidden = state.rows.length > 0;
  for (const r of state.rows) tbody.appendChild(rowEl(r, p.projById.get(r._id)));
  renderAddRow();

  $("#saveTplBtn").disabled = !state.tplDirty;
  $("#saveTplBtn").textContent = state.tplDirty ? "Save template*" : "Save template";
}

function rowEl(r, proj) {
  const tr = document.createElement("tr");
  if (proj < 0) tr.className = "neg-row";

  tr.appendChild(cell("text", r.category, "categories", "Category", (v) => (r.category = v)));
  tr.appendChild(cell("text", r.source, null, "Source / Recipient", (v) => (r.source = v)));

  const dirTd = document.createElement("td");
  const flowBtn = document.createElement("button");
  flowBtn.className = "flow-toggle";
  flowBtn.textContent = r.flow === "in" ? "Income +" : "Expense −";
  flowBtn.style.color = r.flow === "in" ? "var(--pos)" : "var(--text)";
  flowBtn.onclick = () => { r.flow = r.flow === "in" ? "out" : "in"; markDirty(); render(); };
  dirTd.appendChild(flowBtn);
  tr.appendChild(dirTd);

  const amtTd = document.createElement("td"); amtTd.className = "num col-amt" + (r.flow === "in" ? " in" : "");
  const amt = document.createElement("input"); amt.type = "number"; amt.step = "0.01"; amt.min = "0"; amt.value = r.amount || "";
  amt.addEventListener("change", () => { r.amount = amt.value; markDirty(); render(); });
  amtTd.appendChild(amt); tr.appendChild(amtTd);

  const projTd = document.createElement("td"); projTd.className = "proj col-proj" + (proj < 0 ? " neg" : "");
  projTd.textContent = fmt(proj); tr.appendChild(projTd);

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button"); del.className = "del"; del.textContent = "×"; del.title = "Remove";
  del.onclick = () => { if (r.planId) state.removedPlanIds.add(r.planId); state.rows = state.rows.filter((x) => x !== r); markDirty(); render(); };
  act.appendChild(del); tr.appendChild(act);
  return tr;
}

function cell(type, value, list, placeholder, onChange) {
  const td = document.createElement("td");
  const inp = document.createElement("input");
  inp.type = type; inp.value = value ?? ""; if (placeholder) inp.placeholder = placeholder; if (list) inp.setAttribute("list", list);
  inp.addEventListener("change", () => { onChange(inp.value); markDirty(); render(); });
  td.appendChild(inp); return td;
}

const addDraft = () => ({ category: "", source: "", amount: "", flow: "out" });
let draft = addDraft();
function renderAddRow() {
  const foot = $("#addFoot"); foot.innerHTML = "";
  const tr = document.createElement("tr"); tr.className = "add";
  const mk = (type, key, list, ph) => {
    const td = document.createElement("td"); const inp = document.createElement("input");
    inp.type = type; inp.value = draft[key]; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (draft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addRow(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("text", "category", "categories", "Category"));
  tr.appendChild(mk("text", "source", null, "Source / Recipient"));
  const dirTd = document.createElement("td");
  const fb = document.createElement("button"); fb.className = "flow-toggle";
  fb.textContent = draft.flow === "in" ? "Income +" : "Expense −";
  fb.onclick = () => { draft.flow = draft.flow === "in" ? "out" : "in"; renderAddRow(); };
  dirTd.appendChild(fb); tr.appendChild(dirTd);
  tr.appendChild(mk("number", "amount", null, "0.00"));
  tr.appendChild(document.createElement("td"));
  const act = document.createElement("td"); act.className = "row-actions";
  const add = document.createElement("button"); add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = addRow; act.appendChild(add); tr.appendChild(act);
  foot.appendChild(tr);
}
function addRow() {
  if (!draft.amount) return toast("Enter an amount");
  state.rows.push({ _id: "t" + (++tempId), planId: null, category: draft.category, source: draft.source, amount: draft.amount, flow: draft.flow });
  draft = addDraft(); markDirty(); render();
}

function markDirty() { state.tplDirty = true; }

// --- actions ---------------------------------------------------------------

$("#fillBtn").addEventListener("click", () => {
  const pw = state.prevWindow;
  const rows = state.txns
    .filter((t) => inWindow(t.txn_date, pw))
    .sort((a, b) => cmp(a.txn_date, b.txn_date))
    .map((t) => ({ _id: "t" + (++tempId), planId: null, category: t.description || "", source: t.source || "", amount: Number(t.deposit) > 0 ? t.deposit : t.withdrawal, flow: Number(t.deposit) > 0 ? "in" : "out" }));
  if (!rows.length) return toast(`No entries found in the previous window (${pw.start} → ${pw.end}).`);
  if (state.rows.length && !confirm("Replace the current allocations with last paycheck’s entries?")) return;
  for (const r of state.rows) if (r.planId) state.removedPlanIds.add(r.planId);
  state.rows = rows; markDirty(); render();
  toast(`Filled ${rows.length} entries from ${pw.start} → ${pw.end}`);
});

$("#saveTplBtn").addEventListener("click", async () => {
  $("#saveTplBtn").disabled = true;
  try {
    for (const r of state.rows) {
      const body = { owner: state.currentUser, kind: "recurring_allocation", name: r.source || r.category, data: { category: r.category, source: r.source, amount: Number(r.amount) || 0, flow: r.flow } };
      if (r.planId) await api(`/api/plan-targets/${r.planId}`, { method: "PATCH", body });
      else { const res = await api("/api/plan-targets", { method: "POST", body }); r.planId = res.plan_target.id; }
    }
    for (const id of state.removedPlanIds) await api(`/api/plan-targets/${id}`, { method: "DELETE" });
    state.removedPlanIds = new Set(); state.tplDirty = false;
    toast("Template saved");
    render();
  } catch (e) { toast("Error: " + e.message); render(); }
});

$("#applyBtn").addEventListener("click", async () => {
  if (!state.rows.length) return toast("Nothing to apply");
  const p = project();
  if (p.min < 0 && !confirm(`This plan dips to ${fmt(p.min)} during the window. Apply to the ledger anyway?`)) return;
  $("#applyBtn").disabled = true;
  try {
    for (const r of state.rows) {
      const amt = Number(r.amount) || 0;
      await api("/api/transactions", {
        method: "POST",
        body: { account_id: state.account.id, owner: state.currentUser, txn_date: state.window.start, description: r.category, source: r.source, deposit: r.flow === "in" ? amt : 0, withdrawal: r.flow === "out" ? amt : 0 },
      });
    }
    toast(`Applied ${state.rows.length} entries to ${state.account.name} for ${state.window.start}`);
    // refresh starting balance / anchor in case this created the window's paycheck
    const { transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.account.id)}`);
    state.txns = transactions;
  } catch (e) { toast("Error: " + e.message); }
  $("#applyBtn").disabled = false;
});

init();
