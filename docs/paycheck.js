// This Paycheck — the current pay window as a focused, editable slice of the
// ledger. The window is [payday, next payday) from the person's cadence, anchored
// to their most recent paycheck. We prefill the ledger entries that fall inside
// that window (what's *known to happen* this pay period — paycheck, savings,
// investments, card payments, car note, …), project the running balance from the
// balance entering the window, flag where it goes negative, and warn before
// saving. Edits/adds/deletes are staged and written back to the ledger on Save.

import { windowFor } from "./shared/paycycle.js";

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Same-day order: paycheck > investments > savings > bills > everything else.
const isPaycheck = (t) => /paycheck/i.test(t.description || "") && (Number(t.deposit) || 0) > 0;
const DAY_RANK = { Investments: 1, Savings: 2, Bill: 3 };
const dayRank = (t) => (isPaycheck(t) ? 0 : (DAY_RANK[t.description] ?? 4));
const byDate = (a, b) =>
  cmp(a.txn_date, b.txn_date) ||
  (dayRank(a) - dayRank(b)) ||
  cmp(a.created_at || "", b.created_at || "");
const params = new URLSearchParams(location.search);
const TODAY = new Date().toISOString().slice(0, 10);

const state = {
  people: [],
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,
  cadence: "biweekly",
  anchor: null,           // stable payday the pay-window grid is anchored to
  refDate: null,          // the day whose pay window is currently shown
  window: null,
  txns: [],               // all account transactions as last loaded
  edits: new Map(),       // id -> { field: value }
  dels: new Set(),        // ids staged for deletion
  news: [],               // staged new rows
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
  $("#userAvatar").innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  $("#userName").textContent = p.name;
  chip.hidden = false;
}
function showWho() {
  const box = $("#whoOptions"); box.innerHTML = "";
  for (const p of state.people) {
    const b = document.createElement("button"); b.className = "who-card";
    b.innerHTML = (p.avatar ? `<img class="who-photo" src="${p.avatar}" alt="${p.name}">` : `<span class="who-photo initials">${initials(p.name)}</span>`) + `<span class="name">${p.name}</span>`;
    b.onclick = () => { if (hasPending() && !confirm("Discard unsaved changes?")) return; localStorage.setItem("currentUser", p.id); location.href = "./paycheck.html"; };
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
    state.cadence = currentPerson()?.pay_cadence || "biweekly";

    const { accounts } = await api("/api/accounts");
    state.account = accounts.find((a) => a.owner === state.currentUser && a.type === "checking")
                 || accounts.find((a) => a.owner === state.currentUser) || null;
    if (!state.account) { $("main").innerHTML = `<div class="empty">No checking account for this person yet.</div>`; return; }

    await loadWindow();
  } catch (e) { $("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`; }
}

// Fetch the ledger and reset staged edits; keeps whatever pay period is in view.
async function loadWindow() {
  const { transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.account.id)}`);
  state.txns = transactions;
  state.anchor = anchorPaycheck(transactions, TODAY); // stable grid anchor
  if (!state.refDate) state.refDate = TODAY;
  clearPending();
  showWindow();
}

// Recompute + render the pay window containing state.refDate (no fetch, no clear).
function showWindow() {
  state.window = windowFor(state.cadence, state.anchor, state.refDate);
  render();
}

const shiftDay = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};
function gotoPrev() { state.refDate = shiftDay(state.window.start, -1); showWindow(); }
function gotoNext() { state.refDate = state.window.nextStart; showWindow(); }
$("#prevWin").addEventListener("click", gotoPrev);
$("#nextWin").addEventListener("click", gotoNext);
$("#winRange").addEventListener("click", () => { const el = $("#winDate"); el.value = state.refDate; if (el.showPicker) el.showPicker(); else el.focus(); });
$("#winDate").addEventListener("change", (e) => { if (e.target.value) { state.refDate = e.target.value; showWindow(); } });

// Anchor = most recent paycheck deposit on/before today; else the latest/only; else today.
function anchorPaycheck(txns, today) {
  const pays = txns.filter((t) => /paycheck/i.test(t.description || "") && Number(t.deposit) > 0).map((t) => t.txn_date).sort();
  if (!pays.length) return today;
  const past = pays.filter((d) => d <= today);
  return past.length ? past[past.length - 1] : pays[pays.length - 1];
}

function clearPending() { state.edits.clear(); state.dels.clear(); state.news = []; addDraft = freshDraft(); }
const inWin = (d) => d >= state.window.start && d < state.window.nextStart;

// Merge staged changes over the ledger, run the running balance oldest→newest,
// then surface just this window's rows with their projected balance.
function computeView() {
  const all = [];
  for (const t of state.txns) {
    if (state.dels.has(t.id)) { all.push({ ...t, _id: t.id, _deleted: true }); continue; }
    const e = state.edits.get(t.id);
    all.push({ ...t, ...(e || {}), _id: t.id, _edited: !!e });
  }
  for (const n of state.news) all.push({ ...n, _id: n._tempId, _new: true });

  const live = all.filter((r) => !r._deleted)
    .sort(byDate);
  let bal = Number(state.account.opening_balance) || 0;
  let startBal = bal;
  const balById = new Map();
  for (const t of live) {
    bal = round2(bal + (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0));
    balById.set(t._id, bal);
    if (t.txn_date < state.window.start) startBal = bal;
  }

  // Display set: window rows (incl. staged deletes for restore), chronological.
  const rows = all.filter((r) => inWin(r.txn_date)).sort(byDate);
  let deposits = 0, withdrawals = 0, min = startBal, minRow = null, endBal = startBal;
  for (const r of rows) {
    if (r._deleted) continue;
    deposits += Number(r.deposit) || 0;
    withdrawals += Number(r.withdrawal) || 0;
    const b = balById.get(r._id);
    endBal = b;
    if (b < min) { min = b; minRow = r; }
  }
  return { rows, balById, startBal, endBal: round2(endBal), deposits: round2(deposits), withdrawals: round2(withdrawals), min: round2(min), minRow };
}

// Categorical colors assigned by category IDENTITY (never by slice size), from the
// validated dark palette; unmapped categories fold into a single gray "Other".
const CAT_COLORS = {
  "Housing": "#3987e5", "Bill": "#199e70", "Savings": "#c98500", "Investments": "#008300",
  "Credit Card Payment": "#9085e9", "Loan Payment": "#e66767", "Food": "#d55181", "Fun": "#d95926",
};
const OTHER_COLOR = "#898781";
const NS = "http://www.w3.org/2000/svg";

function renderChart(rows) {
  // Sum outflow (allocations) by category; unmapped → "Other".
  const sums = new Map();
  for (const r of rows) {
    if (r._deleted) continue;
    const w = Number(r.withdrawal) || 0;
    if (w <= 0) continue;
    const key = CAT_COLORS[r.description] ? r.description : "Other";
    sums.set(key, round2((sums.get(key) || 0) + w));
  }
  const total = round2([...sums.values()].reduce((a, b) => a + b, 0));
  const chart = document.querySelector("#chart");
  if (total <= 0) { chart.hidden = true; return; }
  chart.hidden = false;

  const data = [...sums.entries()]
    .map(([cat, amount]) => ({ cat, amount, color: cat === "Other" ? OTHER_COLOR : CAT_COLORS[cat] }))
    .sort((a, b) => b.amount - a.amount);

  // --- donut ---
  const svg = document.querySelector("#donut");
  svg.innerHTML = "";
  const cx = 110, cy = 110, rO = 96, rI = 60, pad = data.length > 1 ? 0.03 : 0;
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  let start = -Math.PI / 2;
  for (const d of data) {
    const frac = d.amount / total;
    const end = start + frac * 2 * Math.PI;
    const a0 = start + pad / 2, a1 = Math.max(a0, end - pad / 2);
    const [x1, y1] = pt(rO, a0), [x2, y2] = pt(rO, a1), [x3, y3] = pt(rI, a1), [x4, y4] = pt(rI, a0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${x1} ${y1} A${rO} ${rO} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${rI} ${rI} 0 ${large} 0 ${x4} ${y4} Z`);
    path.setAttribute("fill", d.color);
    const title = document.createElementNS(NS, "title");
    title.textContent = `${d.cat}: ${fmt(d.amount)} (${Math.round(frac * 100)}%)`;
    path.appendChild(title);
    svg.appendChild(path);
    // Direct % label for slices with enough room (≥ 7%).
    if (frac >= 0.07) {
      const [lx, ly] = pt((rO + rI) / 2, (a0 + a1) / 2);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("class", "slice-label"); t.setAttribute("x", lx); t.setAttribute("y", ly + 4);
      t.textContent = `${Math.round(frac * 100)}%`;
      svg.appendChild(t);
    }
    start = end;
  }
  const totalText = document.createElementNS(NS, "text");
  totalText.setAttribute("class", "donut-total"); totalText.setAttribute("x", cx); totalText.setAttribute("y", cy);
  totalText.textContent = fmt(total);
  const subText = document.createElementNS(NS, "text");
  subText.setAttribute("class", "donut-sub"); subText.setAttribute("x", cx); subText.setAttribute("y", cy + 16);
  subText.textContent = "allocated";
  svg.append(totalText, subText);

  // --- legend (identity is never color-alone) ---
  const legend = document.querySelector("#legend");
  legend.innerHTML = "";
  for (const d of data) {
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = d.color;
    const cat = document.createElement("span"); cat.className = "cat"; cat.textContent = d.cat;
    const amt = document.createElement("span"); amt.className = "amt"; amt.textContent = fmt(d.amount);
    const pct = document.createElement("span"); pct.className = "pct"; pct.textContent = `${Math.round((d.amount / total) * 100)}%`;
    legend.append(sw, cat, amt, pct);
  }
}

function render() {
  const v = computeView();
  $("#winTitle").textContent = `This Paycheck — ${state.account.name}`;
  const isCurrent = inWin(TODAY);
  $("#winRange").innerHTML = `${state.cadence} · ${state.window.start} → ${state.window.end}` + (isCurrent ? ` <span class="today-dot">• current</span>` : "");
  $("#startBal").textContent = fmt(v.startBal);
  $("#incomeTotal").textContent = fmt(v.deposits);
  $("#outTotal").textContent = fmt(v.withdrawals);
  const endEl = $("#endBal"); endEl.textContent = fmt(v.endBal);
  endEl.classList.toggle("neg", v.endBal < 0); endEl.classList.toggle("pos", v.endBal >= 0);

  const banner = $("#banner");
  if (v.min < 0) {
    banner.className = "banner warn"; banner.hidden = false;
    const where = v.minRow ? `“${v.minRow.source || v.minRow.description || "an entry"}”` : "the starting balance";
    banner.textContent = `⚠ This pay period dips to ${fmt(v.min)} (at ${where}). Adjust amounts or you’ll overdraw.`;
  } else {
    banner.className = "banner ok"; banner.hidden = false;
    banner.textContent = `On track — ends the pay period at ${fmt(v.endBal)}.`;
  }

  renderChart(v.rows);

  const tbody = $("#rows"); tbody.innerHTML = "";
  $("#empty").hidden = v.rows.length > 0;
  for (const r of v.rows) tbody.appendChild(rowEl(r, v.balById.get(r._id)));
  renderAddRow();
  renderControls();
}

function rowEl(row, proj) {
  const tr = document.createElement("tr");
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  else if (proj < 0) tr.className = "neg-row";
  const dis = !!row._deleted;

  tr.appendChild(cell("date", row.txn_date, "txn_date", "col-date", null, "", dis));
  tr.appendChild(cell("text", row.description, "description", "", "categories", "Category", dis));
  tr.appendChild(cell("text", row.source, "source", "", null, "Source / Recipient", dis));
  tr.appendChild(cell("number", row.deposit || "", "deposit", "num col-dep", null, "", dis));
  tr.appendChild(cell("number", row.withdrawal || "", "withdrawal", "num col-wd", null, "", dis));

  const projTd = document.createElement("td");
  projTd.className = "proj col-proj" + (!row._deleted && proj < 0 ? " neg" : "");
  projTd.textContent = row._deleted ? "—" : fmt(proj);
  tr.appendChild(projTd);

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button");
  del.className = "del" + (row._deleted ? " restore" : "");
  del.textContent = row._deleted ? "↺" : "×"; del.title = row._deleted ? "Restore" : "Delete";
  del.onclick = () => toggleDelete(row);
  act.appendChild(del); tr.appendChild(act);

  tr.querySelectorAll("input[data-field]").forEach((inp) => inp.addEventListener("change", () => stageEdit(row, inp.dataset.field, inp.value)));
  return tr;
}

function cell(type, value, field, cls = "", list = null, ph = "", disabled = false) {
  const td = document.createElement("td"); if (cls) td.className = cls;
  const inp = document.createElement("input");
  inp.type = type; inp.value = value ?? ""; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
  if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
  if (disabled) inp.disabled = true;
  inp.dataset.field = field; td.appendChild(inp); return td;
}

function stageEdit(row, field, value) {
  if (row._new) { const n = state.news.find((x) => x._tempId === row._id); if (n) n[field] = value; }
  else { const e = state.edits.get(row._id) || {}; e[field] = value; state.edits.set(row._id, e); }
  render();
}
function toggleDelete(row) {
  if (row._new) state.news = state.news.filter((x) => x._tempId !== row._id);
  else if (state.dels.has(row._id)) state.dels.delete(row._id);
  else { state.dels.add(row._id); state.edits.delete(row._id); }
  render();
}

// Add row defaults to the window's payday (a date inside the window).
const freshDraft = () => ({ txn_date: state.window ? state.window.start : TODAY, description: "", source: "", deposit: "", withdrawal: "" });
let addDraft = freshDraft();
function renderAddRow() {
  const foot = $("#addFoot"); foot.innerHTML = "";
  const tr = document.createElement("tr"); tr.className = "add";
  const mk = (type, key, cls, list, ph) => {
    const td = document.createElement("td"); if (cls) td.className = cls;
    const inp = document.createElement("input"); inp.type = type; inp.value = addDraft[key]; if (ph) inp.placeholder = ph; if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (addDraft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addRow(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("date", "txn_date", "col-date"));
  tr.appendChild(mk("text", "description", "", "categories", "Category"));
  tr.appendChild(mk("text", "source", "", null, "Source / Recipient"));
  tr.appendChild(mk("number", "deposit", "num col-dep", null, "0.00"));
  tr.appendChild(mk("number", "withdrawal", "num col-wd", null, "0.00"));
  tr.appendChild(document.createElement("td"));
  const act = document.createElement("td"); act.className = "row-actions";
  const add = document.createElement("button"); add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = addRow; act.appendChild(add); tr.appendChild(act);
  foot.appendChild(tr);
}
const pushNew = (t) => state.news.push({ _tempId: "new-" + (++tempId), created_at: new Date().toISOString(), txn_date: t.txn_date, description: t.description, source: t.source, deposit: t.deposit, withdrawal: t.withdrawal });

function addRow() {
  if (!addDraft.txn_date) return toast("Date is required");
  if (!addDraft.deposit && !addDraft.withdrawal) return toast("Enter a deposit or withdrawal");
  if (!inWin(addDraft.txn_date) && !confirm("That date is outside this pay window — add it anyway?")) return;
  const base = { ...addDraft };
  pushNew(base);           // the entry itself is always added to this period
  addDraft = freshDraft();
  render();
  openRecurModal(base);    // then offer to repeat it going forward
}

// --- recurring entries -----------------------------------------------------

const daysBetween = (a, b) => { const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 86400000); };

// Default stop date: the ledger's furthest date, or a year out — whichever later.
function defaultUntil(D) {
  const latest = state.txns.reduce((mx, t) => (t.txn_date > mx ? t.txn_date : mx), D);
  const [y, m, d] = D.split("-").map(Number);
  const yearOut = `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
  return latest > yearOut ? latest : yearOut;
}

let recurBase = null;
function openRecurModal(base) {
  recurBase = base;
  const amt = Number(base.deposit) || Number(base.withdrawal) || 0;
  $("#recurSummary").textContent = `${base.description || "Entry"} · ${base.source || "—"} · ${fmt(amt)} — starting ${base.txn_date}`;
  $("#recurFreq").value = "monthly";
  $("#recurUntil").value = defaultUntil(base.txn_date);
  $("#recurModal").hidden = false;
}
const closeRecurModal = () => { $("#recurModal").hidden = true; recurBase = null; };

// Generate the future occurrences of `base` at the chosen frequency, up to `until`.
function generateRecurring(base, freq, until) {
  const D = base.txn_date;
  let count = 0;
  const CAP = 300;
  if (freq === "weekly" || freq === "biweekly") {
    const step = freq === "weekly" ? 7 : 14;
    for (let n = 1; n <= CAP; n++) { const date = shiftDay(D, n * step); if (date > until) break; pushNew({ ...base, txn_date: date }); count++; }
  } else if (freq === "monthly") {
    const [y, m, d] = D.split("-").map(Number);
    for (let n = 1; n <= CAP; n++) {
      const t = y * 12 + (m - 1) + n, yy = Math.floor(t / 12), mm = (t % 12) + 1;
      if (`${yy}-${String(mm).padStart(2, "0")}-01` > until) break;
      const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      if (d > dim) continue; // day doesn't exist this month — skip
      const date = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date > until) break;
      pushNew({ ...base, txn_date: date }); count++;
    }
  } else if (freq === "period") {
    const cur = windowFor(state.cadence, state.anchor, D);
    const offset = daysBetween(cur.start, D); // same relative position each period
    let win = windowFor(state.cadence, state.anchor, cur.nextStart);
    for (let n = 0; n < CAP; n++) {
      const date = shiftDay(win.start, offset);
      if (date > until) break;
      if (date <= win.end) { pushNew({ ...base, txn_date: date }); count++; }
      win = windowFor(state.cadence, state.anchor, win.nextStart);
    }
  }
  return count;
}

$("#recurAdd").addEventListener("click", () => {
  if (!recurBase) return closeRecurModal();
  const freq = $("#recurFreq").value;
  const until = $("#recurUntil").value || defaultUntil(recurBase.txn_date);
  const n = generateRecurring(recurBase, freq, until);
  closeRecurModal();
  render();
  toast(n ? `Added ${n} future occurrence${n === 1 ? "" : "s"} — review and Save` : "No occurrences in that range");
});
$("#recurOnce").addEventListener("click", closeRecurModal);
$("#recurModal").addEventListener("click", (e) => { if (e.target.id === "recurModal") closeRecurModal(); });

// --- save / discard --------------------------------------------------------

const pendingCount = () => state.edits.size + state.dels.size + state.news.length;
const hasPending = () => pendingCount() > 0;
function renderControls() {
  const n = pendingCount();
  const save = $("#saveBtn"); save.disabled = n === 0; save.textContent = n ? `Save to ledger (${n})` : "Save to ledger";
  $("#discardBtn").hidden = n === 0;
  $("#dirtyNote").hidden = n === 0;
}

$("#saveBtn").addEventListener("click", async () => {
  if (!hasPending()) return;
  const v = computeView();
  if (v.min < 0 && !confirm(`This pay period dips to ${fmt(v.min)}. Save to the ledger anyway?`)) return;
  const n = pendingCount();
  $("#saveBtn").disabled = true;
  try {
    for (const nr of state.news) {
      await api("/api/transactions", { method: "POST", body: { account_id: state.account.id, owner: state.currentUser, txn_date: nr.txn_date, description: nr.description, source: nr.source, deposit: Number(nr.deposit) || 0, withdrawal: Number(nr.withdrawal) || 0 } });
    }
    for (const [id, fields] of state.edits) await api(`/api/transactions/${id}`, { method: "PATCH", body: fields });
    for (const id of state.dels) await api(`/api/transactions/${id}`, { method: "DELETE" });
    await loadWindow();
    toast(`Saved ${n} change${n === 1 ? "" : "s"} to the ledger`);
  } catch (e) { toast("Error: " + e.message); renderControls(); }
});

$("#discardBtn").addEventListener("click", () => { if (!hasPending()) return; clearPending(); render(); toast("Changes discarded"); });
window.addEventListener("beforeunload", (e) => { if (hasPending()) { e.preventDefault(); e.returnValue = ""; } });

init();
