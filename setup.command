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
# Look for a usable Node by PATH *and* by the places installers actually put it
# (the official .pkg → /usr/local/bin, Homebrew on Apple Silicon → /opt/homebrew/bin).
# Finder-launched scripts often have a minimal PATH, so probing absolute paths is
# what makes this reliable right after someone installs Node.
find_node() {
  local cand v dir
  for cand in node /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if command -v "$cand" >/dev/null 2>&1; then cand="$(command -v "$cand")"; fi
    [ -x "$cand" ] || continue
    v="$("$cand" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "${v:-0}" -ge 22 ]; then
      dir="$(cd "$(dirname "$cand")" && pwd)"
      export PATH="$dir:$PATH"        # ensure node AND its sibling npm are reachable
      return 0
    fi
  done
  return 1
}

if ! find_node; then
  echo "Node.js 22 or newer is required — it isn't installed yet."
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew…"
    brew install node || true
  else
    echo ""
    echo "Opening the Node.js download page in your browser."
    echo "→ Click the big LTS button, run the installer, and click through to the end."
    (command -v open >/dev/null 2>&1 && open "https://nodejs.org/en/download") || true
    echo ""
    echo "No need to re-run this — I'll keep checking and continue automatically"
    echo "once Node is installed. (Press Ctrl-C to stop.)"
    tries=0
    until find_node; do
      sleep 5
      tries=$((tries + 1))
      [ $((tries % 6)) -eq 0 ] && echo "  …still waiting for Node.js to finish installing…"
      if [ "$tries" -ge 180 ]; then     # ~15 min
        bail "Still can't find Node.js. Finish the installer from https://nodejs.org/en/download, then run this again."
      fi
    done
  fi
  find_node || bail "Node.js still isn't available. Install it from https://nodejs.org/en/download and run this again."
fi

# npm ships alongside node; make sure it's actually callable before we lean on it.
command -v npm >/dev/null 2>&1 || bail "Found Node ($(node -v)) but not npm. Reinstall Node.js from https://nodejs.org/en/download."
echo "✓ Node $(node -v), npm $(npm -v), git $(git --version | awk '{print $3}') ready."

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
