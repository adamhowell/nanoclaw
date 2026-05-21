# 07 — Apple Container post-merge fixups

The `upstream/skill/apple-container` branch gets re-merged in Phase 2.4. After that merge, two of our fork's commits made follow-up fixes to networking + `.env` mounting. v2 has since introduced a top-level `convert-to-apple-container` skill which may already incorporate these fixes — diff before reapplying.

## Our two fork-specific fix commits

### `5c56d45` — "fix: Apple Container networking and .env mount"

**Intent:** Make Apple Container work on first cold-boot.

Specifically:
- The credential proxy needs to bind to an interface that exists before any container starts. Apple Container creates `bridge100` lazily when the first container starts, so binding to it at host-boot time fails.
- Bind credential proxy to `0.0.0.0` instead.
- Detect the host gateway IP (`bridge100` if up, else `bridge0`, else hardcoded `192.168.64.1`) and pass it to containers as `CONTAINER_HOST_GATEWAY`.
- Remove the `/dev/null` `.env` shadow mount from the Docker container args — Apple Container only supports directory mounts, not file mounts. `.env` shadowing now happens inside the entrypoint via `mount --bind` (which needs root, hence the entrypoint privilege-drop pattern in `06-config.md`).

**v2 status:** Read `git show upstream/main:.claude/skills/convert-to-apple-container/SKILL.md`. The skill almost certainly addresses these same concerns since they're inherent to Apple Container. Likely already handled.

**How to apply:** After `upstream/skill/apple-container` is merged in the worktree, run:
```bash
cd $WORKTREE && bash .claude/skills/convert-to-apple-container/SKILL.md  # if it has a run-this-script section
# OR read it and apply manually
```
Then diff `src/container-runtime.ts` and `container/Dockerfile` between worktree and main tree. Reapply only what's missing from the worktree.

If v2's apple-container skill does NOT handle the bridge IP detection (unlikely), port the `detectHostGateway()` function from our `src/container-runtime.ts` verbatim.

### `c0b58bd` — "fix: require CREDENTIAL_PROXY_HOST for Apple Container networking"

**Intent:** Hardens `5c56d45` by removing the fallback — instead of guessing the bridge IP, require the user to set `CREDENTIAL_PROXY_HOST` explicitly during onboarding, with a clear error pointing to `/convert-to-apple-container`. Prevents silent failures on first setup.

**v2 status:** Very likely OBSOLETE — v2's `convert-to-apple-container` skill handles onboarding and almost certainly sets up `CREDENTIAL_PROXY_HOST` (or v2's equivalent variable) during setup.

**How to apply:** Read v2's skill content. If v2 enforces this requirement (or doesn't need it because OneCLI handles credentials differently), DROP this customization. If v2 has a softer fallback that we don't trust, port the explicit-requirement-with-clear-error.

## Outstanding ambiguity to test in the worktree

We're keeping Apple Container, but we're dropping `src/credential-proxy.ts` (trusting v2's OneCLI Vault). These two decisions interact:

- The original `5c56d45` fix existed to make the **credential proxy** reachable from containers.
- If v2 OneCLI doesn't need a credential proxy (no longer binds a local port), the bridge-IP detection may be unnecessary in our fork.

**Action:** After Phase 2.4 merges `skill/apple-container`, **before** reapplying any fixup:
1. Try `pnpm run build && pnpm test` first.
2. Start the container manually with a trivial agent — see if credentials get to the agent via OneCLI without any of our fixups.
3. If it works, drop both `5c56d45` and `c0b58bd` from the migration. Document that v2 + OneCLI resolved the underlying issues.
4. If it fails, port only the parts needed to recover.

## Verify upstream branch exists

Confirmed at guide generation: `upstream/skill/apple-container` exists on the v2 remote (`git branch -r --list 'upstream/skill/*'` returns it). Phase 2.4 can re-merge it.

Also confirmed: `upstream/skill/native-credential-proxy` exists. We are deliberately NOT applying this — Adam chose OneCLI Vault. Document that decision in `.nanoclaw-migrations/index.md` (already done).
