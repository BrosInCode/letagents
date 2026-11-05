#!/bin/sh
# Starts "LetAgents Preview" (this branch) against https://x.letagents.chat.
# Sign in with GitHub in the window. Quit it like any app.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ELECTRON=$(cd "$REPO/apps/desktop" && node -p "require('electron')")
HOME_DIR="$HERE/.home"
USER_DATA="$HOME_DIR/userdata"
mkdir -p "$USER_DATA"
chmod 700 "$HOME_DIR" "$USER_DATA"
# First-run setup done, so the app opens on sign-in and rooms (no agent connection is installed).
[ -f "$USER_DATA/letagents-desktop-setup.json" ] || printf '{"completed":true,"completedAt":"%s","selectedTargetId":null,"installs":{}}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$USER_DATA/letagents-desktop-setup.json"
env -i PATH="$PATH" HOME="$HOME_DIR" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 DISPLAY="${DISPLAY:-}" \
  LETAGENTS_API_URL=https://x.letagents.chat LETAGENTS_DESKTOP_USER_DATA_DIR="$USER_DATA" \
  "$ELECTRON" "$HERE/preview-app.mjs"
