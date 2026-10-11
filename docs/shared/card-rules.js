// T30(b) — merchant → category rules.
//
// WHY THIS EXISTS. Decision #21 says a card purchase counts in the Spending
// Plan "at its own category", and T25's audit then measured how good those
// categories actually are: **`Other` is 60% of Woody's Apple Card in 2026-09**
// ($1,848.08 of $3,058.35), **Citi exports no category column at all**, and the
// three issuer vocabularies share almost no spelling (`Grocery` /
// `Supermarkets` / none). Across the 977 loaded card rows, 247 (27%) landed in
// `Misc`. Without rules, decision #21 means "a quarter of card spending is
// filed under Other", which is not an answer to "where did it go".
//
// WHAT A RULE IS. A `plan_targets` row of kind `card_rule`, so it inherits the
// snapshot, the per-record last-writer-wins merge, and the whole CRUD surface
// for free — exactly as `csp_plan` / `csp_item` did. No schema change.
//
//   kind: "card_rule"   owner: "woody"   name: "Whole Foods"
//   data: { match: "WHOLEFDS", match_type: "contains",  // contains | exact | regex
//           account_id: null,            // null = every card this owner sees
//           description: "Groceries",    // the ledger category to write
//           source: "Whole Foods",       // optional merchant rename
//           priority: 0 }
//
// WHAT IT MATCHES AGAINST. The row's merchant (`source`), normalized by
// `normalizeMerchant` from card-import-spec.js — accents stripped, uppercased,
// punctuation collapsed to single spaces, DIGITS KEPT. So `WHOLEFDS DCT 10687`
// is matched by `WHOLEFDS`, and a rule can also name a specific store number
// when that matters. The `match` string is normalized the same way before
// comparison, so "whole-foods" and "Whole Foods" are one needle — but
// normalization is not spelling correction: typing "Whole Foods" does NOT match
// `WHOLEFDS`, because the statement does not contain that string. Matching
// nothing is the commonest way a rule set disappoints its author, so every
// surface that edits a rule shows its live match count.
//
// PRECEDENCE, WRITTEN DOWN BECAUSE IT IS THE BUG CLASS DECISION #7 FIXED.
// For CSP items, "whichever matched first" silently let a category-based
// *Debt Payments* swallow a source-based *Rajna Assistance Program*. Same shape
// of bug here, so the order is explicit, total, and tested one tier at a time
// in local/check-rules.js. Every matching rule is collected, then ranked by:
//
//   1. MATCH TYPE — `exact` (2) beats `contains` (1) beats `regex` (0).
//      Specificity first: an exact merchant is a statement about one merchant,
//      a regex is a statement about a shape.
//   2. SCOPE — a rule naming this `account_id` beats an all-cards rule. The
//      narrower claim wins, which is what makes "Amazon is Misc everywhere, but
//      on the business card it is an Expense" expressible.
//   3. PRIORITY — higher number first. The manual override, for when the
//      structural tiers genuinely tie. Defaults to 0.
//   4. LONGEST MATCH — `UBER EATS` beats `UBER`, so one broad rule plus a
//      narrow exception is a working idiom rather than a trap. (Measured on the
//      normalized needle; a regex has no needle length, so it scores 0 and
//      sorts last among regexes.)
//   5. ID — the final tiebreak, so the answer is deterministic on both machines
//      rather than dependent on row order out of SQLite or merge arrival order.
//
// WHAT IT NEVER DOES. `applyRules` only ever writes a category it was told to
// write. There is no fuzzy fallback, no "looks like a restaurant" inference and
// no learning from the category distribution: a row no rule matches keeps
// whatever the importer's first pass gave it, and is reported in
// `needsCategory` when that first pass was the catch-all. "Leaves the unknown
// ones blank, never guessed" is T30's acceptance criterion, and a guess here
// would be invisible — it looks exactly like a correct answer on screen.

import { normalizeMerchant } from "./card-import-spec.js";

/** The `plan_targets.kind` a rule is stored under. */
export const RULE_KIND = "card_rule";

/** Rank of each match type in precedence tier 1. */
export const MATCH_TYPES = ["exact", "contains", "regex"];
const TYPE_RANK = { exact: 2, contains: 1, regex: 0 };

/**
 * The category a row is given when nothing better is known. A row sitting here
 * with no matching rule is what `needsCategory` reports: it is not wrong, it is
 * unanswered, and the review modal highlights it so the person can answer.
 */
export const CATCH_ALL_CATEGORY = "Misc";

/**
 * A `plan_targets` row → a usable rule, or `null` if it cannot be used.
 *
 * Invalid rules are DROPPED rather than thrown on, and the reason is recorded
 * on the returned object for the editor to show. A bad regex typed into a text
 * box must not be able to break the import preview of a statement that has
 * nothing to do with it — and a rule with an empty `match` would otherwise
 * match every row on the card, which is the most destructive possible failure
 * of a tool whose whole job is to rewrite categories in bulk.
 */
export function compileRule(pt) {
  const d = (pt && pt.data) || {};
  const match_type = MATCH_TYPES.includes(d.match_type) ? d.match_type : "contains";
  const raw = String(d.match ?? "").trim();
  const rule = {
    id: pt.id ?? pt._tempId ?? "",
    owner: pt.owner ?? "shared",
    name: pt.name ?? "",
    match: raw,
    match_type,
    account_id: d.account_id ?? null,
    description: String(d.description ?? "").trim(),
    source: d.source ? String(d.source).trim() : "",
    priority: Number(d.priority) || 0,
    // The decision record the seed file carries, shown in the editor.
    why: d.why ?? "",
    needle: "",
    re: null,
    error: null,
  };
  if (!raw) rule.error = "no match string — a rule that matches everything is never what anyone meant";
  else if (!rule.description && !rule.source) rule.error = "a rule has to set a category or a merchant name";
  else if (match_type === "regex") {
    try { rule.re = new RegExp(raw, "i"); }
    catch (e) { rule.error = `invalid regular expression: ${e.message}`; }
  } else {
    rule.needle = normalizeMerchant(raw);
    if (!rule.needle) rule.error = "the match string normalizes to nothing (punctuation only)";
  }
  return rule;
}

/** Compile a list, keeping only the usable rules. */
export function compileRules(planTargets) {
  return (planTargets || [])
    .filter((pt) => pt && pt.kind === RULE_KIND && !pt.deleted_at)
    .map(compileRule)
    .filter((r) => !r.error);
}

/** Compile a list and keep the broken ones too, for an editor to explain. */
export function compileRulesWithErrors(planTargets) {
  const all = (planTargets || [])
    .filter((pt) => pt && pt.kind === RULE_KIND && !pt.deleted_at)
    .map(compileRule);
  return { rules: all.filter((r) => !r.error), invalid: all.filter((r) => r.error) };
}

/** Does this compiled rule match this normalized merchant? */
export function ruleMatches(rule, normalizedMerchant, rawMerchant = "") {
  if (rule.error) return false;
  if (rule.match_type === "exact") return normalizedMerchant === rule.needle;
  if (rule.match_type === "contains") return normalizedMerchant.includes(rule.needle);
  // A regex is tested against the NORMALIZED string, so `^WHOLEFDS` behaves the
  // same way the other two types do and an author does not have to know which
  // issuer writes `Whole Foods Mkt #10687` and which writes `WHOLEFDS DCT`.
  return rule.re.test(normalizedMerchant) || (rawMerchant ? rule.re.test(rawMerchant) : false);
}

/**
 * The precedence comparator. Negative = `a` wins. Exported so the editor can
 * list rules in the order they will actually be consulted, which is the only
 * honest way to show a rule set whose answer depends on order.
 */
export function compareRules(a, b, accountId = null) {
  const byType = TYPE_RANK[b.match_type] - TYPE_RANK[a.match_type];
  if (byType) return byType;
  const scope = (r) => (accountId && r.account_id === accountId ? 1 : 0);
  const byScope = scope(b) - scope(a);
  if (byScope) return byScope;
  const byPriority = b.priority - a.priority;
  if (byPriority) return byPriority;
  const byLength = b.needle.length - a.needle.length;
  if (byLength) return byLength;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The winning rule for one merchant string, or null.
 *
 * `accountId` is the card the row lands on, and it is what makes tier 2
 * meaningful; pass it whenever it is known. A rule whose `account_id` names a
 * DIFFERENT card never matches at all — scope is a filter first and a tiebreak
 * second.
 */
export function pickRule(rules, merchant, accountId = null) {
  const norm = normalizeMerchant(merchant);
  if (!norm) return null;
  const candidates = (rules || []).filter(
    (r) => (!r.account_id || r.account_id === accountId) && ruleMatches(r, norm, String(merchant ?? ""))
  );
  if (!candidates.length) return null;
  return candidates.sort((a, b) => compareRules(a, b, accountId))[0];
}

/**
 * Apply a rule set to rows, returning a NEW array — never mutating the input,
 * because the import preview re-runs this on every edit in the review modal.
 *
 *   applyRules(rows, rules, { accountId })
 *     → [{ ...row, description, source, _rule, _wasDescription, _changed,
 *          _needsCategory }]
 *
 * Per row:
 *   · a matching rule writes `description` (and `source`, if the rule renames
 *     the merchant — Citi's `DUNKIN 354365 DACULA GA` reading as "Dunkin'" in
 *     the ledger is the point of that field);
 *   · no match leaves both exactly as they were;
 *   · `_needsCategory` is true when the row ended up in the catch-all with no
 *     rule behind it. That is the review modal's `tr.needcat` highlight and the
 *     bulk pass's worklist — the honest "nobody has decided about this
 *     merchant yet" state, as opposed to a decision to call it `Misc`.
 *
 * `rules` may be raw `plan_targets` rows or already-compiled ones; both are
 * accepted so a caller holding the API's response does not have to know.
 */
export function applyRules(rows, rules, { accountId = null, catchAll = CATCH_ALL_CATEGORY } = {}) {
  const compiled = normalizeRuleInput(rules);
  // Rows repeat merchants heavily (41 `UBER TRIP` charges in the real corpus),
  // and the rule set is consulted once per row, so memoize per merchant string.
  const cache = new Map();
  return (rows || []).map((row) => {
    const acct = row.account_id ?? accountId;
    const key = `${acct ?? ""} ${row.source ?? ""}`;
    if (!cache.has(key)) cache.set(key, pickRule(compiled, row.source, acct));
    const rule = cache.get(key);
    const description = rule && rule.description ? rule.description : row.description;
    const source = rule && rule.source ? rule.source : row.source;
    return {
      ...row,
      description,
      source,
      _rule: rule ? { id: rule.id, name: rule.name, match: rule.match, match_type: rule.match_type } : null,
      _wasDescription: row.description,
      _changed: description !== row.description || source !== row.source,
      // A rename-only rule has not answered the category question, so the row
      // still counts as unanswered — `_rule` is set, `_needsCategory` stays true.
      _needsCategory: !(rule && rule.description) && (!description || description === catchAll),
    };
  });
}

function normalizeRuleInput(rules) {
  if (!rules || !rules.length) return [];
  // A compiled rule always carries `match_type` AND one of needle/re/error.
  return "needle" in rules[0] || "re" in rules[0] ? rules.filter((r) => !r.error) : compileRules(rules);
}

/**
 * The `plan_targets` body for "always categorize WHOLEFDS as Groceries" —
 * what the review modal offers when someone fixes a category by hand, and what
 * the bulk pass writes per decision.
 *
 * Defaults to `contains` on the row's own normalized merchant, which is the
 * right default for the real data: almost every merchant string in the corpus
 * carries a store or order id, so an `exact` rule learned from one row would
 * match that one row forever (`AMAZON MKTPL BS65S0XP0` never recurs). Narrowing
 * is a deliberate choice the editor offers, not the default.
 */
export function ruleFromRow(row, description, { accountId = null, owner = "shared", matchType = "contains", source = "", priority = 0, match = null } = {}) {
  const needle = match != null ? String(match).trim() : normalizeMerchant(row.source);
  return {
    owner,
    kind: RULE_KIND,
    name: needle,
    data: {
      match: needle,
      match_type: matchType,
      account_id: accountId,
      description,
      source,
      priority,
    },
  };
}

/**
 * Count what a rule set does to a body of rows: how many rows each rule claims
 * and what is left unanswered. The bulk pass's report and the Credit subtab's
 * rule list both read this — a rule that matches nothing is the commonest
 * mistake (a typo'd needle, or a merchant that only ever appeared once) and it
 * is invisible unless something counts.
 */
export function ruleCoverage(rows, rules, { accountId = null } = {}) {
  const compiled = normalizeRuleInput(rules);
  const applied = applyRules(rows, compiled, { accountId });
  const byRule = new Map(compiled.map((r) => [r.id, { rule: r, rows: 0, amount: 0 }]));
  let matched = 0, changed = 0, needs = 0, needsAmount = 0;
  for (const r of applied) {
    const amt = (Number(r.withdrawal) || 0) - (Number(r.deposit) || 0);
    if (r._rule) {
      matched++;
      const e = byRule.get(r._rule.id);
      if (e) { e.rows++; e.amount = Math.round((e.amount + amt) * 100) / 100; }
    }
    if (r._changed) changed++;
    if (r._needsCategory) { needs++; needsAmount = Math.round((needsAmount + amt) * 100) / 100; }
  }
  return {
    total: applied.length,
    matched,
    changed,
    needsCategory: needs,
    needsCategoryAmount: needsAmount,
    unused: [...byRule.values()].filter((e) => e.rows === 0).map((e) => e.rule),
    perRule: [...byRule.values()].sort((a, b) => b.amount - a.amount),
    rows: applied,
  };
}
