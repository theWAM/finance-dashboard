// Theme boot: applies the right theme BEFORE the first paint, and owns the
// storage keys + resolution rule that settings.js reads back.
//
// A classic blocking <script> in <head> on purpose — it has to run before
// anything renders, which rules out a module (deferred) and rules out doing this
// in settings.js. It is one shared file rather than an inline snippet copied
// into six pages so the pre-paint answer and the post-load answer come from the
// same code and can't drift apart.
//
// THE THEME BELONGS TO THE PROFILE, not to the machine. It lives on the
// `people` row, so it rides the existing snapshot export and the existing
// per-record last-writer-wins merge — switching person switches theme, and a
// Publish carries your choice to the other machine and to the published site.
// (Low power is the opposite: that one really is per-machine, because it
// describes what this computer can render, not who you are.)
//
// THE VALUE IS A PAIR: {family, mode}, where family picks the palette and
// mode is light | dark | auto. theme.css is a family x mode table, so BOTH
// attributes are always written explicitly — an absent one matches no variant
// and would silently paint slate-dark, i.e. half a theme.
//
// `auto` is resolved HERE, in JS, and never with an @media block in theme.css
// (decision #29): one resolution rule, one place. What gets stored stays
// `auto`; what gets written to data-mode is always concrete. And because the OS
// can flip at sunset with the page already open, `auto` also subscribes to the
// media query and re-applies — see `follow` below.
//
// A profile row needs a fetch, and pre-paint can't wait for one. So each
// machine also caches the answer per profile, and the real work here is
// collapsing three states into one:
//
//   stored      what the profile row carries — the DB locally, the snapshot on
//               the published site. Not available until after first paint.
//   theme:<id>  this machine's cached answer for that profile. What we paint
//               with immediately.
//   themeSeen:<id>  the last `stored` value this machine actually observed.
//
// Rule: if `stored` differs from `themeSeen`, the profile was changed somewhere
// else — adopt it. Otherwise the cache wins. That one rule covers every case:
//
//   - You pick peach locally → written through to the profile, cached, seen
//     advanced. Reload paints peach with no flash and no Publish needed.
//   - Your partner changes your profile's theme and you Sync → stored moves off
//     themeSeen → adopted.
//   - A reader picks a theme on the READ-ONLY published site → the write 404s,
//     so themeSeen never advances and their cache keeps winning on reload. Their
//     local preference is respected without them being able to write anyone's
//     profile. It yields only when the owner genuinely changes the stored value.
//
// THE COMPARISON IS ON THE WHOLE PAIR, never field by field. If a partner moves
// your profile from Slate/dark to Thicket/light and only the family were
// adopted, you'd land on Thicket/dark — a variant nobody chose. One value, one
// comparison, one adoption. That is why everything here serializes the pair to
// a single "family:mode" string before it is stored or compared.

(function () {
  var FAMILIES = { slate: 1, peach: 1, bordeaux: 1, lagoon: 1, orchid: 1, thicket: 1 };
  var MODES = { light: 1, dark: 1, auto: 1 };

  // A profile that has never chosen resolves to Slate/dark — the pre-pair
  // DEFAULT, widened — and deliberately NOT to matchMedia (decision #36). The
  // `auto` path exists for people who ask for it; if it were also the fallback,
  // "no default mode" would quietly become "the default is your laptop's
  // setting". Nothing in this file writes `auto` unless a human picked it.
  var DEFAULT = { family: "slate", mode: "dark" };

  // Migration (decision #36): every pre-pair value arrives with its mode made
  // EXPLICIT, so nobody's appearance moves on the first load after this phase.
  //   LEGACY  the single-string ids this file used to store and the profile
  //           column still holds: "dark" -> slate, "peach" -> peach.
  //   NATIVE  the mode a family shipped in, for a family that arrives without
  //           one. Only slate and peach can arrive that way, since mode has
  //           been stored since T39, but all six are listed so `norm` never has
  //           to fall back to DEFAULT.mode and silently pick dark for a family
  //           whose whole identity is its light variant (Orchid, Thicket).
  var LEGACY = { dark: "slate", peach: "peach" };
  var NATIVE = {
    slate: "dark", peach: "light",
    bordeaux: "dark", lagoon: "dark", orchid: "light", thicket: "light",
  };

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode — session only */ } }

  // --- The pair, as one value ----------------------------------------------

  function norm(family, mode) {
    family = LEGACY[family] || family;
    if (!FAMILIES[family]) return null;
    return { family: family, mode: MODES[mode] ? mode : (NATIVE[family] || DEFAULT.mode) };
  }

  // Accepts everything this value is stored as anywhere in the chain: the
  // serialized pair, a {family, mode} object (what the profile row gives us as
  // `theme` + `theme_mode`), or a bare pre-pair id. Always returns a pair with
  // a concrete mode, or null if the family is one nothing can render.
  function parse(v) {
    if (!v) return null;
    if (typeof v === "object") return norm(v.family || v.theme, v.mode);
    var s = String(v), i = s.indexOf(":");
    return i < 0 ? norm(s, null) : norm(s.slice(0, i), s.slice(i + 1));
  }

  function serialize(p) { return p ? p.family + ":" + p.mode : null; }
  function same(a, b) { return serialize(parse(a)) === serialize(parse(b)); }

  var cacheKey = function (person) { return "theme:" + (person || ""); };
  var seenKey = function (person) { return "themeSeen:" + (person || ""); };

  // Which profile's theme to paint. `currentUser` is already how every page
  // remembers the chosen person, so there's nothing new to keep in sync.
  function person() { return get("currentUser") || ""; }

  // Falls back along the chain a real install walks: this profile's cache → the
  // no-profile-chosen cache → the flat `theme` key written before the theme was
  // per-profile. Every link goes through `parse`, which is what makes the
  // migration cover all four of the places a pre-pair value can be hiding
  // (those three plus the profile column, parsed by `resolve`).
  function cached(p) {
    return parse(get(cacheKey(p))) || (p ? parse(get(cacheKey(""))) : null) || parse(get("theme")) || null;
  }

  // --- Resolving `auto` -----------------------------------------------------

  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  // Exported below, because the settings panel has to state what `auto` WOULD
  // give you even while an explicit mode is painted — and asking matchMedia a
  // second time over there is the start of two resolution rules.
  function systemMode() { return mq ? (mq.matches ? "dark" : "light") : DEFAULT.mode; }

  // While the stored mode is `auto`, the OS flipping has to move the open page
  // rather than wait for a reload. Explicit modes unsubscribe, so an explicit
  // choice never repaints on a system change.
  var following = false;
  function onSystemChange() { if (current && current.mode === "auto") apply(current); }
  function follow(on) {
    if (!mq || on === following) return;
    following = on;
    if (mq.addEventListener) mq[on ? "addEventListener" : "removeEventListener"]("change", onSystemChange);
    else if (mq.addListener) { if (on) mq.addListener(onSystemChange); else mq.removeListener(onSystemChange); }
  }

  // The pair currently applied (as stored, so `auto` is still `auto`).
  var current = null;

  // Writes the variant and returns the pair as STORED — callers cache what the
  // person chose, not what tonight's system setting resolved it to.
  function apply(v) {
    var p = parse(v) || DEFAULT;
    var mode = p.mode === "auto" ? systemMode() : p.mode;
    var root = document.documentElement, changed = root.dataset.theme !== p.family || root.dataset.mode !== mode;
    current = p;
    root.dataset.theme = p.family;
    root.dataset.mode = mode;
    follow(p.mode === "auto");
    // Lets a panel label "Auto" with what it currently resolves to without
    // duplicating the rule. Fires pre-paint too, when nothing is listening yet.
    if (changed) window.dispatchEvent(new CustomEvent("themechange", {
      detail: { family: p.family, mode: p.mode, resolvedMode: mode },
    }));
    return p;
  }

  window.__theme = {
    themes: { families: Object.keys(FAMILIES), modes: Object.keys(MODES) },
    DEFAULT: DEFAULT,
    parse: parse,
    serialize: serialize,
    same: same,
    person: person,
    cached: cached,
    apply: apply,
    current: function () { return current; },
    // Two different questions, and the settings panel asks both:
    //   resolvedMode  what is PAINTED. Equal to systemMode() only under `auto`.
    //   systemMode    what the OS says, whatever is painted.
    resolvedMode: function () { return document.documentElement.dataset.mode; },
    systemMode: systemMode,
    cache: function (p, v) { var q = parse(v); if (q) set(cacheKey(p), serialize(q)); },
    seen: function (p) { return parse(get(seenKey(p))); },
    markSeen: function (p, v) { var q = parse(v); if (q) set(seenKey(p), serialize(q)); },

    // The rule, in one place. `stored` is what the profile row carries (may be
    // null: a profile that has never chosen) in any of the shapes `parse`
    // takes. Compared as a serialized pair, so a value that only MIGRATED
    // ("dark" -> slate:dark) doesn't look like a change made elsewhere.
    resolve: function (p, stored) {
      stored = parse(stored);
      if (stored && !same(stored, window.__theme.seen(p))) return stored; // changed elsewhere → adopt
      return cached(p) || stored || DEFAULT;
    },
  };

  apply(cached(person()));
})();
