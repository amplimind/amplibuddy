#!/bin/bash
# Double-click to start AmpliBuddy.
# The first start sets everything up (a few minutes); later starts take seconds.
# Close this window to stop it.

set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- Node.js: use the one on this Mac if it's new enough, else a private copy in .runtime ---
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}
if [ -x .runtime/node/bin/node ] && node_ok .runtime/node/bin/node; then
  export PATH="$PWD/.runtime/node/bin:$PATH"
elif ! (command -v node >/dev/null && node_ok node); then
  say "Downloading Node.js (only on the first start)…"
  case "$(uname -m)" in arm64) platform=darwin-arm64 ;; *) platform=darwin-x64 ;; esac
  base=https://nodejs.org/dist/latest-v24.x
  entry=$(curl -fsSL "$base/SHASUMS256.txt" | grep -E " node-v[0-9.]+-$platform\.tar\.gz$")
  sum=${entry%% *}
  file=${entry##* }
  tmp=$(mktemp -d)
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file"
  # The checksum from nodejs.org must match, or we stop.
  echo "$sum  $tmp/$file" | shasum -a 256 -c - >/dev/null
  rm -rf .runtime/node && mkdir -p .runtime/node
  tar -xzf "$tmp/$file" -C .runtime/node --strip-components 1
  rm -rf "$tmp"
  export PATH="$PWD/.runtime/node/bin:$PATH"
fi

# --- Dependencies and the web page, only when something changed ---
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Installing (only when something is new)…"
  npm ci --no-audit --no-fund --loglevel=error
fi
if [ ! -f apps/web/dist/index.html ] || [ -n "$(find apps/web packages/shared/src \( -name node_modules -o -path apps/web/dist \) -prune -o -newer apps/web/dist/index.html -type f -print -quit)" ]; then
  say "Building the town…"
  npm run build --silent
fi

say "Starting AmpliBuddy…"
exec node --disable-warning=ExperimentalWarning --import tsx scripts/start.ts
