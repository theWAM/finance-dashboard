# Financial Dashboard

A **two-part system** that unifies the currently-scattered personal-finance artifacts — the Google-Sheets tracking ledger, the `fin_plan.html` strategy, the Apple Card detail, and the spending chart — into **one space**, and continuously answers one core question:

> **Is the strategic plan still in sync with reality (the ledger), and are we on track against the metrics all these pages care about?**

The whole point is consolidation: instead of a ledger in one place and a strategy in another that silently drift apart, the dashboard holds the ledger *and* the plan targets together so sync is computed automatically. Beyond monitoring, it's also the **day-to-day driver** for two people — a "who are you?" entry that personalizes the view, a per-person **This Paycheck** 2-week planner (the spreadsheet's short-term job, with negative-balance guardrails), and a **Daily Check** that reconciles projected vs. actual bank balances.

This is a **shared, two-person system** (joint finances). Each person runs their own local app; the published site is the common meeting point. Because the site is hosted on **GitHub Pages (static — the published view can't have a server)**, authoring and viewing are separated, and the published snapshot doubles as the sync hub between the two local apps:

```
   PERSON A                          THE SITE (GitHub Pages)                    PERSON B
┌───────────────────────┐                                              ┌───────────────────────┐
│ LOCAL APP (Node+SQLite)│  ── publish (push) ──▶  ┌──────────────────┐ ◀── publish (push) ──   │ LOCAL APP (Node+SQLite)│
│ • editable ledger      │                         │  snapshot.json    │                        │ • editable ledger      │
│ • plan targets & goals │  ◀── refresh (pull) ──  │  + version + time │  ── refresh (pull) ──▶ │ • plan targets & goals │
│ • metrics + sync engine│                         │  PUBLISHED VIEW   │                        │ • metrics + sync engine│
│ • last-synced version  │                         │  (read-only)      │                        │ • last-synced version  │
└───────────────────────┘                         └──────────────────┘                        └───────────────────────┘
```

- **Local app (×2)** — each person runs their own **Node + SQLite** app (local-only, no auth). All editing happens here; metrics/sync recompute live.
- **Published view + snapshot** — the static site renders the read-only dashboard *and* hosts `snapshot.json`, which is both what visitors see and the payload each local app pulls to catch up on the other person's changes.
- **The bridge is bidirectional.** Each local app can **publish** (push its data up as the new snapshot) and **refresh** (pull the latest snapshot down and merge it into its own SQLite). This is what keeps two people eventually consistent.

## Confirmed decisions

- **Two-part system:** local authoring app + read-only published view on GitHub Pages. The **published view has no server** (Pages can't host one); the local app may.
- **Local app stack = Node + SQLite.** A small Node/Express server backed by a local SQLite file, run on your machine.
- **Access = local-only, no auth.** The authoring app runs on localhost and is never exposed; no login needed.
- **Ledger is built in and editable** in the local app; live-updating cells are the source of truth. The exported Google Sheet is retired.
- **Plan targets are migrated into the app.** The strategic assumptions currently living in `fin_plan.html` (payoff targets, savings-goal allocations, investment cadence, Coast FIRE targets) become first-class, editable data in the app — making it the single home for both the ledger and the strategy, and enabling automatic sync. `fin_plan.html`'s content is absorbed; the published view becomes its successor.
- **Published snapshot contains real numbers and is public.** ⚠️ _Accepted trade-off:_ the Pages site is public, so real balances, debts, income, and payoff dates are visible to anyone with the URL and persist in public git history. Chosen deliberately over sanitized/gated options.
- **First feature = Debt payoff sync** — compare the migrated Apple Card & Discover payoff targets against actual ledger payments and re-project real payoff dates.
- **Two-person shared system.** Both people run a local app and share one published snapshot; changes on one side propagate to the other via publish → refresh. Requires versioning, timestamps, and both automatic and manual refresh (see below).
- **Conflict strategy = per-record last-writer-wins merge**, using record `updated_at` + `deleted_at` tombstones.
- **Transport = HTTP GET for refresh (pull), git commit/push for publish.**
- **Dedicated repo.** The dashboard lives in its **own repository** (this one), separate from the portfolio site, with its own free GitHub Pages project site linked from the portfolio. This isolates push access (a partner gets access to finances only, not the whole portfolio) and keeps the portfolio a clean static site. Hosting stays free because the repo is public (free-tier Pages requires public repos).
- **Current-user selection (no auth).** On load, a popup asks **who you are — Woody or Rajna** (stored client-side, no login). The choice personalizes _personal-scope_ views; it is not a security boundary. Applies to both the local app and the published view.
- **Personal scope + shared goals.** Each person has their own paycheck, bank/checking account, and cards. Personal views (This Paycheck, Daily Check, personal debts) reflect the selected person; **savings goals (Wedding, Emergency, Vacation, Apartment) are shared** and common to both.
- **Per-person accounts, merging later.** Two separate checking accounts today (one per person; the current CSV ledger is really Woody's account), with a design path toward a joint account later. Every ledger/target record carries an **`owner`** (`woody` | `rajna` | `shared`).
- **Reusability is the ultimate goal (design principle, not a current pivot).** The system should work for a **single person, a couple, or an N-person household** with minimal change. Build accordingly — see the Reusability note below. No restructuring now; just avoid choices that would be expensive to generalize later.

_All decisions are now settled — nothing blocks the build._

---

## Repo layout

```
finance-dashboard/
├── local/              # Node + Express authoring server (runs on localhost; NOT published)
│   ├── server.js       # Express app: serves the editor + JSON CRUD API, owns the publish step
│   ├── db.js            # SQLite connection + schema (people, accounts, transactions, plan_targets, sync_meta)
│   ├── import-csv.js    # one-time importer: exported sheet CSV → an account's ledger (reconstructs balance)
│   ├── seed-*.js, categorize-cards.js, load-card-statements.js, backfill-transfers.js
│   │                    # hand-run, idempotent data/backfill scripts (CSP targets, card rules, T26b's
│   │                    # direct statement load, T34's transfer_id backfill) — never through the app's CRUD
│   ├── check-*.js       # read-only acceptance harnesses, one per phase/feature, each `npm run check:*`:
│   │                    # check-csp.js, check-cards.js, check-rules.js, check-import.js, check-bulk.js,
│   │                    # check-theme.js — every one reconciles the shared engine against independent SQL
│   ├── public/          # the editable UI: index.html (Ledger) + app.js, dashboard.html/js, paycheck.html/js
│   │                    # (This Paycheck + the Credit subtab), plan.html/js, csp.html/js (Spending Plan),
│   │                    # settings.js, timeframe-ui.js / view-switch.js / pairing.js (small mountable
│   │                    # controls shared across pages), theme.css / theme-boot.js
│   └── dashboard.db     # local SQLite DB — gitignored, private to each machine
├── shared/              # Pure logic, zero-dep, browser + Node — copied verbatim into docs/shared/ on publish
│   ├── merge.js, snapshot.js       # per-record LWW merge (+ tombstones); snapshot.json build/parse
│   ├── metrics.js, drift.js        # running balance / metric computations; plan-target drift + status
│   ├── timeframe.js, paycycle.js   # the shared timeframe control's preset math; pay-cycle anchoring
│   ├── csp.js, csv.js, recurring.js   # the CSP compute engine; CSV parsing; recurring-charge generation
│   ├── cards.js         # card debt/coverage/payoff-schedule engine (Phase 13) — cardDebt, cardCoverage,
│   │                    # statementCycle/statementBalance/minimumDue, payoffSchedule/payoffScenarios
│   ├── transfers.js     # the paired-transfer engine (T34): auditTransfers, the single `KNOWN_UNPAIRED`
│   │                    # exception list shared by check:transfers and check:cards
│   ├── statement-import.js, card-import-spec.js   # per-issuer CSV adapters + the external_id fingerprint
│   │                    # spec, shared verbatim between T26b's hand loader and the in-app uploader
│   └── card-rules.js    # merchant → category rule matching + precedence (T30)
├── docs/                # Static read-only site served by GitHub Pages (Pages source = master:/docs)
│   ├── index.html, ledger.html, paycheck.html, csp.html   # read-only mirrors of the local pages
│   ├── shared/           # `shared/*.js`, copied verbatim by the publish step — not hand-edited here
│   └── data/
│       └── snapshot.json  # committed, PUBLIC bridge between the two local apps
├── package.json          # `npm run check:*` / `seed:*` / `backfill:*` / `load:*` scripts
└── .gitignore             # ignores node_modules + the local SQLite DB (never committed)
```

> **GitHub Pages is served from `master` → `/docs`** (Pages only supports the repo root or `/docs`, not arbitrary folders). The published site therefore lives in `docs/`, and the publish step writes the snapshot to `docs/data/snapshot.json`. The local SQLite DB stays on each person's machine and is gitignored; only the snapshot is committed.

## Getting started (local app)

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` — no native modules to compile). Then:

```bash
npm install         # installs express (SQLite is built into Node)
npm start           # serves the local authoring app on http://localhost:3000
```

---

## Multi-user sync model

Two people edit their own local SQLite DBs and reconcile through the shared `snapshot.json`. The goal is **eventual consistency**: any change one person publishes will, after the other refreshes, appear on their side.

### Versioning & timestamps (required)
- **Snapshot-level metadata** in `snapshot.json`: `schema_version`, a monotonically increasing `version` counter, `published_at` (UTC timestamp), and `published_by` (A/B).
- **Record-level metadata** on every transaction and plan target: stable `id`, `created_at`, `updated_at`, and `deleted_at` (tombstone, so deletions propagate instead of resurrecting).
- **Local state** each app tracks: `last_pulled_version` / `last_pulled_at`, plus a local-dirty flag for unpublished edits.
- **The UI always shows both clocks:** "Site version N, published <time> by <who>" vs. "Your version, last refreshed <time>" — so each person can see at a glance whether they're behind.

### Refresh (pull) — automatic + manual
- **Automatic:** on app launch, and on a background interval (proposed default **every 5 min**), the app checks the site's snapshot `version`; if it's newer than `last_pulled_version`, it pulls and merges. Also auto-refresh immediately *before* a publish to avoid clobbering.
- **Manual:** a "Refresh from site" button for on-demand pull.

### Publish (push)
- A "Publish to site" action exports SQLite → `snapshot.json`, bumps `version`, stamps `published_at`/`published_by`, then commits + pushes so Pages updates.
- **Refresh-before-publish** is enforced so a publish is always built on top of the latest site version.

### Conflict handling — **per-record last-writer-wins merge** (decided)
With two writers there will occasionally be concurrent edits. Resolution is **per-record**: on refresh, each incoming record is merged against the local one by comparing `updated_at`, keeping the newest; `deleted_at` tombstones propagate deletions instead of resurrecting rows. Two people editing *different* rows never conflict; only edits to the *same* record race, and the later `updated_at` wins. This requires the record-level metadata above (`id`, `created_at`, `updated_at`, `deleted_at`).

### Transport — **HTTP for pull, git for push** (decided)
- **Refresh (pull)** = an HTTP `GET` of the published `snapshot.json` from the Pages URL. No git or local clone needed to catch up on the other person's changes.
- **Publish (push)** = export `snapshot.json`, then `git commit` + `push` (each publisher needs the repo cloned + push access). Publish does a pull-and-merge first so it never clobbers.

---

## Background — the two source artifacts

| Artifact | Role | Location | Format |
|---|---|---|---|
| **Main Tracking Sheet** | Ground-truth ledger — every deposit/withdrawal with a running balance, projected biweekly ~18 months out | `Woody's 2026 Income_Expenses/` | Exported Google Sheet (HTML) + `Sheet1.csv` |
| **`fin_plan.html`** | Strategic plan / "playground" — multi-year strategy, payoff simulators, Coast FIRE targets | this repo (`fin_plan.html`) | Static interactive HTML |
| **Apple Card sheet** | Drill-down detail for one payee | `Woody's 2026 Income_Expenses/Apple Card.html` | Exported Google Sheet |
| **Monthly Spending chart** | Spending-by-month view, excluding CC payments | `Woody's 2026 Income_Expenses/[Chart1]...html` | Exported Google Sheet chart |

**The ledger columns:** Date, Description (category), Source/Recipient, Deposit (+), Withdrawal (−), Running Balance.

**Categories in the ledger:** Paycheck, Bonus, Bill, Savings, Investments, Loan Payment, Credit Card Payment, plus one-offs (Tax Refund, Zelle, Transfer, Misc, Fun).

**Accounts/entities referenced by both files:** Apple Card, Discover ("Rajna"), Capital One, Citi, Chase, Car Note, Student Loans, iPhone Upgrade, Affirm; HYSA buckets (Emergency, Vacation, Apartment, Wedding); investments (Fidelity Roth IRA, Fidelity Individual, Fundrise); the March Bonus (~$7.9k).

---

## What the dashboard needs to do

### 1. People & personalization — "Who are you?" (Woody / Rajna)
- On load, a **popup selects the current person** (no auth, stored client-side; changeable anytime).
- The selection drives **personal-scope** surfaces: This Paycheck, Daily Check, and that person's own paycheck/bank/cards.
- **Shared** surfaces (savings goals, joint net-worth, combined sync health) look the same for both.
- Every ledger transaction and plan target carries an `owner` (`woody` | `rajna` | `shared`) so the app can filter personal vs. shared.

### 2. This Paycheck — 2-week planner (per person) 🔑
The in-app replacement for what the tracking spreadsheet did for short-term planning: for the selected person's current ~2-week paycheck cycle, show **exactly how much should go where** (bills, savings, investments, debt, buffer).

- Starts from the paycheck deposit and lists planned allocations for the window, each **editable**.
- Maintains a **running projected balance** through the window.
- **Negative-balance guardrail:** if any edit drives the projected balance below zero (or a safety floor), the offending rows/plan are **flagged**.
- **Warn-before-save:** trying to save a flagged plan prompts a confirmation ("this leaves you at −$X on <date> — save anyway?") before it's allowed.
- Saved allocations materialize as (projected) transactions in the ledger for that window.

### 3. Daily Check — reconciliation (per person's checking account)
Answers "**what *should* be in my bank right now?**" and lets you fix reality when it diverges.

- Shows the **projected running balance as of today** for the selected person's checking account (computed from the ledger).
- Lets you enter the **actual** current bank balance; the app shows the difference.
- A **"Correct" button** reconciles by adding the missing/adjusting transaction(s) — which are **written into the ledger (tracking)** so history stays accurate.

### 4. Sync / drift detection (the original primary job)
Compare what the **plan assumes** against what the **ledger shows**, and flag drift:

- **Debt balances & payoff dates** — plan payoff targets (Apple Card, Discover/Rajna) vs. actual payments; re-project real payoff date.
- **Savings-goal pace** — cumulative contributions vs. the pace required to hit the goal **by its deadline** (see §5) → ahead / on-track / behind.
- **Investment cadence** — plan targets (e.g. Roth ~$636/mo, brokerage ~$364/mo) vs. actual Fidelity/Fundrise contributions.
- **Income assumptions** — planned take-home vs. actual paycheck deposits.
- **Buffer / low-balance risk** — flag cycles where projected balance goes negative or below a safety floor (shared logic with This Paycheck's guardrail).

Each check renders as: **metric name · plan value · actual value · delta · status (✅ on track / ⚠️ drifting / ❌ off).**

### 5. Savings goals with variable deadlines
- Each savings goal has an editable **`start_date` and `end_date`** — the deadline is **not** assumed to be end-of-year.
- Required pace = remaining amount ÷ time left in that window; pace status and progress bar are computed against the goal's own dates.

### 6. Core financial metrics (things the files care about)
- Net worth trajectory (savings + investments − debt) over time
- Total debt outstanding and month-over-month paydown
- Total interest paid / avoided (mirrors the plan's simulators)
- Monthly cash flow: income vs. outflow, and monthly spending **excluding** CC payments (mirrors Chart1)
- Savings rate and investment rate as % of take-home
- Progress bars toward each savings-goal target (vs. its deadline)
- Coast FIRE progress (long-horizon metric the plan emphasizes)

### 7. Presentation
- **Entry popup:** pick Woody / Rajna.
- Summary "health" strip: overall in-sync status + top warnings (incl. any negative-balance flags).
- Per-domain cards: This Paycheck, Daily Check, Debt, Savings (with deadlines), Investments, Cash Flow, Long-term (Coast FIRE).
- Trend charts over the ledger's date range; drill-down into any flagged drift.

### 8. Conscious Spending Plans (CSP) — target vs. actual 🔑
Each person keeps a **Conscious Spending Plan**: take-home income split into buckets
(Fixed Costs / Investments / Savings / Guilt-Free Spending), each holding line items
with a target. The dashboard's job is to answer **"are we actually living this plan?"**
by cross-referencing every CSP line against the ledger.

- **A sibling view of Plan, not a new peer tab.** Plan splits into two mutually
  exclusive views — *Plan targets* (debts / savings goals / investments) and *Spending
  Plan* (the CSPs). Neither renders the other's content; each carries a switch button to
  the other (a small control at the top of the page body, under the navbar — not inline
  with it), and the **Plan** nav item opens a dropdown listing both. **On the published
  site, Spending Plan is a top-level nav link instead** (decision #10) — Plan-target
  editing stays local-only there, so there is no sibling view to switch to, and both the
  dropdown and the switcher button hide themselves accordingly.
- **Personal-scope: one section, your own.** Like This Paycheck / Daily Check, the view
  renders *only the current person's own plan* — never a sibling's, and never a `shared`
  / household one. There is no owner-switcher on the page; a plan's owner is fixed to
  whoever is currently selected, and `+ Add plan` only appears (and only ever creates a
  plan for) that person.
- **Each bucket is a collapsible section, collapsed by default.** The header line is
  the summary — title, target and actual totals (each with its percent of take-home
  small and muted beside it), and a red/green **Δ** — so a whole plan reads as a
  four-line overview; expanding a bucket reveals its item table. Collapse state is
  remembered per bucket. A value the app calculates (totals, percentages, the
  recommended range, which bucket is the catch-all) renders as plain text, never a
  form control — only take-home, net worth, item names, item targets and match rules
  stay editable, since those are what the calculations are *made of*.
- **Every CSP value is editable and staged.** Take-home and per-item targets persist
  only on an explicit **Save**, with **Discard** — the project-wide rule for money data
  (never auto-save on edit).
- **Item `$` targets are the only stored targets; every percentage is derived.** Both
  uploaded CSPs state line items in dollars and show bucket percentages as *computed*
  shares of take-home — and in both, the four bucket totals sum to take-home **exactly**
  (Woody `4124 + 210 + 300 + 188 = 4822`; Rajna `2960 + 25 + 50 + 335 = 3370`). So a
  bucket's target is the **sum of its items**, its target % is that sum ÷ take-home, and
  the `50-60%` / `10%` / `5-10%` / `20-35%` figures in the IWT template headers are a
  **recommended range** (`rec_pct`), shown as fixed muted text next to the bucket's
  totals — never a target, and never an input.
- **Guilt-Free Spending is the residual, on both sides.** Its target is derived as
  `take_home − (fixed + investments + savings)` — which reproduces $188 and $335
  exactly — and it is the plan's single **catch-all** bucket: windowed outflow that
  matched no item lands there as one **Unassigned** row rather than being spread across
  every bucket. Exactly one bucket per plan carries `catch_all: true`.
- **Actual vs. target compared as an _average_ over a chosen window.** The user picks
  the window with the **same timeframe control the Ledger uses** (preset dropdown +
  From/To), mounted here at **month granularity**: a CSP is a monthly plan, so its
  windows only ever step in whole calendar months (`This month`, `Last 3 months`,
  `Last 12 months`, …, From/To as month pickers). Each row shows its target and actual
  monthly average with a colored **Δ** — the only status signal; there is no separate
  status column or pill, since red/green on the Δ already says it — and because every
  window is a whole number of months the divisor behind each average is exact.
  Trailing presets stop at last month — the in-progress month is only ever shown on
  its own, as `This month`, so six days of October can't be averaged as if it were a
  whole one.
- **Only what's cross-referenceable is scored.** A CSP item maps to the ledger through
  a **match rule** — ledger `source`s and/or `description` categories (the same
  multi-source idea `plan_targets` already uses for debts/goals). An item with no
  match rule renders as *target only — not tracked*, so the plan is honest about what
  it can and cannot verify. Four items are target-only today: Woody's Utilities,
  Groceries and Phone, and Rajna's Stocks.
- **Match precedence: a `sources` rule beats a `categories` rule.** Specificity wins,
  not document order — otherwise a broad category rule swallows the narrow lines beneath
  it. Woody's *Debt Payments* matches on `["Credit Card Payment","Loan Payment"]` while
  *Rajna Assistance Program* matches on five `Rajna *` sources inside those same
  categories; source-first precedence correctly carves $328/mo out of the $2,910/mo
  total. Resolution order: (1) items with a `sources` rule, (2) items with both rules,
  matched by category, (3) items with only a `categories` rule — ties inside a tier
  broken by bucket order then `sort_order`. Each row counts **once**; an item matching a
  row already claimed surfaces a "matched by N items" warning rather than double-counting.
- **Click any item to drill down.** Expanding a row lists the actual ledger
  rows/categories that rolled up into its actual (grouped, with amounts and counts),
  plus a link into the Ledger filtered to the same window and facets.
- **Nothing silently unaccounted for.** The catch-all bucket's **Unassigned** row holds
  the windowed outflow that matched no item, grouped by `description`+`source`, so the
  plan's actual reconciles against the real ledger total rather than only the mapped
  slice. Verified: for both people and two window shapes, `ledger outflow − excluded
  rows == sum of all bucket actuals`, to the cent.
- **Excluded from CSP math: `Adjustment` and `Negative Balance`.** These are
  reconciliation artifacts written by the Daily Check, not spending — Rajna's ledger
  carries a single $1,072.87 correction that would otherwise read as $89/mo of phantom
  outflow. They are never matched and never land in Unassigned; the view shows them on a
  separate excluded footer line so nothing disappears silently. **`Transfer` rows do
  count** (extending resolved decision #5): internal transfers are real outflow from the
  paying account, and Rajna's are seeded to a dedicated target-0 line so they read as
  transfers rather than discretionary spending.
- **Projection-aware.** Woody's ledger runs ~18 months into the future, so a window
  extending past today mixes actuals with plan. The view labels that and splits
  *to-date* vs. *projected* rather than quietly averaging the two together. This matters
  more than it looks: over a trailing-12-month window Woody's Fixed Costs read 74.5% of
  take-home, but over Sep–Dec 2026 (mostly projected) they read 98.9%, because the
  projected rows are lumpier than lived ones. Never present a projected average
  unlabelled.
- **A known blind spot, stated rather than papered over.** Woody's ledger records credit
  card **payments**, not card **spend** — so everything funded on the Apple Card
  (groceries, dining, retail) is invisible at this granularity. That is why his
  Groceries ($200), Phone ($66) and Guilt-Free ($188) lines are structurally
  unverifiable and his Unassigned total is only ~$161/mo, versus Rajna, who pays most
  things from checking and whose Guilt-Free therefore populates properly. The view must
  not let a $0/"— untracked" actual read as "spent nothing". Closing this gap needs
  card-level spend import, which is out of Phase 10 scope.

---

## Architecture notes

- **Local app = Node + Express + SQLite.** Runs on localhost, no auth. SQLite (a single local file) holds the ledger transactions *and* the migrated plan targets. The metrics/sync engine lives here.
- **Migrated plan targets.** `fin_plan.html`'s strategic assumptions become editable rows/settings in SQLite (e.g. `plan_targets`: debt payoff goals, savings allocations, investment cadence, Coast FIRE inputs). The old `fin_plan.html` is superseded by the app + published view.
- **Shared render core.** Metrics/sync computation and the chart/card components are shared so the local app and the published view show identical results; the only differences are edit-vs-read-only and data source (SQLite live vs. committed snapshot).
- **Snapshot format.** The publish step exports SQLite → a single versioned `docs/data/snapshot.json` (real numbers, public). That file is the contract the published static view fetches.
- **Publish flow.** Local edits in SQLite → "publish" exports `snapshot.json` → commit + push → GitHub Pages serves the updated read-only view.
- **Separation of concerns.** `local/` (Node server + editor UI), `shared/` (metrics/sync + render components), `docs/` (static read-only entry), `docs/data/snapshot.json` (bridge). SQLite DB file stays gitignored; only the snapshot is committed.

### Data model (updated for the people/accounts pivot)
- **`people` / current user.** Fixed set `{woody, rajna}`. The current user is a client-side selection (localStorage), not a DB row that gates access.
- **`accounts`.** First-class accounts, each with `owner` (`woody`|`rajna`|`shared`), `type` (`checking`|`credit_card`|`savings`|`investment`|`loan`), `name`, and `opening_balance`. Two checking accounts exist now (one per person); a future joint account is just another row with `owner = shared`. The **Daily Check** and running balance are computed **per checking account**.
- **`transactions`.** Gain `owner` and (optionally) an `account_id` for which account's balance they move. Running balance becomes **per account** rather than one global stream. Keep single-entry (each txn hits one account as deposit/withdrawal; `description`/`source` name the destination).
- **`transactions.transfer_id` (Phase 13 / T34).** The join between the two ends of one
  money movement: a checking `withdrawal` and the card `deposit` it paid, a refund flowing
  the other way, or a card-to-card balance transfer (#47). `NULL` on an ordinary row,
  indexed. It is a **group key, not a pointer** — any number of rows may share one, because
  a single payment can arrive on the card as several rows — and the invariant is that a
  group's signed amounts **net to exactly zero**, never that it holds exactly two rows. The
  guard is asymmetric by design (#48): an unpaired **checking-side withdrawal** is an error
  because money left the household with no record of where it went, while an unpaired
  **card-side deposit** is valid data (a card paid from a non-ledger source). All of the
  arithmetic lives in `shared/transfers.js`, shared verbatim by the Ledger, the backfill and
  the checker; `npm run check:transfers` asserts it.
- **`transactions.external_id` (Phase 13 / T26b+T29).** A deterministic fingerprint —
  `(account_id, txn_date, amount, normalized merchant, occurrence-index-within-that-key)`,
  built by `shared/card-import-spec.js`'s `externalId`/`assignExternalIds` — so re-importing
  an overlapping statement dedupes to zero fresh rows instead of doubling every charge.
  `NULL` on hand-entered and pre-Phase-13 rows; unique per account where present (`npm run
  check:cards -- --db`, section L). `transactions.import_batch` tags every row one hand load
  or upload wrote, so a bad batch is revertable as a unit; `transactions.projected` marks a
  recurring-charge projection and such rows deliberately carry **no** `external_id`, so a
  real future import can never collide with one.
- **`accounts.data` (Phase 13 / T25–T26b, credit-card accounts).** Per-card metadata,
  additive JSON on the existing column — no new table:
  ```jsonc
  data: {
    issuer: "apple",                    // adapter key for shared/statement-import.js
    last4: "1234", last4_seen: ["1234"], // last4_seen only when an export mixes card numbers
    credit_limit: 10500, apr: 0.2549,    // null/null is a valid "unknown" state (T32b degrades)
    promo_apr_until: null, post_promo_apr: null,   // decision #47 — 0% assumed PROMOTIONAL unless unset
    statement_day: 23, due_day: 15, min_payment: null,
    source_aliases: ["Apple Card", "Apple Card Payment"],  // checking-side `source` strings this card claims
    seeded_range: ["2026-03-02", "2026-10-07"],   // [first, last] txn_date T26b actually loaded from statements
    statements: {
      source: "Card_Totals.csv", as_of: "2026-10-08", current_balance: 10421.38,
      periods: [{ closing_date: "2026-08-23", closing_balance: 49.00 }],  // ISSUER-STATED only (#45);
                                       // empty until the user supplies a per-period ladder for that card
      derived_month_end: [{ month: "2026-03", closing_balance: 7433.87 }],  // DERIVED by replay, not
                                       // stated — never cited as a check, it is what a future check checks
    },
  }
  ```
  `periods` is what `npm run check:cards -- --db` section M reconciles against (T37 #6); it
  stays empty for a card until the user supplies the issuer's own per-period closing
  balances, at which point every entry is asserted to the cent.
- **`card_rule` (Phase 13 / T30, merchant → category rules).** One more `plan_targets` kind,
  same free ride as `csp_plan`/`csp_item` (no schema change, full CRUD/snapshot/LWW-merge):
  ```jsonc
  // kind: "card_rule"   owner: "woody"   name: "Whole Foods"
  data: { match: "WHOLEFDS", match_type: "contains",  // contains | exact | regex
          account_id: null,            // null = every card this owner sees
          description: "Groceries",    // the ledger category to write
          source: "Whole Foods",       // optional merchant rename
          priority: 0 }
  ```
  Matches against `source`, normalized by `shared/card-import-spec.js`'s `normalizeMerchant`
  (accents stripped, uppercased, punctuation collapsed, digits kept). `owner: 'shared'` by
  default for a seeded rule ("Walmart is Groceries" is a household fact); a rule the app
  *learns* from a manual correction is created under the current user. Precedence when
  several rules match one row is total and tested in `local/check-rules.js`: match type
  (`exact` > `contains` > `regex`), then scope (this `account_id` beats all-cards), then
  `priority`, then longest normalized match, then `id` as the final deterministic tiebreak.
- **`plan_targets`.** Gain `owner`. Savings-goal targets gain **`start_date` / `end_date`** (variable deadlines) instead of an implicit EOY. Debt-payoff and investment targets keep their existing kind-specific `data` JSON.
- **CSP plans / items (Phase 10).** No new table: Conscious Spending Plans ride on
  `plan_targets` as two new kinds — `csp_plan` (one row per plan) and `csp_item` (one row
  per line item). Row-per-item keeps the per-record LWW merge granular, so two people
  editing different lines never conflict; bucket metadata is small and ordering-sensitive,
  so it rides on the plan row instead of being its own kind. **Field shapes frozen by T0:**

  ```jsonc
  // kind: "csp_plan"   id: "csp-woody"   owner: "woody"
  data: {
    take_home: 4822,                 // monthly net — the denominator for every %
    gross_monthly: 7249,
    net_worth: { assets, investments, savings, debt },   // balance sheet, from the PDF;
                                     // the net worth itself is derived (assets + investments
                                     // + savings − debt) by `netWorth()` in shared/csp.js
    buckets: [                       // ordered; labels + recommended range + catch-all
      { bucket: "fixed",       label: "Fixed Costs",         rec_pct: [50,60], sort_order: 0 },
      { bucket: "investments", label: "Investments",         rec_pct: [10,10], sort_order: 1 },
      { bucket: "savings",     label: "Savings Goals",       rec_pct: [5,10],  sort_order: 2 },
      { bucket: "guilt_free",  label: "Guilt-Free Spending", rec_pct: [20,35], sort_order: 3,
        catch_all: true }            // exactly one per plan; target derived as the residual
    ]
  }

  // kind: "csp_item"   id: "csp-woody-insurance"   owner: "woody"
  data: {
    plan_id: "csp-woody",
    bucket: "fixed",                 // must match a bucket key on the plan row
    target_amount: 170,              // authoritative when basis === "$"
    basis: "$",                      // "$" | "%" — which the user typed; the other is derived
    target_pct: null,                // authoritative when basis === "%"
    sources: ["Progressive Car Insurance"],   // match rule — takes precedence over categories
    categories: [],                  // match rule — ledger `description` values
    sort_order: 2,
    proposed: true                   // optional: added by T0, not on the uploaded PDF
  }
  ```

  A bucket has no stored target: it is the sum of its items (or the residual, for the
  catch-all). An item with both `sources` and `categories` empty is *target only — not
  tracked*. `proposed: true` marks the six lines T0 added at target 0 so real ledger
  activity (Wedding/Ring/Honeymoon HYSA, Rajna's AT&T, tuition, internal transfers) shows
  in the right bucket instead of the catch-all — they are flagged in the UI and safe to
  delete. The frozen seed payload lives at **`local/csp-seed.json`** (2 plans, 35 items).
- All of the above keep the sync metadata (`id`, `created_at`, `updated_at`, `deleted_at`) for per-record LWW merge, and all flow through `snapshot.json`.

### Reusability — keep in mind while building
The ultimate goal is a system reusable for **1, 2, or N people**. No pivot now, but develop so generalizing is cheap:

- **People are a list, not a constant.** Model household members as configurable data (a `people` list with id + display name), never hardcode `2` or the literal names "Woody"/"Rajna" in logic or UI. `owner` is a person id or `shared`; single-person mode is just a one-entry list (and the "Who are you?" popup can auto-skip).
- **Rank tabs by how portable they are.** The **paycheck allocator (This Paycheck)** and **income/expense tracking (ledger + Daily Check)** are the most generic — design these first-class and household-agnostic so they drop into any setup. More bespoke, couple-specific "life tracking" surfaces can stay separate and optional.
- **Keep modules decoupled.** Each tab/feature is a self-contained module over the shared data + metrics core, so an instance can enable only the tabs it needs. Avoid cross-tab coupling that assumes a specific household shape.
- **Config over hardcoding.** Household size, member names, account set, safety-floor thresholds, and pay cadence should be data/config — so a new user configures rather than edits code.
- **Don't over-build for it.** Favor the smallest choices that keep the door open (a list instead of two variables); defer any real multi-tenant/templating work until there's a second real user.

## Roadmap

_Phases build on the two-part, two-person model: Node + SQLite local apps ↔ shared `snapshot.json` ↔ static published view. Re-sequenced after the people/accounts pivot — foundation (ledger + owner/accounts + user selection) comes before the interactive tabs._

- [x] **Phase 0 — Scaffolding & sync design** ✅ _(done)_ — repo layout, Node + built-in `node:sqlite`, schema with sync metadata (`id`/`created_at`/`updated_at`/`deleted_at`; snapshot `version`/`published_at`/`published_by`), `snapshot.json` contract, GitHub remote + Pages live at https://thewam.github.io/finance-dashboard/.
- [x] **Phase 1 — Data model + editable ledger** ✅ _(done)_ — added `people`/`accounts` tables + `owner`/`account_id` on transactions (idempotent migrations); per-account running balance in `shared/metrics.js`; full CRUD API + spreadsheet-style editable grid (`local/public/`) with per-account balance/totals and soft-delete; `local/import-csv.js` seeds a checking account from the exported sheet and **reconstructs the running balance exactly**, splicing in explicit "Adjustment" rows wherever the sheet's balance jumped without a transaction (Woody's checking: 606 CSV rows + 1 adjustment, opening $4.50, balance $537.19 ✓). Snapshot contract extended to carry `people`/`accounts`.
- [x] **Phase 2 — Current-user selection** ✅ _(done, local app)_ — "Who are you?" entry popup built from the `people` API (no auth), choice stored in `localStorage`; header user chip with a "switch" control; accounts filtered to the current person's + `shared`, defaulting to their checking; single-person households auto-skip the popup (reusability); `?user=<id>`/`?account=<id>` deep-links. Published-view wiring follows once it renders real snapshot data (Phase 7/8).
- [x] **Phase 3 — This Paycheck (2-week planner)** ✅ _(done)_ 🔑 — per-person pay-window view (`local/public/paycheck.html`). Pay cadence is config on `people` (Woody biweekly, Rajna monthly); the window `[payday, next payday)` is computed by `shared/paycycle.js` anchored to the person's most recent paycheck. **Prefills the ledger entries that fall within the window** (what's known to happen this period — paycheck, savings, investments, card payments, car note, …), projects the running balance from the balance entering the window, **flags where it goes negative + warns before saving**, and stages edits/adds/deletes that write back to the ledger on Save. (Recurring-template `plan_targets` CRUD exists in the backend for later use.)
- [x] **Phase 4 — Daily Check (reconciliation)** ✅ _(done)_ — now a small popup on the **Ledger** (no separate tab): "You should have $X in the bank today" (ledger net as of today for the selected account) with ✓ / ✗. ✗ prompts for the actual balance and stages a dated adjustment transaction (via the normal Save flow) so the ledger matches reality.
- [x] **Phase 5 — Migrate plan targets** ✅ _(done)_ — editable `plan_targets` (`local/public/plan.html`): debt payoffs (balance/APR/monthly/target date), savings goals with **variable start/end dates**, investment cadence; each links a ledger `source`. Seeded by `local/seed-plan-targets.js`.
- [x] **Phase 6 — Sync / drift detection** ✅ _(done)_ — `shared/drift.js` compares plan vs. ledger reality: debt-payoff re-projection, savings-goal pace vs. deadline, investment cadence — each with good/warn/bad status, surfaced on the Dashboard.
- [x] **Phase 7 — Publish + refresh loop** ✅ _(done)_ — `/api/publish` (SQLite → `docs/data/snapshot.json` + copy `shared/` → `docs/shared/`, git commit/push; skippable), `/api/refresh` (pull snapshot → per-record LWW merge with tombstones), `/api/sync-status`; Publish/Refresh buttons + version indicator on the Ledger. _(Remaining: auto-refresh interval, refresh-before-publish enforcement.)_
- [x] **Phase 8 — Metrics engine + dashboard UI (shared)** ✅ _(done)_ — `shared/metrics.js` (`summary`, `monthlySpend`) + `shared/dashboard-render.js` health strip, YTD tiles, drift rows, monthly-spend chart; rendered by both the local **Dashboard** tab and the published `docs/index.html`.
- [~] **Phase 9 — Polish:** DB backups done (`npm run backup`). Remaining: Coast FIRE, drift alert notifications, conflict-audit view, join-accounts (merge to a `shared` checking account).
- [x] **Phase 10 — Conscious Spending Plans (target vs. actual)** ✅ _(done)_ 🔑 — a **Spending Plan** view (`local/public/csp.html`/`csp.js`), a sibling of **Plan**: a segmented switcher on both pages plus a hover/tap dropdown on the **Plan** nav item (`local/public/nav-plan.js`), reached locally; on the published site it's a top-level nav link instead, since Plan-target editing stays local-only. Personal-scope, like This Paycheck/Daily Check: each view renders only the current person's own `csp_plan` row (two rows exist today — Woody and Rajna — but never both in one view, and never a `shared`/household plan), every take-home/net-worth/bucket/item value editable behind Save/Discard, CRUD riding on `plan_targets` as two new kinds (`csp_plan`, `csp_item` — no schema change). Targets compare against **windowed monthly averages** from the ledger using the **shared timeframe control extracted out of the Ledger** (`shared/timeframe.js`, `local/public/timeframe-ui.js`) at **whole-calendar-month granularity** (`MONTH_PRESETS` — the Ledger keeps its own day/paycheck presets), with a pure compute engine (`shared/csp.js`) handling averaging, source/category match precedence, the Adjustment/Negative-Balance exclude set, and a to-date/projected split for windows crossing today. Each line expands into the real ledger rows behind its actual, with an **Unassigned** row reconciling the catch-all bucket, and a "View in Ledger" link (new `?from=`/`?to=`/`?category=`/`?source=` deep-link params on the Ledger). Published read-only parity lives at `docs/csp.html`. The **Dashboard** carries a compact read-only echo of it (`shared/dashboard-render.js`): one card per plan in scope, one line per bucket — target % of take-home vs. actual %, with the delta colored — averaged over the Spending Plan's own default window (`DEFAULT_MONTH_PRESET`, the last three complete months), so a number on the Dashboard and the same number on the Spending Plan agree. Task-by-task breakdown + what each step actually shipped in **[TASKS.md](TASKS.md)**.
- [x] **Phase 11 — Spending Plan UI cleanup** ✅ _(done 2026-10-06, user feedback)_ — a presentation-only pass over `local/public/csp.html`/`csp.js`; no change to `shared/csp.js`, the timeframe module, the server or the data. Each bucket is now a **collapsible section whose one-line header is the summary** — title, target total and actual total as plain bold text with their percent of take-home small and muted beside each, and a red/green Δ — collapsed by default and remembered per bucket (`localStorage`), so a whole CSP reads as four lines with an Expand all/Collapse all in the plan header. Everything the app *calculates* stopped being a form (the recommended range is now fixed text; the catch-all is derived onto the `guilt_free` bucket — falling back to the last by `sort_order` — rather than picked with a radio), and the redundant signals are gone: the **Status column** and every status pill (the colored Δ is now the only status signal), the `· rec 50–60% (above)` clause, and the per-plan provenance line (`averages over 3 paychecks · … · 49% projected`; the open-window months figure moved to a `title` tooltip). The reconciliation warning and the drill-down panels were kept unchanged. Republished to `docs/csp.html` and re-verified against an independent engine run (102/102 checks) and `npm run check:csp -- --db`. Task-by-task breakdown + what each step shipped, and resolved decisions #12–14, in **[TASKS.md](TASKS.md)**.
- [x] **Phase 12 — Second color theme + a global Settings panel** ✅ _(done 2026-10-06, user request)_ — a **peach / pale-yellow / mint / white** theme beside the original dark one, and a **⚙ gear fixed in the bottom-left corner** of every page that grows on hover and opens a panel *out of that corner* over a scrim. The enabling refactor is that colors now live in exactly one place: the 11-token `:root` block that had been copy-pasted into five local pages plus `docs/index.html` became **`local/public/theme.css`**, holding `:root` (dark, values unchanged — the existing look is the spec) and `:root[data-theme="peach"]`, grown to ~35 tokens so nothing has to hardcode a color again (`--on-accent`/`--on-danger`/`--on-slice` for text *on* a filled color, `--scrim`, `--row-edited`/`--row-new`/`--row-neg`, the `--banner-*` tints, `--shadow-*`, `--btn-hover-filter`, `--chart-line`, and `--cat-*` for the nine paycheck-pie categories) — then ~45 literals across the pages, `view-switch.js`, `nav-plan.js`, `shared/dashboard-render.js` and `paycheck.js`'s pie palette were swept onto those tokens, since a literal is invisible in dark and wrong in a light theme. The panel (**`local/public/settings.js`**, mounted by every page, local and published) holds **Appearance** (Dark / Peach swatches) and **Performance → Low power**, which **moved out of the Ledger header**: `settings.js` now owns the `localStorage` flag and the `body.lowpower` class and dispatches a `lowpowerchange` event, and `app.js` just swaps renderers when it hears one — so the module that owns the toggle doesn't know the Ledger exists. Both preferences are per-machine `localStorage` and never enter `snapshot.json`. The theme is applied by a tiny inline `<head>` script so there's no flash before the deferred module runs, and `npm run check:theme` (**`local/check-theme.js`**) scores every token pairing straight out of the stylesheet: the peach palette meets all 26 of its targets, with 12 pre-existing dark-theme shortfalls recorded by name so they can't mask a regression. Task-by-task breakdown and resolved decisions #15–18 in **[TASKS.md](TASKS.md)**.
- [x] **Phase 12b — The theme follows the profile** ✅ _(done 2026-10-06, user follow-up)_ — Phase 12 made the theme a per-machine preference; the correction is that it belongs to the **person**. `theme` is now a column on `people` (`ensureColumn`, like `avatar`/`pay_cadence`), so it rides the existing `snapshot.json` export and the existing per-record LWW merge with **no new sync machinery** — switching person switches theme, and a **Publish** carries your choice to the other machine and to the published site. It is written through the instant you pick it (`PUT /api/people/:id/theme`): no Save step, and no Publish needed for it to stick locally. That write is deliberately **excluded from the dirty flag** — it still bumps `updated_at` so the merge carries it, but a cosmetic toggle has no business popping the Publish button, which is also why the theme has its own route instead of a field on a general people PATCH. Pre-paint application moved out of a six-times-duplicated inline snippet into **`local/public/theme-boot.js`** (a classic blocking `<head>` script), which owns the storage keys and the one resolution rule that collapses three states — what the profile carries, what this machine cached, what this machine last *saw* the profile carry: if the stored value differs from the last-seen one the profile was changed elsewhere, so adopt it; otherwise the cache wins. That single rule covers a local pick surviving reload, a partner's change arriving on Sync, and a reader's pick on the **read-only** published site sticking (the write 404s, so last-seen never advances) until the owner really changes it. Fixed along the way: the publish step injected `docs/mock-api.js` ahead of the *page's* script but behind `settings.js`, so that module's `/api/people` read escaped the read-only shim — the shim now goes ahead of the **first** module script. Low power stays per-machine (it describes what this computer can render, not who you are), so Phase 12's decision #18 split into #18a/#18b. Verified end to end: 7 local profile scenarios, 6 published/read-only scenarios, and both themes across all five local and four published pages. Details and decisions #18a–#19 in **[TASKS.md](TASKS.md)**.
- [ ] **Phase 13 — Credit Cards** 📋 _(planned 2026-10-06, user request)_ 🔑 — the bulk of daily spending happens on cards, and the ledger currently sees it only as a monthly lump: **175 `Credit Card Payment` rows across 13 distinct card source strings, ~$67k of outflow, with no record of what any of it bought.** This phase gives every card **its own ledger** — a second `accounts` row per person (`type: 'credit_card'`, already a valid type) selected with the `#account` dropdown the Ledger already has, so it is a new row rather than new plumbing. Debt is modeled as a **negative balance** (purchase = `withdrawal`, payment/refund = `deposit`, `debt = -balance`), which lets `shared/metrics.js` serve cards **completely unchanged** and confines the sign flip to the display layer. A new **Credit Cards** tab is to a card what *This Paycheck* is to a person: total debt across the owner's cards at the top, then a per-card breakdown over an adjustable whole-calendar-month window (`MONTH_PRESETS`, same control as the Spending Plan), category and merchant rollups that drill down into the real ledger rows, and add-single/add-repeating expenses staged behind Save/Discard. A **monthly statement CSV** can be dropped on a card — parsed **client-side** by `shared/statement-import.js` (adapters for Apple Card, Capital One, Citi and Discover, plus a generic column mapper), reviewed before anything is written, deduped by a deterministic `external_id` so re-uploading an overlapping statement is a no-op, and auto-categorized from learned merchant rules (`plan_targets` kind `card_rule`) with repeating charges offered up as future-dated projections via `generateRecurring` extracted out of `paycheck.js`. **The file never reaches disk by architecture**: there is no file-accepting endpoint, only `POST /api/transactions/bulk` taking already-parsed rows. The headline integration is the **CSP paydown split**: card purchases count in the buckets by their own category, a payment is split into the transfer portion (excluded) and `paydown = max(0, payments − purchases)` (a real `Debt Payments` dollar), so no card dollar is counted twice and *Groceries* / *Bills* finally include what was paid with plastic — turning the reconciliation identity into `bucketTotal + excluded === cashOutflow + netNewCardDebt`, still exact and still asserted. Single-entry is preserved: a card payment is **two rows joined by `transfer_id`**, with edit/delete propagation and an idempotent backfill over the existing 175 payments. Four additive `ensureColumn` migrations (`accounts.data`, `transactions.transfer_id` / `external_id` / `import_batch`) need **no sync work at all**, since `mergeInto` derives its columns from `PRAGMA table_info` and `buildSnapshot` does `SELECT *`. Separately and deliberately decoupled from that uploader, **several months of real statements per card are supplied up front and loaded straight into the ledgers by hand** (T26b, decision #27) — a direct SQLite write, parsed however is expedient, *not* routed through the app's import feature. The uploader is a real feature built and tested on its own; it is simply not the bootstrap mechanism, and three things follow from separating them: the **data stops blocking on the code**, so T27/T28/T31/T32 are built and verified against real rows from their first commit; **the uploader becomes properly testable**, since hand-loading first produces a *known-good* answer to diff it against (run it over an already-loaded month, expect zero fresh rows and identical categorization) instead of the ambiguity of bootstrapping with an unverified parser; and the **`external_id` fingerprint formula moves forward into T26b** for T29 to adopt verbatim, which is what makes that diff possible at all. What survives the decoupling intact is the arithmetic: each `opening_balance` derived from the earliest statement, and **every period reconciled against its stated closing balance** — a ladder of N checks per card that independently proves each sign convention, date-column choice and completeness, where one sample file proves only that a parser ran. The loaded data is also what makes T30's merchant rules worth building in one bulk pass and recurring detection testable at all (its premise is ≥3 consecutive months of a merchant). The statements are staged outside the repo, never committed — not even as a test fixture, since T37's are synthetic — and deleted once the ladder passes, with each closing balance persisted into `accounts.data` so the reconciliation stays assertable afterward. The phase's one hard ordering constraint falls out of this: **T26b strictly before T34**, both of which write the card side of a payment, guarded by a recorded `seeded_range` per card. Fourteen tasks (T25–T37, incl. T26b) with per-task model assignments, the dependency graph, resolved decisions #21–27 and the open questions each one gates are in **[TASKS.md](TASKS.md)**. **Amended since this was written — the description above is stale in six places, all recorded in TASKS.md.** *(i)* The **CSP paydown split described above was rejected by the user on 2026-10-07**; decision #21 was rewritten so card purchases count at their own category and the **full payment counts as `Debt Payments`**, with the identity becoming `bucketTotal + excluded === cashOutflow + cardPurchases`. One economic dollar can therefore appear twice, deliberately, and bucket percentages are a share of *commitments* rather than take-home. *(ii)* Cards are a **`[ Debit | Credit ]` subtab of *This Paycheck* sharing its pay window** (#37), not a fifth top-level tab with its own `MONTH_PRESETS` control. *(iii)* **T25 completed 2026-10-08**: the inventory is **six accounts owned 2 Woody / 4 Rajna** — not five — with Rajna's three `owner: 'shared'` (#43, #44); `Capital One` and `Chase` turned out to be *Rajna's* cards that Woody services. *(iv)* The **ladder of N closing-balance checks is not in the exports** (#45) — the user is collecting the per-period balances for the four transacting cards, and Chase is exempt because it is a dormant balance-only card with no purchases at all (#49). T25 also made the APR and credit limit known for every card, which unblocks T32b at full fidelity. *(v)* **T34 completed 2026-10-08** and corrected the "two rows joined by `transfer_id`" claim above: `transfer_id` is a **group key, not a pointer**, because the real data is not 1:1 — one $888.12 checking withdrawal arrives on the Apple Card as four rows, so the invariant is `groupNet(rows) === 0` rather than *exactly two rows* (#56). The backfill also came out at **49 pairings + 66 mirrors over 151 claimed payments, not 175** — and it mirrors only payments dated **after each card's reconciliation anchor**, not merely outside its `seeded_range`, because a payment predating the export is already absorbed into the derived `opening_balance` (#57). One consequence reaches every later task: with the planned payments mirrored and no planned charges on the card side, a card's **all-dates balance is now a projection** ($6,151.92 household) and only the as-of-today reading is a balance ($36,314.92) (#58). *(vi)* **T30 completed 2026-10-08** and the detector it describes needed a rule the plan did not have: "≥3 consecutive months within ±15%" alone nominates `CHICK FIL A` (38 charges over 7 consecutive months), `QT INSIDE` and `UBER TRIP` — every frequent-but-discretionary merchant — because *appears every month* describes a habit, not a subscription. The discriminator is **one charge per period**, which is categorical on this corpus, and with it the Apple Card yields exactly three real subscriptions. The merchant rules also turned out to be the phase's quiet heavyweight: 58 seeded rules re-categorized **153 rows and $6,920.92 out of `Misc`**, taking the catch-all from **27% of card rows to 12%**, which is what makes decision #21's "at their own category" mean anything. Projections are marked with a fifth additive column, `transactions.projected`, and carry **no `external_id`** — so "a future import cannot collide with a row we invented" is structural rather than remembered.
- [x] **Phase 14 — Five more theme families, each paired light/dark** ✅ _(done 2026-10-08, user request)_ — **eight more color variants**, taking the site from two standalone themes to **six families × two modes = twelve variants**, with **Light / Dark / Auto** as a second, independent axis. Both existing themes are half a pair today (the original `:root` dark has no light counterpart; **Peach** has no dark one), and four palettes picked out of the nine supplied in `~/Desktop/themes/` supply four new families, each arriving as one mode with its counterpart derived: **Bordeaux** (deep wine + honey bronze, native dark), **Lagoon** (jewel teal + berry, native dark), **Orchid** (violet → rose, native light) and **Thicket** (forest green + scarlet, native light). The other five palettes are rejected *in writing* so the choice isn't re-litigated — two as near-neighbours of families that already exist (*Regal Navy* of Slate, *Petal* of Peach), one as the near-neighbour of Bordeaux (*Mahogany/Rust*), and two (*Sage/Taupe*, *Silver/Sky*) for a structural reason rather than on taste: **all five of their swatches are mid-luminance**, so `--text` has nowhere to go and nothing can carry white, meaning neither clears its contrast targets without importing colors from outside its own palette — at which point it isn't that palette. Phase 12 made colors live in one place and Phase 12b made the choice belong to the *person*; this phase makes it **two-dimensional**: `data-theme` stops being a flat id and becomes **family × mode** (`data-theme="bordeaux" data-mode="dark"` — two attributes, not twelve ids like `bordeaux-dark`, so "all dark variants" and "both Bordeaux variants" stay selectable), the profile grows a `theme_mode` column beside `theme` (another `ensureColumn`, so it rides `snapshot.json` and the LWW merge with **no new sync machinery**), and the two fields are written by **one** route in one `applyUpdate` because they must never half-apply — a Slate/dark profile moved elsewhere to Thicket/light must not land on Thicket/dark, a variant nobody chose. **`auto` is resolved in JavaScript, never in an `@media` block**: `theme-boot.js` already runs blocking in `<head>` and already owns the one resolution rule, so it reads `matchMedia("(prefers-color-scheme: dark)")` pre-paint, writes `data-mode` as a concrete value, and re-applies live on the OS change event — which keeps `theme.css` a pure twelve-cell token table instead of duplicating every variant behind a media query and then needing specificity gymnastics for an explicit pick to beat the system one. **There is no default mode** (user answer, 2026-10-07): what a person sees follows their *explicit* light/dark pick, so the `theme_mode` migration arrives **populated** — every existing profile gets its current mode made explicit (Slate → `dark`, Peach → `light`) and a never-chosen profile falls back to Slate/`dark` rather than to `matchMedia`, so nobody's appearance moves on the first load after this phase and `auto` is reached only by choosing it. The real risk is the **multiplication**, not the palettes: 12 variants × ~35 tokens is ~420 values, 108 of them chart hues, and `check:theme` currently hardcodes exactly two selectors. So the guardrails are built **before** the eight new variants (T40 → T42, the load-bearing edge in the graph): the checker learns to enumerate variants out of the stylesheet and gains three new failure modes that matter more at this scale than an unreadable pastel does — **a family shipped in only one mode**, **a token missing from one variant** (today it would be inherited from `:root` and look fine in the one place anyone checked), and **two of the twelve category hues collapsing together**, since `--cat-*` is *identity* rather than decoration and a pie with two same-colored slices stops being readable. (T40 measured that last one and corrected the premise behind it: the metric has to be **perceptual** ΔE2000, not a hue angle — a hue assert flags the catch-all gray `--cat-other` in three of four variants while passing pairs that genuinely collide — and because T38 fixes hue per category, **Thicket is not the family that fails first**; the rule's own tightest pair is purple, `card` vs `transport`, in every variant.) Token blocks also move off `:root` onto plain `[data-theme][data-mode]` attribute selectors — identical in production, and what lets the new **`theme-mock.html`** showcase render all twelve variants side by side as light/dark pairs out of the **real** stylesheet rather than keeping its own copy of 420 values and drifting the week after it's written. Ten tasks (T38–T47) with per-task model assignments, the dependency graph, resolved decisions #28–36 and the open questions each one gates are in **[TASKS.md](TASKS.md)**. **Amended since this was written — four things, all recorded in TASKS.md.** *(i)* **T42's four source palettes needed three per-variant exceptions, not a mechanical application of the derivation rule** — a transcribed role occasionally failed the same contrast targets Phase 12 already hit once, so Orchid's Rosewood (doing double duty as both `--accent` and the `--text` anchor) and Old Rose (transcribed as `--neg`, 2.4:1 on near-white) both deepen, Thicket's Willow Green can't be `--pos` on its own light surface (1.7:1) and becomes `--accent-weak` there instead, and Bordeaux's `--warn` moves out of amber because the palette's `--accent` already owns it. *(ii)* **The category-hue count the risk paragraph above assumes is stale by one category and 48 values**: T46's sweep (not this phase's plan) caught that Phase 13's `Interest` category had no `--cat-*` entry and was falling into the gray catch-all on every card donut, so `--cat-*` closed at **13** names, not 12, for **156** chart-hue values, not the 108 quoted above. *(iii)* **T46's twelve-variant walk ran scoped down, not in full**: no CDP/browser-automation tool was available in that environment, so the planned click-through of all twelve variants across nine pages didn't happen. `check:theme` (now covering all 13 categories), a full-page screenshot of `theme-mock.html`, and targeted screenshots of the specific surfaces T46's own fixes touched stood in instead — the remaining walk is flagged in TASKS.md as still open, not reported done. *(iv)* **Decisions #35 (Slate light's neutral pairing, provisional on T44's mockup) and #36 (no default mode, nothing arrives on `auto` unasked) were settled after this entry's first draft** and are what the "no default mode" sentence above and the Light/Dark/Auto control actually implement.
