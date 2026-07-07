// Ledger grid: a spreadsheet-style editor over the local CRUD API.
// Each cell edit PATCHes its field; adding/deleting rows POST/DELETE. After any
// write we reload so the per-account running balance and totals stay correct.

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// Optional ?account=<id> deep-links to a specific account (else the busiest).
const state = { accountId: new URLSearchParams(location.search).get("account"), accounts: [] };

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
  toastTimer = setTimeout(() => el.classList.remove("show"), 1400);
}

// --- load & render ---------------------------------------------------------

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  state.accounts = accounts;
  const sel = $("#account");
  sel.innerHTML = "";
  for (const a of accounts) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.name} — ${fmt(a.balance)}`;
    sel.appendChild(opt);
  }
  if (!state.accountId || !accounts.some((a) => a.id === state.accountId)) {
    // Default to the account with the most activity (Phase 2 replaces this with
    // the current-user selection). Falls back to the first account.
    const busiest = [...accounts].sort((a, b) => (b.txn_count || 0) - (a.txn_count || 0))[0];
    state.accountId = busiest?.id ?? null;
  }
  sel.value = state.accountId ?? "";
}

async function loadLedger() {
  if (!state.accountId) return;
  const { transactions, totals } = await api(`/api/transactions?account_id=${encodeURIComponent(state.accountId)}`);
  renderRows(transactions);
  $("#totIn").textContent = fmt(totals.deposits);
  $("#totOut").textContent = fmt(totals.withdrawals);
  const bal = transactions.length ? transactions[transactions.length - 1].running_balance
                                  : (state.accounts.find((a) => a.id === state.accountId)?.opening_balance ?? 0);
  const balEl = $("#balance");
  balEl.textContent = fmt(bal);
  balEl.classList.toggle("neg", bal < 0);
}

function renderRows(txns) {
  const tbody = $("#rows");
  tbody.innerHTML = "";
  $("#empty").hidden = txns.length > 0;
  // Newest first for scanning; running_balance was computed oldest→newest.
  for (const t of [...txns].reverse()) tbody.appendChild(rowEl(t));
  renderAddRow();
}

function rowEl(t) {
  const tr = document.createElement("tr");
  tr.dataset.id = t.id;
  tr.appendChild(cell("date", t.txn_date, "col-date"));
  tr.appendChild(cell("text", t.description, "", "categories", "Category"));
  tr.appendChild(cell("text", t.source, "", null, "Source / Recipient"));
  tr.appendChild(cell("number", t.deposit || "", "num col-dep"));
  tr.appendChild(cell("number", t.withdrawal || "", "num col-wd"));

  const bal = document.createElement("td");
  bal.className = "bal" + (t.running_balance < 0 ? " neg" : "");
  bal.textContent = fmt(t.running_balance);
  if (t.running_balance < 0) bal.title = "Balance went negative here";
  tr.appendChild(bal);

  const act = document.createElement("td");
  act.className = "row-actions";
  const del = document.createElement("button");
  del.className = "del"; del.title = "Delete"; del.textContent = "×";
  del.onclick = () => deleteTxn(t.id);
  act.appendChild(del);
  tr.appendChild(act);

  // Wire each editable field to a PATCH on change.
  tr.querySelectorAll("input[data-field]").forEach((inp) => {
    inp.addEventListener("change", () => saveField(t.id, inp.dataset.field, inp));
  });
  return tr;
}

function cell(type, value, cls = "", list = null, placeholder = "") {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value ?? "";
  if (placeholder) inp.placeholder = placeholder;
  if (list) inp.setAttribute("list", list);
  if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
  inp.dataset.field = FIELD_BY_TYPE(type, cls, placeholder);
  td.appendChild(inp);
  return td;
}

// Map a cell to its transaction field (kept explicit so markup order can change).
function FIELD_BY_TYPE(type, cls, placeholder) {
  if (type === "date") return "txn_date";
  if (cls.includes("col-dep")) return "deposit";
  if (cls.includes("col-wd")) return "withdrawal";
  if (placeholder.startsWith("Category")) return "description";
  return "source";
}

// --- writes ----------------------------------------------------------------

async function saveField(id, field, inp) {
  try {
    await api(`/api/transactions/${id}`, { method: "PATCH", body: { [field]: inp.value } });
    toast("Saved");
    await loadAccounts(); // balances in the dropdown may shift
    await loadLedger();
  } catch (e) { toast("Error: " + e.message); }
}

async function deleteTxn(id) {
  try {
    await api(`/api/transactions/${id}`, { method: "DELETE" });
    toast("Deleted");
    await loadAccounts();
    await loadLedger();
  } catch (e) { toast("Error: " + e.message); }
}

function renderAddRow() {
  const foot = $("#addFoot");
  foot.innerHTML = "";
  const tr = document.createElement("tr");
  tr.className = "add";
  const today = new Date().toISOString().slice(0, 10);
  const draft = { txn_date: today, description: "", source: "", deposit: "", withdrawal: "" };

  const mk = (type, key, cls = "", list = null, placeholder = "") => {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    const inp = document.createElement("input");
    inp.type = type; inp.value = draft[key]; inp.placeholder = placeholder;
    if (list) inp.setAttribute("list", list);
    if (type === "number") { inp.step = "0.01"; inp.min = "0"; }
    inp.addEventListener("input", () => (draft[key] = inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") addTxn(draft); });
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
  add.onclick = () => addTxn(draft);
  act.appendChild(add);
  tr.appendChild(act);
  foot.appendChild(tr);
}

async function addTxn(draft) {
  if (!draft.txn_date) return toast("Date is required");
  if (!draft.deposit && !draft.withdrawal) return toast("Enter a deposit or withdrawal");
  try {
    await api("/api/transactions", {
      method: "POST",
      body: { account_id: state.accountId, ...draft, deposit: draft.deposit || 0, withdrawal: draft.withdrawal || 0 },
    });
    toast("Added");
    await loadAccounts();
    await loadLedger();
  } catch (e) { toast("Error: " + e.message); }
}

// --- init ------------------------------------------------------------------

$("#account").addEventListener("change", (e) => {
  state.accountId = e.target.value;
  loadLedger();
});

(async function init() {
  try {
    await loadAccounts();
    await loadLedger();
  } catch (e) {
    document.querySelector("main").innerHTML = `<div class="empty">Failed to load: ${e.message}</div>`;
  }
})();
