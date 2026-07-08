// Shared dashboard renderer — builds the health strip, metric tiles, drift
// table, and a monthly-spend chart from { accounts, transactions, planTargets,
// people }. Used by both the local app (dashboard.js) and the published view, so
// both show identical results. Browser-only (uses the DOM); pure computation
// lives in metrics.js / drift.js. Injects its own scoped styles (inherits the
// host palette).

import { summary, monthlySpend } from "./metrics.js";
import { computeDrift, overallStatus } from "./drift.js";

const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt2 = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const NS = "http://www.w3.org/2000/svg";
const STATUS = { good: { label: "On track", icon: "✓", color: "var(--pos)" }, warn: { label: "Watch", icon: "!", color: "var(--warn)" }, bad: { label: "Off track", icon: "✕", color: "var(--neg)" } };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SPEND_LIMIT = 600; // monthly-spend line above this is flagged (pointed + shaded red)

// The single editable number per plan kind (the value shown in the "plan …" tag).
const PLAN_FIELD = { savings_goal: "target_amount", investment_cadence: "monthly_target", debt_payoff: "monthly_payment" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const avatarPath = (p) => String(p || "").replace(/^\//, ""); // "/avatars/x.jpg" → "avatars/x.jpg" (works at root and under /finance-dashboard/)

function ensureStyles() {
  if (document.getElementById("dash-style")) return;
  const s = document.createElement("style");
  s.id = "dash-style";
  s.textContent = `
  .dash { max-width: 1080px; }
  .health { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel); margin-bottom: 20px; }
  .health .badge { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 20px; font-weight: 700; color: #fff; }
  .health .h-title { font-weight: 700; font-size: 16px; }
  .health .h-sub { color: var(--muted); font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .tile .t-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .tile .t-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .tile .t-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .dash h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 22px 0 10px; }
  .drift-row { display: grid; grid-template-columns: 22px 1.3fr 1fr auto; gap: 12px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; margin-bottom: 8px; background: var(--panel); }
  .drift-row .st { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700; }
  .drift-row .d-name { font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
  .drift-row .d-detail { color: var(--muted); font-size: 12px; }
  .drift-row .d-vals { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
  /* owner avatars — a single circle, or overlapping stack for "shared" */
  .av-stack { display: inline-flex; align-items: center; }
  .av-stack .pav { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; border: 2px solid var(--panel); background: var(--accent); margin-left: -7px; }
  .av-stack .pav:first-child { margin-left: 0; }
  .av-stack .pav-i { display: grid; place-items: center; color: #fff; font-size: 10px; font-weight: 700; }
  /* editable plan tag */
  .plan-edit { cursor: pointer; border-bottom: 1px dashed var(--muted); }
  .plan-edit:hover { color: var(--text); border-bottom-color: var(--accent); }
  .plan-input { width: 92px; background: var(--panel-2); border: 1px solid var(--accent); border-radius: 6px; color: var(--text); font: inherit; padding: 2px 6px; font-variant-numeric: tabular-nums; }
  .chart-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .axis-label { fill: var(--muted); font-size: 10px; }
  .spend-dot { cursor: default; } .spend-dot:hover { r: 6; }`;
  document.head.appendChild(s);
}

/**
 * @param {object} opts
 * @param {Array} opts.accounts
 * @param {Array} opts.transactions
 * @param {Array} opts.planTargets
 * @param {Array} [opts.people]        for owner avatars
 * @param {string} [opts.asOf]
 * @param {string} [opts.currentUser]  when set, scope tiles + plan to this person (+ shared)
 * @param {(id:string, field:string, value:number)=>any} [opts.onEditPlan]  makes plan tags editable
 */
export function renderDashboard(root, { accounts = [], transactions = [], planTargets = [], people = [], asOf, currentUser = "", onEditPlan } = {}) {
  ensureStyles();
  asOf = asOf || new Date().toISOString().slice(0, 10);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  // User-specific view: a person sees their own + shared accounts and plan items.
  const mine = (owner) => !currentUser || owner === currentUser || owner === "shared";
  const myAccounts = accounts.filter((a) => mine(a.owner));
  const myAccountIds = new Set(myAccounts.map((a) => a.id));
  const myTxns = currentUser ? transactions.filter((t) => myAccountIds.has(t.account_id)) : transactions;
  // A plan can name several owners (data.owners); it's in scope when it includes
  // the current person (or names everyone / no one).
  const minePlan = (pt) => { const ow = resolveOwners(pt.data && pt.data.owners, pt.owner, people); return !currentUser || ow.length === 0 || ow.includes(currentUser); };
  const myPlan = planTargets.filter(minePlan);

  // As-of-today checking balance = opening + net of that account's txns ≤ today.
  const checkingToday = myAccounts.filter((a) => a.type === "checking").reduce((sum, a) => {
    let bal = Number(a.opening_balance) || 0;
    for (const t of myTxns) if (t.account_id === a.id && t.txn_date <= asOf) bal += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
    return sum + bal;
  }, 0);

  const ytd = summary(myTxns, { from: yearStart, to: asOf });
  // Drift matches by source, so use the full ledger (a shared goal may be funded
  // by either person) but only for the plan items in scope.
  const drift = computeDrift(transactions, myPlan, { asOf });
  const overall = overallStatus(drift);
  const warnings = drift.filter((d) => d.status !== "good");

  const st = STATUS[overall];
  root.className = "dash";
  root.innerHTML = `
    <div class="health">
      <div class="badge" style="background:${st.color}">${st.icon}</div>
      <div>
        <div class="h-title">${overall === "good" ? "Everything's on track" : `${warnings.length} thing${warnings.length === 1 ? "" : "s"} need attention`}</div>
        <div class="h-sub">${warnings.length ? warnings.map((w) => esc(w.name)).join(", ") : "Debts, savings goals and investments are all pacing to plan."}</div>
      </div>
    </div>
    <div class="tiles">
      ${tile("In checking (today)", fmt2(checkingToday))}
      ${tile("Income (YTD)", fmt(ytd.income))}
      ${tile("Spending (YTD)", fmt(ytd.spend), "excl. savings, debt, transfers")}
      ${tile("Saved (YTD)", fmt(ytd.saved), `${ytd.savingsRate}% of income`)}
      ${tile("Invested (YTD)", fmt(ytd.invested), `${ytd.investRate}% of income`)}
      ${tile("Debt paid (YTD)", fmt(ytd.debtPaid))}
    </div>
    ${driftSection("Debts", drift.filter((d) => d.kind === "debt_payoff"), people, !!onEditPlan)}
    ${driftSection("Savings goals", drift.filter((d) => d.kind === "savings_goal").sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9)), people, !!onEditPlan)}
    ${driftSection("Investments", drift.filter((d) => d.kind === "investment_cadence"), people, !!onEditPlan)}
    <h2>Monthly spending (excl. credit-card &amp; transfers)</h2>
    <div class="chart-card"><svg id="dashSpend" width="100%" height="210" role="img" aria-label="Monthly spending"></svg></div>`;

  const spend = monthlySpend(myTxns).filter((m) => m.month <= asOf.slice(0, 7));
  drawSpendChart(root.querySelector("#dashSpend"), spend.slice(-12));

  if (onEditPlan) wirePlanEditing(root, drift, onEditPlan);
}

const tile = (label, value, sub = "") =>
  `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ""}</div>`;

// --- owner avatars ---------------------------------------------------------

function avatarHTML(person) {
  const name = esc(person?.name || "?");
  if (person?.avatar) return `<img class="pav" src="${avatarPath(person.avatar)}" alt="${name}" title="${name}">`;
  return `<span class="pav pav-i" title="${name}">${name.slice(0, 1).toUpperCase()}</span>`;
}
// Resolve a plan's owners to a list of person ids. Prefer the multi-owner array
// (data.owners); fall back to the legacy single owner string ("shared" = all).
function resolveOwners(ownersArray, ownerStr, people) {
  const ids = new Set(people.map((p) => p.id));
  if (Array.isArray(ownersArray) && ownersArray.length) return ownersArray.filter((id) => ids.has(id));
  if (ownerStr === "shared") return people.map((p) => p.id);
  if (ownerStr && ids.has(ownerStr)) return [ownerStr];
  return [];
}
function ownerAvatars(ownerIds, people) {
  const list = ownerIds.length ? ownerIds : people.map((p) => p.id); // none named ⇒ everyone
  const title = list.map((id) => (people.find((p) => p.id === id) || {}).name || id).join(", ");
  return `<span class="av-stack" title="${esc(title)}">${list.map((id) => avatarHTML(people.find((p) => p.id === id) || { name: id })).join("")}</span>`;
}

// --- drift rows ------------------------------------------------------------

function driftSection(title, rows, people, editable) {
  if (!rows.length) return "";
  return `<h2>${title}</h2>` + rows.map((r) => {
    const s = STATUS[r.status];
    const perMo = r.kind !== "savings_goal";
    const num = fmt(r.planValue) + (perMo ? "/mo" : "");
    const planTag = editable
      ? `plan <span class="plan-edit" data-id="${r.id}" data-field="${PLAN_FIELD[r.kind]}" data-value="${r.planValue}" title="Click to edit the plan target">${num}</span>`
      : `plan ${num}`;
    return `<div class="drift-row">
      <div class="st" style="background:${s.color}" title="${s.label}">${s.icon}</div>
      <div><span class="d-name">${esc(r.name)} ${ownerAvatars(resolveOwners(r.owners, r.owner, people), people)}</span><div class="d-detail">${esc(r.detail)}</div></div>
      <div class="d-detail">${planTag}</div>
      <div class="d-vals">${fmt(r.actualValue)}${perMo ? "/mo" : ""}</div>
    </div>`;
  }).join("");
}

// Turn a clicked plan tag into an inline number input; commit calls onEditPlan.
function wirePlanEditing(root, drift, onEditPlan) {
  root.querySelectorAll(".plan-edit").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.querySelector("input")) return;
      const { id, field, value } = el.dataset;
      const input = document.createElement("input");
      input.type = "number"; input.step = "1"; input.className = "plan-input"; input.value = value;
      const prev = el.textContent; el.textContent = ""; el.appendChild(input); input.focus(); input.select();
      let done = false;
      const cancel = () => { if (done) return; done = true; el.textContent = prev; };
      const commit = async () => {
        if (done) return; done = true;
        const v = Number(input.value);
        el.textContent = "saving…";
        try { await onEditPlan(id, field, Number.isFinite(v) ? v : Number(value)); }
        catch (e) { el.textContent = prev; alert("Could not save: " + e.message); }
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") cancel(); });
      input.addEventListener("blur", commit);
    });
  });
}

// --- monthly-spend chart (line + shaded area; over-limit pointed & red) ----

function drawSpendChart(svg, data) {
  if (!svg || !data.length) return;
  const W = svg.clientWidth || 800, H = 210, padB = 26, padL = 48, padT = 14, padR = 10;
  const plotW = Math.max(1, W - padL - padR), plotH = H - padB - padT;
  const domainMax = Math.max(SPEND_LIMIT * 1.15, ...data.map((d) => d.amount));
  const x = (i) => padL + (data.length === 1 ? plotW / 2 : (plotW * i) / (data.length - 1));
  const y = (v) => padT + plotH * (1 - v / domainMax);
  const pts = data.map((d, i) => ({ x: x(i), y: y(d.amount), d }));
  const base = y(0), limitY = y(SPEND_LIMIT);
  const linePath = pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const areaPath = `M ${pts[0].x.toFixed(1)} ${base.toFixed(1)} ` + pts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L ${pts[pts.length - 1].x.toFixed(1)} ${base.toFixed(1)} Z`;
  const cid = "spclip" + Math.random().toString(36).slice(2, 8);

  const dots = pts.map((p) => {
    const over = p.d.amount > SPEND_LIMIT;
    return `<circle class="spend-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${over ? 5 : 3.5}" fill="${over ? "var(--neg)" : "#3987e5"}" stroke="var(--panel)" stroke-width="1.5"><title>${p.d.month}: ${fmt2(p.d.amount)}${over ? " · over $600" : ""}</title></circle>`;
  }).join("");
  const labels = pts.map((p, i) => {
    const [yr, mm] = p.d.month.split("-").map(Number);
    const txt = (mm === 1 || i === 0) ? `${MON[mm - 1]} ’${String(yr).slice(2)}` : MON[mm - 1];
    return `<text class="axis-label" x="${p.x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${txt}</text>`;
  }).join("");

  svg.innerHTML = `
    <defs><clipPath id="${cid}"><rect x="${padL}" y="${padT}" width="${(W - padR - padL).toFixed(1)}" height="${Math.max(0, limitY - padT).toFixed(1)}"/></clipPath></defs>
    <line x1="${padL}" x2="${W - padR}" y1="${y(domainMax).toFixed(1)}" y2="${y(domainMax).toFixed(1)}" stroke="var(--line)"/>
    <text class="axis-label" x="4" y="${(y(domainMax) + 4).toFixed(1)}">${fmt(domainMax)}</text>
    <path d="${areaPath}" fill="#3987e5" fill-opacity="0.15"/>
    <path d="${areaPath}" fill="var(--neg)" fill-opacity="0.22" clip-path="url(#${cid})"/>
    <line x1="${padL}" x2="${W - padR}" y1="${limitY.toFixed(1)}" y2="${limitY.toFixed(1)}" stroke="var(--neg)" stroke-dasharray="4 3" stroke-opacity="0.8"/>
    <text class="axis-label" x="4" y="${(limitY + 4).toFixed(1)}" style="fill:var(--neg)">${fmt(SPEND_LIMIT)}</text>
    <path d="${linePath}" fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}`;
}
