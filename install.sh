#!/usr/bin/env bash
# Partial Duplicate Checker — installer.
#   ./install.sh                 # local, auto-detect Stash plugins dir
#   ./install.sh /path/plugins   # local, explicit dir
#   ./install.sh user@host       # remote over SSH (auto-detect dir)
set -euo pipefail

PLUGIN_ID="partial_dup_checker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES=(partialdup_checker.yml manifest partialdup.py partialdup.js partialdup.css)
DEFAULT_DIRS=("$HOME/.stash/plugins" "/root/.stash/plugins")

echo "Running unit tests..."
( cd "$SCRIPT_DIR" && python3 -m unittest test_partialdup ) || {
  echo "tests failed — aborting"; exit 1; }

if [[ "${1:-}" == *@* ]]; then
  REMOTE="$1"
  TARGET=""
  for d in "${DEFAULT_DIRS[@]}"; do
    if ssh "$REMOTE" "[ -d '$d' ]"; then TARGET="$d"; break; fi
  done
  [[ -n "$TARGET" ]] || { echo "no plugins dir on $REMOTE"; exit 1; }
  ssh "$REMOTE" "mkdir -p '$TARGET/$PLUGIN_ID'"
  for f in "${FILES[@]}"; do scp "$SCRIPT_DIR/$f" "$REMOTE:$TARGET/$PLUGIN_ID/$f"; done
  echo "Installed to $REMOTE:$TARGET/$PLUGIN_ID"
else
  TARGET="${1:-}"
  if [[ -z "$TARGET" ]]; then
    for d in "${DEFAULT_DIRS[@]}"; do [[ -d "$d" ]] && TARGET="$d" && break; done
  fi
  [[ -n "$TARGET" ]] || { echo "no plugins dir found; pass one as an argument"; exit 1; }
  mkdir -p "$TARGET/$PLUGIN_ID"
  for f in "${FILES[@]}"; do cp "$SCRIPT_DIR/$f" "$TARGET/$PLUGIN_ID/$f"; done
  echo "Installed to $TARGET/$PLUGIN_ID"
fi

echo "Next: Stash -> Settings -> Plugins -> Reload Plugins."
echo "Deps: pip install requests pillow numpy (or apk add py3-numpy py3-pillow); ffmpeg on PATH."
