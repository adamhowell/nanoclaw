# 06 — Config / build / Husky

## package.json (root)

Customizations vs upstream base (`3ab833b`):

- Added: `@anthropic-ai/sdk` (pinned, used by container/agent-runner) — verify v2's existing deps; may already include this.
- Removed: direct `pino` / `pino-pretty` deps (commit `b341bc1`) — v1.2.36 replaced pino with built-in logger. v2 likely already on the built-in logger; no action.
- Other host deps (`pino`, `pino-pretty`, `ws`, `yaml`, `zod`, plus dev `@types/ws`, `@vitest/coverage-v8`) — verify each is in v2's package.json. If missing, add.

**How to apply:** After Phase 2 worktree creation, diff `package.json` between worktree (clean v2) and the main tree (our v1 fork). Add the deps our fork uses that v2 doesn't have. v2 may use `pnpm` (per CHANGELOG: "Host remains on Node + pnpm") instead of `npm` — adjust install commands accordingly.

## container/Dockerfile

v1 customizations (vs the base `3ab833b` Dockerfile, after the `upstream/skill/apple-container` merge):

- **Removed `fonts-noto-cjk`** — unused CJK font deps, ~50MB savings.
- **Entrypoint rewritten** to:
  - Run initially as root (so `mount --bind /dev/null /workspace/project/.env` can shadow the env file — Apple Container can't mount files, only directories).
  - Drop privilege via `setpriv --reuid=$RUN_UID --regid=$RUN_GID` after the bind mount.

**v2 status:** Read v2's `container/Dockerfile` after the `upstream/skill/apple-container` merge in the worktree. v2's apple-container skill may already handle `.env` shadowing and privilege drop differently (the `convert-to-apple-container` skill mentioned in CHANGELOG may bake it in).

**How to apply:** Diff after Phase 2.4 (re-merge of apple-container skill). Reapply only the bits v2 doesn't already do.

## container/build.sh

Minor: changed `docker` to `${CONTAINER_RUNTIME}` variable. v2's Dockerfile / build flow may have superseded this entirely with a v2-aware build script. Read v2's `container/build.sh` first.

## .gitignore

Added these patterns (commit `f8ab52a`): `*.bak`, `*.bak.*` (env file backups and script snapshots — may carry secrets if committed).

**Copy verbatim** — pure additive, no conflict.

## .husky/pre-commit

Added a pre-commit hook that runs `npm run format:fix` (Prettier auto-format) before each commit. Includes a PATH augmentation for Homebrew so the hook works on the Mac mini.

**Copy verbatim** unless v2 ships a different pre-commit hook. If v2 has its own, MERGE them (run both).

**Side note:** the existence of this hook is what kept producing prettier-reflow diffs on `hwmapp.ts` that blocked auto-deploy in our session. Worth keeping but be aware.

## Reapply order

1. After worktree is created and skill/apple-container is merged: diff `Dockerfile`, `package.json`, `.gitignore`, `.husky/pre-commit` between worktree and main tree.
2. Apply only the diffs not already in v2.
3. Run `pnpm install` (or `npm install` — match what v2 uses).
4. Run `pnpm run build` (or `npm run build`) — must succeed before any other step.

## Drop list

- Anything from `package-lock.json` — generated; let v2's `pnpm install` regenerate.
- Old `container.json` per-group files (CHANGELOG v2.0.48: "Container config moved to DB"). v2 backfills them automatically on startup.
