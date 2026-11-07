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

# Failures used to be silent: a dirty tree logged "skip" and exited 0, a pull
# that couldn't fast-forward exited 1, and nothing told anyone. On 2026-11-07
# Burnie turned out to have missed every update since 2026-10-23 (4,269 failed
# pulls) because two skills sat on the Mini uncommitted while the same files
# arrived from GitHub. Now a failure that lasts an hour texts Adam, once a day
# until it's fixed, through hwm_app (HWM_API_TOKEN in .env; no token, no text).
STATE_FILE="$LOG_DIR/auto-deploy.failing"
ALERT_AFTER=3600
ALERT_EVERY=86400

hwm_token() {
  [ -n "${HWM_API_TOKEN:-}" ] && { echo "$HWM_API_TOKEN"; return; }
  [ -f "$REPO_DIR/.env" ] && sed -n 's/^HWM_API_TOKEN=//p' "$REPO_DIR/.env" | tr -d '"' | head -1
}

failing() {
  local reason="$1" now first last
  now=$(date +%s)
  first=$(sed -n 1p "$STATE_FILE" 2>/dev/null || true)
  last=$(sed -n 2p "$STATE_FILE" 2>/dev/null || true)
  [ -n "$first" ] || first=$now
  [ -n "$last" ] || last=0
  if [ $((now - first)) -ge $ALERT_AFTER ] && [ $((now - last)) -ge $ALERT_EVERY ]; then
    local token host hours
    token=$(hwm_token)
    host=$(hostname -s)
    hours=$(( (now - first) / 3600 ))
    if [ -n "$token" ]; then
      curl -sf -m 20 -X POST https://app.hardworkmontage.com/api/v1/texts \
        -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
        -d "{\"text\": \"$host hasn't taken a code update for ${hours}h: $reason. See logs/auto-deploy.log.\"}" >/dev/null 2>&1 \
        && last=$now && log "alerted: $reason"
    fi
  fi
  printf '%s\n%s\n' "$first" "$last" > "$STATE_FILE"
}

healthy() { rm -f "$STATE_FILE"; }

# Files GitHub is about to add that already sit here untracked. When they are
# byte-for-byte what is coming, they were copied or edited here and then
# committed elsewhere: move them aside so the pull can go ahead. Anything that
# differs is real local work and stays put (and the pull keeps failing, loudly).
clear_identical_untracked() {
  local remote="$1" moved=0 f
  local aside="$LOG_DIR/untracked-aside/$(date '+%Y%m%d-%H%M%S')"
  while IFS= read -r f; do
    [ -n "$f" ] && [ -e "$f" ] || continue
    $GIT ls-files --error-unmatch "$f" >/dev/null 2>&1 && continue
    if $GIT show "$remote:$f" 2>/dev/null | cmp -s - "$f"; then
      mkdir -p "$aside/$(dirname "$f")"
      mv "$f" "$aside/$f"
      moved=$((moved + 1))
    fi
  done < <($GIT diff --name-only --diff-filter=A HEAD "$remote")
  [ "$moved" -gt 0 ] && log "moved $moved untracked file(s) identical to $remote aside to $aside"
  return 0
}

cd "$REPO_DIR"

BRANCH=$($GIT rev-parse --abbrev-ref HEAD)

# Working tree check — refuse to deploy if there are local edits,
# since `git pull` would either fail or merge unexpectedly.
if ! $GIT diff --quiet || ! $GIT diff --cached --quiet; then
  log "skip: working tree dirty on $BRANCH"
  failing "uncommitted changes on $BRANCH ($($GIT diff --name-only | head -3 | tr '\n' ' '))"
  exit 0
fi

# Quiet fetch so the log isn't noisy on every tick.
if ! $GIT fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "fetch failed on $BRANCH"
  failing "can't fetch from GitHub"
  exit 1
fi

LOCAL=$($GIT rev-parse "$BRANCH")
REMOTE=$($GIT rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  healthy
  exit 0
fi

# Determine whether package.json or the pnpm lockfile changed in the
# incoming commits — if so we need pnpm install before build. v2 uses
# pnpm-lock.yaml (not package-lock.json — that's the v1/npm artifact).
DEP_CHANGED=0
if $GIT diff --name-only "$LOCAL" "$REMOTE" | grep -qE "^(package\.json|pnpm-lock\.yaml)$"; then
  DEP_CHANGED=1
fi

log "pulling $BRANCH: $LOCAL -> $REMOTE$([ "$DEP_CHANGED" = "1" ] && echo " (deps changed)")"

clear_identical_untracked "$REMOTE"
if ! $GIT pull --ff-only --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "pull failed (non-ff?); leaving as-is on $LOCAL"
  failing "the pull from GitHub keeps failing (local commits, or local files in the way)"
  exit 1
fi

# Skill and doc changes are read fresh by every container, and this script is
# read fresh every run: neither needs a build or a restart, and a restart cuts
# off whatever Burnie is in the middle of (2026-11-07, an Etsy check).
if ! $GIT diff --name-only "$LOCAL" "$REMOTE" | grep -qvE "^(container/skills/|docs/|scripts/auto-deploy\.sh$|[^/]*\.md$)"; then
  log "only skills, docs or this script changed; no build or restart needed"
  healthy
  exit 0
fi

if [ "$DEP_CHANGED" = "1" ]; then
  log "running pnpm install"
  if ! $PNPM install --silent >>"$LOG_FILE" 2>&1; then
    log "pnpm install failed; NOT restarting"
    failing "pnpm install failed"
    exit 1
  fi
fi

log "running pnpm run build"
if ! $PNPM run build >>"$LOG_FILE" 2>&1; then
  log "build failed; NOT restarting (service still on previous code)"
  failing "the build failed"
  exit 1
fi

# Stamp the upgrade marker — this script IS our sanctioned update path,
# and upstream's startup tripwire refuses to boot when the code version
# moved without a stamp (it exists to catch raw `git pull`s that skip
# install/build; ours doesn't).
log "stamping upgrade state"
if ! $PNPM exec tsx scripts/upgrade-state.ts set >>"$LOG_FILE" 2>&1; then
  log "upgrade-state stamp failed; NOT restarting (service still on previous code)"
  failing "the upgrade stamp failed"
  exit 1
fi

log "kicking $SERVICE"
if [ "$OS" = "Darwin" ]; then
  launchctl kickstart -k "gui/$(id -u)/$SERVICE" >>"$LOG_FILE" 2>&1
else
  systemctl --user restart "$SERVICE" >>"$LOG_FILE" 2>&1
fi
log "deploy complete"
healthy
