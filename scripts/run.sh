#!/bin/bash
# Launches nanoclaw v2 with .env loaded into process.env.
#
# launchd has no native env-file directive, and v2's container-runtime.ts
# reads CREDENTIAL_PROXY_HOST (and other settings) via process.env, not
# through the host's readEnvFile() helper. Without this wrapper sourcing
# .env, those vars are missing at boot and the host crashes during
# startCredentialProxy (and individual workers may behave inconsistently
# depending on which path read what).
#
# Wired via setup/service.ts (which writes ~/Library/LaunchAgents/<label>.plist
# pointing here) and matched in the systemd unit. Idempotent — safe to invoke
# directly for manual restarts. The example plist at launchd/com.nanoclaw.plist
# is kept in-sync as documentation.

set -euo pipefail

# Resolve the repo root regardless of CWD when launchd invokes us.
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Load .env into the environment if present. Values with spaces or shell
# metachars in .env will need to be quoted by whoever writes them — we
# treat the file as a shell-sourceable list of KEY=value lines.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Resolve node from the wrapper's environment (PATH set by launchd plist)
# rather than hardcoding /opt/homebrew/bin/node so this works on Intel
# Macs (/usr/local/bin/node) and on hosts using nvm/asdf via PATH.
exec node dist/index.js
