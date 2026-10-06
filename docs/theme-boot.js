// Theme boot: applies the right theme BEFORE the first paint, and owns the
// storage keys + resolution rule that settings.js reads back.
//
// A classic blocking <script> in <head> on purpose — it has to run before
// anything renders, which rules out a module (deferred) and rules out doing this
// in settings.js. It is one shared file rather than an inline snippet copied
// into six pages so the pre-paint answer and the post-load answer come from the
// same code and can't drift apart.
//
// THE THEME BELONGS TO THE PROFILE, not to the machine. It lives in a `theme`
// column on `people`, so it rides the existing snapshot export and the existing
// per-record last-writer-wins merge — switching person switches theme, and a
// Publish carries your choice to the other machine and to the published site.
// (Low power is the opposite: that one really is per-machine, because it
// describes what this computer can render, not who you are.)
//
// But a profile row needs a fetch, and pre-paint can't wait for one. So each
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

(function () {
  var THEMES = { dark: 1, peach: 1 };
  var DEFAULT = "dark";

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode — session only */ } }

  var valid = function (v) { return THEMES[v] ? v : null; };
  var cacheKey = function (person) { return "theme:" + (person || ""); };
  var seenKey = function (person) { return "themeSeen:" + (person || ""); };

  // Which profile's theme to paint. `currentUser` is already how every page
  // remembers the chosen person, so there's nothing new to keep in sync.
  function person() { return get("currentUser") || ""; }

  // Falls back along the chain a real install walks: this profile's cache → the
  // no-profile-chosen cache → the flat `theme` key written before the theme was
  // per-profile (so an existing choice isn't thrown away).
  function cached(p) {
    return valid(get(cacheKey(p))) || (p ? valid(get(cacheKey(""))) : null) || valid(get("theme")) || null;
  }

  function apply(id) {
    document.documentElement.dataset.theme = valid(id) || DEFAULT;
    return valid(id) || DEFAULT;
  }

  window.__theme = {
    themes: Object.keys(THEMES),
    valid: valid,
    person: person,
    cached: cached,
    apply: apply,
    cache: function (p, id) { if (valid(id)) set(cacheKey(p), id); },
    seen: function (p) { return valid(get(seenKey(p))); },
    markSeen: function (p, id) { if (valid(id)) set(seenKey(p), id); },

    // The rule, in one place. `stored` is the profile row's value (may be null:
    // a profile that has never chosen).
    resolve: function (p, stored) {
      stored = valid(stored);
      if (stored && stored !== window.__theme.seen(p)) return stored; // changed elsewhere → adopt
      return cached(p) || stored || DEFAULT;
    },
  };

  apply(cached(person()));
})();
