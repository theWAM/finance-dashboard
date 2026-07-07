// Shared dashboard renderer — builds the health strip, metric tiles, drift
// table, and a monthly-spend chart from { accounts, transactions, planTargets }.
// Used by both the local app (dashboard.js) and the published view, so both show
// identical results. Browser-only (uses the DOM); pure computation lives in
// metrics.js / drift.js. Injects its own scoped styles (inherits the host palette).

import { summary, monthlySpend } from "./metrics.js";
import { computeDrift, overallStatus } from "./drift.js";

const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt2 = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const NS = "http://www.w3.org/2000/svg";
const STATUS = { good: { label: "On track", icon: "✓", color: "var(--pos)" }, warn: { label: "Watch", icon: "!", color: "var(--warn)" }, bad: { label: "Off track", icon: "✕", color: "var(--neg)" } };

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
  .drift-row .d-name { font-weight: 600; } .drift-row .d-owner { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
  .drift-row .d-detail { color: var(--muted); font-size: 12px; }
  .drift-row .d-vals { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
  .chart-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .bar:hover { opacity: .85; }
  .axis-label { fill: var(--muted); font-size: 10px; }`;
  document.head.appendChild(s);
}

export function renderDashboard(root, { accounts = [], transactions = [], planTargets = [], asOf }) {
  ensureStyles();
  asOf = asOf || new Date().toISOString().slice(0, 10);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  // As-of-today checking balance = opening + net of that account's txns ≤ today.
  const checkingToday = accounts.filter((a) => a.type === "checking").reduce((sum, a) => {
    let bal = Number(a.opening_balance) || 0;
    for (const t of transactions) if (t.account_id === a.id && t.txn_date <= asOf) bal += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
    return sum + bal;
  }, 0);

  const ytd = summary(transactions, { from: yearStart, to: asOf });
  const drift = computeDrift(transactions, planTargets, { asOf });
  const overall = overallStatus(drift);
  const warnings = drift.filter((d) => d.status !== "good");

  const st = STATUS[overall];
  root.className = "dash";
  root.innerHTML = `
    <div class="health">
      <div class="badge" style="background:${st.color}">${st.icon}</div>
      <div>
        <div class="h-title">${overall === "good" ? "Everything's on track" : `${warnings.length} thing${warnings.length === 1 ? "" : "s"} need attention`}</div>
        <div class="h-sub">${warnings.length ? warnings.map((w) => w.name).join(", ") : "Debts, savings goals and investments are all pacing to plan."}</div>
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
    ${driftSection("Debts", drift.filter((d) => d.kind === "debt_payoff"))}
    ${driftSection("Savings goals", drift.filter((d) => d.kind === "savings_goal"))}
    ${driftSection("Investments", drift.filter((d) => d.kind === "investment_cadence"))}
    <h2>Monthly spending (excl. credit-card &amp; transfers)</h2>
    <div class="chart-card"><svg id="dashSpend" width="100%" height="200" role="img" aria-label="Monthly spending"></svg></div>`;

  const spend = monthlySpend(transactions).filter((m) => m.month <= asOf.slice(0, 7));
  drawSpendChart(root.querySelector("#dashSpend"), spend.slice(-12));
}

const tile = (label, value, sub = "") =>
  `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ""}</div>`;

function driftSection(title, rows) {
  if (!rows.length) return "";
  return `<h2>${title}</h2>` + rows.map((r) => {
    const s = STATUS[r.status];
    const planLabel = r.kind === "savings_goal" ? fmt(r.planValue) : `${fmt(r.planValue)}${r.kind !== "debt_payoff" ? "/mo" : "/mo"}`;
    return `<div class="drift-row">
      <div class="st" style="background:${s.color}" title="${s.label}">${s.icon}</div>
      <div><span class="d-name">${r.name}</span><span class="d-owner">${r.owner}</span><div class="d-detail">${r.detail}</div></div>
      <div class="d-detail">plan ${planLabel}</div>
      <div class="d-vals">${r.kind === "savings_goal" ? fmt(r.actualValue) : fmt(r.actualValue) + "/mo"}</div>
    </div>`;
  }).join("");
}

function drawSpendChart(svg, data) {
  if (!svg || !data.length) return;
  const W = svg.clientWidth || 800, H = 200, padB = 24, padL = 44, padT = 10;
  const max = Math.max(1, ...data.map((d) => d.amount));
  const bw = (W - padL) / data.length;
  const y = (v) => padT + (H - padB - padT) * (1 - v / max);
  svg.innerHTML = "";
  // gridline + max label
  const gl = document.createElementNS(NS, "line");
  gl.setAttribute("x1", padL); gl.setAttribute("x2", W); gl.setAttribute("y1", y(max)); gl.setAttribute("y2", y(max));
  gl.setAttribute("stroke", "var(--line)"); svg.appendChild(gl);
  const ml = document.createElementNS(NS, "text");
  ml.setAttribute("class", "axis-label"); ml.setAttribute("x", 4); ml.setAttribute("y", y(max) + 4); ml.textContent = fmt(max);
  svg.appendChild(ml);
  data.forEach((d, i) => {
    const x = padL + i * bw + 3, h = (H - padB - padT) * (d.amount / max);
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("class", "bar"); rect.setAttribute("x", x); rect.setAttribute("y", y(d.amount));
    rect.setAttribute("width", Math.max(2, bw - 6)); rect.setAttribute("height", Math.max(0, h));
    rect.setAttribute("rx", 3); rect.setAttribute("fill", "#3987e5");
    const title = document.createElementNS(NS, "title"); title.textContent = `${d.month}: ${fmt2(d.amount)}`;
    rect.appendChild(title); svg.appendChild(rect);
    const lbl = document.createElementNS(NS, "text");
    lbl.setAttribute("class", "axis-label"); lbl.setAttribute("x", x + (bw - 6) / 2); lbl.setAttribute("y", H - 8);
    lbl.setAttribute("text-anchor", "middle"); lbl.textContent = d.month.slice(5);
    svg.appendChild(lbl);
  });
}
