#!/bin/bash
# Pull-build-restart cruise control for the nanoclaw host.
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

# Resolve the repo root from the script's own location — keeps the
# script portable across renames/moves and matches the launchd plist
# that points ProgramArguments at <repo>/scripts/auto-deploy.sh.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/auto-deploy.log"
# v2 slugs the launchd label per-install (com.nanoclaw-v2-<sha1>); derive
# at runtime via the upstream helper so this script keeps working through
# repo moves or copies.
PROJECT_ROOT="$REPO_DIR"
# shellcheck disable=SC1091
source "$REPO_DIR/setup/lib/install-slug.sh"
# Portable across both installs: launchd on the Mac mini (Burnie),
# systemd --user on Linux (rexcom).
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  SERVICE=$(launchd_label)
else
  SERVICE="nanoclaw"
fi
# pnpm lives at the homebrew path on macOS; on Linux fall back to
# whatever is on PATH, then corepack (ships with node on rexcom).
if [ -x /opt/homebrew/bin/pnpm ]; then
  PNPM="/opt/homebrew/bin/pnpm"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  PNPM="corepack pnpm"
fi
GIT="git"

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

# Determine whether package.json or the pnpm lockfile changed in the
# incoming commits — if so we need pnpm install before build. v2 uses
# pnpm-lock.yaml (not package-lock.json — that's the v1/npm artifact).
DEP_CHANGED=0
if $GIT diff --name-only "$LOCAL" "$REMOTE" | grep -qE "^(package\.json|pnpm-lock\.yaml)$"; then
  DEP_CHANGED=1
fi

log "pulling $BRANCH: $LOCAL -> $REMOTE${DEP_CHANGED:+ (deps changed)}"

if ! $GIT pull --ff-only --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "pull failed (non-ff?); leaving as-is on $LOCAL"
  exit 1
fi

if [ "$DEP_CHANGED" = "1" ]; then
  log "running pnpm install"
  if ! $PNPM install --silent >>"$LOG_FILE" 2>&1; then
    log "pnpm install failed; NOT restarting"
    exit 1
  fi
fi

log "running pnpm run build"
if ! $PNPM run build >>"$LOG_FILE" 2>&1; then
  log "build failed; NOT restarting (service still on previous code)"
  exit 1
fi

# Stamp the upgrade marker — this script IS our sanctioned update path,
# and upstream's startup tripwire refuses to boot when the code version
# moved without a stamp (it exists to catch raw `git pull`s that skip
# install/build; ours doesn't).
log "stamping upgrade state"
if ! $PNPM exec tsx scripts/upgrade-state.ts set >>"$LOG_FILE" 2>&1; then
  log "upgrade-state stamp failed; NOT restarting (service still on previous code)"
  exit 1
fi

log "kicking $SERVICE"
if [ "$OS" = "Darwin" ]; then
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG_FILE" 2>&1
else
  systemctl --user restart "$SERVICE" >>"$LOG_FILE" 2>&1
fi
log "deploy complete"
