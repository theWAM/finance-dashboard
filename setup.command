#!/bin/bash
# Finance Dashboard — one-click setup + launch (macOS: double-click this file;
# Linux: run `bash setup.command`). Checks prerequisites, downloads the app if
# needed, installs its parts, and starts it in your browser.

REPO_URL="https://github.com/theWAM/finance-dashboard.git"
DEFAULT_DIR="$HOME/finance-dashboard"

# Homebrew installs live here but aren't always on a double-clicked script's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Keep the Terminal window open on any error so the message is readable.
bail() { echo ""; echo "⚠️  $1"; echo ""; read -r -p "Press Return to close…" _; exit 1; }

echo "──────────────────────────────────────────────"
echo "  Finance Dashboard — setup"
echo "──────────────────────────────────────────────"
echo ""

# 1) git ---------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "Git isn't installed. Opening the developer-tools installer…"
  xcode-select --install 2>/dev/null
  bail "Please finish installing the Command Line Tools, then run this again."
fi

# 2) Node.js (need >= 22.5) --------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 22 ] && need_node=0
fi
if [ "$need_node" -ne 0 ]; then
  echo "Node.js 22+ is required."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew…"
    brew install node || bail "Homebrew couldn't install Node. Install it from https://nodejs.org and re-run."
  else
    echo "Opening the Node.js download page — install the LTS version, then run this again."
    (command -v open >/dev/null 2>&1 && open "https://nodejs.org/") || true
    bail "Node.js not found."
  fi
fi
echo "✓ Node $(node -v) and git $(git --version | awk '{print $3}') ready."

# 3) Locate or download the app ---------------------------------------------
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/package.json" ]; then
  APP_DIR="$HERE"                      # script is running inside the app folder
  echo "✓ Using app in $APP_DIR"
  git -C "$APP_DIR" pull --ff-only 2>/dev/null || true
else
  APP_DIR="$DEFAULT_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    echo "Updating existing copy in $APP_DIR…"
    git -C "$APP_DIR" pull --ff-only || true
  else
    echo "Downloading the app to $APP_DIR…"
    git clone "$REPO_URL" "$APP_DIR" || bail "Could not download the app."
  fi
fi

cd "$APP_DIR" || bail "Could not open $APP_DIR."

# 4) Install dependencies ----------------------------------------------------
echo ""
echo "Installing app parts (this can take a minute the first time)…"
npm install || bail "npm install failed."

# 5) Launch ------------------------------------------------------------------
echo ""
echo "✓ Starting Finance Dashboard at http://localhost:3000"
echo "  (Leave this window open while you use it; press Ctrl-C to stop.)"
echo ""
( sleep 2; (command -v open >/dev/null 2>&1 && open "http://localhost:3000") \
        || (command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:3000") ) &
npm start
