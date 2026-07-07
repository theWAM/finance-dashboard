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
├── local/            # Node + Express authoring server (runs on localhost; NOT published)
│   ├── server.js     # Express app: serves the editor + JSON CRUD API
│   ├── db.js         # SQLite connection + schema (people, accounts, transactions, plan_targets, sync_meta)
│   ├── import-csv.js # one-time importer: exported sheet CSV → an account's ledger (reconstructs balance)
│   ├── public/       # the editable ledger grid UI (static: index.html + app.js)
│   └── dashboard.db  # local SQLite DB — gitignored, private to each machine
├── shared/           # Pure logic shared by local app and published view
│   ├── merge.js      # per-record last-writer-wins merge (+ tombstones)
│   ├── metrics.js    # running balance + metric/sync computations
│   └── snapshot.js   # snapshot.json build/parse — the data contract
├── docs/             # Static read-only site served by GitHub Pages (Pages source = master:/docs)
│   ├── index.html    # loads ./data/snapshot.json, renders read-only dashboard
│   └── data/
│       └── snapshot.json  # committed, PUBLIC bridge between the two local apps
├── package.json
└── .gitignore        # ignores node_modules + the local SQLite DB (never committed)
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
- **`plan_targets`.** Gain `owner`. Savings-goal targets gain **`start_date` / `end_date`** (variable deadlines) instead of an implicit EOY. Debt-payoff and investment targets keep their existing kind-specific `data` JSON.
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
- [x] **Phase 3 — This Paycheck (2-week planner)** ✅ _(done)_ 🔑 — per-person pay-window planner (`local/public/paycheck.html`). Pay cadence is config on `people` (Woody biweekly, Rajna monthly); the window is computed by `shared/paycycle.js` anchored to the person's most recent paycheck. Starting balance comes from the ledger; allocations are seeded from a **recurring template** (`plan_targets` kind=`recurring_allocation`, editable via new plan-targets CRUD). Running projected balance with **negative-balance flag + warn-before-apply**; "Fill from last paycheck" bootstraps the template from the previous window; "Save template" persists the recurring plan; "Apply to ledger" materializes the window's entries as transactions.
- [x] **Phase 4 — Daily Check (reconciliation)** ✅ _(done)_ — `local/public/daily.html` reconciles the current person's checking: projected balance (ledger net as of today) vs. an entered actual bank balance, shows the difference, and a **"Correct"** button writes a single dated adjustment transaction so the ledger matches reality.
- [ ] **Phase 5 — Migrate plan targets:** editable `plan_targets` with `owner`; savings goals get **variable `start_date`/`end_date`**; debt payoff targets (Apple Card & Discover: balance, APR, monthly payment, target date); editor UI.
- [ ] **Phase 6 — Sync / drift detection:** debt payoff sync (re-project payoff date/interest vs. target) + savings-goal pace vs. deadline + income/investment cadence; plan-vs-actual deltas with status (✅/⚠️/❌).
- [ ] **Phase 7 — Publish + refresh loop (multi-user core):** "publish" (SQLite → `snapshot.json` → git commit/push) and "refresh" (HTTP GET → per-record LWW merge with tombstones); version/timestamp tracking; refresh-before-publish; auto-refresh interval + manual buttons; both-clocks indicator.
- [ ] **Phase 8 — Metrics engine + dashboard UI (shared):** net worth, debt paydown, savings/investment rates, monthly spend excl. CC; health strip + per-domain cards + trend charts, rendered by both local app and published view.
- [ ] **Phase 9 — Polish:** Coast FIRE, drift alerts, DB backups, conflict-audit view, join-accounts (merge to a `shared` checking account) support.
