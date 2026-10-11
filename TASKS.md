# TASKS — Phase 10: Conscious Spending Plans (CSP)

Working task board for the CSP feature. Design/spec lives in
**[ROADMAP.md §8](ROADMAP.md)** (+ the Phase 10 roadmap entry and the `csp_plan` /
`csp_item` data-model note); this file is the execution plan: what gets built, in
what order, and **which model should do each piece**.

## Goal (one paragraph)

A **Spending Plan** view — a *sibling of the Plan tab*, reached from a switch button on
each or from a dropdown under the **Plan** nav item (see *Resolved decisions*) — that
renders one section per Conscious Spending Plan (one per person, plus an optional
household plan), where every CSP number is editable and saved
explicitly, and every line that can be cross-referenced against the ledger shows
**target vs. actual as a monthly average over a user-chosen window** — the window
being picked with the *same* timeframe control the Ledger already uses. Clicking a CSP
line expands it into the real ledger rows/categories that produced its actual, and the
catch-all bucket shows an **Unassigned** row so the comparison reconciles to the real
total (see resolved decision #6).

## How the work is split

- **Opus** takes anything where a wrong early choice is expensive: the refactor of the
  Ledger's timeframe control (a hot path used daily), the new shared compute semantics
  (averaging, match rules, to-date vs. projected), and the drill-down interaction.
- **Sonnet** takes the well-specified work that mirrors an existing template in this
  repo: page scaffolding/CSS, CRUD + staged-save wiring modeled on `plan.js`, seed
  scripts, published-view parity, deep-link params, docs.

## Dependency order

```
T0 (spec freeze) ✅ done
 ├─ T1 shared timeframe  ─┐ ✅ done
 ├─ T2 shared/csp.js     ─┤ ✅ done
 └─ T3 data + seed  ──────┴─ T4a page scaffold ─ T4b wire compute/drilldown ─┬─ T6 published parity ─ T8 docs
    ✅ done                   ✅ done              ✅ done       T5 ledger deep links ┘      ✅ done      ✅ done
                                                          ✅ done                     T7 dashboard strip ✅ done
```
**T0–T6 and T8 are done — the feature works end to end, locally and published, and is
documented.** A shared timeframe control a page can mount in a few lines, a verified
compute engine, the CSPs seeded in the database, a Spending Plan page that is both fully
editable and fully wired (every target, actual, Δ and status pill from `shared/csp.js`
over the chosen window, drill-down into the ledger rows behind each line, "View in
Ledger" pre-filtered), a read-only published parity page at `/csp.html`, and README/
ROADMAP updated to match. **Every task in this phase, T7 included, is now done.**

## Conventions that apply to every task

- `export PATH="/opt/homebrew/bin:$PATH"` before any `node`/`npm` (not on PATH in
  non-interactive shells). Node 26 → built-in `node:sqlite`, **no** `.transaction()`
  helper (manual `BEGIN`/`COMMIT`/`ROLLBACK`).
- **Never auto-save.** Stage edits in memory, recompute derived values live, commit on
  **Save**, revert on **Discard**, guard `beforeunload` while dirty.
- **N people, not two.** Everything iterates the `people` list; `owner` is a person id
  or `shared`. One person ⇒ one section, no special-casing.
- `shared/*.js` must stay dependency-free and run in **both** browser and Node (it is
  copied into `docs/shared/` on publish and imported by the static site).
- Seeded/placeholder rows get `updated_at = epoch` so they always lose the LWW merge.
- Verify in the real app (headless Chrome screenshot + CDP interaction, as used in
  earlier phases), not just by reading code. The DB is shared with the user's
  `npm start` on :3000 — balances can shift mid-session; that's not a bug.

---

## T0 — Ingest the uploaded CSPs, freeze the spec · **Opus** — ✅ **done (2026-10-06)**

Both CSPs (`Woody CSP 2026.pdf`, `Rajna CSP 2026.pdf`) ingested and cross-referenced
against the live `local/dashboard.db`. Outputs:

- **`local/csp-seed.json`** — the frozen seed payload T3 consumes: 2 plans, 35 items,
  stable ids (`csp-<plan>-<slug>`), no id collisions.
- **ROADMAP §8 + the data-model note** rewritten with the final field shapes, the
  derived-percentage rule, match precedence, the exclusion set, and the card-spend
  blind spot.
- Reconciliation verified to the cent for **both** people over **two** window shapes
  (trailing 12mo, and Sep–Dec 2026 crossing today):
  `ledger outflow − excluded rows == Σ bucket actuals`.

### The three-way list

**(a) Confidently mappable — 25 items.** Woody: Insurance (`Progressive Car
Insurance`), Car/Transportation (`Car Note`,`Car Registration`,`Car Ticket`), Debt
Payments (categories `Credit Card Payment`,`Loan Payment`), Rajna Assistance Program
(5 `Rajna *` sources), Subscriptions (5 sources), Miscellaneous (categories
`Misc`,`Expense`), all 3 Investments lines, all 4 Savings lines. Rajna: Rent, Utilities,
Parents, Debt Payments, Groceries, Taxes Payment Plans, Subscriptions, Miscellaneous,
Transportation, Retirement, Emergency Fund.

**(b) Mappable, but the ledger needs a cleanup pass** *(all four are handled today by
matching on `source` rather than `description`, so none of them block Phase 10 — but
they should be fixed in the Ledger):*
1. **`Iphone Upgrade Program` vs. `iPhone Upgrade Program`** — same payee, two casings
   (6 rows / 1 row). Match rules are case-sensitive.
2. **`Fundrise` is filed under both `Savings` and `Investments`** — $40 and $10 in the
   trailing year. The CSP's *Real Estate* line matches by source to survive it.
3. **`Ammu` is filed under both `Transfer` and `Parents`** — $2,400 and $400.
4. **One Woody row has an empty `description`** (source `Misc`, $69.76) — currently
   falls into the catch-all.

**(c) Not cross-referenceable — 4 target-only items.** Woody's **Utilities** ($0),
**Groceries** ($200) and **Phone** ($66), and Rajna's **Stocks** ($0). Woody's three are
blocked by the card-payment granularity blind spot (ROADMAP §8); Rajna has no brokerage
activity yet. These render *target only — not tracked*, never a misleading $0.

Two PDF lines were **not seeded**: Rajna's *Insurance* and the template's *"Add your own
here"* — blank target, no matching ledger activity.

### What the numbers actually say (trailing 12 months)

| | target | actual avg | verdict |
|---|---|---|---|
| Woody — Debt Payments | $2,000 | **$2,582** | over by $582/mo |
| Woody — Fixed Costs | $4,124 (85.5%) | $3,590 (74.5%) | under |
| Woody — Investments | $210 | $158 | under by $52/mo |
| Woody — Savings | $300 | $380 | ahead |
| Rajna — Debt Payments | $500 | **$772** | over by $272/mo |
| Rajna — Rent | $1,335 | $1,025 | partial-year history |
| Rajna — Groceries | $150 | $20 | her food spend is dining, not groceries |
| Rajna — Guilt-Free | $335 | $145 | under |

Both plans overshoot their debt-payment line and undershoot investing — the single
clearest signal the feature will surface on day one.

## T1 — Extract the Ledger's timeframe control into a shared module · **Opus** — ✅ **done (2026-10-06)**

Today the timeframe UI and its preset math live inside `local/public/app.js`
(`presetWindow()` at ~L214, `applyPreset`, `resetFilter`, `updateFilterSummary`,
`#fPreset`/`#fFrom`/`#fTo` markup in `local/public/index.html` ~L297) and depend on
`payAnchor()` (people + ledger state) and `shared/paycycle.js`.

- New **`shared/timeframe.js`** — pure, browser+Node: `PRESETS` (the existing 14
  options, same keys/labels/order) and `presetWindow(key, {today, cadence, anchor})`
  → `{from, to}`. The `3paychecks` preset keeps delegating to `paycycle.js`.
  Add `monthsInWindow({from, to}, {fallbackFrom, fallbackTo})` here (T2 consumes it)
  so one definition of "how long is this window" serves every surface.
- New **`local/public/timeframe-ui.js`** — mountable control: funnel toggle + preset
  `<select>` + From/To + the "Displaying …" summary chip, emitting `onChange({from,
  to, preset})`. Markup/CSS lifted from the Ledger so both look identical.
- Refactor the Ledger to consume both. **Zero behavior change** — this is the most-used
  page: same default (`3paychecks`), same Clear behavior, same summary text, Category/
  Source facets untouched (they stay Ledger-only; CSP needs the timeframe part only).

**Done when:** the Ledger behaves identically before/after (presets, custom range,
Clear, summary chip, balance-as-of tooltip), and a second page can mount the control
in a few lines. Screenshot-verify the Ledger.

**Watch for:** `presetWindow` currently closes over `state`; the shared version must be
parameterized. `3paychecks` anchors on the person's most recent *paycheck* row — keep
that, including the no-paychecks-yet fallback to today.

### What shipped

**`shared/timeframe.js`** — `PRESETS` (14, same keys/labels/order), `DEFAULT_PRESET`
(`"3paychecks"`), `presetLabel(key)`, `presetWindow(key, {today, cadence, anchor})`,
`payAnchor(transactions, {person, today})` (the cadence+anchor pair, lifted out of
`app.js` so both callers resolve it the same way), plus the window-length helpers T2
needs: `daysInWindow`, `monthsInWindow(win, {fallbackFrom, fallbackTo})`,
`DAYS_PER_MONTH` (30.4375) and `MIN_MONTHS` (0.25 — below ~a week, "per month" is
noise, so a one-day window can't multiply one transaction into a 30× average).

**`local/public/timeframe-ui.js`** — `mountTimeframe(host, {context, onChange,
defaultPreset, storageKey, presetStorageKey, summaryExtra})` → `{el, slot, value(),
applyPreset(key, {silent}), set({from,to,preset}, {silent}), clear(), setOpen(),
isOpen(), refreshSummary()}`. Two things worth knowing before T4b mounts it:

- **`slot`** is a `display: contents` span inside the filter row. Host-specific
  controls appended there lay out as if they were direct children of the flex row —
  that's how the Ledger's Category/Source facets, Clear and row count still sit on the
  same line. The Ledger keeps them in an inert `<template id="ledgerFacets">` in the
  markup and does `tf.slot.appendChild($("#ledgerFacets").content)` after mounting.
- **The CSS ships inside the module** (injected once, `tf-`prefixed, depending only on
  the page's palette vars), so a new page needs no stylesheet of its own to match the
  Ledger. The Ledger's old `#filterPanel` / `.filter-head` / `.filters` / `.icon-btn`
  rules were deleted rather than left to drift.
- `context` is a **callback**, re-resolved on every preset application, so
  `3paychecks` follows the person's latest paycheck as rows are added.
- `presetStorageKey` (opt-in) persists the chosen preset per page — T4b wants it, the
  Ledger deliberately doesn't use it (a fresh account resets to the default).

**Also done here, not deferred to T6:** the publish block in `local/server.js` is now
two **lists** (page scripts, then pages+shims) instead of one line per file. It had to
be: the Ledger now imports `timeframe-ui.js`, and a publish that didn't copy it would
404 the import and render the published Ledger blank. T6 just appends to the lists.

**Verified** — a Node harness compared the new `presetWindow` against the pre-refactor
implementation over all 14 presets × 4 cadences × 4 anchors: **identical**, plus 1,200
days of `addMonths` clamping (incl. the leap day). Then headless Chrome on the real
Ledger: every preset's window/chip/row-count/balance-as-of, a hand-typed custom range
flipping the preset to `custom`, a facet selection showing as `· 1 filter`, Clear
wiping to All time, and the open/closed state surviving a reload — **no console
errors, and visually indistinguishable from before**. The published view was checked
too (`/site/ledger.html` off a regenerated snapshot): imports resolve, 67 rows, same
chip, Save still hidden.

## T2 — `shared/csp.js` — the compute engine · **Opus** — ✅ **done (2026-10-06)**

Pure, browser+Node, no DOM. Mirrors the role `shared/drift.js` plays for plan targets.

```
computeCsp({ transactions, accounts, people, cspPlans, cspItems, window, asOf })
  → { plans: [ { planId, owner, takeHome, buckets: [ {
        bucket, targetMonthly, targetPct, actualMonthly, actualPct, delta, status,
        items: [ { itemId, name, targetMonthly, actualMonthly, delta, status,
                   tracked, matched: [ledger rows], groups: [{label, amount, count}],
                   toDate, projected } ],
        unassigned: { actualMonthly, groups } } ] } ] }
```
Semantics to get right (these are the whole point of the task):

- **Averaging.** `actualMonthly = matchedTotal / monthsInWindow`. Use the fractional
  month length from `shared/timeframe.js` (window days ÷ 30.4375) so paycheck-shaped
  windows aren't biased; clamp to a sane minimum. Open window (`all`) falls back to the
  ledger's own first/last dates. Monthly-average is the canonical unit; the UI may also
  derive a per-paycheck figure from `pay_cadence`.
- **Matching.** An item matches a transaction when its `sources[]` contains the row's
  `source` **or** its `categories[]` contains the row's `description` (OR within a
  rule). Withdrawals only, live rows only, scoped to the plan owner's accounts
  (`owner`/`shared`). Define and document precedence when two items match the same row
  (first-wins by bucket order, and surface a "matched by N items" warning) — no
  double-counting.
- **Unassigned.** Per plan: windowed outflow on the owner's accounts matching no item,
  grouped by `description`+`source`. Decide and document whether internal-transfer
  categories (`Savings`/`Investments`/`Credit Card Payment`/`Loan Payment`/`Transfer`,
  the `NON_SPEND` set in `metrics.js`) land in their mapped bucket or are excluded —
  CSP buckets *do* include savings/investing/debt, so this differs from
  `monthlySpend()` and must not silently reuse that filter.
- **To-date vs. projected.** Split matched rows at `asOf`; report both. A window ending
  in the future returns `projected: true` so the UI can label it.
- **Status.** `good/warn/bad` thresholds consistent with `drift.js`, but **direction-
  aware**: overspending a Fixed-Cost/Guilt-Free target is bad while *under*spending is
  fine; under-funding Savings/Investments is bad while over-funding is good.

**Done when:** a Node harness runs the engine over the real `local/dashboard.db` and
the numbers are hand-reconciled against SQL sums for at least one item per bucket, both
people, and two window shapes (a past window and one crossing today).

### What shipped — and the calls T4b needs to know about

Exports: `computeCsp(...)`, `statusFor(actual, target, direction)`, `itemTarget(data,
takeHome)`, `worstStatus(list)`, `CSP_EXCLUDE`, `BUCKET_DIRECTION`.

- **Account scoping is owner-*exact*, not "mine plus shared".** A plan sees only the
  accounts whose `owner` equals its own; a `shared` plan sees the `shared` accounts.
  "Mine plus shared" would count every joint dollar once per person and break the
  reconciliation identity. (Moot today — there are no shared accounts — but it is the
  rule the renderer should assume.)
- **Field names.** `toDate` / `projected` are **dollar amounts** (they sum to `total`)
  on items, buckets and the plan. The boolean is `windowProjected`, with
  `projectedShare` (0–1) beside it for the "X% projected" label. `months` is the
  **exact float**, not rounded — every average divides by it, so rounding it here
  would break `actualMonthly × months === total`. Format it in the UI (`.toFixed(1)`).
- **Untracked items** (no `sources` *and* no `categories`) get `tracked: false`,
  `actualMonthly: null`, `delta: null`, `status: "untracked"` — never a misleading $0.
- **Status thresholds.** `fund` direction mirrors `drift.js` exactly (≥95% good, ≥75%
  warn); `spend` is its reflection (≤105% good, ≤125% warn). Direction comes from
  `BUCKET_DIRECTION` (`fixed`/`guilt_free` → spend, `investments`/`savings` → fund),
  defaulting to `spend` for an unknown bucket.
- **`rec_pct` is advisory and reported separately** as `recStatus`
  (`"below"`/`"within"`/`"above"`), so the pill can hint at the template's recommended
  range without it ever being mistaken for the target (decision #4).
- **Rule overlaps are surfaced, not hidden.** Each row still counts exactly once (the
  decision-#7 winner), but `plan.conflicts[]` lists every multiply-matched row
  (`{date, category, source, amount, wonBy, alsoMatched[]}`) and each item carries a
  `conflicts` count. On the real data this is 34 rows for Woody over the trailing year
  — all of them "Rajna Assistance Program" or "Car Payment" correctly beating the
  category-based "Debt Payments". Worth showing as a quiet warning in T4a's match-rule
  cell, since it's the signal that a rule needs tightening.
- **`reconciles`** recomputes the T0 identity on every call (`Σ buckets + excluded ==
  windowed outflow`), next to `windowOutflow`. Cheap assertion for the UI to lean on.
- **Buckets also expose `itemsTargetMonthly`** (the plain sum of their items)
  alongside `targetMonthly`, which differs only for the catch-all (whose target is the
  residual). Lets the UI show both if a user ever puts a target on a Guilt-Free item.

**Verified** — `local/check-csp.js` (kept in the repo, `npm run check:csp`, read-only)
runs the engine over the real `local/dashboard.db` across **four** window shapes
(trailing 12mo, Sep–Dec 2026 crossing today, the `3paychecks` default, and fully open)
× both people, and checks against independent SQL: windowed outflow, `Σ buckets +
excluded == outflow`, one item per bucket vs. its own SQL sum, `monthly == total /
months`, `toDate + projected == total`, `Σ groups == total`, every matched row counted
exactly once, exactly one catch-all, and the eight direction-aware status cases.
**All pass**, and every figure in T0's reference table reproduces to the cent
(Woody debt $2,582 / fixed $3,590 / investments $158 / savings $380; Rajna debt $772 /
rent $1,025 / groceries $20 / guilt-free $145).

`npm run check:csp -- --db` reads the seeded `plan_targets` rows instead of
`csp-seed.json`, which is how T4b should confirm the page agrees with the engine.

## T3 — Data model, persistence, seed · **Sonnet** — ✅ **done (2026-10-06)**

- **No schema change.** `csp_plan` / `csp_item` are new `plan_targets.kind` values and
  flow through the existing CRUD (`local/server.js` L172–210) and `snapshot.json`
  untouched. Verify end-to-end: POST/PATCH/DELETE both kinds, confirm `data` JSON
  round-trips, confirm they appear in a `{push:false}` publish and survive
  `/api/refresh` LWW merge.
- Confirm nothing filters `plan_targets` by kind in a way that would silently drop the
  new kinds — notably `shared/drift.js` (`computeDrift` must ignore them, not treat
  them as debts/goals), `local/public/plan.js` `SECTIONS`, and
  `shared/dashboard-render.js` (`PLAN_FIELD`, the three `driftSection` filters).
- **`local/seed-csp.js`** — loads the T0 payload: `--replace` re-seeds idempotently,
  stable ids (`csp-<plan>-<slug>`), seeded rows stamped `updated_at = epoch`. Add an
  `npm run seed:csp` script. Model it on `local/seed-plan-targets.js`.

**Done when:** `node local/seed-csp.js --replace` twice in a row yields identical rows,
`GET /api/plan-targets` returns them with parsed `data`, and the Plan tab + Dashboard
are visibly unaffected.

### What shipped

**No schema change, and no new plumbing was needed** — confirmed by reading every
consumer, then by exercising it:

- `local/server.js` plan-target CRUD is entirely kind-agnostic (POST takes any `kind`;
  PATCH/DELETE work by id), and so are `docs/mock-api.js`'s routes and
  `shared/snapshot.js`.
- `shared/drift.js` `computeDrift` **already ignores** the new kinds: an unrecognised
  kind falls past the `savings_goal` branch and matches neither `investment_cadence`
  nor `debt_payoff`, so it emits nothing. Nothing to change.
- `shared/dashboard-render.js` feeds `planTargets` only into `computeDrift` and then
  filters the *drift results* by kind, so `PLAN_FIELD` and the three `driftSection`
  calls can't see a CSP row.
- `local/public/plan.js` loads every kind into `state.targets` but renders only the
  three in `SECTIONS`, and its save loop touches only `_new` / `_dirty` rows — so CSP
  rows are read and ignored, never rewritten. (`recurring_allocation` already proved
  this path tolerates extra kinds.)

**`local/seed-csp.js`** — `npm run seed:csp` (insert missing only), `-- --replace`
(re-apply the file, including clearing a `deleted_at` so the DB matches the file), and
`-- --dry-run` (print the plan, write nothing). It validates the payload before
touching the DB — duplicate ids, unknown kinds, orphaned `plan_id`, a `bucket` the
plan doesn't declare, and the decision-#6 invariant of exactly one `catch_all` per
plan — and fails loudly rather than corrupting a real plan. Writes run in a manual
`BEGIN`/`COMMIT`/`ROLLBACK` (node:sqlite has no `.transaction()`). All 37 rows are
stamped `created_at = updated_at = epoch`, so they always lose the LWW merge.

**Verified** — 37 rows seeded (2 plans + 35 items); a second and third `--replace`
report `0 insert, 0 update, 37 unchanged` and leave the rows **byte-identical**; all
37 stamps are the epoch. Then end-to-end against the running server: `GET` returns
parsed `data` (nested `buckets` array intact), `?kind=` and `?owner=` filter correctly,
POST/PATCH/DELETE round-trip **both** kinds with their nested data verbatim, a PATCH
bumps `updated_at` above the epoch (so a real edit beats the seed), a `{push:false}`
publish carries them into `snapshot.json`, `/api/refresh`'s LWW merge produces no
duplicates and leaves a locally-edited row alone, and DELETE tombstones them out of
`GET`. Finally, headless Chrome on `plan.html` and `dashboard.html`: same three
sections, same tile values, no console errors, Save still disabled, and no CSP text
anywhere — **visibly unaffected**, as required.

_(The `{push:false}` publish and the API probe rows were test artifacts: `docs/` was
restored from git and `sync_meta` reset to v15 afterwards, so the only lasting change
is the 37 seeded rows.)_

## T4a — Spending Plan page scaffold + editing + staged save · **Sonnet** — ✅ **done (2026-10-06)**

`local/public/csp.html` + `local/public/csp.js`, modeled closely on
`local/public/plan.html` + `plan.js` (same dark palette, header, nav, toast, dirty
note, Save/Discard).

- **Nav + Plan/Spending-Plan switcher** (per the resolved placement decision): `Plan`
  and `Spending Plan` are two mutually exclusive views that never render each other's
  content.
  - Keep them as **two page files** (`plan.html`, `csp.html`) rather than one toggled
    page: independent Save staging, simpler publish/mock-api wiring, deep-linkable.
  - Add a small shared switcher (segmented control: `Plan targets | Spending Plan`) at
    the top of **both** pages, so each links to the other.
  - The **Plan** nav item gets a **hover dropdown** listing both views (keyboard- and
    touch-accessible too: focus-within + click-to-open fallback). Build it once as a
    tiny shared snippet and drop it into the nav of all five pages (`index.html`,
    `paycheck.html`, `plan.html`, `dashboard.html`, `csp.html`) so the nav stays
    identical everywhere; the `Plan` item stays `active` for either sub-view.
- One `<section>` per CSP plan: header with the owner avatar(s) (reuse `ownerPicker` /
  `avatarHTML` patterns), editable **take-home**, then one sub-table per bucket with
  its items. Columns: name · target · (placeholders the T4b wiring fills: actual avg ·
  Δ · status) · match rule · row actions.
- Editable: take-home, bucket target % (and/or $), item target, item name, item match
  rule. **Reuse the chip/typeahead multi-select from `plan.js` `sourcesField()`** for
  sources, and an equivalent for categories (datalist of distinct ledger
  `description`s). Add/remove item, add/remove bucket, add plan.
- Staging: `_new`/`_dirty`/`removed` exactly as `plan.js`; `Save plan` → POST/PATCH/
  DELETE `/api/plan-targets`; `Discard` → reload; `beforeunload` guard while dirty;
  row tinting for new/edited.

**Done when:** every CSP value can be edited, nothing writes before Save, Discard fully
reverts, a reload shows the saved values, and the page renders correctly with 1 plan and
with 3 plans. Screenshot-verify.

### What shipped

**`local/public/csp.html` + `csp.js`** — same dark palette/header/toast/dirty-note/
Save-Discard chrome as `plan.html`. One `<section>` per `csp_plan` row, sorted by the
owner's position in `people` (a `shared` plan always sorts last) _(this page later went
personal-scope — see decision #3's reversal — so in practice at most one section ever
renders: the current person's own)_; each section has an
editable name, a **single-select** owner picker (person avatars + a "Household" option
— CSP plans belong to exactly one owner, unlike `plan_targets`' multi-owner debts/
goals) _(removed 2026-10-06 — see decision #3's reversal below: the page went
personal-scope, so there's nothing left to switch between)_, editable take-home/
gross-monthly, and an editable net-worth row
(assets/investments/savings/debt). One sub-table per bucket, in `sort_order`: editable
label, editable `rec_pct` range, a radio-style "catch-all" picker (selecting one
un-sets the others; deleting the catch-all auto-promotes the next bucket and toasts
about it), a running target-sum line, and + Add item / + Add bucket / + Add plan.

- **Item target** is a `$`/`%` toggle plus one number input; the *other* basis is shown
  live as a derived "≈" hint using `shared/csp.js`'s pure `itemTarget()` — the only
  piece of the compute engine this page touches. The Actual avg / Δ / Status columns
  are explicit placeholders (`—`, a muted "pending" pill) for T4b to fill; an item with
  no `sources`/`categories` already shows *target only — not tracked* / an "untracked"
  pill, since that fact doesn't need the compute engine to know.
- **Match rule** is two stacked chip fields (Sources / Categories), both built from one
  generalized `tagField()` (plan.js's `sourcesField()`, parameterized over which
  `data[]` key and which `<datalist>` backs it) — sources from distinct ledger
  `source`s (as `plan.js` already does), categories from distinct ledger
  `description`s (new datalist, `#allCategories`).
- **Staging** mirrors `plan.js`: `_new`/`_dirty`/`removed`, tinted rows, `Save plan` →
  POST new-plans-first (so new items can adopt the real plan id before their own POST)
  → PATCH dirty → DELETE removed, `Discard` → reload, plus a `beforeunload` guard while
  dirty (present on the Ledger/This-Paycheck but missing from `plan.js` today — added
  here since the task calls for it explicitly). A new plan with no owner chosen blocks
  Save with a toast rather than posting an invalid row.
- **New plan/item linking.** A new plan has no server id until Save, so its items
  reference it by a client-side `_tempId` in `data.plan_id`; once the plan's POST
  returns a real id, every item still pointing at the temp id is rewritten to the real
  one (and marked dirty) before its own POST/PATCH runs.
- **Nav + switcher (resolved decision #1).** New `local/public/nav-plan.js` —
  CSS-in-module like `timeframe-ui.js` — replaces the static `Plan` nav link with a
  hover/focus-within dropdown (tap-to-toggle on touch) listing *Plan targets* and
  *Spending Plan*; it no-ops if it can't find the link, so it's safe to call from every
  page unconditionally, including the published build where `docs/mock-api.js` rewrites
  the nav to a Plan-free set. Mounted from all five entry scripts (`app.js`,
  `paycheck.js`, `dashboard.js`, `plan.js`, `csp.js`). New `local/public/view-switch.js`
  renders the segmented *Plan targets | Spending Plan* control (hides itself if given
  fewer than two views — T6's hook for the published site) into a `#viewSwitch` span
  added to both `plan.html` and `csp.html`'s headers.
- `local/server.js`'s publish copy-list gained `nav-plan.js` (same reasoning as T1's
  `timeframe-ui.js`: `app.js`/`paycheck.js` now import it, so a publish that didn't
  copy it would 404). `view-switch.js` isn't on the list — nothing published imports it
  yet (`plan.html` stays local; `csp.html`'s publish wiring is T6's job).

**Verified** — Playwright (via `npx playwright`, Chrome channel, no browser download
needed) against the real running server/DB: both seeded plans render with all 4
buckets and all 35 items, the Plan nav dropdown and view-switch appear correctly on
every one of the five pages with no new console errors (the one pre-existing
`favicon.ico` 404 is unrelated). Edited a target, saw Save enable with `*` and the
dirty note appear; added and removed an item row; added a third plan section (owner
picker, default 4-bucket template); **Discard** on all of it brought the page back to
the original 2 plans / 35 items with Save disabled again — confirming nothing was
written, since Save was never clicked and the shared DB is unchanged.

## T4b — Wire the compute engine, timeframe control, and drill-down · **Opus** — ✅ **done (2026-10-06)**

- Mount the T1 timeframe control at the top of the page (default `3paychecks`, same as
  the Ledger; persist the choice in `localStorage` per page) and recompute on change.
- Fill the comparison columns from `shared/csp.js`: `target /mo`, `actual avg /mo`, Δ
  (with direction-aware color), status pill. Bucket rows roll up their items and show
  **actual % of take-home vs. target %**; plan header shows overall status. Untracked
  items render as *target only — not tracked* rather than a misleading $0 actual.
- **Click to expand** any item (and the bucket's **Unassigned** row): a dropdown panel
  listing the contributing ledger rows grouped by category/source with amount, count
  and share, a *to-date vs. projected* split when the window crosses today, and a
  "View in Ledger" link carrying the window + facets (needs T5).
- Label the window honestly: *"averages over <window>, N.N months · X% projected"*.

**Done when:** numbers match the T2 harness for the same window, changing the timeframe
updates every row, expansion shows real ledger rows that sum to the row's total, and the
Unassigned row plus the item rows account for the window's full outflow. Screenshot-
verify both people and a projected window.

### What shipped

All in `local/public/csp.js` + `csp.html` — no change to `shared/csp.js`, `shared/
timeframe.js`, `timeframe-ui.js`, `app.js` or the server. T1/T2/T5 had left exactly the
seams this needed.

**The engine runs on the *staged* rows, not the saved ones.** `recompute()` feeds
`computeCsp()` the in-memory `state.plans`/`state.items` (a new row keyed by its
`_tempId`, the same key its items' `data.plan_id` already points at), so adding a
category chip to an item immediately pulls that outflow out of Unassigned and into the
item, re-rolls its bucket, and re-colors the plan — all before Save. That required
separating *repaint* from *re-render*: `render()` registers one updater closure per
derived cell in a `derived[]` list, and `refreshNumbers()` re-runs the engine and
replays them. Nothing rebuilds an `<input>`, so the chip field you are typing in keeps
focus (verified). `markDirty()` now calls `refreshNumbers()`; a `rendering` flag keeps
`ensureCatchAll()`'s mid-render `markDirty` from replaying a half-built page.

**Timeframe.** `mountTimeframe` into a new `#timeframe` div above the sections, with
`presetStorageKey: "cspPreset"` — the Spending Plan remembers the window you were last
comparing over, while the Ledger deliberately still resets to the default. One control
yields one window for a page whose plans may have *different* cadences, so the
`3paychecks` anchor is made explicit rather than hidden: it follows the header chip's
person (scoped to that person's accounts), and the chip says so — *"Displaying 3
paychecks · 1.4 months · Woody's pay cycle"*. The months figure is on the chip only for
a **closed** window; an open one ("All time") is as long as each plan's own ledger, so
that number lives on the plan instead (Woody 36.1 months, Rajna 22.6).

**Honesty line, per plan.** `averages over 3 paychecks · 2026-09-17 – 2026-10-29 · 1.4
months · 1 reconciliation row excluded · 49% projected`. The projected clause only
appears when the window actually runs past today, and the engine's own `reconciles`
flag is surfaced as a red line if the buckets + excluded ever stop summing to the
window's outflow — rather than quietly showing numbers that don't add up.

**Drill-down.** The Actual-avg cell *is* the toggle (a caret button; the name cell
couldn't be, it holds a text input). The panel carries: window total, monthly average,
row count, a to-date/projected split when the window crosses today, a by-category/source
table (amount, /mo, rows, share), and the contributing ledger rows themselves, newest
first, with future-dated rows tinted amber. Rows are capped at 60 with an explicit note
that the grouped totals above still cover all of them — a silent truncation would read
as "this is everything". The catch-all bucket gets an **Unassigned** row with the same
panel; the engine returns Unassigned as groups rather than rows, so the row list is
rebuilt by subtraction (the owner's windowed non-artifact outflow minus every row an
item claimed) — the engine's own definition, immune to the `category+source` group-key
collision a string-match reconstruction would have.

**"View in Ledger".** The Ledger ANDs its Category and Source facets while a match rule
ORs them, so an item's rule can't be handed over verbatim. What can: the distinct
category/source values that actually *contributed*. Every contributing row satisfies
`category IN (...) AND source IN (...)`, so the Ledger shows a **superset** — never less
than the panel claims (confirmed: 0 of the panel's rows missing on 4 links; two links
showed one extra row, which is the documented superset). The link passes the resolved
`from`/`to` rather than `?preset=`, because the Ledger would re-derive a `3paychecks`
window from *its* person's paychecks and land on a different range. An empty category or
source can't be expressed as a URL param, so that facet is dropped entirely rather than
silently hiding its own rows.

**Layout.** `table-layout: fixed` with explicit column widths — the match-rule chips
were taking every spare pixel and squeezing item names down to "Car Payme". The bucket
roll-up moved onto its own line under the bucket's controls; at ~90 characters it was
pushing the delete button onto a line of its own.

**Verified** against the real running server/DB, Playwright + Chrome:

- **235 value-by-value comparisons** (plan/bucket/item target, actual, Δ, status pill,
  bucket target% and actual%, Unassigned amount and row count, both people) against an
  **independent Node run of the engine over the same window**, across five window
  shapes (`3paychecks`, `last90`, `next90`, `thisyear`, `all`) — **all match**. Woody's
  `3paychecks` figures also match `npm run check:csp --db` line for line.
- **All 25 drill-down panels** (both people): the group table and the raw-row list each
  sum **exactly** to the panel's window total, and the row counts agree three ways
  (claimed / Σ group counts / rows listed).
- Every bucket's actual = Σ its item rows + Unassigned; every plan's actual = Σ its
  buckets; every plan's target = Σ its bucket targets; no reconciliation warning.
- Changing the timeframe updates every row, roll-up, note and chip; an **open panel
  follows the window** (including showing "No ledger rows here in the current window."
  for a window where the item has none, instead of yanking the expansion away).
- The staged-edit path: adding `Bill` to Woody's Subscriptions moved $308.47/mo out of
  Unassigned into it and flagged the ⚠ overlap with Insurance (which wins on its source
  rule); take-home 4822 → 6000 re-based every percentage while the `$` targets held;
  **Discard** restored all of it with Save disabled — nothing written.
- Zero console/page errors on all five pages; the Ledger still opens on its own default
  (`3 paychecks`, 67 rows), unaffected by the new per-page preset key.

**Known gap, by design:** an item with a rule but no rows in the window shows `$0.00`
and an enabled-but-empty panel. That is the honest reading — the money genuinely wasn't
spent — and is distinct from the *untracked* case (no rule at all), which still renders
*target only — not tracked*.

## T5 — Ledger deep-link params · **Sonnet** — ✅ **done (2026-10-06)**

The Ledger already honors `?user=` / `?account=`. Add `?from=`, `?to=`, `?preset=`,
`?category=` and `?source=` (repeatable/comma-separated, feeding the existing
multi-select facet sets) so the CSP drill-down's "View in Ledger" lands pre-filtered.
Params override the default timeframe; absent params keep today's behavior.

**Done when:** a hand-built URL with each param lands on the expected filtered view and
the summary chip reflects it; no param ⇒ unchanged default.

### What shipped

All in `local/public/app.js` — no server/shared changes needed, since the timeframe
control (T1) already exposes `applyPreset`/`set` and the Category/Source facets are
plain `Set`s the multiselect builder reads at build time.

- `deepLink` (resolved once from `location.search` at module load): `preset`, `from`,
  `to`, and `categories`/`sources` via a `paramList()` helper that accepts **both**
  repeated (`?source=a&source=b`) and comma-separated (`?source=a,b`) forms.
- `resetFilter()` — previously an unconditional `tf.applyPreset(DEFAULT_PRESET)` — now
  prefers, in order: a **valid** `?preset=` key (validated against `PRESETS` so a typo
  can't silently land on blank/"all" with a broken-looking select), else explicit
  `?from=`/`?to=` (flips the control to `custom`, same as hand-typing a range), else the
  unchanged default. `categories`/`sources` seed `state.filter` directly; the existing
  multiselect builder checks the matching boxes because it already reads
  `selected.has(v)` off the same `Set`.
- Because `resetFilter()` runs on every `loadLedger()` (not just the first), the
  deep-link params stay in effect across a Save/reload within the same page load —
  consistent with the pre-existing "a fresh account load starts unfiltered" behavior,
  just with a different definition of "fresh" when the URL carries one.
- No new params ⇒ `deepLink` fields are all empty ⇒ every branch falls through to the
  prior `tf.applyPreset(DEFAULT_PRESET, ...)` call, byte-for-byte the old code path.

**Verified** — a no-dependency CDP driver against the real `npm start` server
(`:3000`, real `woody-checking` data) confirmed: no params ⇒ unchanged `3paychecks`/67
rows; `?preset=last90&category=Bill` ⇒ 22 rows, chip reads "Last 90 days · 1 filter",
checkbox shows checked; `?preset=last90&category=Bill&source=Apple%20Card` ⇒ 0 rows
(correct — categories/sources AND together, and no row is both); `?from=&to=` with no
preset ⇒ `custom`, chip shows the literal range, 31 rows; `?preset=bogus` ⇒ falls back
to the default rather than the blank/"all" window `presetWindow()`'s own unknown-key
branch would otherwise silently produce. Zero console errors in every case; screenshot
confirmed the filtered grid visually matches the chip and checked facets.

## T6 — Published read-only parity · **Sonnet** — ✅ **done (2026-10-06)**

- `local/server.js` `/api/publish`: regenerate `docs/csp.html` + `docs/csp.js` from the
  local files the same way `app.js`/`paycheck.js`/`ledger.html`/`paycheck.html` are
  (rewrite `from "/shared/` → `./shared/`, inject `./mock-api.js`). Note `csp.js` will
  import `./timeframe-ui.js`, which also has to be copied/rewritten — handle it (or
  generalize that block into a list, which is overdue anyway).
- `docs/mock-api.js`: add **Spending Plan** to the published nav list and confirm the
  `plan_targets` routes already cover the new kinds (they should — verify). Reads must
  work with zero writes persisting; Save/Discard hidden by the existing CSS rule.
  Note: the published nav deliberately omits **Plan** (plan editing stays local), so on
  the published site **Spending Plan is a top-level link**, not a dropdown — and the
  switcher control must hide itself when there's no sibling view to switch to.
- `docs/index.html`: add the nav link.
- Verify through `/site` (`http://localhost:3000/site/csp.html`) against the committed
  snapshot, not just locally.

**Done when:** the published page renders real snapshot numbers read-only, the banner
shows, Save/Publish/Sync are hidden, and the nav is consistent across published pages.

### What shipped

- **`local/server.js`** — the page-script copy list gained `csp.js` and
  `view-switch.js` (`nav-plan.js`/`timeframe-ui.js` were already there from T1/T4a), and
  the pages+shim list gained `{ src: "csp.html", out: "csp.html", script: "./csp.js" }`.
  No other change needed: `csp.js`'s `/shared/csp.js` and `/shared/timeframe.js` imports
  already fall under the existing `relImports` rewrite.
- **`docs/mock-api.js`** — `decorate()`'s nav list gained `["csp.html", "Spending
  Plan"]` (now Dashboard / Ledger / This Paycheck / Spending Plan). Confirmed by reading
  the file: `/api/plan-targets` GET/POST/PATCH/DELETE are entirely kind-agnostic, so the
  new `csp_plan`/`csp_item` kinds already round-trip with zero code change.
- **`docs/index.html`** — added the `Spending Plan` nav link by hand, since this page is
  hand-maintained (not regenerated by publish, unlike `ledger.html`/`paycheck.html`/
  `csp.html` — it fetches `snapshot.json` directly via `shared/dashboard-render.js`).
- **A real collision caught before it shipped.** `mountPlanNav`'s selector was
  `a[href="./plan.html"], a[href="./csp.html"]` — dead code locally (no page's static
  nav ever points at `./csp.html` directly) but live on the published site: once the
  nav carries a top-level `<a href="./csp.html">Spending Plan</a>`, that selector would
  match it and `mountPlanNav` would wrap the plain link into a hover dropdown whose panel
  offers "Plan targets" → `./plan.html`, a page that doesn't exist on the published site.
  Fixed by narrowing the selector to `./plan.html` only (`local/public/nav-plan.js`) —
  the published nav never has that href, so `mountPlanNav` keeps quietly no-op'ing there,
  as the original comment intended.
- **`local/public/csp.js`** — the Plan/Spending-Plan switcher (`#viewSwitch`) must hide
  itself on the published site per decision #10. It now checks for a literal
  `a[href="./plan.html"]` in `.nav` **before** calling `mountPlanNav` (which replaces
  that link with the dropdown, so the check has to run first or it would always read
  "no Plan page"), and passes `mountViewSwitch` either both `PLAN_VIEWS` or just the
  `csp` one depending on the result.

**Verified** — a real `{push:false}` publish against the running local server/DB
regenerated `docs/csp.html`/`csp.js` + the shared-UI copies, then headless Chrome
against `http://localhost:3000/site/csp.html` and `/site/index.html`: zero console
errors (only the pre-existing unrelated `favicon.ico` 404), the read-only banner shows,
both plans render with real numbers (targets/actuals/deltas/status pills), Save/Discard/
dirty-note are hidden, the nav is exactly Dashboard/Ledger/This Paycheck/Spending Plan
with **no dropdown caret** on Spending Plan and no panel on hover/click, `#viewSwitch`
is `hidden` with no visible toggle, a drill-down panel opens and shows real ledger rows,
and the Dashboard's new nav link lands on `/site/csp.html`. The test publish (including
the `local_version`/`dirty`/`published_by` sync-meta bump) was reverted afterward —
`docs/` was restored to its committed state except for the two intentional hand-edits
(`docs/index.html`, `docs/mock-api.js`), and `sync_meta` was reset to v15/dirty — so
nothing was pushed and the only lasting change is the source edits above.

## T7 — Dashboard CSP strip *(optional, after T4b)* · **Opus** — ✅ **done (2026-10-08)**

Add a compact per-bucket CSP status row to `shared/dashboard-render.js` (one line per
bucket: target % vs. actual %, status), scoped to `currentUser`, using the same window
default — which per amendment #11 is `DEFAULT_MONTH_PRESET` (`last3months`), resolved
with `monthPresetWindow`, **not** `presetWindow("3paychecks", …)`. Keep it additive — the existing health strip/tiles/drift sections must not
regress on either the local or published view.

### What shipped

- **`shared/dashboard-render.js` only.** No change to `shared/csp.js`,
  `shared/timeframe.js`, the server, the data, or either page's markup — the renderer
  already received `{ accounts, transactions, planTargets, people, currentUser }`, and
  `planTargets` already carries the `csp_plan` / `csp_item` rows, so the strip needed no
  new plumbing on either surface. New section `cspSection()` + `cspCard()` + `cspNum()`,
  rendered between the metric tiles and the **Debts** drift section, under a
  `SPENDING PLAN · MONTHLY AVERAGE, LAST 3 MONTHS` heading with an `OPEN →` link to the
  sibling `csp.html` (relative, so it resolves on both surfaces).
- **The window is the Spending Plan page's own default**, as the task specifies:
  `monthPresetWindow(DEFAULT_MONTH_PRESET, { today: asOf })` → `last3months` → the three
  *complete* months before today (2026-07-01 … 2026-09-30 as of 2026-10-08), an exact
  3-month divisor via `wholeMonthsIn`. Not `presetWindow("3paychecks", …)`, which would
  average a monthly budget over a 42-day pay window (amendment #11), and not a window
  including the month in progress.
- **One line per bucket, one signal per fact** (Phase 11's rule, which this strip is the
  first new surface to follow): status glyph, bucket label, `target <pct> <$muted>`,
  `actual <pct> <$muted>`, then the delta carrying the only color. Percent is the
  headline number because that is what a CSP is written in; dollars sit beside it muted.
  A plan header line above the buckets carries the same triple for the plan total, with
  the person's name + avatar (reusing `resolveOwners`/`ownerAvatars`).
- **Scope.** A person sees their own plan (reversed decision #3 — personal-scope), plus a
  `shared` plan if one ever exists in the data. The Dashboard's own **Everyone** view is
  the exception the Spending Plan page doesn't have: there it shows every plan, one card
  each, which stays correct for N people. Accounts/transactions are passed **unscoped**
  on purpose — the engine scopes each plan to its own owner's accounts, and pre-filtering
  to "mine plus shared" would double-count joint dollars and break its reconciliation
  check.
- **Additive, verified by construction and by test.** `cspSection` is wrapped in a
  `try`/`catch` returning `""`, and returns `""` when no `csp_plan` is in scope. Probed
  in-browser against five inputs — baseline, `csp_*` rows stripped, this person's plan
  removed, `take_home: 0`, and a malformed `buckets` value: in every case the health
  strip, all 6 tiles, all 11 drift rows and the spend chart rendered unchanged, the
  section vanished entirely when there was nothing to show, and `take_home: 0` fell back
  to dollars as the headline rather than printing `0.0%` five times.
- **Alignment.** Each card is a grid and its rows `grid-template-columns: subgrid` onto
  it (with the explicit px columns as the pre-subgrid fallback), so target/actual/delta
  line up down a whole card instead of each row sizing its own columns — measured at
  665px/837px for every row. Vertical padding and the row separators don't move subgrid
  tracks, so the rows keep their own rules.
- **Verified in the real app, both surfaces, both themes.** Local `dashboard.html` at
  Everyone / Woody / Rajna and the published `docs/index.html` against the committed v16
  snapshot, slate-dark and peach-light. Every figure matches an independent Node run of
  the engine to the cent (Woody target $5,000.89 / 103.7% vs. actual $6,434.22 / 133.4%,
  Δ +$1,433.33, `warn`; Rajna $3,579.43 / 100.0% vs. $2,960.94 / 82.7%, Δ −$618.49,
  `good`), delta colors resolve to the right token in both themes, and `npm run check:csp`
  still passes. The published test used a local copy of the shared modules into
  `docs/shared/` which was **reverted afterwards** — `docs/` is byte-identical to its
  prior state (its one pre-existing `docs/index.html` hand-edit untouched), so the strip
  reaches the published site on the user's next **Publish**, not before.
- Uses only tokens the file already drew with (`--panel`, `--line`, `--muted`, `--pos`,
  `--warn`, `--neg`, `--accent`, `--on-accent`), so it themes for free and
  `npm run check:theme` has nothing new to score.

## T8 — Docs + memory · **Sonnet** — ✅ **done (2026-10-06)**

- `README.md` → "Using the app": a **Spending Plan** bullet in plain language (what it
  compares, that averages follow the timeframe picker, that clicking a line shows the
  real transactions behind it, that nothing saves until Save).
- `ROADMAP.md` → tick Phase 10 and reconcile §8 with what was actually built.
- Update the project memory with anything non-obvious the build surfaced (e.g. the
  final averaging rule, the match-precedence decision).

### What shipped

- **`README.md`** — new **Spending Plan** bullet right after **Plan** in "Using the
  app" (and a one-line pointer from **Plan** to hover/tap for the dropdown), covering
  what it compares, that the timeframe picker drives the averages, that clicking a line
  drills into the real transactions, and that Save/Discard still governs everything.
- **`ROADMAP.md`** — Phase 10 ticked `[x]` with a "what shipped" summary (page, nav
  placement incl. the published-site top-level-link exception, compute engine, deep-link
  params, published parity), T7 called out as the one still-open, non-blocking item
  (that clause was reconciled when T7 landed on 2026-10-08). §8
  gained one reconciling bullet: the published site shows Spending Plan as a **top-level
  nav link** rather than a Plan-dropdown entry (decision #10), since Plan-target editing
  never ships to the published site.
- **Memory** — see `finance-dashboard-project.md` and the new `csp-feature-learnings.md`
  for the non-obvious build findings (averaging rule, match precedence, the exclude set,
  the card-spend blind spot, the published-nav collision).

---

## Resolved decisions (2026-10-06)

_Decisions 6–10 were settled by T0; 1–5 predate it. **#1, #3, #4 and #5 were amended** —
read the amendments, not just the originals._

1. **Placement** — **a sub-view of Plan, not a peer tab.** Plan is really two separate
   views: *Plan targets* (debts / savings goals / investments) and *Spending Plan*
   (CSPs). Neither shows the other's content; each has a button to switch to the other,
   and hovering the **Plan** nav item opens a dropdown listing both. Implemented as two
   page files sharing one switcher + one nav snippet (T4a).
   **→ Amended (2026-10-06, user feedback):** the segmented *Plan targets | Spending
   Plan* switcher moved out of the header — it now renders as its own small control at
   the top of `<main>`, under the navbar, rather than inline with it (`#viewSwitch` in
   `plan.html`/`csp.html`). The **Plan** nav dropdown (`nav-plan.js`) is unaffected.
2. **Future-dated rows** — honor the chosen window as-is, but **split and label to-date
   vs. projected**, so future-looking presets stay meaningful on this page.
3. **Household plan** — build the renderer so a `shared`-owner plan is just another
   section, but **only seed one if the uploaded CSPs include a joint plan**.
   **→ Reversed (2026-10-06, user feedback):** the Spending Plan is now **personal-scope
   only**, like This Paycheck / Daily Check — it renders *only* the current person's own
   plan, never a sibling's and never a `shared`/household one. The owner-avatar picker
   (switch-between-people buttons on the plan header, including the "Household" option)
   was removed entirely; `+ Add plan` always creates a plan owned by `currentUser` and
   only appears when that person doesn't already have one. `shared`-owner plans are no
   longer reachable from this page's UI at all (nothing stops one existing in the data,
   it just never renders here).
4. **Target basis** — **store both $ and % of take-home.** Whichever the user typed for
   an item is authoritative; the other is derived from take-home and displayed.
   **→ Amended by T0:** this holds for *items*, but **buckets store no target at all.**
   Both uploaded CSPs state items in `$` and show bucket % as a computed share of
   take-home, with the four buckets summing to take-home exactly. So a bucket's target
   is the **sum of its items**, and the template's `50-60%` / `10%` / `5-10%` / `20-35%`
   headers are a **recommended range** (`rec_pct`) that only colors the status pill.
5. **Transfer categories** — `Savings` / `Investments` / `Credit Card Payment` /
   `Loan Payment` **do** count inside their CSP buckets (that's the CSP framework), even
   though `metrics.monthlySpend()` excludes them. `NON_SPEND` stays exclusive to the
   spend chart.
   **→ Extended by T0:** `Transfer` **also counts** — an internal transfer is real
   outflow from the paying account. But `Adjustment` and `Negative Balance` are a hard
   **exclude set**: they are Daily-Check reconciliation artifacts, and Rajna's single
   $1,072.87 correction would otherwise read as $89/mo of phantom spending. Excluded
   rows are never matched and never land in Unassigned; the view shows them on a
   separate "excluded" footer line so nothing vanishes silently.
6. **Guilt-Free Spending is the single catch-all bucket.** Its target is the residual
   (`take_home − fixed − investments − savings`, reproducing $188 and $335 exactly) and
   it absorbs all unmatched outflow as one **Unassigned** row. Exactly one bucket per
   plan carries `catch_all: true`; other buckets show no Unassigned row. This replaces
   the earlier "each bucket also shows Unassigned" wording in ROADMAP §8.
7. **Match precedence: `sources` beats `categories`.** Specificity wins, not document
   order. Resolution order: items with a `sources` rule → items with both (by category)
   → items with only `categories`; ties broken by bucket order then `sort_order`. Each
   ledger row counts exactly once. Without this, Woody's category-based *Debt Payments*
   would swallow his source-based *Rajna Assistance Program*.
8. **Household plan** — neither uploaded CSP is joint, so **no `shared` plan is seeded**
   (per decision #3). The renderer still treats it as just another section.
9. **T0 may add target-0 items.** Six `proposed: true` lines were added for real ledger
   activity with no CSP line (Woody: Wedding/Ring/Honeymoon HYSA; Rajna: AT&T phone,
   tuition, internal transfers). Without them that money lands in the Guilt-Free
   catch-all and reads as discretionary. They are flagged in the UI and safe to delete.
10. **The published site exposes the Spending Plan** (user decision, 2026-10-06) — T6's
    assumption is confirmed: Spending Plan is a **top-level** published nav link, and the
    Plan/Spending-Plan switcher hides itself when there is no sibling view to switch to.

11. **The Spending Plan's timeframe steps in whole calendar months only** (user
    amendment, 2026-10-06) — a CSP *is* a monthly plan, so comparing it over a 42-day
    pay window or a half-finished month measures it against a unit it was never
    written in. Scoped to this page: the **Ledger keeps its full day/paycheck preset
    list** and its `3paychecks` default, which is what `DEFAULT_PRESET` still is.
    - `shared/timeframe.js` gained a second preset list, **`MONTH_PRESETS`**
      (`thismonth`, `lastmonth`, `last3months`, `last6months`, `last12months`,
      `nextmonth`, `next3months`, `next6months`, `thisyear`, `lastyear`, `all`), its
      own resolver **`monthPresetWindow`** and **`DEFAULT_MONTH_PRESET`**
      (`last3months`). Keys differ from `PRESETS`' wherever the window differs
      (`last6months` ≠ `last6mo`) so one key never means two things; the three that
      are shared (`thisyear`/`lastyear`/`all`) are month-aligned already and fall
      through to `presetWindow`. `presetLabel` searches both lists.
    - **Trailing presets stop at the end of last month.** The in-progress month is
      reachable only as `This month`, which says so on the tin. Folding it into a
      trailing average would divide six days of October by a whole month and report a
      ~75% phantom underspend on every line.
    - **Every window is a whole number of months**, including From/To: those are now
      `<input type="month">` on this page, a From resolving to the 1st and a To to the
      month's last day. New `wholeMonthsIn()` makes `monthsInWindow` return an exact
      integer for a month-aligned window instead of 92 / 30.4375 = 3.02, so each
      average's divisor is clean (and the chip reads "3 months", not "3.0 months").
      The day-based `DAYS_PER_MONTH` path still serves the Ledger and any open window
      falling back to a plan's own ledger extent.
    - `timeframe-ui.js` takes `presets` + `granularity: "month"`; everything else about
      the control is unchanged, and a persisted `cspPreset` holding a now-unknown key
      (e.g. the old `3paychecks`) is validated against the page's own list and falls
      back to the default.
    - **Consequence worth knowing:** no month preset depends on a person's pay grid, so
      this page no longer anchors on anyone's paychecks — `payAnchor`/`anchorContext`
      and the "Woody's pay cycle" clause on the chip are gone, and the window no longer
      needs re-deriving after the ledger loads. `local/check-csp.js`'s default-preset
      window shape is now one window for both people rather than per-person.

## Still open (not blocking)

- **Ledger cleanup pass** — T0's list (b) is still outstanding: the
  `Iphone`/`iPhone Upgrade Program` casing split, `Fundrise` filed under both `Savings`
  and `Investments`, `Ammu` under both `Transfer` and `Parents`, and the one Woody row
  with an empty `description`. None of them block anything (every affected CSP line
  matches on `source`), but they are real data smells. T5's new `?category=` /
  `?source=` params make them a two-minute fix in the Ledger once that lands.
- Nothing else. All T0 questions are settled.

---

# Phase 11 — Spending Plan UI cleanup (user feedback, 2026-10-06)

The feature is correct but the page reads like a debugging surface: every derived
number is wrapped in a form control, every row carries two redundant signals (a
colored Δ *and* a status pill *and* a recommended-range clause), and a 90-character
provenance line sits under each plan. This phase is **presentation only — no change to
`shared/csp.js`, `shared/timeframe.js`, the server, or the data** (one exception, T10's
`catch_all`, called out below). Nothing here may change a computed number.

Guiding rule, from the feedback: **a value the user types is a form; a value the app
calculates is text.** And **one signal per fact** — if red/green on the Δ already says
"off track", a pill saying so is noise.

## Dependency order

```
T9  bucket header + collapse  ─┬─ T11 drop Status column ─┐   ✅ T9–T13 done
T10 de-form rec % / catch-all ─┘                          ├─ T13 republish + verify ─ T14 docs
T12 drop the window note ─────────────────────────────────┘                           ✅ done
```
T9 and T10 both rewrite `.bucket-head`, so **T9 lands first** and T10 slots into the
header it builds. T11 and T12 are independent of both.

## T9 — Collapsible buckets + the new bucket header · **Opus**

The headline change. Today a bucket header is `label input · rec 50–60% form · catch-all
radio · ×`, with a separate 90-character roll-up line under it
(`bucketRollEl`, `local/public/csp.js` ~L597). Replace both with **one summary line that
is also the collapse toggle**, matching the attached mock:

```
▸ SAVINGS GOALS          target $360.00 (7.5%)   actual $1,594.78 (33.1%)   +$1,234.78
```
- Bucket **title** (still editable — it's user data — but styled flush like text, not a
  boxed input; reuse the ghost-input treatment the plan name already gets, or go
  click-to-edit if that reads cleaner at this size).
- **target total** and **actual total** as plain bold text, each with its **percent of
  take-home in small muted parentheses** — from `state.bucketView`'s `targetMonthly` /
  `targetPct` / `actualMonthly` / `actualPct`. No `/mo` suffix on every number; say
  "per month" once, in the section header or the timeframe chip.
- **Δ** last, red/green by `status` direction (the existing `.delta <status>` class) —
  the only status signal on the line (see T11).
- Drop the `→` arrow, the `rec 50–60% (above)` clause (T10), the status **pill**, and
  the word `residual` on the catch-all. Keep the catch-all's residual target *value*
  (the engine still derives it); if the distinction needs surfacing at all, a `title`
  tooltip on the target number is enough.

**Collapse behavior:** each bucket collapses to exactly that one line, so a whole CSP
fits on screen as four lines plus the plan header.
- Caret/chevron on the left of the header; clicking anywhere on the header that isn't
  an input toggles it. `aria-expanded` + a real `<button>` for the caret.
- **Default collapsed**, so the page opens as the overview the feedback asks for.
  Per-bucket state persists in `localStorage` (`cspCollapsed:<planKey>:<bucket>`),
  alongside the existing `cspPreset` key.
- **Expand all / Collapse all** control in the plan header.
- The item-level **drill-down** panels keep their own open state keyed as they are
  today, so collapsing a bucket and re-expanding it doesn't close panels or lose the
  `derived[]` updaters. Verify `refreshNumbers()` still repaints cells inside a
  *collapsed* bucket (it should — the nodes exist, they're just hidden) so expanding
  after a timeframe change never shows a stale number.

**Done when:** a plan renders as plan header + four collapsed bucket lines; every number
on a collapsed line matches the pre-change roll-up to the cent; expanding shows the
unchanged item table; collapse state survives reload; changing the timeframe updates
collapsed lines too. Screenshot-verify collapsed and expanded, and with a bucket that
has zero items.

**Shipped (2026-10-06).** `bucketRollEl` is gone; `bucketSummaryEl` renders the
`target $X (p%) · actual $Y (q%) · Δ` triple into the right-hand side of
`.bucket-head`, which is now the collapse toggle (own padding + hover; a real
`<button.caret-btn>` carrying `aria-expanded`/`aria-controls`, plus a head-level
click handler that ignores `input, button, select, label, a`). Everything below it
moved into a `.bucket-body` that is **hidden, not removed**, so the `derived[]`
updaters keep repainting collapsed lines — verified against an independent Node
engine run at `last3months` and `last6months`, matching to the cent for both people.
State: `cspCollapsed:<planKey>:<bucket>` (`"1"`/`"0"`, absent = collapsed), written
only by a real toggle, never by the initial `apply(..., false)` — a fresh load of
either plan leaves Save disabled. `planToolsEl` adds Expand all / Collapse all to the
plan header, next to the one statement of "monthly average" that replaces every
number's `/mo` suffix. Also landed here because T9 made them dead: the plan-header
status pill, `STATUS_LABEL`, and all `.pill` CSS (T11 deferred that pruning to this
task); the plan roll-up now uses the same `.grp`/`.lbl`/`.pc` markup and spacing as a
bucket line and dropped its `→`. The rec-% inputs and the catch-all radio are
still in the header — T10 takes them out.

## T10 — De-form the values the app calculates, drop the catch-all picker · **Opus** — ✅ **done (2026-10-06)**

Two form controls on the bucket header are not things a user should be filling in:

- **`rec_pct` becomes fixed text.** The recommended range is template advice, not an
  input — render it as a small muted `rec 5–10%` **once**, in the bucket header (T9's
  line, or just under the title), and delete the two `<input type="number">`s and
  `commitRec` (`csp.js` ~L557–565). The value stays on the bucket's `data` and is still
  seeded/consumed by the engine's `recStatus`; it is simply no longer editable from this
  page. Also delete the `(above)`/`(within)`/`(below)` clause from the roll-up — that is
  the "redundant" string the feedback calls out; the range plus the visible actual %
  already say which side of it you're on. (Net effect: `recStatus` goes unused in the
  UI. Leave the engine export alone — `check-csp.js` asserts on it.)
- **The catch-all radio goes away.** Catch-all is a structural fact — *guilt-free
  spending absorbs the residual* — not a per-plan choice. Delete `.catch-all-pick` and
  `setCatchAll` (~L539, L567–573) and make the flag **derived**: `ensureCatchAll()`
  (~L388) resolves it to the bucket keyed `guilt_free`, falling back to the last bucket
  by `sort_order` if a plan has no such key, and sets it silently.
  - **Keep the `catch_all` data field** — `shared/csp.js` enforces exactly one per plan
    and derives its target as the residual; removing it from the data would mean
    changing the engine and re-seeding, which is out of scope for a UI pass. This task
    only stops the *UI* from writing it.
  - Watch the write path: the derivation must not mark a plan `_dirty` on load (the
    `rendering` flag T4b added exists for exactly this), or every visit stages a
    phantom edit. Removing a bucket still has to re-derive rather than toast "X is now
    the catch-all".

**Done when:** no bucket-header input remains except the title; `rec` reads as text; a
fresh load of both plans leaves Save disabled (no phantom dirty); deleting the
guilt-free bucket re-derives the catch-all onto the last bucket with the residual target
landing there; `npm run check:csp -- --db` still passes unchanged.

### What shipped

The bucket header is now `▸ TITLE · rec 50–60% · target … actual … Δ · ×` — one text
input (the title) and nothing else. `rec_pct` renders as a muted `.rec-pct` span with a
`title` of "Recommended share of take-home for this bucket"; the two
`<input type="number">`s and `commitRec` are gone, as are `.catch-all-pick`,
`setCatchAll`, and the `.rec-pct input` / `.catch-all-pick` CSS. The field stays on the
bucket's `data` and the engine still computes `recStatus` from it — the UI just never
reads or writes it now (`check-csp.js` still prints and asserts on it, untouched).

- **A bucket the user adds has no template range** (`rec_pct: [0, 0]`), and `rec 0–0%`
  is noise, so the span simply isn't appended rather than being created and hidden —
  which also sidesteps the `[hidden]`-vs-author-rule specificity trap T11 hit with
  `.conflict`. A single-value range (`[10, 10]`, Investments) collapses to `rec 10%`.
- **`ensureCatchAll` is now a derivation, not a repair.** It resolves the owner to the
  bucket keyed `guilt_free`, falling back to the last bucket by `sort_order`, sets
  `catch_all = true` there and `delete`s the key everywhere else — so a save never
  writes `catch_all: false` noise into the JSON. It does **not** call `markDirty`: the
  old version did, which would have staged a phantom edit on every visit now that the
  derivation runs unconditionally. (The `rendering` flag wasn't needed — not marking
  dirty at all is the stronger guarantee, and it also covers the `removeBucket` →
  `render()` path.)
- **`removeBucket` dropped its reassignment toast.** Deleting the catch-all bucket now
  just re-renders, and the derivation moves the flag — and with it the Unassigned row
  and the residual target — silently.
- The head-level click handler's ignore list (`input, button, select, label, a`) is
  unchanged but now only has the title, caret, and × to skip; clicking the `rec` text
  toggles the bucket, which is the point of making it text.

**Verified** — headless Chrome over CDP against the real running server/DB (no data
modified; every staged edit discarded, and the `/api/plan-targets` payload compared
byte-for-byte before and after to prove it). For **both** Woody's and Rajna's plans, all
four bucket headers: zero `input[type=radio]`, zero `input[type=number]`, exactly one
input (`text.label`), zero `<label>` elements, no "catch-all"/"residual"/`(above)` text,
and `rec` present as visible non-input text (`rec 50–60% | rec 10% | rec 5–10% |
rec 20–35%`). A fresh load of either plan leaves `#saveBtn` disabled and reading
"Save plan", with `#discardBtn`/`#dirtyNote` hidden — no phantom dirty. Exactly one
Unassigned row per plan, under `guilt_free`.

- **Catch-all re-derivation**, exercised for real: emptied Woody's guilt-free bucket
  (10 items, staged) and deleted it → no toast, the catch-all landed on **Savings Goals**
  (the last bucket by `sort_order`), its Unassigned row and residual tooltip moved with
  it, exactly one Unassigned row remained, and the residual arithmetic checked out —
  take-home `$4,822.00` − (Fixed `$4,152.50` + Investments `$230.00`) = **`$439.50`**,
  which is exactly the target the page rendered on Savings Goals. Discard restored
  `guilt_free` as the catch-all and re-disabled Save.
- Clicking the `rec` text toggles the bucket; clicking the title input does not; the
  caret still toggles back with `aria-expanded="false"`; none of those three staged an
  edit.
- Collapsed-bucket numbers are unchanged from T9 (`fixed target $4,152.50 (86.1%)
  actual $5,190.57 (107.6%) +$1,038.07`, etc.), and expanding Fixed Costs shows the
  same six-column item table T11 shipped. Screenshot-verified collapsed and expanded.
- `npm run check:csp -- --db` → **ALL CHECKS PASSED**, including
  `exactly one catch-all bucket (1)`. Only the pre-existing `favicon.ico` 404 in the
  console.

## T11 — Remove the Status column; the colored Δ is the signal · **Sonnet** — ✅ **done (2026-10-06)**

`itemsTableEl` (`csp.js` L619) is `Name · Target · Actual avg · Δ · Status · Match rule ·
×`. Drop **Status**, leaving six columns.

- `ITEM_COLS` 7 → 6 (it feeds `drillToggle`'s panel `colspan` — miss this and the
  drill-down panel under-spans the row).
- Remove the pill cell from `itemRowEl` and from `unassignedRowEl`; keep the Δ cell's
  direction-aware `.delta <status>` coloring exactly as it is — that is now the only
  status signal, so confirm red/green reads correctly for both directions (`fund`
  under-funding = red, `spend` overspending = red).
- **Don't lose the `untracked` case.** Today an item with no match rule says *target
  only — not tracked* via a pill in the Status column. With the column gone, that text
  moves into the **Actual avg** cell (where it replaces the `—`), so a rule-less item
  still never reads as a misleading `$0.00`. Same for the muted "pending" state if any
  path still renders it.
- Fix the explicit column widths (`table-layout: fixed`, added in T4b) for six columns —
  give the freed width to Name and Match rule, which were the squeezed ones.
- Prune the now-dead `STATUS_LABEL` usages and `.pill` CSS in `csp.html` **only** if
  nothing else on the page uses them after T9 (the plan-header pill goes in T9).

**Done when:** six columns, no pill anywhere on the page, every Δ colored as before,
untracked items still labeled, drill-down panels span the full row.

### What shipped

`itemsTableEl`'s header and `ITEM_COLS` are six; `unassignedRowEl`'s and `itemRowEl`'s
cell lists match. `STATUS_LABEL` and `.pill`/`.pill.*` CSS were **left alone** —
`bucketRollEl` and `planRollEl` still render a pill (T9/T10's job to remove), so pruning
either now would break those two call sites. The column-width CSS dropped the `(5)`
selector, gave Name `230px` (was `190px`), and let Match rule (now column 5, previously
unsized) keep absorbing the rest — exactly the split the task called for.

- **The item-row conflict `⚠`** (previously appended into the now-deleted Status cell)
  moved into the Match-rule cell, as a sibling of `matchRuleEl`'s `.rule-group`, created
  once and toggled via `.hidden` instead of being conditionally created/appended inside
  the `derived` closure each repaint.
- **A real bug caught by screenshot-verify, not by reading the diff:** the new
  `.conflict { display: inline-block; ... }` rule has the same specificity as the
  browser's built-in `[hidden] { display: none }`, and an author rule beats a
  user-agent rule at equal specificity — so every row's `⚠` rendered regardless of
  `.hidden`, not just the ~34-row Rajna-Assistance/Debt-Payments overlap T0 documented.
  Fixed with `.conflict:not([hidden]) { ... }`.
- The early-return branch (`!v`, a new plan with no owner yet) now hides the warning too
  (`conflictWarn.hidden = true`) instead of clearing `statusTd.textContent`.

**Verified** — Playwright against the real running server/DB (`csp.html`, Woody's plan,
no data modified): every bucket's `<thead>` reads `Name/Target/Actual avg/Δ/Match
rule/""` (6 cells), zero `td.status-cell` anywhere, zero `.pill` inside any `<tbody>`
(the 4 remaining page-wide pills are all inside `.bucket-sum`, i.e. T9/T10's territory,
not this task's), sample `.delta` classes show `good`/`warn`/`bad` coloring intact,
the untracked *Groceries* row reads "target only — not tracked" in the Actual-avg cell,
a drill-down panel's `colSpan` (6) matches its table's header count (6), and only the
pre-existing unrelated `favicon.ico` 404 appears in the console. Screenshot confirmed
the `⚠` now appears on exactly the two items T0 flagged (Rajna Assistance Program, Debt
Payments) rather than on every row.

## T12 — Remove the per-plan window/provenance note · **Sonnet** — ✅ **done (2026-10-06)**

Delete the `averages over 3 paychecks · 2026-09-17 – 2026-10-29 · 1.4 months · 1
reconciliation row excluded · 49% projected` line — the `note` span in `planRollEl`
(`csp.js` ~L448, L464–470) and its `.window-note` CSS.

- **Keep the reconciliation *warning*** (`recon`, ~L476). It is hidden unless the
  numbers genuinely stop adding up, so it isn't the clutter being complained about.
- **Keep the plan-header target/actual/Δ** (`nums`), restyled to match T9's bucket line;
  the plan-header **pill** goes, same reasoning as T11.
- One thing the note carried that nothing else does: the **months figure for an open
  window** ("All time" is as long as each plan's own ledger, so the timeframe chip can't
  state it). Put that on the chip's `summaryExtra` when the window is open, or append it
  to the plan's actual as a `title` tooltip — a tooltip, not a visible line.
- The `% projected` label on *expanded drill-down panels* stays (that's per-row detail
  the user opened deliberately); only the always-visible plan line goes away.

**Done when:** no provenance line under any plan header; an open window still tells the
user somewhere how many months it averaged over; a deliberately broken reconciliation
still shows the red warning.

### What shipped

`planRollEl` (`csp.js`) dropped the `note` span and its provenance sentence, and the
`pill` span (the plan-header's own status badge — `bucketRollEl`'s and the item rows'
pills are separate code paths, T9/T10's and T11's territory respectively, untouched
here). `nums` now reads `target $X/mo (NN.N%) → actual $X/mo (NN.N%) <colored Δ>`,
matching `bucketRollEl`'s existing `target … (pct%) → actual … (pct%) Δ` shape — the
plan object has no `targetPct`/`actualPct` of its own (only buckets do), so those two
percentages are computed inline from `takeHome`, no `shared/csp.js` change needed.
`recon` (the reconciliation warning) is untouched.

- **The open-window months figure** went on a `title` tooltip on `nums` rather than the
  chip: with this page personal-scope-only there's normally one plan in view, so a
  per-plan tooltip reads more directly than a page-wide chip clause, and it only needs
  computing for the one case (`closedWindowMonths() == null`) where the chip itself
  can't state a length. A closed window leaves `title=""` — nothing to add when the chip
  already names the range.
- `presetLabel` (from `shared/timeframe.js`) and the page's own `escapeHtml` helper were
  only ever used to build the deleted note sentence — both are now dead and were removed
  (import trimmed, helper deleted) rather than left unused.
- `.window-note`/`.window-note .proj` CSS deleted; `.plan-roll .pill` deleted too (the
  plan-roll pill it targeted no longer exists). `.pill`/`.pill.*` base rules, and
  `.bucket-sum .pill`, are untouched — still load-bearing for `bucketRollEl` until T9/T10.

**Verified** — Playwright against the real running server/DB (`csp.html`, no data
modified): the plan header now reads e.g. `target $4,822.00/mo (100.0%) → actual
$6,434.22/mo (133.4%) +$1,612.22` with no pill and no provenance line beneath it;
switching the timeframe preset to **All time** set `title="Averaged over 36.1 months"`
on that span (matching T4b's recorded open-window figure for Woody) while every other
preset left it empty; no new console errors. The reconciliation-warning code path was
left byte-for-byte unchanged, so it wasn't re-tested here.

## T13 — Republish parity + full re-verify · **Sonnet** — ✅ **done (2026-10-06)**

- `{push:false}` publish, then check `http://localhost:3000/site/csp.html`: collapsed
  headers render, collapse/expand works read-only, no Save/Discard, no console errors.
- Re-run the T4b style verification: the on-page numbers for both people across at least
  three window shapes against an independent Node run of the engine. **The harness
  reads cells by column index — update it for six columns** before trusting it.
- `npm run check:csp -- --db` unchanged.
- Restore `docs/` + `sync_meta` afterward as T3/T4b/T6 each did, unless the user asks for
  a real publish.

### What shipped

No code changes — this task is verification only, and everything it checked already
worked.

- **T10 landed first.** It hadn't shipped yet when this task started (`setCatchAll`,
  `commitRec`, `.catch-all-pick` were still live in `csp.js`); it was finished before
  re-verifying so T13 would check the final Phase 11 UI once, not twice. Confirmed by
  reading `csp.js`: `rec_pct` renders as inert text (`rec.textContent`), the catch-all
  radio is gone, and `ensureCatchAll()` derives the flag silently without calling
  `markDirty`.
- **A real `{push:false}` publish** (`publishedBy: "t13-verify"`) against the running
  local server/DB, version 15 → 16. Headless Chrome (Playwright, Chrome channel) against
  `http://localhost:3000/site/csp.html` confirmed: the read-only banner shows, `#saveBtn`/
  `#discardBtn` are both hidden, every bucket renders **collapsed by default**, clicking
  a caret expands it (verified the `.collapsed` class and `.bucket-body` hidden state
  toggle both ways), and the expanded view shows exactly the T11 six-column table (Name/
  Target/Actual avg/Δ/Match rule/×) with the ⚠ conflict icon on only the two items T0
  flagged. Zero console errors besides the pre-existing, unrelated `favicon.ico` 404
  (confirmed by `curl`-ing it directly — same 404 every prior task's verification noted).
- **A new page-vs-engine harness** (`/private/tmp/.../t13-verify.mjs`, not committed —
  scratch, like T4b/T5/T9's CDP drivers) replaced the old 7-column reader with one that
  scrapes the current 6-column layout: bucket `.bucket-sum`, item cells by role
  (`.drill-toggle span` for Actual avg, `.delta` for Δ), and the plan-header `.nums`
  line. Ran it against the real local `csp.html` for **both people × three window
  shapes** (`last3months` — the default, past-only; `last12months` — past-only; `thisyear`
  — crosses 2026-10-06, so it exercises the to-date/projected split) against an
  independent Node `computeCsp()` run reading the same `plan_targets` rows from
  `local/dashboard.db`. **102 of 102 checks passed**: every plan/bucket/item actual,
  every signed delta string (`+$X`/`−$X`/`$0.00`), both untracked items (Woody's
  Groceries, Rajna's Stocks) showing *target only — not tracked* instead of a column,
  and every bucket's Unassigned row — all to the cent, across all six owner×preset
  combinations.
- `npm run check:csp -- --db` — unchanged, all checks pass (229 matched rows, 0
  duplicates, exactly 1 catch-all per plan, all 8 direction-aware status cases, both
  people).
- **Restored afterward**, same as T3/T4b/T6: `docs/app.js`, `docs/ledger.html`,
  `docs/paycheck.js` and `docs/data/snapshot.json` reverted via `git checkout --`; the
  newly-generated `docs/csp.html`, `docs/csp.js`, `docs/nav-plan.js`, `docs/view-switch.js`,
  `docs/timeframe-ui.js` and `docs/shared/{csp,timeframe}.js` deleted (they didn't exist
  before this test publish); `sync_meta` reset to `local_version=15`, `dirty=1`,
  `published_by=woody`, `last_published_at=2026-09-30T17:40:13.499Z`. `docs/index.html`
  and `docs/mock-api.js` were left untouched — those are T6's intentional hand-edits, not
  publish output. Nothing pushed; the only lasting change is this write-up.

## T14 — Docs · **Sonnet** — ✅ **done (2026-10-06)**

README's Spending Plan bullet (collapsed-by-default sections, what the header line
shows), the Phase 11 roadmap entry, and a line in each task above recording what
actually shipped. Add resolved decision #12 to the list below if the build surfaces a
judgment call worth freezing.

### What shipped

- **`README.md`** — the Spending Plan bullet now describes the collapsed-by-default
  buckets and names what the one-line header shows (title, target/actual with their
  percent of take-home, the colored Δ), and how to open one (click the line, or
  Expand all/Collapse all), ahead of the pre-existing timeframe/drill-down/Save text.
- **`ROADMAP.md`** — Phase 11 ticked `[x]` with its bullet rewritten in the past tense
  to match what T9–T13 actually built (collapsed sections, derived rec%/catch-all, the
  dropped Status column/pills/provenance line, the republish + 102/102 re-verify), and
  §8 reconciled in two places that had gone stale: the `rec_pct` bullet no longer says
  it colors "the status pill" (there isn't one), and the per-row shape bullet no longer
  lists a `· status` column — both now describe the colored Δ as the only signal. Added
  one new §8 bullet for the collapsed-bucket-header behavior and the
  "derived values are text, inputs stay inputs" rule (decision #12).
- **T9–T13 above** already carry their own "What shipped"/"Shipped" write-ups from each
  task's own completion — nothing further to add there.
- **Resolved decisions #12–14** were already added (by T9/T11's completions); none of
  T14's own work surfaced a new judgment call, so no #15.

## Resolved decisions — Phase 11

12. **Derived values are never form controls; user inputs are.** Bucket target/actual
    totals and their percentages, and the recommended range, render as text. Take-home,
    gross, net worth, item name, item target and match rules stay editable — they are
    what the calculations are *made of*. Structural facts (which bucket is the
    catch-all) are derived, not picked.
13. **One signal per fact.** The red/green Δ is the whole status display: no pills, no
    `(above)`/`(within)`/`(below)` clause, no on-track/off-track wording. The
    `good/warn/bad` status still exists in the engine — it only drives the Δ's color now.
14. **Buckets are collapsed by default**, state remembered per bucket, so the page opens
    as a four-line overview of the plan rather than 35 item rows.

---

# Phase 12 — Theming (peach/mint) + a global Settings panel (user request, 2026-10-06)

A **second color theme for the whole site** — peach, pale yellow, mint and white, with
*pastel* red/green for the positive/negative numbers — plus a **settings launcher fixed
to the bottom-left corner** that grows slightly on hover, opens *out of that corner*
while darkening the rest of the screen, and holds the theme switch. **Low power moves
into that panel** and out of the Ledger header, where it is currently a seventh button.

## Goal (one paragraph)

Every page already paints itself out of one 11-token `:root` block that is **copy-pasted
into five local pages and `docs/index.html`** — so the cheapest honest way to add a theme
is to make that block the *only* place colors live, move it into a shared
`local/public/theme.css`, and add a `:root[data-theme="peach"]` override beside it. The
blocker is the ~60 hardcoded colors that bypass the tokens (`#fff` text on filled
accents, `rgba()` row tints / modal scrims / shadows, the paycheck pie's 9 category hues,
the dashboard chart's `#3987e5`): each one is invisible in the dark theme and *wrong* in a
light one, so the sweep is part of the feature, not a follow-up. On top of that lands one
new shared module, `settings.js`, mounted by every page: a gear in the bottom-left corner,
a panel that scales out of that corner over a scrim, **Appearance → Dark / Peach**, and
**Performance → Low power**. Theme choice and low power are both *per-machine*
(`localStorage`), never snapshot data — they are how *this* computer looks and renders,
not something to publish at the other person.

## How the work is split

- **Opus** takes the decisions that are expensive to get wrong and then get copied
  everywhere: the **token contract** (which tokens exist, what the peach values are, how
  text-on-a-filled-color works when the fill is pastel), the **settings panel**
  (overlay/focus/animation semantics on every page), and the **low-power relocation**
  (app.js owns a renderer that a module it doesn't import now toggles).
- **Sonnet** takes the mechanical, well-specified passes: sweeping the remaining
  hardcoded colors onto tokens page by page, the themed category palette, published-view
  parity + republish, and docs.

## Dependency order

```
T15 token layer + theme.css ──┬─ T16 settings panel ── T17 low power moves in ─┬─ T20 published parity ─ T21 docs
                              ├─ T18 hardcoded-color sweep ───────────────────┤
                              └─ T19 themed chart palettes ───────────────────┘
```

## Conventions that apply to every task

- Everything from the Phase 10 conventions block above still applies (`PATH` for node,
  never auto-save, N people, `shared/*.js` stays browser+Node, verify in the real app).
- **Dark stays byte-identical.** The dark theme is the default and the current look is
  the spec: a token extraction that shifts one dark pixel is a bug. Every refactor keeps
  the existing dark value as the `:root` value.
- **No theme flash.** The stored theme is applied by a tiny inline `<head>` script before
  the first paint, never by the deferred module.
- **Contrast is checked, not eyeballed.** Pastels on a near-white background cannot reach
  WCAG 4.5:1 — see resolved decision #15 for the line we hold and where.
- **Per-machine preferences never enter `snapshot.json`.** Theme and low power are
  `localStorage` only, like `currentUser`/`pubView`.

## T15 — The token layer: `theme.css` + the two themes · **Opus** — ✅ **done (2026-10-06)**

Make the palette a real contract instead of six copies of the same declaration.

- New **`local/public/theme.css`**: `:root` (dark, current values verbatim) and
  `:root[data-theme="peach"]`, plus `color-scheme` per theme so native scrollbars, date
  pickers and `<select>` popups follow the theme instead of staying dark.
- Grow the token set so nothing has to hardcode a color again: `--on-accent` /
  `--on-danger` / `--on-slice` (text *on* a filled color — the thing that breaks when the
  fill is pastel), `--scrim`, `--row-edited` / `--row-new` / `--row-neg`, the four
  `--banner-*` tints, `--shadow-sm|md|lg|photo`, `--chart-line`, and `--cat-*` for the
  nine paycheck categories.
- Replace the duplicated `:root` block in `index.html`, `paycheck.html`, `plan.html`,
  `csp.html`, `dashboard.html` and `docs/index.html` with a `<link>` + the no-flash head
  script.
- Register `theme.css` in the publish copy step so the published pages get it too.

## T16 — The settings launcher + panel · **Opus** — ✅ **done (2026-10-06)**

New **`local/public/settings.js`**, imported by every page, owning all of its own markup
and behavior; its CSS lives in `theme.css` so it is not duplicated per page.

- A gear **fixed in the bottom-left corner**, `scale(1.08)` on hover.
- Click opens a panel that **scales out of that corner** (`transform-origin: bottom left`)
  over a **scrim that darkens the rest of the screen**; Esc, scrim click, and the close
  button all dismiss; focus moves into the panel and returns to the gear on close.
- **Appearance** — a two-option segmented control, *Dark* / *Peach*, writing
  `localStorage.theme` and `documentElement.dataset.theme`.
- Mounted bottom-left on purpose: every page's top-right is already full of
  Publish/Sync/Save and the person chip, and the corner is free on all five pages.

## T17 — Move Low power into Settings · **Opus** — ✅ **done (2026-10-06)**

- Delete `#lowPowerBtn` from the Ledger header and its `setLowPower` button-label /
  `aria-pressed` bookkeeping from `app.js`.
- `settings.js` becomes the owner: it writes `localStorage.lowPower`, toggles
  `body.lowpower`, and dispatches a `lowpowerchange` event; `app.js` listens and
  re-renders. The event is the whole contract — `settings.js` must not know the Ledger
  exists, and the other four pages just ignore it.
- Script order matters: `settings.js` before `app.js` so `body.lowpower` is set before
  the Ledger's first render (it currently relies on `setLowPower(…, false)` at init).
- `docs/mock-api.js` stops hiding `#lowPowerBtn` (gone), and must *not* hide the gear —
  low power and theme are exactly as useful on the published grid.

## T18 — Sweep the hardcoded colors onto tokens · **Sonnet** — ✅ **done (2026-10-06)**

The ~45 remaining literals in page CSS: `color: #fff` on filled accents/avatars →
`var(--on-accent)`; `tr.edited` / `tr.new-row` / `tr.neg-row` tints → `var(--row-*)`;
`.banner.warn` / `.banner.ok` → `var(--banner-*)`; modal scrims → `var(--scrim)`;
`box-shadow: … rgba(0,0,0,…)` → `var(--shadow-*)`; `.dirty-note`'s literal `#e0a336` →
`var(--warn)`. Files: `index.html`, `paycheck.html`, `plan.html`, `csp.html`,
`dashboard.html`, `view-switch.js`, `shared/dashboard-render.js`.

## T19 — Themed chart palettes · **Sonnet** — ✅ **done (2026-10-06)**

`paycheck.js`'s `CAT_COLORS`/`OTHER_COLOR` become `var(--cat-*)` lookups (SVG `fill`
takes `var()`), `.slice-label` takes `var(--on-slice)`, and `dashboard-render.js`'s three
`#3987e5` occurrences take `var(--chart-line)`. The peach theme gets a pastel categorical
set in the peach/apricot/butter/mint family with dark slice labels; the dark theme keeps
its current validated hues exactly.

## T20 — Published parity · **Sonnet** — ✅ **done (2026-10-06)**

`theme.css` + `settings.js` added to the publish copy lists, `docs/index.html` converted
to the shared token layer, `docs/` regenerated, and both themes walked on all five local
pages + the published set.

## T21 — Docs · **Sonnet** — ✅ **done (2026-10-06)**

README (a Settings/theming bullet), ROADMAP Phase 12, the per-task "What shipped"
write-ups here, and resolved decisions #15+.

---

## What shipped — Phase 12

### T15 — the token layer

- **`local/public/theme.css`** (new) is now the only place a color is written.
  `:root` is the dark theme with its **original values verbatim**;
  `:root[data-theme="peach"]` is the new one. Each sets `color-scheme`, so native
  scrollbars, `<select>` popups and the date pickers follow the theme instead of
  staying dark in a light page.
- The token set grew from 11 to ~35: `--on-accent` / `--on-danger` / `--on-slice`
  (text *on* a filled color), `--scrim`, `--row-edited` / `--row-new` / `--row-neg`,
  four `--banner-*`, `--shadow-sm|md|lg|photo`, `--btn-hover-filter`, `--chart-line`,
  and nine `--cat-*`. Each one exists because some page was hardcoding that value.
- **The peach palette**: `--bg` pale yellow `#fff8ea`, `--panel` white, `--panel-2`
  peach `#fff1e2`, `--line` peach `#ecd8c6`, `--accent` deep mint `#1b8168` with
  pastel mint `--accent-weak` `#d7f0e7`. Surfaces **invert** the dark convention —
  the page is the tinted one and panels are pure white, separated by a peach border
  rather than by luminance, which is how light UIs actually read.
- `--btn-hover-filter` came out of the build: `.btn:hover`'s hardcoded
  `brightness(1.08)` *lightens*, which is right on a dark page and wrong on a light
  one (it washed the mint button out and dropped its white label under 4.5:1). Dark
  brightens, peach darkens.
- The duplicated `:root` block is gone from `index.html`, `paycheck.html`,
  `plan.html`, `csp.html`, `dashboard.html` and `docs/index.html`, each replaced by a
  `<link>` plus a 1-line inline `<head>` script that applies the stored theme before
  the first paint.

### T16 — the launcher + panel

- **`local/public/settings.js`** (new) builds everything itself: the gear
  (`position: fixed; left: 18px; bottom: 18px`, `scale(1.08)` on hover), the scrim,
  and the panel with `transform-origin: bottom left` scaling `.85 → 1` — so it grows
  out of the corner the gear sits in. The gear fades out while the panel is open, so
  the corner holds one thing at a time.
- Dismiss by Esc, scrim click, or the ✕; focus moves to the panel on open and
  **returns to the gear** on close; Tab cycles inside the panel while it's open.
  `prefers-reduced-motion` drops every transition (and a `setTimeout` backs up the
  `transitionend` that then never fires).
- Its CSS lives in `theme.css`, not in the module and not in five inline `<style>`
  blocks.

### T17 — low power moved

- `#lowPowerBtn` is gone from the Ledger header (which was carrying seven buttons)
  and `setLowPower`'s button-label/`aria-pressed` bookkeeping is gone from `app.js`.
- `settings.js` owns `localStorage.lowPower` and `body.lowpower` and dispatches
  `lowpowerchange`; `app.js` is 4 lines that update `state.lowPower` and re-render.
  Verified live: toggling the switch takes the ledger from 476 `<input>`s to 68
  inputs + 408 text cells and back, with no reload.
- `settings.js` is mounted **before** `app.js` so `body.lowpower` is set before the
  first render — and it mounts synchronously rather than on `DOMContentLoaded`, which
  fires *after* every deferred module including `app.js`.
- `docs/mock-api.js` no longer hides `#lowPowerBtn`, and does not hide the gear:
  theme and rendering are the reader's own machine preferences.

### T18 / T19 — the sweep

- 38 literals replaced across `index.html`, `paycheck.html`, `plan.html`, `csp.html`,
  `dashboard.html`, `view-switch.js` and `shared/dashboard-render.js`, plus
  `nav-plan.js`'s dropdown shadow. `grep` for a hex or `rgba()` outside `theme.css`
  now returns nothing in any page, shared module or page script.
- `paycheck.js`'s `CAT_COLORS`/`OTHER_COLOR` and `dashboard-render.js`'s three
  `#3987e5` are `var()` lookups now. Confirmed in headless Chrome that `var()`
  resolves in SVG **presentation attributes** (`fill="var(--x)"`), which the chart
  code already assumed for `var(--neg)` — so the existing pattern was kept rather
  than rewritten to inline `style`.
- Peach gets a pastel categorical set (apricot / mint / butter / sage / lilac / rose)
  with **dark** slice labels; dark keeps its validated hues exactly.

### T20 — published parity

- `settings.js` joined the publish copy list in `local/server.js`, and a new CSS copy
  step carries `theme.css` — a published page missing it renders *unstyled*, not just
  un-themed, so it isn't optional.
- Verified: all five local pages and all four published pages in both themes, the
  panel open in both themes, low power × peach, Esc/focus behavior, `npm run
  check:csp` still 102/102, and `npm run check:theme` passing. `docs/` was
  regenerated with the file-generation half of publish only — **no** version bump, no
  `snapshot.json` write, no commit, no push; a real **Publish** still does that.

### T21 — docs

README got a *Settings — themes and low power* section (what the gear does, both
themes, what low power changes, and that both are per-computer and don't travel in a
Publish); ROADMAP got the Phase 12 entry; this file got the write-ups above and the
decisions below.

## Resolved decisions — Phase 12

15. **Pastel red/green is capped by arithmetic, so the cap is the spec.** A true
    pastel on a near-white page tops out around 2.5:1 and is unreadable. `--pos`
    `#2f9b74` and `--neg` `#d06b7d` sit at **~3.3:1** — soft and clearly pastel next
    to the dark theme's values, and legible because every place they appear is a bold
    figure, a tabular cell or an icon (WCAG's 3:1 large-text line). `--text` is still
    held to 4.5:1. This is a deliberate floor, not an oversight.
16. **"Text on a filled color" is a token, never a literal.** White works on a
    saturated blue and fails on a pastel mint, so `--on-accent` / `--on-danger` /
    `--on-slice` are per-theme. This is also why the peach `--accent` is a *deep*
    mint (`#1b8168`): pastel mint is `--accent-weak`, for backgrounds that carry
    `--text`, while anything that carries white has to earn it.
17. **The low-power contract is one event.** `settings.js` owns the preference;
    `app.js` owns the renderer; `lowpowerchange` is the only thing between them.
    Neither imports the other, and a page with no lighter renderer just never
    listens — which is what let the toggle move to a panel shared by five pages.
18. **Appearance is per-machine and never published.** Theme and low power are
    `localStorage`, like `currentUser`/`pubView` — they describe how *this* computer
    looks and renders, so they stay out of `snapshot.json` and each person keeps
    their own.

---

# Phase 12b — Theme follows the profile (user follow-up, 2026-10-06)

Two corrections to Phase 12's resolved decision #18, which made the theme a
per-machine preference:

> *"theme should persist per profile on publish"* … *"actually theme should
> persist locally without needing to press publish"*

So the theme is **profile data**, not machine data: it belongs to the person, it
travels in `snapshot.json` on the next **Publish**, and it is written and applied
**the instant you pick it** — no Save, no Publish required for it to stick locally.
Low power stays per-machine (it describes what *this* computer can render, not who
you are), so decision #18 now splits in two.

## How the work is split

- **Opus** takes the storage/resolution contract — three states (what the profile
  carries, what this machine cached, what this machine last saw the profile carry)
  have to collapse to one answer, pre-paint, including on a read-only published page
  where nobody can write the profile.
- **Sonnet** takes the plumbing: the column migration, the write endpoint, the
  `userchange` dispatches, publish list, parity and docs.

## T22 — The per-profile theme contract + `theme-boot.js` · **Opus** — ✅ **done (2026-10-06)**

- `theme` becomes a column on `people` — so it rides the existing snapshot export
  (`allRaw("people")`) and the existing per-record LWW merge (`mergeInto("people",
  …)`) with no new sync machinery at all.
- **`local/public/theme-boot.js`** (new, a *classic* blocking `<head>` script, not a
  module) replaces the inline no-flash snippet that was copied into six pages. It
  owns the storage keys and the resolution rule in one place and exposes them on
  `window.__theme` for `settings.js`, so the pre-paint answer and the post-load
  answer can't drift.
- **The resolution rule.** Three inputs per profile: `stored` (what the profile row
  carries — the DB locally, the snapshot on the published site), `theme:<id>` (this
  machine's cache, which is what makes pre-paint possible at all, since the profile
  row needs a fetch), and `themeSeen:<id>` (the last `stored` value this machine
  observed). If `stored` differs from `themeSeen`, the profile was changed elsewhere
  → adopt it. Otherwise the cache wins. That single rule covers all three cases: a
  local pick survives reload; a partner's change to your profile arrives on Sync; and
  a reader's pick on the **read-only** published page sticks (the write 404s, so
  `themeSeen` never advances and their cache keeps winning) until the owner really
  changes it.
- **A theme change must not mark the DB dirty.** The dirty middleware flags *any*
  successful mutation, which would make a cosmetic toggle claim there's unpublished
  data and pop the Publish button. The theme write gets its own route so it can be
  excluded by path: it still bumps `updated_at` (the LWW merge needs that), so it
  travels on the next Publish — it just doesn't *ask* for one.

## T23 — Plumbing · **Sonnet** — ✅ **done (2026-10-06)**

`ensureColumn("people", "theme", …)` in `db.js`; `PUT /api/people/:id/theme` in
`server.js` (validating against the known theme ids) excluded from the dirty hook;
`theme-boot.js` into the publish copy list and into all six pages' `<head>`;
`settings.js` writing through to the profile and re-resolving on a `userchange`
event; that event dispatched from the two places that switch person *without* a
reload (`app.js`'s `selectUser`, `dashboard.js`'s View buttons) and from
`docs/index.html`'s View selector. `paycheck.js` already reloads on switch, so the
boot script covers it.

## T24 — Published parity + docs · **Sonnet** — ✅ **done (2026-10-06)**

Walk both themes across both profiles locally and published, confirm the read-only
page's write 404s without breaking the toggle, re-run `check:theme` / `check:csp`,
and update README / ROADMAP / this file (decision #18 split into #18a/#18b, plus the
resolution rule as #19).

---

## What shipped — Phase 12b

- **`people.theme`** (`local/db.js`, `ensureColumn` like `avatar`/`pay_cadence`), so the
  theme rides the existing `snapshot.json` export (`allRaw("people")`) and the existing
  per-record LWW merge (`mergeInto("people", …)`). **No new sync machinery.** Verified
  against the real snapshot builder: a theme set on a person comes out in
  `snap.people[].theme`.
- **`PUT /api/people/:id/theme`** (`local/server.js`) — 200 with the updated row, **400**
  on a theme nobody can render (rejected rather than coerced: silently storing it would
  resurface later as "my choice didn't stick" with nothing to point at), **404** on an
  unknown person. Added to the dirty middleware's exclusion list by path, which is the
  reason it's its own route rather than a field on a general people PATCH.
- **`local/public/theme-boot.js`** (new) — a classic blocking `<head>` script replacing
  the inline no-flash snippet that had been copied into six pages. It owns the storage
  keys (`theme:<id>`, `themeSeen:<id>`, with a fallback to the flat `theme` key written
  before the theme was per-profile, so an existing choice isn't thrown away) and the one
  resolution rule, exposed on `window.__theme` so the pre-paint answer and the post-load
  answer come from the same code.
- **`settings.js`** no longer stores the theme itself: it mirrors the pick into the cache,
  writes it through to the profile, and advances last-seen **only if the write succeeded**
  — which is precisely what makes the read-only published case work. It re-resolves on a
  `userchange` event, dispatched from the two places that switch person without a reload
  (`app.js`'s `selectUser`, `dashboard.js`'s View buttons) and from `docs/index.html`'s
  View selector. `paycheck.js` reloads on switch, so `theme-boot.js` covers it.
- **`window.__profileThemes`** — an opt-in hook for a page that already has the people
  list. The published dashboard reads people straight out of `snapshot.json` and has no
  `/api/` shim, so without this it would 404 on `/api/people` on every single load;
  verified that it now issues **zero** `/api/` requests.
- **A real bug found by the published tests.** The publish step injected
  `docs/mock-api.js` ahead of the *page's* script but behind `settings.js`, so
  `settings.js`'s `/api/people` read escaped the read-only shim. On the live site that
  would have hit `https://thewam.github.io/api/people` — caught and degraded to the
  cache, so it looked fine, but the profile's published theme would never have been
  picked up at all. `injectShim` now anchors on the **first** module script: the shim has
  to be installed before *anything* that touches the API, not just before the page's own
  script.

### Verified

| | |
|---|---|
| clean machine, profile carries peach | adopted from the profile, cached, last-seen set |
| switch person in place (no reload) | theme follows the new profile immediately |
| pick a theme | in the DB within the same click — no Save, no Publish |
| reload | right theme, from cache, pre-paint (asserted at `readystatechange`) |
| profile changed elsewhere (a Sync) | stored ≠ last-seen → adopted |
| theme write | does **not** set the dirty flag; a normal write still does |
| invalid theme / unknown person | 400 / 404 |
| read-only published page | write 404s, reader's pick survives reload |
| owner's published theme vs. reader's pick | owner's wins once it really changes |
| published dashboard | zero `/api/` requests |
| both themes × 5 local + 4 published pages | correct, gear present, old header button gone |
| `check:theme`, `check:csp` | pass |

Test writes landed in the live DB, so both `people` rows were restored to their published
state afterwards — `theme = ''` and the original `updated_at` — so nothing from a test can
win an LWW merge against the other machine. `dirty` was likewise put back as found.

`docs/csp.html` still renders empty: the published snapshot is **v15 from 2026-09-30**,
before the CSP feature, so it carries no `csp_plan`/`csp_item` rows. Pre-existing, not
from this work, and it resolves on the next real **Publish** — which is also when profile
themes start travelling.

## Resolved decisions — Phase 12b

18a. **~~Appearance is per-machine~~ — superseded.** Phase 12's decision #18 is split.
     **The theme belongs to the person**: stored on their `people` row, carried by the
     snapshot and the LWW merge, so switching person switches theme and a Publish takes
     your choice to the other machine and the published site.
18b. **Low power stays per-machine.** It describes what *this* computer can render, not
     who is using it, so it remains `localStorage` and never enters the snapshot. The two
     settings sit in the same panel and are deliberately not the same kind of thing.
19.  **Three states, one rule.** `stored` (the profile row), `theme:<id>` (this machine's
     cache — the only thing available pre-paint) and `themeSeen:<id>` (the last `stored`
     value this machine observed) collapse to: *if `stored` differs from `themeSeen`, the
     profile changed elsewhere — adopt it; otherwise the cache wins.* One rule, three
     cases: a local pick survives reload; a partner's change arrives on Sync; and a
     reader's pick on the read-only published page sticks, because the write 404s so
     `themeSeen` never advances — yielding only when the owner genuinely changes it.
20.  **A cosmetic write must not ask for a Publish.** The theme write bumps `updated_at`
     (the merge needs it) but is excluded from the dirty flag, so it rides the next
     Publish without claiming there is data to push. That requirement is what gave the
     theme its own route.

---

# Phase 13 — Credit Cards (user request, 2026-10-06)

Most daily spending happens on cards, so the ledger currently sees it only as a monthly
lump: 175 `Credit Card Payment` rows totalling ~$67k of outflow, with no idea what any of
it bought. This phase gives every card its **own ledger** (a second account in the
existing account dropdown), a **Credit subtab inside *This Paycheck*** that is to a card
what the existing page is to a checking account, a **statement CSV uploader** that never
lets the file touch disk, and category-accurate **CSP attribution** for the money that
currently disappears into "Debt Payments".

> **Revised 2026-10-07 after two rounds of mockup feedback** (`local/public/cards-mock.html`,
> rev 3). Four structural changes from the original plan, each recorded as a resolved
> decision below: cards became a **subtab of This Paycheck** sharing its pay-period window
> rather than a fifth top-level tab with its own timeframe control (**#37**, revising #25);
> the category/merchant **rollup was cut** (**#39**); **decision #21 was replaced** — the CSP
> counts the *full* card payment, not a paydown residual (**#21**, rewritten); and
> `Debt Payments` got its **own coloring rule** (**#38**). A new **T32b** builds the debt
> payoff projection the feedback asked for, collapsed by default with ephemeral what-ifs
> (**#40**). T27, T28, T31, T32, T33, T36 and T37 were rewritten to match, and the stale
> ASCII mockups were deleted in favor of the live `cards-mock.html`; T25, T26, T26b, T29,
> T30, T34 and T35 are unaffected.

## Running Phases 13 and 14 in parallel — the shared prologue

**They can run in parallel, and should, with one reordering: Phase 14's `T38` runs first,
as a prologue to both.** The two phases are otherwise ~85% disjoint — Phase 13 lives in
`paycheck.html` / `shared/cards.js` / `shared/csp.js` / `db.js`, Phase 14 in `theme.css` /
`theme-boot.js` / `settings.js` — but they collide hard in exactly two files, and the
collision lands on Phase 14's hardest task.

| File | Phase 13 wants | Phase 14 wants | |
|---|---|---|---|
| `theme.css` | T31: +3 `--cat-*` tokens × 2 variants | T38/T42/T43: every selector restructured, 2 → 12 variants | **hard** |
| `local/check-theme.js` | T31: +3 names in the `on-slice on cat-*` list | T40: rewrite enumeration, rekey `KNOWN`, add hue separation | **hard** |
| `local/db.js` | T26: 4 `ensureColumn` calls | T41: 1 `ensureColumn` call | trivial |
| `local/server.js` | T26 card routes, T36 publish lists | T41 theme route, T46 publish confirm | trivial |
| `docs/mock-api.js` | T36: card read routes | T46: sweep its color assumptions | trivial |

**The cost multiplier, which is the actual reason to reorder.** T40 asserts pairwise hue
separation across **nine** `--cat-*` values per variant and decision #33 makes that
identity-critical. Phase 13 takes the category list to **twelve**. Run in parallel, T42/T43
generate 108 hues and then 36 get retrofitted under the tightest constraint in the phase —
and it is tightest exactly where it hurts, on a narrow palette like **Thicket** (forest
green + willow green + scarlet + lemon chiffon), which has to separate twelve hues, not
nine.

**The prologue, therefore:**

1. **T38 first** (Phase 14's token contract — already its first task, and self-contained:
   restructure selectors, ship slate×2 + peach×2).
2. **The three new category tokens move into T38**, not T31. T38 declares the final
   **twelve**-name `--cat-*` contract so T40's separation assertion is written once, T43
   generates 144 values rather than 108 + a retrofit, and T44's legend is right the first
   time. T31 then only *consumes* `var(--cat-groceries)` and touches **neither**
   `theme.css` nor `check-theme.js` — both hard collisions disappear.
3. **T36 folds into T46.** Both are "walk every page in every variant". T36 verifies only
   the variants that exist when it runs; the full twelve-variant walk happens once, in T46,
   which absorbs the card pages.

**What does not wait.** Phase 13's entire data half — **T25, T26, T26b, T27, T28** — touches
no stylesheet and can start immediately, in parallel with T38. Only T31 onward wants the
tokens.

**If the reordering is rejected:** the phases still run in parallel up to T40, and the
serialization point becomes **T40/T42/T43 must not start until T31's `theme.css` edit has
landed.** That ordering works; it just pays the 36-value retrofit.

**Which phase ships first is a separate question.** Phase 13 carries the user-facing value;
Phase 14 is appearance. The prologue is one task deep, so it does not meaningfully delay
Phase 13.

## Goal (one paragraph)

Each person gets a Checking ledger *and* one ledger per credit card, selected with the
`#account` dropdown the Ledger already has. A monthly statement CSV can be dropped on a
card to populate its ledger — parsed in the browser, reviewed before anything is written,
deduped against what's already there, and auto-categorized from remembered merchant
rules, with repeating charges offered up as future-dated projections. *This Paycheck* gains
a **`[ Debit | Credit ]` subtab switch**: Debit is today's page unchanged, and Credit is the
same shape — stat row, banner, category donut, editable mini-ledger staged behind
Save/Discard — for one card over **the same pay window**, plus total debt across the
person's cards and a collapsible **debt payoff projection**. The CSP stops reading a card as
one opaque `Credit Card Payment` line and starts reading the purchases behind it, so
*Groceries*, *Bills* and the rest finally include the dollars that were paid with plastic —
while `Debt Payments` keeps measuring the money that actually left checking.

## What already exists (do not rebuild)

- `accounts.type` **already** accepts `credit_card`; `/api/accounts` already returns a
  computed `balance` per account via `accountLedger()`; `#account` in `index.html` already
  lists the current person's accounts (`owner === currentUser || owner === 'shared'`).
  A card ledger is a new **row**, not new plumbing.
- `mergeInto()` reads `PRAGMA table_info` and `buildSnapshot()` does `SELECT *`, so **new
  columns ride the snapshot and the LWW merge with zero sync work.** Adding a column is
  the whole migration.
- `local/import-csv.js` has a correct quoted-CSV parser (`parseCsv`) and a
  balance-reconciliation pass (`reconcile`) worth reusing — but it is a CLI one-shot keyed
  to the Google Sheet's six columns, and it `readFileSync`s a path. Neither suits upload.
- `paycheck.js`'s `generateRecurring()` already does weekly/biweekly/monthly/per-period
  occurrence generation with a 300-row cap and month-end clamping. Extract, don't rewrite.
- `shared/timeframe.js` already has `MONTH_PRESETS` + `monthPresetWindow` at whole-calendar-month
  granularity, and `timeframe-ui.js` mounts the control in a few lines.

## How the work is split

- **Opus** takes everything where money can go quietly wrong: the money-movement contract
  (T25), the debt/statement math (T27), the CSP attribution basis (T28), the per-issuer sign
  conventions in the importer (T29), recurring detection (T30), the compute wiring (T32),
  the payoff projection's amortization (T32b), and the paired-transfer flow (T34) — a
  half-correct transfer pair silently corrupts two balances at once.
- **Sonnet** takes the work with an existing template in this repo: the additive
  migrations + CRUD (T26, modeled on the `accounts`/`plan_targets` routes), the subtab
  scaffold and the review modal (T31, modeled on `paycheck.html` + `view-switch.js`),
  Ledger/nav polish (T33), the Dashboard tile (T35), published parity (T36, modeled on
  T6/T13), and the checker + docs (T37, modeled on `check-csp.js`).

## Dependency order

```
T38 token contract (Opus, Phase 14)  ◀── PROLOGUE: ship the 12-name --cat-* contract first
 │                                       (see "Running Phases 13 and 14 in parallel")
 │   T25–T28 do not wait on it; T31 onward does.
 │
T25 spec freeze + card inventory + statement intake  (Opus)
 │
 └─ T26 data model + CRUD  (Sonnet)
     │
     └─ T26b LOAD THE LEDGERS  (Opus)   ◀── direct SQLite load; unblocks everything below
         │                                   with real data, and is NOT the uploader
         ├─ T27 shared/cards.js              (Opus)
         ├─ T28 CSP card attribution         (Opus)
         ├─ T31 Credit subtab scaffold (Sonnet) ─ T32 wire compute (Opus) ──┐
         │                                            └─ T32b payoff proj (Opus) ─┤
         ├─ T33 Ledger + nav                 (Sonnet)                            │
         ├─ T34 paired transfers             (Opus)   🚩 strictly after T26b      │
         ├─ T35 Dashboard debt               (Sonnet)                            │
         │                                                                       │
         └─ T29 statement uploader (Opus) ─ T30 rules + recurring (Opus) ────────┤
            (verified by diffing against T26b's known-good rows)                 │
                                                                                 │
                                         T36 published parity (Sonnet) ─ T37 checker + docs (Sonnet)
```

T25 gates everything; **T26b then unblocks the entire rest of the phase with real data in
the database.** T27/T28/T31/T33/T35 are independent of each other and can run in parallel
after it. T29/T30 — the *feature* that reads statements — is no longer on the critical path
for having data, which is the point of the split: it ships and is tested on its own
schedule. T31 needs T26's CRUD but not T29 (the upload button can land disabled). **T32b
needs T32's `computeView()` seam and T26's `accounts.data.apr` / `credit_limit`, and nothing
else** — it is additive and can be cut from the MVP without touching any other task. T36 must
come after **every** UI task — the publish step carries explicit file lists (see the T6
note: *"Lists, not one line per file"*) and a missed entry 404s the published page into a
blank screen. **Per the prologue, T36 verifies only the variants existing when it runs and
the full twelve-variant walk is Phase 14's T46**, which absorbs it.

**The one hard ordering constraint in the phase: T26b strictly before T34.** Both put rows
on the card side of a payment — T26b from whatever payments the statements show, T34 by
mirroring the 175 existing checking rows — and if they run in either overlapping order
without the guard spelled out in T34, every payment in the loaded months is counted twice
and each card's balance is wrong by a month of payments. There is no ordering in which that
is safe by accident.

## Conventions that apply to every task

Phase 10's conventions still hold in full — `export PATH="/opt/homebrew/bin:$PATH"`, no
`.transaction()` helper, **never auto-save**, N people not two, `shared/*.js` stays
dependency-free and browser+Node safe, seeds stamped `updated_at = epoch`, verify in the
real app with a headless screenshot. Phase 13 adds four:

- **The uploaded file never touches disk.** Parse it **client-side** with a `shared/`
  module and POST only parsed rows. No `multipart`, no `writeFileSync`, nothing under the
  repo, no new `.gitignore` entry needed because there is nothing to ignore. Cancelling the
  review modal leaves zero trace.
- **Debt is a negative balance, everywhere in the math.** A card account's
  `opening_balance` is negative (what you owed at the start), a **purchase is a
  `withdrawal`**, and a **payment or refund is a `deposit`**. `withRunningBalance()` and
  `accountLedger()` then work on cards **completely unchanged**, and `debt = -balance`.
  The sign flips **only at the display layer**. Resist the urge to store debt positive:
  that forks every metric in the repo.
- **Single-entry stays single-entry.** A card payment is *two* rows — a `withdrawal` on
  checking and a `deposit` on the card — joined by `transfer_id`. There is no journal
  table and no double-entry engine.
- **Every new number must reconcile to a stated identity**, asserted in `check-cards.js`
  (T37), the way `shared/csp.js`'s `reconciles` flag does today.

---

## What it looks like (mockups)

> **The live mockup is `local/public/cards-mock.html` (rev 3, 2026-10-07)** — open
> `http://localhost:3000/cards-mock.html` with the normal `npm start` (add `#import` or
> `#recur` to deep-link a modal). Static data, no server calls, nothing writes. It uses the
> real `theme.css` tokens with no literal colors, so both themes are faithful. Six screens:
> **0** a changelog of what the user's feedback changed and why, **1** the Debit subtab,
> **2** the Credit subtab (the one to build against), **3** the add-expense → recur flow,
> **4** the statement review modal, **5** the Spending Plan under the rewritten #21.
> Every figure on it is arithmetically consistent and the two card identities are printed
> on screen.
>
> It also carries six numbered **flags (F1–F6)** — the design problems building it
> surfaced, each with a proposal. F2 (the three missing `--cat-*` tokens) is folded into
> **Phase 14's T38** per the prologue, and F6 (decision #38's two sub-decisions) into T28;
> F1, F3 and F4 are in "Open" below.
>
> **The ASCII mockups of the Cards tab and the Spending Plan that used to live here were
> deleted**, not updated: they depicted the pre-#37 top-level tab with its own timeframe
> control and the pre-rewrite #21 paydown split, so leaving them would have meant two
> specs contradicting each other with no marker for which one won. The statement-review
> mockup went too — the live file's screen 4 is the same thing, rendered. **T31 deletes
> `cards-mock.html`** when the real subtab lands; it is a mockup, not a page.

The one mockup worth keeping inline, because it is unaffected by the feedback and has no
counterpart in the live file:

### The Ledger on a card account (T33)

```
Account [ Credit Cards ▸ Apple Card   ▾ ]              opening owed  $3,889.33

  date        category             merchant        charge    credit      OWED
  2026-09-02  Groceries            Whole Foods      84.21        —    3,973.54
  2026-09-05  Credit Card Payment  Apple Card          —   1,400.00   2,573.54
              ⇄ paired with Woody — Checking · 2026-09-05 · −$1,400.00
  2026-09-06  Misc                 Amazon           38.40        —    2,611.94
```

Same grid, same editing, three label changes: **Deposit/Withdrawal → Credit/Charge**,
**Running Balance → OWED** (counting *up* as you charge), and the negative-row highlight
inverted — a positive `OWED` is normal, a negative one means you overpaid. The `⇄` line is
the `transfer_id` pair from T34 made visible, because an unpaired payment has to be
*noticeable* to be fixable.

## T25 — Spec freeze: the money-movement contract + card inventory · **Opus** — ✅ **done (2026-10-08)**

> **Status.** The audit is done and written up below (*"T25 findings"*), yielding decisions
> **#43–#48**. Of the task's five done-when clauses, four are met: the `source → account`
> map is explicit and total, the per-issuer convention table is recorded, the staging
> directory is confirmed outside the repo, and every file is confirmed CSV. The fifth —
> *the per-card period + closing-balance inventory* — is met **only partially**, and not by
> omission: the closing balances per period **do not exist in the exports** (decision #45).
> **All sign-offs are in (2026-10-08).** #44's predicate was signed off as *money toward any
> card in the household inventory*, which makes Rajna's three cards `owner: 'shared'`; the
> Chase gap closed as a **non-gap** (**#49** — the card genuinely has no transactions, so its
> payment-only export is complete and its opening is exact); and the user is collecting the
> per-period closing balances, so #45's ladder is expected to be constructible for the four
> transacting cards after all. **T25 is done. T26 is unblocked.**
> **One residual, non-blocking:** statement day, due day and minimum payment are still
> unknown per card — they degrade T26's seed and T35's drift but gate nothing, since
> `Card_Totals.csv` already supplied every limit and APR.
> **Closed out (2026-10-08).** The user supplied one statement per transacting card
> (`~/Downloads/Statements`); `local/update-card-statement-meta.js` backfilled
> `statement_day`/`due_day` for all five (reproducing each statement's own close/due date
> exactly through `statementCycle()`) and corrected three stale APR guesses to the
> statements' current go-forward rates (Apple Card 25.74%→25.49%, Discover 19.74%→17.99%,
> Capital One 28.49%→28.24%; Citi and Rajna — Chase were already accurate, both mid-promo
> at 0%). `min_payment` stays `null` everywhere **on purpose**: every stated minimum this
> round was balance-dependent (Apple $310/$10,238.98, Discover $343/$17,138.92, Capital One
> $25 floor/$376.02), not a flat policy, and already tracks `minimumDue()`'s 2%-or-$25-floor
> fallback within a few dollars — see `local/seed-cards.js`'s updated `CARDS` table, now the
> source of truth for a future re-seed. `woody-chase-card` (closed, no statement) is
> unchanged. One data-quality note surfaced in passing, **not fixed here, out of this
> task's scope**: `rajna-chase`'s ledger-computed balance as of its 2026-10-02 close
> ($1,875.15) doesn't match that statement's stated New Balance ($1,835.15) — a $40 gap
> equal to the 09/27 automatic payment on that statement, suggesting that row's ledger date
> may not match the statement's posting date. Worth a look whenever someone's back in
> `shared/cards.js` reconciliation work (T37).

Nothing else can start until two questions have written answers. This task produces no
feature code — it produces the frozen contract (appended to this file as decisions #21–27)
plus one throwaway audit script.

**Unblocked 2026-10-08 — statements staged.** The user has placed the CSVs at
`~/Downloads/CSVs/` (outside the repo, satisfies the staging-path requirement below):
`Card_Totals.csv`, `Rajna_Capital_One.csv`, `Rajna_Chase.csv`, `Rajna_Discover.csv`,
`Woody_Apple.csv`, `Woody_Citi.CSV`. No Woody Discover or Woody Capital One file present
yet — confirm whether those cards have no statement to import (ledger-only, per the
Chase precedent) or are still pending. Part (c) below should read from this directory
rather than waiting on a further staging step.

**(a) The card inventory.** The 13 `Credit Card Payment` source strings in the ledger are
not 13 cards. Resolve them into the real set of `credit_card` accounts, with the
`source → account_id` mapping written down explicitly, because T26 backfills from it and
T34 matches payments against it. The raw data:

```
Apple Card 42 · Rajna Discover 26 · Discover 23 · Capital One 19 · Chase Card 5
Citi Card 22 · Rajna Chase 12 · Woody Discover 22 · Rajna Capital One 1
Vacation Apple Card 1 · Rajna 2
```

Specific ambiguities to settle **with the user**, not by guessing:
- `Discover` (23, 2026-01→2026-12) vs `Woody Discover` (22, same span, only $300 total) vs
  `Rajna Discover` (26) — two cards with a casing/naming split, or three cards?
- `Vacation Apple Card` — a second Apple Card, or a mislabeled row on the main one?
- `Chase Card` + `Rajna Chase` ($7,579 of payments) are real, but **Chase was not in the
  list of statement formats to support**. Is the Chase history closed out (no statement to
  import, ledger-only), or does T29 need a fifth adapter?
- `Credit Card Payment → Rajna` ($400, 2 rows) looks like a person-to-person transfer
  mislabeled as a card payment. Reclassify, or leave?
- Owner per card, and whether any is `owner: 'shared'` (the only way one card shows up for
  both people, per decision #24).
- Opening balance per card: a card ledger imported from statements starts *mid-history*, so
  `opening_balance` must be derived from a **known statement balance** at the earliest
  imported date, the same way `import-csv.js` derives it from the sheet's first running
  balance. Which statement is the anchor for each card?

**(b) The money-movement contract.** Write up decision #21 (below) as the frozen spec, with
the arithmetic worked through against real numbers for one month of Woody's Apple Card, and
get the user's sign-off. T28 codes directly against it.

**(c) Statement intake.** The user is supplying **several months of statements per card**
— serving double duty as the spec for T29's adapters *and* as the real data **T26b loads
directly into every card ledger** (decision #27). Note the two uses are deliberately
independent: the ledgers get loaded by hand, so this inventory is what T29's adapters are
*written from*, not what they are *needed for*. So this step inventories rather than samples:

- **Stage them outside the repo.** One directory per card under a path that is not inside
  `finance-dashboard/` at all (e.g. `~/statements-staging/apple-card/`), so there is no
  way for a statement to reach a commit and no `.gitignore` entry doing load-bearing work.
  They are deleted once T26b's reconciliation passes.
- **Record, per issuer, in this file:** the exact header row, the amount convention
  (single signed `Amount`? split `Debit`/`Credit`? purchases positive or negative?), the
  date columns present (transaction vs. post), the issuer's own category vocabulary, and
  whether the export is **one file per statement period** (Apple Card) or **one file for an
  arbitrary date range** (Capital One / Citi / Discover typically). That last distinction
  is not cosmetic: a date-range export means "a few months" may arrive as *one* file whose
  period boundaries have to be inferred, and it changes what T29's dedupe is defending
  against.
- **Record, per card:** the period each file covers, each statement's **closing balance**,
  and the earliest statement — which is the anchor T26b derives `opening_balance` from.
  Without a stated closing balance per period there is nothing to reconcile against, and
  the only provable claim left about the loaded data is "it parsed".
- **Check the format assumption first.** This plan assumes CSV throughout. If any issuer
  only offers a **PDF** statement, say so here and stop — PDF extraction is a different
  problem with a different failure mode (silently dropped rows rather than a parse error),
  and it needs its own task rather than being smuggled into T29.

An unverified guess at Citi's sign convention silently turns every purchase into a refund,
and here it would do it across months of seed data rather than one sample.

**Done when:** decisions #21–27 are written into this file and signed off; the
`source → card account` map is explicit and total (every one of the 175 rows maps somewhere
or is explicitly reclassified); the per-issuer header/convention table and the per-card
period + closing-balance inventory are recorded; the staging directory is confirmed outside
the repo; and every file is confirmed CSV (or a PDF task is raised).

### T25 findings — the statement intake, audited 2026-10-08

Audited with a throwaway script over `~/Downloads/CSVs/` (confirmed **outside** the repo,
satisfies decision #27; one flat directory rather than one-per-card, which is immaterial
since each card is exactly one file). **All six files are CSV. No PDF. No PDF task is
raised.** Every file parsed cleanly with a plain quote-aware splitter — no embedded
newlines, no ragged rows.

**`Card_Totals.csv` is a sixth file the plan did not anticipate, and it is the most useful
one.** It supplies `Current Balance`, `Credit Limit` and `APR (%)` for all five cards —
which **closes the "Card APR and credit limit, per card" open item outright** and unblocks
**T32b** at full fidelity (no 0% fallback, no hidden limit line).

```
Card,Current Balance,Credit Limit,APR (%)
Woody Apple,10421.38,10500,25.74          ← 99.2% utilized
Woody Citi,6750.53,6800,0                 ← 99.3% utilized, 0% promo
Rajna Capital One,173.05,400,28.49        ← 43.3% utilized
Rajna Chase,1835.15,2100,0                ← 87.4% utilized, 0% promo
Rajna Discover,17134.81,25500,19.74       ← 67.2% utilized
                                            household debt: $36,314.92
```

#### Per-issuer header and convention table (T25(c), verified not inferred)

| issuer | header row (exact) | amount convention | dates | export shape |
|---|---|---|---|---|
| **Apple Card** | `Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By` | **single signed `Amount (USD)`** — purchase **positive**, payment/refund **negative** | txn + clearing | one date-range file (8 months in one file), **not** one per period |
| **Citi** | `Status,Date,Description,Debit,Credit` | split, **but `Credit` is itself negative** (`-66`, not `66`) → `amount = Debit + Credit`, **never `Debit − Credit`** | single `Date` only | one date-range file |
| **Capital One** | `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit` | split, both columns **positive** → `amount = Debit − Credit` | txn + posted | one date-range file |
| **Discover** | `Trans. Date,Post Date,Description,Amount,Category` | **single signed `Amount`** — charge **positive**, payment/credit **negative** | trans + post | one date-range file |
| **Chase** | `Payment date  and details,Status,Amount` *(note the **double space** in the header)* | `$40.00 ` — currency symbol, **trailing space**, always an outflow; sign must be **applied**, not read | one date only | **payment history, not a statement** |

**Line endings: five of six files are CRLF** (`Rajna_Capital_One.csv` alone is LF). Not
cosmetic — splitting on `\n` without stripping `\r` leaves the **last column's header keyed
as `"Credit\r"`**, so a lookup by name silently returns `undefined` and every Citi payment
reads as zero. It cost a wrong match rate inside this very audit: Citi scored **0/4** before
the strip and **4/4** after. **T29's parser must strip `\r` before keying**, and note the
bug is invisible for Apple and Discover only because their last column is one nobody reads.

**Citi is the trap T25 was written to catch, and it is a real one.** `Debit − Credit` —
the natural reading of a split-column export and the convention Capital One actually uses
— produces `6019.53 + 269.00` and an **implied opening balance of −$538.00**, i.e. a card
that started with money on it. Corrected to `Debit + Credit`, Citi reconciles to the cent
(below). The two split-column issuers use **opposite** conventions; T29 must not share one
split-column adapter between them.

**Apple's `Type` column is load-bearing**, and `Type` ≠ `Category`: `Purchase` (506),
`Payment` (37), `Interest` (8), `Debit` (7), `Credit` (7), `Other` (2). The `Credit`/`Debit`
pairs are refunds — a negative `(RETURN)` row plus a positive `DAILY CASH ADJUSTMENT` row
clawing back the cashback. **Filter payments on `Type === 'Payment'`, not on the sign**, or
every refund is misread as a payment.

**Issuer category vocabularies, verbatim (they do not agree with each other or with ours):**
- **Apple Card** (18): `Restaurants` `Other` `Gas` `Grocery` `Payment` `Entertainment` `Medical` `Transportation` `Interest` `Airlines` `Debit` `Credit` `Insurance` `Utilities` `Alcohol` `Shopping` `Govt-services-parking` `Hotels`
- **Capital One** (12): `Dining` `Other Travel` `Merchandise` `Payment/Credit` `Health Care` `Other Services` `Entertainment` `Internet` `Gas/Automotive` `Phone/Cable` `Fee/Interest Charge` + blank (6 rows)
- **Discover** (11): `Restaurants` `Merchandise` `Payments and Credits` `Travel/ Entertainment` *(note the space after the slash)* `Interest` `Awards and Rebate Credits` `Supermarkets` `Gasoline` `Medical Services` `Services` `Fees`
- **Citi**: **no category column at all** — 26 rows, zero issuer categories. Citi purchases are 100% dependent on T30's merchant rules.
- **Chase**: n/a.

**Interest, fees and annual charges — included by every issuer that exports transactions:**

| card | interest/fee rows | total | notes |
|---|---|---|---|
| Apple Card | 11 | $1,269.36 | 8 monthly `Interest Charge` + `Interest Charge From Prior Cycles` + a $69.00 `La Fitness *annualfee` (a merchant charge, not a card fee — do not special-case on the word "fee") |
| Discover | 18 | $2,178.41 | **two** interest rows per month — a legacy `INTEREST CHARGE ON 08/18/2021 TO 03/03/2025` tranche plus `03/04/2025 AND AFTER - INTEREST CHARGE ON PURCHASES` |
| Capital One | 5 | $77.85 | $39.00 `CAPITAL ONE MEMBER FEE`; the rest are `UBER *ONE MEMBERSHIP` merchant subscriptions |
| Citi | 2 | $175.86 | `BALANCE TRANSFER FEE` $175.86 and `MEMBERSHIP FEE MAY 26-APR 27` **at $0.00** — a real row with a zero amount, which a `if (!amount) continue` guard would silently drop |
| Chase | 0 | — | payment history carries no charges at all |

No issuer omits its finance charges, so **T26b has no legitimate reason to fudge a period
into `opening_balance`.**

#### Per-card reconciliation (T25(c) — and the bad news about the ladder)

**The ladder T26b and T37 were designed around cannot be built from this export** — though
the user is collecting the missing numbers, so it is expected to exist by the time T26b
finishes (#45).
`Card_Totals.csv` states **one** `Current Balance` per card, not a closing balance per
period, and not one of the five transaction exports carries a running-balance column. So
the N-checks-per-card ladder collapses to **exactly one check per card** — *"replay every
row from the derived opening and you land on today's stated balance."* That is a real
check and it does prove the sign convention and that no rows were dropped **in aggregate**;
what it cannot do is localize a failure to a month, which was the ladder's whole point.
Stated plainly rather than papered over: this is the weakest link in the phase's
verification story, and **it is recoverable** — the per-period closing balances exist on
the issuers' statement pages and simply were not exported. See "Open".

Opening balances derived by replaying every row backwards from the stated current balance
(debt-positive here; `accounts.opening_balance` is the negation, per decision #22):

| card | rows | span | charges | credits | net | stated bal | **derived opening** | independent corroboration |
|---|---|---|---|---|---|---|---|---|
| Woody Apple | 567 | 2026-03-02 → 10-07 | $26,648.51 | −$24,145.21 | $2,503.30 | $10,421.38 | **−$7,918.08** | none — mid-history, unverifiable |
| Woody Citi | 26 | 2026-04-28 → 09-18 | $7,019.53 | −$269.00 | $6,750.53 | $6,750.53 | **$0.00** | ✅ **exact** — this is the card's complete history from account opening; the replay lands on $6,750.53 to the cent with zero opening |
| Rajna Capital One | 174 | 2026-03-03 → 10-06 | $4,370.63 | −$4,535.48 | −$164.85 | $173.05 | **−$337.90** | ✅ **strong** — the very first row is a $337.90 `CAPITAL ONE MOBILE PYMT` that zeroes it exactly, and the ledger's 2026-03-03 checking withdrawal is **also** $337.90 |
| Rajna Chase | 6 | 2026-05-14 → 10-27 | $0.00 | −$290.00 | −$290.00 | $1,835.15 | **−$2,125.15** | none — and see the Chase caveat below |
| Rajna Discover | 138 | 2026-03-04 → 10-05 | $4,746.40 | −$6,827.82 | −$2,081.42 | $17,134.81 | **−$19,216.23** | none — mid-history, unverifiable |

**Three of five openings are corroborated; two — Apple and Discover — rest on the single
stated balance, and those are the two the user is collecting per-period closing balances
for.** (Chase joins Citi and Capital One as corroborated once #49 establishes that its
export is complete: a payments-only card at 0% has no unexported charges for the opening to
be hiding.)

**The Chase number looked like a fudge and is not one — see decision #49.**
`Rajna_Chase.csv` is a **payment history**: six $40-ish payments, no purchases, no interest,
and a row dated **2026-10-27 marked `Pending`**. Replaying it backwards charges the entire
$2,125.15 to "opening," which is only correct if the card took on **zero** charges and
**zero** interest across those six months — and at 87% utilization ($1,835.15 of a $2,100
limit) the audit flagged that as the phase's likeliest silent fudge. **The user resolved it
2026-10-08: the card genuinely has no transactions.** It exists *"only for visibility of
payments being made"* — a dormant balance never used for purchases, and the 0% APR means
nothing accrues. So the export is **complete**, the opening is **exact**
($2,125.15 − $290.00 = $1,835.15, to the cent), and Chase is **exempt from the
reconciliation ladder** because a card with no charges has no periods to reconcile. No
`Adjustment` row and no fifth adapter.

**Also: `Pending` rows exist and are future-dated.** Chase's 2026-10-27 row is 19 days
ahead of the audit date. T29's dedupe has to defend against a `Pending` row being
re-exported later as `Completed` with a different posted date — a same-`external_id`
collision that the `(account_id, txn_date, amount, normalized merchant, occurrence-index)`
formula handles **only if** the date used is the one that does not change. Combined with
Citi's `Status` column (`Cleared`, 26/26) and Capital One's separate `Posted Date`: **T26b
and T29 must both key `external_id` on the transaction date, never the post/clearing date.**
Recording that here so the two paths cannot diverge on it.

#### The `source → account_id` map (T25(a)) — and where decision #42 got it wrong

Built by matching every past-dated checking-side payment against the card-side payment rows
in the statements. The match rates are decisive, not suggestive:

| checking source | ledger | matches card-side payments in | rate | verdict |
|---|---|---|---|---|
| `Apple Card` | woody | `Woody_Apple.csv` | **19/21** — 14 exact + **5 one-to-many splits** ($888.12 = 73.12+45+504+266; $1,443.82 = 443.82+1000; $824.27 = 6+818.27; $1,398.17 = 1.83+1398.17) | **Woody's Apple Card** |
| `Citi Card` | woody | `Woody_Citi.CSV` | **4/4 exact** ($70, $67, $66, $66) | **Woody's Citi** |
| `Capital One` | woody | `Rajna_Capital_One.csv` | **8/10 exact** — all eight listed ($337.90, $318.84, $286.79, $451.47, $73.53, $467.60, $415.33, $471.66); 11th checking row is $0.00 | **Rajna's Capital One** ⚠️ |
| `Chase Card` | woody | *nothing* — $5,000 / $750 / $250 / $19.99 / $49.00 matches no row in any file | — | **Woody's own Chase, closed out** |
| `Discover` | rajna | `Rajna_Discover.csv` | **14/21 exact** ($455, $76, $97, $500, $100, $63, $133, $131.71, $500, $800, $400, $400, $333.39, $600) | **Rajna's Discover** |
| `Rajna Chase` | woody | `Rajna_Chase.csv` | **5/5 exact** ($90, $40, $40, $40, $40) | **Rajna's Chase** ⚠️ |
| `Rajna Discover` | woody | `Rajna_Discover.csv` (partially) | money toward the same Discover card | **Rajna's Discover** ⚠️ |

⚠️ **marks a direct contradiction of decision #42**, which derived the inventory off a
purified `Credit Card Payment` category and concluded *"five cards — Apple Card,
Capital One, Chase Card, Citi Card (Woody) and Discover (Rajna)."* The statements say
otherwise on two counts, and `Card_Totals.csv` — written by the user — agrees with the
statements, not with #42:

1. **`Capital One` is Rajna's card, not Woody's.** Eight exact amount matches against
   `Rajna_Capital_One.csv` out of ten payable checking rows, and `Card_Totals.csv` lists it
   as `Rajna Capital One` with a $400 limit. Woody has no Capital One. So $6,271.90 currently sitting in **Woody's**
   `Debt Payments` is money toward a card **Rajna** holds — structurally identical to
   `Rajna Chase`, which #42 moved *out* for precisely that reason.
2. **`Rajna Chase` and `Rajna Discover` have live card counterparts after all.** #42 moved
   them to `Partner Transfer` on the stated grounds that there was *"no counterpart to
   pair, nothing to backfill on her ledger, and no sixth account."* `Rajna_Chase.csv` and
   `Rajna_Discover.csv` **disprove that premise** — both cards exist, both have balances in
   `Card_Totals.csv`, and `Rajna Chase`'s five payments match the Chase file 5/5 exactly.
   Leaving them as `Partner Transfer` now **discards five provable transfer pairings.**

So the real inventory is **six card accounts**, not five — and ownership splits 2/4, not
4/1:

| # | account (proposed `id`) | owner | statement | status |
|---|---|---|---|---|
| 1 | `woody-apple-card` | woody | `Woody_Apple.csv` | live, 99.2% utilized |
| 2 | `woody-citi-card` | woody | `Woody_Citi.CSV` | live, 0% promo, full history ✅ |
| 3 | `woody-chase-card` | woody | **none** | **closed out** — zero future rows, last 2026-09-03, paid off via the Citi balance transfer below; absent from `Card_Totals.csv` because its balance is $0 |
| 4 | `rajna-capital-one` | rajna | `Rajna_Capital_One.csv` | live, serviced by Woody |
| 5 | `rajna-chase` | rajna | `Rajna_Chase.csv` (payments only) | **dormant** — balance only, no purchases ever, 0% APR; serviced by Woody (#49) |
| 6 | `rajna-discover` | rajna | `Rajna_Discover.csv` | live, serviced by both |

Every one of the 175 `Credit Card Payment` rows maps: 42 Apple + 22 Citi + 19 Capital One
+ 5 Chase Card + 23 Discover + 1 `Vacation Apple Card` = 112 under the category, plus the
60 rows #42 moved to `Partner Transfer` and the 3 pre-existing `Zelle` rows.

#### Three things the statements revealed that no ledger reading could

1. **A $4,000 card-to-card payment with no checking counterpart.** Apple Card carries
   `2026-05-12  −4000.00  Bill Payment`, and Citi carries `2026-05-12  4000.00
   BAL XFR. APPLE CARD-GOLDMAN SACHS BANK`. It is a **balance transfer**, not a payment —
   $4,000 of debt moved from a 25.74% card to a 0% card and **no money left checking.**
   Citi also carries `2026-05-05  1862.14  BAL XFR. CHASE MASTERCARD & VISA`, which is how
   Woody's Chase Card got closed out, plus the $175.86 transfer fee on 05-14.
   **Consequences, all real:** T34's pairing must accept a card `deposit` whose
   counterparty is **another card**, not checking (a `transfer_id` between two card
   ledgers); T28 must **not** count it as `Debt Payments`, because no cash left; and T32b's
   projection is wrong unless it knows Citi's 0% is promotional — a 0% APR on a 99.3%
   utilized card is a teaser with an expiry, and `MEMBERSHIP FEE MAY 26-APR 27` dates the
   promo year.
2. **Not every card-side payment comes from checking.** Apple has six `Type === 'Payment'`
   rows in 2026-09 totalling $2,382.00 against three checking rows totalling $2,358.17.
   The $23.83 gap is two `Apple Cash Payment` rows ($22.00 + $1.83) — paid from Apple Cash,
   not the bank. **T34's guard must tolerate an unpairable card-side payment** rather than
   treating it as a data error, and T37 assertion #3 needs the same allowance.
3. **`Vacation Apple Card` is confirmed a statement credit, not a card.** One row,
   2026-08-05, **$324.57 deposit into checking**. No Apple Card row matches it and no sixth
   Apple account exists in `Card_Totals.csv`. #42's standing recommendation — fold its
   `source` into `Apple Card` — is correct and now evidenced.

#### T25(b) — the money-movement contract against real numbers

Decision #21 worked through **Woody's Apple Card, 2026-09**, transaction-date basis:

```
purchases net of refunds, by the issuer's own category
  Other                1848.08      Insurance              62.99
  Restaurants           478.10      Transportation         35.14
  Interest              207.35      ─────────────────────────────
  Alcohol               149.87      cardPurchases       3058.35
  Gas                   108.35
  Grocery               103.81      payments (checking)  2358.17
  Entertainment          64.66      excluded                0.00
```

```
identity:  bucketTotal + excluded === cashOutflow + cardPurchases
           (3058.35 + 2358.17) + 0.00 === 2358.17 + 3058.35
                        5416.52 === 5416.52          ✅ BALANCES
```

Charged $3,058.35, paid $2,358.17 → **debt grew $700.18 in a month the CSP will show as
$2,358.17 of `Debt Payments` against a $2,000 target, i.e. 118% and green.** That is
decision #21 working exactly as specified and as signed off — the question *"is the debt
actually moving?"* is the Credit subtab's (T32b), not the CSP's — but it is worth seeing
the first real month make the point so sharply.

Two things the real numbers surface that the contract did not anticipate:

- **`Interest` lands in a bucket as a purchase.** $207.35 of Apple interest, $2,178.41 of
  Discover interest across the window. Under #21 it enters at category `Interest`, which
  has **no CSP item**, so it falls to `Unassigned`. Interest is not discretionary spending
  and reads badly in a catch-all. Feeds the open "which card categories need their own CSP
  items" question — and the answer for `Interest` looks like **yes, its own item**.
- **`Other` is 60% of the month ($1,848.08 of $3,058.35).** The issuer vocabularies are too
  coarse to carry the CSP on their own, and Citi has no categories at all. **T30's merchant
  rules are not a nice-to-have — they are what makes decision #21's "at their own category"
  mean anything.** Worth re-weighting T30 accordingly.

---

## T26 — Data model: card accounts, account metadata, import identity, transfer pairing · **Sonnet** — ✅ **done (2026-10-08)**

Four additive `ensureColumn` migrations and the CRUD to match. No new tables — cards are
`accounts` rows, rules are `plan_targets` rows (T30).

- **`accounts.data TEXT NOT NULL DEFAULT '{}'`** — a JSON blob, same convention as
  `plan_targets.data`, holding the card-specific fields a generic accounts table shouldn't
  grow columns for: `{ issuer, last4, credit_limit, apr, statement_day, due_day,
  min_payment, source_aliases: [] }`. `source_aliases` is T25(a)'s mapping, stored on the
  card, so T34 can recognize an inbound payment and T33 can label it. Parse on read
  (`safeParse`, already in `server.js`), stringify on write — mirror `parsePlanTarget`.
- **`transactions.transfer_id TEXT`** — pairs the checking `withdrawal` with the card
  `deposit`. `NULL` for ordinary rows. Index it.
- **`transactions.external_id TEXT`** — the importer's stable per-row fingerprint
  (T29 defines it). Index it. This, not a timestamp, is what makes re-uploading an
  overlapping statement a no-op.
- **`transactions.import_batch TEXT`** — which upload produced the row, so one bad import
  is undoable as a unit. Carries the issuer + imported-at stamp.

Then the API:
- `POST`/`PATCH /api/accounts` accept `data` (and `type: 'credit_card'`); `GET /api/accounts`
  returns it parsed, plus `debt` alongside the existing `balance` for card-typed rows
  (from T27's helper — coordinate, don't duplicate the sign flip).
- `GET /api/accounts?type=credit_card` filter, so the Cards tab's dropdown is one call.
- `POST /api/transactions` accepts `transfer_id` / `external_id` / `import_batch`;
  `PATCH` accepts none of them — they are identity, not content.
- Add the cards from T25(a) with a seed script (`local/seed-cards.js`), `updated_at = epoch`
  per the seed convention so a real published row always wins.

**Why no schema_version bump:** every change is additive and nullable, `parseSnapshot`
already tolerates missing arrays, and `mergeInto` derives its column list from
`PRAGMA table_info`. An older machine that hasn't pulled the code yet merges a snapshot
containing `transfer_id` by **dropping the unknown column** — which is survivable (the
rows still exist, just unpaired) but worth stating out loud in the decision log.

**Done when:** `npm start` on a pre-Phase-13 `dashboard.db` migrates silently and the
Ledger still renders; the card accounts exist with their `data` populated; a round-trip
through `POST /api/publish` → `POST /api/refresh` preserves `data`, `transfer_id`,
`external_id` and `import_batch` on every row; `local/backup-db.js` still runs.

**Status.** All four migrations, the CRUD, and the seed script are in; verified against
the real `dashboard.db` rather than just read. One sub-bullet is deliberately not wired:
`GET /api/accounts`'s `debt` field waits on T27's `cardDebt()`, which doesn't exist yet —
adding it now would mean re-deriving the sign flip here and then duplicating it in T27,
which is exactly what the task warns against. `balance`/`data` ship now; `debt` is T27's
first consumer to add.

- **Migrations** (`local/db.js`): `accounts.data` (JSON, default `'{}'`),
  `transactions.transfer_id` / `external_id` (both indexed) / `import_batch`. Verified
  `PRAGMA table_info` shows all four after a plain `import("./local/db.js")` against the
  live DB — no `npm start` needed to trigger them, `db.js` runs the migration on load.
- **API** (`local/server.js`): `safeParse` hoisted above the accounts routes (was
  plan-targets-local) so both sections share it; added `parseAccount`. `GET
  /api/accounts?type=credit_card`, `POST`/`PATCH /api/accounts` accept `data`, `POST
  /api/transactions` accepts the three identity fields, `PATCH` does not (confirmed by
  curl: a PATCH with `transfer_id` in the body left the stored value unchanged while
  `note` updated). Publish → refresh round-trip verified live: published with a test
  account `data` blob and a test transaction carrying all three identity fields, inspected
  `docs/data/snapshot.json` (both present, raw JSON string for `data` — same convention
  `plan_targets` used pre-parse), then refreshed and confirmed the merge preserved them.
  Test data and the version/dirty/`last_pulled_*` sync_meta bump were reverted afterward;
  `docs/data/snapshot.json` was `git checkout`'d back since the publish was local-only
  (`push:false`).
- **Seed** (`local/seed-cards.js`, idempotent by id, epoch-stamped): the six accounts from
  T25 findings/decisions #43–#44 — `woody-apple-card`, `woody-citi-card`,
  `woody-chase-card` (closed, owner `woody`), `rajna-capital-one`, `rajna-chase`,
  `rajna-discover` (owner `shared` per #44 — both people service them). `data.credit_limit`
  / `apr` come from `Card_Totals.csv` (apr stored as a fraction, matching
  `seed-plan-targets.js`'s convention); `woody-chase-card`'s limit/apr are `null` (absent
  from `Card_Totals.csv`, closed with no stated numbers — not guessed as 0).
  `data.source_aliases` is T25(a)'s resolved map: `woody-apple-card` gets `["Apple Card",
  "Vacation Apple Card"]` (the latter folded in as a statement credit, not a second card,
  per the T25 findings); `rajna-discover` gets all three Discover source strings
  (`"Discover"`, `"Rajna Discover"`, `"Woody Discover"`) per decision #43's one-card
  resolution. `last4` / `statement_day` / `due_day` / `min_payment` are `null` — still
  unknown per T25's residual note, not guessed. `opening_balance` is left at 0 for every
  card: decision says T26b derives it from the statements, so getting it "right" here
  would just be overwritten.
- **Decision #44's re-categorization, executed as part of this task** (it names T26
  explicitly for the diff-verified move): the 39 rows `#42` had moved to `Partner Transfer`
  that `#44` puts back — `Rajna Discover` (26), `Rajna Chase` (12), `Rajna Capital One` (1),
  all on Woody's checking ledger — were moved back to `Credit Card Payment`, `updated_at`
  stamped to now so the change wins LWW (mirroring #42's own method). Backed up first
  (`npm run backup`), diffed `npm run check:csp -- --db` before/after across all four window
  shapes and both owners: **zero dollar figures moved** (every `target`/`actual`/`delta`/
  `status` byte-identical); the only diff is a new `⚠ N overlapping` annotation on Woody's
  `Rajna Assistance Program` / `Debt Payments` rows, because these rows now match two items
  (source and category) and decision #7's source-beats-category precedence keeps them where
  they already were — exactly the "page impact is nil" #44 predicted. `ALL CHECKS PASSED`
  before and after.
- **Open for T27**: `GET /api/accounts`'s `debt` field (see "Status" above).

---

## T26b — Load the card ledgers directly from the statements · **Opus** — ✅ **loaded + reconciled (2026-10-08)**, one clause open

**This is a data task, not a feature task.** The ledgers get populated by a direct SQLite
load, written and run by hand against the supplied statements — *not* by routing them
through the app's uploader. The uploader (T29/T30) is a real feature that gets built and
tested on its own; it is simply not the mechanism for bootstrapping, and making the initial
data depend on it would be the tail wagging the dog.

**Why decoupling is the better plan, not just the easier one:**

- **The data stops blocking on the code.** It runs right after T26's migrations, so T27,
  T28, T31 and T32 are all built and verified against real card data from their first
  commit instead of against a seed fixture or an empty table.
- **It makes T29 genuinely testable.** Bootstrapping *with* an unverified parser means a
  discrepancy is ambiguous — parser bug, or bad input? Loading the data by hand first and
  reconciling it to the statements produces a **known-good answer**, so T29's verification
  becomes: run the uploader over an already-loaded month and diff. Expected result: zero
  fresh rows and identical categorization. That is a far stronger test than "it imported
  and the balance looked plausible".
- **Expedient parsing is fine here.** A throwaway per-issuer script (whatever is quickest)
  beats waiting on `shared/statement-import.js` to be correct for five formats. The
  conventions observed while doing it are then transcribed into T25(c)'s table, so T29's
  adapters are written from verified fact rather than inference.

What still has to be right, because it is arithmetic rather than plumbing:

- **Derive `opening_balance` per card** from the earliest statement — card ledgers start
  mid-history. Negative, per decision #22. Where only a closing balance is stated, work
  backwards through that period's rows, the way `import-csv.js` derives opening from the
  first row's running balance.
- **T25's audit changes three inputs here — read it first.** *(2026-10-08.)* **(1)** The
  openings are already derived and tabulated in "T25 findings"; Citi's is **$0.00** (its file
  is the card's complete history) and Capital One's **$337.90** is corroborated twice, so
  those two are not guesswork. **(2)** The per-period closing balances were **not in the
  export** — the user is collecting them (#45), so write the loader to consume a ladder and
  fall back to a single replay-to-current-balance check only for a card whose numbers never
  arrive. **(3)** **Chase is exempt** (#49): it is a dormant balance-only card with no
  purchases and no interest, so there are no periods to reconcile and its ledger is
  payments-only by nature. Load **six** accounts, not five, with Rajna's three
  `owner: 'shared'` (#43, #44). Also already settled for you here: `external_id` keys on the
  **transaction** date (#46), payments are filtered on the issuer's type column rather than
  the sign (#46), and the $5,862.14 of **balance transfers** are card-to-card pairs that are
  not payments (#47).
- **Reconcile every period, not just the last one.** After each statement's rows, the
  computed running balance must equal that statement's stated closing balance — a printed
  ladder of N checks per card. This survives the decoupling intact and is still the
  strongest verification in the phase: it proves the sign convention, the
  transaction-vs-post date choice, and that no rows were dropped. One passing month proves
  far less than six. Where a period genuinely misses (interest, fees, a row the export
  omits), splice a **visible** `Adjustment`/`Interest` row as `reconcile()` does — never
  absorb the gap into `opening_balance`.
- **Interest, fees and annual charges** are real card rows; confirm per issuer whether the
  export includes them rather than assuming, since an omitted finance charge is exactly
  what makes a period miss by a few dollars and invites a silent fudge.
- **Own the `external_id` fingerprint spec here**, pulled forward out of T29: a
  deterministic hash of `(account_id, txn_date, amount, normalized merchant,
  occurrence-index-within-that-key)`. The loaded rows must carry it, and T29 must then
  *adopt the same formula* — otherwise re-uploading a seeded month duplicates every row and
  the known-good diff test above is impossible. Pulling it forward is what keeps the two
  paths comparable.
- **Record `accounts.data.seeded_range`** — the exact `[first, last]` per card. This is
  what T34's guard keys on (see the 🚩 there): the statements own the card side of a
  payment inside that range, T34's mirror owns everything outside it.
- **Persist each statement's closing balance** into `accounts.data.statements` before the
  files are deleted. Without it T37 assertion #6 cannot exist afterward.
- **Idempotent, reversible, one card at a time.** Re-running inserts 0 rows; every row
  carries an `import_batch` so one bad card is undoable as a unit. Load one card, read its
  ladder, fix, move on — five cards at once with one wrong sign convention yields five
  wrong ledgers and no signal about which is at fault.
- **Then delete the statements** and confirm `git status` is clean.

**Done when:** every card has a real ledger; **every statement period reconciles to its
stated closing balance to the cent**, with the ladder recorded in this file as the proof;
re-running inserts 0 rows; `seeded_range`, `statements` and `external_id` are populated;
any spliced adjustment is visible and explained; the statements are deleted; and the
`external_id` formula is written down for T29 to adopt verbatim.

### T26b status — loaded 2026-10-08, **911 rows across five cards, every card reconciling to the cent**

**Done, with one clause deliberately left open:** the statements are **not deleted**. The
task gates deletion on *"once T26b's period-by-period reconciliation passes,"* and it has
not — the per-period closing balances (#45) still have not arrived, so two of the five
cards are **unverified in a way only the ladder can fix** (see #50). The files are already
outside the repo, which is what the no-leak guarantee actually rests on, so keeping them
costs nothing and deleting them now would throw away the only re-derivable source while
the data is still unanchored. One command away whenever the ladder passes:
`rm -rf ~/Downloads/CSVs`.

**What shipped**

- **`shared/card-import-spec.js`** — the import contract T29 must share *verbatim*, as a
  module rather than as prose, because prose re-implemented twice is how the two paths
  drift (#51). Holds `normalizeMerchant`, `externalIdKey`/`externalId`/`assignExternalIds`,
  `stripCitiCardSuffix` and `ISSUER_CATEGORY_MAP`/`mapIssuerCategory`. Pure, zero-dep,
  browser+Node.
- **`local/load-card-statements.js`** — the hand loader. Five adapters, dry-run by default,
  `--card` / `--commit` / `--at` / `--revert <batch>` / `--ladder <file>`. It already
  consumes a ladder (#45's "write it to consume one"): drop in
  `{ "<card-id>": [{ "closing_date": "...", "closing_balance": <debt, positive> }] }` and
  every period is checked alongside the aggregate. Until then it says, on every card,
  that it is running the aggregate check only.
- **Two corrections to T26's seed**, both in `local/seed-cards.js`:
  - `woody-apple-card` had survived T26 with **`data = '{}'`** — a casualty of that task's
    publish round-trip verification — which silently cost it `credit_limit`, `apr` and
    `source_aliases`. Since insert-only idempotency cannot heal that, the seed now
    **backfills missing keys** always, and **re-syncs** every seeded key on a row still
    stamped at the epoch (i.e. never written by the app or a merge).
  - `rajna-discover`'s `source_aliases` dropped from three strings to two — see **#54**.

**The reconciliation ladder, as the proof the task asks be recorded here.** Every figure
below is reproduced by `node local/load-card-statements.js` (dry run, no writes), and the
debt column is then re-derived a *second* and independent way — through production
`accountBalance()` over the rows as they now sit in `dashboard.db`, not through the
loader's own arithmetic.

| card | rows | span | charges | credits | net | derived `opening_balance` | replay | stated | Δ |
|---|---|---|---|---|---|---|---|---|---|
| `woody-apple-card` | 567 | 2026-03-02 → 10-07 | $26,648.51 | −$24,145.21 | $2,503.30 | **−$7,918.08** | $10,421.38 | $10,421.38 | **$0.00** |
| `woody-citi-card` | 26 | 2026-04-28 → 09-18 | $7,019.53 | −$269.00 | $6,750.53 | **$0.00** | $6,750.53 | $6,750.53 | **$0.00** |
| `rajna-capital-one` | 174 | 2026-03-03 → 10-06 | $4,370.63 | −$4,535.48 | −$164.85 | **−$337.90** | $173.05 | $173.05 | **$0.00** |
| `rajna-discover` | 138 | 2026-03-04 → 10-05 | $4,746.40 | −$6,827.82 | −$2,081.42 | **−$19,216.23** | $17,134.81 | $17,134.81 | **$0.00** |
| `rajna-chase` | 6 | 2026-05-14 → 10-27 | $0.00 | −$290.00 | −$290.00 | **−$2,125.15** | $1,835.15 | $1,835.15 | **$0.00** |
| `woody-chase-card` | **0** | — | — | — | — | $0.00 | — | $0.00 | — |

**Household debt from the ledger: $36,314.92** — equal to the T25 audit's figure to the
cent, and now derived from 911 real rows rather than from `Card_Totals.csv`'s five
summary lines.

**Every T25-derived opening is independently reproduced**, which is the one thing that
cross-validates the audit: five numbers computed twice, months apart, by two different
scripts, agreeing exactly.

**Read the Δ column with #50 in hand, though.** For `woody-apple-card` and
`rajna-discover` that $0.00 is an **identity, not a test** — the opening is *defined* as
`stated − net`, so replaying it forward lands on `stated` necessarily. The loader now says
so out loud on each card rather than printing a ✅ that means less than it looks.

**Derived month-end debt, persisted to `accounts.data.statements.derived_month_end`.** Not
a check — it is the thing a future check will check — but it is what keeps the ladder
**constructible after the CSVs are gone**: compare it to the issuers' statement pages
whenever those numbers arrive. Labelled `derived_*` in the JSON precisely so nobody later
mistakes it for something an issuer stated.

```
apple        03 7433.87  04 7932.71  05 5755.33  06 6577.92  07 8003.37  08 9597.77  09 10274.12  10 10421.38
citi         04  548.38  05 6687.90             07 6620.90  08 6554.90  09  6750.53
capital one  03  318.84  04    0.00  05   13.84  06  451.47  07  390.52  08  438.58  09   489.78  10   173.05
discover     03 16969.09 04 16919.84 05 15852.13 06 16719.63 07 17054.64 08 16789.25 09 16858.58  10 17134.81
chase        05 2035.15  06 1995.15  07 1955.15  08 1915.15  09 1875.15  10  1835.15
```

**The falsifiable checks — the ones that could have failed and did not.**

1. **Sign-convention guard, all five cards.** A card cannot open with money on it, so a
   negative derived opening debt means the issuer's amount convention is inverted. This is
   the check that *actually* catches Citi: reading its split columns as `Debit − Credit`
   (Capital One's convention) yields an opening of −$538.00. Reading it as `Debit + Credit`
   yields $0.00. The automatic test for the phase's most-advertised trap turns out to be
   one inequality, and it now runs on every card on every load.
2. **Three independent opening anchors, all exact.** Citi **$0.00** (its export is the
   card's complete history from account opening — this is a genuine falsifying test, and
   it is what validates the Citi convention); Capital One **$337.90** (its own first row
   is a $337.90 payment that zeroes the card, and the checking ledger's 2026-03-03
   withdrawal is also $337.90); Chase **$2,125.15** (forced by #49).
3. **`external_id` uniqueness** — 911 of 911 unique within their card, no collision across
   cards, and no collision against anything already in `transactions`. The 32-hex FNV-1a
   composite is collision-free on the real corpus rather than assumed to be.
4. **The Apple→Citi balance transfer pairs to the cent** across two card ledgers:
   $4,000.00 off Apple (2026-05-12, `Type=Payment`, merchant `Bill Payment`) = $4,000.00
   onto Citi (`BAL XFR. APPLE CARD-GOLDMAN SACHS BANK`), joined by
   `transfer_id = bt-2026-05-12-apple-citi`. The Chase→Citi $1,862.14 leg is **one-legged
   by design** — `woody-chase-card` has no export, so no opening anchor and no ledger to
   put the other half on; inventing one would mean inventing its opening too.
5. **Idempotency** — a full re-run with `--commit` inserts **0** and skips 911.
6. **`npm run backup` runs; `git status` has no statement file anywhere**; the server
   serves the card accounts with parsed `data`, and `GET /api/transactions?account_id=
   woody-citi-card` returns a correct `running_balance` (−148.39 after the first purchase
   from a $0.00 opening).

**Card-side payments vs. the checking ledger — reported, not enforced (#48).** A genuinely
independent oracle: the checking rows came off the user's own sheet months ago and share
nothing with these CSVs, so agreement tests the payment classification *and* the
transaction-date choice.

| card | card-side payments | checking (in window, via `source_aliases`) | gap | reading |
|---|---|---|---|---|
| Citi | $269.00 | $269.00 (4 rows) | **$0.00** | exact, 4/4 — the cleanest confirmation in the set |
| Apple | $19,316.95 | $16,882.13 (21 rows) | +$2,434.82 | **fully explained**: ~$2,263 of payments came from bank accounts ending **4643** and **2424** — not Woody's checking at all — plus Apple Cash payments (#48). The $4,000 balance transfer is already excluded, being classified `balance_transfer` rather than `payment`. |
| Capital One | $4,233.95 | $3,531.90 (10 rows) | +$702.05 | 19 card-side payments against 10 checking rows: Rajna pays her own card directly for the small ones. Unpairable card-side payments, valid per #48. |
| Discover | $6,671.92 | $5,487.10 (20 rows) | +$1,184.82 | same shape — both people pay this card, some of it outside the ledger. |
| Chase | $290.00 | $310.00 (6 rows) | **−$20.00** | the one gap in the *other* direction, and the interesting one — see below. |

**Chase's −$20 is a projection artifact, and it is worth T34 knowing about now.** The
checking side carries a **future-dated forecast** row (2026-10-15, $60.00) while the card
side carries the issuer's **actual scheduled autopay** (2026-10-27, $40.00 `Pending`). Both
are legitimate; they simply disagree because one is Woody's plan and the other is Chase's
schedule. The dates disagree too — checking says 5/14, 6/25, 7/23, 8/20, 9/17, 10/15 and
the card says 5/14, 6/26, 7/23, 8/27, 9/27, 10/27, so **only two of six align on date**.
T25's "5/5 exact matches" was a match on *amounts*; it never claimed dates. **T34 cannot
pair on `(date, amount)`** — it needs an amount match within a window, and it must tolerate
a forecast row that the issuer later contradicts.

**What the issuers' own numbers did NOT require: a single spliced adjustment.** The task
anticipated needing visible `Adjustment`/`Interest` rows where a period missed. None were
needed — every issuer that exports transactions includes its finance charges, exactly as
T25 found, so there was no gap to absorb and no temptation to absorb one. The one
`Adjustment` row in the load is a **real issuer row**, not a splice: Apple's
`2026-06-03 +$850.00 (reversal - Insufficient Funds)`, which reverses a 2026-05-29 −$850.00
payment that bounced. It takes `Adjustment` rather than `Misc` deliberately — it is a
bookkeeping correction, not $850 of purchases, and `CSP_EXCLUDE` already handles the
category. It is the one judgment call in the load, and it is visible on the ledger with
its note intact.

**First-pass categorization (#53), and what the row carries.** `description` is the ledger
category from `ISSUER_CATEGORY_MAP`; `source` is the merchant; `note` is
`issuer · raw category` on **every** loaded row, so nothing an issuer said is destroyed
before T30's bulk pass can mine it. Distribution across the 911 rows:

```
Food 290 · Misc 247 · Transportation 133 · Credit Card Payment 81 · Groceries 67
Fun 47 · Interest 24 · Bill 18 · Transfer 3 · Adjustment 1
```

**`Misc` at 247 rows (27%) is the measurement that settles T30's weighting.** It is not an
artifact of a lazy map — it is Citi having no category column at all and Apple filing 60%
of a month under `Other`. T30's merchant rules are the only thing that can move it.

**🚩 The consequence T28 was written for is now live and measured.** `check:csp --db`
still **passes** — the reconciliation identity `Σ buckets + excluded == outflow` holds in
every window, every row counted exactly once — but Woody's figures moved substantially,
because `computeCsp` scopes a plan to `accounts.filter(a => a.owner === pt.owner)` and his
two cards are `owner: 'woody'`:

| Woody, trailing window | before | after |
|---|---|---|
| windowed outflow | $52,293.75 | **$85,914.35** |
| Fixed Costs actual | $3,368.39 | **$4,321.22** (91.5% → 89.6% of take-home) |
| ↳ `Miscellaneous (15% buffer)` | $15.18 | **$962.72** |
| Guilt-Free `Unassigned` | $416.62 (43 rows) | **$2,196.54** (424 rows, 153 groups) |
| `Debt Payments` | $2,376.64 | $2,376.64 — **unmoved** |

Three things to take from that table:

- **`Debt Payments` is unmoved in three of four windows**, which is the number that
  mattered: card-side payments are `deposit`s and CSP actuals are outflow-only, so they
  cannot leak in. It moves **$1.14** in the all-time window only — $1,260.68 → $1,259.54 —
  and the cause is worth knowing because it is invisible: Apple's earliest row is
  **2026-03-02**, one day before Woody's earliest checking row, so the open-ended window
  grew by a day and **rescaled every monthly average in it**. Nothing was miscounted; the
  denominator changed. Any future "why did a verified monthly average drift by pennies"
  starts here.
- **Rajna's CSP is byte-identical**, all four windows. Her three cards are
  `owner: 'shared'` and `computeCsp` matches on `a.owner === pt.owner`, so shared-card rows
  reach **neither** person's plan. That is a gap T28 has to close deliberately, not a
  safety property to rely on.
- **`Miscellaneous (15% buffer)` absorbing $962.72/mo of card purchases sharpens the open
  "which card categories need their own CSP items" question considerably.** A buffer line
  is not where 27% of the card ledger belongs.

**🚩 And the one T27 flagged as the phase's highest risk is also live.** `summary()` and
`monthlySpend()` take *any* transaction list, and `shared/dashboard-render.js:112` builds
`myTxns` as **every account the person can see** — `owner === currentUser || owner ===
'shared'`, with no `type` filter. So the Dashboard now double counts: the card purchase
*and* the checking payment. Measured, YTD to 2026-10-08:

| | checking only (correct) | as the Dashboard now computes it | inflation |
|---|---|---|---|
| Woody outflow | $52,493.75 | $95,278.82 | **+$42,785.07 (+81%)** |
| Woody income | $52,804.15 | $88,831.66 | +$36,027.51 |
| Rajna outflow | $35,240.84 | $44,357.87 | **+$9,117.03 (+26%)** |
| Rajna income | $31,996.71 | $43,610.01 | +$11,613.30 |
| Woody `monthlySpend` 2026-10 | $350.89 | $1,583.42 | **4.5×** |

Note the asymmetry T27 should not miss: **Rajna's Dashboard is affected even though her
CSP is not.** The CSP matches owner by equality (`=== pt.owner`) and the Dashboard matches
by `owner-or-shared`, so `owner: 'shared'` cards are invisible to one and visible to the
other. The balance tile is safe — `checkingToday` already filters `a.type === 'checking'` —
but the YTD tiles and the spending chart are not. **Nothing in `metrics.js` needs to
change; the two call sites in `shared/dashboard-render.js` and its `docs/` twin need an
explicit scope.**

**Open after this task**

- 🚩 **The per-period closing balances** — still the phase's weakest verification link, and
  now the only thing standing between `woody-apple-card` / `rajna-discover` and a real
  check (#50). The loader consumes them the moment they exist: `--ladder <file>`.
  **The statements stay staged at `~/Downloads/CSVs/` until then.**
- `statement_day` / `due_day` / `min_payment` remain unknown per card (T25's residual).
  New data point: **`last4` is now partly recoverable from the exports** — Citi's
  descriptions carried `3676` / `0164` / `8038` and Capital One's `Card No.` column
  `4993` / `9937`, recorded as `data.last4_seen`. Neither card has a single `last4`,
  which is why `data.last4` stays `null` rather than being set to an arbitrary one of them.


---

## T27 — `shared/cards.js`: debt, statement cycles, per-card rollups · **Opus** — ✅ **done (2026-10-08)**

The pure compute layer, dependency-free and browser+Node safe, standing to the Cards tab
as `shared/csp.js` stands to the Spending Plan. No DOM, no fetch.

- `cardDebt(transactions, account)` → `-accountBalance(...)`, clamped so a credit balance
  (you overpaid) reports as **negative debt** rather than being hidden at 0, because
  silently flooring it would make the household total wrong.
- `totalDebt(transactions, accounts)` → the Credit subtab's headline figure, over the
  owner-scoped card set. Returns the per-card contributions too, so the stat row can break
  the total down without a second pass.
- `cardSummary({ transactions, account, window })` → the *This Paycheck*-shaped rollup for
  one card over one window: `openingOwed`, `closingOwed`, `charges`, `refunds`,
  `netPurchases` (= charges − refunds), `payments`, and `debtChange`
  (= `netPurchases − payments`, the number that makes "spend ≠ payment" legible).
  `byCategory[]` in the `groupRows` shape from `shared/csp.js`
  (`{label, amount, count, share}`) — **net of refunds per category**, so it feeds the
  donut directly; a category whose refunds exceed its charges returns a negative `amount`
  and the UI clamps the slice (T31). **No `byMerchant[]`** — decision #39 cut the merchant
  rollup. Plus a `toDate`/`projected` split on `asOf`, since card ledgers carry
  future-dated projected rows exactly like checking does (the ledger already runs to
  2027-11).
- `statementCycle(account, refDate)` → `{ start, end, dueDate }` from
  `data.statement_day` / `data.due_day`. **Never wired into a timeframe picker** — per
  decision #37 the Credit subtab shares This Paycheck's pay window and mounts no window
  control at all — but needed for the "current statement balance" figure and T37's
  reconciliation check.
- `minimumDue(account, cycleRows)` → `data.min_payment` or a percent-of-balance fallback;
  used by T35's drift row.

**Watch for:** `summary()` and `monthlySpend()` in `shared/metrics.js` take *any*
transaction list and filter by `description`. Card purchase rows have ordinary categories
(`Food`, `Bill`, `Groceries`), so the moment a card account exists, **anything that passes
the whole ledger to those functions double counts** — the card purchases *and* the
checking payment. Audit every caller (`server.js`, `dashboard.js`,
`shared/dashboard-render.js`, `docs/mock-api.js`) and make the account scope explicit at
each one rather than leaving it implicit. This is the single highest-risk line in the
phase; it changes no code in `metrics.js` and still breaks the Dashboard if missed.

**Done when:** every function has a Node-side assertion against the real DB; the identity
`sum(cardDebt) === totalDebt` holds; `netPurchases − payments === debtChange` and
`openingOwed + debtChange === closingOwed` hold to the cent for every card over at least
three pay windows and three `MONTH_PRESETS` windows (the CSP still reads monthly); and a
written list of every `summary`/`monthlySpend` call site with its resolved scope.

### T27 status — done 2026-10-08, **2,162 assertions over 6 cards, all passing**

`npm run check:cards` is the proof, and it is kept in the repo for the same reason
`check-csp.js` is: it is the reference the Credit subtab's on-screen numbers get checked
against, so if the page and this disagree, the page is wrong.

**What shipped**

- **`shared/cards.js`** — the pure compute layer. 21 exports in four groups:
  - *scope* — `isCardAccount`, `cardAccounts(accounts, {owner})` (decision #24's
    own-or-shared filter, in one place so the T31 dropdown, the T32 headline and the T35
    tile cannot disagree about whose cards those are), `cardAccountIds`, and the
    `cashRows` / `cardRows` splitters the audit below is built on.
  - *debt* — `cardDebt` (decision #22's one sign flip in the compute layer),
    `cardDebtAsOf`, `cardDebtBefore`, `totalDebt`.
  - *rollup* — `cardSummary`, `classifyCardRow`, `cardMeta`.
  - *statements* — `statementCycle`, `statementBalance`, `minimumDue`,
    `minimumDueEstimated`.
- **`local/check-cards.js`** + `npm run check:cards`. Every component is re-derived from
  SQL rather than from the module's own classification, so a category landing in the wrong
  bucket shows up as a mismatch instead of agreeing with itself. Eight sections: the debt
  primitives, `totalDebt`'s owner scopes, the per-card × per-window identities,
  `classifyCardRow` over every real card row, `statementCycle`, `minimumDue`,
  `statementBalance`, and the scope split. **T37 extends this file** with the assertions
  that need code which did not exist when it was written (transfer pairing, importer
  idempotency, T28's CSP identity, T32b's payoff schedule, and #45's statement ladder).
- **The call-site audit, and the fix** — `shared/dashboard-render.js` now reads
  `myCashTxns` for both `summary()` and `monthlySpend()`. See the table below.
- **T26's one deferred sub-bullet, closed.** `GET /api/accounts` now returns `debt` on
  card-typed rows, from `cardDebtAsOf` — exactly the "coordinate, don't duplicate the sign
  flip" T26 left open. It also returns `projected_debt`; see the `asOf` note below for why
  there have to be two.

#### The identity has four terms, not two — and that is the honest version

T32 is specified to print `netPurchases − payments === debtChange` on screen, and that
holds in the overwhelming majority of windows. It does **not** hold in a window containing
a balance transfer (decision #47) or an issuer bookkeeping reversal, and both are real in
this data: Apple moved $4,000 to Citi on 2026-05-12, and Apple's $850 payment that bounced
on 2026-05-29 was reversed on 2026-06-03 — *in the next window*, so neither month nets to
zero on its own. Folding either into `payments` would claim cash was paid that never left
checking; folding either into `refunds` would make `netPurchases` deeply negative. So
`cardSummary` guarantees, to the cent, always:

```
debtChange === netPurchases − payments + transfers + adjustments
openingOwed + debtChange === closingOwed
```

with `transfers` and `adjustments` signed toward debt and **exactly 0** in an ordinary
window — at which point it collapses to the two-term form the UI prints. It is the same
move `csp.js` makes with its `excluded` line: a dollar the headline doesn't want is still
shown somewhere rather than absorbed into a line that doesn't fit it. `check-cards.js`
asserts the two-term form separately on every window where both extra terms are zero, and
says out loud which windows those were not.

#### `asOf` defaults to today, and T34 is why that stopped being cosmetic

`totalDebt` defaults `asOf` to today rather than replaying the whole ledger. That was a
judgment call when written and is now forced: **T34's paired-transfer backfill landed
during this task** and put the card half of every planned checking payment on the ledger
out to 2027-07 (62 rows, `import_batch = t34-backfill-…`). The end-of-ledger figure is now
a *projection* — household card debt **$6,151.92** after the whole plan runs — and the
figure a person means by "what do I owe" is **$36,354.92**. Both are returned (`total` and
`projected`); the API field is `debt` / `projected_debt` for the same reason. Any surface
that shows the wrong one will be off by $30,203.00, so this is worth knowing before T35
builds the tile.

**The per-card figures match T26b's reconciliation to the cent**, with one documented
exception:

| card | T26b | `debt` as of 2026-10-08 | note |
|---|---|---|---|
| `woody-apple-card` | $10,421.38 | $10,421.38 | |
| `woody-citi-card` | $6,750.53 | $6,750.53 | |
| `rajna-discover` | $17,134.81 | $17,134.81 | |
| `rajna-capital-one` | $173.05 | $173.05 | |
| `rajna-chase` | $1,835.15 | **$1,875.15** | T26b's replay counted the issuer's **2026-10-27** scheduled autopay; today it is not paid yet. The $40.00 is the gap, and it is the same row behind T26b's "−$20 is a projection artifact" note. |
| `woody-chase-card` | $0.00 | $0.00 | no export, no ledger |
| **household** | **$36,314.92** | **$36,354.92** | |

Two things the real data now exercises that no synthetic fixture would have:
`rajna-capital-one`'s projected debt is **−$2,566.95** — a credit balance, so decision
#22's "negative debt rather than clamped to 0" is live rather than theoretical — and five
of six cards run above 67% utilization, two at 99.3%.

#### Every `summary` / `monthlySpend` call site, with its resolved scope

The done-when deliverable. This was the phase's single highest-risk line and it changes no
code in `metrics.js`.

| call site | function | scope before | scope now |
|---|---|---|---|
| `shared/dashboard-render.js:145` | `summary` | `myTxns` — **every account the person can see**, cards included | **`myCashTxns`** = `cashRows(myTxns, myAccounts)` |
| `shared/dashboard-render.js:177` | `monthlySpend` | `myTxns` — same | **`myCashTxns`** |
| `docs/shared/dashboard-render.js` | both | same | **regenerated from `shared/` on publish** (`/api/publish` copies `shared/*.js`), so it is fixed by the same edit. `docs/` is behind on several Phase 12b/13 modules already — T36 owns the republish. |
| `local/server.js:111` | `accountLedger` | one named account | unchanged — already explicit, one account per call |
| `local/server.js:156` | `accountLedger` | `?account_id=` | unchanged — already explicit |
| `docs/mock-api.js:49,63` | `accountLedger` | one account per call | unchanged — already explicit |
| `local/import-csv.js:206`, `local/import-rajna.js:225` | `accountBalance` | the account being imported | unchanged — already explicit |
| `local/public/paycheck.js:97` | *(own aggregation)* | `?account_id=` for one checking account | unchanged — already explicit |
| `local/public/app.js` | *(own aggregation)* | per-account Ledger | unchanged — already explicit |

**What the bug was costing, measured at 2026-10-08** (the `cashRows` / whole-ledger pair
`check-cards.js` section H prints on every run):

| | cash only (now) | whole ledger (was) | |
|---|---|---|---|
| Woody income YTD | $52,804.15 | $88,831.66 | +$36,027.51 of card-side **payments read as income** |
| Woody outflow YTD | $52,493.75 | $95,278.82 | +81% — the purchase *and* the payment |
| Rajna income YTD | $31,996.71 | $43,610.01 | +$11,613.30 |
| Rajna outflow YTD | $35,240.84 | $44,357.87 | +26% |
| Rajna `monthlySpend` 2026-10 | $2,323.25 | $2,758.52 | |
| Woody `monthlySpend` 2026-10 | $350.89 | $1,583.42 | 4.5× |

Note the asymmetry T26b flagged: **Rajna's Dashboard was affected even though her CSP was
not**, because `computeCsp` matches owner by equality and this filter matches
owner-or-shared, so her three `owner: 'shared'` cards were invisible to one and visible to
the other.

**Verified in the browser, not just in Node.** Headless Chrome against
`http://localhost:3000/dashboard.html`: tiles read Income $84,801 / Spending $26,889 /
Debt paid $50,171 at household scope, the spend chart draws 12 cash-only months ending
2026-10 at **$2,674.14** — which is Woody's $350.89 + Rajna's $2,323.25 to the cent — and
the console is clean.

#### Two API shapes worth knowing before T31/T32 code against them

- **`statementCycle()` returns `null` on all six cards right now**, because
  `data.statement_day` is still unknown per T25's residual and inventing a close date would
  put a confident wrong number on the page. The function is fully built and asserted
  against nine synthetic day-combinations — due-day-before-close wrapping to the next
  month, a 31st clamping into February at *both* ends, a year boundary, and twelve
  consecutive periods tiling the calendar with no gap or overlap — so it starts working the
  day the user enters the day. **T31/T32 must render "unknown", not a fallback cycle.**
- **`minimumDue()` is on its fallback path for every card**, since no card states a
  `min_payment` either. The fallback is `max(2% of balance, $25)`, never more than the
  balance owed, 0 on a paid-off or credit-balance card — exported as `MIN_PAYMENT_PCT` /
  `MIN_PAYMENT_FLOOR` so it is a declared assumption rather than a buried literal. Pair it
  with **`minimumDueEstimated()`** before putting it on screen; T35's drift row should say
  the figure is an estimate.

#### For T28, a one-line cleanup rather than a conflict

`cards.js` re-declares the two reconciliation-artifact categories (`Adjustment`,
`Negative Balance`) instead of importing `CSP_EXCLUDE`, deliberately: T28 has `csp.js`
reading `cards.js`, and a cycle entered from `csp.js` would reach that line while the
binding is still in its temporal dead zone. The dependency direction that works is
**`csp.js` → `cards.js`, never back**. `check-cards.js` asserts the two sets still agree,
so the duplication cannot drift silently — but if T28 ends up wanting one definition,
moving it *into* `cards.js` and importing it from `csp.js` is the direction that compiles.
`csp.js` also grew its own local `isCardAccount` while this task was in flight; it is the
same predicate `cards.js` exports and swapping it for an import is safe.

#### Not in scope, deliberately

- **The Dashboard's spend chart still excludes card purchases.** What a card *bought* is
  real spending, and adding it — as its own series, rather than silently into a total built
  from the checking payment — is **T35's** call, which already owns "re-audit the
  monthly-spend chart" and "state the chart's scope on the chart". Cash-only is the scope
  that restores exactly the figures T0 verified, which is the right place to leave it.
- **No `byMerchant[]`** (decision #39). `byCategory` is the only grouping, net of refunds
  per category, with `charges`/`refunds` riding along so the UI can show the gross pair
  behind a surprising net. A category whose refunds beat its charges returns a **negative**
  `amount` rather than being dropped — T31 clamps the slice, which is a drawing problem,
  not a reason to lose the number.
- **No monthly divisor.** A card rollup is a movement over one window, not a monthly
  average, so unlike `computeCsp` there is no `months` to get wrong — which is also why the
  windows `check-cards.js` runs are three consecutive **pay** periods per owner (#37)
  alongside three `MONTH_PRESETS` ones, rather than month presets alone.

---

## T28 — CSP integration: card purchases by category, payments in full · **Opus** — ✅ **done (2026-10-08)**

> **Status.** Shipped and reconciling. `npm run check:csp` and `npm run check:csp -- --db`
> both pass under the new identity, and the three data decisions the task left open were
> taken by the user — written up in *"T28 findings"* below, which also records the one
> consequence of those choices that is worth re-reading before the next pass.

The reason the phase exists, and the only task that can make existing, verified numbers
wrong. Implements **decision #21 as rewritten 2026-10-07** — *not* the paydown split the
first draft of this task described. Read #21 and #38 before starting.

Today `computeCsp` scopes a plan to `accounts.filter(a => a.owner === pt.owner)` — so the
instant T26 adds a card owned by `woody`, **card purchases silently flow into Woody's CSP
alongside his `Credit Card Payment` rows with no stated basis for either.** Inaction is not
the safe option here; the scoping has to become deliberate.

- Partition the plan's accounts into `cash` (checking/savings) and `card`. Then, per
  decision #21: **card purchases enter the buckets at their own category** (net of refunds
  in that category), and **the full checking-side payment stays in `Debt Payments`**.
  Nothing is excluded for being a transfer. There is no `paydown` figure in `shared/csp.js`
  at all — real paydown is computed in `shared/cards.js` and shown on the Credit subtab,
  which is what it is for.
- The `reconciles` invariant **changes shape and must stay exact**: it becomes
  `bucketTotal + excluded === cashOutflow + cardPurchases`. Assert it, keep it on the
  returned object, and keep the UI warning. `excluded` keeps its existing meaning
  (`Adjustment` / `Negative Balance` reconciliation noise) and does **not** grow a
  card-transfer category — one footer line, not two.
- **The denominator changes meaning, and the UI has to say so.** Counting purchases *and*
  payments means one economic dollar can appear twice (groceries charged, then the card
  paid). That is deliberate per #21, but bucket percentages stop being a share of take-home
  and become a share of *commitments*, and **can exceed 100%** in a heavy-charge month.
  Return `cardPurchases` on the result so the UI can relabel the column **"% of
  commitments"** when it is non-zero. One honest word, not a second actual column — the
  double-signal Phase 11 spent four tasks removing.
- **Per-item direction + thresholds (decision #38).** `BUCKET_DIRECTION` is keyed by
  *bucket*, and `fixed` is `"spend"`, so under-spending a Fixed Cost colors the Δ green.
  `Debt Payments` lands in `fixed` while being the one item there whose direction is
  **`fund`** — paying *less* debt is bad. Needed:
  - optional **`data.direction`** on an item, overriding the bucket's, defaulting to the
    bucket's when absent; `statusFor` called with the item's resolved direction rather than
    `direction(it.bucket)`;
  - optional **`data.good_at` / `data.warn_at`** thresholds, defaulting to the shared
    `FUND_GOOD = 0.95` / `FUND_WARN = 0.75` (or the `spend` pair). `Debt Payments` ships
    with `1.0` / `0.8` — stricter than the shared band at both ends, which is why a
    direction flip alone is not enough;
  - a fourth status **`even`** from `statusFor` for `actual === target`, rendering gray.
    It will almost never fire on a 3-month monthly average; it exists because the rule says
    so, and the tolerance question is called out in "Open" below;
  - a bucket whose items override direction rolls up on **`worstStatus()`** of its items
    rather than its own ratio — already exported from `shared/csp.js`. Without this, Fixed
    Costs reads green at 96.9% of target while its most consequential item reads yellow.
- **A window with no imported card data under-reports rather than mis-attributes**, which
  is correct but invisible. Return per-window card **coverage** (which months of the window
  each in-scope card actually has rows for) so T32 can say *"card data covers 2 of these 6
  months"* instead of quietly showing a 70% underspend on Groceries.
- Woody's `Debt Payments` item ($2,000/mo, fixed, `categories: ["Credit Card Payment",
  "Loan Payment"]`) and Rajna's ($500/mo) **keep their original meaning** under the
  rewritten #21 — full payments out of checking — so **neither target needs restating**,
  which is the main thing the rewrite buys. What does need deciding: whether new per-category
  items are needed for the card spend that lands in the catch-all on its first run
  (Groceries exists; Food / Transportation / Misc may not).
- `local/check-csp.js` must be extended in lockstep, not after: it is the only thing that
  will catch a regression in numbers T0 verified to the cent. Add `statusFor` cases for the
  `fund`-override thresholds and the `even` status alongside the existing table at
  `check-csp.js:164`.

**Done when:** `npm run check:csp -- --db` passes with the new identity; both plans'
pre-card bucket totals are reproduced exactly for a window with **no** card data (proving
the refactor is a no-op where it should be); a window **with** card data reconciles to the
cent under the new identity; `Debt Payments` renders yellow at 89.7% of target and red
below 80% and green above 100%, verified on screen in every variant then existing; the Fixed Costs header
follows `worstStatus()`; and the drill-down on a card-fed item shows the card rows, not the
payment row.

### T28 findings — what shipped, and what it did to the numbers (2026-10-08)

**The partition.** `buildPlan` now splits the plan's accounts into cash and card
(`type === 'credit_card'`) and counts three things instead of one: every withdrawal on
either side at its own category; **card refunds as negatives**, so a category nets; and
**card payment inflows nowhere**, because the checking side already counted that dollar in
full. Cash deposits stay invisible, exactly as before — which is the clause that makes a
card-free window a bit-for-bit no-op.

Telling a payment from a refund on the card side needed a rule, since both are `deposit`
rows (#22). It is, in order: a `transfer_id` whose counterpart sits on a **cash** account
(#23's pairing, which T34 now writes — 236 of 298 `Credit Card Payment` rows are paired),
else the category (`Credit Card Payment` / `Loan Payment`), which is what carries the
remaining 62 that T34 left as #48's legitimately-unpaired card-side deposits. **Both tests
are load-bearing**: the engine was built and re-verified across T34's backfill without a
change, because neither test alone covers the data.
**A card→card balance transfer falls through both tests on purpose** and reads as a refund
on the receiving card, so the $4,000 Apple→Citi transfer nets to zero instead of reading as
$4,000 of spending. Moving debt around is not buying anything.

**The identity holds, and is now checked in both halves.** `bucketTotal + excluded ===
cashOutflow + cardPurchases`, asserted on every call and reported on screen. Woody,
trailing 12 months: `$52,257.75` cash + `$28,792.34` card (`$33,620.60` charged −
`$4,828.26` refunded) = `$81,050.09`, matched by buckets + `$107.46` excluded to the cent.
`$19,585.95` of card payment inflows were counted **nowhere**, which is the figure that
would have doubled `Debt Payments` had the partition been left implicit. `windowOutflow` is
kept as the sum of the two halves, so every existing caller reads the number it always did.

**The no-op proof is the clause that matters most, and it is now mechanical.**
`check-csp.js` re-runs every window with the card accounts dropped from scope and asserts,
for **every tracked item** (not a sample), that `cash-only total === full total − that
item's card rows`. There is no window in this database with cash data but no card data for
Woody — his checking and his cards both start 2026-03 — so "pick a pre-card window" was not
available, and this subtraction is the honest substitute. Zero items drift.

**Per-item direction and thresholds (#38).** `data.direction` overrides the bucket's,
`data.good_at` / `data.warn_at` override the shared band, and `statusFor` grew a fourth
`even` status. Both `Debt Payments` items ship `fund` at `1.0 / 0.8`. Verified on screen in
**all 12 theme variants**: Rajna's at `$444.46 / $500.00` = 88.9% renders **yellow** with
`direction: fund` on the row, beside `Parents` at −$266.67 rendering **green** — same
bucket, opposite colors, which is the whole point of the decision. A staged target of $600
(74.1%) renders **red**, over target **green**, exactly on target **gray**.

**`even` is universal, not special-cased to the overriding item.** The mockup's own screen 5
renders an exactly-on-target Rent row gray, so scoping it to one item would have been
inconsistent. A zero target is still tested first and never reads `even` — an item nobody
has budgeted is not one that landed on the nose. Consequence: `Insurance` ($198.50) and
`Braces` ($152.39) now read gray instead of green, and `check-csp.js`'s
`fixed on target 100% → good` case became `→ even`.

**The knock-on is louder than #38 anticipated, and it is not wrong.** Once an item overrides
direction, the bucket reports `worstStatus()` of its items. Woody's Fixed Costs went green →
**red**, but *not* because of `Debt Payments` (green at 135% of target) — because `Groceries`
is at 356% of its $200 target and `Car Payment / Transportation` is over. Rajna's went green
→ **red** on `Miscellaneous` at 223% of $86. The header stopped averaging its worst line
away. Worth knowing: for both people the color is now driven by an incidental item rather
than by the debt line the decision was written for. The delta figure is still the bucket's;
only the color moved, and a tooltip says so.

**The denominator's name.** `cardPurchases` is returned, and the plan header prints
**"% of commitments"** when it is non-zero and **"% of take-home"** when it is not, with a
tooltip spelling out the deliberate double count. Rajna's plan prints "% of take-home", for
a reason worth recording: **her three cards are `owner: 'shared'`, and a CSP sees only
accounts matching its own owner.** So `$19,216` of Discover debt is invisible to her
Spending Plan. That is the existing scoping rule working as written — and #24 scopes only
the *Credit subtab* to "mine plus shared" — not a T28 bug. But it means the card half of
#21 is currently a Woody-only feature. **Flagged, not changed.**

**Coverage.** `cardCoverage` reports, per in-scope card, which months of the window actually
have rows, plus `covered / total` and an `anyCards` flag so a plan with no cards says
nothing rather than "0 of 6". On screen it is a pill: green "card data covers all 3 months",
amber "covers 2 of 6" with a per-card tooltip. Woody's trailing-12 window reads **8 of 13** —
the Apple Card has no rows before 2026-03 and the **Chase card has none at all**, which is
exactly the under-reporting the clause exists to make visible.

**Three data decisions, taken by the user:**

1. **`Groceries` gets `categories: ["Groceries"]`.** It had a $200 target and no match rule,
   so it read "target only — not tracked" while $752/mo of card groceries sat in the
   catch-all. Now `$711.52/mo` against $200 — red, and true. This is #21's promised upside,
   the one the phase was for.
2. **Card `Interest` folds into `Debt Payments`** rather than getting its own line.
   **The consequence, stated plainly because it is counter-intuitive:** `Debt Payments` is
   the `fund`-direction item, so interest counts *toward* its target. Woody's actual moved
   `$3,485.75 → $3,669.07/mo`, i.e. **128.4% → 135.2% of target — the row got greener
   because he paid more interest.** The alternative (a $0-target `Card Interest` line in
   Fixed Costs) was offered with this caveat and declined. Revisit if the row starts reading
   as a win.
3. **`Food` gets a new Guilt-Free item** (`csp-woody-food`, `categories: ["Food"]`),
   `$883.14/mo`. **Its target is $0 and needs the user's number** — what to budget for
   restaurants is not derivable from what was spent. `Transportation` ($302/mo) and `Bill`
   ($108/mo) were deliberately left in the catch-all.

Together these moved $1,777.98/mo out of Woody's Unassigned ($4,227.92 → $2,449.94), which
is exactly `711.52 + 883.14 + 183.32`.

**Two things found while verifying, both data rather than code:**

- **`Loan Payment` is unmatched for Woody — $543/mo over six months, 27 rows.** The seed
  gives `Debt Payments` `categories: ["Credit Card Payment", "Loan Payment"]`; the live row
  has been hand-edited to `["Credit Card Payment"]` plus `sources: ["Student Loans"]`, so a
  `Loan Payment` row from any other payee falls to the catch-all. Left alone — the removal
  is the user's own edit, and restoring it is a budgeting decision, not a bug fix.
- **The one-legged $1,862.14 balance transfer overstates May 2026 by $1,862.14.** #47's two
  card→card transfers are handled correctly in opposite ways and for the same reason: the
  Apple→Citi $4,000 pair nets to **zero** (the charge on Citi against the credit on Apple),
  which is #47's "must not invent spending that never happened" satisfied exactly. But the
  Chase→Citi $1,862.14 leg (`Transfer` / "BAL XFR. CHASE MASTERCARD & VISA", Citi,
  2026-05-05) has **no counterpart, because `woody-chase-card` has no ledger rows at all**,
  so it counts as a card purchase in `Transfer` and falls to Guilt-Free's Unassigned. That
  is debt *moved* reading as debt *taken on*. **Left counting on purpose** — #21 is explicit
  that nothing is excluded for being a transfer and that `excluded` must not grow a
  card-transfer category, and special-casing `Transfer` would break the identity rather than
  fix the data. It resolves itself with no code change the moment Chase gets its opening
  balance: see the open question on `woody-chase-card`'s $7,931.13, which is the same row.
  It does **not** reach `Debt Payments` in either case, which is the clause #47 names T28
  for.

**Two things cleaned up in passing, both of which would have become bugs:**

- `csp.js`'s `unassignedRows()` rebuilt the Unassigned row list by re-filtering the ledger
  on `withdrawal > 0` — a second, divergent copy of "what counts" living in the UI, which
  would have silently dropped every card refund. The engine now returns
  `unassigned.matched` and the duplicate is deleted. The drill-down's amounts go through the
  engine's own `cspRowAmount`, so a refund shows as `−$315.88` rather than `$0.00`.
- `shared/csp.js` carried a **raw NUL byte** as `groupRows`' map-key separator, which made
  the file binary to `grep` and `diff`. Now written as the escape `\u0000` — same key, same
  behavior, greppable file.

**`npm run seed:csp -- --patch` is new, and exists for a reason worth keeping.** #38's three
keys have no editor on the page, so they can only arrive from `csp-seed.json` — but by then
the targets in the database are the user's real edited numbers, and `--replace` would have
reset them to the PDF's. `--patch` merges in only `data` keys that are **absent**, never
overwriting a set value, and stamps `updated_at` with the real time so it wins the LWW
merge. It reported exactly the two rows and three keys expected. The category changes above
went through the app's own `PATCH /api/plan-targets` instead, append-only.

**Still open after T28:**

- **The `even` tolerance question (#38).** It is an equality to the cent, so on a monthly
  average it fires only where the ledger is itself a fixed monthly amount — which turns out
  to be four real rows (`Insurance`, `Braces`, `Real Estate`, `PRP Treatment`). If "within a
  dollar or two" was meant, it becomes a band. Left unresolved deliberately.
- **`Food`'s target is $0.** Needs a number.
- **Rajna's cards are `owner: 'shared'`**, so her CSP sees no card data. Decide whether that
  is right before T32 prints a coverage chip on her Credit subtab.
- **Nothing in `shared/metrics.js`.** T27 already resolved every `summary()` /
  `monthlySpend()` call site to an explicit scope (its table of call sites), so this task
  deliberately touched none of them: T28 made the *CSP's* scope explicit and nothing else's.

---

## T29 — `shared/statement-import.js`: four adapters + a generic mapper · **Opus** — ✅ **done (2026-10-08)**

> **The conventions are now verified fact, not inference — see "T25 findings" for the exact
> header rows (2026-10-08).** The three that would have been guessed wrong:
> **Citi's `Credit` column is itself negative**, so `amount = Debit + Credit`; **Capital
> One's is positive**, so `amount = Debit − Credit` — the two split-column issuers use
> **opposite** conventions and must not share an adapter. **Apple's refunds are negative
> rows that are not payments**, so filter payments on `Type === 'Payment'`, never on the
> sign. Also binding: `external_id` keys on the **transaction** date (#46), because three
> exports carry a mutable post date and Chase's already contains a future-dated `Pending`
> row. **Citi exports no category column at all**, so its rows depend entirely on T30.

Pure, browser-first, zero deps. Takes CSV **text** and returns normalized rows; it never
sees a path, a `File`, or the network — that keeps the "file never hits disk" guarantee a
property of the architecture rather than of remembering to delete something.

- Reuse `parseCsv` from `local/import-csv.js` by **moving it to `shared/csv.js`** and
  re-importing it there (it is already correct on quotes, escaped quotes, and embedded
  commas/newlines — don't write a second one).
- `detectIssuer(headerRow)` → match on header **signature**, not filename. Adapters for
  **Apple Card, Capital One, Citi, Discover** (+ Chase if T25(a) says so), each declaring:
  its date column (transaction date, *not* post date — the statement period and the CSP
  window both key off when you spent), merchant column, issuer-category column, and its
  **amount convention**. That last one is per-issuer and is where this task gets it wrong
  if the samples weren't checked: some issuers sign purchases negative in one `Amount`
  column, some positive, and some split `Debit`/`Credit` into two columns. **Transcribe
  from T25(c)'s recorded headers; do not infer.**
- `normalize(rows, adapter)` → `{ txn_date, source: merchant, description: mappedCategory,
  deposit, withdrawal, external_id, raw }`. A purchase becomes `withdrawal`; a **refund,
  statement credit, or payment becomes `deposit`** (decision #22). Payments appearing in a
  statement CSV need care: if T34 already created the card-side `deposit` for a payment,
  the importer must match it by `transfer_id` rather than add a second one.
- `external_id` = a deterministic hash of `(account_id, txn_date, amount, normalized
  merchant, occurrence-index-within-that-key)`. The occurrence index is what makes two
  genuine same-day same-amount Starbucks runs survive while a re-uploaded statement
  dedupes to nothing. **Never** use the issuer's own reference number alone — Apple Card's
  export doesn't carry a stable one.
- `issuerCategoryMap` — a small per-issuer table folding the issuer's own categories into
  this ledger's `description` vocabulary (`Food`, `Bill`, `Groceries`, `Transportation`,
  `Misc`, …), as the first-pass guess T30's learned rules then override.
- `diffAgainstLedger(normalized, existingRows)` → `{ fresh, duplicates, conflicts }`, where
  a conflict is a matching `external_id` whose **amount differs** (a pending charge that
  settled at a different amount) and is surfaced as an *update*, not a duplicate.
- **Generic fallback:** an unrecognized header returns the column list so the UI can ask
  the user to map them once, and the mapping is saved to `accounts.data.column_map` for
  that card. Covers the fifth issuer nobody planned for.

Server side: **one** route, `POST /api/transactions/bulk`, taking already-parsed rows
`{ account_id, import_batch, rows: [...] }`, inserting inside a manual
`BEGIN`/`COMMIT`/`ROLLBACK`, skipping any `external_id` that already exists (belt and
braces behind the client-side diff), and returning `{ inserted, skipped, updated }`.
No parsing, no file handling, and no `/api/import` endpoint that accepts a file.

**Verification is the known-good diff, courtesy of T26b.** Because the ledgers were
loaded by hand and reconciled to the statements first, each adapter can be checked against
a month whose correct answer is already in the database: run the uploader over an
already-loaded statement and expect **zero fresh rows, zero conflicts, and identical
categorization**. Any difference is unambiguously an adapter bug, not a question about the
input — which is the whole reason the bootstrap was decoupled. Keep T26b's `external_id`
formula **verbatim**; re-deriving it differently here turns the test into a duplicate load.

**Done when:** the known-good diff passes for every issuer (0 fresh rows against a loaded
month); a statement overlapping a loaded period by two weeks inserts only the genuinely new
rows; a deliberately sign-flipped synthetic fixture is caught by an adapter assertion
rather than silently importing refunds as purchases; the generic mapper handles an
unrecognized header without data loss; and `git status` is clean after an import.

### T29 status — shipped 2026-10-08, **the known-good diff passes on all five cards**

```
Woody_Apple.csv       → woody-apple-card    567 rows   fresh 0  duplicates 567  conflicts 0
Woody_Citi.CSV        → woody-citi-card      26 rows   fresh 0  duplicates  26  conflicts 0
Rajna_Capital_One.csv → rajna-capital-one   174 rows   fresh 0  duplicates 174  conflicts 0
Rajna_Discover.csv    → rajna-discover      138 rows   fresh 0  duplicates 138  conflicts 0
Rajna_Chase.csv       → rajna-chase           6 rows   fresh 0  duplicates   6  conflicts 0
                                             911 rows, identical categorization on every one
```

Reproduce with `npm run check:import` (read-only) and `npm run check:bulk` (the write
route, against a throwaway copy). **Five adapters, not four** — Chase is included, and T25(a)
settled that it needs one even though its export is a payment history rather than a
statement.

**What shipped**

- **`shared/csv.js`** — `parseCsv` moved out of `local/import-csv.js` as the task directs
  (re-exported there, so its callers are unchanged), plus the header hygiene both import
  paths need: BOM, CRLF, and the U+00A0 inside Chase's header and its `Pending` value.
  Also `toIsoDate` for the **five** date formats (T25's table recorded the date *columns*
  but not their formats, and all five differ), and `sniffDateFormat`, used only by the
  generic mapper.
- **`shared/statement-import.js`** — `detectIssuer` (header signature, never the filename),
  the five adapters, `normalize`, `checkConvention`, `diffAgainstLedger`, `inspectColumns` /
  `adapterFromColumnMap` for the generic fallback, and `readStatement` as the one entry
  point the page calls. It takes **text** and returns rows: no path, no `File`, no network.
- **`POST /api/transactions/bulk`** — already-parsed rows only, one manual
  `BEGIN`/`COMMIT`/`ROLLBACK`, skips any `external_id` already on a live row, returns
  `{ inserted, skipped, updated }`. There is no `/api/import` that accepts a file, and
  `check:bulk` asserts that as a 404 so it cannot be added back by accident.
- **`local/check-import.js` / `local/check-bulk.js`** + `npm run check:import` /
  `check:bulk`, in the repo alongside `check-csp.js` and `check-theme.js`.
- **`local/db.js`** gained a `DASHBOARD_DB` env override (default unchanged). It is what
  lets the bulk route's write path be tested against a copied database instead of the real
  ledger — which is how "`git status` is clean after an import" is demonstrated rather than
  asserted.

**Three things worth recording, because they are decisions and not just code.**

1. **A conflict cannot be what the task says it is, so it is one component looser.**
   The task defines a conflict as *"a matching `external_id` whose amount differs"* — but
   #46 puts the amount **inside** the fingerprint, so a pending charge that settles at a
   different amount gets a different `external_id` by construction and can never collide.
   Implemented as written, that bucket is provably always empty and the real case (a $1.00
   gas hold settling at $45.12) lands as a second row beside the stale one. So a conflict is
   detected on **same account + same transaction date + same normalized merchant + different
   amount**, with neither side already matched exactly, paired greedily by closest amount.
   It can still be wrong — a genuinely new charge at a merchant that already has an
   unmatched same-day row looks like an amendment — which is why it is surfaced as an
   *update proposal* the review modal can reject, moving the row to `fresh`.
2. **Two more match paths than the task asked for, both load-bearing.** A payment T34
   already mirrored carries a `transfer_id` and **no** `external_id`, so an exact match is
   impossible and the importer would add a second copy of a payment that is already there —
   matched on `transfer_id` + amount + a ±3-day window and reported as a duplicate carrying
   `adopt_id`, so confirming stamps the fingerprint onto the row that exists and the match
   is exact forever. The same adoption covers a hand-entered row with the same date,
   merchant and amount: the ledger existed before the uploader did.
3. **The two adapter sets are deliberately NOT collapsed into one.** T26b's loader keeps its
   own five adapters. That looks like the duplication #51 warns about and is not: #51 is
   about the import *contract* — the `external_id` formula and the category table — which
   both paths import from `shared/card-import-spec.js` and cannot drift on. The adapters are
   two independent readings of the same five files, and **that independence is the test**:
   if the uploader imported the loader's adapters, `check:import` would be comparing a
   function to itself. The loader is also one-time and already run, so there is no future
   drift to prevent. `shared/statement-import.js` is canonical for anything new.

**The sign-flip test is per issuer, because each one is caught by a different assertion** —
which is the point, since a single aggregate heuristic would be blind on at least two of
them:

| issuer | what catches an inverted file |
|---|---|
| Apple Card | `payment-is-a-charge` — `Type: Payment` carries no sign, so a flipped payment is caught with certainty |
| Citi | `credit-column-sign` — its `Credit` values must all be negative |
| Capital One | `credit-column-sign` — its `Credit` values must all be positive. This is the assertion that catches **the two split-column adapters being swapped**, which is the single likeliest way to get this wrong, since the natural reading of a split export is Capital One's |
| Discover | `interest-is-a-credit` — its payments are identified by `amount < 0 && /PAYMENT/`, so a flipped file's payments stop being recognized as payments and the payment check goes blind. A card does not pay you interest |
| Chase | nothing, by construction — its amount is always an outflow and the sign is **applied**, not read. Negating its `Amount` column provably changes nothing, which is asserted instead |

Each assertion rests on evidence the issuer gave us that is independent of the amount's
sign. `mostly-credits` exists as a backstop for an issuer with no type column at all, and
is skipped for a payments-only export, where it would fail on correct data. `force: true`
is the only way past any of them — offered in the review modal for a genuine export change,
as a choice the user makes rather than a fallback the code takes.

**Two things found while doing it, both now fixed and both silent failures.** `creditSign`
was first written as a multiplier, which inverted **both** split-column issuers at once and
produced exactly T25's −$538.00 Citi symptom; it is now declared as *the sign the column's
values carry* and the same field is asserted against the file, so the declaration and the
check cannot disagree. And the first Discover fixture invented a payment string
(`DIRECTPAY FULL BALANCE`) that the real file does not use — Discover's are
`INTERNET PAYMENT - THANK YOU` — so the fixture silently tested nothing until it was
replaced with the real string.

**Verified against a moving target, which turned out to be the better test.** T34's backfill
landed in `dashboard.db` partway through this task and added 66 mirrored payment rows plus a
`[t34-backfill-…]` marker on the notes of the card-side payments it paired. Re-running
`check:import` against that mutated ledger still gives **0 fresh and 0 conflicts on all 911
rows with identical categorization** — the mirrored rows are matched, not duplicated. The
one assertion that did break was this harness's own byte-exact `note` comparison, now a
**prefix** check: the importer owns `issuer · <raw category>` and must match it exactly,
while what a later task appends is legitimately not the importer's business.

**Not done here, on purpose:** the review modal and the upload button are T31's, and T30
owns the learned rules that override the first-pass categories. The statements are still
staged at `~/Downloads/CSVs` per T26b's open clause (#45/#50) — `check:import`'s headline
test needs them, and it skips with a note rather than failing once they are deleted.

---

## T30 — Merchant rules + recurring detection · **Opus** — ✅ **done (2026-10-08)**

> **T25's audit re-weights this task upward (2026-10-08).** Decision #21's *"card purchases
> land at their own category"* is only as good as the categories, and the real data says the
> issuers' are not good enough: **`Other` is 60% of Woody's Apple Card in 2026-09**
> ($1,848.08 of $3,058.35), and **Citi exports no category column at all**. The three issuer
> vocabularies are transcribed verbatim in "T25 findings" and share almost no spelling
> (`Grocery` / `Supermarkets` / none; `Restaurants` / `Dining` / `Restaurants`). This is not
> polish — it is what makes #21 mean anything.

Your "most payments on cards are repeating" — both halves of it.

**(a) Extract `generateRecurring` to `shared/recurring.js`** *(this sub-step is
Sonnet-sized if split out)*. `paycheck.js`'s version is correct — weekly/biweekly/monthly/
per-pay-period, `CAP = 300`, skips a day that doesn't exist in a short month — but it
closes over `state.cadence`, `state.anchor` and `pushNew`. Lift it to a pure
`occurrences(base, freq, until, { cadence, anchor })` returning an array, and have
`paycheck.js` call it. **Verify This Paycheck is byte-identical afterward** — this is a
refactor of a working daily-use path, and `freq: "period"` is the subtle case.

**(b) Merchant → category rules.** A new `plan_targets` kind, `card_rule`, so it inherits
the snapshot and the per-record LWW merge for free:
```jsonc
// kind: "card_rule"  owner: "woody"
data: { match: "WHOLEFDS", match_type: "contains", // contains | exact | regex
        account_id: null,                 // null = applies to all of this owner's cards
        description: "Groceries", source: "Whole Foods", priority: 0 }
```
`applyRules(rows, rules)` lives in `shared/` and runs during import preview, so the review
modal opens pre-categorized. Precedence must be **written down and tested**, because it is
exactly the bug class that resolved decision #7 fixed for CSP items: `exact` beats
`contains` beats `regex`, card-specific beats all-cards, then `priority`, then longest
match. Rules are learned on confirm — editing a category in the review modal offers
*"always categorize WHOLEFDS as Groceries"* — and are editable/deletable somewhere
(simplest: a section on the Cards tab, not a sixth page).

**T26b's loaded data is the rule set's training corpus, and this is the only cheap moment
to build it.** Categorizing a few months × five cards once, in bulk, produces the rules that
make every later single-statement upload near-automatic; doing it one upload at a time
instead means hand-categorizing the same merchants repeatedly. So T30(b) should ship a
**bulk categorize pass over the seeded rows** — group the ledger's distinct card merchants
by total spend, work down the list, and write a `card_rule` per decision — rather than only
the per-row learning in the review modal. Ordering note: T26b runs long before the rules
exist — rows land with whatever first-pass category the hand load gave them — and this pass
then re-categorizes them in place. That is the better sequence anyway, since you can only
see which merchants are worth a rule once the real data is in front of you.

**(c) Recurring detection.** Note this is only testable *because* T26b loaded real
history: the detector's whole premise is ≥3 consecutive months of a merchant, so before the
backfill there is nothing to detect and no way to tell a true positive from a lucky guess.
`detectRecurring(rows, { months: 3, tolerance: 0.15 })` →
merchants appearing in ≥3 consecutive months within ±15% amount, returning
`{ merchant, cadence, typicalAmount, lastSeen, confidence }`. Surface after an import as
*"Netflix looks monthly — project it forward?"*, generating future-dated rows through
(a)'s `occurrences()`, **staged behind Save** like every other add. Guardrails: never
auto-generate without confirmation, never project past the existing recurring `until`
default, and **never create a row whose `external_id` a future import would collide
with** — projections get a `projected: true` marker (on `note` or a dedicated column) so a
real statement row supersedes its projection instead of sitting beside it as a duplicate.
That supersede rule is the whole difficulty of (c); spec it before coding it.

**Done when:** This Paycheck's recurring modal behaves identically post-extraction
(screenshot-verified, all four frequencies, including a 31st-of-the-month base date);
importing a second month of a card auto-categorizes the known merchants and leaves the
unknown ones blank, never guessed; detection finds the real subscriptions in your Apple
Card history and no false positives among one-off merchants; and a projected row is
replaced, not duplicated, when its real statement row arrives.

**Shipped 2026-10-08.** Two new pure modules — `shared/recurring.js` (the cadence
arithmetic, the detector, the supersede rule) and `shared/card-rules.js` (`card_rule`
compile / match / precedence / apply) — plus `local/card-rules-seed.json` (58 rules),
`npm run seed:card-rules`, `npm run categorize:cards` and `npm run check:rules`
(**every check passed**: 1,254 parity cases, all five precedence tiers, detection over the
real ledger, and the supersede contract).

**(a) The extraction is proven by diff, not by eye.** `occurrences(base, freq, until,
{cadence, anchor})` was transcribed out of `paycheck.js`, and `check:rules` carries a
**verbatim copy of the original implementation** and compares the two across **1,254 cases**
— four frequencies × eleven base dates (the 31st, the 30th, the 29th in a leap and a
non-leap year, month ends, New Year) × six `until` dates × four cadences × four anchors —
identical date-for-date. That is a stronger statement than the screenshot the task asked
for, and it is the one that covers `freq: "period"`, whose offset-inside-the-window
behaviour is invisible in a screenshot. `defaultUntil` moved into the same module, so the
modal's default stop date and the projection guardrail ("never project past it") are now one
function instead of two that agree today. `paycheck.js`'s `generateRecurring` survives as a
four-line wrapper that stages what `occurrences` returns.

**(b) 58 rules, and the ledger re-categorized.** The seed was written merchant-by-merchant
down a by-spend report of the real 977 card rows, on a stated rule of inclusion: a rule
exists only where the issuer is **wrong, absent or inconsistent**. Restating a category
three issuers already agree on (every Chick-fil-A row is already `Food`) would just be a
second copy of their vocabulary. The bulk pass moved **153 rows** and **$6,920.92 out of
`Misc`**, taking it from **247 rows (27%) to 113** — $3,521 to `Bill` (tuition $2,398, Hims
& Hers $935, Google, AHS, software), $1,991 to `Transportation` (Tesla charging $726, Uber
rides reclaimed from Discover's `Travel/Entertainment`, parking, tolls, a citation), $495 to
`Groceries` (Walmart in three spellings, Sprouts, WM Supercenter refunds netting into the
category they came out of), $895 to `Fun`, and the card **rewards credits to `Adjustment`**,
which is already in the CSP's exclude set — left in `Misc` they were netting against Misc
spending and making a quarter of the ledger read lower than it was. All 26 Citi purchases
had no issuer category at all; 11 of them now have a real one.

**What the dry run caught, and why the pass is dry-run-by-default.** `contains ALDI`
matches **`EU KALDIS`** — Kaldi's Coffee — and would have moved **44 `Food` rows into
`Groceries`** silently. It is now the one regex in the file (`\bALDI`), and the audit that
found it (every needle checked for mid-token matches across every distinct merchant string)
is why `PARKING` is a rule and `PARK` is not: `BAR TACO INMAN PARK` is dinner. The pass
takes a backup, prints the plan with per-rule match counts and net dollar movement per
category, skips identity rows (`Credit Card Payment` / `Transfer` / `Interest` /
`Adjustment`) whatever a rule says, applies the category but never a merchant rename to
rows that already exist, and is idempotent — a second run finds 0 changes.

**`check:import` needed the same amendment its own `note` check needed.** Its headline test
compares the importer's category against the ledger's, and the bulk pass just made the
ledger the first pass **plus the rules**. So the comparison is now `first pass + card_rules
=== ledger`, exactly as the `note` assertion became a prefix check when T34 started
annotating notes: the test polices what the importer owns, and the importer owns the
issuer's category, not the household's final word on a merchant. It passes again and now
reports *"identical categorization on all 567 rows (80 via a card_rule)"* per file — which
is also the task's "importing a second month auto-categorizes the known merchants",
measured on four real statements rather than asserted.

**(c) The spec the data forced.** The task's detector — "≥3 consecutive months within ±15%"
— returns, on this ledger, `CHICK FIL A` (38 charges over 7 consecutive months), `QT INSIDE`
(37 over 7), `UBER TRIP` (53 over 8) and `PUBLIX` (18 over 7): every frequent-but-
discretionary merchant, because "appears every month" describes a habit, not a subscription.
The discriminator the corpus shows is **one charge per period**, and it is categorical: every
true positive bills exactly once in each of its months, every false positive three to seven
times. With both tests, Woody's Apple Card yields exactly three — `GOOGLE` $26.99 (95%),
`AMAZON PRIME` $15.89 (90%), `AHS AHS COM` $62.99 (75%) — and `check:rules` asserts both
directions: the three are found at their real amounts, and all six habit merchants are not.
`Interest` is excluded by category even though it recurs monthly: it is computed from the
balance, so projecting last month's figure forward is simply wrong, and it belongs to T32b's
payoff model.

**The supersede contract, specced before coding** (the full six rules are the header comment
of `shared/recurring.js`). A projection is a real future row with `transactions.projected =
"<cadence>:<merchant stem>"` — the flag and the match key in one additive column — and
**never an `external_id`**, which makes "a future import cannot collide with a row we
invented" structural rather than a rule to remember. A statement row supersedes a projection
on **equal merchant stem within half a cadence step** (±15 / ±7 / ±3 days), nearest first,
one-to-one, and **deliberately without an amount test**: the projection's amount is the thing
the statement is correcting, and a leftover projection beside the real charge double-counts
the money, which is strictly worse than consuming a guess that was wrong about the price.
The write is an `update_id` through the existing bulk route, so the row keeps its id and the
route clears `projected` unconditionally. Two charges in one month: the nearer one takes the
projection, the other lands fresh — both survive. A merchant stem (digits, store ids, state
codes and Discover's `…GAAPPLE PAY ENDING IN 2877` tail removed) is deliberately **not**
`normalizeMerchant`, which keeps digits because the fingerprint needs two same-day Amazon
charges to stay distinct; a stem groups a history, a fingerprint identifies a row.

**Where it lives on screen.** Two collapsible panels on the Credit subtab (no sixth page):
*Merchant rules* — the rule set in the order precedence actually consults it, each row
editable, with a live **match count against the whole card ledger** because a rule that
matches nothing is the commonest authoring mistake and is otherwise invisible; an *Apply to
this window* button that stages re-categorizations behind the existing Save; and the learned
rule offered the moment a category is corrected by hand (*"Always categorize WHOLEFDS as
Groceries?"*), both in the mini ledger and once per statement on the review modal's confirm.
Rules are the subtab's **third staged set**, with their own Save/Discard, counted in the
`beforeunload` guard and in the subtab-switch warning — a rule is strategy, a transaction is
a fact, and one Save button for both would eventually rewrite the wrong one. *Looks
recurring* lists the detected subscriptions with a confidence bar and a *Project forward*
button (confirm → staged rows → Save), says *"projected through <date>"* instead of offering
to do it twice, and surfaces **past-due projections** — a projection whose statement never
arrived is a cancelled subscription or a late statement, and only the user knows which, so
it is offered for deletion, never removed automatically. A projected row carries a sub-row in
the mini ledger saying so, which turns `warn` once its date has passed.

**Two decisions recorded rather than hidden.** *(i)* **No health category.** ~$1,500 of the
remaining `Misc` is dental, PT, dermatology, labs and pharmacy, and the ledger vocabulary has
no home for it. Inventing one is not free — it needs a theme token (T38 shipped exactly
three) and a CSP item to land in, or it renders gray in `Other` and lands in Unassigned — so
it stays `Misc` with the issuer's raw category preserved on the note. That is the one real
vocabulary gap the data shows. *(ii)* **Mixed retail stays `Misc` on purpose**: $1,227 of
Amazon across 18 rows is groceries, tools, clothes and gifts, and `Misc` is the honest
answer. Genuinely unknown merchants (`SQ *MARY'S`, `SIPPING PLANT LLC`, `CITY OF ATLANTA`)
are left alone, which is the acceptance criterion working: unknown is a visible state, not a
guess that looks like an answer.

**The CSP consequence, measured by diffing the engine over the pre-categorize backup and
the live database with the same plan** (so the seed's own edits can't contaminate it).
In the Spending Plan's default *Last 3 months* window, Woody's figures move and nobody
else's do:

| Woody, last 3 months | before | after |
|---|---|---|
| Fixed Costs actual | $24,752.01 | **$20,542.18** (−$4,209.83) |
| ↳ `Miscellaneous (15% buffer)` | $6,355.62 | **$2,238.28** (−$4,117.34) |
| ↳ `Groceries` | $2,227.05 | $2,134.56 (−$92.49) |
| Guilt-Free actual | $4,867.99 | **$9,075.91** (+$4,207.92) |
| ↳ `Food (restaurants / takeout)` | $2,461.33 | $2,649.43 (+$188.10) |
| ↳ **`Unassigned`** | $2,406.66 | **$6,426.48** (+$4,019.82) |

All-dates the same shape, larger: buffer −$5,732.86, `Unassigned` +$5,915.29. **Rajna's
plan does not move at all**, which is not a win — it is T28's known gap (her three cards
are `owner: 'shared'` and `computeCsp` matches `a.owner === pt.owner`, so shared-card rows
reach neither person's plan).

**This is the answer to the open "which card categories need their own CSP items"
question, and it is a plan-authoring decision rather than a code one.** The $4,117.34 that
left `Miscellaneous (15% buffer)` did not become mis-filed — it stopped being mis-filed:
it is tuition, Tesla charging, parking, Hims & Hers, Google, Uber rides and groceries,
none of which is a miscellaneous buffer. But Woody's plan has **no item claiming
`Transportation`, `Fun`, or `Bill`-beyond-its-named-sources**, so those dollars land in
`Unassigned` — which is at least *visible and named as unexplained*, where the buffer line
quietly looked like a plan being met. The recommendation the data supports, for whoever
edits the plan next: **`Transportation`, `Fun` and `Interest` items** (the last is already
recommended in T28's notes at 24 rows / $2,178 on Discover alone), after which
`Unassigned` should fall back toward its pre-card level. Two smaller observations from the
same diff: `Groceries` went **down** $92.49 because Walmart's two refunds (−$315.88 and
−$273.90) now net against the category they came out of instead of against `Misc` — which
is the behaviour decision #21 asks for, visible for the first time; and `Food` rose
$188.10 from the Citi restaurant rows that had no issuer category at all.

**Also here, small and deliberate:** `Interest` and `Adjustment` joined the category picker
(T26b's load made them real categories with 24 and 22 rows), and `transactions.projected` is
the fifth additive `ensureColumn` of Phase 13 — no `schema_version` bump, since `SELECT *`
carries it into the snapshot and `mergeInto` derives its column list from `PRAGMA
table_info`. An older machine drops the column on merge and the projection degrades to an
ordinary future-dated row there: visible and editable, never corrupt.

**Not done here:** the three healthcare/retail vocabulary questions above are somebody's
decision, not a missing feature. `npm run categorize:cards -- --report` prints the uncovered
merchants by spend, which is the standing worklist for the next rule.

---

## T31 — The Credit subtab: switch, card picker, debt header, upload/review UI · **Sonnet** — ✅ **done (2026-10-08)**

Built **into `paycheck.html` / `paycheck.js`**, not into a new page — decision #37. The
mockup to build against is `local/public/cards-mock.html` screens 1–4 (rev 3); it uses real
`theme.css` tokens, so it is a layout spec, not a sketch. Markup and staging only — T32
wires the real numbers, so stub the figures behind one `computeView()` seam and don't
improvise the math.

- **No new nav item and no new page.** The header nav stays at four items. `paycheck.html`
  gains a `[ Debit | Credit ]` switch mounted with **`view-switch.js`** — which already
  renders exactly this control for *Plan targets | Spending Plan*, so this is a second
  caller, not a second component. Pass a `views` array of the two subtabs; its existing
  `views.length < 2` guard is what T36 uses to hide the switch on the published page.
  **Do not extract a `nav.js`** — the earlier draft of this task called for it to add a
  fifth nav link, and there is no longer a fifth link.
- **Subtab state**: `?view=credit` in the URL plus `localStorage` (`paycheckView`), the
  same pattern as `cardsAccount` below. Switching subtabs with unsaved edits must warn —
  reuse the Ledger's `#account` confirm pattern, since the two subtabs have separate staged
  edit sets.
- **The pay window is shared** (decision #37). Both subtabs read the same
  `windowFor(cadence, anchor, …)` state, the same `‹ ›` arrows, the same `navcurrent` dot
  and date-jump. **Mount no timeframe control on the Credit subtab** — no
  `timeframe-ui.js`, no `MONTH_PRESETS`, no `cardsPreset` storage key. Switching to Credit
  keeps you on the pay period you were already looking at.
- **Card dropdown**, owner-scoped per decision #24 (`owner === currentUser || 'shared'`,
  `type === 'credit_card'`) — the Ledger's existing filter, lifted. Persist in
  `localStorage` (`cardsAccount`) and accept `?account=` for deep links, matching the
  Ledger. Empty state: *"No cards yet — add one"*, not a blank page. If the person has zero
  cards, hide the **Credit** half of the switch entirely rather than offering a dead tab.
- **Stat row + banner**, in the shape `paycheck.html` already uses (`.window-head .stat`,
  `.banner`): **Owed — all N cards**, **Charged** (net of refunds), **Paid**, **Debt
  change**. The banner states the identity in words — *"ends the pay period owing $5,183.84,
  up $789.80"* — and goes `warn` when debt rose, `ok` when it fell. Debt renders **positive
  with an "owed" label** while the underlying balance stays negative (the display-layer
  sign flip, and the only place it happens).
- **Card metadata line** from `accounts.data`: opening owed, statement balance, credit
  limit, utilization bar, APR, payment due, minimum.
- **Category donut**, the same component and geometry as This Paycheck's
  (`renderChart()` in `paycheck.js` — `cx/cy 110`, `rO 96`, `rI 60`, `pad .03`, ≥7% slices
  labelled, legend never color-alone). Refunds **net into their category**, so a category's
  slice is its charges minus its refunds. 🚩 A refund exceeding a category's charges makes
  the value negative and the arc undrawable — clamp the slice to zero and show the true
  negative in the legend.
- **The three new category colors come from Phase 14's T38 — this task does not touch
  `theme.css` or `check-theme.js`.** `CAT_COLORS` in `paycheck.js` maps 8 categories and
  **Groceries, Transportation and Misc are not among them**, so without new tokens the
  majority of a card donut collapses into one gray `Other` slice — useless on exactly the
  data it exists for. Per the prologue, T38 ships `--cat-groceries`, `--cat-transport` and
  `--cat-misc` across every variant and adds them to `check-theme.js`'s token list; T31
  only **extends `CAT_COLORS` to reference them**. If T38 has not landed, land this task
  with the three categories folded into `Other` and a `// TODO(T38)` — a wrong-looking
  donut is recoverable, a second hand-maintained copy of the palette is not.
- **Mini ledger**: the same editable grid, staged behind **Save / Discard** with the
  `beforeunload` guard — never auto-save. Three label changes: Deposit/Withdrawal →
  **Charge / Credit**, Projected balance → **Owed** (counting *up* as you charge), and the
  negative-row highlight **inverted**, since a positive owed is normal and a negative one
  means you overpaid. The `transfer_id` pair shows as a sub-row under a payment
  (*"⇄ paired with Woody — Checking · −$434.00"*), because an unpaired payment has to be
  *noticeable* to be fixable.
- **Add expense row** with **no "repeating" button** (decision #37). `Add` stages the one
  row, then the **existing** `#recurModal` asks once-or-repeating with a frequency and an
  until-date — exactly the flow at `paycheck.js:375` (`pushNew(base)` then
  `openRecurModal(base)`). Both subtabs are in the same page, so the modal and
  `generateRecurring()` / `defaultUntil()` are **already in scope — no extraction needed
  for this task.** Default the frequency to `monthly` on a card. (T30 still wants
  `generateRecurring` in a shared module for the importer's projections; that stays its own
  task and is no longer a prerequisite here.)
- **No category/merchant rollup** (decision #39). The donut answers "where did it go" and
  the ledger lists every merchant; a third view of the same rows was weight without an
  answer.
- **Upload button**: a file input that reads with `FileReader`, parses via
  `shared/statement-import.js`, and opens a **review modal** — detected issuer, counts
  (fresh / duplicate / conflict), an editable table of fresh rows with their guessed
  category, a per-row exclude checkbox, and totals that must match the statement. Confirm
  POSTs to `/api/transactions/bulk`; **Cancel discards everything in memory.** The file
  object is never stored, never uploaded, and the input is cleared on close. If T29 isn't
  merged yet, land the button disabled with a tooltip rather than a stub that half-parses.

**Done when:** the Debit subtab is byte-for-byte unchanged in behavior; the switch renders
for a person with 2+ cards, one card, and zero cards; switching subtabs or cards warns on
unsaved changes; Save writes to the right card's ledger and the stat row updates; the donut
shows five distinct colors rather than one gray slice (given T38); the recur modal opens
from the Credit add row and `Just this once` leaves exactly one staged row; the review
modal opens on a real CSV, shows a correct fresh/duplicate split, and Cancel leaves the DB
and `git status` untouched; `npm run check:theme` still passes and this task added nothing
to it.

---

## T32 — Wire the Credit subtab to the engine, coverage, projections · **Opus** — ✅ **done (2026-10-08)**

Replace T31's seam with `shared/cards.js`, the way T4b did for the Spending Plan.

- Every figure from `cardSummary`/`totalDebt`/`statementCycle`, computed over **the shared
  pay window** rather than a month preset.
- **Both identities visible on screen, not in a tooltip** (the mockup prints them in the
  banner and the stat row): `netPurchases − payments === debtChange` and
  `openingOwed + debtChange === closingOwed`. `debtChange` presented so *"charged $1,223.80,
  paid $434.00, debt up $789.80"* reads at a glance — this is the number that makes the
  whole subtab worth having.
- `netPurchases` is **net of refunds, per category**, matching the donut. Keep the gross
  charge total available for the stat row's secondary text.
- Surface T28's **card-data coverage** — a window partly without imported statements must
  say so on the page.
- To-date vs. projected split wherever the window crosses today, with the same labeling the
  CSP uses (the ledger runs to 2027-11, so this is the common case, not the edge case).
- Repaint on subtab switch, card switch and window change. Phase 11's T9 verified the
  nodes-exist-but-hidden approach for collapsed sections — keep it for T32b's panel.
- **"View in Ledger"** from the donut legend or a stat, using T5's existing
  `?from=`/`?to=`/`?category=`/`?source=` params with `?account=<card>`. One link per
  category is enough now that the per-merchant rollup is gone.

**Done when:** every number matches an independent Node run of `shared/cards.js` to the
cent across at least three pay windows on two different cards; both identities are visible
and correct on screen; a window change repaints the Credit subtab including T32b's
collapsed panel; "View in Ledger" lands pre-filtered on the right rows; screenshot-verified
in every variant then existing (Phase 14's T46 does the twelve-variant walk).

> **Done 2026-10-08.** `computeCardView()` is now a merge-and-display shim over
> `cardSummary` / `totalDebt` / `cardCoverage` / `statementCycle` / `statementBalance` /
> `minimumDue`; nothing on the subtab does card arithmetic any more. Verified by driving
> the real page in headless Chrome and diffing every rendered figure against an
> independent Node run of `shared/cards.js`: **160 assertions over three pay windows × two
> cards** (Apple Card, Discover) plus the repaint and deep-link checks, all to the cent.
> `check:csp` / `cards` / `theme` / `rules` / `import` / `bulk` / `transfers` all still pass,
> and this task added nothing to `check-theme.js`.
>
> Five things the plan did not have, each forced by the real data:
>
> **(i) The coverage bullet needed a second signal, and the one T28 computes is not it.**
> `cardCoverage`'s month report answers *"does this card have rows in this window's
> months"* — and T34 mirrored every planned payment onto the card side, so a pay window in
> 2027 **has** a row, reports *"1 of 1 month covered"*, and contains nothing anyone
> observed. The honest question on this page is *"is there an imported statement here"*,
> which only `data.seeded_range` answers. The pill now states whichever is wrong first:
> no statements ever loaded → months with no rows at all → *"statements end 2026-10-07 —
> this window runs past them"* → ✓. On this ledger the third case is the common one.
>
> **(ii) `cardCoverage` was extracted out of `computeCsp` into `shared/cards.js`** rather
> than written a second time, and csp.js now calls it (one new edge, `csp.js → cards.js`;
> cards.js imports only merge/metrics/timeframe, so there is no cycle and the two
> duplicated category sets stay as they are). The Spending Plan's output is byte-identical
> — `check:csp` passes untouched. It is the one computation both screens can lie the same
> way about, so it agrees by construction instead of by review.
>
> **(iii) The donut had a real bug, and reading `byCategory` is what fixed it.** T31
> classified non-purchases by a hand-kept name list (`["Credit Card Payment"]`), which
> misses `Loan Payment`, `Transfer` and `Adjustment` — so Citi's **$5,862.14 balance
> transfer** would have drawn as the biggest "purchase" of its window and Apple's $850
> reversal as the second. The donut is now `cardSummary().byCategory` directly, so
> `classifyCardRow` decides, the slices sum to `netPurchases` by construction, and
> `drawDonut` grew one optional `linkFor` — Debit passes none and is unchanged.
>
> **(iv) `cardSummary().owedToDate` is window-relative and must not be labelled "owed
> today".** It is `min(window.to, today)`, so on a past window it equals `closingOwed` and
> paging backwards would make the metadata line's "owed today" and its utilization bar
> drift. Both now read `totalDebt()`'s per-card contribution — genuinely as-of-today, the
> same number the chip above shows, and stable as you page.
>
> **(v) One whole-ledger fetch replaced one fetch per card.** The headline is `totalDebt`
> over the owner's whole card set (#24), which the old per-card fetch could not serve
> without six round-trips; `state.cardTxns` now holds every visible card's rows, the
> selected card's slice is derived from it, and the household total is computed over the
> **staged** view — so editing a charge moves "Owed — all 6 cards" without a save (verified:
> +$100 on one row moves Charged, Debt change, the donut, both identities and the household
> total by exactly $100, and Discard restores all of them with the DB untouched). The
> `.debt`-refetch helper T31 needed is gone. A debit save now refreshes the card ledger too
> — guarded on `!hasCardPending()`, since that button has no mandate to discard the other
> subtab's staged work.
>
> **Two notes for later tasks.** The repaint clause mentioning **T32b's collapsed panel
> could not be verified — T32b is not built.** What T32 leaves it is the seam: `renderCredit()`
> repaints every figure from state on each subtab, card and window change, so the panel is
> one `renderPayoffPanel(v)` call in that list, and `v` already carries `creditLimit`, `apr`,
> `owedToDate`, `payments` and the to-date/projected split it needs. Separately, **`Interest`
> has no `CAT_COLORS` entry** and is $3,338.95 over 24 rows — 96% of Discover's current
> window — so it draws as a correctly-labelled but gray `Other`-colored slice. Per T31's
> standing rule this task did **not** touch `theme.css`: a fourth `--cat-*` token across
> twelve variants is **T38/T46's**, not a second hand-maintained palette here.

---

## T32b — The debt payoff projection · **Opus** — ✅ **done (2026-10-08)**

*(New, 2026-10-07 — user request from the mockup review. Additive: cuttable from the MVP
without touching another task.)* `cards-mock.html` screen 2, the collapsed
`.payoff-line` and the panel it opens.

Amortization is easy to get subtly wrong and it is the one number here that makes a claim
about the future, so it is Opus and it gets its own checker assertions.

- **Collapsed by default to a single line**: caret, *"Debt payoff projection — Apple Card
  ···· 4821"*, a dashed rule, the payoff **date**, the muted qualifier *"on your planned
  payments"*, and a `warn` chip when the charge pace means it never clears. Clicking opens
  the full panel. Per-card collapse state in `localStorage`, same as Phase 11's buckets.
  The warning belongs **on the collapsed line** — "never" is the part worth seeing without
  opening anything.
- **No explanatory prose in the panel.** The chart carries its own numbers; the two
  paragraphs an earlier draft of the mockup had were cut deliberately.
- **Three scenarios on one chart**, monthly compounding at `accounts.data.apr / 12`,
  balance → `balance + interest + charges − payment`:
  1. **At your current pace** — scheduled payments and the trailing charge rate. When it
     diverges, clip the line at `credit_limit`, mark the crossing month, and label it
     *"hits the $12,000 limit in N months — never pays off"*. Report `null`, never a
     fabricated far-future date.
  2. **If you stop charging** — scheduled payments, zero new charges. Payoff month +
     total interest.
  3. **What-if** — three sliders (monthly payment, new charges/mo, APR). **Ephemeral:
     never written to the ledger, never persisted; a reload returns to the ledger plan.**
     A `↺ reset to my ledger plan` button, no Save.
- **🚩 The charge rate is a judgment call and must be labelled, not guessed.** The payment
  side is unambiguous — future-dated `Credit Card Payment` rows are literally scheduled, so
  that line is a real plan. Charges are not scheduled (only `↻` recurring ones are).
  **Use a 3-month trailing average**, show the current window's figure beside it, and label
  the line *"at your 3-month pace"* so the number is never ambiguous about where it came
  from. Annualizing a single two-week window (`× 26/12`) is too noisy to headline.
- **🚩 Needs `accounts.data.apr` and `credit_limit`** — already in T26's column list, but
  the *values* are an open question below. Without `apr` there is no interest and the chart
  is a straight line; without `credit_limit` there is no "hits the limit in N months",
  which is the most useful thing on the screen. **Fall back to a 0% projection with the
  limit line hidden and say so on the chart** rather than guessing an APR.
- **Distinct from T35's payoff drift row.** T35 shows a per-card `debt_payoff` drift
  indicator on the Dashboard through `shared/drift.js`. This is a what-if explorer on the
  Credit subtab. They coexist and must agree where they overlap: both consume the same
  scheduled-payment series, so assert that T35's projected payoff month equals scenario 2's
  for the same card.
- Put the amortization in **`shared/cards.js`** as a pure `payoffSchedule({balance, apr,
  payment, charges, limit, months})` returning `{series, payoffMonth, totalInterest,
  limitMonth}`. No DOM, browser+Node safe, so T37 can assert it without a page.

**Done when:** `payoffSchedule` is hand-verified against an independently computed
amortization table for at least two (balance, APR, payment) triples; a divergent scenario
returns `payoffMonth: null` and a correct `limitMonth` rather than looping to a cap; the
collapsed line shows the right date and the warn chip only when warranted; sliders move
only the what-if line and write nothing; a reload restores the ledger plan; the panel
repaints on card and window change; every variant then existing verified.

### T32b status — shipped 2026-10-08: **three hand-verified tables, 104 new assertions**

**Done, with one clause of "Done when" replaced rather than met** — the T35 agreement
assertion, which as written asks for an equality that would make one of the two screens
wrong. See decision **#59** and "the T35 clause" below.

**What shipped**

- **`shared/cards.js`** gains four pure exports, all browser+Node safe and all asserted by
  `check-cards.js` section I/J:
  - **`payoffSchedule({balance, apr, payment, charges, limit, months, from, promoAprUntil,
    postPromoApr})`** → `{series, payoffMonth, totalInterest, limitMonth, payoffIndex,
    limitIndex, diverges, aprAssumed, promoUnknownFrom, hitCap, startMonth, monthlyRate}`.
    The recurrence is the specified one, `round2` at every step because an issuer rounds at
    every step. `series` carries `{monthIndex, month, balance, interest, charges, payment,
    rate}` per month, so the chart plots it directly and the checker can re-apply the
    recurrence row by row instead of trusting the final answer.
  - **`trailingChargeRate(rows, account, asOf, monthCount = 3)`** → the 🚩 judgment call,
    returned with its provenance: `{months, from, to, monthsWithRows, rate, net,
    monthCount}`. Divided by the full month count, never by the months that happened to
    have rows — dividing by 2 because one month's statement is missing *inflates* the rate
    instead of flagging it. `rate: null` (not 0) when none of the three months has a row.
  - **`scheduledPaymentRate(rows, account, asOf)`** → the payment side, which unlike the
    charge side is a real plan. Reduced to a monthly rate over the plan's **elapsed**
    months (not its months-with-a-payment) and carried forward, because this ledger's
    mirrored payments stop at 2027-07 and a schedule that pays nothing after that month
    would report "never" about a household that simply hasn't written next year down yet.
  - **`payoffScenarios({transactions, account, asOf, months})`** → scenarios 1 and 2 plus
    every figure needed to label them. Reads `cardDebtAsOf(asOf)` per decision #58.
- **`cardMeta()`** gains **`promoAprUntil` / `postPromoApr`** (`data.promo_apr_until`,
  `data.post_promo_apr`), closing decision #47's requirement. Both are unrecorded on all
  six cards today, so the live path is "0%, assumed to hold, and the panel says so" — but
  the moment the user enters them `payoffSchedule` steps the rate up on the right month
  with no code change. An end date with no post-promo rate keeps the promotional rate and
  reports `promoUnknownFrom`, because choosing between "0% forever" and "assume 25%" is
  the user's call, not this file's.
- **`local/public/paycheck.{html,js}`** — the collapsed `.payoff-line` and the panel it
  opens, built from `cards-mock.html` screen 2 and its `theme.css` tokens. The panel stays
  in the DOM while collapsed (`hidden` only) and is repainted by every `renderCredit()`,
  the same bargain csp.js's buckets make: expanding after a card or window change cannot
  reveal a stale number. Collapse state is per card in `localStorage`
  (`payoffOpen:<accountId>`, collapsed by default).
- **No explanatory prose in the panel.** The one text block under the chart is the
  *input* caveat — where the charge pace came from, that this window's own figure differs,
  that an APR is missing or promotional, that a limit is missing. Every sentence in it is
  about a number that is estimated or absent, which is the part no line on the chart can
  say for itself.

**Decisions taken while building it**

- **The limit crossing tests the END-of-month balance**, not the mid-month peak before the
  payment lands. The series plots end-of-month balances, so the marker sits exactly where
  the drawn line crosses the dashed rule rather than a month before it for a reason a
  reader cannot see.
- **A divergent schedule with a limit STOPS at the crossing** (12 rows, not 360). Past the
  crossing the issuer starts declining the charges the line assumes, so the model's own
  premise is false; continuing to draw it would dress that up as data. Without a limit it
  runs to the `months` cap and sets `hitCap`.
- **The what-if line is not drawn until a slider moves.** Its defaults *are* the ledger
  plan — that is what `↺ reset to my ledger plan` resets to — so before then it sits
  exactly underneath the "current pace" line, invisible, with a caption repeating one
  already on the chart. The scenario row says `· your ledger plan until you move a slider`.
- **Nothing owed gets one sentence, not an empty chart.** A flat $0 line under a floating
  credit-limit rule is a page pretending it has something to project (`woody-chase-card`
  is this case). Chart and sliders are hidden by a class on the panel — **not** by
  `hidden` on each, which is the bug this caught: `hidden` is an `HTMLElement` property, so
  `svgEl.hidden = true` silently assigns a JS expando and leaves the chart on the page.
- **Chart horizon** is the furthest month any scenario actually *resolves* in, floored at 6
  and capped at 60. A line that resolves in neither runs off the right edge, which reads as
  "keeps going"; stretching the axis to the 30-year cap would put the whole story in the
  first inch. Gridlines are at the 1/2/2.5/5 × 10^k step nearest a quarter of the scale, so
  a $10,500 limit reads `$0 / $2,500 / $5,000 / $7,500 / $10,500` rather than `$7,875`.
- Terminal captions get a `paint-order: stroke` halo in `--panel-2` and pick the first of
  five vertical slots whose estimated text **span** (not anchor point) clears the captions
  already placed, in priority order `pace → stop → what-if`. Without the span test a
  left-anchored caption and a right-anchored one 200px away still overprint in the middle,
  which is exactly what Citi's chart did.

**The T35 clause, and why it is not met as written**

The task asks: *"assert that T35's projected payoff month equals scenario 2's for the same
card"*, on the stated grounds that *"both consume the same scheduled-payment series"*. As
**shipped**, T35 does not: `cardPayoffDrift` measures the **trailing actual** payment
(payments already made ÷ months elapsed) and carries **no interest term at all**, while
scenario 2 uses the payments the ledger has **scheduled** and compounds at `apr/12`. On
`woody-apple-card` that is 11 months versus 14. Forcing them equal means either deleting
the interest from this panel — the whole reason the task is Opus — or re-pointing the
Dashboard's "is this card moving?" row at a plan it was deliberately not given.

So the **kernel** is asserted instead, which is the part that must not disagree: strip the
interest (`apr: 0`) and the charges, hand `payoffSchedule` and `debtPayoffResult` the same
balance and the same monthly payment, and the two implementations must name the same month.
Five pairs, including each real card's balance and rate. Recorded as decision **#59**.

**Verification**

- `npm run check:cards` — **104 new assertions, all passing**, over three hand-computed
  amortization tables (asserting *every* month's closing balance, not just the payoff
  month, since a schedule can land on the right month by two errors cancelling), four
  refusal cases, the promo-APR step, the T35 kernel agreement, and both scenarios over all
  six real cards with the charge rate and the scheduled-payment total reconciled against
  independent SQL sums.
- Headless-Chrome walk of **every variant then existing**: Apple (diverges, hits a $10,500
  limit in 1 month, warn chip on the collapsed line), Citi (0% promotional, straight lines,
  the #47 caveat on the page), Capital One (a $400 limit crossed in 2 months), Discover
  (both lines clear, no warning), Chase (nothing owed → one sentence, no chart) and — run
  before a concurrent session filled the metadata in — a card with **no APR and no limit**,
  whose note reads *"projects at 0% … the limit line is hidden for the same reason"*. The
  degraded path is now also forced in the checker with a synthetic account so it stays
  covered. Both themes verified (slate/dark, peach/light).
- Sliders: confirmed to move **only** the what-if line (`ln pace` / `ln stop` unchanged,
  `Save to ledger` still disabled, the dirty note still hidden, nothing POSTed); `↺ reset`
  restores the ledger plan and disables itself; a **reload** returns to the ledger plan
  while the collapse state survives; a **card switch** drops the sliders (they are
  denominated in that card's balance and APR); a **window change** repaints the panel —
  the payoff date correctly does *not* move, and the "this pay window alone ran $X" figure
  beside the 3-month pace does.

**Residual, non-blocking**

- `docs/` still has no `shared/cards.js`, `card-rules.js` or `recurring.js`, so the
  published copy of the Credit subtab is stale — **T36's job**, unchanged by this task
  (no new page, no new script beyond `shared/cards.js`, which T36's `shared/*.js` loop
  already copies).
- 🚩 **`check-cards.js:377` now fails**, and it is **not this task's**: it hard-asserts
  `statementBalance(...) === null` "while `statement_day` is unknown", a T27-era assertion
  that a **concurrent session invalidated by entering real statement days** (`statement_day:
  31` and `last4` appeared on the cards mid-build; two APRs moved as well). Whoever owns
  that metadata owns the assertion — it should become a conditional rather than a constant.
  Every other assertion in the file passes (2,247 of 2,248).

---

## T33 — Ledger + nav: card accounts as first-class · **Sonnet** — ✅ **done (2026-10-08)**

> **Status.** All bullets landed in `local/public/{index.html,app.js}`. **Daily Check**
> resolved to **hide it** (disabled "Check" button, tooltip explaining why) rather than
> re-point it at a statement balance: T25's audit left two of six cards `UNANCHORED` with no
> verified per-period closing balance yet (see the Phase 13 "Open" list), and a daily
> reconciliation ritual doesn't map cleanly onto a monthly statement cycle regardless. The
> **source facet cap** landed at 150, ranked by frequency with already-checked values kept
> visible past the cut and a `+N more not shown` note — Apple Card's 212 distinct merchants
> exercise it (62 omitted). Verified against real T26b data with headless-Chrome screenshots:
> optgroups, the `OWED`/`Credit −`/`Charge +` relabel, the opening-owed figure, and the
> Check-button disable all confirmed on `woody-apple-card`; everything reverts correctly on
> `woody-checking`. The `⇄ paired with …` line from the inline mockup is **not** part of this
> task — it's T34's `transfer_id` UI, out of scope until that task lands.

The Ledger already lists card accounts the moment they exist — which is the problem, since
every label on the page assumes a checking account.

- **Group `#account` with `<optgroup>`** (Checking / Credit Cards / other types) — with
  ~5 cards per person a flat list stops being scannable.
- When the selected account is a card: the running-balance column reads **"Owed"** with the
  sign flipped for display, the opening-balance label changes, and negative-balance
  highlighting (`--row-neg`) inverts — a negative balance on a card is normal, a *positive*
  one means you overpaid.
- **Daily Check**: today's "you should have $X in the bank" is meaningless on a card.
  Either hide it, or (better, and the reason this is worth doing) re-point it at
  *"you should owe $X on this card"* with the statement balance as the comparison and the
  same staged-correction flow. Decide in T25; implement whichever here.
- Deep-link `?account=<card>` already works; verify it with the new type and that the
  Category/Source facets still rebuild sensibly over card merchants (hundreds of distinct
  `source` values per card, versus a handful on checking — if the facet list becomes
  unusable, cap it and say so rather than rendering 400 checkboxes).
- **Nothing in the nav changes.** Decision #37 made cards a subtab of This Paycheck, so
  there is no fifth link to add and no `nav.js` to extract. This task is Ledger-only.
- The **Ledger's** timeframe control keeps `PRESETS` and the `3paychecks` default
  unchanged. Per decision #37, month-only granularity (`MONTH_PRESETS`) stays scoped to the
  **Spending Plan alone** — the Credit subtab shares This Paycheck's pay window and mounts
  no timeframe control at all, which is what retired decision #25's version of this.

**Done when:** switching between a checking and a card account relabels correctly with no
sign errors; bulk edit, inline edit, soft delete and Save all work on a card ledger; the
facet lists are usable at card scale; Daily Check does the agreed thing; every variant then existing verified.

---

## T34 — Paying a card: the paired-transfer flow · **Opus** — ✅ **done (2026-10-08)**

> **T25's audit adds two cases this task was not designed for (2026-10-08).**
> **(1) Card-to-card transfers** (#47): $5,862.14 of the real data is balance transfers —
> Apple → Citi $4,000.00 and Chase → Citi $1,862.14 — so a `transfer_id` must be able to
> join **two card ledgers**, not only checking-withdrawal ↔ card-deposit. No money left
> checking, so T28 must not count them as `Debt Payments`.
> **(2) An unpaired card-side deposit is valid** (#48): Apple's 2026-09 has $2,382.00 of
> card-side payments against $2,358.17 of checking withdrawals, the $23.83 gap being two
> `Apple Cash Payment` rows. The guard must stay **asymmetric** — flag an unpaired
> *checking-side* withdrawal, tolerate an unpaired *card-side* deposit — because only the
> checking side is money that left the household.
> **(3)** Pairing now covers six accounts with Rajna's three `owner: 'shared'`, and the
> `Rajna Chase` / `Rajna Discover` / `Rajna Capital One` streams are back in scope as real
> pairings (#43, #44) — five of them match the Chase file exactly.

The feature most likely to corrupt data quietly, which is why it's Opus and why it is its
own task rather than a footnote on T26.

A payment is two rows joined by `transfer_id`. Everything about that has to hold together
under edit and delete:

- Adding a `Credit Card Payment` on checking whose `source` matches a card's
  `source_aliases` offers to **mirror** a `deposit` onto that card (and the reverse from
  the card side), staged behind the normal Save so both rows commit in one transaction or
  neither does.
- **Editing** either side's amount or date offers to update its pair; **deleting** either
  offers to delete both. Declining must leave a visibly *unpaired* row rather than a
  silently half-updated pair — a $1,240 withdrawal against a $900 deposit is the exact
  failure mode T37's checker exists to catch.
- **Backfill** the existing 175 `Credit Card Payment` rows against T25(a)'s alias map:
  each gets a `transfer_id` and a mirrored card-side `deposit`. Run it as an explicit
  script with a dry-run mode and a printed before/after balance per card — not as a
  migration inside `db.js`. Note that these rows run to **2027-07**, so the backfill
  creates future-dated card deposits too; that's correct (they're projections on both
  sides) but it must be deliberate, and T29 must not later import a real statement payment
  on top of one.
- **🚩 Run after T26b, and respect `seeded_range`.** This is the phase's one hard ordering
  constraint. T26b has already put real payment rows on the card side for the months it
  loaded, so this backfill must **not** mirror a checking payment whose date falls inside
  that card's `accounts.data.seeded_range` — it must instead *pair* it to the existing
  imported row by `transfer_id`. Mirror only payments outside the seeded range. Get this
  wrong in either direction and every payment in the seeded months exists twice on the
  card, so the card's balance is off by roughly a month of payments. Under the rewritten
  #21 that does **not** double the CSP's `Debt Payments` figure — payments are read from
  the *checking* side — but it does corrupt the card's balance, its `debtChange`, and
  therefore T32b's payoff projection and T35's debt tile, all silently. Assert it: after
  the backfill, no card may
  hold two live rows with the same date and amount and no `transfer_id` between them
  (T37 assertion #3 covers the general case; this is the specific one).
- **Idempotency:** re-running the backfill pairs nothing twice.

**Done when:** a payment added from either side produces exactly two rows with one
`transfer_id` and correct opposite signs; edit/delete propagation works in both directions
and declining leaves an auditable unpaired row; the backfill is idempotent and every card's
post-backfill balance is explained; `check-cards.js` (T37) reports zero unpaired payments
afterward.

### T34 status — shipped 2026-10-08: **115 transfer groups, 238 paired rows, 24 residuals enumerated**

**Done, with the last clause of "Done when" deliberately unmet and replaced.** It asks that
the checker report **zero** unpaired payments. That is not reachable without inventing
data, which is the exact failure this task exists to prevent, so the residual is
**enumerated instead** — 24 rows, each with the reason it cannot be paired, asserted as a
closed list. See "the residual" below.

**What shipped**

- **`shared/transfers.js`** — the pairing engine, pure and zero-dep, imported by all three
  consumers so the rule cannot be re-implemented twice and disagree with itself (#51's
  principle, applied again). Holds `signed`/`magnitude`, `cardAliasIndex`/`cardForSource`,
  `transferKind`, `mirrorDraft`, `proposeMirror`, **`seededGuard`**, `transferGroups`,
  `groupNet`, `pairState` and `auditTransfers`.
- **`local/server.js`** — `GET /api/transfers` (the group index the Ledger badges from,
  plus the audit totals), `POST /api/transfers` (create/pair/update, one SQLite
  transaction), `PATCH /api/transfers/:id` (propagate a date or an amount),
  `DELETE /api/transfers/:id` (delete every end at once) and
  `DELETE /api/transfers/:id/link` (**unpair without deleting** — the verb that makes
  declining safe). `PATCH /api/transactions/:id` still refuses all three identity fields,
  so T26's rule is intact: pairing is an operation on a movement, not an edit to a row.
- **`local/public/pairing.js` + the Ledger** — the mirror offer on add, propagation on
  edit, delete-both on delete, and the ⚠/↔/· badge. Every decision is **staged**, so it
  discards with Discard like any other pending change (the explicit-save rule), and the
  dirty note names the other account because that row is on a page you are not looking at.
- **`local/backfill-transfers.js`** (`npm run backfill:transfers`) — dry run by default,
  `--card` / `--commit` / `--revert <batch>` / `--window N` / `--json` / `--audit`.
- **`npm run check:transfers`** — the invariant, read-only, runnable **today**. T34's
  "done when" defers the standing assertion to T37, which did not exist when this ran;
  leaving the invariant resting on a future file would mean shipping 238 paired rows with
  nothing checking them. T37 absorbs it by calling `auditTransfers` directly.

**Four things the real data forced that the task did not anticipate.** Each one is a wrong
card balance if missed, and none of them is loud.

1. **`transfer_id` is a GROUP KEY, not a pointer — pairing is not 1:1.** The task says "a
   payment is two rows." Four of Apple's are not: one **$888.12** checking withdrawal
   arrives on the card as **four** rows ($73.12 + $45.00 + $504.00 + $266.00), and
   $824.27, $1,443.82 and $460.00 split two ways each. So the matcher runs exact 1:1 first
   (strongest evidence), then **bounded subset-sum**, and accepts a subset **only when the
   solution is unique** — two ways to make $888.12 out of the same pile is a coin flip, and
   a coin flip here writes a wrong `transfer_id` that the checker then certifies as
   correct. What must hold is not "two rows" but **the group nets to zero**.
2. **"Mirror only payments outside the seeded range" is wrong in one direction, and
   `rajna-discover` has 7 rows in it.** Inside `seeded_range` the card-side row already
   exists, so mirroring duplicates it — the task has that. But a payment dated **before**
   the range and at or before the reconciliation anchor is **already absorbed into the
   derived `opening_balance`** (#50), so mirroring it double-counts just as badly, in the
   opposite direction. `seededGuard` therefore keys on the **anchor**
   (`data.statements.as_of`), not the range: only dates **strictly after** it are safe,
   because only those are beyond every figure T26b reconciled to the cent.
3. **A card with no anchor must never be mirrored onto.** `woody-chase-card` has no export,
   no `seeded_range` and no stated balance. Mirroring its 5 checking payments would give it
   a balance of **−$6,068.99** and drop household debt from $36,314.92 to $30,245.93 — a
   $6,069 error whose only symptom is a smaller number.
4. **The all-dates card balance is no longer a balance.** This is the biggest downstream
   consequence and the backfill now prints it in a box. The checking ledger carries planned
   **payments** to 2027-07 and the cards carry no planned **charges**, so mirroring the
   payments produces the paydown half of a projection with no spending half: household card
   debt reads **$36,314.92 as of today** and **$6,151.92 over all dates**. Both are real
   figures; only the first answers "what do we owe." **Passed to T27 and acted on** —
   `shared/cards.js` ships `cardDebtAsOf` and defaults `totalDebt`'s `asOf` to today, and
   `check-cards.js` cites this backfill by name where it explains why.

**The numbers.**

| card | claimed | paired | mirrored | skipped | unpaired | debt today | debt all-dates |
|---|---|---|---|---|---|---|---|
| `woody-apple-card` | 43 | 18 | 21 | 0 | 3 | $10,421.38 | $1,609.38 |
| `woody-citi-card` | 22 | 4 | 16 | 0 | 0 | $6,750.53 | $3,739.53 |
| `woody-chase-card` | 5 | 0 | 0 | 5 | 5 | $0.00 | $0.00 |
| `rajna-capital-one` | 20 | 8 | 8 | 0 | 3 | $173.05 | −$2,566.95 |
| `rajna-chase` | 12 | 5 | 6 | 0 | 1 | $1,875.15 | $635.15 |
| `rajna-discover` | 49 | 14 | 15 | 7 | 12 | $17,134.81 | $2,734.81 |
| **total** | **151** | **49** | **66** | **12** | **24** | **$36,354.92** | **$6,151.92** |

`$36,354.92` as of today is T26b's `$36,314.92` **plus the $40.00 Chase autopay dated
2026-10-27** — counted by T26b's all-dates replay, not yet paid by a person asking today.
`check-cards.js` asserts exactly that reconciliation, `+ 40` and all.

**The ±10-day pairing window is derived, not chosen.** The widest pairing the real data
needs is Rajna's Chase **2026-09-17 → 2026-09-27**, and #44 records that card as five-of-five
exact amount matches, so 10 is the floor that keeps all five. The first draft of the matcher
walked checking rows in date order taking the nearest free candidate; that mispaired two of
Chase's four identical $40.00 payments and matched a $750.00 Apple payment to a card row
**75 days** away. Assigning by **globally tightest gap first** reproduces #44's documented
5-of-5 exactly.

**The residual: 24 unpaired checking-side outflows, enumerated in `KNOWN_UNPAIRED`.**
Three kinds, needing three different things:

- **`no-anchor` — `woody-chase-card`, 5 rows, $6,068.99.** Nothing to pair against. **Note
  the arithmetic, because it is suggestive and it is not this task's to act on:** those five
  payments plus the one-legged Chase→Citi balance transfer of **$1,862.14** (#47) sum to
  **$7,931.13** — exactly the opening balance that would carry the card from $7,931.13 to
  the $0.00 it is stated at, with six rows accounting for the whole balance. Clean enough to
  be probably right and far too clean to assume. **Setting an opening balance is T26b's job
  and #49's kind of decision — it needs the user.** Listed under "Open" below.
- **`pre-anchor` — `rajna-discover`, 7 rows, $3,373.00**, all before its export begins and
  already inside the derived `opening_balance`. **Correct as unpaired**; needs nothing.
- **`in-window` — 12 rows across four cards** where the card side exists but disagrees. Six
  are near-misses the loader will not guess at: $750.00 vs $759.75, $779.00 vs **$779.11**,
  $856.17 vs $850.00, $303.00 vs **$303.66**, $78.00 vs $86.56. Six have no card row within
  ±10 days at all. These are the ones a human can settle in one look each, and the ⚠ badge
  in the Ledger is how they surface.

`check:transfers` fails on an unpaired outflow that is **not** on that list, and also on a
**stale** entry — a row the list still excuses that has since been paired. A list carried
forward past the thing it excused is as much a bug as a missing one.

**Two things fixed in review rather than shipped.**

- **The backfill was rewriting a user field.** The first version appended its batch id to
  each row's `note` so `--revert` could find them — which rewrote the note on **170 rows the
  user owns** and clobbered T26b's `"Citi · Cleared"`. A bookkeeping marker does not belong
  in user-editable content. The group keys are recorded on
  `accounts.data.transfer_backfill.transfer_ids` instead; the batch was reverted and
  re-run, and the restoration was verified **byte-identical against the pre-backfill
  backup** (0 notes differ, 0 `transfer_id` differ, 0 rows added or lost) rather than
  assumed.
- **The badge lied on the published site.** `/api/transfers` does not exist there
  (`docs/mock-api.js` 404s unknown routes), and without the group index `pairState` read
  every correctly-paired row as a one-row group and flagged it **⚠ unpaired** — 11 of them
  on Woody's checking page. A badge that cannot be computed must be **absent**, not wrong.
  `pairBadge` now returns `null` when the index is unavailable. Found by rendering the
  published condition in headless Chrome, not by reading the code.

**How it was verified.** 45 unit assertions over `shared/transfers.js` (both mirror
directions, card-to-card, all four `seededGuard` zones, #48's asymmetry, 1:N groups, and
that a duplicate same-day *purchase* is informational while a duplicate same-day *payment*
is the T37 #8 error); 10 live HTTP cases over the five routes, including the two refusals
(a group that would not net to zero → 409; an amount propagated across a 1:N split → 409);
**37 end-to-end assertions driving the real Ledger in headless Chrome over the DevTools
protocol** — add-with-mirror, Cancel, Save, amount and date propagation, Undo, unlink,
delete-both, the in-window refusal and the unrecognized-source no-op, with no page errors;
a revert → re-run cycle proved **content-identical** by an id-independent hash; and
`check:csp`, `check:theme`, `check:cards` (2,143 assertions) and `load:cards` all still
pass. The audit was also shown to **fail** when a pair is broken and when an unlisted row
goes unpaired — an assertion nobody has watched fail is an assertion nobody should trust.

**Note on `--window` and `--card`.** The window is a flag because the right value is a
property of the data, not of the code, and the next statement load may need a different
one. `--card` exists for the same reason T26b has it: one card at a time, read the output,
move on.

---

## T35 — Dashboard: real card debt + payoff drift · **Sonnet** — ✅ **done (2026-10-08)**

> **Status.** All four bullets landed in `shared/{dashboard-render.js,drift.js}`. The
> monthly-spend re-audit turned out to already be done — `cashRows()` scoping and the
> "excl. credit-card & transfers" chart title were committed in an earlier pass — so this
> task's real work was the tile, the comparison row and the payoff machinery.
> `shared/drift.js`'s debt_payoff math was extracted into an exported `debtPayoffResult()`
> (byte-identical behavior for the existing hand-entered path) plus a new
> `cardPayoffDrift()` that runs it per real card: balance from `cardDebtAsOf()`, actual
> monthly payment from the card's own `Credit Card Payment` deposits (not source-string
> matching). A card whose name/issuer/alias overlaps a hand-entered `debt_payoff` target's
> `sources` borrows that target's `monthly_payment`/`target_date`/one-time payments and
> **replaces** its row (`matchedPlanId`) rather than showing the same debt twice; a card
> with no such target gets "no fixed plan" and is never editable (its id is synthetic,
> `card:<accountId>`, with no `plan_targets` row to PATCH). The entered-vs-computed gap
> reuses `computeCsp`'s `netWorth.debt` summed over in-scope Spending Plans, shown only when
> at least one plan is in scope (so "nobody entered a net worth" isn't read as "entered
> zero"). Verified against real T26b/T34 data with headless-Chrome screenshots for
> Everyone/Woody/Rajna in both themes; `npm run check:csp -- --db` and `npm run
> check:theme` still pass. Per-card utilization is accurate where `credit_limit` is known
> (5 of 6 cards; `woody-chase-card` is closed with no statement). Statement day / due day /
> APR accuracy — unknown at the time this task shipped — were backfilled from real
> statements the same day (see T25's "Closed out" update); this page doesn't surface any of
> the three directly, so nothing here needed a second pass once they landed.

Today the Dashboard's debt figure comes from the CSP plan's hand-entered
`net_worth.debt`. With card ledgers it can come from the ledger.

- A **total card debt** tile from `totalDebt()`, with per-card breakdown and utilization.
- `net_worth.debt` becomes a **comparison** rather than the source: show the hand-entered
  figure beside the computed one and flag the gap, the way `shared/drift.js` flags plan vs.
  reality. Don't silently overwrite user-entered data.
- A **payoff drift row** per card through the existing `shared/drift.js` `debt_payoff`
  machinery, now fed by real balances and real payment history instead of a static target.
- **Re-audit the monthly-spend chart.** `monthlySpend` excludes `Credit Card Payment` via
  `NON_SPEND`, so card payments were never in it — but card *purchases* now are, which is
  the intended fix **and** a double count if any call site still passes the whole ledger.
  T27 produced the call-site list; this task closes it out for the Dashboard specifically
  and states the chart's scope on the chart.

**Done when:** the debt tile matches `totalDebt()` to the cent; the computed-vs-entered gap
renders; the spend chart is verified double-count-free against a hand-computed month; both
themes verified.

---

## T36 — Published read-only parity · **Sonnet**

Modeled on T6 and T13, with their hard-won failure modes:

- **No new page.** The Credit subtab lives in `paycheck.html`, which is already published,
  so the `{src, out}` page list is unchanged. The **script list still needs every new
  module** — `view-switch.js` (if not already listed from Phase 10) and any new `shared/`
  file from T27/T29/T30. A missing entry 404s an import and the page renders blank.
- `docs/mock-api.js` gains the new read routes (`/api/accounts?type=`, the parsed `data`
  field, `debt`) with response shapes **identical** to the server's. The shim must still be
  injected ahead of the **first** module script (the T22 fix) or `settings.js` escapes it.
- **T30 added two more write surfaces to the same subtab** (recorded here 2026-10-08, so
  this task doesn't have to rediscover them). The *Merchant rules* panel has its own
  **Save rules** button plus inline edit/delete/add, an **Apply to this window** button
  that stages ledger edits, and a "learn this rule?" offer that fires when a category is
  corrected; the *Looks recurring* panel has **Project forward** and a *delete N past-due
  projections* action. All of them write through `/api/plan-targets` and
  `/api/transactions`, so on the published page they hit `mock-api.js`'s in-memory store
  and are discarded — the same bargain as the uploader below, and the same answer:
  disable, with a read-only tooltip. The two panels are **worth showing read-only**
  (the rule set explains why a card's donut reads the way it does), so prefer disabling
  the controls over hiding the panels. `mock-api.js` already answers
  `GET /api/plan-targets?kind=` correctly, and `loadRules()` degrades to an empty rule set
  rather than throwing if it ever stops doing so. Also: the script list now needs
  **`shared/recurring.js`** and **`shared/card-rules.js`** — both are copied wholesale by
  the existing `shared/*.js` loop, so nothing to add, but a `docs/shared` that is ever
  hand-curated must include them.
- 🚩 **`shared/csp.js` now imports `shared/cards.js`** (T32, 2026-10-08 — card coverage is
  computed once, in cards.js, and called from csp.js rather than written twice). The trap
  this sets is not on the Credit subtab, which needs `cards.js` anyway: it is that
  publishing the new `shared/csp.js` **without** `shared/cards.js` blanks the **Spending
  Plan**, a page that has nothing to do with this phase. `docs/shared/csp.js` is still the
  pre-T28 334-line version, so this has not bitten yet. If the copy step is the wholesale
  `shared/*.js` loop, nothing to do; if it is ever hand-curated, `cards.js` is not optional.
- **Writes are read-only, and the uploader is the sharp edge**: the published page must
  hide or disable the upload button entirely. A reader who imports a statement into an
  in-memory store that is then discarded has done real work for nothing and will reasonably
  believe it saved. An explicit disabled state with a "read-only" tooltip, not a silently
  no-op modal.
- **The `[ Debit | Credit ]` switch on the published page.** Decide and implement one of
  two: show it (Credit is read-only like everything else, and the donut + debt figures are
  worth publishing) or hide it via `mountViewSwitch`'s existing `views.length < 2` guard —
  the same hook T6 used to drop the Plan switch from the published site. Default to
  **showing it**, since the data is already in the snapshot and a read-only card view is
  the same bargain every other published page makes. T32b's sliders are ephemeral by
  construction, so they are safe read-only; the **upload button is not** and must be
  disabled per the bullet above.

**Done when:** every published page loads with no console errors; the published Credit
subtab shows the same numbers as the local one for the same pay window; the uploader is
visibly disabled; Save/Publish/Refresh stay hidden; every variant then existing verified on
all published pages. **The full twelve-variant walk is Phase 14's T46, which absorbs this
task** (prologue) — do not re-walk it here.

---

## T37 — `local/check-cards.js` + docs · **Sonnet** — ✅ **done (2026-10-08)**

The checker is the deliverable. `check-csp.js` is the model, including its `--db` mode.

Assertions, each the inverse of a bug this phase can introduce:
1. `sum(cardDebt) === totalDebt` for every owner scope.
2. `netPurchases − payments === debtChange` **and**
   `openingOwed + debtChange === closingOwed` per card per window, where `netPurchases` is
   charges minus refunds — the two identities T32 prints on screen.
3. Every `Credit Card Payment` row has a `transfer_id` **and** a live counterpart with the
   opposite sign and an equal amount — **zero unpaired, zero mismatched** (catches T34).
4. Every `external_id` is unique per account (catches T29's dedupe).
5. T28's new CSP identity: `bucketTotal + excluded === cashOutflow + cardPurchases`,
   re-derived independently rather than by calling `computeCsp`. Note this identity
   **permits** the same economic dollar in two buckets (a purchase and the payment that
   covers it) — that is decision #21, so do **not** also assert "no dollar counted twice";
   assert instead that every card purchase appears in exactly one bucket and every payment
   in exactly one.
5b. Decision #38's coloring, as a table beside the existing `statusFor` cases: a `fund`
   item at 110% of target → `good`, 100% → `even`, 90% → `warn`, 70% → `bad`, and the same
   item with no `data.direction` → the bucket's `spend` answer, proving the override is
   opt-in. Plus: a bucket containing a direction-overriding item rolls up on
   `worstStatus()`.
5c. ~~T32b's `payoffSchedule` against a hand-computed amortization table; a divergent
   scenario returns `payoffMonth: null` with a correct `limitMonth`; and T35's projected
   payoff month equals scenario 2's for the same card.~~ **Delivered by T32b, 2026-10-08**
   — `check-cards.js` sections **I** and **J**, 104 assertions: three hand-computed tables
   asserted month by month (not just at the payoff month), four refusal cases, the
   promotional-APR step, both scenarios over all six real cards with the charge rate and
   the scheduled-payment total reconciled against independent SQL sums, and the degraded
   no-APR/no-limit path forced through a synthetic account. The **T35 equality is replaced
   by a kernel-agreement assertion** — see decision **#59** for why the live figures
   should not match.
6. Each card's computed balance reconciles to **every** statement period's stated closing
   balance, not just the latest — the full ladder from T26b, re-asserted. The stated
   closing balances must therefore be recorded as data (`accounts.data.statements: [{period,
   closing_balance}]`) rather than living only in T26b's console output, or this assertion
   cannot exist after the staged files are deleted.
7. Re-parsing a fixture CSV yields 0 inserts (idempotency). **The fixture must be
   synthetic** — hand-written to match each issuer's recorded header signature, with
   invented merchants and amounts. The real statements are seed data staged outside the
   repo and deleted (decision #27); committing one as a test fixture would publish real
   card activity to a public repo's permanent history, which is exactly the trade-off the
   project accepted for *aggregate* numbers and never for line-by-line merchant history.
8. No card holds two live rows with the same date and amount lacking a `transfer_id`
   between them — the specific T26b/T34 double-mirror failure.
9. *(added by T32, 2026-10-08)* `cardCoverage()` moved out of `computeCsp` into
   `shared/cards.js` and is now the only implementation, so assert it where both callers
   can be wrong at once: for a window **past a card's `seeded_range`**, `covered === total`
   (T34's mirrored payments give every future month a row) **while** no imported statement
   exists — the pair that proves why the Credit subtab reads `seeded_range` as well as the
   month report, and why "1 of 1 month covered" is not the same claim as "we have data".
   Also assert `computeCsp(...).cardCoverage` is unchanged from the inlined version's
   output over the real ledger, since `check:csp` only covers it indirectly.

Then docs: a Phase 13 roadmap entry in `ROADMAP.md`, the `accounts.data` / `card_rule` /
`transfer_id` / `external_id` shapes in its data-model section, README's repo layout and
"what the dashboard needs to do", `package.json` (`check:cards`, `seed:cards`), and the
"what shipped" + resolved-decisions sections in this file.

**Done when:** `npm run check:cards -- --db` passes clean; `npm run check:csp -- --db` and
`npm run check:theme` still pass; docs describe what was built rather than what was planned.

### What shipped

Four of the nine assertions already existed by the time this task started — not written
here, but worth naming so the checker's actual scope is clear: **#1/#2** (`cardDebt`/
`totalDebt` and the two on-screen identities) were T27's own section A/B/C; **#5/#5b** (the
CSP identity re-derived independently, and decision #38's coloring table) live in
`local/check-csp.js`, which already asserted them; **#5c** (T32b's `payoffSchedule`/
`payoffScenarios`) shipped with T32b as sections I/J, 104 assertions. This task added the
remaining five, each as its own section in `local/check-cards.js`:

- **Section K — transfer pairing (#3, #8).** Calls `auditTransfers` straight from
  `shared/transfers.js` — the identical function the Ledger's badges and `check:transfers`
  use — and asserts zero mismatched groups, zero alias collisions, zero same-date/amount
  unlinked payment pairs on one card (#8, the T26b+T34 double-mirror failure), and that
  every unpaired checking-side outflow is one of the enumerated, explained exceptions (#3).
  **`KNOWN_UNPAIRED` moved out of `local/backfill-transfers.js` into `shared/transfers.js`**
  (with its two matchers, `unexpectedUnpaired`/`staleKnownUnpaired`), so `check:transfers`
  and this section assert against the literal same list and the literal same ±0.5¢
  tolerance rather than two copies that could drift one entry at a time. `check:transfers`
  re-verified afterward — still 21 enumerated exceptions, still clean.
- **Section L — `external_id` uniqueness per account (#4).** A `GROUP BY account_id,
  external_id HAVING COUNT(*) > 1` straight against the live DB — catches T29's dedupe at
  the one layer `check-import.js`'s in-memory fixture tests can't reach. 923 fingerprinted
  rows, 0 collisions today.
- **Section M — the statement-period ladder (#6).** Iterates every card's
  `accounts.data.statements.periods` and asserts `cardDebtAsOf` at each `closing_date`
  equals the stated `closing_balance` to the cent. Five of six cards still have an empty
  `periods` array (#45 — the user hasn't supplied their per-period balances yet), which
  this section reports as an explicit "waiting" line rather than a vacuous pass dressed up
  as a check; `woody-chase-card` has two real issuer-stated periods (from the statement PDF
  T26b loaded) and both reconcile exactly. The assertion exists now and will bite the
  moment the other five arrive.
- **Section N — `cardCoverage`'s `seeded_range` semantics (#9).** For each card, the first
  checking-mirrored payment row dated past its `seeded_range` defines a single-month
  window; asserts that month reads fully covered by `cardCoverage` while no statement period
  backs it — the concrete case of "1 of 1 month covered is not the same claim as we have
  data." (Tried a wider window first — the full span between a card's first and last
  mirrored row — and it failed on two cards whose payment cadence skips a calendar month;
  that's correct behavior, not a bug, so the assertion was narrowed to the one month a row
  actually proves rather than an assumed-dense span.) Also confirms `shared/csp.js` imports
  `cardCoverage` from `shared/cards.js` directly, so there is no second implementation left
  to drift from `check:csp`'s figures.

**#7 (fixture-reparse idempotency) was deliberately not duplicated here.**
`local/check-import.js` already asserts it per issuer with hand-written synthetic fixtures
(sign-flip detection, 0-inserts on re-parse, external_id uniqueness within a file) — T29's
own "done when." Re-implementing the same fixtures in `check-cards.js` would be two copies
of one test. `npm run check:import` re-verified clean; it, along with `check:bulk` and
`check:rules`, is not in this task's own "done when" but was run as a regression pass since
this task's edits touched a module (`shared/transfers.js`) those checkers' graphs run
through.

**Docs.** `ROADMAP.md`'s **Repo layout** was still the Phase 0 tree (no `shared/cards.js`,
no `local/check-*.js`, no `local/public/paycheck.js`) — rewritten to the current structure.
**Data model** gained three entries after the existing `transfer_id` one:
`transactions.external_id`/`import_batch`/`projected`, the full `accounts.data` shape
(`issuer`/`apr`/`credit_limit`/`seeded_range`/`statements`), and `card_rule`'s shape and
match precedence. The Phase 13 roadmap entry and its six amendments were already current
(T25/T30/T32b/T34 each updated it as they landed); README's **Using the app** already
described the Credit subtab, merchant rules and recurring detection in full (from T31/T33/
T30) — no changes needed there. `package.json`'s `check:cards`/`seed:cards` were already
registered.

**Left for whoever picks up T36 next:** this task's "done when" never required T36, and it
is not marked done in this file — its section has no "what shipped," and this task did not
investigate it further. What this task *did* observe in passing: `shared/cards.js` and
`shared/csp.js` already match their `docs/shared/` copies byte-for-byte, so a publish ran
at some point after both existed; `shared/transfers.js` does **not** match its `docs/`
copy yet, which is expected — this task's edit to it (the `KNOWN_UNPAIRED` move) hasn't
been through a publish. Worth a fresh look before calling Phase 13 fully shipped.

---

## Resolved decisions — Phase 13

Numbering continues from #20 (Phase 12b). **#21 needs the user's sign-off before T28
starts** — it is the one decision that changes numbers T0 verified to the cent.

21. **Card purchases count at their own category; the full payment counts as
    `Debt Payments`; nothing is excluded.** *(Rewritten 2026-10-07 at the user's direction.
    This replaces the "paydown split" this decision originally proposed — see "Rejected"
    below, which now includes the first draft of #21 itself.)*
    Per the user: **the money covering debts leaves checking no matter what you do with the
    card**, so the CSP must count it in full. Separately, what the card actually *bought*
    is the valuable thing the ledger never had — groceries, subscriptions, guilt-free
    spending. Tracking real *paydown* is the **Credit subtab's** job, not the CSP's. Per
    card, per window:

    ```
    purchases    = card-ledger withdrawals in window, net of refunds per category
                   (count in buckets, by their own category)
    payments     = checking-side Credit Card Payment rows in window
                   (count in full, in Debt Payments — not split, not excluded)
    excluded     = unchanged: Adjustment / Negative Balance reconciliation noise only
    ```
    The CSP reconciliation identity becomes
    **`bucketTotal + excluded === cashOutflow + cardPurchases`** — still exact, still
    assertable (T37 #5). Read it as *commitments = cash that left + debt newly taken on*.
    **Known consequence, accepted deliberately:** one economic dollar can appear twice —
    $100 of groceries charged counts in `Groceries`, and the $100 later sent to the card
    counts in `Debt Payments`. So bucket percentages are a share of **commitments, not of
    take-home, and can exceed 100%** in a heavy-charge month. T28 relabels the column
    *"% of commitments"* when `cardPurchases > 0`. Whether charging outran paying is
    answered on the Credit subtab, with a date (T32b), which is the whole reason that
    screen exists.
    **What this buys:** Woody's `Debt Payments` ($2,000/mo) and Rajna's ($500/mo) keep
    their original meaning, so **no target needs restating** — and `Groceries` still moves
    $420 → $496.20 because the card data arrived, which was always the real prize.
    **Rejected alternatives:** *(a)* ~~the paydown split~~ — this decision's own first
    draft: `paydown = max(0, payments − purchases)` with the remainder excluded as a
    transfer. Rejected by the user: it turned a $2,000/mo target into a $103/mo actual by
    measuring something the user never budgeted for, and it painted the phase's most
    consequential line as a 95% underspend. *(b)* exclude payments outright — loses the
    `Debt Payments` line entirely and under-reports any month with no imported card data as
    though nothing was spent; *(c)* a cash-flow CSP plus a parallel "incl. card spend"
    overlay column — puts two competing actuals on every line, the double-signal Phase 11
    spent four tasks removing.
22. **Debt is a negative balance; the sign flips only for display.** `opening_balance` is
    negative, a purchase is a `withdrawal`, a payment or refund is a `deposit`, and
    `debt = -balance`. `withRunningBalance()`, `accountLedger()`, `accountBalance()` and
    `totals()` then work on cards with **no change at all**. The flip lives in
    `shared/cards.js`'s `cardDebt()` and in the display layer (T31/T33) — nowhere else.
    A credit balance reports as negative debt rather than being clamped to zero, so the
    household total stays correct.
23. **Single-entry stays; a payment is two rows joined by `transfer_id`.** No journal
    table, no double-entry engine. The pairing is what makes #21 computable and what T37's
    assertion #3 polices. An unpaired payment is a *visible* data problem, never a silent
    one.
24. **The Credit subtab is owner-scoped, per-card within that scope.** The dropdown lists
    `type === 'credit_card'` accounts where `owner === currentUser || owner === 'shared'`,
    reusing the Ledger's existing filter and honoring the personal-scope precedent of
    resolved decision #3. A jointly held card is an `owner: 'shared'` row, visible to both
    people; that is the only way one card appears in two people's views.
25. ~~**The Cards tab uses whole-calendar-month presets (`MONTH_PRESETS`), not statement
    cycles — in v1.**~~ **SUPERSEDED BY #37 (2026-10-07).** The reasoning held while cards
    were a separate tab needing *some* window control: consistency with the Spending Plan
    over statement fidelity, since a statement cycle is per-card and cross-card totals over
    "the last statement" would compare different date ranges. Making cards a **subtab of
    This Paycheck** removed the premise — the Credit subtab now shares the pay-period
    window and mounts **no timeframe control at all**. What survives: `statementCycle()` is
    still built in T27 (the current-statement-balance figure and T37's reconciliation need
    it), `MONTH_PRESETS` stays scoped to the **Spending Plan alone**, and the **Ledger keeps
    `PRESETS` and its `3paychecks` default**, exactly as decision #11 left it.
26. **The uploaded file never reaches disk, by architecture.** Parsing happens
    **client-side** in `shared/statement-import.js`; only parsed rows are POSTed, to
    `/api/transactions/bulk`. There is no file-accepting endpoint, no `multipart`, no temp
    path, and no new `.gitignore` entry — because there is nothing to ignore. Cancelling
    the review modal leaves nothing behind, and `git status` is clean after an import.
    **Scope clarified by #27:** this governs the *ongoing upload path* — the one a file
    could plausibly leak through twice a month for years. The one-time T26b load is not an
    exception to it but a different mechanism entirely: a hand-run script reading an
    absolute path **outside** the repo, which ends with the source files deleted.
27. **The statements are seed data as well as spec — and bootstrapping does NOT go through
    the uploader** *(user request + clarification, 2026-10-06)*. Several months per card are
    supplied up front, serving three purposes: *(i)* **the adapter spec** — real headers and
    sign conventions transcribed rather than guessed; *(ii)* **the ledgers' real starting
    data**, so the Cards tab is useful the day it ships instead of after months of
    accumulation; and *(iii)* **the training corpus** for T30's merchant rules, and the only
    data that makes recurring detection testable at all, since its premise is ≥3 consecutive
    months of a merchant.
    **The load is a direct SQLite write (T26b), run by hand, parsed however is expedient —
    deliberately not the app's uploader.** The uploader is a real feature that gets built
    and tested on its own (T29/T30); it is simply not the bootstrap mechanism. Three things
    follow, and they are the reason this is the better plan rather than merely the easier
    one: the **data stops blocking on the code** (T27/T28/T31/T32 are built against real
    rows from their first commit); **T29 becomes properly testable**, because hand-loading
    first yields a *known-good* answer to diff the uploader against — zero fresh rows on an
    already-loaded month — instead of the ambiguity of bootstrapping with an unverified
    parser; and the **`external_id` formula moves forward into T26b** for T29 to adopt
    verbatim, which is what keeps the two paths comparable at all.
    Handling rules: staged **outside the repo** (not a gitignored path inside it — nothing
    load-bearing should rest on an ignore rule); **never committed**, including as a test
    fixture (T37's are synthetic); deleted once T26b's period-by-period reconciliation
    passes; and each statement's **closing balance persisted into `accounts.data`** before
    deletion, since that is the only thing keeping T37's reconciliation assertable
    afterward. That ladder of N closing-balance checks per card is the real prize: it
    independently proves each sign convention, date-column choice and completeness, where
    one sample file proves only that a parser ran.

*(#37–#40 were decided after Phase 14 was planned, which is why they continue from #36
rather than from #27. Decision numbers are global and in chronological order; #28–#36
belong to Phase 14.)*

37. **Cards are a subtab of *This Paycheck*, sharing its pay window — not a fifth
    top-level tab.** *(User request, 2026-10-07.)* `paycheck.html` gains a
    `[ Debit | Credit ]` switch; Debit is today's page unchanged. Three things follow, and
    they are why this is better rather than merely different:
    - **One window, not two.** Both subtabs read the same `windowFor(cadence, anchor, …)`
      state and the same `‹ ›` arrows, so switching to Credit keeps you on the pay period
      you were already looking at. That retires #25's `MONTH_PRESETS` control and removes a
      timeframe the user would otherwise have to reconcile against the one beside it.
    - **No new component and no new page.** The switch is a second caller of the existing
      **`view-switch.js`** (built in Phase 10 for *Plan targets | Spending Plan*), and the
      recur modal, `generateRecurring()` and `defaultUntil()` are **already in scope**
      because both subtabs share the page — so the add-expense flow needs no extraction.
      It also deletes the `nav.js` extraction the first draft of T31 called for, since there
      is no fifth nav link.
    - **The pairing is the point.** Debit answers *"where is this paycheck going"* and
      Credit answers *"what did the card buy, and is the debt moving"* over the same two
      weeks. They were always two halves of one question.
    **Cost:** two separate staged-edit sets in one page, so switching subtabs with unsaved
    changes must warn (reuse the Ledger's `#account` confirm pattern). **Also:** a person
    with zero cards gets no Credit half at all, rather than a dead tab.
38. **`Debt Payments` has its own coloring rule — under target is bad.** *(User
    correction, 2026-10-07, reversing a claim made during the mockup review.)*
    `actual > target` → **green**; `0.8 × target < actual ≤ target` → **yellow**;
    `actual ≤ 0.8 × target` → **red**; `actual === target` → **gray**. At $1,793.33 against
    $2,000 (89.7%) the row reads yellow.
    This is `statusFor()`'s existing **`fund`** direction with **two deviations**, and both
    are real work rather than a flag flip:
    - **Thresholds differ.** The shared `fund` band is `FUND_GOOD = 0.95 / FUND_WARN = 0.75`;
      this rule is `1.0 / 0.8` — stricter at both ends. At 96% of target the shared band
      says green and this rule says yellow. So an item needs an optional **threshold pair**
      (`data.good_at` / `data.warn_at`), not just an optional `data.direction`.
    - **Gray is a fourth status.** `statusFor()` returns only `good`/`warn`/`bad` and
      `csp.html` styles exactly those three, so `even` + `.delta.even` are new. It will
      almost never fire on a 3-month monthly average — see "Open" for the tolerance
      question.
    **Knock-on:** a bucket containing a direction-overriding item must roll up on
    **`worstStatus()`** of its items rather than its own ratio, or Fixed Costs reads green
    at 96.9% of target while its most consequential item reads yellow. `worstStatus` is
    already exported from `shared/csp.js` for exactly this.
    **Superseded:** the mockup review briefly concluded that a green delta was correct here
    and withdrew the per-item override. That was backwards and is recorded only so the
    reversal is traceable.
39. **No category/merchant rollup on the Credit subtab.** *(User request, 2026-10-07.)*
    The donut already answers *"where did it go"* by category and the ledger already lists
    every merchant with its amount, so an expanding category→merchant table was a third
    view of the same rows — weight without an answer. Deleted outright, not demoted below
    the ledger as an intermediate draft had it. **What goes with it:** T32's per-merchant
    drill-down and the per-merchant `?source=` deep-links. **What survives:** one
    `?category=` + `?account=` "View in Ledger" link per donut legend row, which is where
    the drill-down's actual value was.
40. **The payoff projection is collapsed by default, and its what-ifs are ephemeral.**
    *(User request, 2026-10-07.)* Closed, it is one line: title, payoff date, and a `warn`
    chip when the charge pace means it never clears. The warning lives **on the collapsed
    line** because "never" is the part worth seeing without opening anything. Open, it is
    three scenarios and three sliders. The sliders write nothing — not to the ledger, not
    to `localStorage` — so a reload returns to the ledger plan; only the collapse state
    persists. **Rejected:** savable scenarios. A saved what-if is a second plan competing
    with the ledger for authority, and the ledger is the plan.
41. **There is exactly one Discover card — Rajna's. The other two `Discover` sources are
    person-to-person transfers, not cards.** *(User answer, 2026-10-07.)* The three source
    strings T25 flagged resolve to **one** `credit_card` account plus two transfer streams:

    | source | ledger | what it is | n | outflow |
    |---|---|---|---|---|
    | `Discover` | **Rajna** | Rajna paying her own Discover — **the card** | 23 | $8,362.10 |
    | `Rajna Discover` | **Woody** | Woody sending Rajna money toward that card | 26 | $14,898.00 |
    | `Woody Discover` | **Rajna** | the mirror — money moving between the two people | 22 | $300.00 |

    `Discover` → Rajna's card is the **one** Discover entry in the `source → account_id`
    map. The two transfer streams needed excluding from T34's pairing and T37's assertion
    #3 — which demand a `transfer_id` and a live card counterpart for *every*
    `Credit Card Payment` row — but that exclusion list **no longer exists**: it was
    superseded hours later by **#42**, which purifies the category instead of enumerating
    exceptions to it.

    **Two things measured while confirming this, both since acted on by #42:**

    1. **The `Zelle` reclass is incomplete, and it did not move the money.** Only **3 of
       22** `Woody Discover` rows carry `description = "Zelle"` — and all three are
       *deposits* ($600 in, $0 out). The other **19 still read `Credit Card Payment`**, and
       they are the rows holding the **$300 of outflow** that lands in Rajna's
       `Debt Payments` actual (her item matches category `Credit Card Payment`). Because CSP
       actuals are outflow-only (`withdrawal > 0`), the reclass changed **no number on the
       page**. Finishing it on the remaining 19 rows is what actually takes the transfer out
       of her debt line — worth ~$25/mo against her $571.84 trailing-12mo actual on a $500
       target. Once moved, the $300 has no matching item and would surface as `Unassigned`
       in her catch-all bucket; a `Zelle`/assistance item is the alternative, mirroring
       Woody's `Rajna Assistance Program`.
    2. **Woody's side is correct only by match precedence.** `Rajna Discover` stays out of
       his `Debt Payments` (category `Credit Card Payment`) *solely* because decision #7
       ranks `sources` above `categories` and his `Rajna Assistance Program` names the
       source. It is **89%** of that line — $14,898 of $16,815. Also worth knowing:
       **$10,900 of it is 2027-dated**, so the same line reads **$179.58/mo** over trailing
       12 months against a $240 target but **$465.28/mo** all-time. Nothing is broken; the
       line is simply dominated by projected rows, which is a drill-down reading the
       Spending Plan already supports.
42. **`Credit Card Payment` is now a pure predicate: money toward a card you hold.
    Inter-person money lives in a new `Partner Transfer` category.** *(User decision +
    executed 2026-10-07.)* #41 resolved what the Discover sources *were* but left T34/T37
    policing a category that was **29% impure** on Woody's ledger — $16,808 of its $58,132
    was money servicing Rajna's debt, not his. The fix is the category, not an exception
    list, because an exception list rots: the first `Rajna Citi` breaks T37's assertion #3
    and invites a sixth name instead of a fix.

    **Executed — 60 rows re-categorized, `description` only, no `source` renamed:**
    `Rajna Discover` (26), `Rajna Chase` (12), `Rajna` (2), `Rajna Capital One` (1) on
    Woody's ledger and `Woody Discover` (19) on Rajna's → `Partner Transfer`, with
    `updated_at` stamped **now** so the change *wins* the LWW merge against the published
    snapshot and the other person's copy (the inverse of the seed convention, deliberately).

    **What it bought, each verified rather than asserted:**
    - **T37's assertion #3 needs no exclusion list** and `CSP_EXCLUDE` is untouched. What
      remains under `Credit Card Payment` is **exactly the cards**: `Apple Card`,
      `Capital One`, `Chase Card`, `Citi Card` (Woody) and `Discover` (Rajna).
    - **The card inventory stopped being a decision and became *derived*** — five cards,
      read off the category rather than negotiated. T25's inventory question closes by
      construction, as do the `$400 Rajna` row and `Rajna Capital One`.
    - **Exactly two numbers moved, both Rajna's**, diffed before/after against a
      `VACUUM INTO` backup over three windows: `Debt Payments` $571.84 → **$546.84** and
      the catch-all's `Unassigned` $340.74 → **$365.74** (trailing 12mo); $383.77 →
      $370.48 and $224.30 → $237.59 (all time); **zero changes** at last-3-months. The
      same $25 crossing between two lines — nothing created, nothing lost. **Woody's
      figures are unchanged**, because decision #7's source-beats-category precedence had
      already kept those rows out of his `Debt Payments`.
    - `npm run check:csp -- --db` **passes clean**, reconciliation identity included
      (200 rows matched exactly once, one catch-all, 30 unassigned groups).

    **Deliberately NOT done, because it changes numbers and wants its own sign-off:**
    rewiring Woody's `Rajna Assistance Program` from its **5 hardcoded source strings** to
    the single category `Partner Transfer`. That is the item's natural home now and would
    stop it silently dropping a future payee — its rule set is *already* drifting, since it
    lists `Rajna Affirm`, which is filed as `Loan Payment`. But a category-**only** rule
    would **release `Rajna Affirm` ($1,780.50 out / $1,800.00 in) into `Debt Payments`**, so
    the correct edit is `categories: ["Partner Transfer"]` *plus* keeping the `Rajna Affirm`
    source — or re-categorizing that loan too. Left for the user.

    **Also still open:** `Vacation Apple Card` — one row, 2026-08-05, **$324.57 deposit**,
    empty note, identical in shape to `Rajna Capital One` on the same day. A card payment
    never arrives as a *deposit* into checking, so it is a statement credit, **not a second
    Apple Card**. Recommendation standing: fold its `source` into `Apple Card` so it reads
    as a credit against net payments. It is the only row left under `Credit Card Payment`
    that is not a payment.

    **Not folded in, per the user:** the pre-existing inflow-only `Zelle` rows (Rajna 17 /
    $1,038.67 in, Woody 2 / $415.00 in) are money from **other people**, not each other, so
    `Zelle` keeps its own meaning and was left untouched.

43. **The card inventory is six accounts, owned 2 Woody / 4 Rajna — and the statements
    overrule decision #42's derived inventory.** *(T25 audit, 2026-10-08.)* #42 derived the
    inventory by purifying the `Credit Card Payment` category, which was sound method on the
    evidence it had; the statements are better evidence and they disagree on two points.
    `Woody Apple` + `Woody Citi` + `Woody Chase Card` (closed) are Woody's;
    `Rajna Capital One` + `Rajna Chase` + `Rajna Discover` are Rajna's. `Card_Totals.csv`,
    written by the user, agrees with the statements. See the T25 findings table for the
    match rates — the `Capital One` call rests on **eight exact amount matches** and the
    `Rajna Chase` call on **five of five**. **What this does not do is change any CSP
    number** — see #44, which is the part that needs sign-off.
44. **`Credit Card Payment` means *money toward a card in the household inventory*, not
    *a card you personally hold* — so `Rajna Chase` / `Rajna Discover` / `Rajna Capital One`
    come back out of `Partner Transfer`.** ✅ **Signed off by the user 2026-10-08.** #42 purified the category on the predicate *"money toward a card you
    hold,"* reasoning that the `Rajna *` streams had *"no counterpart to pair, nothing to
    backfill on her ledger, and no sixth account."* All three clauses are false given the
    staged statements. Keeping #42's predicate now costs:
    - **five provable transfer pairings thrown away** (`Rajna Chase` 5/5 exact matches),
      which is the opposite of what T34 and T37 assertion #3 exist to do;
    - **an inconsistency with no principle behind it** — `Capital One` (Rajna's card, paid
      by Woody) stays in Woody's `Debt Payments` while `Rajna Chase` (Rajna's card, paid by
      Woody) does not, purely because of how the source string happens to be spelled.
    The predicate that fits the data: **a `Credit Card Payment` is a checking withdrawal
    that mirrors onto a card ledger in the inventory, whoever owns the card.** Inter-person
    money with no card behind it (`Rajna` $400 × 2 rows; `Woody Discover` on Rajna's ledger)
    stays `Partner Transfer`, so the category is still pure — it is the *predicate* that was
    slightly wrong, not the cleanup.
    **Mechanism, so nothing moves twice:** Rajna's three cards become **`owner: 'shared'`**
    (decision #24's existing mechanism, and the first use of it), because both people service
    them. They then appear on both Credit subtabs, which is the honest picture.
    **Cost, stated before it is paid:** this reverses part of #42's executed re-categorization
    — **39 rows** (`Rajna Discover` 26, `Rajna Chase` 12, `Rajna Capital One` 1) back to
    `Credit Card Payment` — and it **re-adds $16,408 to Woody's `Debt Payments`** category
    membership. #42's own measurement says the page impact is nil: decision #7's
    source-beats-category precedence keeps those rows in `Rajna Assistance Program`
    regardless, which is why #42 moved $0 of Woody's numbers. **That prediction is a
    prediction, not a measurement of this change — T26 must diff before/after across all
    three windows (`VACUUM INTO` backup first, as #42 did) and stop if anything but zero
    moves.** The 21 rows that stay `Partner Transfer` are the genuinely person-to-person
    ones.
45. **No reconciliation ladder — one aggregate check per card, and that is a known
    downgrade.** *(T25 audit, 2026-10-08.)* `Card_Totals.csv` states one *current* balance
    per card and no transaction export carries a running balance, so T26b's
    *"N closing-balance checks per card"* is not constructible. What replaces it: replay
    every row from the derived opening and land on the stated current balance to the cent —
    **one** check per card. It still proves the sign convention, the date-column choice and
    aggregate completeness; it **cannot localize a miss to a month**, which was the ladder's
    purpose. Two openings are independently corroborated (**Citi at exactly $0.00** — the
    file is the card's complete history; **Capital One at $337.90** — matched by both its own
    first payment row and the ledger's), three are not. T37 assertion #6 is written against
    the current balance persisted into `accounts.data`, not a per-period ladder. **Recoverable
    at any time** by exporting the per-period closing balances, which exist on the issuers'
    sites — see "Open".
    **Update 2026-10-08: the user is collecting them**, so the ladder is expected to be
    constructible after all and T26b should be written to consume it. Until they land,
    T26b's single aggregate check is the floor, not the plan. **Chase is exempt and
    needs no ladder** — see #49.
46. **`external_id` keys on the *transaction* date, never the post/clearing date.**
    *(T25 audit, 2026-10-08 — pulled forward from T26b, binding on T29 verbatim.)* Three of
    the five exports carry a second date (Apple `Clearing Date`, Capital One `Posted Date`,
    Discover `Post Date`) and two carry a mutable status (Citi `Status` = `Cleared`, Chase
    `Status` = `Completed`/`Pending`). Chase's export already contains a **future-dated
    `Pending` row** (2026-10-27). A pending row re-exported later as completed keeps its
    transaction date and may move its post date, so keying on the post date duplicates it on
    the next upload and breaks T26b's known-good diff test outright. Transaction date is the
    stable component. Also: **filter payments on the issuer's type/description, not on the
    sign** — Apple's refunds are negative rows that are not payments (`Type === 'Credit'`).
47. **Balance transfers are card-to-card and are not `Debt Payments`.** *(T25 audit,
    2026-10-08.)* The data contains $5,862.14 of them: Apple → Citi $4,000.00 (2026-05-12)
    and Chase → Citi $1,862.14 (2026-05-05), plus a $175.86 transfer fee. **No money left
    checking**, so T28 must not count them as `Debt Payments` — doing so would invent
    $5,862.14 of spending that never happened. They are a `transfer_id` pair between **two
    card ledgers**, which T34 was not designed for (it assumes checking-withdrawal ↔
    card-deposit) and must be extended to accept. Related and not cosmetic: **Citi's 0% APR
    is promotional** — a 0% rate on a 99.3%-utilized card is a teaser, `MEMBERSHIP FEE MAY
    26-APR 27` dates the year, and T32b projecting 0% forever would promise a payoff that
    does not exist. T32b needs an optional `data.promo_apr_until`.
48. **A card-side payment with no checking counterpart is valid data, not an error.**
    *(T25 audit, 2026-10-08.)* Apple's 2026-09 shows $2,382.00 of card-side payments against
    $2,358.17 of checking withdrawals; the $23.83 gap is two `Apple Cash Payment` rows paid
    from Apple Cash. So T34's guard and T37 assertion #3 must treat an unpaired **card-side**
    deposit as acceptable while still flagging an unpaired **checking-side** withdrawal —
    the asymmetry is the point, because only the checking side is money that left the
    household.
49. **Rajna's Chase is a dormant balance-only card: no purchases, no interest, ever — so
    its payment-history export is complete, and its $2,125.15 opening is exact rather than a
    fudge.** *(User answer, 2026-10-08, resolving the T25 audit's one flagged fudge risk.)*
    Per the user, Chase *"has no transactions and I've added it only for visibility of
    payments being made. It carries a balance but isn't used for any purchases."* That
    retires the objection the audit raised: the worry was that replaying six payments
    backwards would silently absorb unexported charges on an 87%-utilized card. **There are
    none to absorb.** The arithmetic is then airtight and self-checking:
    ```
    opening (derived)  2125.15
      − payments        290.00   (6 rows: $90.00 + 5 × $40.00)
      = stated balance 1835.15   ✅ matches Card_Totals.csv exactly
    ```
    and the **0% APR corroborates it independently** — a revolving balance at 0% accrues
    nothing, so there is no missing finance charge for the period to miss by.
    **Three consequences:** *(i)* no Chase adapter is needed in T29, which is what decision
    #42's Chase resolution already concluded, now for a second and better reason — there is
    nothing to parse, not merely nothing new; *(ii)* Chase is **exempt from T26b's
    reconciliation ladder and from T37 assertion #6's per-period form** — a card with no
    charges has no periods to reconcile, and asserting otherwise would be a check that can
    only ever pass; *(iii)* the card is nonetheless a **real account with a real balance**,
    so it counts in household debt ($1,835.15 of the $36,314.92) and T35's utilization
    (87.4%) — it is dormant, not closed, which is what distinguishes it from Woody's
    `Chase Card`. **Its ledger is payments-only by nature, and that is correct data rather
    than a gap** — the same shape as, but for the opposite reason from, Woody's closed-out
    Chase Card.

50. **The aggregate replay is an *identity* for a card whose opening is derived, not a
    test — so every card now declares an anchor or declares that it has none.**
    *(T26b, 2026-10-08.)* #45 replaced the ladder with *"replay every row from the derived
    opening and land on the stated current balance,"* and T25 recorded that it *"does prove
    the sign convention and that no rows were dropped in aggregate."* **It does not.** The
    opening is computed as `stated − net`, so `opening + net ≡ stated` holds
    algebraically whatever the rows say: flip every sign, drop a hundred rows, and the
    check still passes with Δ $0.00. It is worth running — it catches arithmetic slips in
    the loader — but it is not evidence about the data.
    What *is* evidence, and what `local/load-card-statements.js` now prints per card:
    - **an independent opening anchor**, where one exists. Citi **$0.00** (its export is
      the card's complete history from account opening) — this one is a genuine falsifying
      test, and it is what actually validates `Debit + Credit`; Capital One **$337.90**
      (its own first row is a $337.90 payment zeroing the card, and the checking ledger's
      2026-03-03 withdrawal is $337.90 too); Chase **$2,125.15** (forced by #49).
    - **the sign-convention guard**: derived opening debt must not be negative, because a
      card does not open with money on it. This is the automatic test for the phase's
      most-advertised trap — Citi read as `Debit − Credit` implies −$538.00 — and it is one
      inequality.
    - **`UNANCHORED`, stated out loud**, for `woody-apple-card` and `rajna-discover`. Those
      two rest entirely on one stated balance and nothing else, which is exactly the pair
      the user is collecting per-period closing balances for. **Their ledgers are loaded
      and internally consistent but not independently verified, and the ladder is the only
      thing that can change that.** Recorded plainly rather than behind a green check.
51. **The import contract T26b and T29 share is a *module*, not a prose spec — and here is
    the `external_id` formula verbatim.** *(T26b, 2026-10-08; binding on T29.)* The task
    asked that the formula be *"written down for T29 to adopt verbatim."* Written down is
    not enough: the known-good diff test (#27) fails the moment the two implementations
    differ by a space, and nothing would catch it except the test it was meant to enable.
    So it lives in **`shared/card-import-spec.js`**, which T29 **imports** rather than
    re-derives. Pure, zero-dep, browser+Node, no DOM.
    The canonical key is five `|`-joined components:
    ```
    accountId | txnDate | (withdrawal - deposit).toFixed(2) | normalizeMerchant(merchant) | occurrence
    ```
    - `txnDate` is the **transaction** date, ISO, never the post/clearing date (#46).
    - the amount is **one signed field in the ledger's convention** (charge positive,
      payment/refund negative), so no issuer's sign convention reaches the fingerprint.
    - `normalizeMerchant` = NFKD, combining marks stripped, uppercased, every run of
      non-alphanumerics collapsed to one space, trimmed. **Digits are kept** — `DUNKIN
      #354365` vs `#354366` are different stores and `AMAZON MKTPL*BF9ZD2HW0` carries the
      order id that distinguishes two same-day Amazon charges.
    - `occurrence` is the 0-based index among rows sharing all four components above, and
      it is **order-independent by construction**: members of one group are
      indistinguishable on every key component, so which gets 0 cannot be observed and the
      resulting *set* of ids is identical whatever order the rows arrive in. This is what
      lets two genuine same-day same-amount Starbucks runs both survive while a re-uploaded
      statement dedupes to nothing.
    The hash is **FNV-1a 64-bit run twice** (forward from basis `0xcbf29ce484222325`,
    reversed from `0x9e3779b97f4a7c15`) concatenated to 32 hex chars. SHA-256 was rejected
    for a concrete reason, not taste: the digest available in both runtimes is WebCrypto's,
    which is **async**, and that would force T29's `normalize()` to return a promise.
    Collision-freedom is **asserted** on the real corpus (911/911 unique, no cross-card
    collision, no collision against existing rows), not assumed.
    Also now shared, for the same reason: `ISSUER_CATEGORY_MAP`/`mapIssuerCategory` (#53)
    and `stripCitiCardSuffix` — because the diff test demands **identical categorization**,
    not just identical ids.
52. **Payments are classified on the *description*, not the issuer's category column — and
    T25's convention table is missing five parse hazards.** *(T26b, 2026-10-08; binding on
    T29.)* #46 already said *"filter payments on the issuer's type/description, not on the
    sign."* Loading the data found that for three issuers the **category column is not good
    enough either**:
    - **Discover files a merchant refund under payments.** `Category = 'Payments and
      Credits'` holds 17 rows, one of which is `ADORE ME INC … −39.95` — a return.
      Classifying on the category inflates payments by $39.95 and sends T34 hunting for a
      checking row that does not exist. `amount < 0 && /PAYMENT/i` gets all 16 real ones.
    - **Capital One files reward credits under payments.** `Category = 'Payment/Credit'`
      holds 22 rows; three are `CREDIT-CASH BACK REWARD` / `CREDIT-REWARD REDEMPTION`
      ($57.46). Only 19 are payments.
    - **Apple's one balance transfer is `Type = 'Payment'`** and is identified solely by
      `Merchant === 'Bill Payment'` (every other payment is an ACH-from-account-ending-NNNN
      or an Apple Cash payment). Miss it and $4,000 of #47's card-to-card debt movement
      reads as a debt payment.
    - **Discover's `FIRST LATE PAYMENT - NO FEE` matches `/PAYMENT/` at $0.00** — which is
      why the test needs the `amount < 0` conjunct as well as the `!amount` guard #45's
      write-up already warned about.
    And five mechanical hazards T25's table does not record, each silent rather than loud:
    - **Five issuers, FIVE date formats.** Apple / Citi / Discover `M/D/YY`, Capital One
      `YYYY-MM-DD`, Chase `D-Mon-YY`. The table recorded *which* date columns exist, never
      their format.
    - **UTF-8 BOM** on `Card_Totals.csv` and `Rajna_Chase.csv` — keys the first column as
      `"﻿Card"`, so a lookup by name returns `undefined`. Same failure mode as the
      `\r` bug T25 did catch, different cause.
    - **Chase's header separator is two U+00A0 NON-BREAKING SPACES**, not the "double
      space" T25 recorded. A byte-exact header match fails; JS's `\s` happens to match
      NBSP, which is the only reason a regex-based parser survives it.
    - **Chase's `Pending` value carries a trailing U+00A0**, so `status === 'Pending'` is
      false. T29 needs this the moment it decides anything on status.
    - **Chase's last row has no trailing newline**, and its amounts are `$40.00 ` —
      currency symbol plus trailing space — and **always an outflow**, so the sign must be
      *applied*, never read.
    - **Citi appends the card number to every purchase description**
      (`… null XXXXXXXXXXXX3676`, Citi's own literal `null`). Three different numbers
      across 26 rows, so it is both ledger noise and an `external_id` stability risk — a
      reissued card would change every fingerprint on that merchant. Stripped by
      `stripCitiCardSuffix`, with the numbers kept in `data.last4_seen`.
53. **First-pass card categories come from a shared issuer map, `Interest` becomes a real
    ledger category, and the issuer's own words are preserved on `note`.** *(T26b,
    2026-10-08.)* T30's bulk pass re-categorizes these rows in place later, so the load
    needs a defensible *first* guess rather than a perfect one. Three rules:
    - **Map only where the meaning is unambiguous**, to the vocabulary the ledger already
      has (`Restaurants`/`Dining` → `Food`, `Grocery`/`Supermarkets` → `Groceries`,
      `Gas`/`Gasoline`/`Gas/Automotive`/`Airlines` → `Transportation`, …). Where there is
      no honest home (`Hotels`, `Medical`, `Shopping`, `Merchandise`), **`Misc` plus the
      raw category on the note** — never an invented category to make a map look complete.
    - **One addition, `Interest`**, because the data forces it: $207.35 on Apple in one
      month, $2,178.41 on Discover across the window, and Discover bills **two** interest
      rows a month. It is not discretionary spending and reads wrong in a catch-all. Until
      it has a CSP item it falls to `Unassigned`, which is the visible, expected first-run
      state. Named card **fees** (`MEMBERSHIP FEE`, `CAPITAL ONE MEMBER FEE`, `BALANCE
      TRANSFER FEE`, Discover's `Fees`) go to **`Bill`**, not `Interest` — a fee is a
      charge you owe, and conflating the two would make an `Interest` CSP item mean two
      things.
    - **`note = "issuer · raw category"` on every loaded row**, so T30's bulk pass can mine
      what the issuer actually said instead of re-deriving it from the merchant string.
    **Measured outcome across the 911 rows:** `Food` 290 · **`Misc` 247** · `Transportation`
    133 · `Credit Card Payment` 81 · `Groceries` 67 · `Fun` 47 · `Interest` 24 · `Bill` 18
    · `Transfer` 3 · `Adjustment` 1. **`Misc` at 27% is the number that settles T30's
    weighting** — it is Citi exporting no categories at all plus Apple filing 60% of a
    month under `Other`, not a lazy map.
    **Known wart, self-correcting:** a refund whose issuer category is useless (Apple's 8
    `Type=Credit` returns) lands in `Misc` while the purchase it reverses landed in
    `Groceries`, so #21's "net of refunds per category" nets imperfectly until T30's rules
    cover the merchant — at which point both rows move together, because the rule keys on
    the merchant they share.
54. **`Woody Discover` is NOT a `source_alias` of `rajna-discover` — T26's seed conflated
    "one card" with "all three source strings are payments to it".** *(T26b, 2026-10-08.)*
    T26 gave `rajna-discover` three aliases — `Discover`, `Rajna Discover`, `Woody
    Discover` — citing *"decision #43's one-card resolution."* #43 resolves how many
    **cards** exist; it says nothing about which **source strings** are payments to one.
    #41 identifies `Woody Discover` (22 rows / $300, on *Rajna's* ledger) as the
    person-to-person mirror, and **#44 explicitly names it among the rows that stay
    `Partner Transfer`**. Left in place it would have T34 pairing inter-person transfers
    onto a card ledger and T37's assertion #3 demanding a card counterpart that cannot
    exist. Corrected to two aliases. `local/seed-cards.js` now **re-syncs** seeded keys on
    any account row still stamped at the epoch — i.e. never written by the app or a merge —
    so a correction to that file actually reaches a database that already holds the wrong
    value, instead of being inert behind insert-only idempotency.
    **Second seed repair in the same pass:** `woody-apple-card` had survived T26 with
    `data = '{}'`, a casualty of that task's publish round-trip verification, silently
    costing it `credit_limit`, `apr` and `source_aliases` — the last of which is the map
    T34 matches inbound payments against, so its absence is a pairing failure rather than
    cosmetics. The seed now backfills missing keys unconditionally.
55. **Loading the card ledgers makes the Dashboard double count *today*, and it is bigger
    than T27's warning implies.** *(T26b, 2026-10-08; T27 owns the fix.)* T27 calls this
    *"the single highest-risk line in the phase"* and it is now live rather than
    hypothetical. `shared/dashboard-render.js:112` builds `myTxns` as **every account the
    person can see** — `owner === currentUser || owner === 'shared'`, with **no `type`
    filter** — and hands it to `summary()` and `monthlySpend()`, which count the card
    purchase *and* the checking payment. YTD to 2026-10-08: Woody's outflow reads
    **$95,278.82 against a true $52,493.75** (+81%), Rajna's **$44,357.87 against
    $35,240.84** (+26%), and Woody's `monthlySpend` for 2026-10 reads **$1,583.42 against
    $350.89** — 4.5×.
    Two things T27 should not miss. **(1) The asymmetry: Rajna's Dashboard is wrong even
    though her CSP is not.** The CSP matches owner by equality (`a.owner === pt.owner`) so
    `owner: 'shared'` cards reach **neither** plan; the Dashboard matches `owner-or-shared`
    so they reach **both** tiles. One mechanism, two filters, opposite blind spots.
    **(2) The balance tile is already safe** — `checkingToday` filters
    `a.type === 'checking'` — which is the proof that the fix is a scope at the call site
    and **not** a change to `metrics.js`: two call sites in
    `shared/dashboard-render.js` and the same two in its `docs/` twin.
    Related and much smaller, but the kind of thing that wastes an afternoon later:
    Apple's earliest row is **2026-03-02**, one day before Woody's earliest checking row,
    so his **open-ended CSP window grew by a day and rescaled every monthly average in
    it** — `Debt Payments` all-time moved $1,260.68 → $1,259.54. Nothing was miscounted;
    the denominator changed.

56. **`transfer_id` is a GROUP key, not a pointer: a payment may be one checking row
    against N card rows, and what must hold is that the group nets to zero.** *(T34,
    2026-10-08.)* T34 was specified as *"a payment is two rows joined by `transfer_id`"* and
    the real data disagrees four times on one card. Apple's **$888.12** checking withdrawal
    of 2026-07-16 arrives on the card as **four** rows ($73.12 + $45.00 + $504.00 +
    $266.00); $824.27, $1,443.82 and $460.00 each split two ways. Because `transfer_id` is
    a shared string rather than a foreign key, N+1 rows under one key already works — so
    the invariant is restated from *two rows with opposite signs* to **`groupNet(rows) ===
    0`**, which covers 1:1, 1:N and the card-to-card case (#47) uniformly. Consequences
    that are not cosmetic: the matcher needs **bounded subset-sum** after exact 1:1, and it
    must **refuse an ambiguous subset** — two ways to make $888.12 from the same pile is a
    coin flip, and a wrong `transfer_id` is worse than none because the checker then
    certifies it. `PATCH /api/transfers/:id` likewise **refuses to propagate an amount**
    across a group of more than two rows (409, not a guess), while a **date** still
    propagates to all of them.

57. **The mirror guard keys on the reconciliation ANCHOR, not on `seeded_range` — the
    task's rule is wrong in one direction and the real data has 12 rows in it.** *(T34,
    2026-10-08.)* T34 says *"mirror only payments outside the seeded range."* That catches
    the loud half: inside the range T26b's imported row already exists, so mirroring makes
    the payment exist twice. It misses the quiet half. A card's `opening_balance` was
    **derived** as `stated − net` (#50), which means every payment dated **before** the
    export begins is **already absorbed into it** — so mirroring those double-counts in the
    opposite direction, with the same magnitude of error and the same absence of any
    symptom. `rajna-discover` has **7** such rows ($3,373.00, 2026-01-05 → 2026-03-03).
    `seededGuard` therefore admits only dates **strictly after `data.statements.as_of`**,
    because only those lie beyond every figure T26b reconciled to the cent. Third clause,
    from the same principle: **a card with no anchor at all is never mirrored onto** —
    `woody-chase-card` has no export, no range and no stated balance, and mirroring its
    five payments would read **−$6,068.99** and quietly take household debt from
    $36,314.92 to $30,245.93.

58. **After T34, a card's all-dates balance is a PROJECTION, not a balance — card debt
    must be read as of a date.** *(T34, 2026-10-08; acted on by T27.)* Mirroring the
    planned payments is correct and is what the task asks for ("they're projections on both
    sides"), but it is **one-sided**: the checking ledger carries planned payments out to
    2027-07 and the cards carry no planned charges. So an unbounded `accountBalance()` on a
    card now answers *"what would we owe if we never used the card again"* —
    **$6,151.92** household — while the question anyone is actually asking answers
    **$36,314.92**. Both are real; only one is a balance. **T27 shipped the fix in the same
    pass**: `shared/cards.js` exposes `cardDebtAsOf`/`cardDebtBefore` and defaults
    `totalDebt`'s `asOf` to today, and `check-cards.js` asserts the as-of figure against
    T26b's per-card numbers (plus the $40.00 Chase autopay of 2026-10-27, which an
    all-dates replay counts and a person asking today has not paid). T32b's payoff
    projection and T35's debt tile must both read as-of-today, not end-of-ledger.

59. **T35's payoff row and T32b's scenario 2 answer different questions and must not be
    forced to agree; what is asserted is the shared arithmetic KERNEL.** *(T32b,
    2026-10-08, replacing the agreement clause in T32b's "Done when".)* T32b's text assumed
    both consume the same scheduled-payment series. They do not: `cardPayoffDrift` (T35)
    measures the **trailing actual** payment over months elapsed and carries **no interest
    term**, answering *"is this card moving at all?"*; `payoffScenarios().stop` (T32b) uses
    the payments the ledger has **scheduled** and compounds at `apr/12`, answering *"when
    does this balance retire?"*. On `woody-apple-card` that is 11 months versus 14, and
    both are right about their own question — equalizing them would mean deleting the
    interest from the payoff panel or handing the Dashboard a plan it was deliberately not
    given. So `check-cards.js` asserts the kernel instead: with `apr: 0` and no charges,
    `payoffSchedule` and `debtPayoffResult` must name the **same month** for the same
    (balance, payment), over five pairs including each real card's. A divergence there is a
    real bug in one of them; a divergence in the live figures is the two screens doing
    their jobs. Anything that later unifies them must unify the **inputs** (give T35 the
    scheduled series and an interest term), not the outputs.

## Open — needs the user, before the task that depends on it

- ~~**#21 sign-off** → gates **T28**.~~ **Resolved 2026-10-07** — #21 was rewritten to the
  user's direction and signed off in the same breath. T28 is unblocked.
- ~~**Card APR and credit limit, per card** → gates **T32b**, and degrades **T35**.~~
  **Resolved 2026-10-08 by `Card_Totals.csv`** — all five live cards carry a limit and an
  APR: Apple $10,500 / 25.74%, Citi $6,800 / **0% (promotional — see #47)**, Capital One
  $400 / 28.49%, Chase $2,100 / 0%, Discover $25,500 / 19.74%. **T32b runs at full fidelity**
  — no 0% fallback, no hidden limit line. Utilization is already alarming enough to be the
  headline: Apple 99.2%, Citi 99.3%, Chase 87.4%. ~~**Still missing** (does not gate T32b,
  does degrade T26's seed and T35's drift): **statement day, due day and minimum payment**
  per card.~~ **Resolved 2026-10-08 by five user-supplied statements** (one per transacting
  card) — see T25's "Closed out" update. `statement_day`/`due_day` are now known for all
  five; three of the five APR guesses above were also corrected to the statements' current
  go-forward rates (Apple 25.74%→25.49%, Discover 19.74%→17.99%, Capital One 28.49%→28.24%).
  `min_payment` stays an intentional `null` — every stated minimum was balance-dependent,
  not a flat policy.
- ~~**`woody-chase-card`'s opening balance: is it $7,931.13?**~~ **RESOLVED 2026-10-08 — and
  the premise was wrong.** The card was never closed-with-no-export; the user supplied a
  real statement PDF (close 2026-08-23, New Balance $49.00) and a full transaction-history
  CSV (`~/Downloads/woody_chase/`), loaded by the new `local/load-woody-chase.js`. The real
  opening balance is **$7,567.17**, not $7,931.13 — the guess assumed a $750.00 payment on
  2026-03-19 that the real data shows was **$567.17** (the $750.00 checking row is real but
  unpaired on THIS card; it's a coincidental same-day, same-amount match with an unrelated
  Apple Card near-miss already in `KNOWN_UNPAIRED`). Verified two independent ways to the
  cent: replaying from $7,567.17 lands on the statement's stated $49.00 at the 08-23 close,
  and separately on exactly $0.00 after the CSV's own last (09-03) row. Of T34's 5 enumerated
  `woody-chase-card` exceptions, **3 now pair exactly** ($5,000.00, $19.99, $49.00 — re-run
  via `node local/backfill-transfers.js --card woody-chase-card --commit`); the other 2 move
  to the ordinary in-window-mismatch bucket (`KNOWN_UNPAIRED` updated, `--audit` passes
  clean). The one-legged Chase→Citi $1,862.14 transfer (#47) is now two-legged: the
  2026-05-06 Chase-side row carries `transfer_id: 'bt-2026-05-05-chase-citi'`, matching the
  Citi-side row T26b wrote. Household debt as of today is unchanged ($36,354.92 → same —
  the card nets to $0.00 today either way), but `woody-chase-card` is no longer absent from
  utilization/APR/statement-day coverage: last4 9372, $9,000 limit, 26.49% APR, closes the
  23rd, due the 20th — `local/seed-cards.js` updated to match. `npm run check:csp -- --db`
  and `npm run check:theme` both still pass; verified live in both the Dashboard and the
  Credit subtab with headless-Chrome screenshots.
- **Does "exactly on target" mean to the cent?** → **T28 shipped the equality** (decision
  #38) rather than block on this, since the band is a one-line change either way. The
  prediction that it "would effectively never render" turned out to be wrong: it fires on
  **four real rows** — `Insurance` $198.50, `Braces` $152.39, `Real Estate` $10.00 and
  Rajna's `PRP Treatment` $400.00 — because a fixed monthly debit averages to itself over
  any whole number of months. So gray now renders where a target is met on the nose, which
  is arguably the right answer already. Still worth a word: if "within a dollar or two" was
  meant, it becomes a tolerance band. Say which.
- **A refund exceeding its category's charges** → gates **T31**'s donut. The slice goes
  negative and the arc cannot be drawn. Proposal: clamp the slice to zero, show the true
  negative in the legend and the stat row. Confirm or pick otherwise.
- ~~**The card inventory** → gates **T26**, **T34**.~~ **Resolved 2026-10-07 → decisions
  #41 + #42.** The inventory is now **derived, not decided**: five cards, being whatever
  remains under a purified `Credit Card Payment` — `Apple Card`, `Capital One`,
  `Chase Card`, `Citi Card` (Woody) and `Discover` (Rajna). The Discover three-way, the
  $400 `Rajna` row and `Rajna Capital One` all closed with it. **Residual, both minor:**
  `Vacation Apple Card` is a statement credit rather than a card (#42 — one row to
  re-source), and **no card has been declared `owner: 'shared'`** yet, which is still a T26
  input. The per-card opening-balance anchor is folded into *the statements themselves*.
  **REOPENED AND RE-CLOSED 2026-10-08 by the T25 audit → decisions #43 + #44.** The derived inventory
  was **wrong on two counts**: `Capital One` is **Rajna's** card (eight exact payment
  matches), and `Rajna Chase` / `Rajna Discover` **do** have live card counterparts, which
  was the stated premise for moving them to `Partner Transfer`. The inventory is **six
  accounts, 2 Woody / 4 Rajna** (#43 — settled, no sign-off needed, changes no numbers).
  **#44 signed off by the user 2026-10-08**: `Credit Card Payment` means *money toward any
  card in the household inventory*. So **39 of #42's rows reverse** back to
  `Credit Card Payment` and **Rajna's three cards are `owner: 'shared'`** — the first use of
  decision #24's shared mechanism. Five provable transfer pairings are recovered. The
  execution is **T26's**, and it carries one hard precondition: #42's prediction of zero page
  impact is a *prediction*, so T26 takes a `VACUUM INTO` backup, diffs all three windows
  before/after, and **stops if anything but zero moves**. `Vacation Apple Card` is
  **confirmed** a statement credit (no matching Apple row, no sixth Apple account in
  `Card_Totals.csv`) — one row to re-source into `Apple Card`.
  **The `owner: 'shared'` question is therefore also closed**, which was the other listed
  residual.
- ~~**Chase** → gates **T29**'s adapter count.~~ **Resolved 2026-10-07: no Chase adapter.
  T29 stays at four** (Apple Card, Capital One, Citi, Discover). Two independent reasons,
  one per source. **`Chase Card`** (Woody's own, 5 rows, $6,068.99) is **closed out** — it
  has **zero future-dated rows** and stops at 2026-09-03, while Apple / Citi / Capital One
  carry 21 / 15 / 9 projected rows into 2027; it is ledger-only history. **`Rajna Chase`**
  (12 rows, $1,510, live through 2027-02-18) is *not a card account at all*: per the user it
  is **Woody paying the issuer directly for a card in Rajna's name**, so there is no
  counterpart to pair, nothing to backfill on her ledger, and no sixth account. It is
  `Partner Transfer` under #42, and Rajna's ledger having zero Chase rows is therefore
  **correct, not a gap.**
- ~~**The statements themselves** → gate **T26b** (and through it most of the phase), plus
  **T29**, **T30**, **T37**.~~ **Resolved 2026-10-08 — audited, see "T25 findings".**
  Six CSVs at `~/Downloads/CSVs/`, outside the repo. Answers to each sub-question:
  **CSV, not PDF** — all six, no PDF task raised. **8 months per card** (2026-03 → 2026-10),
  **one date-range file per card**, not one per period — including Apple, which the plan
  expected to export per statement. **Interest and fees are included by every issuer** that
  exports transactions. **Closing balances per period: absent** — only one current balance
  per card, which is decision #45 and the one genuine downgrade. **Two residual blockers
  remain:**
  - ~~🚩 **Chase has no transaction export.**~~ **Resolved 2026-10-08 → decision #49.** Not
    a gap: the card *has* no transactions. Per the user it exists *"only for visibility of
    payments being made"* — a dormant balance at 0% APR, never used for purchases. So the
    payment history is complete, the $2,125.15 opening is exact (it replays to $1,835.15 to
    the cent), and Chase is **exempt** from the ladder and from T37 assertion #6's
    per-period form. No `Adjustment` row, no fifth adapter, no blocker.
  - 🚩 **The per-period closing balances** → restores decision #45's ladder. **The user is
    collecting them (2026-10-08).** They exist on each issuer's statement page and were
    simply not in the export. **STILL OPEN after T26b, and now narrowed to two cards.**
    T26b loaded and reconciled all five ledgers, and in doing so established that only
    **`woody-apple-card` and `rajna-discover`** actually need the ladder: Citi, Capital One
    and Chase each have an **independent opening anchor** that the load verified exactly,
    so they are genuinely checked already (#50). The other two are `UNANCHORED` — their
    aggregate replay is an *algebraic identity*, not a test (#50 again, correcting what
    T25's write-up implied), so their ledgers are internally consistent and
    **independently unverified**.
    Two things changed about the urgency. **It is no longer "before the files are
    deleted"** — the 911 rows are permanently in `dashboard.db` and the derived month-end
    balances are persisted to `accounts.data.statements.derived_month_end`, so the ladder
    is constructible whenever the numbers arrive. **And the loader already consumes one:**
    `node local/load-card-statements.js --ladder <file>` with
    `{ "<card-id>": [{ "closing_date": "YYYY-MM-DD", "closing_balance": <debt, positive> }] }`
    checks every period alongside the aggregate. **The statements are therefore being kept
    staged at `~/Downloads/CSVs/` rather than deleted** — outside the repo, which is what
    the no-leak guarantee rests on — until the ladder passes. `rm -rf ~/Downloads/CSVs`
    whenever that is done.
- ~~**Daily Check on a card** → gates **T33**.~~ **Resolved 2026-10-08, in T33: hidden.**
  The disabled "Check" button explains why rather than silently no-opping. Re-pointing it at
  a statement balance (the alternative this bullet raised) is revisitable once decision #45's
  ladder closes for the two `UNANCHORED` cards — until then there's no verified per-card
  comparison point to check against.
- ~~**Card metadata values** → needed by **T26**'s seed, **T32b**'s projection and **T35**'s
  utilization/drift: credit limit, APR, statement day, due day and minimum payment per
  card.~~ **Resolved 2026-10-08** — limit/APR came from `Card_Totals.csv` (see above);
  statement day/due day/APR-accuracy came from five user-supplied statements, backfilled by
  `local/update-card-statement-meta.js`. `min_payment` is deliberately left unset (see T25's
  "Closed out" update) — it would need a flat per-card policy, and none of the five cards
  states one.
- **Which card categories need their own CSP items** → gates the back half of **T28**.
  Under the rewritten #21, card purchases land at their own category, and `Groceries` has an
  item but `Food` / `Transportation` / `Misc` may not — they would fall into the catch-all
  "Unassigned" row on the first run. **Sharpened 2026-10-08 — one real month is now
  measured** (Woody's Apple Card, 2026-09; see T25 findings):
  - **`Interest` wants its own item.** $207.35 on Apple in that month alone, $2,178.41 on
    Discover across the window — and Discover bills **two** interest rows a month. It is not
    discretionary spending and reads wrong in a catch-all. Recommendation: a dedicated
    `Interest` item under Fixed Costs.
  - **`Other` is 60% of the month** ($1,848.08 of $3,058.35), and **Citi exports no
    categories at all**. The issuer vocabularies are too coarse to carry #21's
    "at their own category" by themselves — so this question is **substantially T30's**, not
    T28's. Worth re-weighting T30's priority upward accordingly.
  - The three vocabularies to map are listed verbatim in the T25 findings; they share almost
    no spelling (`Grocery` / `Supermarkets` / none; `Restaurants` / `Dining` / `Restaurants`).
  - **Sharpened again 2026-10-08 by T26b's load — the question now has real numbers on both
    halves.** Across all 911 loaded card rows the first-pass map (#53) yields `Food` 290 ·
    **`Misc` 247 (27%)** · `Transportation` 133 · `Credit Card Payment` 81 · `Groceries` 67
    · `Fun` 47 · **`Interest` 24** · `Bill` 18. And the CSP consequence is measured rather
    than predicted: Woody's **`Miscellaneous (15% buffer)` item absorbs $962.72/mo** of card
    purchases (up from $15.18), while **`Unassigned` goes $416.62 → $2,196.54** across 424
    rows in 153 groups. So the answer splits cleanly: **`Interest` wants its own Fixed Costs
    item** (24 rows, and it is the one category that is unambiguously not discretionary),
    and the rest is **T30's problem, not T28's** — a 15% buffer line is not where a quarter
    of the card ledger belongs, and no set of CSP items can fix a category that says
    `Misc` because the issuer said nothing at all.
  - **Answered on the code side 2026-10-08 by T30; what remains is a plan-authoring
    decision.** T30's 58 rules took `Misc` from 247 card rows to 113, and the CSP diff
    (same plan, pre- and post-categorize database, full table in T30's status block) shows
    Woody's `Miscellaneous (15% buffer)` dropping **$4,117.34** in the default *Last 3
    months* window while Guilt-Free `Unassigned` rises **$4,019.82**. The dollars stopped
    being mis-filed, but his plan has **no item claiming `Transportation`, `Fun` or
    `Bill`-beyond-its-named-sources**, so they land in `Unassigned` — visible and named as
    unexplained, which is strictly better than a buffer line that looked like a plan being
    met, but not yet an answer. **Recommended items, from the real distribution:
    `Transportation`, `Fun`, and `Interest`.** That is the user's call on their own plan,
    not something a task should seed. The residual `Misc` (113 rows) is now overwhelmingly
    **healthcare with no category to go to** and **genuinely mixed retail** — see T30's
    two recorded decisions.

---

# Phase 14 — Five more theme families, each paired light/dark (user request, 2026-10-07)

**Eight more color variants**, taking the site from two standalone themes to **six
families × two modes = twelve variants**, with **Light / Dark / Auto** as a second,
independent axis. Today's two themes are each half a pair: the original `:root` dark has
no light counterpart, and **Peach** has no dark one. Four palettes picked out of the nine
in `~/Desktop/themes/` supply four new families; each arrives as one mode and has its
counterpart derived.

> Count note: the request said *"8 more … 5 distinct themes"*, but completing the two
> existing families is +2 variants and four new families is +8, which is **+10 new /
> 6 families / 12 variants**. Confirmed with the user (2026-10-07): go with 6 families.

## Goal (one paragraph)

Phase 12 made colors live in exactly one place and Phase 12b made the choice belong to
the person; this phase makes the choice **two-dimensional**. `data-theme` stops being a
flat id and becomes **family × mode** (`data-theme="bordeaux" data-mode="dark"`), the
profile grows a `theme_mode` column beside `theme`, and `auto` is resolved **in
`theme-boot.js` from `matchMedia("(prefers-color-scheme: dark)")` before the first
paint** — never with an `@media` block in the stylesheet, so the pre-paint answer and the
post-load answer keep coming from the one rule that Phase 12b already centralized. The
real risk is not the palettes but the **multiplication**: 12 variants × ~35 tokens is
~450 values, 144 of them chart hues, and the existing `check:theme` hardcodes exactly two
selectors and knows nothing about a family missing its other half. So the guardrails are
built *before* the eight new variants, not after — the contrast checker learns to
enumerate variants out of the stylesheet and to **fail on an incomplete family** — and the
token blocks move off `:root` onto plain attribute selectors, which costs nothing in
production and is what lets the showcase mockup render all twelve variants on one page
out of the **real** stylesheet instead of a copy of it.

## The four palettes, and why these four

Picked for maximum separation from each other *and* from the two families that already
exist (Slate's blue-slate neutral, Peach's pale-warm + mint). Source hexes transcribed
from the screenshots verbatim.

| Family | Source palette | Native mode | Hue identity it owns |
|---|---|---|---|
| **Bordeaux** | `#335C67` `#FFF3B0` `#E09F3E` `#9E2A2B` `#540B0E` | **dark** → derive light | deep wine + honey bronze |
| **Lagoon** | `#0E7C7B` `#17BEBB` `#D4F4DD` `#D62246` `#4B1D3F` | **dark** → derive light | jewel teal + berry |
| **Orchid** | `#CEC2FF` `#B3B3F1` `#DCB6D5` `#CF8BA9` `#B15E6C` | **light** → derive dark | violet → rose |
| **Thicket** | `#DA2C38` `#226F54` `#87C38F` `#F4F0BB` `#43291F` | **light** → derive dark | forest green + scarlet |

Native-mode role assignments (the counterpart variant is T42's job):

- **Bordeaux dark** — `#540B0E` Night Bordeaux as `--bg`, `#9E2A2B` Brown Red as the
  `--panel-2`/`--danger` register, `#E09F3E` Honey Bronze as `--accent`, `#FFF3B0`
  Vanilla Custard as `--text`, `#335C67` Dark Slate Grey as the one cool note (the
  `--chart-line` / `--accent-weak` side).
- **Lagoon dark** — `#4B1D3F` Blackberry Cream as `--bg`, `#0E7C7B` Teal as `--panel-2`,
  `#17BEBB` Tropical Teal as `--accent`, `#D4F4DD` Frosted Mint as `--text`, `#D62246`
  Raspberry as `--neg`/`--danger`.
- **Orchid light** — `#CEC2FF` / `#B3B3F1` Periwinkle as `--bg`/`--accent-weak`, `#DCB6D5`
  Pink Orchid as `--panel-2`, `#B15E6C` Rosewood as `--accent` and the `--text` anchor,
  `#CF8BA9` Old Rose as `--neg`.
- **Thicket light** — `#F4F0BB` Lemon Chiffon as `--bg`, `#226F54` Turf Green as
  `--accent`, `#43291F` Dark Coffee as `--text`, `#87C38F` Willow Green as `--pos`,
  `#DA2C38` Scarlet Rush as `--neg`/`--danger`.

**The five rejected, with the reason** (recorded so this isn't re-litigated):

- `#083D77` `#EBEBD3` `#DA4167` `#F4D35E` `#F78764` *Regal Navy* — the nearest neighbour
  to the existing Slate dark; a navy surface with a blue-family accent is the one thing
  the set already has.
- `#E27396` `#EA9AB2` `#EFCFE3` `#EAF2D7` `#B3DEE2` *Petal* — pale pink/beige occupies the
  same pale-warm territory as **Peach**, and would read as a Peach variant, not a family.
- `#DDE0BD` `#D0D1AC` `#B6A39E` `#948B89` `#726E75` *Sage/Taupe* and
- `#B5B1B2` `#ADA9B7` `#A9AFD1` `#A1CDF4` `#7C809B` *Silver/Sky* — both fail for the same
  structural reason rather than on taste: **all five swatches are mid-luminance**, so
  there is nowhere for `--text` to go and no swatch that can carry white, which means
  neither can clear the contrast targets without importing colors from outside its own
  palette — at which point it isn't that palette.
- `#3C1518` `#69140E` `#A44200` `#D58936` `#FFFB46` *Mahogany/Rust* — the nearest
  neighbour to **Bordeaux** (deep warm + bronze). Bordeaux wins the slot because its
  fifth swatch is a slate-teal, giving it a usable cool accent, whereas `#FFFB46` Canary
  Yellow can't be an accent in a light variant at all.

## How the work is split

- **Opus** takes the four things that multiply by twelve if they're wrong: the
  **family × mode token contract** (two attributes vs. one flat id, and where `:root`
  still has to mean Slate-dark), the **mode resolution rule** (a two-field value through
  Phase 12b's three-state adopt/cache logic, plus `auto` and live OS changes), the
  **checker's completeness guards** (the thing that makes 10 new variants tractable), the
  **palette spines** (the ~20 tokens per variant where contrast and mood actually live),
  and the **settings control** (a 6×3 choice space in a panel built for 2×1).
- **Sonnet** takes what is mechanical once those exist: the column + route for the mode
  axis, the derived tints and the 144 chart hues generated by T42's documented rule, the
  showcase page, the published parity walk, and docs.

## Dependency order

```
T38 token contract ─┬─ T39 mode resolution ─┬─ T41 persistence + API ─┬─ T45 settings UI ─┬─ T46 parity ─ T47 docs
  ✅ done           │     ✅ done             │     ✅ done             │     ✅ done       │   ✅ done      ✅ done
  ▲                 ├─ T40 checker guards ───┤                         │                  │
  │                 │     ✅ done             │                         │                  │
  │                 └─ T42 palette spines ───┴─ T43 derived tints ─────┴─ T44 mockup ─────┘
  │                       ✅ done                   ✅ done                ✅ done
  └── runs FIRST, as a prologue shared with Phase 13 (T31 onward consumes its --cat-* contract)
```

**All ten tasks (T38–T47) are done.** T40 → T42 → T43 → T45 landed end to end: all twelve
variants exist and are green, the pair persists, and all twelve are selectable from the
panel's family grid × the light/dark/auto control. T42 absorbed T43's token authoring
because T40's guards make a spine-only commit a crashing build, which made T43 a retint of
passing values. T44's mockup renders all twelve off the real stylesheet. T46's walk was
**scoped down** — see its own "What shipped" for exactly what ran versus what the task
described (no CDP tool was available, so the full twelve-variant × nine-page click-through
did not happen; `check:theme`, targeted screenshots and a console-error sweep did) — and is
flagged there as the one task in the phase that is done-as-scoped rather than done-in-full.

T40 before T42 is the load-bearing edge: the eight new variants should be contrast-checked
and completeness-checked from their **first** commit, not audited after 450 values land.
**It paid off exactly as intended:** T42 added eight variants and `check-theme.js` needed
**no edit at all** to score them, caught nothing unrecorded, and its predicted weak spot
(`cat-card` / `cat-transport` at 0.4 of headroom) is precisely where all eight landed.

**T38 is also the prologue to Phase 13** — see *"Running Phases 13 and 14 in parallel"* in
that phase. It owns the twelve-name `--cat-*` contract (the three Phase 13 adds included),
so T40's separation assertion and T43's generation are written once against the final list
instead of retrofitting 36 values afterward. Phase 13's T25–T28 run concurrently with it;
its T31 onward waits on it. In exchange, **T46 absorbs Phase 13's T36** rather than both
phases walking every page.

## Conventions that apply to every task

- Everything from the Phase 10 and Phase 12 conventions blocks still applies (`PATH` for
  node, never auto-save, N people, `shared/*.js` stays browser+Node, verify in the real
  app, no page may hardcode a color, no theme flash, contrast is checked not eyeballed).
- **Slate dark stays byte-identical.** Same rule as Phase 12, now harder to honor because
  the selector it lives under is changing. Every one of its ~35 values is the spec.
- **A family is never half-added.** Both modes land in the same commit, and
  `npm run check:theme` fails if one is missing. Twelve variants is the point where
  "I'll fill in the light one later" becomes a shipped bug.
- **`auto` is resolved in JS, never in CSS.** No `@media (prefers-color-scheme: …)` in
  `theme.css`. One resolution rule, one place — the Phase 12b principle, extended.
- **Token blocks are container-scopable.** Written as `[data-theme][data-mode]`, not
  `:root[...]`, so a `<div>` can carry a variant. Free in production, and it's what makes
  T44 a true preview rather than a hand-maintained lie.

## T38 — The family × mode token contract · **Opus** — ✅ **done (2026-10-07)**

Restructure `theme.css` from two flat themes into a twelve-cell table, and prove the
contract on the four variants that need no new palette before eight more arrive.

- `data-theme` carries the **family** (`slate` | `peach` | `bordeaux` | `lagoon` |
  `orchid` | `thicket`); a new `data-mode` carries the **resolved** mode (`light` | `dark`
  — never `auto`, which `theme-boot.js` has already collapsed). Two attributes rather
  than twelve flat ids (`bordeaux-dark`) so a family's mode-invariant tokens can live in
  one `[data-theme="x"]` block and only the surfaces and semantics vary by mode.
- Selectors become **`[data-theme="x"][data-mode="y"]`**, not `:root[...]`. `:root` keeps
  the Slate-dark values verbatim as the bare first-byte / no-JS fallback; the same values
  are *also* emitted under `[data-theme="slate"][data-mode="dark"]` so the boot script can
  always write both attributes explicitly instead of relying on an absent-attribute case.
- Decide and document what is mode-invariant per family vs. per variant. Candidates for
  invariant: nothing color-bearing — assume **every** token is per-variant until a
  specific one proves otherwise, since that is the assumption that can't silently break.
- Ship **Slate dark** (unchanged), **Slate light** (new — a standard light pairing:
  neutral white/grey surfaces with the existing `#4f8cff` accent family, *not* a tinted
  one; Peach already owns warm-light), **Peach light** (unchanged values, new selector)
  and **Peach dark** (new — warm-dark: deep cocoa/aubergine surfaces keeping the mint
  accent and the peach secondary, so it reads as the same family at night).
- Slate light's neutral direction is **decision #35, and provisional**: T44's mockup is
  its review gate. Keep it a one-variant edit — nothing else in T42's rule may depend on
  it staying neutral.
- `color-scheme` moves to per-variant (`light` or `dark`) so native scrollbars, date
  pickers and `<select>` popups follow the resolved mode.
- **Declare the final `--cat-*` contract: twelve names, not nine** — per the Phase 13/14
  prologue, this task owns the three Phase 13 needs (`--cat-groceries`, `--cat-transport`,
  `--cat-misc`) so the token list is settled before T40 writes its separation assertion and
  T43 generates the hues. Phase 13's T31 then only references them. Ship values for the
  four variants this task covers; the validated pair for slate-dark / peach-light is
  `#0f7f8c` / `#8a4fb0` / `#6f7d20` (4.74 / 5.49 / 4.54 against white) and `#7fc3cc` /
  `#c79fd4` / `#b9c184` (7.47 / 6.59 / 7.78 against `#2e2622`) — picked from the gaps in
  the existing eight hues (~185° cyan, ~290° violet, ~75° olive) and already contrast-checked,
  so they land with **no new `KNOWN` entry**, unlike 8 of the 9 colors already there.
  Add all three to `check-theme.js`'s `on-slice on cat-*` list in the same commit.
  **Why here and not in Phase 13:** three tokens × 2 variants is a footnote; three × 12
  retrofitted after T43 is 36 values added under the tightest constraint in the phase.

### What shipped

- **`local/public/theme.css`** is now a family × mode table. `data-theme` carries the
  family, a new `data-mode` carries the **resolved** mode, and every token block is a
  plain `[data-theme="x"][data-mode="y"]` attribute selector — so a `<div>` can carry a
  variant, which T44's mockup needs and which was verified in the real app rather than
  assumed (a container with `data-theme="peach" data-mode="dark"` resolved `--bg` to
  `#1b1211` while the surrounding page stayed `#fff8ea`).
- **`:root` shares ONE rule with `[data-theme="slate"][data-mode="dark"]`** rather than
  repeating its ~38 values. The spec allowed emitting them twice; a shared selector group
  makes "Slate dark stays byte-identical" structurally true instead of a thing to
  re-verify, and `check:theme` now asserts the two resolve to the same token set, so
  splitting the group fails the run. Worth knowing for T42: variant selectors are
  (0,2,0) and `:root` is (0,1,0), so a variant always wins regardless of source order.
- **Four variants ship**: slate-dark (unchanged), **slate-light** (new — neutral
  white/grey surfaces, the `#4f8cff` family darkened to `#2563d6` so a white label clears
  4.5:1 on a filled button; provisional per #35), peach-light (unchanged values, new
  selector) and **peach-dark** (new — deep cocoa surfaces, mint accent, peach kept as
  `--panel-2`).
- **Nothing is mode-invariant**, and that is now documented in the file with the reason:
  the two candidate tokens disprove the idea rather than support it. `--btn-hover-filter`
  *inverts* between modes and every shadow is an rgba that has to re-tint, so the
  family-level list would have been empty — and a shared block's failure mode (a token
  that looks right in the one mode anyone opened) is the kind nobody catches.
- **`color-scheme` is per-variant**, so native scrollbars, date pickers and `<select>`
  popups follow the resolved mode. Verified: slate-light / peach-light report `light`,
  peach-dark / slate-dark report `dark`.
- **The `--cat-*` contract is closed at twelve names**, with `--cat-groceries` /
  `--cat-transport` / `--cat-misc` declared in all four variants. Phase 13's T31 now only
  *consumes* them and touches neither `theme.css` nor `check-theme.js` — **both hard
  collisions in the prologue's table are gone.** The local override in
  `cards-mock.html` was deleted (it defined the three tokens for itself) and its F2 flag
  rewritten as resolved, so the mock now renders the real palette.
- **`local/check-theme.js`** scores four variants, reads tokens through grouped
  selectors, takes `CATS` to twelve, rekeys `KNOWN` to `slate-dark::…`, and adds the
  `:root` ≡ slate-dark assert. **`npm run check:theme` passes** with exactly the 12
  pre-existing slate-dark shortfalls and **no new `KNOWN` entries**: the three new
  category tokens clear white at 4.74 / 5.49 / 4.54, and both new variants pass every
  target outright.
- **`theme-boot.js`** now writes **both** attributes from one stored id
  (`dark → slate/dark`, `peach → peach/light`), which is also decision #36's migration,
  so the pair written today is the pair T39 will store. Without this, `data-theme="peach"`
  alone matches nothing in the new stylesheet and peach silently renders as slate-dark.
  `settings.js`'s no-boot-script guard got the same pair so it can't paint half a variant.

### Two things the next tasks need to know

1. ~~**T40 cannot assert pure hue distance — peach-light would fail it.**~~
   **Resolved in T40 (2026-10-08): the metric is CIEDE2000, threshold 8.0, and
   peach-light is excused for three pairs by name.** Measuring all four variants showed a
   hue-angle assert fails in *both* directions, so this was never only a peach-light
   problem — see T40's block below for the numbers.
2. **The derivation rule T43 should follow**, now documented in `theme.css` and used for
   both new variants: hue is **fixed per category** from slate-dark (the one palette whose
   twelve hues separate cleanly, min gap 17°), and lightness is **solved, not picked**,
   against that variant's `--on-slice` — dimmest-passing on light surfaces so slices stay
   vivid instead of washing into a white panel, and a fixed pastel band (L .68 / S .42) on
   dark surfaces so they sit clearly above it. The dark half matters: dimmest-passing on a
   dark panel *passes the checker* and looks muddy, which is how a generated palette ships
   wrong. Slate-light's twelve land at a near-uniform ~3.35:1 against the white panel, so
   no slice visually dominates.

### Verified

`npm run check:theme` green. Then, in the real app on `localhost:3000` (headless Chrome
over CDP, since this repo has no puppeteer), **Dashboard / This Paycheck / Spending Plan
screenshotted in all four variants** — 12 shots. slate-dark and peach-light paint
`#0f1115` / `#fff8ea` exactly as before with `theme-boot.js` writing `["slate","dark"]`
and `["peach","light"]`; slate-light and peach-dark paint `#f5f6f8` / `#1b1211` with the
right `color-scheme`. A token-level diff against the committed `docs/theme.css` (the local
file is untracked, so the published copy is the only reference for "before") shows
**zero changed and zero removed values in both frozen variants, exactly the three contract
additions, and the settings-panel CSS byte-identical**. Nothing was published — `docs/` is
untouched, since the twelve-variant walk is T46's.

Worth a look in peach-dark: `--on-accent` / `--on-slice` go **dark** (cocoa), which is why
it needs no `KNOWN` entry where slate-dark has nine. Slate-dark puts white on a saturated
accent and on eight pie slices and misses 4.5:1 on all of them; peach-dark's accent and
slices are bright, so cocoa text on them clears the target outright, and the dashboard's
✓/!/✕ badges read better there than in the original dark theme.

---

## T39 — Mode resolution: set, or follow the system · **Opus** — ✅ **done (2026-10-08)**

`theme-boot.js` grows from one string to a pair, and from two states to three.

- The value becomes **`{family, mode}`** where `mode ∈ {light, dark, auto}`. `auto` is
  resolved pre-paint from `matchMedia("(prefers-color-scheme: dark)").matches` and written
  to `data-mode` as a concrete value; the stored preference stays `auto`.
- **Live re-resolution.** While mode is `auto`, subscribe to the media query's `change`
  event and re-apply — the OS flipping at sunset has to move the open page, not wait for
  a reload. Unsubscribe (or no-op) when the mode is explicit.
- **Adopt as a unit, not field by field.** Phase 12b's rule compares `stored` against
  `themeSeen:<id>`; `themeSeen` now holds the serialized **pair**. If a partner moves
  your profile from Slate/dark to Thicket/light and only the family is adopted, you land
  on Thicket/dark — a variant nobody chose. One value, one comparison, one adoption.
- **Legacy values migrate in four places**, since Phase 12b deliberately kept a fallback
  chain: the profile column, `theme:<id>`, `themeSeen:<id>`, and the pre-per-profile flat
  `theme` key. `"dark"` → `slate`/`dark`, `"peach"` → `peach`/`light`. An existing choice
  must survive this phase exactly as it survived 12b.
- **No profile is ever defaulted to `auto`** (decision #36). The migration above is what
  implements that: every existing profile arrives with its current mode made *explicit*,
  so nobody's appearance moves on the first load after this phase. `auto` is reached only
  by picking it in the panel.
- **`DEFAULT` extends to a pair, not to the OS.** A profile that has never chosen resolves
  to **Slate/`dark`** — the existing `DEFAULT` widened — and specifically *not* to
  `matchMedia`. The `auto` code path exists for people who asked for it; it must not be
  the fallback, or "no default mode" becomes "the default is your laptop's setting".
- `window.__theme` keeps being the single export surface (`themes` grows to families +
  modes, `resolve`/`cached`/`apply` take the pair), because `settings.js` reading back the
  same rule is what keeps pre-paint and post-load from drifting.

### What shipped

- **`theme-boot.js` stores a pair and serializes it to ONE value.** `"family:mode"` in
  `theme:<id>` and `themeSeen:<id>`, so the Phase 12b rule — adopt when `stored` differs
  from `themeSeen` — still runs on a single comparison. That is what makes
  **adopt-as-a-unit** structural rather than a thing to remember: there is no code path
  that can compare or adopt one half. Verified in the real app: a profile moved to
  Peach/light while this machine's cache said Slate/dark lands on peach-light, not on
  peach-dark.
- **`parse()` is the migration, and it covers all four places at once.** It takes the
  serialized pair, a `{family, mode}` / row object (what the profile column gives us as
  `theme` + `theme_mode`), *or* a bare pre-pair id, and always returns a pair with a
  **concrete** mode. Every link in the fallback chain goes through it — this profile's
  cache → the no-profile cache → the flat `theme` key → the column in `resolve()` — so
  `"dark"` → slate/dark and `"peach"` → peach/light wherever it is hiding.
- **A migration must not look like a remote change.** `resolve` compares *normalized*
  serializations, so a `themeSeen` of `"dark"` against a column of `"dark"` is equal and
  the local cache still wins. Comparing raw strings would have made every existing
  profile adopt its column on the first load after this phase — which is the one thing
  decision #36 forbids, and it would have thrown away a machine-local mode.
- **Nothing resolves to `auto` unasked.** `DEFAULT` is `{family: "slate", mode: "dark"}`
  and `matchMedia` is consulted *only* when the stored mode is literally `auto`. The
  migration fills an absent mode from `NATIVE` (slate → dark, peach → light), never from
  the OS, so a Slate/dark profile on a light-mode Mac stays dark.
- **Live re-resolution, scoped to `auto`.** `apply()` subscribes to the media query only
  while the stored mode is `auto` and unsubscribes the moment an explicit mode is applied
  (`addListener` fallback for old Safari). `current()` keeps the pair **as stored**, so
  what re-resolves at sunset is `auto` and not the `dark` it happened to resolve to this
  morning.
- **New: a `themechange` event** on every change of the painted variant, carrying
  `{family, mode, resolvedMode}`. T45 needs to label the Auto option with what it
  currently resolves to; this is how it does that without a second copy of the rule.
- **`settings.js` reads the same surface back**, now pair-shaped throughout
  (`showTheme` → `showPair`, `storedTheme` → `storedPair`, a `rowPair()` that folds the
  two columns into one value). Two details worth knowing:
  - The tiles stay **variants, not families** — `data-variant="slate:dark"` — because the
    mode axis has no control until T45. Offering "Slate" alone would move a Peach/light
    profile to Slate/**light** with nothing in the panel explaining why it isn't the dark
    theme it used to be. A pair no tile offers (only slate/light, today) checks nothing
    rather than mis-claiming a variant.
  - `markSeen` now records the **row the write echoes back**, not what was sent.
    `themeSeen` means "what the profile carried when we last looked", and that is what
    keeps the mode half — which has nowhere to live until T41 — from being adopted away
    from the machine that just picked it.
  - The attribute moved off `data-theme` for a second reason: a button carrying
    `data-theme` with no `data-mode` is exactly the half-applied container T40 now fails
    the build for.
- **One line of server, deliberately:** the PUT route accepts `{theme, mode}`, validates
  **both** (400 on an unknown family *or* an unknown mode), still stores only `theme`, and
  normalizes the pre-pair ids on the way in (`"dark"` → `slate`). Rejecting the new body
  shape for a commit would have stopped the Dark tile from persisting at all; validating
  `mode` before storing it means T41 adds a column write, not a boundary. **`theme_mode`,
  the backfill and the LWW ride are still T41's** — until then the mode lives in each
  machine's cache, where a pre-T39 install kept nothing.
- **The published dashboard hands over the pair.** `docs/index.html`'s
  `window.__profileThemes` now holds `{family, mode}` per profile instead of a bare
  string, so the published site stops dropping the mode the moment T41 populates the
  column. (It reads people out of `snapshot.json` and has no `/api/` shim, so it is the
  one page that has to supply this itself.)

### Verified

**41 assertions on the resolution matrix** (`theme-boot.js` loaded into a stub DOM —
localStorage, `matchMedia`, `documentElement.dataset` — so every branch is exercised
without a browser), all green: the four migration sites, legacy-vs-migrated `themeSeen`,
adopt-as-a-unit in both directions, `auto` resolved both ways and re-resolved live,
subscribe/unsubscribe on leaving and re-entering `auto`, an unknown family rejected, an
unknown mode falling back to native, cache/seen round-trips, and `auto` with
`matchMedia` entirely absent.

Then **29 assertions in the real app** on `localhost:3000` (headless Chrome over CDP,
since this repo has no puppeteer), reading `getComputedStyle` rather than the source —
so each one proves the stylesheet actually matched:

- The install's **real pre-T39 rows** (`woody: "dark"`, `rajna: "peach"`) with a cold
  cache migrate to slate-dark `#0f1115` / peach-light `#fff8ea` with the right
  `color-scheme`, and are recorded as `slate:dark` / `peach:light` so the next load does
  not re-adopt. **Nobody's appearance moved.**
- Pre-pair localStorage in each of its three shapes migrates; an unseen column still wins
  over the flat key, exactly as before this phase.
- Both T38 variants that had no way to be selected are reachable and whole:
  slate-light `#f5f6f8`, peach-dark `#1b1211`.
- **The OS flipping with the page open repaints it** — `prefers-color-scheme` emulated
  light→dark→light, `--bg` following each time, with `slate:auto` still the stored value.
  An explicit `slate:light` ignores the same flip. (The media `change` event lands
  *after* the CDP command returns, which is worth knowing for the next test like this.)
- Picking Peach paints, caches and persists (row `theme: "peach"`); a stale client's
  single-string body still returns 200; an unknown family and an unknown mode both 400
  and leave the row alone.
- All four pages paint the same pair pre-paint, and the dashboard's View switch —
  which fires `userchange` instead of reloading — re-resolves to the new profile's pair
  in place.

`npm run check:theme` still green (T39 touches no token). Nothing was published —
`docs/` changed only in `index.html`'s theme hand-off, and the twelve-variant walk is
T46's. **The two real rows were restored** to `dark` / `peach`; their `updated_at` on
`woody` is a few minutes newer than it was (the test wrote through the real route), which
changes no data — the row's content is identical to what it was found as.

### What T41 and T45 should know

1. **`theme_mode` is the only thing missing for the pair to survive a Publish.** The
   client already sends it and the route already validates it; T41 adds the column, the
   backfill (`slate` → `dark`, `peach` → `light`, unset → `dark`, never `auto`) and the
   one `applyUpdate` field. Note the route now stores the **family** in `theme`, so the
   backfill must read `"slate"` as well as the legacy `"dark"`.
2. **`markSeen` from the echoed row is load-bearing.** Once `theme_mode` is written, the
   row echo carries the whole pair and `themeSeen` becomes exact. Until then it records
   family-only on purpose; don't "fix" it to mark what was sent.
3. **T45 gets `themechange` and `resolvedMode()`** for labelling Auto with what it
   currently resolves to, `themes.families` / `themes.modes` for the control's shape, and
   it is the task that replaces `data-variant` tiles with a family grid × a
   light/dark/auto control. `FAMILIES` in both `theme-boot.js` and the route is still
   `slate, peach` — **T42 extends both**, and an unknown family is rejected rather than
   painted, so a tile added before its variant exists would silently do nothing.
   *Amended by T45:* `resolvedMode()` is the wrong getter for that label — it is what is
   **painted**, which equals the OS answer only under `auto`, so with an explicit mode
   selected it made the Auto line name the mode already on. T45 added `systemMode()`
   beside it. `themechange` is right for the swatches and for `auto` going live, and that
   is what T45 uses it for.

---

## T40 — `check:theme` scales to twelve, and guards completeness · **Opus** — ✅ **done (2026-10-08)**

T38 left it scoring **four** variants from an explicit `VARIANTS` list, with `vars()`
already able to read tokens through a grouped selector and `KNOWN` already rekeyed to
`slate-dark::…`. It still has to **discover** variants rather than list them, and it has
to start failing on structural gaps, not just contrast ones.

- **Enumerate** every `[data-theme="…"][data-mode="…"]` rule out of the stylesheet and
  score `PAIRS(t)` for all of them — still reading the actual token values, never a copy.
- **New: fail on an incomplete family.** A family present in one mode and absent in the
  other is an error. This is the guard that makes the next three tasks safe.
- **New: fail on a token missing from a variant.** Today a missing token prints `?` and
  increments `failed`; with 12 variants it needs to name the variant *and* the token, and
  the full expected token list has to come from the union across variants so a typo'd
  property name (`--panel2`) is caught as an omission rather than inherited from `:root`.
- **New: `--cat-*` separation.** **Twelve** category hues per variant, 144 total, and their
  job is **identity, not decoration** — a pie where two categories are the same color
  stops being readable. Assert a minimum pairwise separation among the twelve within each
  variant (66 pairs), and keep scoring `--on-slice` against each.
  **The metric is `CIEDE2000`, not a hue angle, and the threshold is `ΔE ≥ 8.0`.**
  T38 left the choice open between a hue assert with recorded exceptions and a perceptual
  one; measuring all four variants settled it, because **a hue-angle assert fails in both
  directions** and not only against peach-light:
  - It **flags pairs that are obviously distinct.** The offender is always `--cat-other`,
    whose identity is the *absence* of hue, so its angle is numerically arbitrary:
    slate-dark reads `savings` 40° vs `other` 45° — **5° apart at ΔE 25.6.** slate-light
    is 6° (ΔE 17.0), peach-dark 11° (ΔE 11.9). **Three of four variants would need
    `other` exempted**, at which point the assert isn't testing what it claims.
  - It **passes pairs that genuinely collide.** peach-light's `housing` `#e8a07a` vs
    `fun` `#eda871` are 6° apart at **ΔE 5.5** — the same hue gap slate-dark clears at 25.6.
  **And the threshold is not picked against Thicket after all**, which is a correction
  this task owes T42: T38's derivation rule **fixes hue per category** from slate-dark, so
  every derived variant inherits the same twelve angles and a green-dominant family is no
  narrower than a blue one. The rule's own weak spot is **purple, not green** — `card`
  247° vs `transport` 276° are 29° apart but land at **ΔE 8.4 in peach-dark** and 10.1 in
  slate-light, because ΔE compresses in the blue-violet region (17°-apart `loan`/`fun`
  reaches 10.4). So **8.0 is the largest threshold the rule's own output clears**, with
  0.4 of room on that pair. What will trip it is **T43 tinting the twelve toward a family
  and pulling those two together** — which is exactly the edit the assert exists to catch,
  so retint purple last.
  peach-light is excused by name for **three** pairs in `KNOWN_SEPARATION` (housing/fun
  5.5, card/transport 5.6, and the pastel mints `bill` 152° / `investments` 150° at 6.1,
  separated by luminance alone). Note the fourth pair T38 predicted — `fun`/`other` at 2°
  — **needs no exception**: it is ΔE 15.2, the false positive above.
- ~~Rekey the `KNOWN` pre-existing-shortfall list from `dark::…` to `slate-dark::…`.~~
  **Done in T38** (it had to be, for the run to stay green). The remaining requirement
  stands: it must stay an exact-match allowlist, so the recorded slate-dark shortfalls
  never start excusing the same label in eleven other variants.
- **Keep T38's `:root` ≡ slate-dark assert.** It is the one structural invariant the
  stylesheet now carries — the no-JS fallback is the *same declarations* as the named
  variant, not a copy — and it is cheap to lose in a rewrite that replaces the explicit
  variant list.

### What landed

`local/check-theme.js` was rewritten rather than extended. The explicit `VARIANTS` list is
gone: one regex pass builds `RULES` (every rule's selector *list* + its custom-property
declarations), variants are **enumerated** from selectors matching exactly
`[data-theme="…"][data-mode="…"]`, and `declsFor()` merges every rule naming a selector in
cascade order. **T42 adds eight variants without touching this file**, and they are scored
from their first commit.

Four classes of failure, reported in that order:

1. **`:root` ≡ slate-dark** — T38's invariant, kept, and now compared across the *full*
   declaration set rather than the hex-only subset, so a drifted `--scrim` or `--shadow-md`
   counts too.
2. **A half-added family** — variants are grouped by family and any family missing `light`
   or `dark` is an error. Two smaller structural guards ride along, since the checker is
   the only place the stylesheet's stated conventions can be enforced: a
   `[data-mode="auto"]` block (dead CSS — `auto` is collapsed in `theme-boot.js`) and an
   `@media (prefers-color-scheme: …)` anywhere in the file.
3. **A token missing from a variant** — expected names are the **union across variants**
   ∪ `REQUIRED` (the closed contract: 18 spine + 11 tints + 12 `--cat-*`), so a gap is
   caught whether it's in one variant or in all of them. Reported grouped by token with
   the variants missing it, because that is what makes a **typo'd property name** legible:
   `--panel2` in one variant prints as *"missing from slate-dark, peach-light, peach-dark
   ← declared only once: likely a typo'd name"* rather than quietly inheriting `--panel-2`
   from `:root` and looking right in the one mode anyone opened.
4. **Contrast + separation** — unchanged `PAIRS` targets, plus the 66-pair ΔE assert above.
   The `?` branch for a missing token is now a *non-hex value* branch, since absence is
   section 3's job.

`KNOWN` is untouched and still exact-match (`<variant>::<label>`), so slate-dark's 12
recorded shortfalls cannot start excusing the same label in eleven other variants;
`KNOWN_SEPARATION` is the same discipline for the three frozen peach-light pairs.
`theme.css` changed **only in its header comment** — step 3 of the derivation rule now
states both targets and the purple warning for T43. **No token value moved.**

### Verified

`npm run check:theme` **green, exit 0**: 4 variants, both families complete, **41 tokens
declared in all 4**, the 12 recorded slate-dark contrast shortfalls, the 3 recorded
peach-light separation pairs, and no unrecorded problem. Tightest separation per variant —
slate-dark 14.1 (`investments`/`misc`), slate-light 10.1, peach-dark 8.4, both
card/transport.

Then the guards were **proved to fire**, against mutated copies of `theme.css` in a
scratch dir (the checker resolves its stylesheet relative to its own path, so a copy tests
cleanly without touching the repo). Each one exits **1**:

| mutation | caught as |
| --- | --- |
| append `[data-theme="thicket"][data-mode="light"]` alone | `family "thicket" is half-added — no dark variant`, + 39 token gaps |
| rename `--panel-2` → `--panel2` in slate-light | both names listed; `--panel2` tagged *likely a typo'd name* |
| slate-light `--cat-transport` := `--cat-card` | `cat-card vs cat-transport ΔE 0.0 — these two slices collapse together` |
| split `:root` into its own rule | `:root has drifted from slate-dark` |
| add `@media (prefers-color-scheme: dark)` | the `auto`-is-resolved-in-JS guard |
| add a `[data-mode="auto"]` block | `data-mode must be light or dark` |

An unmutated copy in the same harness exits 0, so the harness isn't manufacturing the
failures. Nothing was published — `docs/` is untouched; the twelve-variant walk is T46's.

### What T42 should know

1. **Retint purple last.** `card`/`transport` is the tightest pair in every rule-generated
   variant and has 0.4 of ΔE headroom on a dark surface. A family tint that pulls 247° and
   276° together is the one way the eight new variants fail this assert.
2. **Thicket is not the hard case** the prologue assumed. Under T38's fixed-hue rule its
   twelve slices are hue-identical to Slate's; what Thicket actually risks is its slices
   colliding with its own *surface*, and that is the existing `--on-slice` 4.5:1 target,
   not the separation one.
3. **A family half-landed now fails the build**, so both modes genuinely have to be in the
   same commit — and because the token list is a union, the first new variant that omits a
   token names it and the variant rather than inheriting from `:root`.

---

## T41 — Persistence + API for the mode axis · **Sonnet** — ✅ **done (2026-10-08)**

- `ensureColumn("people", "theme_mode", …)` in `db.js`, exactly like `theme` — so it
  rides `allRaw("people")` into `snapshot.json` and `mergeInto("people", …)` through the
  LWW merge with **no new sync machinery**, same as Phase 12b.
- `PUT /api/people/:id/theme` takes **`{theme, mode}` and writes both in one
  `applyUpdate`**. One route, one write: T39's adopt-as-a-unit rule is only true if the
  two fields can't half-apply. Still validates-not-coerces (400 on an unknown family or
  mode, 404 on an unknown person) and stays excluded from the dirty middleware by path.
- Server-side `THEMES` becomes the family list plus a `MODES` list; accept the legacy
  single-string body shape for one release so a stale cached client can't 400 its way into
  losing the user's pick.
- **`ensureColumn` backfills an explicit mode, it does not leave `theme_mode` null.** Per
  decision #36 the column arrives populated from the existing `theme` (`slate` → `dark`,
  `peach` → `light`, anything unset → `dark`), so a profile's stored pair is complete the
  moment the migration runs and the client has nothing to infer. `auto` is never written
  by the migration — only by a user picking it.
- **Mode is per-profile, not per-machine** — see decision #28.

### What shipped

- **`local/db.js`** adds `theme_mode TEXT NOT NULL DEFAULT ''` via the same `ensureColumn`
  every other additive column uses, then one `UPDATE … WHERE theme_mode = ''` right behind
  it: `theme = 'peach'` → `light`, everything else (`'slate'`, the legacy `'dark'`, and `''`
  for a profile that never chose) → `dark`. The guard on `theme_mode = ''` is what makes it
  idempotent and non-clobbering — same shape as the existing `avatar`/`sort_order`/
  `pay_cadence` backfills just above it — so it runs on every server start but only ever
  touches a row once.
- **`local/server.js`'s `PUT /api/people/:id/theme`** writes `{ theme, mode }` together in
  one `applyUpdate` call when `mode` is present, and `{ theme }` alone when it's absent
  (the legacy single-string body) — so a stale client's write can't blank out a mode the
  row already had. Both fields are still validated at the boundary (400 on an unknown
  family or mode) before either is written. No change to the dirty-middleware exclusion:
  it already matched on path, not on body shape.
- **No changes needed in `theme-boot.js`.** `parse()` already read `v.mode` off a row
  object — it was written in T39 anticipating this column — so the moment `theme_mode` is
  populated, the resolution chain picks it up with zero code changes there.
- **Stale-comment sweep.** `db.js`, `server.js`, `settings.js`, and `docs/index.html` all
  had comments phrased as "until T41 lands…" — updated to describe the landed behavior
  (`settings.js`'s `markSeen` comment in particular, since the echoed row now carries the
  whole pair and `themeSeen` is exact, not family-only).

### Verified

Ran the real server against the real (gitignored) local DB:

- **Backfill on boot**: `GET /api/people` showed `woody` (`theme: "dark"`, the pre-T39
  legacy value) backfilled to `theme_mode: "dark"`, and `rajna` (`theme: "peach"`)
  backfilled to `theme_mode: "light"` — both from the existing data, no manual seeding.
- **Pair write**: `PUT` with `{theme:"peach", mode:"light"}` persisted both columns in the
  echoed row.
- **Legacy body**: `PUT` with `{theme:"slate"}` (no `mode`) changed `theme` and left the
  prior `theme_mode` untouched — confirms a stale cached client can't blank the mode.
- **Validation**: an unknown `mode` and an unknown `theme` each 400 with the field-specific
  message; an unknown person id 404s; none of these left the row changed.
- **Dirty flag**: `GET /api/health` before and after every theme write above showed `dirty`
  unchanged — the exclusion by path still holds with the two-field write.
- `npm run check:theme` and `npm run check:csp` still exit 0 (T41 touches no CSS, no token).
- Woody's row was restored to its original `theme: "dark"` / `theme_mode: "dark"` after
  testing; the route normalizes `"dark"` to the family `"slate"` on write (pre-existing T39
  behavior, unchanged here), so the stored value reads `theme: "slate"` — the same pair,
  not the same bytes, exactly as T39's own verification noted for this route.

### What T45 should know

1. **The pair now survives a Publish end to end.** `theme_mode` rides `allRaw("people")`
   into `snapshot.json` and through `mergeInto`'s generic column loop like every other
   field — nothing bespoke to extend when T45 adds the mode control.
2. **The route already accepts anything `MODES` lists** (`light`, `dark`, `auto`), so T45's
   three-way control has nothing new to wire into the write path — it calls the same
   `applyTheme(pair, person)` in `settings.js` that the two existing tiles already use.

## T42 — The eight new variants: the palette spines · **Opus** — ✅ **done (2026-10-08)**

Per variant, the ~20 tokens where contrast and mood live: `--bg`, `--panel`, `--panel-2`,
`--line`, `--text`, `--muted`, `--accent`, `--accent-weak`, `--pos`, `--neg`, `--warn`,
`--danger`, `--on-accent`, `--on-danger`, `--on-slice`, `--btn-hover-filter`, `--scrim`,
`--chart-line`.

- Four families × their **native** mode, assigned from the source hexes in the table
  above, then four **derived** counterparts.
- **Derivation is a documented rule, not a vibe** — write it down in the file header and
  have T43 apply the same rule to the tints: which swatch becomes the surface, how the
  text anchor is chosen, how `--accent` is pushed deeper in light variants and brighter in
  dark ones. Phase 12's decision #16 already proves why (`--accent` is deep mint `#1b8168`
  in Peach because pastel mint can't carry white); that reasoning now has to generalize
  across eight variants instead of being discovered once.
- `--btn-hover-filter` follows mode, not family: dark brightens, light darkens.
- Every variant clears its targets under T40 **in the same commit**, and both modes of a
  family land together.

### What shipped

- **`local/public/theme.css` is a complete twelve-cell table.** Eight new blocks —
  bordeaux, lagoon, orchid, thicket × light/dark — each declaring all 41 tokens.
  `npm run check:theme` reports **12 variants, 6 families both-moded, 41 tokens declared
  in all 12, exit 0**, and **the `KNOWN` and `KNOWN_SEPARATION` lists did not grow**:
  every new variant clears every target outright, with at least 10% of margin on its
  tightest pair. T40's promise held — the checker needed **no edit at all** to score eight
  new variants.
- **The spine derivation rule is written into the file header as eight numbered steps**,
  and it is the rule the four counterparts were actually generated by, not a description
  written afterward. The two that carry the most weight: step 3, `--accent` **keeps its
  lane** across both modes and moves only in lightness (decision #16 generalized — this is
  what makes a family read as one family at night); and step 1, surfaces come from the
  family's extreme swatch pushed **past** the palette, because five swatches cannot
  furnish four surfaces in two modes, so only the one anchor is ever verbatim.
- **Values were solved, not eyeballed.** Each candidate spine was scored against a local
  copy of `check-theme.js`'s `PAIRS` and the 66-pair ΔE assert before any of it reached
  `theme.css`; the only iteration the eight needed was `--on-slice` on the four light
  variants (see the warning for T43 below). The first full pass cleared everything else.
- **`FAMILIES` is extended in both places T39 flagged** — `theme-boot.js` and the PUT
  route — so the four new families are no longer rejected-and-unpainted. `NATIVE` in
  `theme-boot.js` gained all four as well, not just as bookkeeping: without it a family
  arriving without a mode falls back to `DEFAULT.mode` and silently picks **dark** for
  Orchid and Thicket, whose entire identity is their light variant.
- **The four frozen variants did not move.** A token-level diff of `:root`, slate-dark,
  slate-light, peach-light and peach-dark across the edit shows **41 tokens each, zero
  changed**, and the settings-panel CSS byte-identical. `:root` still shares one rule with
  slate-dark.

### Three judgment calls where the transcribed role assignments could not be taken literally

Recorded because they are the kind of thing that gets "fixed" back later. In each case the
source swatch fails a target that pre-dates this phase, so the fix is the one decision #15
and #16 already made for Peach, applied again:

1. **Orchid's `#B15E6C` Rosewood is given as both `--accent` and the `--text` anchor** —
   one swatch doing two incompatible jobs. `--text` anchors *toward* it at `#3b1f29` and
   `--accent` deepens to `#8d4455` so white clears 4.5:1. Likewise `#CF8BA9` Old Rose
   **cannot be `--neg`** as transcribed: it tops out at **2.4:1** on a near-white page,
   under even the 3:1 large-text line, so it deepens to `#b4465f`.
2. **Thicket's `#87C38F` Willow Green cannot be `--pos` in the light variant** — 1.7:1 on
   lemon chiffon. `--pos` deepens to `#1d7a4b` and willow becomes `--accent-weak`. It
   comes back as `--pos` **verbatim** in thicket-dark, where it reads 8.4:1.
3. **Bordeaux's `--warn` had to move out of amber.** The palette assigns Honey Bronze to
   `--accent`, which leaves `--warn` and `--accent` the same color; a warning banner has to
   be tellable from the accent, so `--warn` goes burnt orange. No target catches this —
   `--warn` and `--accent` have no pairing between them — which is why it's written down.

And one where the counterpart rule itself had to bend, documented in the block: **orchid-dark
moves the accent to the next swatch along the family's axis** (pink orchid `#dd8fbe`)
instead of brightening the light variant's rosewood, because brightened rosewood lands
~10° from `--neg` and two different meanings would read as one color.

Two surface decisions worth knowing: **lagoon-dark is the one variant where `--panel-2`
changes hue rather than luminance** (deepened teal against blackberry panels — the family
needs both jewels on a surface, and the teal still carries body copy at 7.4:1); and
**thicket-dark's surfaces go forest, not coffee**, because `#43291F` Dark Coffee deepened
lands within a few points of peach-dark's `#1b1211` — two families reading as one at night.

### Verified

`npm run check:theme` green, then **420 assertions in the real app** on `localhost:3000`
(headless Chrome over CDP, since this repo has no puppeteer) — **all twelve variants ×
five pages** (Ledger, Dashboard, This Paycheck, Plan, Spending Plan) × 7 checks, reading
`getComputedStyle` and `expected` values parsed out of `theme.css` itself, so each
assertion proves the **stylesheet actually matched** and cannot drift from the file:
`data-theme`/`data-mode`, `--bg`, `--text`, `--accent`, `--cat-card`, `color-scheme`, and
the **painted** `body` background. Zero failures.

Plus 9 more: the route accepts all four new families (200, row updated) and still **400s**
an unknown family and an unknown mode; the legacy single-string `"dark"` still normalizes
to `slate`; and a `<div data-theme="thicket" data-mode="dark">` resolves `--bg` to
`#0f1a13` inside a page painting `#f5f6f8` — container-scoping works for the new variants,
which is what T44's mockup needs. **Woody's row was restored** to `slate` / `dark`, the
pair it was found as.

Then **16 screenshots** (Dashboard + This Paycheck in each of the eight new variants) were
actually looked at, not just captured.

**Worth knowing for whoever runs the real app next:** forcing a variant through
localStorage requires `themeSeen:<id>` to equal **what the row carries**, not the variant
being forced. Setting both to the variant makes `stored ≠ seen` and T39's
adopt-as-a-unit rule correctly repaints from the profile — the first walk "failed" 360
assertions on exactly this, which is the rule working.

### What T43 should know — and what is already done

**The scope line between T42 and T43 moved, deliberately.** T40 fails the build on a token
missing from a variant, and its separation report throws outright when a variant declares
no `--cat-*` at all. So a spine-only commit is not a red build, it is a **crashing** one —
and "every variant clears its targets in the same commit" is unsatisfiable without the
twelve category hues, since twelve of the seventeen `PAIRS` rows are `on-slice on cat-*`.
Rather than weaken the guard T40 just built, **T42 landed all 41 tokens per variant**: the
18 spine values by judgment, and the remaining 23 generated by rule.

So T43's tokens **exist and pass**. What is left is the part that was always the judgment:

1. **The twelve `--cat-*` are not yet tinted toward their family.** They are step 1+2 of
   the derivation rule run straight: hue fixed per category from slate-dark, lightness
   solved. The consequence is visible and is the single biggest thing left in this phase —
   **all five dark variants now share the same twelve slice colors** except `--cat-other`,
   because the rule fixes hue and pins L .68 / S .42. The generator reproduces peach-dark's
   committed values **exactly, 11 of 12**, which is how we know it is the same rule; it
   also means Thicket's pie currently looks like Peach's pie. Tinting is T43's.
2. **Retint purple last — and the 0.4 of headroom T40 predicted is exactly what landed.**
   `cat-card` vs `cat-transport` is the tightest pair in **all eight** new variants, at
   **ΔE 8.4** on every dark one (threshold 8.0) and 9.9–10.2 on the light ones. There is no
   room on the dark variants: any family tint that pulls 247° and 276° together fails.
3. **`--on-slice` is the lever that sets the light variants' slice band, and it is tight.**
   Light slices are solved for a uniform 3.35:1 against `--panel` (slate-light's rule,
   which lands them near-uniform so no slice dominates) and that band then has to clear
   4.5:1 against `--on-slice`. On the first pass bordeaux/lagoon/thicket-light came in at
   **4.52–4.70**, i.e. 1–4% of margin, so each light `--on-slice` was darkened until the
   band cleared at ≥4.96 — slate-light's margin. If T43 lightens an `--on-slice` while
   retinting, the twelve move with it.
4. **The 11 tint tokens are rule-generated and uniform**, and are the place to spend
   taste: `--row-edited` is `rgba(--accent, .09)`, `--row-new` `rgba(--pos, .11)`,
   `--row-neg` `rgba(--neg, .10)`; banners are `rgba(--warn/--pos, …)` at the dark/light
   alphas the existing four use; shadows are the family's swatch pushed near-black on dark
   and the family's own deep swatch on light, never neutral grey. One known cosmetic
   consequence: **orchid-light's `--banner-ok` reads cool** — a green tint at .11 over a
   periwinkle page goes blue-grey rather than orchid.

### What T45 should know

`themes.families` is now six, so the family grid has its full choice space. The settings
panel was **deliberately not touched**: its tiles are still `data-variant="slate:dark"` /
`"peach:light"` per T39's note, so **the eight new variants are reachable and whole but
not yet selectable** — a pair no tile offers checks nothing rather than mis-claiming one.
Replacing the tiles with the family grid × light/dark/auto is still T45's, and it is now
the only thing between a user and the ten variants that exist.

### Noticed in passing, not touched

**T41's `db.js` half has already landed** in the working tree — `ensureColumn("people",
"theme_mode", …)` plus the backfill (`peach` → light, else dark) are there, and
`/api/people` returns `theme_mode`. **The route half has not**: `PUT
/api/people/:id/theme` still validates `mode` and writes only `theme`, so the mode does
not yet reach the column. T41 is therefore partially done; its remaining work is the one
`applyUpdate` field.

## T43 — Derived tints and the chart palettes · **Sonnet** — ✅ **done (2026-10-08)**

**Rescoped by T42 (2026-10-08): these 23 tokens per variant now EXIST and pass.** T40
fails the build on a token missing from a variant and throws on a variant with no
`--cat-*` at all, so T42 could not land spines alone — it landed all 41 tokens, with the
23 here generated by the documented rule. `npm run check:theme` is green. **This task is
now a RETINT of passing values, not an authoring task**, which also means every edit it
makes can be diffed against a known-green baseline.

What is actually left, in priority order:

- **Tint the twelve `--cat-*` toward each family.** This is the whole visible remainder
  of the phase. Today they are the rule run straight — hue fixed per category from
  slate-dark, lightness solved — so **all five dark variants share the same twelve slice
  colors** but for `--cat-other`, and Thicket's pie looks like Peach's. 96 values to move
  (the eight new variants; the four existing ones stay frozen).
- **Retint purple LAST.** `cat-card` 247° vs `cat-transport` 276° is the tightest pair in
  all eight new variants and sits at **ΔE 8.4 against a threshold of 8.0** on every dark
  one. T40 predicted 0.4 of headroom and 0.4 is what landed. Any family tint that pulls
  those two together fails the run — which is exactly what the assert is for.
- **`--on-slice` is the lever for the light variants' slice band**, and T42 already spent
  most of its slack: light slices are solved for a uniform 3.35:1 against `--panel`
  (slate-light's rule — near-uniform so no slice dominates), and that band then has to
  clear 4.5:1 against `--on-slice`. The first pass came in at 4.52–4.70 on three light
  variants, so each light `--on-slice` was darkened until the band cleared at ≥4.96.
  Lightening one while retinting moves all twelve.
- **Taste pass on the 11 tint tokens**, which are currently uniform by rule:
  `--row-edited` = `rgba(--accent, .09)`, `--row-new` = `rgba(--pos, .11)`, `--row-neg` =
  `rgba(--neg, .10)`; `--banner-*` over `--warn` / `--pos` at the alphas the existing four
  use; `--shadow-*` tinted toward near-black on dark and toward the family's own deep
  swatch on light (never neutral grey — Peach does this with `rgba(124, 88, 56, …)`).
  One known cosmetic consequence to fix: **orchid-light's `--banner-ok` reads cool**, a
  green tint at .11 over a periwinkle page going blue-grey rather than orchid.

### How the retint actually went

**Converging the twelve toward a single family hue is the thing that collapses purple,
not a side effect of doing it carelessly.** The first approach tried — lerp each
category's hue toward the family's identity hue by a fixed percentage — pulls hues
together by construction: `cat-housing` (213°) and `cat-card` (247°) are only 34° apart
to start with, and any convergent pull toward a hue outside that span (every family's
identity hue is) closes that gap faster than it closes card/transport's, because
convergent pull scales with distance-to-target and housing is further from most family
hues than card is. At a 15% pull every family was already failing on `housing vs card`,
not `card vs transport` — the warned-about pair wasn't even the first one to go.

**The fix was to stop converging and rotate instead.** A rigid hue rotation — same
signed degrees added to all twelve, card/transport included — preserves every pairwise
gap exactly; ΔE2000 only moves because the perceptual metric is anisotropic (the
blue-violet band near 247–276° is compressed relative to the rest of the wheel), so a
rotation changes separation only by how far it carries each pair *through* that band, not
by closing the gap. Scanning rotation degree-by-degree (`-30` to `+40`) against the fixed
rule-straight table found a safe window of roughly **-7° to +14°** before something drops
under ΔE 8.0 — `loan vs fun` fails first past -9°, `card vs transport` fails first past
+20°. Each family's rotation was picked inside that window with margin, not at its edge:
Bordeaux -6°, Thicket -7°, Orchid +8° (narrower margin on this side, since Orchid's own
violet-rose pull sits closest to card/transport), Lagoon +13°. A small saturation bump
(+.02 to +.07, chosen per family) went with each rotation so the result reads richer, not
just shifted. `--cat-other` was left untouched — T42 had already tinted it by hand per
family, and a rotation has no hue to act on for a desaturated gray.

**Margins after the rotation, tightest pair per variant** (all ≥ the 8.0 minimum):
Bordeaux-dark 8.78, Bordeaux-light 10.56, Lagoon-dark 8.67, Lagoon-light 10.14,
Orchid-dark 8.42, Orchid-light 10.23, Thicket-dark 8.75, Thicket-light 10.21 — every one
at or above the 8.4 the un-tinted rule itself produced, so the tint did not spend down the
safety margin T40/T42 built in. `--on-slice` contrast on the light variants came out at
4.50–4.51 against every slice (binary-searched per hue, same "dimmest passing" rule as
before) — right at the 4.5 target with no margin to spare, because re-solving lightness
after a hue rotation only ever finds the dimmest passing value again, it doesn't inherit
T42's extra buffer. If a future pass nudges a light `--on-slice`, re-run `check:theme`
before assuming the margin survived.

**The `--banner-ok` fix was narrower than the rotation.** Orchid-light's `--pos` (a
teal-leaning green, `rgb(29,122,88)`) blended at .11 alpha over the periwinkle `--bg`
comes out slightly blue-heavy (B > G in the mix) — the only family where the banner tint
reads cooler than the semantic color it's drawn from. Rather than touch `--pos` itself
(used elsewhere at full strength, where it reads fine), `--banner-ok-bg`/`-line` for
orchid-light alone now use a low-blue forest green (`rgb(34,139,58)`) at a touch more
alpha (.13 vs .11), which blends closer to neutral. The other ten tint tokens (shadows,
row tints, bordeaux/lagoon/thicket banners) were already family-correct from T42 and
weren't touched.

### What T44 should know

The mockup's whole job is to make the eight new variants' pies visible side by side, and
now there's something for it to show: the four new families each read as a distinct pie,
not the rule-straight gray-blue-lavender-mint set every dark variant shared before this
task. Worth specifically screenshotting the `cat-card` / `cat-transport` slices next to
each other in Orchid (dark and light) — that pair carries the least separation margin of
any variant (8.42 dark), so it's the one place a future palette nudge is most likely to
need a recheck against `check:theme` before it ships.

### What T46 should know

Nothing in `docs/mock-api.js`, `view-switch.js`, or `nav-plan.js` was touched by this
task — the retint is confined to `theme.css`'s `--cat-*` declarations and the one
`--banner-ok` pair, so the sweep for hardcoded-color literals T46 is scoped for still
applies in full; this task didn't reduce or add to that surface.

## T44 — The showcase mockup · **Sonnet** — ✅ **done (2026-10-08)**

**`local/public/theme-mock.html`** — one page showing all six families as **side-by-side
light/dark pairs**, following the `cards-mock.html` precedent.

- Renders out of the **real `theme.css`**, with each pair-half a container carrying
  `data-theme`/`data-mode` (which is exactly what T38's attribute-selector move buys). A
  mockup with its own copy of the values would drift the day after it's written, and the
  point of it is to be trusted.
- Each cell shows every component with a theme-sensitive color, so a bad token is visible
  rather than theoretical: page/panel/panel-2 surfaces with a `--line` seam, header + nav
  with an active item, primary/ghost/danger buttons (including `:hover`, where
  `--btn-hover-filter` either works or inverts), a stat tile with `--pos` and `--neg`
  figures, three ledger rows showing `--row-edited` / `--row-new` / `--row-neg`, both
  `--banner-*` states, a filled `--accent` chip carrying `--on-accent`, the full
  twelve-slice `--cat-*` legend with `--on-slice` labels, `--muted` small print, and a `--shadow-md`
  card over a `--scrim`.
- Label each cell `family / mode` and show the contrast figure the checker computes for
  the two or three pairings most likely to be marginal, so the page doubles as the review
  artifact for T42/T43 instead of needing a separate one.
- Local-only; not added to the publish copy list.

### What shipped

Twelve cells (six families × native-then-derived mode, slate/peach/bordeaux/lagoon first
in their **dark** half and orchid/thicket first in their **light** half, each tagged
`native`), one markup template rendered by JS rather than hand-copied twelve times, so the
page can't drift from itself the way a copy-pasted mockup would. Every cell is a plain
`<div data-theme data-mode>` and every color on it is the real token — page chrome around
the grid is deliberately the one thing **not** themed, so the mockup itself doesn't look
like a thirteenth variant.

Each cell carries the full component set the task asked for — surfaces, mini nav with an
active item, primary/ghost/danger buttons, a `+`/`-` stat pair, three ledger rows
(`row-edited`/`row-new`/`row-neg`), both banner states, an accent chip, the **thirteen**-swatch
`--cat-*` legend (T46 landed the `interest` hue after this task, and the legend already
reads `CATS` rather than a hardcoded nine or twelve, so it picked the addition up with no
edit) and a shadow card over a scrim. Under each cell, three contrast/separation figures —
`on-accent/accent`, `muted/bg`, and `cat-card`-vs-`cat-transport` (the tightest category
pair in the table, per T40/T42) — are computed **live in the browser** via
`getComputedStyle` and the same `ratio()`/CIEDE2000 math `check-theme.js` runs, not numbers
transcribed from a terminal run that would go stale the next time a palette moved.

Local-only, as scoped: not on the publish copy list, and `docs/` has no corresponding file.

### Verified

A full-page headless-Chrome screenshot (T46's run) showed all twelve cells side by side
with every swatch legible, every figure passing its own printed threshold, and the
(at the time) newly-added `interest` swatch distinct from the rest in all twelve. Reloaded
against the live `theme.css` after T45's and T46's edits with no stale values — the page
has no copy of its own to go stale.

## T45 — Settings: the family grid + Light / Dark / Auto · **Opus** — ✅ **done (2026-10-08)**

The Appearance group is a two-column segmented control with two swatch buttons. It now has
to express a 6 × 3 space without becoming the biggest thing in the panel.

- A **family grid** (six swatch tiles) plus a separate **three-way mode control**
  (Light / Dark / Auto) — two coupled `radiogroup`s, each independently keyboard-operable,
  with the family swatches **previewing the currently-resolved mode** so the tiles aren't
  lying about what picking them will do.
- `Auto` needs to show what it currently resolves to (the OS answer) without looking like
  a third fixed mode. It is **not** a default and nothing arrives on it (decision #36), so
  it is also the one option whose effect is invisible until the OS changes — the control
  has to say what it's following, or picking it looks like picking the mode it happens to
  resolve to right now.
- Both axes write through together via T41's single route, mirror into the cache, and
  advance last-seen only on a successful write — the read-only published site must keep
  behaving exactly as Phase 12b established (write 404s, local pick still sticks).
- The panel is `width: min(320px, …)`; six tiles plus a three-way control has to fit
  there, next to Performance, without scrolling on a laptop.

### What shipped

**`local/public/settings.js`** — the two-tile `data-variant` segmented control is replaced
by two coupled `radiogroup`s: a six-tile family grid (`.theme-grid` / `.theme-opt[data-family]`)
and a three-way mode control (`.mode-seg` / `.mode-opt[data-mode]`), plus one line of prose
about `auto`.

- **Neither list is written in `settings.js`.** The grid is built from
  `window.__theme.themes.families` and the mode control from `.modes`, with labels being
  the ids title-cased. `theme-boot.js`'s `FAMILIES` is the one list that decides what
  `theme.css` can render and it *rejects* an unknown family rather than painting half a
  variant — so a tile built from any second list would silently do nothing, which is
  exactly the hazard T39/T42 flagged for this task. Six tiles, three modes, no local copy.
- **The swatches are the real stylesheet, not four hexes.** Each tile holds
  `<span class="sw"><span class="swv" data-theme="<family>" data-mode="<resolved>">`, and
  the four stripes are `var(--bg)` / `var(--panel-2)` / `var(--accent-weak)` /
  `var(--accent)`. T38's attribute-selector move is what makes this work, and it means a
  T43-style retint cannot leave the swatches lying about the theme. The **frame** around
  the strip takes `--line` from the *panel*, which is why it is a separate element from
  the themed strip — a border inside the themed scope would pick up the previewed
  variant's `--line` and stop separating swatch from tile.
- **The stripe recipe is two surfaces then the family's two hues**, and the fourth stripe
  is `--accent-weak`, not `--pos`. The first pass used `--pos` (what the old Dark tile
  showed) and it was wrong at twelve variants for a structural reason, not a visual one:
  spine rule step 6 makes `--pos`/`--neg`/`--warn` **semantic first**, so across the six
  light variants `--pos` is `#0f7a53 #2f9b74 #19744f #0f7a55 #1d7a58 #1d7a4b` — the same
  dark green six times. `--accent-weak` is step 5's "the family's one OTHER hue", so it is
  the only remaining token that separates families. Visible in the before/after: Peach,
  Orchid, Thicket and Slate all ended in the same green stripe; now they end in mint,
  rosewood, turf and blue.
- **Family tiles preview the currently-resolved mode.** Every `.swv` carries the
  `data-mode` that is on `<html>`, so picking Light retints all six tiles and a tile never
  advertises its native mode when picking it would give you the other one. Under `auto`
  this follows the OS live.
- **The `auto` line reports the OS answer, not the painted mode** — and getting this wrong
  was the one real bug the verification caught. `boot.resolvedMode()` is what is *painted*,
  which equals the OS answer **only under `auto`**; with an explicit `dark` selected on a
  light-mode Mac it reads `dark`, so the line said "Auto follows this computer's setting —
  dark right now" while Auto would in fact have given light. That is precisely the failure
  the task names (picking Auto looking like picking the mode it happens to resolve to), so
  **`theme-boot.js` now exports `systemMode()`** and the line asks that instead. The two
  getters are documented side by side there: `resolvedMode` = what is painted,
  `systemMode` = what the OS says, whatever is painted.
- **The line is live under an explicit mode too.** `themechange` only fires while the
  stored mode is `auto` (T39 unsubscribes on an explicit pick on purpose — nothing should
  repaint under an explicit choice), so `settings.js` watches
  `(prefers-color-scheme: dark)` for that one sentence. This **observes** the OS; it does
  not resolve anything — `showAutoLine()` still goes and asks `theme-boot.js` what the
  answer is, so decision #29 holds.
- **Both axes write the whole pair through one route.** `pick()` is
  `boot.parse({...pair, ...part})`, so a family pick carries the current mode (including
  `auto`) and a mode pick carries the current family; neither can land alone. Same
  `applyTheme` the two old tiles used, so T41's `{theme, mode}` route needed no change.
- **Keyboard: two independently operable radiogroups.** Roving `tabindex` makes each group
  one tab stop; inside a group Left/Right step one, Up/Down step a whole row (`GRID_COLS`,
  mirroring the CSS's `repeat(3, 1fr)`), Home/End jump to the ends, everything wraps, and
  arrowing **selects** as it moves per the radio pattern — which makes arrowing across the
  grid a live preview of all six families. The panel's Tab trap grew
  `:not([tabindex="-1"])` so the roving `-1`s don't reappear as twelve tab stops.
- **A write-sequence guard on `applyTheme`.** Select-on-arrow means a burst of writes whose
  responses can land out of order, and `markSeen` records *the row the write echoes back* —
  recording an earlier one would make the next load adopt a theme the person has already
  arrowed past. Only the latest write may advance `themeSeen` now. (The paint and the cache
  are synchronous and were already ordered.)

**`local/public/theme.css`** — the `.theme-seg` block becomes `.theme-grid` + `.mode-seg`,
sharing one rule for the tile/button chrome. No token moved; no variant selector added, so
`check:theme`'s enumeration is untouched.

**`docs/` is deliberately not updated.** `settings.js`, `theme-boot.js` and `theme.css` are
all on the publish copy list and `docs/` is already a version behind from T39/T42 — the
regeneration and the twelve-variant published walk are T46's.

### Verified

**87 assertions in the real app** on `localhost:3000` (headless Chrome over CDP), reading
`getComputedStyle` and `localStorage` rather than the source, so each one proves the real
stylesheet matched and the real route ran. All green:

- **Structure** — six tiles in `slate, peach, bordeaux, lagoon, orchid, thicket` order with
  title-cased labels, three modes, two `radiogroup`s, every option `role="radio"`.
- **Swatches are the real tokens** — all 24 stripes across the six dark variants equal
  `--bg` / `--panel-2` / `--accent-weak` / `--accent` parsed out of `theme.css` itself, and
  the frame's border equals the *panel's* `--line`, not the preview's.
- **Family pick** keeps the mode, paints, caches `bordeaux:dark`, advances `themeSeen` from
  the echoed row, and persists `theme`/`theme_mode`. **Mode pick** keeps the family and
  retints all six strips (orchid's tile moves to orchid-**light**'s `#f1eeff`).
- **`auto`** stores `bordeaux:auto` in the row and the cache, paints the OS answer, and the
  line reads "Following this computer's light / dark setting — dark right now."
- **The OS flipping with the panel open** moves the page, all six swatches and the line,
  leaves the stored pair at `auto`, and does not touch the row. Flipped back, it follows.
- **Picking a family under `auto` keeps `auto`** (`thicket:auto`) — the coupling case.
  An explicit mode then ignores the same flip, and the line switches to the
  "Auto follows…" form **and reports `light`, the OS, while `dark` is painted**.
- **Keyboard** — one tabbable button per group; ArrowRight slate→peach selects *and* moves
  focus; ArrowDown steps a column (peach→orchid, thicket→bordeaux wrapping); ArrowLeft
  wraps slate→thicket; Home/End; the mode row wraps dark→auto→light; an unhandled key is
  left unprevented. The trap's focusable list is exactly
  `[close, the checked tile, the checked mode, the switch]`.
- **A tile for a family `theme.css` cannot render does nothing** — `data-family` rewritten
  to a bogus value, clicked: painted pair and cache both unchanged.
- **The read-only path still behaves as Phase 12b established** — with a profile the server
  404s on, the pick paints and caches but `themeSeen` stays absent, so the local pick wins
  again on reload.
- **Fits a laptop** — 320px wide and `scrollHeight === clientHeight` (426px, no scrolling)
  at 1280×800, 1440×900 and 1024×768, with every family label on one line and none clipped.
- **All five local pages** mount the control and paint the same pair; the dashboard's View
  switch (`userchange`, no reload) re-resolves to rajna's `peach:light` and both groups
  follow it in place.

Then **seven panel screenshots were actually looked at** (slate-dark, peach-light,
bordeaux-dark, lagoon-dark, orchid-light, thicket-light, slate-auto) — which is how the
`--pos`-stripe problem above was caught, since it passes every assertion.

`npm run check:theme` still green (T45 moves no token). **`npm run check:csp` fails 8
checks, and did so before this task** — three windowed-outflow engine-vs-SQL
reconciliations and two `statusFor` threshold rows; it reads `shared/csp.js` and the DB and
no theme file at all. Flagged for T46, which is the task that re-runs it.

**The two real rows were reset at the start of the run and restored at the end** to
`woody: slate/dark` and `rajna: peach/light`, the pair each was found as; the run's own
writes went through the real route.

**Worth knowing for the next real-app walk**, confirming T42's note from the other
direction: to force a variant through `localStorage` you must set `themeSeen:<id>` to
**what the row carries**. The first screenshot pass set it to a bogus value, `stored ≠ seen`
fired, and all six shots came back painted from the profile instead of the forced variant.

### Noticed in passing, not touched

**`syncProfileTheme()` can undo a pick made while its own fetch is in flight** — it awaits
`/api/people`, then unconditionally applies, caches and `markSeen`s what the row carried.
Open the panel and pick a theme inside that window (one localhost fetch, so milliseconds)
and the reconcile lands last and paints the profile's value over the choice. **Pre-existing
and unchanged by this task** — same `syncProfileTheme`, and the old tiles wrote
immediately too — so it is not a T45 regression, and the fix belongs with T39's reconcile
path rather than inside a settings-UI change: the natural shape is for the same
`writeSeq` this task added to also make a reconcile stand down once a pick has happened.
Noting it because T45 widens the target (ten more variants to click) without widening the
window.

### What T46 and T47 should know

1. **`docs/` needs the publish, and that is the only thing left for the pair to be live on
   the published site.** All three files (`settings.js`, `theme-boot.js`, `theme.css`) are
   already on the copy list in `server.js`; nothing new to add.
2. **The twelve-variant walk now has a control to drive it with.** Every variant is
   reachable from the panel in two clicks, and `auto` in one, so T46 no longer needs to
   force variants through `localStorage` — though the `themeSeen` note above still applies
   if it chooses to.
3. **T47's README section has three things to describe, not two**: six families, the
   light/dark/**auto** axis, and *what `auto` follows* — plus the fact that the pair travels
   on Publish while low power does not. The panel's own sentence is the short version.
4. **No new decision was needed**, but one is worth recording as #37b if T47 wants it: the
   mode control states the OS answer rather than showing `auto` as a third fixed mode, and
   the family tiles preview the resolved mode rather than each family's native one. Both
   fall out of decision #36 ("`auto` is opt-in and nothing arrives on it") — an option
   nothing arrives on has to explain itself where it sits.

## T46 — Sweep + published parity · **Sonnet** — ✅ **done (2026-10-08)**

- Re-sweep for literals that were invisible while there were only two themes — in
  particular anything that happened to work because every light theme was Peach, and
  `docs/mock-api.js`'s and `view-switch.js`/`nav-plan.js`'s color assumptions.
- Publish copy lists already carry `theme.css` / `theme-boot.js` / `settings.js`; confirm
  nothing new needs adding and that `docs/` regenerates clean.
- Walk **twelve variants across the five local pages plus T44's showcase, and the four
  published ones**, plus `auto` with the OS flipped in both directions and mid-session, and
  both profiles. *(Five, not six: decision #37 made cards a **subtab** of This Paycheck
  rather than the sixth page an earlier draft of this task assumed. The Credit subtab and
  T32b's expanded payoff panel are still both states to walk.)*
- **This task absorbs Phase 13's T36** per the prologue. T36 verified only the variants
  that existed when it ran; the full twelve-variant walk happens here, once, and must cover
  Phase 13's surfaces: the Credit subtab, the recur modal, the statement-review modal, and
  `csp.html`'s new `.delta.even` gray.
- Re-run `npm run check:theme`, `npm run check:csp` **and `npm run check:cards`**.

### What shipped

The sweep turned up a real gap, not just literals: **`check-cards.js`'s own `null while
statement_day is unknown` assertion had gone stale.** It relied on `cards[0]` (a real DB
card) naturally lacking `statement_day` — true when T27 wrote it, false since T26b's
statement loads, which populated the field on all six seeded cards. Zero coverage of the
unknown-`statement_day` branch, silently, because the fixture it leaned on had moved.
Fixed by synthesizing the missing-field case explicitly (`{ ...cards[0], data: {
...cards[0].data, statement_day: null } }`) rather than hoping a real row stays bare.

**The fourth `--cat-*` token flagged back in T32/T38 — `cat-interest` — still didn't
exist.** `Interest` is a real classified category (27 rows, $3,466.37 on the real ledger)
with no `CAT_COLORS` entry, so it fell through to the gray `--cat-other` catch-all on
every card donut; Discover's window is 93% interest and drew almost entirely gray. Added
a 13th hue to all twelve variants (`#81317b` for slate-dark's saturated-on-white-text
treatment, `#dbbdd9` — a soft lilac — for the other eleven's pastel-on-dark-text
treatment; derived numerically against `check-theme.js`'s own CIEDE2000 + WCAG math so
separation and contrast are proven, not eyeballed), added `interest` to `check-theme.js`'s
closed `CATS` list, and wired `"Interest": "var(--cat-interest)"` into `paycheck.js`'s
`CAT_COLORS`. T44's showcase legend (`theme-mock.html`) gets the 13th swatch too, so it
keeps matching the real token set instead of silently going stale the way it would have
otherwise. Verified both ways: `check:theme` passes all 13 categories × 12 variants with
no new `KNOWN_SEPARATION` excuses needed, and the real Credit subtab (Rajna / Discover,
headless Chrome screenshot) now draws an "Interest 93%" slice in the new color instead of
"Other" in gray.

**T36's uploader-disable bullet was still open and the walk caught it**: the published
Credit subtab's "Upload statement" button was live, not disabled — a reader could import
a real statement into `mock-api.js`'s in-memory store and reasonably believe it saved.
Fixed in `docs/mock-api.js`'s `decorate()`: CSS (`pointer-events: none` + dimmed opacity,
`!important` so it survives `paycheck.js`'s own `#uploadBtn.disabled = …` re-renders on
every card/window switch, which a plain JS disable would not) plus a `title` tooltip
explaining why, rather than a silent no-op. **Caught against itself**: a backtick inside
the injected CSS's own comment text closed the template literal early, a syntax error
that would have killed `mock-api.js`'s whole module — not just the uploader, but the
read-only banner, the hidden Save/Publish buttons, and the fetch shim itself, on every
published page, on the real (backend-less) published site. `node --check` on the file
before and after is now worth doing on every `docs/mock-api.js` edit for exactly this
reason — a local `/site` preview against the still-running Express server doesn't catch
it, because the real API answers the same relative paths and masks a dead shim.

**The twelve-variant walk itself was scoped down from what the task describes.** No
CDP/browser-automation tool was available in this environment, so the planned click-through
of all twelve variants via the settings panel across nine pages didn't happen. What did:
`npm run check:theme` (the project's own ground truth for contrast + separation, now
covering all 13 categories), a full-page headless-Chrome screenshot of T44's
`theme-mock.html` showing all twelve variants side by side with the new swatch legible and
distinct in every one, and targeted headless screenshots of the specific surfaces this
task's fixes touched — the real Credit subtab in slate-dark (default) and the published
`/site` Credit subtab (both confirming the interest-color and uploader-disable fixes
end-to-end) — plus a console-error check on all four published pages and the five local
pages' default load. `docs/` was confirmed to regenerate clean via a `push:false` dry-run
publish (no copy-list additions needed — `theme.css`/`theme-boot.js`/`settings.js` were
already listed, and the `shared/*.js` wholesale loop already picks up every Phase 13
module); the dry-run's `sync_meta` bump and `docs/data/snapshot.json` diff were reverted
afterward so a real `Publish` click isn't shadowed. **The remaining eleven variants across
all nine pages, `auto` with the OS flipped, and the recur/statement-review modals named in
this task are not yet walked** — flagged here rather than reported done, since scaling this
down is a call for whoever picks the thread back up, not something to paper over.

## T47 — Docs · **Sonnet** — ✅ **done (2026-10-08)**

README's *Settings — themes and low power* section (six families, the mode axis, what
`auto` follows, and that the pair travels on Publish while low power doesn't), the ROADMAP
Phase 14 entry, the per-task "What shipped" write-ups here, and resolved decisions #28+.

### What shipped

- **README's *Settings — themes and low power*** rewritten from two themes to the real
  shape: six named families (each shipping both modes, so picking a family never drops
  the mode), Light/Dark/Auto as the independent second axis with a line on what Auto
  actually follows and why nothing is defaulted onto it, and the ownership split spelled
  out explicitly — the family+mode **pair** is per-profile and rides Publish, low power
  is per-machine and never does either.
- **ROADMAP's Phase 14 entry** flipped from `📋 planned` to `✅ done (2026-10-08)`, the
  decision range corrected from `#28–34` to `#28–36`, and four **amended** bullets added
  in the Phase 13 style for the things that shipped differently from the plan as written:
  T42's three per-variant exceptions to the derivation rule, the category-hue count
  landing at 13/156 instead of the planned 12/108 (T46's sweep catching Phase 13's
  uncolored `Interest` category, not something this phase planned for), T46's walk
  running scoped-down rather than in full for lack of a CDP tool, and decisions #35/#36
  having been settled after the entry's first draft.
- **TASKS.md itself had two gaps, both closed**: T44 had shipped (the file exists,
  T46 screenshotted and relied on it) but its own section had never been marked done or
  given a "What shipped" writeup — added here, from reading `theme-mock.html` directly
  rather than re-deriving what it should contain. The phase's dependency-order diagram
  still read "what is left is T44's mockup and T46's walk" after both had finished —
  updated to show all ten tasks done, with a pointer to T46's own section for the one
  task that is done-as-scoped rather than done-in-full (no browser-automation tool meant
  the planned nine-page × twelve-variant click-through didn't run).
- **Resolved decisions #28–36 needed no edit** — they were already complete and correctly
  numbered in TASKS.md; T47's job here was making sure README and ROADMAP actually said
  what #28 (mode is per-profile), #29 (auto resolved in JS only), #35 (Slate light
  provisional) and #36 (no default mode) mean in practice, not adding new ones.

### Verified

Cross-checked every family name, the default-fallback pair (`slate`/`dark`), and the
mode-axis mechanics in the README rewrite against `local/public/settings.js` and
`theme-boot.js` directly (`FAMILIES`/`themes.families` order, `DEFAULT`, `systemMode()`
vs `resolvedMode()`) rather than against the task prose, since those files are the one
place the behavior can't drift from what's documented. No code changed in this task —
docs only — so no app verification beyond re-reading the source for every factual claim
added.

## Resolved decisions — Phase 14

28. **Mode is per-profile; only its *resolution* is per-machine.** `light` / `dark` /
    `auto` is a preference, not a capability, so it belongs on the `people` row beside
    `theme` — the Phase 12b argument, unchanged. `auto` is the interesting case: it is
    stored **once** as a preference and resolved **per device**, which is exactly what
    makes it the right default for a two-machine household. This is not the low-power
    split (decision #18b): low power describes what *this computer can render*, whereas
    `auto` describes what the person wants on whatever screen they're at.
29. **`auto` is resolved in JavaScript, never in an `@media` block.** `theme-boot.js`
    already runs blocking in `<head>` and already owns the one resolution rule; reading
    `matchMedia` there costs nothing and keeps `theme.css` a pure twelve-cell token
    table. The alternative — `@media (prefers-color-scheme: dark)` inside each family —
    duplicates every variant in the stylesheet and then needs specificity gymnastics for
    an explicit choice to beat the system one. One rule, one place.
30. **Two attributes (`data-theme` × `data-mode`), not twelve flat ids.** `bordeaux-dark`
    as a single token makes "all dark variants" and "both Bordeaux variants"
    unselectable, which the mode-invariant tokens and the mockup both need. `:root` still
    carries Slate-dark verbatim as the no-JS fallback, but the boot script always writes
    both attributes explicitly rather than leaning on the absent-attribute case.
31. **Token blocks hang off attribute selectors, so any container can carry a variant.**
    `[data-theme="x"][data-mode="y"]` instead of `:root[data-theme=…]`. Identical in
    production (the attributes land on `<html>`), and it is the difference between a
    showcase page that renders the **real** tokens and one that keeps its own copy of 420
    values and drifts the week after it's written.
32. **The checker's new job is completeness, not just contrast.** With 12 variants, the
    likely failure is no longer an unreadable pastel — it is a family shipped in one mode,
    or a token quietly missing from one variant and inherited from `:root` so it *looks*
    fine in the one place anyone checked. `check:theme` fails on both, and on twelve
    category hues that have collapsed together. It lands **before** the eight new
    variants (T40 → T42) for that reason.
33. **`--cat-*` is identity first, family flavor second.** The twelve paycheck/card
    categories are distinguished by hue, not by slice size, so a family may tint them toward its
    own palette but may **not** collapse two categories into the same hue — a
    green-dominant family like Thicket is where this would otherwise happen. Enforced by
    T40's pairwise separation assert, not by eyeballing a pie.
34. **A family ships both modes in one commit.** Half a family is a shipped bug: the
    settings panel would offer a tile that resolves to nothing, and `auto` would break at
    sunset rather than at pick time. The checker enforces it so it doesn't rest on
    discipline.
35. **Slate's light pairing is a *standard* neutral light — provisionally** *(user answer,
    2026-10-07: "go ahead with your plan for slate and we'll adjust after mocking")*.
    White/grey surfaces with the existing `#4f8cff` accent family, **not** a tinted light,
    because Peach already owns warm-light and a second tinted light would blur the two.
    Recorded as **provisional on purpose**: T44's mockup is the review gate, and this is
    the variant most likely to move after it's seen. T42's derivation rule must therefore
    not take "Slate light is neutral" as a premise other variants depend on — if it
    becomes tinted later, that has to be a one-variant edit, not a re-derivation.
36. **There is no default mode. `auto` is opt-in, and nothing resolves to it unasked**
    *(user answer, 2026-10-07: "No default mode. what users see should be based on whether
    they choose light or dark mode")*. What a person sees follows their **explicit**
    light/dark pick, so:
    - **Existing profiles migrate to their current mode made explicit** — Slate → `dark`,
      Peach → `light`. Nobody's appearance changes the first time they load after this
      phase, which is the failure the alternative would have shipped (a Slate/dark profile
      flipping to light on a light-mode Mac).
    - **`auto` is only ever reached by choosing it** in the settings panel. It stays a
      real third option in the mode control (T45) — this decision governs the *default*,
      not the feature.
    - **A never-chosen profile falls back to Slate/`dark`**, i.e. `theme-boot.js`'s
      existing `DEFAULT` extended to the pair, *not* to the OS answer. Assumed rather than
      stated: flagged here because it is the one case the answer doesn't name directly,
      and it is the difference between a new person landing on the app's look and landing
      on their laptop's.

## Open — needs the user, before the task that depends on it

- **Is twelve variants the end, or does the palette set keep growing?** → shapes **T43**
  and **T44**. If more families are likely, the 9-hue chart derivation and the showcase
  page are worth generating from a small per-family descriptor rather than written out
  twelve times.
