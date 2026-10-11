// Structural + contrast check for the variants in local/public/theme.css.
//
//   npm run check:theme
//
// theme.css is a family x mode table, so a "theme" here is a VARIANT —
// `slate-dark`, `slate-light`, `peach-light`, `peach-dark` today, twelve once
// the remaining families land. Nothing below lists them: the variants are
// ENUMERATED out of the stylesheet, so a family added in T42 is scored from its
// first commit without touching this file, and a family added in only ONE mode
// is an error rather than a silent omission.
//
// Reads the ACTUAL token values out of the stylesheet (never a copy of them) and
// scores the pairings the UI really draws, so the comments in theme.css can't
// drift from the file and a future palette tweak can't quietly go unreadable.
//
// FOUR CLASSES OF FAILURE, in the order they're reported:
//
//   1. :root has drifted from slate-dark. The no-JS first-byte fallback must be
//      the same DECLARATIONS as the named variant, not a copy of them.
//   2. A family shipped in only one mode. This is the guard that makes adding
//      eight variants tractable — "I'll fill in the light one later" is how a
//      half-variant ships, and at twelve cells nobody notices by eye.
//   3. A token missing from a variant. The expected token list is the UNION
//      across variants plus the closed contract in REQUIRED, so a typo'd
//      property name (`--panel2`) is caught as an omission of `--panel-2`
//      instead of inheriting from `:root` and looking fine in the one mode
//      anyone opened.
//   4. Contrast below target, and category hues that have collapsed together.
//
// Why the contrast targets differ per row: --text is body copy and small labels,
// so it's held to WCAG AA 4.5:1. --pos / --neg / --warn / --accent are only ever
// used on bold figures, tabular cells and icons — WCAG's large-text line, 3:1.
// That is also the whole reason the peach theme's red/green can be pastel at
// all: a true pastel on a near-white page tops out around 2.5:1 and is
// unreadable, while ~3.3:1 is soft, clearly pastel, and still legible.
//
// The dark theme's white-on-filled-color pairings are below target and always
// have been: the ✓/!/✕ status glyphs on the dashboard badges, the % labels on
// the paycheck pie, and white on the blue --accent. They predate theming, and
// "dark stays byte-identical" outranks fixing them inside a theming change, so
// they are listed by name in KNOWN below — reported on every run, excused only
// because they're recorded. Anything NOT on that list that falls below target
// fails the run, which is the point: every other variant meets every target it
// has, and this is what keeps it that way.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CSS = join(dirname(fileURLToPath(import.meta.url)), "public", "theme.css");
const css = readFileSync(CSS, "utf8");
// Strip comments first: the file's own header names selectors and token values
// in prose, and a plain search matches that prose instead of the rule.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// Parse once: every rule's selector LIST and its custom-property declarations.
// Selectors are GROUPED in theme.css — slate-dark's values live under
// `:root, [data-theme="slate"][data-mode="dark"]` so the no-JS fallback and the
// named variant are physically the same declarations and cannot drift. So a
// selector is matched anywhere in a rule's list, not just at its head.
// ---------------------------------------------------------------------------
const RULES = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(",").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean),
  decls: Object.fromEntries(
    [...m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+)/g)].map((d) => [d[1], d[2].trim()])
  ),
}));

// Merged like the cascade: every rule naming this selector, later winning.
function declsFor(selector) {
  const out = {};
  let found = false;
  for (const r of RULES) {
    if (!r.selectors.includes(selector)) continue;
    found = true;
    Object.assign(out, r.decls);
  }
  if (!found) throw new Error(`theme.css: no rule for ${selector}`);
  return out;
}

// A variant block is EXACTLY `[data-theme="x"][data-mode="y"]` — not
// `:root[...]`, so a <div> can carry a variant, and not a compound like
// `[data-theme="x"][data-mode="y"] .thing`, which is a styling rule and not a
// token table. Insertion order is source order, so the report reads top-down.
const VARIANT_SEL = /^\[data-theme="([a-z][a-z-]*)"\]\[data-mode="([a-z]+)"\]$/;
const MODES = ["light", "dark"];

const variants = new Map();
const badModes = [];
for (const r of RULES) {
  for (const s of r.selectors) {
    const m = VARIANT_SEL.exec(s);
    if (!m) continue;
    const [, family, mode] = m;
    // `auto` is resolved in theme-boot.js and never reaches the stylesheet, so
    // a block for it is dead CSS that would never match.
    if (!MODES.includes(mode)) { badModes.push(s); continue; }
    const name = `${family}-${mode}`;
    if (!variants.has(name)) variants.set(name, { name, family, mode, selector: s, decls: {} });
    Object.assign(variants.get(name).decls, r.decls);
  }
}

// ---------------------------------------------------------------------------
// Color math. WCAG contrast for "is this legible", CIEDE2000 for "are these two
// slices tellable apart" — see the SEPARATION block for why that needs a
// perceptual metric and not a hue angle.
// ---------------------------------------------------------------------------
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const hex = (h) => {
  h = h.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lum = (h) => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// sRGB → CIELAB (D65), then CIEDE2000.
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : t / (3 * Math.pow(6 / 29, 2)) + 4 / 29);
function lab(h) {
  const [r, g, b] = hex(h).map(lin);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  return [116 * fLab(Y) - 16, 500 * (fLab(X) - fLab(Y)), 200 * (fLab(Y) - fLab(Z))];
}
const RAD = Math.PI / 180;
function deltaE(c1, c2) {
  const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2);
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const ang = (a, b) => { if (a === 0 && b === 0) return 0; const x = Math.atan2(b, a) / RAD; return x < 0 ? x + 360 : x; };
  const hp1 = ang(ap1, b1), hp2 = ang(ap2, b2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) { dh = hp2 - hp1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * RAD);
  const Lb = (L1 + L2) / 2, Cpb = (Cp1 + Cp2) / 2;
  let hb = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) hb = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * RAD) + 0.24 * Math.cos(2 * hb * RAD)
    + 0.32 * Math.cos((3 * hb + 6) * RAD) - 0.20 * Math.cos((4 * hb - 63) * RAD);
  const Sl = 1 + (0.015 * Math.pow(Lb - 50, 2)) / Math.sqrt(20 + Math.pow(Lb - 50, 2));
  const Sc = 1 + 0.045 * Cpb, Sh = 1 + 0.015 * Cpb * T;
  const Rt = -Math.sin(2 * (30 * Math.exp(-Math.pow((hb - 275) / 25, 2))) * RAD)
    * 2 * Math.sqrt(Math.pow(Cpb, 7) / (Math.pow(Cpb, 7) + Math.pow(25, 7)));
  return Math.sqrt(Math.pow(dL / Sl, 2) + Math.pow(dC / Sc, 2) + Math.pow(dH / Sh, 2)
    + Rt * (dC / Sc) * (dH / Sh));
}

// ---------------------------------------------------------------------------
// The token contract. CATS is twelve names, a CLOSED list, declared in EVERY
// variant; the last three are Phase 13's (cards), here rather than in that
// phase so the separation assert and T43's palette generation are written once
// against the final list instead of 36 values being retrofitted afterward.
// REQUIRED is everything a page can reference — a token missing from ALL
// variants is a contract gap the union alone cannot see.
// ---------------------------------------------------------------------------
const CATS = ["housing", "bill", "savings", "investments", "card", "loan", "food", "fun",
  "other", "groceries", "transport", "misc", "interest"];
const SPINE = ["bg", "panel", "panel-2", "line", "text", "muted", "accent", "accent-weak",
  "pos", "neg", "warn", "danger", "on-accent", "on-danger", "on-slice",
  "btn-hover-filter", "scrim", "chart-line"];
const TINTS = ["row-edited", "row-new", "row-neg",
  "banner-warn-bg", "banner-warn-line", "banner-ok-bg", "banner-ok-line",
  "shadow-sm", "shadow-md", "shadow-lg", "shadow-photo"];
const REQUIRED = [...SPINE, ...TINTS, ...CATS.map((c) => `cat-${c}`)];

// [label, foreground token, background token, target]
const PAIRS = (t) => [
  ["text on bg", t.text, t.bg, 4.5],
  ["text on panel", t.text, t.panel, 4.5],
  ["text on panel-2", t.text, t["panel-2"], 4.5],
  ["text on accent-weak", t.text, t["accent-weak"], 4.5],
  ["muted on bg", t.muted, t.bg, 3.0],
  ["muted on panel", t.muted, t.panel, 3.0],
  ["pos on bg", t.pos, t.bg, 3.0],
  ["pos on panel", t.pos, t.panel, 3.0],
  ["neg on bg", t.neg, t.bg, 3.0],
  ["neg on panel", t.neg, t.panel, 3.0],
  ["warn on bg", t.warn, t.bg, 3.0],
  ["accent on bg", t.accent, t.bg, 3.0],
  ["on-accent on accent", t["on-accent"], t.accent, 4.5],
  ["on-danger on danger", t["on-danger"], t.danger, 4.5],
  ["on-accent on pos (badge)", t["on-accent"], t.pos, 3.0],
  ["on-accent on neg (badge)", t["on-accent"], t.neg, 3.0],
  ["on-accent on warn (badge)", t["on-accent"], t.warn, 3.0],
  ...CATS.map((c) => [`on-slice on cat-${c}`, t["on-slice"], t[`cat-${c}`], 4.5]),
];

// Pre-existing slate-dark shortfalls, recorded so they don't mask a regression.
// Each entry is "<variant>::<label>" with why it's tolerated. EXACT MATCH, never
// a prefix or a label-only match: a shortfall recorded for slate-dark must not
// start excusing the same label in eleven other variants.
const KNOWN = new Map([
  ["slate-dark::on-accent on accent", "white on the blue .btn — the app's original primary button"],
  ["slate-dark::on-accent on pos (badge)", "white ✓ on the green dashboard badge — original"],
  ["slate-dark::on-accent on neg (badge)", "white ✕ on the red dashboard badge — original"],
  ["slate-dark::on-accent on warn (badge)", "white ! on the amber dashboard badge — original"],
  // The original EIGHT. --cat-investments passes, and so do T38's three new
  // names (4.74 / 5.49 / 4.54), so the list did not grow with the contract.
  ...["housing", "bill", "savings", "card", "loan", "food", "fun", "other"]
    .map((c) => [`slate-dark::on-slice on cat-${c}`, "white % label on the original dark pie palette"]),
]);

// ---------------------------------------------------------------------------
// SEPARATION — twelve category hues per variant, 144 across the table, and
// their job is IDENTITY, not decoration. Two categories that collapse into one
// color make a pie unreadable in a way no contrast target catches.
//
// THE METRIC IS PERCEPTUAL (CIEDE2000), NOT A HUE ANGLE. T38 left this open;
// measured across the four variants, a pure hue assert is not merely unkind to
// peach-light's frozen values, it is testing the wrong thing in both
// directions:
//
//   - It FAILS pairs that are obviously distinct. The offender is always
//     --cat-other, the catch-all whose identity is the ABSENCE of hue, so its
//     hue angle is numerically arbitrary: slate-dark reads savings 40° vs
//     other 45° (5° apart, ΔE 25.6), slate-light housing 213° vs other 219°
//     (6°, ΔE 17.0), peach-dark savings vs other 11° (ΔE 11.9). Three of four
//     variants would need `other` exempted — at which point the assert isn't
//     checking what it claims to.
//   - It PASSES pairs that genuinely collide. peach-light's housing #e8a07a vs
//     fun #eda871 sit 6° apart at ΔE 5.5 — the same hue gap slate-dark clears
//     at 25.6.
//
// THRESHOLD 8.0, and the reason it is not picked against Thicket after all:
// T38's derivation rule fixes hue PER CATEGORY from slate-dark, so every
// derived variant inherits the same twelve angles and a green-dominant family
// is no narrower than a blue one. Thicket is therefore not the family that
// fails first — the RULE's own weak spot is, and it is purple, not green:
// card 247° vs transport 276° are 29° apart but land at ΔE 8.4 in peach-dark
// and 10.1 in slate-light, because ΔE compresses in the blue-violet region
// where 17°-apart loan/fun reaches 10.4. So 8.0 is the largest threshold the
// rule's own output clears, with 0.4 of room on that pair. What will trip it is
// T43 tinting the twelve toward a family and pulling those two together;
// that is exactly the edit this assert exists to catch.
//
// peach-light is excused by name for three pairs, the same way KNOWN records
// contrast shortfalls — its values are frozen by spec, and its greens
// (bill 152° / investments 150°, separated only by luminance) are the reason a
// hue-only assert was never going to work here.
// ---------------------------------------------------------------------------
const MIN_DELTA_E = 8.0;
const KNOWN_SEPARATION = new Map([
  ["peach-light::cat-housing vs cat-fun", "frozen Phase 12 values — peach #e8a07a beside #eda871"],
  ["peach-light::cat-bill vs cat-investments", "frozen — pastel mints 1° apart, separated by luminance only"],
  ["peach-light::cat-card vs cat-transport", "frozen — the two pastel violets"],
]);

let failed = 0;
const known = [];

// --- 1. the one structural invariant T38 introduced ------------------------
{
  const root = declsFor(":root");
  const slateDark = variants.get("slate-dark");
  const same = slateDark
    && JSON.stringify(Object.entries(root).sort()) === JSON.stringify(Object.entries(slateDark.decls).sort());
  if (!same) {
    console.log("\n❌ :root has drifted from slate-dark — they must share ONE rule in theme.css");
    failed++;
  } else {
    console.log("\n✅ :root and slate-dark share one rule (no-JS fallback cannot drift)");
  }
}

// --- 2. no family is half-added -------------------------------------------
{
  const families = new Map();
  for (const v of variants.values()) {
    if (!families.has(v.family)) families.set(v.family, new Set());
    families.get(v.family).add(v.mode);
  }
  console.log(`\n== ${variants.size} variant(s) found in theme.css: ${[...variants.keys()].join(", ")}`);
  for (const s of badModes) {
    console.log(`   ❌ ${s} — data-mode must be light or dark; auto is resolved in theme-boot.js`);
    failed++;
  }
  for (const [family, modes] of families) {
    const missing = MODES.filter((m) => !modes.has(m));
    if (missing.length) {
      console.log(`   ❌ family "${family}" is half-added — no ${missing.join(" / ")} variant`);
      failed++;
    } else {
      console.log(`   ✅ family "${family}" ships both modes`);
    }
  }
  if (!families.size) { console.log("   ❌ no variant blocks found at all"); failed++; }
  if (/@media[^;{]*prefers-color-scheme/.test(bare)) {
    console.log("   ❌ @media (prefers-color-scheme) in theme.css — `auto` is resolved in theme-boot.js, one place");
    failed++;
  }
}

// --- 3. every variant declares every token --------------------------------
{
  const union = new Set(REQUIRED);
  for (const v of variants.values()) for (const k of Object.keys(v.decls)) union.add(k);
  const gaps = [];
  for (const token of [...union].sort()) {
    const absent = [...variants.values()].filter((v) => !(token in v.decls)).map((v) => v.name);
    if (absent.length) gaps.push([token, absent]);
  }
  if (!gaps.length) {
    console.log(`\n✅ all ${union.size} tokens declared in all ${variants.size} variants`);
  } else {
    console.log(`\n❌ ${gaps.length} token(s) not declared in every variant:`);
    for (const [token, absent] of gaps) {
      // Missing from nearly all of them reads as a typo'd property name, which
      // is the failure this union is built to surface: --panel2 declared once
      // means --panel-2 was dropped and inherited from :root.
      const hint = absent.length === variants.size ? " ← in no variant at all: contract gap"
        : absent.length > variants.size - 2 ? " ← declared only once: likely a typo'd name" : "";
      console.log(`   --${token} — missing from ${absent.join(", ")}${hint}`);
      failed += absent.length;
    }
  }
}

// --- 4. contrast + category separation, per variant -----------------------
for (const v of variants.values()) {
  const t = v.decls;
  console.log(`\n== ${v.name}${v.name === "slate-dark" ? " (also :root — the no-JS fallback)" : ""} — ${v.selector}`);
  for (const [label, fg, bg, target] of PAIRS(t)) {
    // Absence is already reported above; here the complaint is a value the
    // contrast math can't read.
    if (!fg || !bg) continue;
    if (!HEX.test(fg) || !HEX.test(bg)) {
      console.log(`   ?  ${label.padEnd(26)} not a plain hex (${fg} on ${bg})`);
      failed++;
      continue;
    }
    const value = ratio(fg, bg);
    const ok = value >= target;
    const excuse = ok ? null : KNOWN.get(`${v.name}::${label}`);
    if (!ok && !excuse) failed++;
    if (excuse) known.push(`${v.name}::${label} (${value.toFixed(2)}) — ${excuse}`);
    console.log(`   ${ok ? "✅" : excuse ? "➖" : "❌"} ${label.padEnd(26)} ${value.toFixed(2)}  (target ${target})`);
  }

  const collisions = [];
  let tightest = null;
  for (let i = 0; i < CATS.length; i++) {
    for (let j = i + 1; j < CATS.length; j++) {
      const a = t[`cat-${CATS[i]}`], b = t[`cat-${CATS[j]}`];
      if (!a || !b || !HEX.test(a) || !HEX.test(b)) continue;
      const label = `cat-${CATS[i]} vs cat-${CATS[j]}`;
      const dE = deltaE(a, b);
      if (!tightest || dE < tightest[1]) tightest = [label, dE];
      if (dE >= MIN_DELTA_E) continue;
      const excuse = KNOWN_SEPARATION.get(`${v.name}::${label}`);
      if (!excuse) failed++;
      else known.push(`${v.name}::${label} (ΔE ${dE.toFixed(1)}) — ${excuse}`);
      collisions.push([label, dE, excuse]);
    }
  }
  if (!collisions.length) {
    console.log(`   ✅ ${CATS.length} category hues separated — tightest ${tightest[0]} at ΔE ${tightest[1].toFixed(1)}  (min ${MIN_DELTA_E})`);
  } else {
    for (const [label, dE, excuse] of collisions) {
      console.log(`   ${excuse ? "➖" : "❌"} ${label.padEnd(34)} ΔE ${dE.toFixed(1)}  (min ${MIN_DELTA_E})${excuse ? "" : " — these two slices collapse together"}`);
    }
  }
}

if (known.length) {
  console.log(`\n➖ ${known.length} recorded pre-existing shortfall(s):`);
  for (const k of known) console.log(`   ${k}`);
}
console.log(failed ? `\n❌ ${failed} unrecorded problem(s)` : "\n✅ ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
