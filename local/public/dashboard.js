// Local Dashboard — pulls the household's people, accounts, transactions and
// plan targets from the API and hands them to the shared renderer. The view is
// scoped to the current person (their + shared items) and can be switched
// between people from the header; plan targets can be edited inline by clicking
// the "plan …" tag.

import { renderDashboard } from "/shared/dashboard-render.js";

let currentUser = new URLSearchParams(location.search).get("user") || localStorage.getItem("currentUser") || "";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.json();
}

const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
let people = [], accounts = [], transactions = [], planTargets = [];

function renderSwitch() {
  const el = document.querySelector("#userSwitch");
  if (!el || people.length <= 1) { if (el) el.innerHTML = ""; return; } // one person: nothing to switch
  el.innerHTML = `<span class="lbl">View</span>`;
  const mk = (id, label, avatar) => {
    const b = document.createElement("button");
    b.className = (currentUser === id ? "on " : "") + (id ? "" : "everyone");
    b.innerHTML = (id ? `<span class="av">${avatar ? `<img src="${avatar}" alt="">` : initials(label)}</span>` : "") + label;
    b.onclick = () => {
      currentUser = id;
      if (id) localStorage.setItem("currentUser", id); else localStorage.removeItem("currentUser");
      draw();
      renderSwitch();
    };
    el.appendChild(b);
  };
  mk("", "Everyone");
  for (const p of people) mk(p.id, p.name, p.avatar);
}

function draw() {
  renderDashboard(document.querySelector("#dashRoot"), {
    people, accounts, transactions, planTargets, currentUser,
    onEditPlan: async (id, field, value) => {
      const pt = planTargets.find((p) => p.id === id);
      if (!pt) return;
      const data = { ...(pt.data || {}), [field]: value };
      await api(`/api/plan-targets/${id}`, { method: "PATCH", body: { data } });
      await load(); // re-fetch + re-render with the saved value
    },
  });
}

async function load() {
  const root = document.querySelector("#dashRoot");
  try {
    const [pRes, aRes, ptRes] = await Promise.all([
      api("/api/people"), api("/api/accounts"), api("/api/plan-targets"),
    ]);
    people = pRes.people; accounts = aRes.accounts; planTargets = ptRes.plan_targets;
    transactions = [];
    for (const a of accounts) {
      const { transactions: rows } = await api(`/api/transactions?account_id=${encodeURIComponent(a.id)}`);
      transactions.push(...rows);
    }
    renderSwitch();
    draw();
  } catch (e) {
    root.innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`;
  }
}

load();
