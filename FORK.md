# Fork manifest

This install is a fork of [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw)
(branch `v2-port`). This file is the merge checklist: every deliberate divergence
from upstream, why it exists, and what guards it. If an upstream merge conflicts
in a file not listed here, the conflict is probably resolvable in upstream's
favor. Keep this file current — it is the difference between a 20-minute merge
and an afternoon of archaeology.

**Convention:** fork logic lives in fork-owned files; shared files carry only
minimal call sites, each marked with a `// FORK:` comment.

## Fork-owned files (never conflict)

| File(s) | What |
|---|---|
| `src/credential-proxy.ts` (+ test) | Local credential proxy replacing upstream's OneCLI gateway: containers get `ANTHROPIC_BASE_URL` → proxy + placeholder creds, never real secrets. Also owns `CONTAINER_HOST_GATEWAY`, `getProxyBindHost()`, `credentialProxyContainerArgs()`. |
| `src/host-env-passthrough.ts` | HOST_BROWSER_URL/TOKEN + `CONTAINER_ENV_PASSTHROUGH` injection into containers. |
| `src/channels/hwmapp.ts`, `hwmapp-actions.ts` | hwm_app relay channel (ActionCable WS, liveness watchdog, `new_conversation` action). |
| `src/channels/wiring-inheritance.ts` | Auto-created mgs on opted-in channels (hwmapp) inherit a sibling's policy + wirings. |
| `container/agent-runner/src/mcp-tools/conversation.ts` | `new_conversation` MCP tool (morning-briefing threads). |
| `container/skills/{accomplice,capabilities,dayjob,host-browser,hwm-api,status,theachievemint-fulfill,voice-delegation}/` | Install-specific agent skills. |
| `scripts/auto-deploy.sh` + plist | Burnie's 300s fast-forward auto-deploy; stamps upgrade-state (it IS our sanctioned path). |
| `scripts/handoff_sync*.sh`, `scripts/imessage_dispatch.rb`, `scripts/run.sh` | Mini-side helpers (iMessage dispatch, handoff sync). |

## Divergences in shared files

| File | Divergence | Why | Guard |
|---|---|---|---|
| `src/container-runner.ts` | Calls `credentialProxyContainerArgs()` + `hostEnvPassthroughArgs()`; keeps `onecli.ensureAgent` but NOT `applyContainerConfig` (HTTPS_PROXY conflicts with ANTHROPIC_BASE_URL); no `--entrypoint bash` override (image entrypoint must run — setpriv + .claude.json restore — or every spawn exits 1); root start + `RUN_UID`/`RUN_GID`/`HOME` env for the entrypoint's privilege drop. | Credential proxy architecture. | `src/container-runner.test.ts` "credential flow (structural)" |
| `src/container-runtime.ts` | `hostGatewayArgs()` adds `--add-host=host.docker.internal:host-gateway` unconditionally (upstream: Linux-only). | Colima on macOS doesn't inject the hostname; the credential proxy is reached through it. | Startup fails loudly if proxy unreachable |
| `src/router.ts` | Auto-create path consults `findWiringTemplate`/`mirrorTemplateWirings`. | hwmapp conversations all belong to the authenticated owner. | `src/host-core.test.ts` wiring-inheritance cases |
| `src/index.ts` | Starts the credential proxy at boot. | — | `src/credential-proxy.test.ts` |
| `src/config.ts` | `CREDENTIAL_PROXY_PORT`. | — | — |
| `src/channels/adapter.ts` | `inheritWiringOnAutoCreate` + `channelDestinationsAreSessionScoped` flags on `ChannelAdapter`. | — | — |
| `src/modules/agent-to-agent/write-destinations.ts` | On channels with `channelDestinationsAreSessionScoped` (hwmapp), a channel destination takes its platform_id from the session's own mg instead of the destination row — replies land in the originating conversation. | One logical destination ("the user") spans many per-conversation platform_ids. | `write-destinations.test.ts` (fork cases) |
| `container/agent-runner/src/poll-loop.ts` | Idle stand-down: ends the SDK stream after `NANOCLAW_IDLE_EXIT_MS` (default 5 min) idle post-result and exits 0 instead of holding the poll loop until the 30-min SIGTERM. | Clean container lifecycle. | Interleaved with upstream's stream loop — highest-touch merge spot; re-read both sides every merge. |
| `container/agent-runner/src/mcp-tools/index.ts` | Imports `./conversation.js`. | — | — |
| `container/Dockerfile`, `container/entrypoint.sh` | `ENV NODE_OPTIONS=` reset; entrypoint restores `.claude.json`, shadows `/workspace/project/.env`, setprivs root → RUN_UID before exec'ing bun. | Entrypoint contract with container-runner. | Spawns die visibly if broken |
| `container/build.sh` | `CONTAINER_RUNTIME` defaults to `docker` (upstream: Apple `container`, absent on Linux). | Both installs run docker. **Upstream PR candidate.** | — |
| `package.json` | `ws` dependency (hwmapp channel). | — | — |
| `setup/service.ts`, `launchd/com.nanoclaw.plist` | Install-specific service tweaks. | — | — |

## Deliberately dropped from this fork

- **Apple Container support** (was: runtime detection, bridge-gateway discovery,
  file-mount gating, `--mount` syntax, JSON orphan cleanup). Both installs run
  docker (Burnie: Colima; rexcom: native Linux). If ever needed again, upstream's
  `/convert-to-apple-container` skill is the sanctioned path — don't resurrect
  the old fork layer.
- **Upstream's OneCLI gateway as the credential path** (see above; `ensureAgent`
  is kept for approval routing only).

## Merge routine

1. `git fetch upstream && git merge upstream/main` — `rerere` replays past
   resolutions automatically.
2. Walk this file top-to-bottom against the conflicts.
3. `pnpm run build && pnpm test` (the structural tests catch reintroduced
   gateway/entrypoint changes), plus `bun test` + typecheck in
   `container/agent-runner/` if that tree changed.
4. Deploy: push `v2-port` (Burnie auto-deploys + stamps); rexcom is manual.
   Rebuild the agent image on both boxes if `container/` deps or Dockerfile
   changed — auto-deploy does NOT rebuild images.
