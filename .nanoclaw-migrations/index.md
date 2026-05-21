# NanoClaw v1 → v2 Migration Guide — Adam Howell's fork (Burnie)

| Field | Value |
| --- | --- |
| Generated | 2026-05-21 |
| Generator | `/migrate-nanoclaw` skill (manual replay) |
| Base (merge-base) | `3ab833b` |
| HEAD at generation | `570b17c` (branch `apple-container-migration`) |
| Upstream HEAD | `0683c6e` (`nanocoai/nanoclaw` `main`, v2.0.64) |
| Tier | 3 — complex (1064 upstream commits, 64 fork commits, 40 changed files, 24-file overlap) |
| Runs on | Mac mini (`burnie@100.105.168.11`), `/Users/burnie/nanoclaw`, Apple Container runtime |

## Migration plan

This is a port across a major architectural rewrite, not a merge. v2 replaced the v1 `Channel` interface with a `ChannelAdapter` pattern, split sessions across `inbound.db`/`outbound.db`, moved channels to a separate `upstream/channels` branch, made Apple Container opt-in, retired group-folder per-channel `.claude/`, and introduced the `ncl` admin CLI. There is no straight-line `git merge` path; the upgrade replays each customization onto a clean v2 base in a worktree.

### Order of operations (Phase 2 staging)

1. **Apple Container runtime.** Merge `upstream/skill/apple-container` into the worktree first (we stay on Apple Container — Burnie's existing data and bridge networking depend on it). Validate it builds.
2. **Custom channel: hwmapp.** Port `src/channels/hwmapp.ts` to the v2 `ChannelAdapter` interface (see `01-channels-hwmapp.md`). This is the highest-risk single file — Burnie's chat depends on it. Validate connect + receive + deliver before going further.
3. **Custom channel: imessage.** Port `src/channels/imessage.ts` similarly. Lower risk (read-only poller). See `01-channels-hwmapp.md` §iMessage.
4. **Core source customizations.** Replay session-binding, new-conversation buffering, status-event streaming, auto-rebind on JID change, and the env-var additions across `src/index.ts`, `src/ipc.ts`, `src/task-scheduler.ts`, `src/types.ts`, `src/config.ts`, `src/db.ts`. See `02-core-source.md`. Many of these are additive and low-risk; `index.ts` is the one to be careful with.
5. **Container agent-runner customizations.** Tool-use status event summarization + `new_conversation` MCP tool in `container/agent-runner/src/index.ts` and `ipc-mcp-stdio.ts`. See `03-container-agent-runner.md`. v2 moved this to **Bun** — port carefully.
6. **Container skills.** Copy 8 active skills verbatim (`accomplice`, `host-browser`, `hwm-api`, `dayjob`, `theachievemint-fulfill`, `voice-delegation`) plus 2 lightly-modified upstream skills (`capabilities`, `status`) into `container/skills/`. Drop `agent-task` (obsolete since /social was retired). See `04-container-skills.md`.
7. **Scripts.** `scripts/auto-deploy.sh`, `com.hwm.nanoclaw-auto-deploy.plist`, `handoff_sync.sh`, `imessage_dispatch.rb`, `handoff_sync_logrotate.sh`. See `05-scripts.md`. NOTE: v2 changed the launchd label scheme to `com.nanoclaw.<sha1>` per-install — update the auto-deploy plist to kick the new label.
8. **Config / build / Husky.** Apply Dockerfile entrypoint changes (only the bits not already in v2's `convert-to-apple-container` skill), package.json deps, .gitignore additions, .husky/pre-commit. See `06-config.md`.
9. **Apple Container post-merge fixes.** Reapply only the parts of `5c56d45` and `c0b58bd` (CREDENTIAL_PROXY_HOST + bridge gateway detection) that the v2 `convert-to-apple-container` skill doesn't already handle. See `07-apple-container-fixups.md`.

### Validation gates

- **After step 1**: `npm install && npm run build && npm test` clean. Container builds.
- **After step 2**: in the worktree with symlinked data, run dev and send a text message from the web UI to Burnie. Reply lands. Send a screenshot; verify it materializes to disk and Claude `Read`s it.
- **After step 6**: scheduled jobs (Burnie daily digest, news fetch) fire as expected on the next interval.

### Rollback

Phase 2.1 creates `backup/pre-migrate-<hash>-<timestamp>` branch and tag. If anything blows up at any stage:

```bash
git reset --hard pre-migrate-<hash>-<timestamp>
launchctl kickstart -k gui/$(id -u)/com.nanoclaw    # restart whichever label is current
```

Auto-deploy on the Mac mini polls every 5 min — pushing a rollback commit to `apple-container-migration` is enough to redeploy the previous code.

### Risk areas

| Area | Risk | Mitigation |
| --- | --- | --- |
| hwmapp channel port | HIGH — v1 `Channel` interface gone; must rewrite against `ChannelAdapter` | Reference `upstream/main:src/channels/cli.ts` as the working v2 example; preserve JID prefix `accomplice:` and ActionCable identifier `{"channel":"AgentRelayChannel"}` exactly. Test attachment download. |
| Per-conversation Claude sessions | HIGH — v2 has its own session model (`inbound.db`/`outbound.db`), our composite-key (`${groupFolder}:${chatJid}`) pattern may not survive | Read `docs/db-session.md` on upstream first; may already be solved. Migration guide step 4 documents the pattern; if v2's pattern is equivalent, skip our customization. |
| Container agent-runner moved to Bun | MEDIUM — our `summarizeToolUse()` and `new_conversation` MCP tool ride on the Anthropic SDK message stream API which may have shifted | Worktree validate; rewrite the tool-use loop if message shape changed. |
| Launchd label rename | LOW but visible — `com.nanoclaw` → `com.nanoclaw.<sha1>` per-install | Update `scripts/auto-deploy.sh` to derive the label via upstream's `setup/lib/install-slug.sh`. |
| `agent-task` skill drop | LOW — already retired | Just don't copy the folder. |

## Applied skills

The only upstream skill branch this fork ever merged in is `upstream/skill/apple-container` (at commit `94cdac7`). Phase 2 re-merges this same branch onto v2 main in the worktree. v2 has additionally introduced a top-level `convert-to-apple-container` skill (in `.claude/skills/`) that handles the user-facing setup flow — see `07-apple-container-fixups.md` for how the two relate.

**Custom (non-upstream) Claude Code skills** in `.claude/skills/`: none. All `.claude/skills/` content is upstream-provided and not modified in this fork.

**Custom container skills** in `container/skills/` to copy as-is: see `04-container-skills.md`.

## Skill interactions

`upstream/skill/apple-container` interacts with our two post-merge fix commits (`5c56d45`, `c0b58bd`) — both adjust networking and `.env` mounting in ways that the v2 `convert-to-apple-container` skill may or may not already handle. `07-apple-container-fixups.md` documents the diff-and-decide step.

`upstream/skill/native-credential-proxy` exists on upstream but is **NOT applied** — Adam chose v2's OneCLI Vault as the sole credential path. Our v1 `credential-proxy.ts` is deliberately dropped.

## Table of contents

- [`01-channels-hwmapp.md`](01-channels-hwmapp.md) — port hwmapp + imessage channels to v2 `ChannelAdapter`
- [`02-core-source.md`](02-core-source.md) — replay session-binding, new-conversation buffering, auto-rebind, env additions across host src
- [`03-container-agent-runner.md`](03-container-agent-runner.md) — tool-use status summarization + `new_conversation` MCP tool inside the container
- [`04-container-skills.md`](04-container-skills.md) — list of skills to copy verbatim into `container/skills/`
- [`05-scripts.md`](05-scripts.md) — auto-deploy + handoff + iMessage relay scripts (including launchd label fix)
- [`06-config.md`](06-config.md) — Dockerfile entrypoint, package.json deps, Husky, .gitignore
- [`07-apple-container-fixups.md`](07-apple-container-fixups.md) — what to keep / drop from our post-merge networking fixes given v2's new setup skill

## Out of scope (intentionally dropped)

- `src/credential-proxy.ts` + `src/credential-proxy.test.ts` (125 lines + tests) — replaced by v2 OneCLI Vault.
- `container/skills/agent-task/` — role-persona feed was retired with the `/social` removal on 2026-05-06.
- `src/types.ts` — `RegisteredGroup` and v1 channel-callback shapes (replaced by v2's `ChannelAdapter` / `ChannelSetup` types).
