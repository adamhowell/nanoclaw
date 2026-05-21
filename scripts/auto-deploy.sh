#!/bin/bash
# Pull-build-restart cruise control for nanoclaw on Burnie's Mac mini.
#
# Polls origin for new commits on the currently-checked-out branch.
# When the local HEAD is behind origin, fast-forward, rebuild, and
# kick the nanoclaw launchd service. Idempotent — exits 0 silently
# when there's nothing to do. Refuses to pull anything that isn't a
# fast-forward (so a force-pushed rebase upstream won't silently
# clobber local work).
#
# Wired via ~/Library/LaunchAgents/com.hwm.nanoclaw-auto-deploy.plist
# (StartInterval 300s). Output goes to logs/auto-deploy.log so a
# silent miss is debuggable after the fact.

set -euo pipefail

REPO_DIR="/Users/burnie/nanoclaw"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/auto-deploy.log"
SERVICE="com.nanoclaw"
NPM="/opt/homebrew/bin/npm"
GIT="/usr/bin/git"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

cd "$REPO_DIR"

BRANCH=$($GIT rev-parse --abbrev-ref HEAD)

# Working tree check — refuse to deploy if there are local edits,
# since `git pull` would either fail or merge unexpectedly.
if ! $GIT diff --quiet || ! $GIT diff --cached --quiet; then
  log "skip: working tree dirty on $BRANCH"
  exit 0
fi

# Quiet fetch so the log isn't noisy on every tick.
if ! $GIT fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "fetch failed on $BRANCH"
  exit 1
fi

LOCAL=$($GIT rev-parse "$BRANCH")
REMOTE=$($GIT rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# Determine whether package.json or the lockfile changed in the
# incoming commits — if so we need npm install before build.
DEP_CHANGED=0
if $GIT diff --name-only "$LOCAL" "$REMOTE" | grep -qE "^(package\.json|package-lock\.json)$"; then
  DEP_CHANGED=1
fi

log "pulling $BRANCH: $LOCAL -> $REMOTE${DEP_CHANGED:+ (deps changed)}"

if ! $GIT pull --ff-only --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "pull failed (non-ff?); leaving as-is on $LOCAL"
  exit 1
fi

if [ "$DEP_CHANGED" = "1" ]; then
  log "running npm install"
  if ! $NPM install --silent >>"$LOG_FILE" 2>&1; then
    log "npm install failed; NOT restarting"
    exit 1
  fi
fi

log "running npm run build"
if ! $NPM run build >>"$LOG_FILE" 2>&1; then
  log "build failed; NOT restarting (service still on previous code)"
  exit 1
fi

log "kicking $SERVICE"
launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG_FILE" 2>&1
log "deploy complete"
