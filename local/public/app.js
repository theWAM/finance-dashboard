import { windowFor, previousWindowFor } from "/shared/paycycle.js";

// Ledger grid: a spreadsheet-style editor over the local CRUD API.
//
// Edits are STAGED in memory, never written on keystroke. Cell edits, added
// rows, and deletes accumulate as pending changes; the running balance and
// totals are recomputed live from that staged state so you preview the result.
// Nothing hits the database until you click Save (Discard drops the changes).

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Ledger ordering: by date, then same-day priority — paycheck > investments >
// savings > bills > everything else — then created_at.
const isPaycheck = (t) => /paycheck/i.test(t.description || "") && (Number(t.deposit) || 0) > 0;
const DAY_RANK = { Investments: 1, Savings: 2, Bill: 3 };
const dayRank = (t) => (isPaycheck(t) ? 0 : (DAY_RANK[t.description] ?? 4));
const byDate = (a, b) =>
  cmp(a.txn_date, b.txn_date) ||
  (dayRank(a) - dayRank(b)) ||
  cmp(a.created_at || "", b.created_at || "");

const TODAY = new Date().toISOString().slice(0, 10);
const params = new URLSearchParams(location.search);
const state = {
  accountId: params.get("account"),
  accounts: [],
  people: [],
  // ?user=<id> deep-links as a person; otherwise the last stored choice.
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,          // the selected account's row (has opening_balance)
  rows: [],               // transactions as last loaded from the server
  edits: new Map(),       // id -> { field: value } staged edits to existing rows
  dels: new Set(),        // ids staged for deletion
  news: [],               // staged new rows ({ _tempId, created_at, ...fields })
  filter: { from: "", to: "", categories: new Set(), sources: new Set() }, // date window → category set → source set
  selected: new Set(),    // _ids selected for bulk edit/delete
  _shown: [],             // rows currently displayed (for select-all)
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

// --- current user (no auth; personalizes the view) -------------------------

async function loadPeople() {
  const { people } = await api("/api/people");
  state.people = people;
}

const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();
const currentPerson = () => state.people.find((p) => p.id === state.currentUser) || null;

// A person's profile image, falling back to their initials on a colored circle.
function avatarMarkup(person, photoClass) {
  return person.avatar
    ? `<img class="${photoClass}" src="${person.avatar}" alt="${person.name}">`
    : `<span class="${photoClass} initials">${initials(person.name)}</span>`;
}

function renderUserChip() {
  const chip = $("#userChip");
  const person = currentPerson();
  // A single-person household needs no chip (nobody to switch to).
  if (!person || state.people.length <= 1) { chip.hidden = true; return; }
  const av = $("#userAvatar");
  if (person.avatar) av.innerHTML = `<img src="${person.avatar}" alt="">`;
  else av.textContent = initials(person.name);
  $("#userName").textContent = person.name;
  chip.hidden = false;
}

function showWho() {
  const box = $("#whoOptions");
  box.innerHTML = "";
  for (const p of state.people) {
    const btn = document.createElement("button");
    btn.className = "who-card";
    btn.innerHTML = `${avatarMarkup(p, "who-photo")}<span class="name">${p.name}</span>`;
    btn.onclick = () => selectUser(p.id);
    box.appendChild(btn);
  }
  $("#who").hidden = false;
}

async function selectUser(id) {
  if (hasPending() && !confirm("Discard unsaved changes?")) return;
  state.currentUser = id;
  localStorage.setItem("currentUser", id);
  $("#who").hidden = true;
  renderUserChip();
  state.accountId = null; // re-default to the newly selected person's account
  await loadAccounts();
  await loadLedger();
}

// --- accounts --------------------------------------------------------------

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  // Personal scope: show the current person's accounts plus shared ones.
  const visible = state.currentUser
    ? accounts.filter((a) => a.owner === state.currentUser || a.owner === "shared")
    : accounts;
  state.accounts = visible;

  const sel = $("#account");
  sel.innerHTML = "";
  for (const a of visible) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.name} — ${fmt(a.balance)}`;
    sel.appendChild(opt);
  }
  if (!state.accountId || !visible.some((a) => a.id === state.accountId)) {
    // Prefer the current person's checking account, then their busiest account,
    // then the busiest visible account overall.
    const mine = visible.filter((a) => a.owner === state.currentUser);
    const pref =
      mine.find((a) => a.type === "checking") ||
      [...mine].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))[0] ||
      [...visible].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))[0];
    state.accountId = pref?.id ?? null;
  }
  sel.value = state.accountId ?? "";
}

// --- ledger data + staging -------------------------------------------------

function clearPending() {
  state.edits.clear();
  state.dels.clear();
  state.news = [];
  state.selected.clear();
  addDraft = freshDraft();
}

async function loadLedger() {
  if (!state.accountId) { state.rows = []; state.account = null; clearPending(); resetFilter(); buildFilters(); render(); $("#dailyCheck").hidden = true; return; }
  const { account, transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.accountId)}`);
  state.account = account;
  state.rows = transactions;
  clearPending();
  resetFilter();          // a fresh account starts unfiltered
  buildFilters();         // rebuild category/source checkboxes for this account
  render();
  showDailyCheck();       // "you should have $X in the bank today" prompt
}

// --- filtering (date window → category → source) ---------------------------

const filterActive = () => {
  const f = state.filter;
  return !!(f.from || f.to || f.categories.size || f.sources.size);
};

function matchesFilter(r) {
  const f = state.filter;
  if (f.from && r.txn_date < f.from) return false;
  if (f.to && r.txn_date > f.to) return false;
  // Within a facet, any checked value matches (OR); facets combine (AND).
  if (f.categories.size && !f.categories.has(r.description || "")) return false;
  if (f.sources.size && !f.sources.has(r.source || "")) return false;
  return true;
}

// The current person's cadence + the paycheck to anchor pay-window math to.
function payAnchor() {
  const today = new Date().toISOString().slice(0, 10);
  const person = state.people.find((p) => p.id === state.currentUser);
  const cadence = person?.pay_cadence || "biweekly";
  const pays = state.rows
    .filter((t) => /paycheck/i.test(t.description || "") && Number(t.deposit) > 0)
    .map((t) => t.txn_date).sort();
  let anchor = today;
  if (pays.length) { const past = pays.filter((d) => d <= today); anchor = past.length ? past[past.length - 1] : pays[pays.length - 1]; }
  return { cadence, anchor, today };
}

// Map a timeframe preset key to a { from, to } date window ("" = open-ended).
function presetWindow(key) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const t = iso(now);
  const addDays = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };
  const addMonths = (n) => { const d = new Date(now); d.setMonth(d.getMonth() + n); return iso(d); };
  const y = now.getFullYear();
  switch (key) {
    case "3paychecks": {
      const { cadence, anchor } = payAnchor();
      const prev = previousWindowFor(cadence, anchor, t);      // one paycheck ago
      const cur = windowFor(cadence, anchor, t);               // current period
      const next = windowFor(cadence, anchor, cur.nextStart);  // next period
      return { from: prev.start, to: next.nextStart };         // prev · current · next
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

function applyPreset(key) {
  const { from, to } = presetWindow(key);
  state.filter.from = from;
  state.filter.to = to;
  $("#fFrom").value = from;
  $("#fTo").value = to;
  $("#fPreset").value = key;
  render();
}

function resetFilter() {
  const { from, to } = presetWindow("3paychecks"); // default timeframe
  state.filter = { from, to, categories: new Set(), sources: new Set() };
  if ($("#fFrom")) $("#fFrom").value = from;
  if ($("#fTo")) $("#fTo").value = to;
  if ($("#fPreset")) $("#fPreset").value = "3paychecks";
}

// Distinct values of a field across the loaded ledger, sorted case-insensitively.
function distinctValues(key) {
  const set = new Set();
  for (const r of state.rows) set.add(r[key] ?? "");
  return [...set].sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase()));
}

function buildFilters() {
  buildMultiselect("msCategory", "Category", distinctValues("description"), state.filter.categories);
  buildMultiselect("msSource", "Source", distinctValues("source"), state.filter.sources);
}

// A checkbox dropdown over `values`; checking several matches ANY of them.
function buildMultiselect(elId, label, values, selected) {
  const el = $("#" + elId);
  el.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ms-btn";
  const relabel = () => {
    btn.textContent = (selected.size ? `${label} (${selected.size})` : label) + " ▾";
    btn.classList.toggle("active", selected.size > 0);
  };
  relabel();

  const panel = document.createElement("div");
  panel.className = "ms-panel";
  panel.hidden = true;
  for (const v of values) {
    const opt = document.createElement("label");
    opt.className = "ms-opt";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(v);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(v); else selected.delete(v);
      relabel();
      render();
    });
    const span = document.createElement("span");
    span.textContent = v === "" ? "(blank)" : v;
    opt.append(cb, span);
    panel.appendChild(opt);
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeAllPanels();
    panel.hidden = !willOpen;
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  el.append(btn, panel);
}

function closeAllPanels() {
  document.querySelectorAll(".ms-panel").forEach((p) => (p.hidden = true));
}

// --- Daily check popup (projected-vs-actual balance for today) --------------

let dcProjected = 0;
function showDailyCheck() {
  dcProjected = computeView().todayBal;
  $("#dcAmount").textContent = fmt(dcProjected);
  $("#dcAsk").hidden = false;
  $("#dcCorrect").hidden = true;
  $("#dcActual").value = "";
  $("#dcDiff").textContent = "";
  $("#dcApply").disabled = true;
  $("#dailyCheck").hidden = false;
}
$("#dcClose").addEventListener("click", () => { $("#dailyCheck").hidden = true; });
$("#dcYes").addEventListener("click", () => { $("#dailyCheck").hidden = true; });
$("#dcNo").addEventListener("click", () => { $("#dcAsk").hidden = true; $("#dcCorrect").hidden = false; $("#dcActual").focus(); });
$("#dcActual").addEventListener("input", (e) => {
  const has = e.target.value !== "" && !Number.isNaN(Number(e.target.value));
  const diff = has ? round2(Number(e.target.value) - dcProjected) : 0;
  $("#dcApply").disabled = !has || Math.abs(diff) < 0.01;
  $("#dcDiff").textContent = !has ? ""
    : Math.abs(diff) < 0.01 ? "Matches — nothing to correct."
    : `Bank is ${diff > 0 ? "over" : "short"} by ${fmt(Math.abs(diff))} — Correct adds an adjustment dated ${TODAY}.`;
});
$("#dcApply").addEventListener("click", () => {
  const diff = round2(Number($("#dcActual").value) - dcProjected);
  if (Math.abs(diff) < 0.01) return;
  state.news.push({
    _tempId: "new-" + (++tempCounter), created_at: new Date().toISOString(), txn_date: TODAY,
    description: "Adjustment", source: "Daily check correction",
    deposit: diff > 0 ? diff : 0, withdrawal: diff < 0 ? -diff : 0,
  });
  $("#dailyCheck").hidden = true;
  render();
  toast("Adjustment added — review and Save");
});

// --- bulk selection / edit / delete ----------------------------------------

function updateSelectionUI() {
  // Drop any selections that are no longer visible (e.g. after filtering).
  const shownIds = new Set(state._shown.map((r) => r._id));
  for (const id of [...state.selected]) if (!shownIds.has(id)) state.selected.delete(id);

  const n = state.selected.size;
  $("#bulkBar").hidden = n === 0;
  $("#bulkCount").textContent = `${n} selected`;
  const sa = $("#selectAll");
  sa.checked = n > 0 && n === state._shown.length;
  sa.indeterminate = n > 0 && n < state._shown.length;
  document.querySelectorAll('#rows tr[data-id]').forEach((tr) => {
    const sel = state.selected.has(tr.dataset.id);
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = sel;
    tr.classList.toggle("row-selected", sel);
  });
}

// Stage the same field=value across every selected row (edits, or new-row fields).
function bulkSetField(field, value) {
  for (const id of state.selected) {
    const nw = state.news.find((x) => x._tempId === id);
    if (nw) nw[field] = value;
    else { const e = state.edits.get(id) || {}; e[field] = value; state.edits.set(id, e); }
  }
  render();
}

function bulkDelete() {
  for (const id of state.selected) {
    if (String(id).startsWith("new-")) state.news = state.news.filter((x) => x._tempId !== id);
    else { state.dels.add(id); state.edits.delete(id); }
  }
  state.selected.clear();
  render();
}

// Show the value input appropriate to the chosen bulk field.
function renderBulkValue() {
  const field = $("#bulkField").value;
  const wrap = $("#bulkValueWrap");
  wrap.innerHTML = "";
  $("#bulkApply").disabled = !field;
  if (!field) return;
  const inp = document.createElement("input");
  inp.id = "bulkValue";
  if (field === "txn_date") inp.type = "date";
  else if (field === "deposit" || field === "withdrawal") { inp.type = "number"; inp.step = "0.01"; inp.min = "0"; inp.placeholder = "0.00"; }
  else { inp.type = "text"; if (field === "description") inp.setAttribute("list", "categories"); inp.placeholder = field === "description" ? "Category" : "Source / Recipient"; }
  wrap.appendChild(inp);
}

// Merge staged changes over the loaded rows, then recompute the running balance
// (oldest → newest) so the preview reflects unsaved edits. Deleted rows are kept
// for display (struck-through) but excluded from the balance.
function computeView() {
  const rows = [];
  for (const r of state.rows) {
    if (state.dels.has(r.id)) { rows.push({ ...r, _id: r.id, _deleted: true }); continue; }
    const e = state.edits.get(r.id);
    rows.push({ ...r, ...(e || {}), _id: r.id, _edited: !!e });
  }
  for (const n of state.news) rows.push({ ...n, _id: n._tempId, _new: true });

  const live = rows
    .filter((r) => !r._deleted)
    .sort(byDate);
  let bal = Number(state.account?.opening_balance) || 0;
  let deposits = 0, withdrawals = 0, todayBal = bal;
  const balById = new Map();
  for (const t of live) {
    const d = Number(t.deposit) || 0, w = Number(t.withdrawal) || 0;
    deposits += d; withdrawals += w; bal = round2(bal + d - w);
    balById.set(t._id, bal);
    if (t.txn_date <= TODAY) todayBal = bal; // running balance as of today
  }
  return { rows, balById, totals: { deposits: round2(deposits), withdrawals: round2(withdrawals) }, endBal: round2(bal), todayBal };
}

function render() {
  const { rows, balById, totals, endBal } = computeView();
  const active = filterActive();
  const shown = active ? rows.filter(matchesFilter) : rows;

  const tbody = $("#rows");
  tbody.innerHTML = "";
  $("#empty").hidden = rows.length > 0;
  // Oldest → newest (top to bottom). Each row keeps its TRUE running balance
  // (computed over the whole ledger in computeView), so filtering never distorts it.
  const display = [...shown].sort(byDate);
  for (const r of display) tbody.appendChild(rowEl(r, balById.get(r._id)));
  renderAddRow();

  // Deposits/Withdrawals reflect the filtered view (e.g. total for a category);
  // Balance stays the account's true end balance regardless of filter.
  const shownTotals = active
    ? shown.filter((r) => !r._deleted).reduce((t, r) => ({
        deposits: round2(t.deposits + (Number(r.deposit) || 0)),
        withdrawals: round2(t.withdrawals + (Number(r.withdrawal) || 0)),
      }), { deposits: 0, withdrawals: 0 })
    : totals;
  $("#totIn").textContent = fmt(shownTotals.deposits);
  $("#totOut").textContent = fmt(shownTotals.withdrawals);
  const balEl = $("#balance");
  balEl.textContent = fmt(endBal);
  balEl.classList.toggle("neg", endBal < 0);

  $("#fClear").hidden = !active;
  $("#fCount").textContent = active ? `showing ${shown.length} of ${rows.length}` : "";
  state._shown = shown;
  updateSelectionUI();
  renderControls();
}

function rowEl(row, bal) {
  const tr = document.createElement("tr");
  tr.dataset.id = row._id;
  if (row._deleted) tr.className = "to-delete";
  else if (row._new) tr.className = "new-row";
  else if (row._edited) tr.className = "edited";
  if (state.selected.has(row._id)) tr.classList.add("row-selected");

  const checkTd = document.createElement("td");
  checkTd.className = "col-check";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = state.selected.has(row._id);
  chk.addEventListener("change", () => {
    if (chk.checked) state.selected.add(row._id); else state.selected.delete(row._id);
    updateSelectionUI();
  });
  checkTd.appendChild(chk);
  tr.appendChild(checkTd);

  const dis = !!row._deleted;
  tr.appendChild(cell("date", row.txn_date, "txn_date", "col-date", null, "", dis));
  tr.appendChild(cell("text", row.description, "description", "", "categories", "Category", dis));
  tr.appendChild(cell("text", row.source, "source", "", null, "Source / Recipient", dis));
  tr.appendChild(cell("number", row.deposit || "", "deposit", "num col-dep", null, "", dis));
  tr.appendChild(cell("number", row.withdrawal || "", "withdrawal", "num col-wd", null, "", dis));

  const balTd = document.createElement("td");
  balTd.className = "bal" + (bal < 0 ? " neg" : "");
  balTd.textContent = row._deleted ? "—" : fmt(bal);
  if (!row._deleted && bal < 0) balTd.title = "Balance goes negative here";
  tr.appendChild(balTd);

  const act = document.createElement("td");
  act.className = "row-actions";
  const btn = document.createElement("button");
  btn.className = "del" + (row._deleted ? " restore" : "");
  btn.title = row._deleted ? "Restore" : "Delete";
  btn.textContent = row._deleted ? "↺" : "×";
  btn.onclick = () => toggleDelete(row);
  act.appendChild(btn);
  tr.appendChild(act);

  // Stage each edit on change (blur/enter) — not on every keystroke.
  tr.querySelectorAll("input[data-field]").forEach((inp) => {
    inp.addEventListener("change", () => stageEdit(row, inp.dataset.field, inp.value));
  });
  return tr;
}

function cell(type, value, field, cls = "", list = null, placeholder = "", disabled = false) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value ?? "";
  if (placeholder) inp.placeholder = placeholder;
  if (list) inp.setAttribute("list", list);
  if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
  if (disabled) inp.disabled = true;
  inp.dataset.field = field;
  td.appendChild(inp);
  return td;
}

function stageEdit(row, field, value) {
  if (row._new) {
    const n = state.news.find((x) => x._tempId === row._id);
    if (n) n[field] = value;
  } else {
    const e = state.edits.get(row._id) || {};
    e[field] = value;
    state.edits.set(row._id, e);
  }
  render();
}

function toggleDelete(row) {
  if (row._new) {
    state.news = state.news.filter((x) => x._tempId !== row._id);
  } else if (state.dels.has(row._id)) {
    state.dels.delete(row._id);
  } else {
    state.dels.add(row._id);
    state.edits.delete(row._id); // pending edits on a to-be-deleted row are moot
  }
  render();
}

// --- add row ---------------------------------------------------------------

const freshDraft = () => ({ txn_date: new Date().toISOString().slice(0, 10), description: "", source: "", deposit: "", withdrawal: "" });
let addDraft = freshDraft();
let tempCounter = 0;

function renderAddRow() {
  const foot = $("#addFoot");
  foot.innerHTML = "";
  const tr = document.createElement("tr");
  tr.className = "add";
  tr.appendChild(document.createElement("td")); // checkbox column spacer
  const mk = (type, key, cls = "", list = null, placeholder = "") => {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    const inp = document.createElement("input");
    inp.type = type; inp.value = addDraft[key]; inp.placeholder = placeholder;
    if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (addDraft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") stageAdd(); });
    td.appendChild(inp); return td;
  };
  tr.appendChild(mk("date", "txn_date", "col-date"));
  tr.appendChild(mk("text", "description", "", "categories", "Category"));
  tr.appendChild(mk("text", "source", "", null, "Source / Recipient"));
  tr.appendChild(mk("number", "deposit", "num col-dep", null, "0.00"));
  tr.appendChild(mk("number", "withdrawal", "num col-wd", null, "0.00"));
  tr.appendChild(document.createElement("td"));

  const act = document.createElement("td");
  act.className = "row-actions";
  const add = document.createElement("button");
  add.className = "btn"; add.textContent = "Add"; add.style.padding = "5px 10px";
  add.onclick = stageAdd;
  act.appendChild(add);
  tr.appendChild(act);
  foot.appendChild(tr);
}

function stageAdd() {
  if (!addDraft.txn_date) return toast("Date is required");
  if (!addDraft.deposit && !addDraft.withdrawal) return toast("Enter a deposit or withdrawal");
  state.news.push({ _tempId: "new-" + (++tempCounter), created_at: new Date().toISOString(), ...addDraft });
  addDraft = freshDraft();
  render();
  toast("Row added (unsaved)");
}

// --- save / discard --------------------------------------------------------

const pendingCount = () => state.edits.size + state.dels.size + state.news.length;
const hasPending = () => pendingCount() > 0;

function renderControls() {
  const n = pendingCount();
  const save = $("#saveBtn");
  save.disabled = n === 0;
  save.textContent = n ? `Save (${n})` : "Save";
  $("#discardBtn").hidden = n === 0;
  $("#dirtyNote").hidden = n === 0;
}

async function applyPending() {
  if (!hasPending()) return;
  const n = pendingCount();
  $("#saveBtn").disabled = true;
  try {
    for (const nr of state.news) {
      await api("/api/transactions", {
        method: "POST",
        body: {
          account_id: state.accountId, txn_date: nr.txn_date,
          description: nr.description, source: nr.source,
          deposit: Number(nr.deposit) || 0, withdrawal: Number(nr.withdrawal) || 0,
        },
      });
    }
    for (const [id, fields] of state.edits) {
      await api(`/api/transactions/${id}`, { method: "PATCH", body: fields });
    }
    for (const id of state.dels) {
      await api(`/api/transactions/${id}`, { method: "DELETE" });
    }
    await loadAccounts();
    await loadLedger(); // clears pending + re-renders from the server
    toast(`Saved ${n} change${n === 1 ? "" : "s"}`);
  } catch (err) {
    toast("Error saving: " + err.message);
    renderControls(); // re-enable Save so the user can retry
  }
}

function discardPending() {
  if (!hasPending()) return;
  clearPending();
  render();
  toast("Changes discarded");
}

// --- init ------------------------------------------------------------------

$("#account").addEventListener("change", (e) => {
  if (hasPending() && !confirm("Discard unsaved changes and switch account?")) {
    e.target.value = state.accountId;
    return;
  }
  state.accountId = e.target.value;
  loadLedger();
});

$("#userChip").addEventListener("click", showWho);
$("#saveBtn").addEventListener("click", applyPending);
$("#discardBtn").addEventListener("click", discardPending);

$("#fPreset").addEventListener("change", (e) => applyPreset(e.target.value));
$("#fFrom").addEventListener("change", (e) => { state.filter.from = e.target.value; $("#fPreset").value = "custom"; render(); });
$("#fTo").addEventListener("change", (e) => { state.filter.to = e.target.value; $("#fPreset").value = "custom"; render(); });
$("#fClear").addEventListener("click", () => {
  // Clear wipes to show-all (not the default window), so nothing is hidden.
  state.filter = { from: "", to: "", categories: new Set(), sources: new Set() };
  $("#fFrom").value = ""; $("#fTo").value = ""; $("#fPreset").value = "all";
  buildFilters(); render();
});
document.addEventListener("click", () => closeAllPanels()); // click-away closes dropdowns

$("#selectAll").addEventListener("change", (e) => {
  if (e.target.checked) for (const r of state._shown) state.selected.add(r._id);
  else state.selected.clear();
  updateSelectionUI();
});
$("#bulkField").addEventListener("change", renderBulkValue);
$("#bulkApply").addEventListener("click", () => {
  const field = $("#bulkField").value;
  const valEl = $("#bulkValue");
  if (!field || !valEl) return;
  const n = state.selected.size;
  bulkSetField(field, valEl.value);
  toast(`Updated ${n} row${n === 1 ? "" : "s"} — review and Save`);
});
$("#bulkDelete").addEventListener("click", () => {
  const n = state.selected.size;
  if (!n) return;
  bulkDelete();
  toast(`Marked ${n} row${n === 1 ? "" : "s"} for deletion — Save to apply`);
});
$("#bulkClearSel").addEventListener("click", () => { state.selected.clear(); updateSelectionUI(); });
window.addEventListener("beforeunload", (e) => { if (hasPending()) { e.preventDefault(); e.returnValue = ""; } });

(async function init() {
  try {
    await loadPeople();
    if (state.people.length <= 1) {
      // Single-person (or empty) household: auto-select and skip the popup.
      state.currentUser = state.people[0]?.id ?? null;
      if (state.currentUser) localStorage.setItem("currentUser", state.currentUser);
    } else if (!state.people.some((p) => p.id === state.currentUser)) {
      showWho(); // multi-person with no valid stored choice → ask who they are
    } else {
      localStorage.setItem("currentUser", state.currentUser); // persist a valid choice
    }
    renderUserChip();
    await loadAccounts();
    await loadLedger();
  } catch (e) {
    document.querySelector("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
  }
})();
