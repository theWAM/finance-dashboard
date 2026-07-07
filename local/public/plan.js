// Plan editor — the migrated fin_plan.html strategy as editable plan_targets.
// Three sections (debts, savings goals, investments); each target is a row with
// its kind-specific fields. Edits stage locally and persist on "Save plan"
// (POST new / PATCH changed / DELETE removed).

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

// kind → section config. Each field: [dataKey, label, type]. `pct` = stored as a
// fraction but shown/edited as a percentage.
const SECTIONS = [
  { kind: "debt_payoff", title: "Debts", fields: [["balance", "Balance", "money"], ["apr", "APR", "pct"], ["monthly_payment", "Monthly payment", "money"], ["target_date", "Target payoff", "date"], ["source", "Ledger source", "text"]] },
  { kind: "savings_goal", title: "Savings goals", fields: [["target_amount", "Target", "money"], ["start_date", "Start", "date"], ["end_date", "Deadline", "date"], ["source", "Ledger source", "text"]] },
  { kind: "investment_cadence", title: "Investments", fields: [["monthly_target", "Monthly target", "money"], ["source", "Ledger source", "text"]] },
];

const state = { people: [], currentUser: localStorage.getItem("currentUser") || null, targets: [], removed: new Set(), dirty: false };
let tempId = 0;

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
  for (const sec of SECTIONS) {
    const section = document.createElement("section");
    const rows = state.targets.filter((t) => t.kind === sec.kind);
    section.innerHTML = `<h2>${sec.title}</h2>`;
    const table = document.createElement("table");
    const head = ["Name", "Owner", ...sec.fields.map((f) => f[1]), ""];
    table.innerHTML = `<thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const t of rows) tbody.appendChild(rowEl(t, sec));
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
  nameTd.appendChild(textInput(t.name, (v) => { t.name = v; markDirty(t); }));
  tr.appendChild(nameTd);

  const ownerTd = document.createElement("td");
  const sel = document.createElement("select");
  for (const o of [...state.people.map((p) => p.id), "shared"]) {
    const opt = document.createElement("option"); opt.value = o; opt.textContent = o; if (t.owner === o) opt.selected = true; sel.appendChild(opt);
  }
  sel.onchange = () => { t.owner = sel.value; markDirty(t); };
  ownerTd.appendChild(sel);
  tr.appendChild(ownerTd);

  for (const [key, , type] of sec.fields) {
    const td = document.createElement("td");
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

// APR is stored as a fraction (0.2624) but shown as a percent (26.24).
const pctToInput = (v) => (v == null || v === "" ? "" : Math.round((v <= 1 ? v * 100 : v) * 100) / 100);
const inputToPct = (v) => (v === "" ? 0 : Number(v) / 100);

function textInput(value, onChange) {
  const inp = document.createElement("input"); inp.type = "text"; inp.value = value ?? "";
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

function addTarget(kind) {
  state.targets.push({ _tempId: "new-" + (++tempId), owner: state.currentUser || "shared", kind, name: "", data: {}, _new: true, _dirty: true });
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
