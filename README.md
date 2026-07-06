# Financial Dashboard

A **two-part system** that unifies the currently-scattered personal-finance artifacts — the Google-Sheets tracking ledger, the `fin_plan.html` strategy, the Apple Card detail, and the spending chart — into **one space**, and continuously answers one core question:

> **Is the strategic plan still in sync with reality (the ledger), and are we on track against the metrics all these pages care about?**

The whole point is consolidation: instead of a ledger in one place and a strategy in another that silently drift apart, the dashboard holds the ledger *and* the plan targets together so sync is computed automatically.

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

_All decisions are now settled — nothing blocks the build._

---

## Repo layout

```
finance-dashboard/
├── local/            # Node + Express authoring server + editor UI (runs on localhost; NOT published)
│   ├── server.js     # Express app: serves editor + JSON API
│   └── db.js         # SQLite connection + schema (transactions, plan_targets, sync_meta)
├── shared/           # Pure logic shared by local app and published view
│   ├── merge.js      # per-record last-writer-wins merge (+ tombstones)
│   ├── metrics.js    # running balance + metric/sync computations
│   └── snapshot.js   # snapshot.json build/parse — the data contract
├── published/        # Static read-only site served by GitHub Pages
│   └── index.html    # loads ../data/snapshot.json, renders read-only dashboard
├── data/
│   └── snapshot.json # committed, PUBLIC bridge between the two local apps
├── package.json
└── .gitignore        # ignores node_modules + the local SQLite DB (never committed)
```

> GitHub Pages should be configured to serve the `published/` (and `data/`) content. The local SQLite DB stays on each person's machine and is gitignored; only `snapshot.json` is committed.

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

### 1. Sync / drift detection (the primary job)
Compare what the **plan assumes** against what the **ledger shows**, and flag drift:

- **Debt balances & payoff dates.** The plan has payoff simulators for the Apple Card and Discover (Rajna) card. Compare each simulator's assumed balance and monthly payment against the actual payments flowing through the ledger, and re-project the real payoff date vs. the plan's target.
- **Savings-goal pace.** The plan sets end-of-year targets for the Wedding, Emergency, Vacation, and Apartment funds. Track cumulative contributions in the ledger vs. the planned monthly allocation → ahead / on-track / behind.
- **Investment cadence.** Plan targets (e.g. combined Roth ~$636/mo, individual brokerage ~$364/mo) vs. actual Fidelity/Fundrise contributions in the ledger.
- **Income assumptions.** Plan's take-home / paycheck assumptions vs. actual paycheck deposits (which grow over time in the ledger).
- **Buffer / low-balance risk.** The ledger deliberately runs the running balance near ~$0 after each paycheck. Flag cycles where projected balance goes negative or below a safety threshold.

Each check should render as: **metric name · plan value · actual value · delta · status (✅ on track / ⚠️ drifting / ❌ off).**

### 2. Core financial metrics (things the files care about)
- Net worth trajectory (savings + investments − debt) over time
- Total debt outstanding and month-over-month paydown
- Total interest paid / avoided (mirrors the plan's simulators)
- Monthly cash flow: income vs. outflow, and monthly spending **excluding** CC payments (mirrors Chart1)
- Savings rate and investment rate as % of take-home
- Progress bars toward each savings-goal target
- Coast FIRE progress (long-horizon metric the plan emphasizes)

### 3. Presentation
- Summary "health" strip at top: overall in-sync status + top warnings
- Per-domain cards: Debt, Savings, Investments, Cash Flow, Long-term (Coast FIRE)
- Trend charts over the ledger's date range
- Drill-down into any flagged drift

---

## Architecture notes

- **Local app = Node + Express + SQLite.** Runs on localhost, no auth. SQLite (a single local file) holds the ledger transactions *and* the migrated plan targets. The metrics/sync engine lives here.
- **Migrated plan targets.** `fin_plan.html`'s strategic assumptions become editable rows/settings in SQLite (e.g. `plan_targets`: debt payoff goals, savings allocations, investment cadence, Coast FIRE inputs). The old `fin_plan.html` is superseded by the app + published view.
- **Shared render core.** Metrics/sync computation and the chart/card components are shared so the local app and the published view show identical results; the only differences are edit-vs-read-only and data source (SQLite live vs. committed snapshot).
- **Snapshot format.** The publish step exports SQLite → a single versioned `dashboard/data/snapshot.json` (real numbers, public). That file is the contract the published static view fetches.
- **Publish flow.** Local edits in SQLite → "publish" exports `snapshot.json` → commit + push → GitHub Pages serves the updated read-only view.
- **Separation of concerns.** `dashboard/local/` (Node server + editor UI), `dashboard/shared/` (metrics/sync + render components), `dashboard/published/` (static read-only entry), `dashboard/data/snapshot.json` (bridge). SQLite DB file stays gitignored; only the snapshot is committed.

## Roadmap

_Phases build on the two-part, two-person model: Node + SQLite local apps ↔ shared `snapshot.json` ↔ static published view. One open decision (conflict strategy) is confirmed in Phase 0 and shapes the record schema._

- [ ] **Phase 0 — Scaffolding & sync design:** create `dashboard/` layout (`local/`, `shared/`, `published/`, `data/`); stand up Node + Express + SQLite; bake the sync metadata into the schema for per-record LWW merge (record `id`/`created_at`/`updated_at`/`deleted_at`; snapshot `version`/`published_at`/`published_by`); gitignore the DB file; define the `snapshot.json` contract.
- [ ] **Phase 1 — Editable ledger (replaces the Sheet):** transaction model (Date, Description/category, Source/Recipient, Deposit, Withdrawal, auto running-balance) with sync metadata; spreadsheet-style editable grid with live cell updates persisted to SQLite; one-time CSV import to seed from `Sheet1.csv`.
- [ ] **Phase 2 — Migrate plan targets:** model the `fin_plan.html` strategy as editable `plan_targets` (start with Apple Card & Discover payoff: balance, APR, monthly payment, target payoff date); editor UI.
- [ ] **Phase 3 — Debt payoff sync (first feature):** compute actual payments per card from the ledger; re-project real payoff date & interest vs. the migrated target; render plan-vs-actual delta with status (✅/⚠️/❌).
- [ ] **Phase 4 — Publish + refresh loop (multi-user core):** "publish" (SQLite → `snapshot.json` → git commit/push) and "refresh" (HTTP GET snapshot → per-record LWW merge with tombstones); version/timestamp tracking; refresh-before-publish; auto-refresh interval + manual buttons; both-clocks UI indicator.
- [ ] **Phase 5 — Metrics engine:** net worth, total debt & paydown, savings/investment rates, monthly spend excl. CC, low-balance risk.
- [ ] **Phase 6 — Dashboard UI (shared):** health strip, per-domain cards (Debt, Savings, Investments, Cash Flow, Coast FIRE), trend charts, drill-down — rendered by both the local app and the published view from the shared core.
- [ ] **Phase 7 — Full sync coverage & polish:** extend plan-vs-actual sync to savings/investment/income targets and Coast FIRE; drift alerts; DB backups; conflict-audit view.
