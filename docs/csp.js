// Spending Plan editor — Conscious Spending Plans as editable plan_targets
// (kinds `csp_plan` / `csp_item`), modeled closely on plan.js. One section per
// plan, one sub-table per bucket, items editable inline. Edits stage locally
// and persist on "Save plan" (POST new / PATCH changed / DELETE removed).
//
// Every derived number on the page comes from `shared/csp.js` — the same engine
// `npm run check:csp` reconciles against SQL — evaluated over the window the
// shared timeframe control (the Ledger's, mounted here at MONTH granularity:
// a CSP is a monthly plan, so its windows only step in whole months) shows. The
// engine is fed the *staged* rows, not the saved ones, so editing a target or a
// match rule re-colors the comparison immediately, before any Save.

import { computeCsp, itemTarget, CSP_EXCLUDE, netWorth } from "./shared/csp.js";
import { MONTH_PRESETS, monthsInWindow } from "./shared/timeframe.js";
import { mountTimeframe } from "./timeframe-ui.js";
import { mountPlanNav, PLAN_VIEWS } from "./nav-plan.js";
import { mountViewSwitch } from "./view-switch.js";

// Check for the sibling Plan page before mountPlanNav runs — it replaces the
// literal "./plan.html" link with a dropdown, which would make this check
// pass by this page's own accord. The published site has no plan.html at
// all, so the switcher should hide rather than link to a 404.
const hasPlanPage = !!document.querySelector('.nav a[href="./plan.html"]');
mountPlanNav(document.querySelector(".nav"), { view: "csp" });
mountViewSwitch(document.getElementById("viewSwitch"), {
  active: "csp",
  views: hasPlanPage ? PLAN_VIEWS : PLAN_VIEWS.filter((v) => v.key === "csp"),
});

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
// A delta only means something with its sign attached, and "−$52" reads better
// than "-$52" at 12px.
const signed = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : "") + fmt(Math.abs(n));
const pct1 = (n) => `${(Number(n) || 0).toFixed(1)}%`;
const TODAY = new Date().toISOString().slice(0, 10);

const state = {
  people: [],
  currentUser: localStorage.getItem("currentUser") || null,
  accounts: [],
  transactions: [],
  plans: [], // csp_plan rows
  items: [], // csp_item rows
  removed: new Set(),
  dirty: false,
  sources: [],
  categories: [],
  // The window every "per month" figure on the page divides by.
  window: { from: "", to: "", preset: null },
  csp: null,          // the engine's last answer
  planView: new Map(), // planId        -> computed plan
  bucketView: new Map(), // planId:bucket -> computed bucket
  itemView: new Map(), // planId:itemId -> computed item
};
let tempId = 0;

const planKey = (plan) => plan.id || plan._tempId;
const itemsForPlan = (plan) =>
  state.items.filter((it) => it.data.plan_id === planKey(plan)).sort((a, b) => (a.data.sort_order ?? 0) - (b.data.sort_order ?? 0));

function defaultBuckets() {
  return [
    { bucket: "fixed", label: "Fixed Costs", rec_pct: [50, 60], sort_order: 0 },
    { bucket: "investments", label: "Investments", rec_pct: [10, 10], sort_order: 1 },
    { bucket: "savings", label: "Savings Goals", rec_pct: [5, 10], sort_order: 2 },
    { bucket: "guilt_free", label: "Guilt-Free Spending", rec_pct: [20, 35], sort_order: 3, catch_all: true },
  ];
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

function ensureDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = values.map((s) => `<option value="${String(s).replace(/"/g, "&quot;")}"></option>`).join("");
}

async function load() {
  state.people = (await api("/api/people")).people;
  // This page is personal-scope (one plan per person, like This Paycheck /
  // Daily Check): fall back to a real person id if the stored choice is
  // missing or stale, so a direct visit never renders someone else's plan.
  if (!state.people.some((p) => p.id === state.currentUser)) {
    state.currentUser = state.people[0]?.id ?? null;
    if (state.currentUser) localStorage.setItem("currentUser", state.currentUser);
  }
  renderUserChip();
  state.accounts = (await api("/api/accounts")).accounts;
  // The whole ledger, every account: the engine scopes rows to each plan's
  // owner itself, and a page-level account filter would break that.
  const { transactions } = await api("/api/transactions");
  state.transactions = transactions;
  state.sources = [...new Set(transactions.map((t) => t.source).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  state.categories = [...new Set(transactions.map((t) => t.description).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const { plan_targets } = await api("/api/plan-targets");
  const mapRow = (t) => ({ id: t.id, owner: t.owner, kind: t.kind, name: t.name, data: { ...t.data }, _new: false, _dirty: false });
  state.plans = plan_targets.filter((t) => t.kind === "csp_plan").map(mapRow);
  state.items = plan_targets.filter((t) => t.kind === "csp_item").map(mapRow);
  state.removed = new Set();
  state.dirty = false;
  render();
}

// A staged edit that can change a derived number but not the DOM's shape only
// needs the numbers repainted — rebuilding inputs mid-keystroke would steal
// focus out of the chip field you are typing in.
function markDirty(row) { if (row) row._dirty = true; state.dirty = true; renderControls(); refreshNumbers(); }


// --- the timeframe control -------------------------------------------------

// Only a closed window has a length of its own; an open one ("All time", or a
// half-filled custom range) is as long as each plan's own ledger, so the months
// figure belongs on the plan, not on the page-wide chip.
const closedWindowMonths = () => {
  const { from, to } = state.window;
  return from && to ? monthsInWindow({ from, to }) : null;
};

// Month-granularity windows make this an exact integer ("3 months"); a plan
// whose own ledger extent stands in for an open window does not, hence the
// one decimal place there.
const fmtMonths = (m) => (Number.isInteger(m) ? `${m} month${m === 1 ? "" : "s"}` : `${m.toFixed(1)} months`);

const tf = mountTimeframe($("#timeframe"), {
  // Whole calendar months only. A Conscious Spending Plan states everything
  // per month, so comparing it over a 42-day pay window (the Ledger's default)
  // or a half-finished October would be measuring the plan against a unit it
  // was never written in.
  presets: MONTH_PRESETS,
  granularity: "month",
  // Unlike the Ledger (where a fresh account resets to the default), the
  // Spending Plan remembers the window you were last comparing over.
  storageKey: "cspFiltersOpen",
  presetStorageKey: "cspPreset",
  onChange: (win) => { state.window = win; refreshNumbers(); },
  summaryExtra: () => {
    const m = closedWindowMonths();
    return m ? fmtMonths(m) : "";
  },
});

// Adopt the control's current window. Every month preset is a pure function of
// today's date, so this runs once at mount and never needs re-deriving when the
// ledger loads (the `3paychecks` preset this page used to offer did).
state.window = tf.value();

// --- derived numbers (shared/csp.js) ---------------------------------------

// One updater per derived cell / roll-up, registered while render() builds the
// DOM. refreshNumbers() re-runs the engine and replays them, so a timeframe
// change or a staged edit repaints every number without touching a single
// input — which would otherwise steal focus mid-typing.
const derived = [];
// Which drill-down panels are open, keyed so they survive a re-render.
const expanded = new Set();
let rendering = false;

function recompute() {
  // The engine is fed the STAGED rows: a plan or item that exists only in
  // memory still gets measured, keyed by its temp id until Save gives it a real
  // one (the same key the items' `data.plan_id` already points at).
  const asRow = (r, id) => ({ id, owner: r.owner, kind: r.kind, name: r.name, data: r.data });
  state.csp = computeCsp({
    transactions: state.transactions,
    accounts: state.accounts,
    people: state.people,
    cspPlans: state.plans.map((p) => asRow(p, planKey(p))),
    cspItems: state.items.map((it) => asRow(it, it.id || it._tempId)),
    window: state.window,
    asOf: TODAY,
  });
  state.planView = new Map(state.csp.plans.map((p) => [p.planId, p]));
  state.bucketView = new Map();
  state.itemView = new Map();
  for (const p of state.csp.plans) {
    for (const b of p.buckets) {
      state.bucketView.set(`${p.planId}:${b.bucket}`, b);
      for (const i of b.items) state.itemView.set(`${p.planId}:${i.itemId}`, i);
    }
  }
}

function refreshNumbers() {
  if (rendering) return;   // render() calls this itself once the DOM is complete
  recompute();
  for (const fn of derived) fn();
  tf.refreshSummary();
}

// --- "View in Ledger" ------------------------------------------------------

// The Ledger ANDs its Category and Source facets while a match rule ORs them,
// so the item's own rule can't be handed over verbatim. What can: the distinct
// category/source values that actually contributed. Every contributing row
// satisfies `category IN (...) AND source IN (...)`, so the Ledger shows a
// superset — never less than the drill-down claims. An empty value can't be
// expressed as a URL param, so that facet is dropped entirely rather than
// silently hiding its rows.
function ledgerHref(owner, groups, matched) {
  const q = new URLSearchParams();
  if (owner && owner !== "shared") q.set("user", owner);
  const accts = [...new Set(matched.map((r) => r.account_id))];
  if (accts.length === 1) q.set("account", accts[0]);
  const { from, to } = state.window;
  // Pass the resolved dates, not the preset key: this page's keys are the
  // month-granularity list, which the Ledger's picker doesn't offer — it would
  // fail to resolve `last3months` and quietly open on every row instead.
  if (from || to) { if (from) q.set("from", from); if (to) q.set("to", to); }
  else q.set("preset", "all");
  const cats = new Set(), srcs = new Set();
  for (const g of groups) { cats.add(g.category || ""); srcs.add(g.source || ""); }
  if (!cats.has("")) for (const c of cats) q.append("category", c);
  if (!srcs.has("")) for (const sc of srcs) q.append("source", sc);
  return `./?${q}`;
}

// --- drill-down panel ------------------------------------------------------

const cell = (text, cls) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = text; return td; };

/** The expanded panel under an item (or Unassigned) row. */
function drillPanel(owner, view, months) {
  const el = document.createElement("div");
  el.className = "drill";
  if (!view || !view.matched.length) {
    el.innerHTML = `<div class="drill-top">No ledger rows here in the current window.</div>`;
    return el;
  }
  const { matched, groups, total, toDate, projected } = view;

  const top = document.createElement("div");
  top.className = "drill-top";
  const perMonth = months ? total / months : 0;
  top.innerHTML =
    `<span><b>${fmt(total)}</b> over the window \u00b7 <b>${fmt(perMonth)}</b>/mo avg \u00b7 ${matched.length} row${matched.length === 1 ? "" : "s"}</span>` +
    (projected > 0.005
      ? `<span>to date <b>${fmt(toDate)}</b> \u00b7 <span class="proj">projected <b>${fmt(projected)}</b></span></span>`
      : "");
  const spacer = document.createElement("span"); spacer.className = "spacer";
  const link = document.createElement("a");
  link.className = "btn ghost"; link.href = ledgerHref(owner, groups, matched);
  link.textContent = "View in Ledger \u2192";
  link.title = "Opens the Ledger on this window, filtered to the categories and sources that contributed";
  top.append(spacer, link);
  el.appendChild(top);

  // --- grouped by category + source ---
  const gHead = document.createElement("div"); gHead.className = "sub"; gHead.textContent = "By category / source";
  const gTable = document.createElement("table");
  gTable.innerHTML = `<thead><tr><th>Category</th><th>Source</th><th class="n">Amount</th><th class="n">/mo</th><th class="n">Rows</th><th class="n">Share</th></tr></thead>`;
  const gBody = document.createElement("tbody");
  for (const g of groups) {
    const tr = document.createElement("tr");
    tr.append(
      cell(g.category || "\u2014"), cell(g.source || "\u2014"),
      cell(fmt(g.amount), "n"), cell(fmt(months ? g.amount / months : 0), "n"),
      cell(String(g.count), "n"), cell(pct1(g.share * 100), "n"),
    );
    gBody.appendChild(tr);
  }
  gTable.appendChild(gBody);
  el.append(gHead, gTable);

  // --- the rows themselves, newest first ---
  const CAP = 60;
  const rows = matched.slice().sort((a, b) => (a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : 0));
  const rHead = document.createElement("div"); rHead.className = "sub";
  rHead.textContent = rows.length > CAP ? `Ledger rows (newest ${CAP} of ${rows.length})` : `Ledger rows (${rows.length})`;
  const scroll = document.createElement("div"); scroll.className = "rows-scroll";
  const rTable = document.createElement("table");
  rTable.innerHTML = `<thead><tr><th>Date</th><th>Category</th><th>Source</th><th class="n">Amount</th></tr></thead>`;
  const rBody = document.createElement("tbody");
  for (const r of rows.slice(0, CAP)) {
    const tr = document.createElement("tr");
    // A row dated after today is the ledger's own forecast, not history.
    if (r.txn_date > TODAY) tr.className = "future";
    tr.append(cell(r.txn_date), cell(r.description || "\u2014"), cell(r.source || "\u2014"), cell(fmt(r.withdrawal), "n"));
    rBody.appendChild(tr);
  }
  rTable.appendChild(rBody);
  scroll.appendChild(rTable);
  el.append(rHead, scroll);
  if (rows.length > CAP) {
    const note = document.createElement("div"); note.className = "note";
    note.textContent = `The grouped totals above cover all ${rows.length} rows; open the Ledger for the full list.`;
    el.appendChild(note);
  }
  return el;
}

/**
 * Wire a row's Actual-avg cell as a drill-down toggle. Returns a `paint(view)`
 * the row's updater calls, so the open panel follows the current window.
 */
function drillToggle(tr, key, owner, colSpan) {
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.className = "drill-toggle";
  const amount = document.createElement("span");
  const caret = document.createElement("span"); caret.className = "caret"; caret.textContent = "\u25b6";
  toggle.append(amount, caret);

  let drillTr = null;
  let last = null;

  const paintPanel = () => {
    if (!expanded.has(key)) { drillTr?.remove(); drillTr = null; toggle.classList.remove("open"); return; }
    toggle.classList.add("open");
    if (!drillTr) {
      drillTr = document.createElement("tr");
      drillTr.className = "drill-row";
      const td = document.createElement("td"); td.colSpan = colSpan;
      drillTr.appendChild(td);
    }
    drillTr.firstChild.replaceChildren(drillPanel(owner, last?.view, last?.months));
    if (!drillTr.parentNode && tr.parentNode) tr.parentNode.insertBefore(drillTr, tr.nextSibling);
  };

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    paintPanel();
  });

  return {
    cell: toggle, amount, caret,
    // Enabled tracks whether the row is *measurable at all*, not whether it
    // happens to have rows in this window: an empty window shows an empty panel
    // rather than yanking the expansion out from under you as you sweep
    // timeframes.
    paint(view, months, { enabled = true } = {}) {
      last = { view, months };
      toggle.disabled = !enabled;
      caret.hidden = toggle.disabled;
      if (toggle.disabled) expanded.delete(key);
      paintPanel();
    },
  };
}

function render() {
  rendering = true;
  const root = $("#cspRoot");
  root.innerHTML = "";
  derived.length = 0;
  collapsers.clear();
  ensureDatalist("allSources", state.sources);
  ensureDatalist("allCategories", state.categories);

  // Personal-scope page: only the current person's own plan is ever
  // rendered here — never a sibling's, and never a household/shared one.
  const myPlans = state.plans.filter((p) => p.owner === state.currentUser);
  for (const plan of myPlans) root.appendChild(planSectionEl(plan));

  if (!myPlans.length) {
    const addPlanRow = document.createElement("div");
    addPlanRow.className = "add-row page-actions";
    addPlanRow.innerHTML = `<button class="btn ghost">+ Add my Spending Plan</button>`;
    addPlanRow.querySelector("button").onclick = addPlan;
    root.appendChild(addPlanRow);
  }

  rendering = false;
  renderControls();
  refreshNumbers();
}

// Which bucket absorbs the residual is a structural fact, not a per-plan
// choice (decision #12): guilt-free spending does, by definition. So it's
// derived on every render rather than picked in the UI — and derived
// *silently*, because marking the plan dirty here would stage a phantom edit
// on every single visit. The `catch_all` field stays in the data (the engine
// reads it, and `check:csp` asserts exactly one per plan); the UI just no
// longer lets you set it.
function ensureCatchAll(plan) {
  const buckets = plan.data.buckets || [];
  if (!buckets.length) return;
  const owner =
    buckets.find((b) => b.bucket === "guilt_free") ||
    buckets.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).at(-1);
  for (const b of buckets) {
    if (b === owner) b.catch_all = true;
    else delete b.catch_all;
  }
}

function planSectionEl(plan) {
  ensureCatchAll(plan);
  const section = document.createElement("section");
  section.className = "plan-section";
  section.dataset.planId = planKey(plan) || "";
  section.appendChild(planHeadEl(plan));
  section.appendChild(netWorthEl(plan));

  const buckets = (plan.data.buckets || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const b of buckets) section.appendChild(bucketEl(plan, b));

  const addBucketRow = document.createElement("div");
  addBucketRow.className = "add-row";
  addBucketRow.style.padding = "10px 18px";
  addBucketRow.innerHTML = `<button class="btn ghost">+ Add bucket</button>`;
  addBucketRow.querySelector("button").onclick = () => { addBucket(plan); render(); };
  section.appendChild(addBucketRow);

  return section;
}

function planHeadEl(plan) {
  const head = document.createElement("div");
  head.className = "plan-head";

  const left = document.createElement("div");
  left.style.display = "flex"; left.style.flexDirection = "column"; left.style.gap = "8px";
  left.appendChild(nameField(plan));
  head.appendChild(left);

  const fields = document.createElement("div");
  fields.className = "plan-fields";
  fields.appendChild(moneyField("Take-home /mo", plan.data.take_home, (v) => { plan.data.take_home = v; markDirty(plan); render(); }));
  fields.appendChild(moneyField("Gross /mo", plan.data.gross_monthly, (v) => { plan.data.gross_monthly = v; markDirty(plan); }));
  head.appendChild(fields);

  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const del = document.createElement("button"); del.className = "del"; del.textContent = "×"; del.title = "Remove plan";
  del.onclick = () => removePlan(plan);
  actions.appendChild(del);
  head.appendChild(actions);

  head.appendChild(planRollEl(plan));
  head.appendChild(planToolsEl(plan));
  return head;
}

// Expand all / Collapse all, plus the one place this page says "per month".
// Every figure under here is a monthly average, so no individual number
// carries a `/mo` suffix (Phase 11: one signal per fact).
function planToolsEl(plan) {
  const tools = document.createElement("div");
  tools.className = "plan-tools";
  const mk = (text, collapsed) => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn ghost"; btn.textContent = text;
    // Looked up at click time, not build time: the buckets register
    // themselves after this header is built.
    btn.onclick = () => { for (const apply of collapsers.get(planKey(plan)) || []) apply(collapsed); };
    return btn;
  };
  const note = document.createElement("span");
  note.className = "per-month-note";
  note.textContent = "every figure below is a monthly average over the window above";
  tools.append(mk("Expand all", false), mk("Collapse all", true), note);
  return tools;
}

// The plan's own target-vs-actual line and its overall status (the worst of
// its buckets). The per-window provenance sentence this used to carry
// (preset label, date range, months, excluded-row count, % projected) is
// gone per Phase 11's "one signal per fact" — the timeframe chip above
// already names the window, and the colored delta already says whether the
// plan is on track.
function planRollEl(plan) {
  const wrap = document.createElement("div");
  wrap.className = "plan-roll";
  wrap.style.flexBasis = "100%";
  const nums = document.createElement("span"); nums.className = "nums";
  const recon = document.createElement("span"); recon.className = "recon-warn"; recon.style.flexBasis = "100%";
  wrap.append(nums, recon);

  derived.push(() => {
    const v = state.planView.get(planKey(plan));
    if (!v) {   // a brand-new plan with no owner chosen yet: nothing to measure
      nums.textContent = ""; nums.title = ""; recon.hidden = true;
      return;
    }
    const targetPct = v.takeHome ? (v.targetMonthly / v.takeHome) * 100 : 0;
    const actualPct = v.takeHome ? (v.actualMonthly / v.takeHome) * 100 : 0;
    nums.innerHTML =
      `<span class="grp"><span class="lbl">target</span> <b>${fmt(v.targetMonthly)}</b> <span class="pc">(${pct1(targetPct)})</span></span> ` +
      `<span class="grp"><span class="lbl">actual</span> <b>${fmt(v.actualMonthly)}</b> <span class="pc">(${pct1(actualPct)})</span></span> ` +
      `<span class="delta ${v.status}">${signed(v.actualMonthly - v.targetMonthly)}</span>`;
    // An open window ("All time") has no length of its own \u2014 it's as long
    // as this plan's own ledger \u2014 so that figure, which the removed note
    // line used to carry, lives on a tooltip instead of a visible line.
    nums.title = closedWindowMonths() == null ? `Averaged over ${fmtMonths(v.months)}` : "";

    // The engine re-checks on every call that every windowed dollar is either
    // bucketed or explicitly excluded. If it ever stops adding up, say so here
    // rather than quietly showing numbers that don't.
    recon.hidden = v.reconciles;
    recon.textContent = v.reconciles ? "" : `Doesn't reconcile: buckets + excluded = ${fmt(v.total + v.excluded.total)} but the window's outflow is ${fmt(v.windowOutflow)}`;
  });
  return wrap;
}

function nameField(plan) {
  const wrap = document.createElement("span");
  wrap.className = "name-field";
  const inp = document.createElement("input");
  inp.type = "text"; inp.value = plan.name || ""; inp.placeholder = "Plan name";
  inp.addEventListener("change", () => { plan.name = inp.value; markDirty(plan); });
  wrap.appendChild(inp);
  return wrap;
}

function moneyField(label, value, onChange) {
  const f = document.createElement("div");
  f.className = "field money";
  const lab = document.createElement("label"); lab.textContent = label;
  const inp = document.createElement("input");
  inp.type = "number"; inp.step = "0.01"; inp.value = value ?? "";
  inp.addEventListener("change", () => onChange(Number(inp.value) || 0));
  f.append(lab, inp);
  return f;
}

// The plan's balance sheet, at the top of the plan and above its buckets: the
// four components are typed in, the net worth itself is computed by
// `shared/csp.js` (assets + investments + savings − debt, with `debt` stored
// as a positive magnitude). Registered as a derived cell like every other
// computed figure here, so a staged edit to any component repaints the total
// without rebuilding — and therefore without stealing focus out of the field
// being typed in.
function netWorthEl(plan) {
  if (!plan.data.net_worth) plan.data.net_worth = { assets: 0, investments: 0, savings: 0, debt: 0 };
  const nw = plan.data.net_worth;
  const row = document.createElement("div");
  row.className = "netw";

  const total = document.createElement("div");
  total.className = "field netw-total";
  const lab = document.createElement("label"); lab.textContent = "Net worth";
  const val = document.createElement("b");
  total.append(lab, val);

  const mk = (key, label) => moneyField(label, nw[key], (v) => { nw[key] = v; markDirty(plan); });
  row.append(total, mk("assets", "Assets"), mk("investments", "Investments"), mk("savings", "Savings"), mk("debt", "Debt"));

  derived.push(() => {
    const w = netWorth(nw);
    val.textContent = fmt(w.total);
    // Negative net worth is the one state worth coloring: owing more than you
    // own is the fact the number exists to surface.
    val.classList.toggle("neg", w.total < 0);
    val.title = `${fmt(w.owned)} owned (assets + investments + savings) \u2212 ${fmt(w.debt)} debt`;
  });
  return row;
}

function slugify(s) { return (s || "bucket").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "bucket"; }
function uniqueBucketKey(plan, base) {
  const used = new Set((plan.data.buckets || []).map((b) => b.bucket));
  let key = base, n = 1;
  while (used.has(key)) key = `${base}_${++n}`;
  return key;
}

function addBucket(plan) {
  const key = uniqueBucketKey(plan, "bucket");
  plan.data.buckets.push({ bucket: key, label: "New bucket", rec_pct: [0, 0], sort_order: plan.data.buckets.length });
  markDirty(plan);
}

function removeBucket(plan, b) {
  const hasItems = itemsForPlan(plan).some((it) => it.data.bucket === b.bucket);
  if (hasItems) { toast("Remove this bucket's items first"); return; }
  plan.data.buckets = plan.data.buckets.filter((x) => x !== b);
  markDirty(plan);
  render();   // re-derives the catch-all, and with it the residual target
}

// --- collapsing a bucket ---------------------------------------------------

// Collapsed by default (decision #14): a plan should open as four summary
// lines, not 35 item rows. Per bucket, so expanding one to work in it doesn't
// re-open the other three on the next visit. Lives alongside `cspPreset`.
const collapseKey = (plan, b) => `cspCollapsed:${planKey(plan)}:${b.bucket}`;
const isCollapsed = (plan, b) => localStorage.getItem(collapseKey(plan, b)) !== "0";
const setCollapsed = (plan, b, v) => localStorage.setItem(collapseKey(plan, b), v ? "1" : "0");

// planKey -> [apply(collapsed)], so the plan header's Expand/Collapse all can
// reach buckets that render after it. Rebuilt by every render().
const collapsers = new Map();
let bucketUid = 0;

function bucketEl(plan, b) {
  const wrap = document.createElement("div");
  wrap.className = "bucket";
  wrap.dataset.bucket = b.bucket;

  // Everything below the summary line. Hidden rather than removed when
  // collapsed, so the derived updaters keep repainting it: expanding a bucket
  // after a timeframe change must never reveal a stale number.
  const body = document.createElement("div");
  body.className = "bucket-body";
  body.id = `bucket-body-${++bucketUid}`;

  const head = document.createElement("div");
  head.className = "bucket-head";

  const caret = document.createElement("button");
  caret.type = "button"; caret.className = "caret-btn"; caret.textContent = "\u25b6";
  caret.setAttribute("aria-controls", body.id);

  const labelInp = document.createElement("input");
  labelInp.className = "label"; labelInp.type = "text"; labelInp.value = b.label || b.bucket;
  labelInp.addEventListener("change", () => { b.label = labelInp.value; markDirty(plan); });

  // The recommended range is template advice, not something to fill in
  // (decision #12) — text, not a form. A bucket the user added himself has no
  // range at all, and "rec 0\u20130%" is noise, so it simply isn't appended.
  const [lo, hi] = Array.isArray(b.rec_pct) ? b.rec_pct : [0, 0];
  let rec = null;
  if (lo || hi) {
    rec = document.createElement("span");
    rec.className = "rec-pct";
    rec.textContent = lo === hi ? `rec ${lo}%` : `rec ${lo}\u2013${hi}%`;
    rec.title = "Recommended share of take-home for this bucket";
  }

  const delBtn = document.createElement("button");
  delBtn.className = "del bucket-del"; delBtn.textContent = "\u00d7"; delBtn.title = "Remove bucket";
  delBtn.onclick = () => removeBucket(plan, b);

  head.append(caret, labelInp, ...(rec ? [rec] : []), bucketSummaryEl(plan, b), delBtn);

  let collapsed = isCollapsed(plan, b);
  const apply = (next, persist = true) => {
    collapsed = next;
    wrap.classList.toggle("collapsed", collapsed);
    body.hidden = collapsed;
    caret.setAttribute("aria-expanded", String(!collapsed));
    caret.title = collapsed ? "Expand bucket" : "Collapse bucket";
    if (persist) setCollapsed(plan, b, collapsed);
  };
  apply(collapsed, false);   // the stored state isn't an edit; don't write it back
  caret.addEventListener("click", () => apply(!collapsed));
  // The whole summary line is the toggle — except the parts of it that are
  // controls in their own right: the title input, the caret, the delete ×.
  head.addEventListener("click", (e) => {
    if (e.target.closest("input, button, select, label, a")) return;
    apply(!collapsed);
  });
  if (!collapsers.has(planKey(plan))) collapsers.set(planKey(plan), []);
  collapsers.get(planKey(plan)).push(apply);

  const items = itemsForPlan(plan).filter((it) => it.data.bucket === b.bucket);
  body.appendChild(itemsTableEl(plan, b, items));

  const addItemRow = document.createElement("div");
  addItemRow.className = "add-row";
  addItemRow.innerHTML = `<button class="btn ghost">+ Add item</button>`;
  addItemRow.querySelector("button").onclick = () => addItem(plan, b);
  body.appendChild(addItemRow);

  wrap.append(head, body);
  return wrap;
}

// The one line a collapsed bucket is, and the right-hand half of its header
// when expanded: its items' targets summed (or, for the catch-all, the
// residual take-home) against its items' actuals summed, each with its share
// of take-home — the number the CSP template is actually written in — then the
// delta, whose red/green is the bucket's only status signal (decision #13).
function bucketSummaryEl(plan, b) {
  const span = document.createElement("span");
  span.className = "bucket-sum";
  derived.push(() => {
    const v = state.bucketView.get(`${planKey(plan)}:${b.bucket}`);
    if (!v) { span.textContent = ""; return; }
    // The catch-all's target is what's left of take-home, not a sum of its
    // items. Worth surfacing; not worth a word on every line.
    const tip = v.catchAll ? ` title="Residual: take-home minus every other bucket\u2019s target"` : "";
    span.innerHTML =
      `<span class="grp"><span class="lbl">target</span> <b${tip}>${fmt(v.targetMonthly)}</b> <span class="pc">(${pct1(v.targetPct)})</span></span>` +
      `<span class="grp"><span class="lbl">actual</span> <b>${fmt(v.actualMonthly)}</b> <span class="pc">(${pct1(v.actualPct)})</span></span>` +
      `<span class="delta ${v.status}">${signed(v.delta)}</span>`;
  });
  return span;
}

const ITEM_COLS = 6;

function itemsTableEl(plan, b, items) {
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Name</th><th>Target</th><th>Actual avg</th><th>Δ</th><th>Match rule</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const it of items) tbody.appendChild(itemRowEl(plan, it));
  // Only the catch-all bucket absorbs unmatched outflow (decision #6), so only
  // it gets the Unassigned row that makes the comparison reconcile.
  if (b.catch_all) tbody.appendChild(unassignedRowEl(plan, b));
  table.appendChild(tbody);
  return table;
}

// Every windowed dollar of the owner's outflow that no item claimed. Without
// this row the bucket totals would quietly understate real spending.
function unassignedRowEl(plan, b) {
  const tr = document.createElement("tr");
  tr.className = "unassigned-row";
  const key = `${planKey(plan)}:unassigned:${b.bucket}`;
  const drill = drillToggle(tr, key, plan.owner, ITEM_COLS);

  const nameTd = document.createElement("td"); nameTd.className = "u-name";
  const countNote = document.createElement("span"); countNote.className = "ph";
  nameTd.append(document.createTextNode("Unassigned "), countNote);

  const actualTd = document.createElement("td"); actualTd.className = "money";
  actualTd.appendChild(drill.cell);

  tr.append(
    nameTd,
    cell("\u2014", "money"),
    actualTd,
    cell("\u2014", "money"),
    cell("outflow matching no item", "ph"),
    cell(""),
  );

  derived.push(() => {
    const v = state.bucketView.get(`${planKey(plan)}:${b.bucket}`);
    const u = v?.unassigned;
    const p = state.planView.get(planKey(plan));
    countNote.textContent = u?.count ? `(${u.count} row${u.count === 1 ? "" : "s"})` : "(none)";
    drill.amount.textContent = fmt(u?.actualMonthly || 0);
    // `unassigned` carries no `matched` list (the engine groups it instead), so
    // reconstruct one from the groups for the panel's row list.
    drill.paint(u ? { ...u, matched: unassignedRows(p) } : null, p?.months, { enabled: !!u });
  });
  return tr;
}

// The engine returns Unassigned as groups, not rows. Rebuild the row list the
// way the engine defines it — by subtraction: the owner's windowed, non-artifact
// outflow minus every row an item claimed.
function unassignedRows(planView) {
  if (!planView) return [];
  const taken = new Set();
  for (const b of planView.buckets) for (const i of b.items) for (const r of i.matched) taken.add(r.id);
  const ids = new Set(state.accounts.filter((a) => !a.deleted_at && a.owner === planView.owner).map((a) => a.id));
  const { from, to } = planView.window;
  return state.transactions.filter((t) =>
    !t.deleted_at && ids.has(t.account_id) && (Number(t.withdrawal) || 0) > 0 &&
    (!from || t.txn_date >= from) && (!to || t.txn_date <= to) &&
    !CSP_EXCLUDE.has(t.description || "") && !taken.has(t.id));
}

function itemRowEl(plan, it) {
  const tr = document.createElement("tr");
  tr.dataset.itemId = it.id || it._tempId;
  if (it._new) tr.className = "new-row"; else if (it._dirty) tr.className = "edited";
  if (it.data.proposed) tr.classList.add("proposed-row");

  const nameTd = document.createElement("td"); nameTd.className = "name-cell";
  nameTd.appendChild(textInput(it.name, (v) => { it.name = v; markDirty(it); }));
  tr.appendChild(nameTd);

  const targetTd = document.createElement("td"); targetTd.className = "num";
  targetTd.appendChild(targetField(plan, it));
  tr.appendChild(targetTd);

  // --- the comparison columns, from shared/csp.js ---
  const key = `${planKey(plan)}:${it.id || it._tempId}`;
  const drill = drillToggle(tr, key, plan.owner, ITEM_COLS);

  const actualTd = document.createElement("td"); actualTd.className = "money actual-cell";
  actualTd.appendChild(drill.cell);
  tr.appendChild(actualTd);

  const deltaTd = document.createElement("td"); deltaTd.className = "money delta-cell";
  tr.appendChild(deltaTd);

  const ruleTd = document.createElement("td");
  ruleTd.appendChild(matchRuleEl(it));
  const conflictWarn = document.createElement("span");
  conflictWarn.className = "conflict"; conflictWarn.textContent = "\u26a0"; conflictWarn.hidden = true;
  ruleTd.appendChild(conflictWarn);
  tr.appendChild(ruleTd);

  derived.push(() => {
    const v = state.itemView.get(key);
    const p = state.planView.get(planKey(plan));
    if (!v) {   // no plan to measure against (new plan, no owner picked yet)
      drill.amount.textContent = "\u2014";
      deltaTd.textContent = "\u2014";
      conflictWarn.hidden = true;
      drill.paint(null, null, { enabled: false });
      return;
    }
    // An item with no match rule can't be measured against the ledger at all;
    // saying so is honest where a $0 actual would just look like a failure.
    drill.amount.textContent = v.tracked ? fmt(v.actualMonthly) : "target only \u2014 not tracked";
    deltaTd.innerHTML = v.tracked ? `<span class="delta ${v.status}">${signed(v.delta)}</span>` : "\u2014";
    conflictWarn.hidden = !v.conflicts;
    if (v.conflicts) {
      conflictWarn.title = `${v.conflicts} ledger row${v.conflicts === 1 ? "" : "s"} here also match another item's rule. Each row is still counted once — a payee rule wins over a category rule.`;
    }
    drill.paint(v, p?.months, { enabled: v.tracked });
  });

  const act = document.createElement("td"); act.className = "row-actions";
  const del = document.createElement("button"); del.className = "del"; del.textContent = "×"; del.title = "Remove";
  del.onclick = () => { if (it.id) state.removed.add(it.id); state.items = state.items.filter((x) => x !== it); state.dirty = true; render(); };
  act.appendChild(del); tr.appendChild(act);
  return tr;
}

// $/% basis toggle + the single editable number; shows the derived other-basis
// figure (shared/csp.js itemTarget) so typing a % immediately shows the $/mo
// it implies at the plan's current take-home, and vice versa.
function targetField(plan, it) {
  const wrap = document.createElement("div");
  wrap.className = "target-field";

  const toggle = document.createElement("span");
  toggle.className = "basis-toggle";
  const dollarBtn = document.createElement("button"); dollarBtn.type = "button"; dollarBtn.textContent = "$";
  const pctBtn = document.createElement("button"); pctBtn.type = "button"; pctBtn.textContent = "%";
  toggle.append(dollarBtn, pctBtn);

  const inp = document.createElement("input"); inp.type = "number"; inp.step = "0.01";
  const derived = document.createElement("span"); derived.className = "derived";

  const refresh = () => {
    dollarBtn.classList.toggle("on", it.data.basis !== "%");
    pctBtn.classList.toggle("on", it.data.basis === "%");
    inp.value = it.data.basis === "%" ? (it.data.target_pct ?? 0) : (it.data.target_amount ?? 0);
    const t = itemTarget(it.data, plan.data.take_home);
    derived.textContent = it.data.basis === "%" ? `≈ ${fmt(t.targetMonthly)}` : `≈ ${t.targetPct.toFixed(1)}%`;
  };
  refresh();

  dollarBtn.onclick = () => { if (it.data.basis !== "$") { it.data.basis = "$"; markDirty(it); refresh(); } };
  pctBtn.onclick = () => { if (it.data.basis !== "%") { it.data.basis = "%"; markDirty(it); refresh(); } };
  inp.addEventListener("change", () => {
    const v = Number(inp.value) || 0;
    if (it.data.basis === "%") it.data.target_pct = v; else it.data.target_amount = v;
    markDirty(it);
    refresh();
  });

  wrap.append(toggle, inp, derived);
  return wrap;
}

function matchRuleEl(it) {
  const wrap = document.createElement("div");
  wrap.className = "rule-group";
  const srcLabel = document.createElement("div"); srcLabel.className = "rule-label"; srcLabel.textContent = "Sources";
  const catLabel = document.createElement("div"); catLabel.className = "rule-label"; catLabel.textContent = "Categories";
  wrap.append(srcLabel, tagField(it.data, "sources", state.sources, "allSources", () => markDirty(it)));
  wrap.append(catLabel, tagField(it.data, "categories", state.categories, "allCategories", () => markDirty(it)));
  return wrap;
}

// Multi-select chip field for sources/categories — mirrors plan.js's
// sourcesField(), generalized over which data[] key and datalist it uses.
function tagField(data, key, allValues, datalistId, onDirty) {
  if (!Array.isArray(data[key])) data[key] = [];
  const list = data[key];
  const wrap = document.createElement("div");
  wrap.className = "tag-multi";
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "tag-input"; inp.placeholder = "add…";
  inp.setAttribute("list", datalistId);

  const renderChips = () => {
    wrap.querySelectorAll(".tag-chip").forEach((e) => e.remove());
    list.forEach((s, i) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.appendChild(document.createTextNode(s));
      const x = document.createElement("button");
      x.type = "button"; x.className = "tag-x"; x.textContent = "×"; x.title = "Remove";
      x.onclick = () => { list.splice(i, 1); onDirty(); renderChips(); };
      chip.appendChild(x);
      wrap.insertBefore(chip, inp);
    });
  };
  const add = (val) => {
    const v = (val ?? inp.value).trim();
    inp.value = "";
    if (v && !list.includes(v)) { list.push(v); onDirty(); }
    renderChips();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !inp.value && list.length) { list.pop(); onDirty(); renderChips(); }
  });
  inp.addEventListener("input", () => { if (allValues.includes(inp.value)) add(inp.value); });
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

function addItem(plan, b) {
  state.items.push({
    _tempId: "newitem-" + (++tempId),
    owner: plan.owner,
    kind: "csp_item",
    name: "",
    data: { plan_id: planKey(plan), bucket: b.bucket, target_amount: 0, basis: "$", target_pct: null, sources: [], categories: [], sort_order: itemsForPlan(plan).length },
    _new: true, _dirty: true,
  });
  state.dirty = true;
  render();
}

function addPlan() {
  // Personal-scope: a plan you create here is always your own — there is no
  // picker, and no "shared"/household option.
  const me = state.people.find((p) => p.id === state.currentUser);
  if (!me) { toast("Can't tell who you are — reload the page"); return; }
  state.plans.push({
    _tempId: "newplan-" + (++tempId),
    owner: me.id,
    kind: "csp_plan",
    name: `${me.name} — Conscious Spending Plan`,
    data: { take_home: 0, gross_monthly: 0, net_worth: { assets: 0, investments: 0, savings: 0, debt: 0 }, buckets: defaultBuckets() },
    _new: true, _dirty: true,
  });
  state.dirty = true;
  render();
}

function removePlan(plan) {
  const items = itemsForPlan(plan);
  for (const it of items) if (it.id) state.removed.add(it.id);
  state.items = state.items.filter((it) => !items.includes(it));
  if (plan.id) state.removed.add(plan.id);
  state.plans = state.plans.filter((p) => p !== plan);
  state.dirty = true;
  render();
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
    for (const plan of state.plans) {
      if (!plan.owner) { toast("Choose an owner for every plan before saving"); renderControls(); return; }
      const body = { owner: plan.owner, kind: plan.kind, name: plan.name, data: plan.data };
      if (plan.id && plan._dirty) {
        await api(`/api/plan-targets/${plan.id}`, { method: "PATCH", body });
      } else if (!plan.id) {
        const oldKey = plan._tempId;
        const res = await api("/api/plan-targets", { method: "POST", body });
        plan.id = res.plan_target.id;
        for (const it of state.items) if (it.data.plan_id === oldKey) { it.data.plan_id = plan.id; it._dirty = true; }
      }
    }
    for (const it of state.items) {
      const body = { owner: it.owner, kind: it.kind, name: it.name, data: it.data };
      if (it.id && it._dirty) await api(`/api/plan-targets/${it.id}`, { method: "PATCH", body });
      else if (!it.id) { const res = await api("/api/plan-targets", { method: "POST", body }); it.id = res.plan_target.id; }
    }
    for (const id of state.removed) await api(`/api/plan-targets/${id}`, { method: "DELETE" });
    toast("Spending plan saved");
    await load();
  } catch (e) { toast("Error: " + e.message); renderControls(); }
});
$("#discardBtn").addEventListener("click", load);
window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

load().catch((e) => { $("#cspRoot").innerHTML = `<p style="color:var(--muted)">Failed to load: ${e.message}</p>`; });
