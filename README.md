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
  can be made **recurring** (monthly, every pay period, etc.).
- **Plan** — your goals and targets: debts to pay off, savings goals (each with its
  own deadline), and monthly investing.
- **Dashboard** — the big picture: what's in the bank, how you're spending, and
  whether each debt / savings goal / investment is **on track** (✓), needs a look
  (!), or is behind (✕).

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
