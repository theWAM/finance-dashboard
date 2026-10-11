# Finance Dashboard

A private money dashboard for one or two people. It keeps your **ledger** (every
deposit and withdrawal, with a running balance), a **paycheck planner**, your
**savings/debt/investment plan**, and a **dashboard** that tells you whether the
plan is on track — all running on your own computer.

> New here? Follow **Get started** below. Curious how it all works under the hood?
> See **[ROADMAP.md](ROADMAP.md)** for the full design and architecture.

---

## Get started (easiest way)

**On a Mac:** double-click **`setup.command`** in this folder.

It will:
1. check you have the tools it needs (and help you install them),
2. download the app (if you don't already have it),
3. install its parts, and
4. start it and open it in your browser at **http://localhost:3000**.

That's it. Leave the little Terminal window open while you use the app; close it
(or press **Ctrl‑C**) when you're done.

### If macOS says *"can't be opened because Apple cannot check it for malicious software"*

That's normal for a small script that isn't signed by a big company — it's safe;
you just have to allow it once. Do **any one** of these:

- **Right‑click** (or Control‑click) `setup.command` → **Open** → in the dialog click
  **Open**. (Right‑clicking gives you an **Open** button the plain double‑click doesn't.)
- Or open  **→ System Settings → Privacy & Security**, scroll down to the message
  about `setup.command`, and click **Open Anyway** — then double‑click it again.
- Or run it from **Terminal**, which is never blocked. Open the Terminal app and paste:
  ```bash
  bash ~/Downloads/finance-dashboard/setup.command
  ```
  (adjust the path if the folder is somewhere else).

If you'd rather not deal with the prompt at all, just use the **manual steps** below —
they do exactly the same thing.

---

## Get started (manual, step by step)

If you'd rather do it by hand:

1. **Install Node.js** (version 22.5 or newer) from <https://nodejs.org/en/download> —
   pick the **macOS Installer (.pkg)**, run it, and click through to the end. This is
   the engine the app runs on. After it finishes, **close and reopen Terminal** so it
   picks up the new command.
2. **Download the app.** If you have `git`:
   ```bash
   git clone https://github.com/theWAM/finance-dashboard.git
   cd finance-dashboard
   ```
   (Or download the ZIP from GitHub and unzip it, then open a Terminal in that folder.)
3. **Install its parts:**
   ```bash
   npm install
   ```
4. **Start it:**
   ```bash
   npm start
   ```
5. Open **http://localhost:3000** in your browser.

To stop the app, click the Terminal window and press **Ctrl‑C**.

---

## Using the app

When it opens, pick **who you are** (Woody or Rajna) — this just personalizes your
view; there's no login. Then explore the tabs across the top:

- **Ledger** — every transaction with a running balance. Click a cell to edit, use
  **Add** at the bottom for new entries, and the checkboxes (they appear when you
  hover a row) to edit or delete several at once. Nothing is saved until you press
  **Save**, so you can review first. Use the **timeframe** dropdown and the
  **Category / Source** filters to narrow things down. A small popup asks *"you
  should have $X in the bank today"* — click ✗ if your bank differs and it'll add a
  correcting entry.
- **This Paycheck** — the current pay period: your paycheck and everything due
  before the next one, with a running balance that warns if you'd overdraw. Use the
  **‹ ›** arrows (or click the dates) to look at other pay periods. Adding an entry
  can be made **recurring** (monthly, every pay period, etc.). The
  **[ Debit | Credit ]** switch under the title turns the same pay period into your
  credit cards — pick a card, see what it owes and where the charges went, and upload
  a statement. Two panels there do the tidying:
  - **Merchant rules** — *"Walmart is Groceries"*, written down once. Statements come
    with the issuer's own categories, and they're often wrong, inconsistent between
    cards, or missing entirely, which is why a quarter of card spending used to land
    in **Misc**. A rule fixes a merchant everywhere: new statements arrive already
    categorized, and **Apply to this window** re-files the rows you're looking at.
    Whenever you correct a category by hand it offers to remember it. Rules save with
    their own **Save rules** button, separately from the ledger.
  - **Looks recurring** — the subscriptions it can see in a card's own history
    (something billed once a month, at about the same amount, three months running).
    **Project forward** writes the future charges into the ledger so a pay period
    shows what's actually coming. They're marked as projections, and when the real
    statement arrives the real charge *replaces* its projection instead of showing up
    twice. Nothing is ever projected without you asking.
- **Plan** — your goals and targets: debts to pay off, savings goals (each with its
  own deadline), and monthly investing. Hover (or tap) **Plan** to also reach the
  **Spending Plan**.
- **Spending Plan** — your Conscious Spending Plan (take-home split into Fixed
  Costs / Investments / Savings / Guilt-Free Spending), comparing each target against
  what actually happened in the ledger. Each bucket opens **collapsed**, so the whole
  plan starts as a four-line overview; its header line is the summary — name, target
  and actual (each with its percent of take-home shown small next to it), and a
  red/green **Δ** for whether you're over or under — click anywhere on the line (or
  **Expand all** / **Collapse all** in the plan header) to open it into the full item
  table. Pick a **timeframe** — here it moves in whole months only (*This month*,
  *Last 3 months*, *Last 12 months*, …), since a spending plan is a monthly one — and
  every line shows the real monthly average for that window, not just the target. The
  trailing choices stop at the end of last month, so a half-finished month never drags
  an average down; to look at the month you're in, pick *This month*. Click a line to
  see the actual transactions behind its number. As with everything else, edits don't
  save until you press **Save**.
- **Dashboard** — the big picture: what's in the bank, how you're spending, and
  whether each debt / savings goal / investment is **on track** (✓), needs a look
  (!), or is behind (✕).

### Settings — themes and low power

The **⚙ gear in the bottom-left corner** of every page opens Settings:

- **Appearance** — two independent choices: a color **family**, and a **Light / Dark /
  Auto** mode.
  - Six families: the original **Slate** (blue-slate dark), **Peach** (peach, pale
    yellow, mint and white), **Bordeaux** (deep wine + honey bronze), **Lagoon** (jewel
    teal + berry), **Orchid** (violet → rose) and **Thicket** (forest green + scarlet).
    Every family ships in *both* light and dark, so picking a family never leaves your
    mode choice behind.
  - **Light** and **Dark** pick the mode outright. **Auto** follows *this computer's*
    own light/dark setting, and the panel says so — the Auto control reports the OS
    answer ("Following this computer's light / dark setting — dark right now") rather
    than pretending to be a third fixed look. Auto has to be chosen on purpose: nobody
    is switched onto it for them, so your appearance never changes on its own the first
    time you open the app after an update.
- **Low power** — a lighter Ledger: cells render as plain text and only become an
  input while you're actually editing one, which makes a long ledger much faster to
  scroll on an older computer. (This used to be a button in the Ledger header.)

The two settings are remembered differently, on purpose:

- **Your family + mode belong to you.** They're saved on your profile as a pair, so
  switching person switches both, and your choice travels with your next **Publish** —
  pick Bordeaux/dark on your laptop and your profile looks Bordeaux/dark on the other
  computer and on the published site too. A pick takes effect and is saved the moment
  you click it: there's no Save step and you don't have to Publish for it to stick on
  your own machine — Publish just carries it to the other computer.
- **Low power belongs to the computer.** It describes what *this* machine can
  render comfortably, so it stays in this browser and never travels — not on Publish,
  not with your profile.

### Sharing between two people

Each person runs this app on their own computer. When you press **Publish** (on the
Ledger), your data is saved to a shared online snapshot; the other person presses
**Sync** to pull it in. ⚠️ The published page is **public**, so only publish if
you're comfortable with that (see the trade-off note in [ROADMAP.md](ROADMAP.md)).

### Backing up your data

Your data lives only on your computer (in `local/dashboard.db`). To make a
timestamped backup copy:
```bash
npm run backup
```

---

## Troubleshooting

- **`command not found: node` (or `npm`)** — Node.js isn't installed, or Terminal
  was open before you installed it. Install it from <https://nodejs.org/en/download>,
  then **fully quit and reopen Terminal** (a still-open window won't see a newly
  installed command). To confirm it's there, run `node -v` — you should see a version
  like `v22.…`. The `setup.command` script now waits for the installer to finish and
  continues on its own, and it looks in the usual install spots
  (`/usr/local/bin`, `/opt/homebrew/bin`) even when your PATH doesn't list them.
- **The page won't load** — make sure the Terminal still shows
  `Finance Dashboard (local) running at http://localhost:3000`. If you closed it,
  run `npm start` again.
- **Port already in use** — start it on another port: `PORT=3001 npm start`, then
  open <http://localhost:3001>.
