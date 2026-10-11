// Acceptance harness for T30 — shared/recurring.js and shared/card-rules.js.
//
//   npm run check:rules
//
// READ-ONLY. It opens local/dashboard.db read-only and never writes anything.
//
// Five parts, in the order the task's "Done when" states them:
//
//   1. EXTRACTION PARITY. `occurrences()` was lifted out of paycheck.js, which
//      is a working daily-use path. So this file carries a verbatim copy of the
//      ORIGINAL implementation and diffs the two across every frequency, every
//      cadence, a 31st-of-the-month base date, month-end boundaries and leap
//      years — thousands of cases, asserted date-for-date. A screenshot can
//      show that the modal still opens; only this can show that
//      `freq: "period"` still lands on the same days.
//
//   2. PRECEDENCE, one tier at a time. The resolution order is a total order,
//      and each tier is tested in isolation with the tiers above it tied, which
//      is the only way to know that tier 4 is reached at all.
//
//   3. APPLY semantics: unknown merchants are left ALONE (never guessed),
//      rename-only rules don't answer the category question, an unusable rule
//      is dropped rather than thrown on, and a rule naming another card never
//      matches.
//
//   4. DETECTION over the REAL ledger. The detector's premise is ≥3 consecutive
//      months of a merchant, so this is only a meaningful test because T26b
//      loaded real history. Two assertions that pull in opposite directions:
//      the known subscriptions must be found, and the frequent-but-
//      discretionary merchants (Chick-fil-A, QuikTrip, Uber rides) must NOT be,
//      even though they appear in more consecutive months than any subscription.
//
//   5. SUPERSEDE. A projected row is REPLACED, not duplicated, when its real
//      statement row arrives — including when the dates differ by a few days,
//      when the amount changed, and when the same merchant charges twice in one
//      month. Plus the structural guarantee: a projection never carries an
//      `external_id`.
//
// Parts 1–3 and 5 are synthetic and self-contained. Part 4 is the real one, and
// it skips with a note if the database is absent.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { windowFor } from "../shared/paycycle.js";
import {
  occurrences, occurrenceDates, defaultUntil, detectRecurring, merchantStem,
  projectionRows, supersedeProjections, staleProjections, parseProjection,
  projectionMarker, matchWindowDays, nextOccurrence, NON_RECURRING_CATEGORIES,
} from "../shared/recurring.js";
import {
  RULE_KIND, compileRule, compileRules, compileRulesWithErrors, applyRules,
  pickRule, ruleCoverage, ruleFromRow, CATCH_ALL_CATEGORY,
} from "../shared/card-rules.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_FILE = join(ROOT, "local", "dashboard.db");

let failures = 0;
const pass = (msg) => console.log(`     ✅ ${msg}`);
const fail = (msg, detail) => {
  failures++;
  console.log(`     ✗  ${msg}`);
  if (detail) console.log(String(detail).split("\n").map((l) => `        ${l}`).join("\n"));
};
const check = (ok, msg, detail) => (ok ? pass(msg) : fail(msg, detail));
const head = (title) => console.log(`\n${"═".repeat(84)}\n${title}\n${"═".repeat(84)}`);

const rule = (id, data, owner = "shared", name = id) => ({ id, owner, kind: RULE_KIND, name, data });

// ---------------------------------------------------------------------------
// 1. Extraction parity
// ---------------------------------------------------------------------------
//
// THE ORIGINAL, verbatim from paycheck.js before T30 lifted it — closures and
// all, with `push` collecting instead of staging and `state` passed in. Not
// tidied: a cleaned-up copy would test the cleanup, not the original.
function generateRecurringORIGINAL(base, freq, until, state) {
  const shiftDay = (iso, n) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => { const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 86400000); };
  const out = [];
  const D = base.txn_date;
  const push = (t) => out.push(t);
  let count = 0;
  const CAP = 300;
  if (freq === "weekly" || freq === "biweekly") {
    const step = freq === "weekly" ? 7 : 14;
    for (let n = 1; n <= CAP; n++) { const date = shiftDay(D, n * step); if (date > until) break; push({ ...base, txn_date: date }); count++; }
  } else if (freq === "monthly") {
    const [y, m, d] = D.split("-").map(Number);
    for (let n = 1; n <= CAP; n++) {
      const t = y * 12 + (m - 1) + n, yy = Math.floor(t / 12), mm = (t % 12) + 1;
      if (`${yy}-${String(mm).padStart(2, "0")}-01` > until) break;
      const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      if (d > dim) continue; // day doesn't exist this month — skip
      const date = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date > until) break;
      push({ ...base, txn_date: date }); count++;
    }
  } else if (freq === "period") {
    const cur = windowFor(state.cadence, state.anchor, D);
    const offset = daysBetween(cur.start, D);
    let win = windowFor(state.cadence, state.anchor, cur.nextStart);
    for (let n = 0; n < CAP; n++) {
      const date = shiftDay(win.start, offset);
      if (date > until) break;
      if (date <= win.end) { push({ ...base, txn_date: date }); count++; }
      win = windowFor(state.cadence, state.anchor, win.nextStart);
    }
  }
  return out;
}

head("1. extraction parity — occurrences() vs the implementation it replaced");

{
  const FREQS = ["weekly", "biweekly", "monthly", "period"];
  const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly"];
  // Base dates chosen for the cases that break naive month arithmetic: the
  // 31st, the 30th, the 29th (leap and non-leap February), the 1st, and a
  // mid-month ordinary day. Anchors deliberately differ from the base date so
  // `freq: "period"` has a non-zero offset to preserve.
  const BASES = [
    "2026-01-31", "2026-03-31", "2026-05-31", "2026-01-30", "2026-01-29",
    "2024-01-29", "2024-01-31", "2026-02-28", "2026-12-31", "2026-07-01", "2026-06-15",
  ];
  const ANCHORS = ["2026-01-02", "2026-03-13", "2026-06-15", "2026-01-31"];
  const UNTILS = ["2026-02-01", "2026-03-01", "2026-12-31", "2027-06-30", "2029-01-01", "2026-01-01"];

  let cases = 0, mismatches = [];
  for (const freq of FREQS) {
    for (const base of BASES) {
      for (const until of UNTILS) {
        for (const anchor of ANCHORS) {
          for (const cadence of CADENCES) {
            // Only `period` reads cadence/anchor; skip the redundant crossproduct
            // for the other three so the case count stays honest.
            if (freq !== "period" && (anchor !== ANCHORS[0] || cadence !== CADENCES[0])) continue;
            cases++;
            const row = { txn_date: base, description: "Bill", source: "X", withdrawal: 10 };
            const mine = occurrences(row, freq, until, { cadence, anchor }).map((r) => r.txn_date);
            const theirs = generateRecurringORIGINAL(row, freq, until, { cadence, anchor }).map((r) => r.txn_date);
            if (mine.join(",") !== theirs.join(",")) {
              mismatches.push(`${freq} ${base} → ${until} (${cadence}/${anchor})\n  new: ${mine.slice(0, 6).join(" ")}…(${mine.length})\n  old: ${theirs.slice(0, 6).join(" ")}…(${theirs.length})`);
            }
          }
        }
      }
    }
  }
  check(mismatches.length === 0, `${cases} cases, identical date-for-date across all four frequencies`, mismatches.slice(0, 3).join("\n"));

  // The specific cases the task calls out, asserted as values rather than
  // left to the crossproduct's word.
  const m31 = occurrenceDates("2026-01-31", "monthly", "2026-12-31", {});
  check(!m31.includes("2026-02-28") && !m31.includes("2026-03-01"), "a 31st-of-the-month base never slides into February");
  check(m31[0] === "2026-03-31", `the next occurrence after Jan 31 is Mar 31 (${m31[0]}) — February is skipped, not clamped`);
  check(m31.join(",") === "2026-03-31,2026-05-31,2026-07-31,2026-08-31,2026-10-31,2026-12-31", `and it lands on every remaining 31st in 2026, and only those (${m31.join(" ")})`);
  check(occurrenceDates("2024-01-31", "monthly", "2024-04-30", {}).join(",") === "2024-03-31", "leap-year February is skipped too");
  check(occurrenceDates("2026-06-15", "weekly", "2026-07-06", {}).join(",") === "2026-06-22,2026-06-29,2026-07-06", "weekly steps 7 days and includes `until` itself");
  check(occurrenceDates("2026-06-15", "biweekly", "2026-07-12", {}).join(",") === "2026-06-29", "biweekly steps 14 days and stops before `until`");
  check(occurrenceDates("2026-06-15", "nonsense", "2027-01-01", {}).length === 0, "an unknown frequency generates nothing at all");
  check(occurrenceDates("2026-06-15", "period", "2027-01-01", { cadence: "biweekly", anchor: null }).length === 0, "`period` with no anchor generates nothing rather than guessing a grid");

  // `period` preserves the offset inside the window — the subtle case.
  const periodDates = occurrenceDates("2026-01-07", "period", "2026-03-01", { cadence: "biweekly", anchor: "2026-01-02" });
  const offsets = periodDates.map((d) => {
    const w = windowFor("biweekly", "2026-01-02", d);
    return Math.round((Date.parse(d) - Date.parse(w.start)) / 86400000);
  });
  check(new Set(offsets).size === 1 && offsets[0] === 5, `\`period\` keeps the same offset (${offsets[0]} days) in every pay window, not a fixed 14-day step`);
  check(periodDates.join(",") === "2026-01-21,2026-02-04,2026-02-18", `and each one is the next window's same slot (${periodDates.join(" ")})`);

  // defaultUntil moved into the module with the generator, so the modal's
  // default and the projection guardrail cannot drift apart.
  check(defaultUntil("2026-06-15", []) === "2027-06-15", "defaultUntil: a year out when the ledger ends sooner");
  check(defaultUntil("2026-06-15", [{ txn_date: "2029-03-06" }]) === "2029-03-06", "defaultUntil: the ledger's furthest date when that is later");
  check(defaultUntil("2026-01-31", []) === "2027-01-28", "defaultUntil clamps the day to 28 so 'a year out' exists in every month");
}

// ---------------------------------------------------------------------------
// 2. Precedence
// ---------------------------------------------------------------------------

head("2. precedence — one tier at a time, with the tiers above it tied");

{
  const MERCH = "WHOLEFDS DCT 10687";
  const CARD = "woody-apple-card";
  const won = (rules, merchant = MERCH, accountId = CARD) => pickRule(compileRules(rules), merchant, accountId)?.description ?? null;

  // Tier 1: exact > contains > regex. All three match the same string, so only
  // the type can decide.
  check(
    won([
      rule("a", { match: MERCH, match_type: "exact", description: "EXACT" }),
      rule("b", { match: "WHOLEFDS", match_type: "contains", description: "CONTAINS" }),
      rule("c", { match: "WHOLE", match_type: "regex", description: "REGEX" }),
    ]) === "EXACT",
    "tier 1: exact beats contains beats regex"
  );
  check(
    won([
      rule("b", { match: "WHOLEFDS", match_type: "contains", description: "CONTAINS" }),
      rule("c", { match: "WHOLE", match_type: "regex", description: "REGEX" }),
    ]) === "CONTAINS",
    "tier 1: with no exact rule, contains still beats regex"
  );

  // Tier 2: card-specific beats all-cards, types tied.
  check(
    won([
      rule("a", { match: "WHOLEFDS", match_type: "contains", account_id: null, description: "ALL" }),
      rule("b", { match: "WHOLEFDS", match_type: "contains", account_id: CARD, description: "THIS CARD" }),
    ]) === "THIS CARD",
    "tier 2: a rule naming this card beats an all-cards rule"
  );
  check(
    won([
      rule("a", { match: "WHOLEFDS", match_type: "contains", account_id: null, description: "ALL" }),
      rule("b", { match: "WHOLEFDS", match_type: "contains", account_id: "woody-citi-card", description: "OTHER CARD" }),
    ]) === "ALL",
    "tier 2: a rule naming a DIFFERENT card does not match at all"
  );
  check(
    won([rule("b", { match: "WHOLEFDS", match_type: "contains", account_id: "woody-citi-card", description: "OTHER CARD" })]) === null,
    "tier 2: and with only that rule, nothing matches — scope filters before it ranks"
  );

  // Tier 3: priority, with type and scope tied and needles the same length.
  check(
    won([
      rule("a", { match: "WHOLEFDS", match_type: "contains", description: "LOW", priority: 0 }),
      rule("b", { match: "WHOLEFDS", match_type: "contains", description: "HIGH", priority: 5 }),
    ]) === "HIGH",
    "tier 3: higher priority wins"
  );
  check(
    won([
      rule("a", { match: "WHOLEFDS", match_type: "contains", account_id: CARD, description: "CARD, LOW PRIORITY", priority: 0 }),
      rule("b", { match: "WHOLEFDS", match_type: "contains", account_id: null, description: "ALL, HIGH PRIORITY", priority: 99 }),
    ]) === "CARD, LOW PRIORITY",
    "tier 3 never outranks tier 2 — priority 99 on an all-cards rule still loses to a card rule at 0"
  );

  // Tier 4: the longest needle, everything above tied. This is the tier that
  // makes "one broad rule plus a narrow exception" work.
  check(
    won([
      rule("a", { match: "UBER", match_type: "contains", description: "Transportation" }),
      rule("b", { match: "UBER EATS", match_type: "contains", description: "Food" }),
    ], "UBER EATS 8005928996 CA") === "Food",
    "tier 4: UBER EATS beats UBER on the same row"
  );
  check(
    won([
      rule("a", { match: "UBER", match_type: "contains", description: "Transportation" }),
      rule("b", { match: "UBER EATS", match_type: "contains", description: "Food" }),
    ], "UBER TRIP HELP UBER COM") === "Transportation",
    "tier 4: and the broad rule still claims the rows the narrow one doesn't"
  );

  // Tier 5: determinism. Two rules identical in every ranked field must resolve
  // the same way whatever order they arrive in — otherwise two machines with the
  // same rule set show different categories.
  const twins = [
    rule("zzz", { match: "WHOLEFDS", match_type: "contains", description: "Z" }),
    rule("aaa", { match: "WHOLEFDS", match_type: "contains", description: "A" }),
  ];
  check(won(twins) === "A" && won(twins.slice().reverse()) === "A", "tier 5: a true tie resolves by id, so row order cannot change the answer");
}

// ---------------------------------------------------------------------------
// 3. applyRules semantics
// ---------------------------------------------------------------------------

head("3. applyRules — what it writes, and what it refuses to");

{
  const rules = compileRules([
    rule("groceries", { match: "WHOLEFDS", match_type: "contains", description: "Groceries" }),
    rule("rename", { match: "DUNKIN", match_type: "contains", description: "", source: "Dunkin'" }),
    rule("broken-regex", { match: "([", match_type: "regex", description: "Food" }),
    rule("empty", { match: "", match_type: "contains", description: "Food" }),
  ]);
  check(rules.length === 2, `2 of 4 rules compile; the bad regex and the empty needle are dropped (${rules.length})`);

  const { invalid } = compileRulesWithErrors([
    rule("broken-regex", { match: "([", match_type: "regex", description: "Food" }),
    rule("empty", { match: "", match_type: "contains", description: "Food" }),
  ]);
  check(invalid.length === 2 && invalid.every((r) => r.error), "and both come back with an error string an editor can show");
  check(/invalid regular expression/i.test(invalid.find((r) => r.id === "broken-regex").error), "a bad regex is reported, never thrown");

  const rows = [
    { source: "WHOLEFDS DCT 10687", description: "Misc", withdrawal: 40 },
    { source: "SOME MERCHANT NOBODY KNOWS", description: "Misc", withdrawal: 12 },
    { source: "DUNKIN #354365", description: "Misc", withdrawal: 6 },
    { source: "CHICK-FIL-A #05542", description: "Food", withdrawal: 11 },
  ];
  const out = applyRules(rows, rules);
  check(out[0].description === "Groceries" && out[0]._rule?.id === "groceries", "a matched row gets the rule's category and says which rule did it");
  check(out[1].description === "Misc" && out[1]._rule === null && out[1]._needsCategory === true,
    "an unknown merchant is LEFT ALONE and flagged as unanswered — never guessed");
  check(out[2].source === "Dunkin'" && out[2].description === "Misc" && out[2]._needsCategory === true,
    "a rename-only rule renames but does NOT answer the category question");
  check(out[3].description === "Food" && out[3]._needsCategory === false,
    "a row the issuer already categorized is untouched and not flagged");
  check(rows[0].description === "Misc", "the input array is not mutated — the review modal re-runs this on every edit");

  const cov = ruleCoverage(rows, rules);
  check(cov.matched === 2 && cov.changed === 2 && cov.needsCategory === 2, `coverage counts: ${cov.matched} matched, ${cov.changed} changed, ${cov.needsCategory} unanswered`);
  check(cov.unused.length === 0, "no unused rules in this set");
  const covUnused = ruleCoverage(rows, compileRules([rule("nope", { match: "NEVERLAND", description: "Fun" })]));
  check(covUnused.unused.length === 1, "a rule that matches nothing is reported as unused — the commonest authoring mistake");

  const learned = ruleFromRow({ source: "WHOLEFDS DCT 10687" }, "Groceries", { owner: "woody" });
  check(learned.kind === RULE_KIND && learned.data.match_type === "contains" && learned.data.match === "WHOLEFDS DCT 10687",
    "a learned rule defaults to `contains` on the row's own normalized merchant");
  check(applyRules([rows[0]], compileRules([{ ...learned, id: "learned" }]))[0].description === "Groceries", "and it matches the row it was learned from");
  check(CATCH_ALL_CATEGORY === "Misc", "the catch-all category is `Misc`, matching the importer's fallback");
}

// ---------------------------------------------------------------------------
// 4. Detection over the real ledger
// ---------------------------------------------------------------------------

head("4. detection — the real card history (the only test here that uses real data)");

if (!existsSync(DB_FILE)) {
  console.log(`  ⚠  skipped: no local/dashboard.db. Everything else runs regardless.`);
} else {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  const cards = db.prepare("SELECT * FROM accounts WHERE type = 'credit_card' AND deleted_at IS NULL").all();
  const rowsFor = (id) => db.prepare("SELECT * FROM transactions WHERE account_id = ? AND deleted_at IS NULL").all(id);

  const apple = cards.find((c) => /apple/i.test(c.id));
  if (!apple) {
    console.log("  ⚠  no Apple Card account — skipping the headline detection test");
  } else {
    const rows = rowsFor(apple.id);
    const hits = detectRecurring(rows, { months: 3, tolerance: 0.15 });
    const found = new Map(hits.map((h) => [h.merchant, h]));
    console.log(`\n  ${apple.name}: ${rows.length} rows → ${hits.length} recurring merchant(s)`);
    for (const h of hits) {
      console.log(`     ${String(Math.round(h.confidence * 100)).padStart(3)}%  ${h.merchant.padEnd(26)} $${h.typicalAmount.toFixed(2).padStart(8)}  ${h.cadence.padEnd(8)} ${h.monthsRun} mo through ${h.lastSeen}${h.mixed ? "  (mixed)" : ""}`);
    }

    // TRUE POSITIVES — the real subscriptions in this history.
    for (const [stem, amount] of [["AMAZON PRIME", 15.89], ["GOOGLE", 26.99], ["AHS AHS COM", 62.99]]) {
      const h = found.get(stem);
      check(!!h, `finds ${stem}`, h ? null : `detected: ${[...found.keys()].join(", ")}`);
      if (h) check(Math.abs(h.typicalAmount - amount) < 0.01, `  at its real amount $${amount} (got $${h.typicalAmount})`);
      if (h) check(h.cadence === "monthly", `  as monthly (got ${h.cadence})`);
    }

    // FALSE POSITIVES — the merchants that appear in MORE consecutive months
    // than any subscription, and must still not be detected. This is the
    // assertion that the amount tolerance alone cannot pass.
    for (const stem of ["CHICK FIL A", "QT INSIDE", "UBER TRIP", "PUBLIX", "CHIPOTLE", "UBER EATS"]) {
      const h = found.get(stem);
      check(!h, `does NOT call ${stem} recurring`, h ? `detected at ${Math.round(h.confidence * 100)}% — one-charge-per-month is not holding` : null);
    }

    // Structural guarantees of the detector.
    check(hits.every((h) => !NON_RECURRING_CATEGORIES.has(h.category)),
      "never proposes interest, a payment, a transfer or an adjustment — those repeat but are not merchants");
    check(hits.every((h) => h.confidence >= 0.5 && h.confidence <= 0.99), "confidence stays inside [0.5, 0.99]");
    check(hits.every((h) => h.monthsRun >= 3), "every hit clears the ≥3-consecutive-month premise");

    // Raising the bar must only ever remove hits, never add them.
    const strict = detectRecurring(rows, { months: 5, tolerance: 0.05 });
    const strictSet = new Set(strict.map((h) => h.merchant));
    check([...strictSet].every((m) => found.has(m)) && strict.length <= hits.length,
      `months:5 / tolerance:5% is a strict subset (${strict.length} ≤ ${hits.length})`);
  }

  // Across every card, so a card with no history is also exercised.
  for (const c of cards) {
    const rows = rowsFor(c.id);
    const hits = detectRecurring(rows, { months: 3, tolerance: 0.15 });
    const bad = hits.filter((h) => h.lastSeen < h.firstSeen || h.typicalAmount <= 0);
    check(bad.length === 0, `${c.name}: ${rows.length} rows → ${hits.length} hit(s), all internally consistent`);
  }

  // The merchant stem, on the strings the real issuers actually produce.
  const stems = [
    ["AMAZON PRIME 0Y44R18W3", "AMAZON PRIME"],
    ["CHICK-FIL-A #05542", "CHICK FIL A"],
    ["EU KALDIS-HSRB MO ATLANTA GAAPPLE PAY ENDING IN 2877", "EU KALDIS HSRB MO ATLANTA"],
    ["AMAZON MKTPL*BS65S0XP0 SEATTLE WA", "AMAZON MKTPL SEATTLE"],
    ["SQ *REBEL TEAHOUSE ? D Decatur GA", "SQ REBEL TEAHOUSE D DECATUR"],
  ];
  for (const [raw, want] of stems) check(merchantStem(raw) === want, `stem: "${raw.slice(0, 34)}…" → ${merchantStem(raw)}`, merchantStem(raw) === want ? null : `expected ${want}`);
  check(merchantStem("5637R95V2") === "5637R95V2", "a merchant that is only digits keeps its string rather than collapsing to nothing");

  db.close();
}

// ---------------------------------------------------------------------------
// 5. Supersede
// ---------------------------------------------------------------------------

head("5. supersede — a projection is replaced, never duplicated");

{
  const hit = {
    merchant: "AMAZON PRIME", label: "AMAZON PRIME 0Y44R18W3", category: "Fun", cadence: "monthly",
    typicalAmount: 15.89, dayOfMonth: 26, firstSeen: "2026-03-26", lastSeen: "2026-09-26",
    monthsRun: 7, charges: 7, spread: 0, mixed: false, confidence: 0.92,
    key: projectionMarker("AMAZON PRIME", "monthly"),
  };
  const until = defaultUntil(hit.lastSeen, []);
  const projected = projectionRows(hit, { until });
  check(projected.length === 12, `projects 12 monthly rows to the recurring modal's own default stop date ${until} (${projected.length})`);
  check(projected[0].txn_date === "2026-10-26", `starting at the next occurrence after lastSeen (${projected[0].txn_date})`);
  check(projected.every((r) => r.projected === hit.key), "every row carries the `projected` marker");
  check(projected.every((r) => !("external_id" in r)), "and NONE carries an external_id — a future import cannot collide with a row we invented");
  check(projected.every((r) => r.description === "Fun" && r.withdrawal === 15.89), "with the merchant's own historical category and typical amount");
  check(projected[projected.length - 1].txn_date <= until, "nothing is projected past `until`");
  try {
    projectionRows(hit, {});
    fail("projectionRows without `until` should throw — the guardrail is 'never past the modal's default'");
  } catch { pass("projectionRows refuses to run without an explicit `until`"); }

  // The ledger as it would be after Save: projections are real rows.
  const ledger = projected.map((r, i) => ({ ...r, id: `proj-${i}`, account_id: "woody-apple-card", external_id: null }));

  // (a) The real October row arrives two days early, at a NEW price.
  const real = { txn_date: "2026-10-24", source: "AMAZON PRIME R322G68P3", description: "Misc", withdrawal: 17.99, deposit: 0, external_id: "abc123", kind: "purchase" };
  const r1 = supersedeProjections([real], ledger);
  check(r1.superseded.length === 1 && r1.fresh.length === 0, "the real row supersedes its projection instead of landing fresh");
  check(r1.superseded[0].update_id === "proj-0", `and it targets the right projection (${r1.superseded[0].update_id})`);
  check(r1.superseded[0].days_apart === 2, `two days apart, inside half a monthly step (${matchWindowDays("monthly")} days)`);
  check(!r1.unmatched.some((p) => p.id === "proj-0"), "the claimed projection is not reported back as unmatched");
  const r1b = supersedeProjections([real], ledger, { today: "2026-11-01" });
  check(r1b.unmatched.length === 0, "with a `today`, only PAST-DUE unclaimed projections come back — none here, because the one that was due got its row");

  // (b) Amount is deliberately not part of the match.
  const doubled = { ...real, withdrawal: 31.98 };
  check(supersedeProjections([doubled], ledger).superseded.length === 1,
    "a doubled amount still supersedes — the projection's amount is what the statement is CORRECTING");

  // (c) Outside the window it is a genuinely new row.
  const far = { ...real, txn_date: "2026-11-15" };
  const r3 = supersedeProjections([far], ledger);
  check(r3.superseded.length === 1 && r3.superseded[0].update_id === "proj-1",
    "a row 20 days from October's projection matches NOVEMBER's, which is the nearer one");
  const justOutside = supersedeProjections([{ ...real, txn_date: "2026-10-10" }], [ledger[0]]);
  check(justOutside.superseded.length === 0 && justOutside.fresh.length === 1,
    "16 days from the only projection is OUTSIDE ±15 — the window is enforced, not approximated");
  check(justOutside.unmatched.length === 1, "and that projection is reported back as unclaimed");

  // (d) Two charges in one month: the first consumes the projection, the second
  //     is fresh. Both survive; neither is dropped.
  const twice = [
    { ...real, txn_date: "2026-10-26", withdrawal: 15.89, external_id: "x1" },
    { ...real, txn_date: "2026-10-27", withdrawal: 15.89, external_id: "x2" },
  ];
  const r4 = supersedeProjections(twice, ledger);
  check(r4.superseded.length === 1 && r4.fresh.length === 1,
    "two charges in one period: one replaces the projection, the other lands fresh — neither is lost");
  check(r4.superseded[0].row.external_id === "x1", "the nearer-dated of the two takes the projection");

  // (e) A different merchant never touches it.
  const other = { ...real, source: "NETFLIX.COM", external_id: "n1" };
  check(supersedeProjections([other], ledger).superseded.length === 0, "a different merchant never claims a projection");

  // (f) One projection is claimed at most once, even by many candidate rows.
  const many = [1, 2, 3].map((n) => ({ ...real, txn_date: `2026-10-2${n + 3}`, external_id: `m${n}` }));
  const r6 = supersedeProjections(many, [ledger[0]]);
  check(r6.superseded.length === 1 && r6.fresh.length === 2, "a projection is claimed exactly once, however many rows are nearby");

  // (g) Stale projections: past-dated, nothing arrived.
  const stale = staleProjections(ledger, "2026-12-01");
  check(stale.length === 2 && stale.every((r) => r.txn_date < "2026-12-01"), `past-due projections are surfaced for review, not deleted (${stale.length})`);
  check(staleProjections(ledger.map((r) => ({ ...r, projected: null })), "2026-12-01").length === 0, "an ordinary future row is never mistaken for a projection");

  // (h) The marker round-trips, including a merchant containing a colon.
  const weird = projectionMarker("A:B MARKET", "biweekly");
  check(parseProjection(weird).cadence === "biweekly" && parseProjection(weird).stem === "A:B MARKET", "the marker round-trips even when the merchant contains a colon");
  check(parseProjection(null) === null, "a null marker parses to null, not to a phantom projection");
  check(nextOccurrence("2026-01-31", "monthly") === "2026-03-31", "nextOccurrence keeps a 31st on the 31st");
  check(nextOccurrence("2026-01-15", "biweekly") === "2026-01-29", "and steps 14 days for biweekly");
}

// ---------------------------------------------------------------------------

head(failures === 0 ? "✅ every check passed" : `✗ ${failures} check(s) failed`);
console.log(
  failures === 0
    ? "The extracted generator matches the one it replaced, precedence is total, detection separates\nsubscriptions from habits on the real ledger, and a projection is replaced rather than duplicated."
    : "Read the ✗ lines above."
);
process.exit(failures === 0 ? 0 : 1);
