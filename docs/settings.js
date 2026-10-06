// Global settings: the gear fixed in the bottom-left corner, the panel that
// grows out of that corner over a scrim, and the two preferences that live in
// it — the color theme and low-power rendering.
//
// Imported by every page (local and published). It owns all of its own markup;
// the CSS lives in theme.css so it isn't duplicated into each page's inline
// <style>.
//
// The two preferences are deliberately NOT the same kind of thing:
//
//   theme      belongs to the PERSON. Stored on their `people` row, so it rides
//              snapshot.json and the LWW merge — switching person switches
//              theme, and a Publish carries your choice to the other machine.
//              Written through the moment you pick it (no Save, no Publish
//              needed to make it stick locally) and mirrored into localStorage
//              so theme-boot.js can paint it before the first frame.
//              theme-boot.js owns the keys and the resolution rule; this module
//              just calls into it.
//   lowPower   belongs to the MACHINE. Pure localStorage — it describes what
//              this computer can render, not who is using it, so it never
//              enters the snapshot.
//
// Low power lives here but is consumed by the Ledger (app.js), which owns the
// lighter renderer. The whole contract between them is one event: this module
// writes the flag, toggles `body.lowpower`, and dispatches `lowpowerchange`;
// app.js listens and re-renders. Nothing here knows the Ledger exists, and the
// four pages with no lighter renderer simply never listen.

const THEMES = [
  { id: "dark", label: "Dark", swatch: ["#0f1115", "#1e222b", "#4f8cff", "#46c08a"] },
  { id: "peach", label: "Peach", swatch: ["#fff8ea", "#fff1e2", "#d7f0e7", "#e8a07a"] },
];

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode — session-only */ } };

// theme-boot.js is a blocking <head> script on every page, so it is always here
// by the time this module runs. Guard anyway rather than throw: a missing boot
// script should cost the theme, not the whole settings panel.
const boot = window.__theme ?? {
  person: () => "", cached: () => null, apply: (id) => { document.documentElement.dataset.theme = id || "dark"; },
  cache: () => {}, seen: () => null, markSeen: () => {}, resolve: (_p, stored) => stored || "dark",
};

// What the profile itself carries. A page that already has the people list can
// hand it over instead of making this module fetch for it: define
// `window.__profileThemes` (an id → theme map) before this module loads and keep
// it current. The published dashboard does exactly that — it reads people
// straight out of snapshot.json and has no /api/ shim, so without this it would
// 404 on every load.
async function storedTheme(person) {
  if (window.__profileThemes) return window.__profileThemes[person] || null;
  try {
    const { people } = await (await fetch("/api/people")).json();
    return people?.find((p) => p.id === person)?.theme || null;
  } catch {
    return null; // offline, or a page with no API: this machine's cache stands
  }
}

// Mirror the chosen theme into this machine's cache for that profile so the next
// pre-paint is instant, then write it through to the profile itself. The write
// 404s on the read-only published site — that's expected, and it's exactly what
// keeps a reader's local pick from pretending to be the owner's choice (see the
// resolution rule in theme-boot.js).
async function applyTheme(id, person) {
  boot.apply(id);
  boot.cache(person, id);
  if (!person) return;            // nobody chosen yet — cache only
  try {
    const res = await fetch(`/api/people/${encodeURIComponent(person)}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: id }),
    });
    if (res.ok) boot.markSeen(person, id); // the profile really carries it now
  } catch { /* offline or read-only: the cache above already holds it */ }
}

function applyLowPower(on, { notify = true } = {}) {
  document.body.classList.toggle("lowpower", on);
  write("lowPower", on ? "1" : "0");
  if (notify) window.dispatchEvent(new CustomEvent("lowpowerchange", { detail: { on } }));
}

const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3.2"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`;

function mount() {
  if (document.querySelector(".settings-wrap")) return;

  // theme-boot.js already painted this machine's cached answer for the current
  // profile; that's what the panel opens showing. The profile's own stored value
  // needs a fetch, so it reconciles just below, after the panel exists.
  let person = boot.person();
  let theme = boot.cached(person) || "dark";
  const lowPower = read("lowPower", "0") === "1";
  applyLowPower(lowPower, { notify: false });

  const wrap = document.createElement("div");
  wrap.className = "settings-wrap";
  wrap.dataset.open = "false";
  wrap.innerHTML = `
    <button class="settings-fab" type="button" aria-expanded="false" aria-label="Settings" title="Settings">${GEAR}</button>
    <div class="settings-scrim" hidden></div>
    <div class="settings-panel" role="dialog" aria-modal="true" aria-label="Settings" hidden>
      <div class="settings-head">
        <h2>Settings</h2>
        <button class="settings-close" type="button" aria-label="Close settings">✕</button>
      </div>
      <div class="settings-group">
        <h3>Appearance</h3>
        <div class="theme-seg" role="radiogroup" aria-label="Color theme">
          ${THEMES.map((t) => `
            <button class="theme-opt" type="button" role="radio" data-theme="${t.id}" aria-checked="${t.id === theme}">
              <span class="sw">${t.swatch.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
              <span>${t.label}</span>
            </button>`).join("")}
        </div>
      </div>
      <div class="settings-group">
        <h3>Performance</h3>
        <div class="settings-row">
          <span class="lbl" id="lpLabel">Low power</span>
          <button class="settings-switch" type="button" role="switch" aria-checked="${lowPower}" aria-labelledby="lpLabel"><span class="knob"></span></button>
        </div>
        <p class="settings-hint">Lighter ledger rendering for slower machines — cells become
        plain text and upgrade to an input only while you edit one. This computer only.</p>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const fab = wrap.querySelector(".settings-fab");
  const scrim = wrap.querySelector(".settings-scrim");
  const panel = wrap.querySelector(".settings-panel");
  const closeBtn = wrap.querySelector(".settings-close");
  const lpSwitch = wrap.querySelector(".settings-switch");

  // `hidden` is toggled a frame apart from `data-open` so the panel has a
  // layout box to animate from/to instead of popping in at full size.
  let open = false;
  function setOpen(next) {
    if (next === open) return;
    open = next;
    fab.setAttribute("aria-expanded", String(open));
    if (open) {
      scrim.hidden = panel.hidden = false;
      requestAnimationFrame(() => { wrap.dataset.open = "true"; });
      closeBtn.focus();
    } else {
      wrap.dataset.open = "false";
      const done = () => { if (!open) { scrim.hidden = panel.hidden = true; } };
      panel.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 260); // transitionend never fires under reduced motion
      fab.focus();
    }
  }

  fab.addEventListener("click", () => setOpen(true));
  closeBtn.addEventListener("click", () => setOpen(false));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) setOpen(false); });
  // Modal means modal: Tab cycles inside the panel instead of walking the page
  // behind the scrim.
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = [...panel.querySelectorAll("button:not([disabled])")];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Reflect a theme in the panel without writing it (used when a person switch
  // or a fetched profile changes it under us).
  function showTheme(id) {
    theme = id;
    for (const o of wrap.querySelectorAll(".theme-opt")) o.setAttribute("aria-checked", String(o.dataset.theme === id));
  }

  for (const opt of wrap.querySelectorAll(".theme-opt")) {
    opt.addEventListener("click", () => {
      showTheme(opt.dataset.theme);
      applyTheme(opt.dataset.theme, person);
    });
  }

  // Reconcile this machine's cache against what the profile actually carries.
  // Runs on load and on every person switch; /api/people serves the DB locally
  // and the snapshot on the published site, so this is one code path for both.
  async function syncProfileTheme() {
    person = boot.person();
    if (!person) { showTheme(boot.cached("") || "dark"); return; }
    const stored = await storedTheme(person);
    const resolved = boot.resolve(person, stored);
    boot.apply(resolved);
    boot.cache(person, resolved);
    // Record what the profile carried, so the next load can tell "unchanged"
    // from "changed elsewhere" — that distinction is the whole resolution rule.
    if (stored) boot.markSeen(person, stored);
    showTheme(resolved);
  }
  syncProfileTheme();

  // Pages that switch person WITHOUT reloading say so with this event; the ones
  // that reload are covered by theme-boot.js on the way in.
  window.addEventListener("userchange", syncProfileTheme);

  lpSwitch.addEventListener("click", () => {
    const on = lpSwitch.getAttribute("aria-checked") !== "true";
    lpSwitch.setAttribute("aria-checked", String(on));
    applyLowPower(on);
  });
}

// Mount synchronously. As a deferred module this runs after parsing, so <body>
// exists — and it has to be `body.lowpower` before app.js's first render, which
// a DOMContentLoaded handler would miss (that fires after every deferred
// module, app.js included). The listener is only a fallback for a page that
// somehow includes this early.
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount);
