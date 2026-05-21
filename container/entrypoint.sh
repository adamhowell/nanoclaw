#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

# Restore .claude.json from the most recent backup. Claude expects this
# config at $HOME/.claude.json, but the SDK's automatic backups live in
# /home/node/.claude/backups/. We only mount the .claude/ subtree (so
# session/auth state persists across spawns) — $HOME/.claude.json itself
# is per-container and won't survive recreation. Re-materialize it from
# the newest backup on each spawn.
LATEST_BACKUP=$(ls -t /home/node/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
if [ -n "$LATEST_BACKUP" ] && [ ! -f /home/node/.claude.json ]; then
  cp "$LATEST_BACKUP" /home/node/.claude.json
  # Chown to the UID setpriv will switch to below — not the "node" user
  # (UID 1000) — so the agent process can write to its own config file.
  # Without this Claude Code logs a warning and falls back to defaults.
  chown "${RUN_UID:-1000}:${RUN_GID:-1000}" /home/node/.claude.json
fi

set -e

cat > /tmp/input.json

# Drop to non-root so Claude Code accepts --dangerously-skip-permissions
# (the CLI refuses that flag when EUID=0). Root-only setup (the .claude.json
# restore above) is done; nothing else needs root.
if [ "$(id -u)" = "0" ]; then
  RUN_UID="${RUN_UID:-1000}"
  RUN_GID="${RUN_GID:-1000}"
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- \
    bun run /app/src/index.ts < /tmp/input.json
else
  exec bun run /app/src/index.ts < /tmp/input.json
fi
