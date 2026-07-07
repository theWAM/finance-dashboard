// Plan editor — the migrated fin_plan.html strategy as editable plan_targets.
// Three sections (debts, savings goals, investments); each target is a row with
// its kind-specific fields. Edits stage locally and persist on "Save plan"
// (POST new / PATCH changed / DELETE removed).

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// kind → section config. Each field: [dataKey, label, type]. `pct` = stored as a
// fraction but shown/edited as a percentage.
const SECTIONS = [
  { kind: "debt_payoff", title: "Debts", fields: [["balance", "Balance", "money"], ["apr", "APR", "pct"], ["monthly_payment", "Monthly payment", "money"], ["target_date", "Target payoff", "date"], ["sources", "Ledger source(s)", "sources"]] },
  { kind: "savings_goal", title: "Savings goals", fields: [["target_amount", "Target", "money"], ["start_date", "Start", "date"], ["end_date", "Deadline", "date"], ["sources", "Ledger source(s)", "sources"]] },
  { kind: "investment_cadence", title: "Investments", fields: [["monthly_target", "Monthly target", "money"], ["sources", "Ledger source(s)", "sources"]] },
];

const state = { people: [], currentUser: localStorage.getItem("currentUser") || null, targets: [], removed: new Set(), dirty: false, sources: [] };
let tempId = 0;
let dragTarget = null; // savings goal being dragged to reorder

const savingsSorted = () =>
  state.targets.filter((t) => t.kind === "savings_goal").sort((a, b) => (a.data.sort_order ?? 1e9) - (b.data.sort_order ?? 1e9));

// Drop `fromT` immediately before `toT` in the savings order, then renumber.
function reorderSavings(fromT, toT) {
  if (fromT === toT) return;
  const list = savingsSorted();
  list.splice(list.indexOf(fromT), 1);
  list.splice(list.indexOf(toT), 0, fromT);
  list.forEach((t, i) => { if (t.data.sort_order !== i) { t.data.sort_order = i; t._dirty = true; } });
  state.dirty = true;
  render();
}

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) { const m = await res.json().catch(() => ({})); throw new Error(m.error || `${res.status} ${res.statusText}`); }
  return res.status === 204 ? null : res.json();
}
let toastTimer;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1600); }

const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
function renderUserChip() {
  const chip = $("#userChip"); const p = state.people.find((x) => x.id === state.currentUser);
  if (!p || state.people.length <= 1) { chip.hidden = true; return; }
  $("#userAvatar").innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  $("#userName").textContent = p.name; chip.hidden = false;
}

async function load() {
  state.people = (await api("/api/people")).people;
  renderUserChip();
  // Every distinct ledger source, to power the source autocomplete/dropdown.
  const { transactions } = await api("/api/transactions");
  state.sources = [...new Set(transactions.map((t) => t.source).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const { plan_targets } = await api("/api/plan-targets");
  state.targets = plan_targets.map((t) => ({ id: t.id, owner: t.owner, kind: t.kind, name: t.name, data: { ...t.data }, _new: false, _dirty: false }));
  state.removed = new Set();
  state.dirty = false;
  render();
}

function markDirty(t) { if (t) t._dirty = true; state.dirty = true; renderControls(); }

function render() {
  const root = $("#planRoot");
  root.innerHTML = "";
  // Shared autocomplete list of every ledger source (for the source pickers).
  let dl = document.getElementById("allSources");
  if (!dl) { dl = document.createElement("datalist"); dl.id = "allSources"; document.body.appendChild(dl); }
  dl.innerHTML = state.sources.map((s) => `<option value="${String(s).replace(/"/g, "&quot;")}"></option>`).join("");
  for (const sec of SECTIONS) {
    const section = document.createElement("section");
    const rows = sec.kind === "savings_goal" ? savingsSorted() : state.targets.filter((t) => t.kind === sec.kind);
    section.innerHTML = `<h2>${sec.title}</h2>`;
    const table = document.createElement("table");
    const head = ["Name", "Owner", ...sec.fields.map((f) => f[1]), ""];
    table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const t of rows) {
      tbody.appendChild(rowEl(t, sec));
      // Debts get a second row holding a running list of one-time (bonus) payments.
      if (sec.kind === "debt_payoff") tbody.appendChild(oneTimeRowEl(t, head.length));
    }
    table.appendChild(tbody);
    section.appendChild(table);
    const add = document.createElement("div");
    add.className = "add-row";
    add.innerHTML = `<button class="btn ghost">+ Add ${sec.title.replace(/s$/, "").toLowerCase()}</button>`;
    add.querySelector("button").onclick = () => addTarget(sec.kind);
    section.appendChild(add);
    root.appendChild(section);
  }
  renderControls();
}

function rowEl(t, sec) {
  const tr = document.createElement("tr");
  if (t._new) tr.className = "new-row"; else if (t._dirty) tr.className = "edited";

  const nameTd = document.createElement("td");
  // Savings goals can be dragged (by the grip) to reorder them; the order shows
  // on the dashboard too. The whole row is a drop target.
  if (sec.kind === "savings_goal") {
    nameTd.className = "name-cell";
    const grip = document.createElement("span");
    grip.className = "drag-grip"; grip.textContent = "⠿"; grip.title = "Drag to reorder"; grip.draggable = true;
    grip.addEventListener("dragstart", (e) => { dragTarget = t; e.dataTransfer.effectAllowed = "move"; tr.classList.add("dragging"); });
    grip.addEventListener("dragend", () => { tr.classList.remove("dragging"); document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over")); });
    tr.addEventListener("dragover", (e) => { if (dragTarget && dragTarget !== t) { e.preventDefault(); tr.classList.add("drag-over"); } });
    tr.addEventListener("dragleave", () => tr.classList.remove("drag-over"));
    tr.addEventListener("drop", (e) => { e.preventDefault(); tr.classList.remove("drag-over"); const from = dragTarget; dragTarget = null; if (from) reorderSavings(from, t); });
    nameTd.appendChild(grip);
  }
  nameTd.appendChild(textInput(t.name, (v) => { t.name = v; markDirty(t); }));
  tr.appendChild(nameTd);

  const ownerTd = document.createElement("td");
  ownerTd.appendChild(ownerPicker(t));
  tr.appendChild(ownerTd);

  for (const [key, , type] of sec.fields) {
    const td = document.createElement("td");
    if (type === "sources") { td.appendChild(sourcesField(t)); tr.appendChild(td); continue; }
    if (type === "money" || type === "pct") td.className = "num";
    const inp = document.createElement("input");
    if (type === "date") inp.type = "date";
    else if (type === "text") inp.type = "text";
    else { inp.type = "number"; inp.step = type === "pct" ? "0.01" : "0.01"; }
    inp.value = type === "pct" ? pctToInput(t.data[key]) : (t.data[key] ?? "");
    inp.addEventListener("change", () => {
      t.data[key] = type === "pct" ? inputToPct(inp.value) : (type === "text" || type === "date" ? inp.value : Number(inp.value) || 0);
      markDirty(t);
    });
    td.appendChild(inp);
    tr.appendChild(td);
  }

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button"); del.className = "del"; del.textContent = "×"; del.title = "Remove";
  del.onclick = () => { if (t.id) state.removed.add(t.id); state.targets = state.targets.filter((x) => x !== t); state.dirty = true; render(); };
  act.appendChild(del); tr.appendChild(act);
  return tr;
}

// A full-width row beneath a debt listing its one-time payments — bonuses or
// windfalls made outside the usual monthly cadence. Stored on
// data.one_time_payments = [{ date, amount, note }] and factored into the
// payoff projection (future ones shrink the remaining balance).
function oneTimeRowEl(t, colspan) {
  if (!Array.isArray(t.data.one_time_payments)) t.data.one_time_payments = [];
  const list = t.data.one_time_payments;
  const tr = document.createElement("tr");
  tr.className = "ot-row";
  const td = document.createElement("td");
  td.colSpan = colspan;

  const wrap = document.createElement("div");
  wrap.className = "ot-wrap";
  const total = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const head = document.createElement("div");
  head.className = "ot-head";
  head.innerHTML = `<span>One-time payments <span class="muted">(bonuses, windfalls — outside the monthly plan)</span></span>${list.length ? `<span class="muted">${list.length} · ${fmt(total)} total</span>` : ""}`;
  wrap.appendChild(head);

  list.forEach((p, i) => {
    const line = document.createElement("div");
    line.className = "ot-line";
    const date = document.createElement("input");
    date.type = "date"; date.value = p.date || "";
    date.onchange = () => { p.date = date.value; markDirty(t); };
    const amt = document.createElement("input");
    amt.type = "number"; amt.step = "0.01"; amt.placeholder = "amount"; amt.className = "num"; amt.value = p.amount ?? "";
    amt.onchange = () => { p.amount = Number(amt.value) || 0; markDirty(t); renderOtHead(head, list); };
    const note = document.createElement("input");
    note.type = "text"; note.placeholder = "note (e.g. work bonus)"; note.value = p.note || "";
    note.onchange = () => { p.note = note.value; markDirty(t); };
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×"; del.title = "Remove";
    del.onclick = () => { list.splice(i, 1); markDirty(t); render(); };
    line.append(date, amt, note, del);
    wrap.appendChild(line);
  });

  const add = document.createElement("button");
  add.className = "btn ghost ot-add";
  add.textContent = "+ Add one-time payment";
  add.onclick = () => { list.push({ date: new Date().toISOString().slice(0, 10), amount: 0, note: "" }); markDirty(t); render(); };
  wrap.appendChild(add);

  td.appendChild(wrap); tr.appendChild(td);
  return tr;
}
function renderOtHead(head, list) {
  const total = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  head.innerHTML = `<span>One-time payments <span class="muted">(bonuses, windfalls — outside the monthly plan)</span></span>${list.length ? `<span class="muted">${list.length} · ${fmt(total)} total</span>` : ""}`;
}

// APR is stored as a fraction (0.2624) but shown as a percent (26.24).
const pctToInput = (v) => (v == null || v === "" ? "" : Math.round((v <= 1 ? v * 100 : v) * 100) / 100);
const inputToPct = (v) => (v === "" ? 0 : Number(v) / 100);

// Owner picker: click each person's avatar to include/exclude them from the
// plan. Stored as data.owners (array of person ids). Also keep the legacy single
// `owner` column in sync (all people ⇒ "shared", one ⇒ that id) for compat.
const deriveOwner = (owners) =>
  (owners.length === 0 || owners.length >= state.people.length) ? "shared" : (owners.length === 1 ? owners[0] : "shared");

function ownerPicker(t) {
  if (!Array.isArray(t.data.owners)) {
    t.data.owners = t.owner === "shared" ? state.people.map((p) => p.id) : (t.owner ? [t.owner] : state.people.map((p) => p.id));
  }
  const wrap = document.createElement("div");
  wrap.className = "owner-pick";
  for (const p of state.people) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "owner-av" + (t.data.owners.includes(p.id) ? " on" : "");
    btn.title = p.name;
    btn.innerHTML = p.avatar ? `<img src="${p.avatar}" alt="${p.name}">` : `<span class="oi">${initials(p.name)}</span>`;
    btn.onclick = () => {
      const i = t.data.owners.indexOf(p.id);
      if (i >= 0) t.data.owners.splice(i, 1); else t.data.owners.push(p.id);
      t.owner = deriveOwner(t.data.owners);
      btn.classList.toggle("on");
      markDirty(t);
    };
    wrap.appendChild(btn);
  }
  return wrap;
}

// Multi-select of ledger sources: a tag list plus a typeahead input backed by
// the shared #allSources datalist. Stored as data.sources (array). Supports
// several sources because both people may fund one goal under different names.
function sourcesField(t) {
  if (!Array.isArray(t.data.sources)) t.data.sources = t.data.source ? [t.data.source] : [];
  delete t.data.source; // migrated to the array form
  const wrap = document.createElement("div");
  wrap.className = "src-multi";
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "src-input"; inp.placeholder = "add source…";
  inp.setAttribute("list", "allSources");

  const renderChips = () => {
    wrap.querySelectorAll(".src-chip").forEach((e) => e.remove());
    t.data.sources.forEach((s, i) => {
      const chip = document.createElement("span");
      chip.className = "src-chip";
      chip.appendChild(document.createTextNode(s));
      const x = document.createElement("button");
      x.type = "button"; x.className = "src-x"; x.textContent = "×"; x.title = "Remove";
      x.onclick = () => { t.data.sources.splice(i, 1); markDirty(t); renderChips(); };
      chip.appendChild(x);
      wrap.insertBefore(chip, inp);
    });
  };
  const add = (val) => {
    const v = (val ?? inp.value).trim();
    inp.value = "";
    if (v && !t.data.sources.includes(v)) { t.data.sources.push(v); markDirty(t); }
    renderChips();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !inp.value && t.data.sources.length) { t.data.sources.pop(); markDirty(t); renderChips(); }
  });
  // Picking a datalist suggestion (exact match) commits immediately; free text
  // commits on Enter or blur.
  inp.addEventListener("input", () => { if (state.sources.includes(inp.value)) add(inp.value); });
  inp.addEventListener("change", () => add());

  wrap.appendChild(inp);
  renderChips();
  return wrap;
}

function textInput(value, onChange) {
  const inp = document.createElement("input"); inp.type = "text"; inp.value = value ?? "";
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

function addTarget(kind) {
  // New savings goals go to the end of the current order.
  const data = kind === "savings_goal" ? { sort_order: savingsSorted().length } : {};
  state.targets.push({ _tempId: "new-" + (++tempId), owner: state.currentUser || "shared", kind, name: "", data, _new: true, _dirty: true });
  state.dirty = true; render();
}

function renderControls() {
  $("#saveBtn").disabled = !state.dirty;
  $("#saveBtn").textContent = state.dirty ? "Save plan*" : "Save plan";
  $("#discardBtn").hidden = !state.dirty;
  $("#dirtyNote").hidden = !state.dirty;
}

$("#saveBtn").addEventListener("click", async () => {
  $("#saveBtn").disabled = true;
  try {
    for (const t of state.targets) {
      const body = { owner: t.owner, kind: t.kind, name: t.name, data: t.data };
      if (t.id && t._dirty) await api(`/api/plan-targets/${t.id}`, { method: "PATCH", body });
      else if (!t.id) { const res = await api("/api/plan-targets", { method: "POST", body }); t.id = res.plan_target.id; }
    }
    for (const id of state.removed) await api(`/api/plan-targets/${id}`, { method: "DELETE" });
    toast("Plan saved");
    await load();
  } catch (e) { toast("Error: " + e.message); renderControls(); }
});
$("#discardBtn").addEventListener("click", load);

load().catch((e) => { $("#planRoot").innerHTML = `<p style="color:var(--muted)">Failed to load: ${e.message}</p>`; });
