// Segmented "Plan targets | Spending Plan" switcher shown at the top of both
// Plan sub-views, so either page links straight to the other (Phase 10 / T4a,
// resolved decision #1). CSS ships inside the module, same pattern as
// timeframe-ui.js and nav-plan.js.
//
// Renders nothing (and hides `host`) when fewer than two views are passed in —
// the hook T6 needs for the published site, where Spending Plan is a
// top-level link with no sibling Plan view to switch to.

import { PLAN_VIEWS } from "./nav-plan.js";

const CSS = `
.view-switch { display: inline-flex; gap: 2px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: 3px; }
.view-switch a { color: var(--muted); text-decoration: none; padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.view-switch a:hover { color: var(--text); }
.view-switch a.active { color: var(--on-accent); background: var(--accent); }
`;

function injectCSS() {
  if (document.getElementById("view-switch-css")) return;
  const style = document.createElement("style");
  style.id = "view-switch-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * @param {Element} host
 * @param {object} [opts]
 * @param {"plan"|"csp"} opts.active
 * @param {Array<{key,href,label}>} [opts.views]  defaults to both Plan sub-views
 */
export function mountViewSwitch(host, { active, views = PLAN_VIEWS } = {}) {
  if (!host) return;
  if (views.length < 2) { host.hidden = true; host.innerHTML = ""; return; }
  injectCSS();
  host.hidden = false;
  host.className = "view-switch";
  host.innerHTML = views.map((v) => `<a href="${v.href}"${v.key === active ? ' class="active"' : ""}>${v.label}</a>`).join("");
}
