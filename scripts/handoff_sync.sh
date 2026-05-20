#!/usr/bin/env bash
# Rsync new files from ~/nanoclaw/data/handoff_outbox/ to Adam's Mac
# at ~/Desktop/_handoff/ over Tailscale. Idempotent — re-runs are
# cheap (rsync only ships changed files). Source is the source of
# truth for sequential numbering; destination is a mirror Adam's eye
# touches first.

set -uo pipefail

SRC="$HOME/nanoclaw/data/handoff_outbox/"
DEST_HOST="adams-macbook-pro"
DEST_USER="adamhowell"
DEST_PATH="~/Desktop/_handoff/"
LOG="$HOME/nanoclaw/logs/handoff_sync.log"

mkdir -p "$(dirname "$LOG")"

# Only run if there's anything in the outbox — avoids logging "synced 0"
# spam every 10s when idle.
if [ -z "$(ls -A "$SRC" 2>/dev/null)" ]; then
  exit 0
fi

NOW=$(date "+%Y-%m-%dT%H:%M:%S%z")

# Capture which new files we're about to ship (rsync --dry-run gives
# us this line-prefixed list; filter only file transfers).
NEW_FILES=$(rsync -avz --ignore-existing --dry-run \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=5" \
  "$SRC" "${DEST_USER}@${DEST_HOST}:${DEST_PATH}" 2>/dev/null \
  | grep -E "^[0-9]{3}_.+\.svg$" || true)

if [ -z "$NEW_FILES" ]; then
  # Nothing new — silent exit
  exit 0
fi

# Do the actual transfer.
if rsync -avz --ignore-existing \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=5" \
  "$SRC" "${DEST_USER}@${DEST_HOST}:${DEST_PATH}" \
  >> "$LOG" 2>&1; then
  for f in $NEW_FILES; do
    echo "$NOW [ok] $f -> ${DEST_HOST}:${DEST_PATH}" >> "$LOG"
  done
else
  echo "$NOW [err] rsync exit=$? (see entries above)" >> "$LOG"
fi
# Rotate log if it's gotten big.
[ -x "$HOME/nanoclaw/scripts/handoff_sync_logrotate.sh" ] && "$HOME/nanoclaw/scripts/handoff_sync_logrotate.sh"
