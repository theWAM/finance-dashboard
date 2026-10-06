// The timeframe picker as a mountable control: funnel toggle + "Displaying …"
// chip + a collapsible panel holding the preset <select> and From/To inputs.
//
// Lifted out of the Ledger (Phase 10 / T1) so the Spending Plan — and anything
// after it — gets a picker that is identical by construction rather than by
// copy-paste. The markup and CSS are the Ledger's; the CSS ships inside this
// module (injected once, `tf-` prefixed, depending only on the host page's
// palette vars) so a page needs no stylesheet of its own to look right.
//
// Host-specific controls (the Ledger's Category/Source facets, its Clear
// button and row count) go in `slot`, which is `display: contents` — they lay
// out as if they were direct children of the filter row, exactly as before.

import {
  PRESETS, DEFAULT_PRESET, presetWindow, presetLabel,
  MONTH_PRESETS, DEFAULT_MONTH_PRESET, monthPresetWindow, monthOf, monthStart, monthEnd,
} from "./shared/timeframe.js";

const CSS = `
.tf-head { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.tf-summary { color: var(--text); font-weight: 600; }
.tf-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--panel-2); color: var(--muted); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 9px; cursor: pointer;
}
.tf-toggle:hover { border-color: var(--accent); color: var(--accent); }
.tf-toggle.active { border-color: var(--accent); color: var(--accent); background: var(--accent-weak); }
.tf-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .25s ease; }
.tf-panel.open { grid-template-rows: 1fr; margin-bottom: 14px; }
.tf-panel > .tf-filters { overflow: hidden; min-height: 0; margin-bottom: 0; }
.tf-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
.tf-filters > label { color: var(--muted); font-size: 12px; display: inline-flex; gap: 6px; align-items: center; }
.tf-filters select {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 10px; color: var(--text);
}
.tf-filters input[type="date"], .tf-filters input[type="month"] {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 9px; color: var(--text);
}
.tf-filters input[type="date"]:focus,
.tf-filters input[type="month"]:focus,
.tf-filters select:focus { outline: none; border-color: var(--accent); }
.tf-filters .btn { padding: 6px 12px; }
.tf-slot { display: contents; }
`;

function injectCSS() {
  if (document.getElementById("tf-css")) return;
  const style = document.createElement("style");
  style.id = "tf-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

const FUNNEL = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 3h13l-5 6v4l-3 1.5V9z" fill="currentColor"/></svg>`;

/**
 * Mount the control inside `host` (its contents are replaced).
 *
 * @param {Element} host
 * @param {object} [opts]
 * @param {() => {today?:string, cadence?:string, anchor?:string}} [opts.context]
 *        Resolved fresh on every preset application, so `3paychecks` always
 *        anchors on the person's *current* latest paycheck.
 * @param {(win:{from:string,to:string,preset:string}) => void} [opts.onChange]
 * @param {Array<object>} [opts.presets]      the preset list (default PRESETS; the
 *        Spending Plan passes MONTH_PRESETS)
 * @param {"day"|"month"} [opts.granularity]  `month` snaps every window to whole
 *        calendar months and turns From/To into <input type="month">, so a
 *        monthly budget can't be compared over a 42-day window
 * @param {string} [opts.defaultPreset]       initial preset (defaults per granularity)
 * @param {string} [opts.storageKey]          localStorage key for the open/closed state
 * @param {string} [opts.presetStorageKey]    if set, the chosen preset persists per page
 * @param {() => string} [opts.summaryExtra]  extra clause appended to the chip
 * @returns {object} the controller (see the methods assigned to `ctl` below)
 */
export function mountTimeframe(host, opts = {}) {
  injectCSS();
  const {
    context = () => ({}),
    onChange = () => {},
    granularity = "day",
    storageKey = "filtersOpen",
    presetStorageKey = null,
    summaryExtra = () => "",
  } = opts;

  // Month granularity swaps three things and nothing else: which preset list
  // the <select> offers, which resolver turns a key into dates, and whether
  // From/To speak days or months.
  const byMonth = granularity === "month";
  const presets = opts.presets || (byMonth ? MONTH_PRESETS : PRESETS);
  const resolveWindow = byMonth ? monthPresetWindow : presetWindow;
  const defaultPreset = opts.defaultPreset || (byMonth ? DEFAULT_MONTH_PRESET : DEFAULT_PRESET);
  // An <input type="month"> reads and writes "YYYY-MM"; the window it means is
  // that whole month, so From takes its 1st and To takes its last day.
  const fieldValue = (iso) => (byMonth ? monthOf(iso) : iso);
  const windowEdge = (v, edge) => (byMonth && v ? (edge === "to" ? monthEnd(v) : monthStart(v)) : v);

  host.innerHTML = `
    <div class="tf-head">
      <button type="button" class="tf-toggle" aria-pressed="false" title="Filters" aria-label="Toggle filters">${FUNNEL}</button>
      <span class="tf-summary">Timeframe</span>
    </div>
    <div class="tf-panel">
      <div class="tf-filters">
        <select class="tf-preset" title="Timeframe">
          ${presets.map((p) => `<option value="${p.key}"${p.hidden ? " hidden" : ""}>${p.label}</option>`).join("")}
        </select>
        <label>From <input type="${byMonth ? "month" : "date"}" class="tf-from"></label>
        <label>To <input type="${byMonth ? "month" : "date"}" class="tf-to"></label>
        <span class="tf-slot"></span>
      </div>
    </div>`;

  const q = (sel) => host.querySelector(sel);
  const toggle = q(".tf-toggle"), panel = q(".tf-panel"), inner = q(".tf-filters");
  const summary = q(".tf-summary"), selPreset = q(".tf-preset");
  const inFrom = q(".tf-from"), inTo = q(".tf-to");

  // The control's own copy of the window. The host keeps its own state (the
  // Ledger folds it into `state.filter`); this is what the chip renders from.
  let value = { from: "", to: "", preset: defaultPreset };

  function refreshSummary() {
    const label = value.preset === "custom"
      ? `${fieldValue(value.from) || "…"} – ${fieldValue(value.to) || "…"}`
      : presetLabel(value.preset);
    const extra = summaryExtra() || "";
    summary.textContent = `Displaying ${extra ? `${label} · ${extra}` : label}`;
  }

  function paint() {
    inFrom.value = fieldValue(value.from);
    inTo.value = fieldValue(value.to);
    selPreset.value = value.preset;
    refreshSummary();
  }

  function emit(silent) {
    paint();
    if (presetStorageKey) localStorage.setItem(presetStorageKey, value.preset);
    if (!silent) onChange({ ...value });
  }

  /** Apply a preset key, recomputing its window from the live context. */
  function applyPreset(key, { silent = false } = {}) {
    const { from, to } = resolveWindow(key, context());
    value = { from, to, preset: key };
    emit(silent);
    return { ...value };
  }

  /** Set an explicit window (preset defaults to `custom`). */
  function set({ from = "", to = "", preset = "custom" }, { silent = false } = {}) {
    value = { from, to, preset };
    emit(silent);
    return { ...value };
  }

  /** Clear to show-all — the Ledger's Clear semantics, not "back to default". */
  const clear = (o) => set({ from: "", to: "", preset: "all" }, o);

  // `animate: false` opens with no slide -- used for the initial mount, where
  // the panel was just created by innerHTML and so has no before-change style
  // for the grid-template-rows transition to run from.
  let revealTimer = null;
  function setOpen(open, { animate = true } = {}) {
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-pressed", String(open));
    clearTimeout(revealTimer);
    if (open) {
      panel.classList.add("open");
      // Reveal overflow only after the slide finishes, so dropdowns in the slot
      // (the Ledger's facet panels) aren't clipped mid-animation. This runs off
      // a timer rather than `transitionend`, because on a mount that starts open
      // no transition -- and therefore no `transitionend` -- ever fires, which
      // used to leave the slot clipped for the life of the page and swallow the
      // Category/Source panels entirely.
      if (!animate) inner.style.overflow = "visible";
      else revealTimer = setTimeout(() => {
        if (panel.classList.contains("open")) inner.style.overflow = "visible";
      }, 300); // just past the .25s grid-template-rows transition
    } else {
      inner.style.overflow = "hidden"; // clip again before sliding up
      panel.classList.remove("open");
    }
    if (storageKey) localStorage.setItem(storageKey, open ? "1" : "0");
  }

  selPreset.addEventListener("change", (e) => applyPreset(e.target.value));
  inFrom.addEventListener("change", (e) => set({ from: windowEdge(e.target.value, "from"), to: value.to }));
  inTo.addEventListener("change", (e) => set({ from: value.from, to: windowEdge(e.target.value, "to") }));
  toggle.addEventListener("click", () => setOpen(!panel.classList.contains("open")));

  setOpen(localStorage.getItem(storageKey) === "1", { animate: false }); // default collapsed

  const ctl = {
    el: host,
    slot: q(".tf-slot"),
    value: () => ({ ...value }),
    applyPreset, set, clear, setOpen, refreshSummary,
    isOpen: () => panel.classList.contains("open"),
  };

  // Restore a persisted preset if the page asked for that, else the default.
  const stored = presetStorageKey ? localStorage.getItem(presetStorageKey) : null;
  const initial = stored && presets.some((p) => p.key === stored) ? stored : defaultPreset;
  if (initial === "custom") paint(); else applyPreset(initial, { silent: true });

  return ctl;
}
