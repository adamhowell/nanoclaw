# 04 — Container skills (copy into `container/skills/`)

These are SKILL.md instructions mounted into Burnie's container at `/workspace/global/skills/<name>/SKILL.md` so Claude Code inside the container can discover them. They're documentation, not code — mostly safe to copy verbatim. The exception is anything that hard-codes v1-specific paths or MCP tool names.

In the worktree, copy each listed skill from the main tree's `container/skills/<name>/` into the worktree's `container/skills/<name>/`. Do not modify unless flagged below.

## Copy verbatim — 6 skills

| Skill | Purpose | Copy as-is? |
| --- | --- | --- |
| `accomplice` | Drives the `/accomplice` focus-contract / nudge product in hwm_app from chat | YES — pure REST API docs |
| `dayjob` | Microsoft 365 work email/calendar/Teams via MS Graph | YES — pure Graph API docs |
| `host-browser` | Routes authed/bot-protected URLs (Etsy, Stripe, Shopify, Mercury) through the Mac mini's persistent headed Chrome | YES — references `HOST_BROWSER_URL` env which is preserved |
| `hwm-api` | Generic hwm_app REST wrapper (emails, todos, calendar, orders, notes, contacts, weather, briefings, calls) | YES — pure REST API docs |
| `theachievemint-fulfill` | TAM order-fulfillment flow (ask-only trigger; no autonomous runs) | YES — references `TAM_API_*` env vars and `/workspace/extra/handoff_outbox/` path (verify the bind-mount path in v2 — see Adjustments below) |
| `voice-delegation` | When phone-Burnie hits tool/latency limits, delegated tasks land here and reply via iMessage | YES — references `/Users/burnie/nanoclaw/data/imessage_outbox/` (path stays the same) |

## Verify / lightly update — 2 skills

| Skill | Why | What to update |
| --- | --- | --- |
| `capabilities` | Hard-references v1 MCP tool naming (`mcp__nanoclaw__*`) and directory paths (`/home/node/.claude/skills/`) | Open v2 main's `container/skills/capabilities/SKILL.md` (if it exists upstream); diff against ours. v2's MCP tool prefix may have changed. Update path references to match v2's container layout. |
| `status` | Same issue — references v1 tool names and paths | Same approach. May share most content with `capabilities`. |

## DROP

- `agent-task` — obsolete since the `/social` per-channel persona feed was retired on 2026-05-06 (see hwm_app `CLAUDE.md`). Do not copy the folder.

## Skill files to copy (everything inside each kept folder)

Some skills have more than just `SKILL.md`. From the inventory:

- `accomplice/` — `SKILL.md` only.
- `dayjob/` — `SKILL.md` only.
- `host-browser/` — `SKILL.md` only.
- `hwm-api/` — `SKILL.md` only.
- `theachievemint-fulfill/` — check the folder for helper scripts / example files; copy whatever is there.
- `voice-delegation/` — same.
- `capabilities/` — `SKILL.md` only.
- `status/` — `SKILL.md` only.

When in doubt, copy the whole directory.

## Adjustments to v2 layout

If v2 changed the container global-skills mount path (currently `/workspace/global/skills/`), search-and-replace in each SKILL.md. Likely safe but verify by reading v2's `docs/agent-runner-details.md` first.

If v2 uses a different mechanism than mount-based skill discovery (e.g., DB-managed skills via `ncl groups config`), follow that flow instead of dropping files into `container/skills/` directly. The CHANGELOG v2.0.48 mentions "Container config moved to DB" — skills are part of `container_configs`. Read `ncl help` after the v2 base is up and use whatever the canonical install path is.

## Validation

After all 8 skills are in place and the container is rebuilt:

1. From a Burnie chat, ask: "List your skills". The reply should include the 8 active ones.
2. Trigger one skill end-to-end (e.g., "what's on my calendar today?" → should call `hwm-api` skill → return today's events).
3. Specifically test `host-browser` (latest Etsy conversations) and `accomplice` (current focus contract status) since those have the tightest host-side coupling.
