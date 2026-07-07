// Local Dashboard — pulls the household's people, accounts, transactions and
// plan targets from the API and hands them to the shared renderer. The view is
// scoped to the current person (their + shared items), and plan targets can be
// edited inline by clicking the "plan …" tag.

import { renderDashboard } from "/shared/dashboard-render.js";

const currentUser = new URLSearchParams(location.search).get("user") || localStorage.getItem("currentUser") || "";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.json();
}

let planTargets = [];

async function load() {
  const root = document.querySelector("#dashRoot");
  try {
    const [{ people }, { accounts }, { plan_targets }] = await Promise.all([
      api("/api/people"), api("/api/accounts"), api("/api/plan-targets"),
    ]);
    planTargets = plan_targets;
    const transactions = [];
    for (const a of accounts) {
      const { transactions: rows } = await api(`/api/transactions?account_id=${encodeURIComponent(a.id)}`);
      transactions.push(...rows);
    }
    renderDashboard(root, {
      people, accounts, transactions, planTargets, currentUser,
      onEditPlan: async (id, field, value) => {
        const pt = planTargets.find((p) => p.id === id);
        if (!pt) return;
        const data = { ...(pt.data || {}), [field]: value };
        await api(`/api/plan-targets/${id}`, { method: "PATCH", body: { data } });
        await load(); // re-fetch + re-render with the saved value
      },
    });
  } catch (e) {
    root.innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`;
  }
}

load();
