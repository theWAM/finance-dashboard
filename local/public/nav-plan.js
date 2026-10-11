// Shared "Plan" nav dropdown — built once so all five local pages (Ledger,
// This Paycheck, Plan, Spending Plan, Dashboard) agree on how the Plan nav
// item exposes its two sub-views, instead of five drifting copies of the same
// markup (Phase 10 / T4a, resolved decision #1).
//
// CSS ships inside the module (same pattern as timeframe-ui.js) so no page
// needs its own stylesheet to render it correctly. On a published page the
// read-only shim (docs/mock-api.js) rewrites `.nav` to a fixed link set with
// no Plan item at all — mountPlanNav() finds nothing to replace and quietly
// no-ops, so it's safe to call unconditionally from every page's entry script.

export const PLAN_VIEWS = [
  { key: "plan", href: "./plan.html", label: "Plan targets" },
  { key: "csp", href: "./csp.html", label: "Spending Plan" },
];

const CSS = `
.nav-plan { position: relative; display: inline-flex; }
.nav-plan > a { display: inline-flex; align-items: center; gap: 4px; }
.nav-plan > a .car { font-size: 9px; opacity: .7; }
.nav-plan-panel {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 9;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 6px; min-width: 170px; box-shadow: var(--shadow-sm);
  display: none;
}
.nav-plan-panel a {
  display: block; color: var(--muted); text-decoration: none; padding: 8px 10px;
  border-radius: 6px; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.nav-plan-panel a:hover { color: var(--text); background: var(--panel-2); }
.nav-plan-panel a.active { color: var(--text); background: var(--accent-weak); }
.nav-plan:hover .nav-plan-panel,
.nav-plan:focus-within .nav-plan-panel,
.nav-plan.open .nav-plan-panel { display: block; }
`;

function injectCSS() {
  if (document.getElementById("nav-plan-css")) return;
  const style = document.createElement("style");
  style.id = "nav-plan-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Replace the static Plan `<a>` inside `navEl` with a dropdown listing both
 * Plan sub-views. Opens on hover/focus-within (mouse/keyboard); a tap toggles
 * it on touch devices, which get no `:hover`.
 *
 * @param {Element} navEl
 * @param {object} [opts]
 * @param {"plan"|"csp"|null} [opts.view]  which sub-view this page is, so the
 *        trigger and the matching panel link render as active. `null` for
 *        pages that aren't a Plan sub-view (Ledger, This Paycheck, Dashboard).
 */
export function mountPlanNav(navEl, { view = null } = {}) {
  if (!navEl) return;
  // Only the static "Plan" link is ever a literal "./plan.html" href locally —
  // no page's static nav points at "./csp.html" directly. Matching only this
  // href (not csp.html too) matters once the published nav has a top-level
  // "Spending Plan" link to "./csp.html": that link must stay a plain link,
  // not get wrapped into a dropdown pointing at a plan.html that doesn't exist
  // on the published site.
  const old = navEl.querySelector('a[href="./plan.html"]');
  if (!old) return; // published nav (docs/mock-api.js) has no Plan item — nothing to do
  injectCSS();

  const wrap = document.createElement("span");
  wrap.className = "nav-plan";

  const trigger = document.createElement("a");
  trigger.href = "./plan.html";
  if (view) trigger.className = "active";
  trigger.innerHTML = `Plan <span class="car">▾</span>`;
  trigger.addEventListener("click", (e) => {
    if (matchMedia("(hover: none)").matches) { e.preventDefault(); wrap.classList.toggle("open"); }
  });

  const panel = document.createElement("div");
  panel.className = "nav-plan-panel";
  panel.innerHTML = PLAN_VIEWS.map(
    (v) => `<a href="${v.href}"${v.key === view ? ' class="active"' : ""}>${v.label}</a>`,
  ).join("");

  wrap.append(trigger, panel);
  old.replaceWith(wrap);

  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) wrap.classList.remove("open"); });
}
