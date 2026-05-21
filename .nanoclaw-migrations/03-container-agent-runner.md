# 03 — Container agent-runner customizations

This is what runs *inside* Burnie's container — the bridge between nanoclaw's host runner and the Claude Code SDK. v2 moved the agent-runner runtime from **Node to Bun** (per CHANGELOG v2.0.0). Read `docs/agent-runner-details.md` on upstream/main first to understand the new structure; the file layout has likely changed.

## Tool-use status event summarization

**Where v1 has it:** `container/agent-runner/src/index.ts`. Adds a `summarizeToolUse(name, input)` function (~80 lines) that converts a Claude SDK tool_use event into a human-readable string like:

- `Read("/workspace/group/foo.ts")` → `"Reading foo.ts"`
- `Bash("npm test")` → `"Running npm test"`
- `WebSearch("q3 revenue")` → `"Searching the web for q3 revenue"`
- `Grep("export function", path="src/")` → `"Grepping for export function in src/"`

Then hooks into the agent's message stream in `runQuery()` to extract `tool_use` blocks and emit them via `writeOutput({ statusEvent: { tool, text } })`.

**Intent:** Show what Claude is doing in the chat UI as transient status under the typing bubble. Original commit: `efb2e5e` "Surface tool-use events as transient status updates".

**v2 status:** v2 has `src/modules/typing.ts` (mentioned in CHANGELOG v2.0.0). Read it. It may already cover this case. If not, port `summarizeToolUse` into the v2 agent-runner — but adapt for Bun + whichever SDK version v2 ships.

**How to port:**
1. Find v2's equivalent of the message-stream-iteration loop (probably in `container/agent-runner/src/index.ts` on v2 main, or wherever the SDK `messageStream` is consumed).
2. Add the tool-use block extraction at the same point.
3. Copy the `summarizeToolUse` function — it's pure-functional (just match-case on tool name), no SDK coupling.
4. Plumb the output: in v1 it lands as `ContainerOutput.statusEvent`. v2's host reads container output from `outbound.db` — figure out the equivalent column or record shape.
5. On the host side, forward to the channel via the `sendStatusUpdate?(platformId, text)` method we add to `ChannelAdapter` (see `02-core-source.md`).

**Truncate** at 200 chars (`Bump status-text truncation 60→200, 80→200` from commit `b3d61ad`) — long file paths / commands otherwise blow out the UI.

## `new_conversation` MCP tool

**Where v1 has it:** `container/agent-runner/src/ipc-mcp-stdio.ts`. Registers an MCP tool named `new_conversation` with zod schema `{ title: string, content: string }`. Tool body checks `isMain` (only the main group is allowed to spawn conversations), writes an IPC file with `type: 'new_conversation'` payload, returns a confirmation string to the agent.

**Intent:** Lets agents create new conversations on the platform from inside the container. Used by:
- The morning briefing job ("Generate today's briefing in a new conversation titled 'Morning briefing — <date>'")
- The accomplice/focus_contract skill (when a contract ends, the grade can post into a fresh thread)

**v2 status:** v2's MCP wiring has likely changed. Read v2's `container/agent-runner/src/` first. Per CHANGELOG, v2 has `add_mcp_server` flow and the `ncl` admin CLI for managing MCP servers — the IPC-based "tool calls write a file, host polls and acts" pattern may have been replaced.

**How to port:**
1. Find where v2 registers built-in MCP tools (probably an entry like `ipc-mcp-stdio.ts` or a renamed equivalent).
2. Add a `new_conversation` tool with the same zod schema.
3. The tool body should publish an IPC event in whatever shape v2 expects (outbound.db row? stdout event? `ncl new_conversation` invocation?). Read v2's existing built-in MCP tools to mirror the pattern.
4. Authorization check: only allow when the calling agent is in the "owner" agent group (v2 entity model; CHANGELOG v2.0.0). v1's `isMain` check is the closest analog.

## Bun migration concerns

Two things to verify when porting these to the v2 agent-runner:

1. **`@anthropic-ai/sdk` import** — v1 used the Node SDK. Bun supports it but check whether v2 pins a different version or uses a different package (Anthropic SDK is `@anthropic-ai/claude-code` SDK rather than the raw Messages API SDK in some agent-runner setups).
2. **`zod`** — Bun-native; should just work, but verify the version is pinned via container's package.json.
3. **MCP SDK** — `@modelcontextprotocol/sdk` — version compatibility check.

## Validation

After porting:

1. Container builds (`bash container/build.sh`).
2. Spawn a manual agent run with a prompt that forces a tool call (`"read /etc/hostname"`). Watch nanoclaw logs for a `statusEvent` (or v2 equivalent) being emitted.
3. From inside an interactive Burnie chat, ask "make a new conversation called 'test'". Verify a new conversation appears in hwm_app's UI.
