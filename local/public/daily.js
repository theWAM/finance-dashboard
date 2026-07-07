// Daily Check — reconcile the ledger's projected balance against the real bank
// balance for the current person's checking account. "Correct" writes a single
// adjusting transaction (dated today) so the ledger matches reality going forward.

const $ = (s) => document.querySelector(s);
const fmt = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const params = new URLSearchParams(location.search);
const TODAY = new Date().toISOString().slice(0, 10);

const state = {
  people: [],
  currentUser: params.get("user") || localStorage.getItem("currentUser") || null,
  account: null,
  projected: 0,
  actual: null,
};

async function api(path, opts) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts?.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) { const m = await res.json().catch(() => ({})); throw new Error(m.error || `${res.status} ${res.statusText}`); }
  return res.status === 204 ? null : res.json();
}
let toastTimer;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 1800); }

const initials = (n) => (n || "?").trim().slice(0, 1).toUpperCase();
const currentPerson = () => state.people.find((p) => p.id === state.currentUser) || null;

function renderUserChip() {
  const chip = $("#userChip"); const p = currentPerson();
  if (!p || state.people.length <= 1) { chip.hidden = true; return; }
  $("#userAvatar").innerHTML = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  $("#userName").textContent = p.name;
  chip.hidden = false;
}
function showWho() {
  const box = $("#whoOptions"); box.innerHTML = "";
  for (const p of state.people) {
    const b = document.createElement("button"); b.className = "who-card";
    b.innerHTML = (p.avatar ? `<img class="who-photo" src="${p.avatar}" alt="${p.name}">` : `<span class="who-photo initials">${initials(p.name)}</span>`) + `<span class="name">${p.name}</span>`;
    b.onclick = () => { localStorage.setItem("currentUser", p.id); location.href = "./daily.html"; };
    box.appendChild(b);
  }
  $("#who").hidden = false;
}
$("#userChip").addEventListener("click", showWho);

// Projected balance = opening + net of every transaction dated on/before today.
async function computeProjected() {
  const { transactions } = await api(`/api/transactions?account_id=${encodeURIComponent(state.account.id)}`);
  let bal = Number(state.account.opening_balance) || 0;
  for (const t of transactions) if (t.txn_date <= TODAY) bal += (Number(t.deposit) || 0) - (Number(t.withdrawal) || 0);
  return round2(bal);
}

function render() {
  const person = currentPerson();
  $("#cardTitle").textContent = `Daily Check — ${state.account?.name || person?.name || ""}`;
  $("#asOf").textContent = `As of ${TODAY}`;
  $("#projected").textContent = fmt(state.projected);

  const hasActual = state.actual !== null && state.actual !== "" && !Number.isNaN(Number(state.actual));
  const diff = hasActual ? round2(Number(state.actual) - state.projected) : null;
  const diffEl = $("#diff");
  diffEl.textContent = hasActual ? fmt(diff) : "—";
  diffEl.classList.toggle("pos", hasActual && diff > 0);
  diffEl.classList.toggle("neg", hasActual && diff < 0);

  const note = $("#note");
  const btn = $("#correctBtn");
  if (!hasActual) {
    note.textContent = "Enter your current bank balance to reconcile.";
    btn.disabled = true;
  } else if (Math.abs(diff) < 0.01) {
    note.textContent = "✓ Your ledger matches your bank exactly — nothing to correct.";
    btn.disabled = true;
  } else if (diff > 0) {
    note.textContent = `Your bank has ${fmt(diff)} more than the ledger expects. Correcting adds a ${fmt(diff)} deposit dated ${TODAY} so the ledger matches.`;
    btn.disabled = false;
  } else {
    note.textContent = `Your bank has ${fmt(-diff)} less than the ledger expects. Correcting adds a ${fmt(-diff)} withdrawal dated ${TODAY} so the ledger matches.`;
    btn.disabled = false;
  }
}

$("#actual").addEventListener("input", (e) => { state.actual = e.target.value; render(); });

$("#correctBtn").addEventListener("click", async () => {
  const diff = round2(Number(state.actual) - state.projected);
  if (Math.abs(diff) < 0.01) return;
  $("#correctBtn").disabled = true;
  try {
    await api("/api/transactions", {
      method: "POST",
      body: {
        account_id: state.account.id, owner: state.currentUser, txn_date: TODAY,
        description: "Adjustment", source: "Daily Check reconciliation",
        deposit: diff > 0 ? diff : 0, withdrawal: diff < 0 ? -diff : 0,
      },
    });
    state.projected = await computeProjected(); // now equals actual
    toast(`Corrected — added a ${fmt(Math.abs(diff))} adjustment`);
    render();
  } catch (e) { toast("Error: " + e.message); render(); }
});

(async function init() {
  try {
    state.people = (await api("/api/people")).people;
    if (state.people.length <= 1) state.currentUser = state.people[0]?.id ?? null;
    else if (!state.people.some((p) => p.id === state.currentUser)) { showWho(); return; }
    renderUserChip();

    const { accounts } = await api("/api/accounts");
    state.account = accounts.find((a) => a.owner === state.currentUser && a.type === "checking")
                 || accounts.find((a) => a.owner === state.currentUser) || null;
    if (!state.account) { $("main").innerHTML = `<div class="card">No checking account for this person yet.</div>`; return; }

    state.projected = await computeProjected();
    render();
  } catch (e) {
    $("main").innerHTML = `<div class="card">Failed to load: ${e.message}</div>`;
  }
})();
