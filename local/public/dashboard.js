// Local Dashboard — pulls the household's accounts, transactions and plan
// targets from the API and hands them to the shared renderer.

import { renderDashboard } from "/shared/dashboard-render.js";

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

(async function load() {
  try {
    const [{ accounts }, { plan_targets }] = await Promise.all([api("/api/accounts"), api("/api/plan-targets")]);
    const transactions = [];
    for (const a of accounts) {
      const { transactions: rows } = await api(`/api/transactions?account_id=${encodeURIComponent(a.id)}`);
      transactions.push(...rows);
    }
    renderDashboard(document.querySelector("#dashRoot"), { accounts, transactions, planTargets: plan_targets });
  } catch (e) {
    document.querySelector("#dashRoot").innerHTML = `<p class="muted">Failed to load: ${e.message}</p>`;
  }
})();
