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
//   theme      belongs to the PERSON — and it is a PAIR, {family, mode}, where
//              mode is light | dark | auto. Stored on their `people` row, so it
//              rides snapshot.json and the LWW merge — switching person switches
//              theme, and a Publish carries your choice to the other machine.
//              Written through the moment you pick it (no Save, no Publish
//              needed to make it stick locally) and mirrored into localStorage
//              so theme-boot.js can paint it before the first frame.
//              theme-boot.js owns the keys, the `auto` resolution and the
//              adopt-or-keep rule; this module just calls into it, which is
//              what keeps pre-paint and post-load from drifting apart.
//   lowPower   belongs to the MACHINE. Pure localStorage — it describes what
//              this computer can render, not who is using it, so it never
//              enters the snapshot.
//
// Low power lives here but is consumed by the Ledger (app.js), which owns the
// lighter renderer. The whole contract between them is one event: this module
// writes the flag, toggles `body.lowpower`, and dispatches `lowpowerchange`;
// app.js listens and re-renders. Nothing here knows the Ledger exists, and the
// four pages with no lighter renderer simply never listen.

// The Appearance control is TWO AXES, not a list of variants: six family tiles
// and a three-way mode control, coupled so a pick on either keeps the other
// half. Twelve variants as twelve tiles would not fit a 320px panel and would
// also be the wrong shape — "Bordeaux" and "light" are independent choices.
//
// Neither list is written here. `window.__theme.themes` is the one list that
// decides what theme.css can render, and theme-boot.js rejects a family it
// doesn't know rather than painting half a variant — so a tile built from any
// other list could silently do nothing. Labels are the ids title-cased, which
// is exactly what the families are named.
const label = (s) => s[0].toUpperCase() + s.slice(1);
// Keep in step with .theme-grid's grid-template-columns: it is what Up/Down
// move by, so the arrows walk the grid that is on screen.
const GRID_COLS = 3;

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode — session-only */ } };

// theme-boot.js is a blocking <head> script on every page, so it is always here
// by the time this module runs. Guard anyway rather than throw: a missing boot
// script should cost the theme, not the whole settings panel. The guard mirrors
// just enough of theme-boot.js to paint a WHOLE variant: both
// attributes, and `auto` collapsed here rather than left to CSS. A half-applied
// variant matches nothing in theme.css and silently renders slate-dark, which
// would make picking Peach look like a no-op.
const FALLBACK = { family: "slate", mode: "dark" };
const fallbackBoot = {
  // All six, because this list is what the family grid is built from — a
  // shorter one here would hide four families rather than degrade gracefully.
  // Unlike theme-boot.js, this shim does not validate against them: it is only
  // reached when the real boot script is missing, and offering a tile that
  // paints nothing is the lesser failure.
  themes: {
    families: ["slate", "peach", "bordeaux", "lagoon", "orchid", "thicket"],
    modes: ["light", "dark", "auto"],
  },
  DEFAULT: FALLBACK,
  parse: (v) => {
    if (!v) return null;
    const [family, mode] = typeof v === "object" ? [v.family ?? v.theme, v.mode] : String(v).split(":");
    return family ? { family, mode: mode || FALLBACK.mode } : null;
  },
  serialize: (p) => (p ? `${p.family}:${p.mode}` : null),
  same: (a, b) => fallbackBoot.serialize(fallbackBoot.parse(a)) === fallbackBoot.serialize(fallbackBoot.parse(b)),
  apply: (v) => {
    const p = fallbackBoot.parse(v) ?? FALLBACK;
    const mode = p.mode === "auto"
      ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : p.mode;
    Object.assign(document.documentElement.dataset, { theme: p.family, mode });
    return p;
  },
  person: () => "", cached: () => null, cache: () => {}, seen: () => null, markSeen: () => {},
  resolve: (_p, stored) => fallbackBoot.parse(stored) ?? FALLBACK,
  resolvedMode: () => document.documentElement.dataset.mode || FALLBACK.mode,
  systemMode: () => (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
};
const boot = window.__theme ?? fallbackBoot;

// What the profile itself carries, in the shape boot.parse takes: the two
// columns as one pair (T41 populates `theme_mode`; a pre-T41 snapshot or a
// row this backfill hasn't reached yet still has only a family, and parse
// migrates it to that family's native mode per decision #36).
const rowPair = (row) => (row?.theme ? { family: row.theme, mode: row.theme_mode } : null);

// A page that already has the people list can hand it over instead of making
// this module fetch for it: define `window.__profileThemes` (an id → stored
// pair map — a {family, mode}/row object, or a legacy single string) before this
// module loads and keep it current. The published dashboard does exactly that —
// it reads people straight out of snapshot.json and has no /api/ shim, so
// without this it would 404 on every load.
async function storedPair(person) {
  if (window.__profileThemes) return window.__profileThemes[person] || null;
  try {
    const { people } = await (await fetch("/api/people")).json();
    return rowPair(people?.find((p) => p.id === person));
  } catch {
    return null; // offline, or a page with no API: this machine's cache stands
  }
}

// Mirror the chosen theme into this machine's cache for that profile so the next
// pre-paint is instant, then write it through to the profile itself. The write
// 404s on the read-only published site — that's expected, and it's exactly what
// keeps a reader's local pick from pretending to be the owner's choice (see the
// resolution rule in theme-boot.js).
// Bumped per write so only the LATEST one may advance last-seen. Arrowing
// across the family grid selects as it moves (the radio pattern), so a burst of
// writes is normal and their responses can land out of order; recording an
// earlier row as "what the profile carried" would make the next load adopt a
// theme the person has already arrowed past. The paint and the cache are
// synchronous and therefore already in order.
let writeSeq = 0;

async function applyTheme(pair, person) {
  boot.apply(pair);
  boot.cache(person, pair);
  if (!person) return;            // nobody chosen yet — cache only
  const seq = ++writeSeq;
  try {
    // One route, one write: both fields go in a single request, because
    // adopt-as-a-unit is only true if the two can't half-apply. Both axes go
    // through here — picking a family sends the current mode along with it and
    // picking a mode sends the current family, so neither can land alone.
    const res = await fetch(`/api/people/${encodeURIComponent(person)}/theme`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: pair.family, mode: pair.mode }),
    });
    if (!res.ok) return;          // read-only published site: the cache stands
    // Mark seen from the ROW the write echoes back, not from what we sent:
    // `themeSeen` means "what the profile carried when we last looked", and
    // since T41 the echo carries the whole pair, so this is exact.
    const row = await res.json().then((r) => r.person).catch(() => null);
    if (seq !== writeSeq) return; // a later pick already landed; it owns `seen`
    boot.markSeen(person, rowPair(row) ?? pair);
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
  let pair = boot.cached(person) ?? boot.DEFAULT;
  const lowPower = read("lowPower", "0") === "1";
  applyLowPower(lowPower, { notify: false });

  const families = boot.themes.families;
  const modes = boot.themes.modes;
  // What <html> is actually painted as, which for a stored `auto` is the OS
  // answer theme-boot.js already resolved. The swatches open showing this.
  const resolved0 = boot.resolvedMode?.() || pair.mode;

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
        <div class="theme-grid" role="radiogroup" aria-label="Theme family">
          ${families.map((f) => `
            <button class="theme-opt" type="button" role="radio" data-family="${f}"
                    aria-checked="${f === pair.family}" tabindex="${f === pair.family ? 0 : -1}">
              <span class="sw" aria-hidden="true"><span class="swv" data-theme="${f}" data-mode="${resolved0}"><i></i><i></i><i></i><i></i></span></span>
              <span>${label(f)}</span>
            </button>`).join("")}
        </div>
        <div class="mode-seg" role="radiogroup" aria-label="Light or dark">
          ${modes.map((m) => `
            <button class="mode-opt" type="button" role="radio" data-mode="${m}"
                    aria-checked="${m === pair.mode}" tabindex="${m === pair.mode ? 0 : -1}">${label(m)}</button>`).join("")}
        </div>
        <p class="settings-hint theme-hint"></p>
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
  const famBtns = [...wrap.querySelectorAll(".theme-opt")];
  const modeBtns = [...wrap.querySelectorAll(".mode-opt")];
  const themeHint = wrap.querySelector(".theme-hint");

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
    // `:not([tabindex="-1"])` is what keeps the two radiogroups at one tab stop
    // each: inside a group the arrows move, and Tab leaves it.
    const f = [...panel.querySelectorAll('button:not([disabled]):not([tabindex="-1"])')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // One radiogroup's worth of state: aria-checked, plus a roving tabindex so
  // the group is a single tab stop and the arrows move within it. A value no
  // button offers checks nothing rather than lying about which one is on — and
  // then the first button stays reachable so the group can't become a dead end.
  function check(btns, isOn) {
    let any = false;
    for (const b of btns) {
      const on = isOn(b);
      any = any || on;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (!any && btns[0]) btns[0].tabIndex = 0;
  }

  // The six swatches, retinted to the mode now PAINTED — so a tile shows what
  // picking it would actually give you rather than that family's native mode,
  // and picking Light repaints all six. Under `auto` this moves when the OS
  // does and the stored pair doesn't, which is why it isn't part of showPair.
  function showResolved(resolvedMode) {
    for (const b of famBtns) b.querySelector(".swv").dataset.mode = resolvedMode;
    showAutoLine();
  }

  // The Auto line — and the one thing in this panel that reports the OS answer
  // rather than what is painted. The two differ whenever an explicit mode is
  // selected: the page is dark because the person said dark, while Auto would
  // hand them light. Printing the painted mode here would make Auto read as a
  // synonym for the mode already on, which is the specific way this control can
  // lie. `auto` is also the only option whose effect is invisible until the OS
  // changes, so saying what it follows is the whole job of the sentence.
  function showAutoLine() {
    const os = boot.systemMode?.() || boot.resolvedMode?.() || pair.mode;
    const now = `<b>${os === "dark" ? "dark" : "light"}</b>`;
    themeHint.innerHTML = pair.mode === "auto"
      ? `Following this computer's light / dark setting — ${now} right now.`
      : `Auto follows this computer's light / dark setting — ${now} right now.`;
  }

  // Reflect a pair in the panel without writing it (a person switch, a fetched
  // profile, or our own pick). Reads the resolved mode off <html>, so call it
  // AFTER the pair has been applied — only theme-boot.js knows what `auto`
  // comes out as, and duplicating that rule here is what decision #29 forbids.
  function showPair(next) {
    pair = next;
    check(famBtns, (b) => b.dataset.family === next.family);
    check(modeBtns, (b) => b.dataset.mode === next.mode);
    showResolved(boot.resolvedMode?.() || next.mode);
  }

  // Both axes land here, and both send the WHOLE pair: a family pick keeps the
  // current mode (including `auto`), a mode pick keeps the current family.
  // parse() returns null for a family theme.css can't render, so a tile added
  // ahead of its variant does nothing rather than painting half of one.
  function pick(part) {
    const next = boot.parse({ ...pair, ...part });
    if (!next) return;
    applyTheme(next, person);   // paints synchronously, writes in the background
    showPair(next);
  }

  // Arrow keys move AND select, per the radio pattern — so arrowing across the
  // grid is a live preview of each family. Left/Right step one tile, Up/Down a
  // whole row, everything wraps, and Home/End jump to the ends. Each group gets
  // its own handler: that is what "two independently keyboard-operable
  // radiogroups" means in practice.
  function arrows(btns, cols, onPick) {
    for (const b of btns) {
      b.addEventListener("keydown", (e) => {
        const n = btns.length, i = btns.indexOf(b);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
        const j = step !== undefined ? (i + step + n) % n
          : e.key === "Home" ? 0
          : e.key === "End" ? n - 1
          : -1;
        if (j < 0) return;
        e.preventDefault();
        btns[j].focus();
        onPick(btns[j]);
      });
      b.addEventListener("click", () => onPick(b));
    }
  }

  arrows(famBtns, GRID_COLS, (b) => pick({ family: b.dataset.family }));
  arrows(modeBtns, 1, (b) => pick({ mode: b.dataset.mode }));

  // The markup above renders the checked state inline (so the panel is never
  // briefly blank), but the Auto line has to be composed; do it now rather than
  // waiting for the profile fetch below to come back.
  showPair(pair);

  // The OS flipping under an `auto` pick repaints the page, and has to repaint
  // the panel's six swatches and its Auto line with it. theme-boot.js owns the
  // resolution and announces the result; this is the whole subscription.
  window.addEventListener("themechange", (e) => showResolved(e.detail.resolvedMode));

  // ...but that event only fires while the stored mode IS `auto`: an explicit
  // mode unsubscribes from the media query on purpose, because nothing should
  // repaint under an explicit choice. The Auto LINE still has to be true, so
  // the query is watched here for that one sentence. This OBSERVES the OS; it
  // does not resolve anything — what `auto` means is still theme-boot.js's
  // answer to give, and `showAutoLine` goes and asks it.
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (mq?.addEventListener) mq.addEventListener("change", showAutoLine);
  else mq?.addListener?.(showAutoLine); // old Safari

  // Reconcile this machine's cache against what the profile actually carries.
  // Runs on load and on every person switch; /api/people serves the DB locally
  // and the snapshot on the published site, so this is one code path for both.
  async function syncProfileTheme() {
    person = boot.person();
    if (!person) { showPair(boot.cached("") ?? boot.DEFAULT); return; }
    const stored = await storedPair(person);
    // One value, one comparison, one adoption — resolving field by field is how
    // you land on Thicket/dark when the profile moved to Thicket/light.
    const resolved = boot.resolve(person, stored);
    boot.apply(resolved);
    boot.cache(person, resolved);
    // Record what the profile carried, so the next load can tell "unchanged"
    // from "changed elsewhere" — that distinction is the whole resolution rule.
    if (stored) boot.markSeen(person, stored);
    showPair(resolved);
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
