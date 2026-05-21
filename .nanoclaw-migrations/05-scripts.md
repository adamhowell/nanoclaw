# 05 — Scripts (Mac mini automation)

Five scripts live in `scripts/`. All are Mac-mini-specific (paths reference `/Users/burnie/...` and macOS-native commands like `launchctl`, `osascript`).

## scripts/auto-deploy.sh + com.hwm.nanoclaw-auto-deploy.plist

**Intent:** Poll `origin/<branch>` every 5 min, fast-forward on new commits, run `npm install` (only if package.json/lock changed), `npm run build`, restart the nanoclaw launchd service.

**Files to copy:** both, verbatim except:

### REQUIRED FIX for v2: launchd label rename

v2.0.63 introduced per-install slugged service names: `com.nanoclaw.<sha1(projectRoot)[:8]>` instead of `com.nanoclaw`. Our `auto-deploy.sh` currently has `SERVICE="com.nanoclaw"` hardcoded — that name no longer matches the running service after v2 install.

**How to fix:**

In `scripts/auto-deploy.sh`, replace the static `SERVICE` constant with derived-at-runtime:

```bash
# v1 (current):
SERVICE="com.nanoclaw"

# v2 (after migration):
# Derive the slugged label from the install path. Upstream ships
# setup/lib/install-slug.sh with a `launchd_label` helper for this.
source "$REPO_DIR/setup/lib/install-slug.sh"
SERVICE=$(launchd_label)
```

Verify the path `setup/lib/install-slug.sh` exists in the v2 worktree (per CHANGELOG it does). The plist file (`com.hwm.nanoclaw-auto-deploy.plist`) only needs its `ProgramArguments` updated if the script path changes — keep the path stable.

### Other behavior to preserve

- Safety checks: skip if dirty tree, skip if non-ff pull, don't restart if build fails (leaves previous nanoclaw running).
- Logs at `/Users/burnie/nanoclaw/logs/auto-deploy.log`.
- StartInterval=300 (5 min).
- RunAtLoad=true.
- Environment PATH includes `/opt/homebrew/bin`.

## scripts/handoff_sync.sh + handoff_sync_logrotate.sh

**Intent:** Polls a macOS Continuity Handoff event database, syncs it to `/Users/burnie/nanoclaw/data/handoff_outbox/` (the theachievemint-fulfill skill reads from this folder). Logrotate keeps log size in check.

**Copy verbatim.** Both are pure shell scripts; not coupled to v1 or v2 host code.

**Verify:** Confirm the corresponding launch agent `~/Library/LaunchAgents/com.hwm.handoff_sync.plist` is still installed and active on the Mac mini after migration (`launchctl list | grep handoff`).

## scripts/imessage_dispatch.rb

**Intent:** Ruby script that watches `/Users/burnie/nanoclaw/data/imessage_outbox/` for queued outbound iMessages and dispatches them via AppleScript. Called from `com.hwm.imessage_dispatch.plist`.

**Copy verbatim.** Pure Ruby + AppleScript, no host coupling.

## File permissions

After copying, ensure shell scripts are executable in the worktree:

```bash
chmod +x scripts/auto-deploy.sh scripts/handoff_sync.sh scripts/handoff_sync_logrotate.sh
chmod +x scripts/imessage_dispatch.rb
```

## What about the launch agents themselves?

The plist files in `~/Library/LaunchAgents/` on the Mac mini are NOT in this repo (except for `com.hwm.nanoclaw-auto-deploy.plist` which IS in the repo at `scripts/`). The others — `com.hwm.handoff_sync.plist`, `com.hwm.imessage_dispatch.plist`, `com.hwm.cloudflared.plist`, `com.hwm.host-browser.plist`, `com.hwm.voice-bridge.plist`, `com.hwm.always-on-chrome.plist`, `com.hwm.imessage_inbound.plist` — live only on the Mac mini.

**Migration:** No action needed for those. They remain installed and continue working. The only one we need to touch is the new `com.hwm.nanoclaw-auto-deploy.plist` (already installed) which references `scripts/auto-deploy.sh`. After Phase 2 swap, run a final `cp scripts/com.hwm.nanoclaw-auto-deploy.plist ~/Library/LaunchAgents/` + `launchctl kickstart -k gui/$(id -u)/com.hwm.nanoclaw-auto-deploy` to pick up any plist changes.

## com.nanoclaw.plist (the main service)

This plist is also outside the repo (installed once at setup). After v2 install, it has a NEW slugged label. The migration's Phase 2.9 "Restart the service" step needs to use the new label:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
# v2 setup installs a new plist with the slugged label, e.g. ~/Library/LaunchAgents/com.nanoclaw.<sha1>.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.<sha1>.plist
```

The exact slug for our install: derive from `/Users/burnie/nanoclaw` via the same `install-slug.sh` helper.
