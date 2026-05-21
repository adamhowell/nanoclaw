# 02 — Core source customizations (host)

These customizations live in `src/*.ts` on the host. v2 likely restructured `src/index.ts` heavily and split DB across `src/db/`; before replaying, read v2's `src/index.ts` + `src/router.ts` + `src/session-manager.ts` to understand where each v1 concept now lives.

## Composite session keys (`${groupFolder}:${chatJid}`)

**Where v1 has it:** `src/index.ts` — session map is keyed on `${group.folder}:${chatJid}` instead of just group folder. Original commit: `4b2406c` "Key Claude Code sessions per-conversation, not per-group".

**Intent:** Different conversations from the same user / group keep separate Claude Code session state. Without it, switching topics mid-day reuses an unrelated stale session and the agent comes back confused.

**v2 status:** v2 has its own session model (`docs/db-session.md` describes the two-DB split inbound.db/outbound.db). Read it first. If v2 keys sessions per-conversation by default (likely), this customization is OBSOLETE — skip it. If v2 still keys per-group, we need to port the composite key.

**How to apply (if needed):** Find where v2 resolves the session key (likely in `session-manager.ts`). Change the key derivation to include both group folder and the inbound message's `platformId`. Persist via the same v2 mechanism as group-keyed sessions.

## Session-binding for new conversations (`recentNewConvsByGroup`)

**Where v1 has it:** `src/index.ts` — `Map<string, string[]>` buffers `conversation_jid` strings keyed by the requesting group folder. Populated by `onNewConversationCreated` callback in `setupChannelOpts`. Drained by `consumeNewConversations(groupFolder)` for the scheduler and by interactive turns. Original commits: `309e4c1` (Add new_conversation MCP tool), `a52ab43`/`f7d7565` (Bind run session to agent-created conversations).

**Intent:** When an agent calls the `new_conversation` MCP tool mid-run, hwm_app creates a new Conversation row and replies with the JID. The host buffers it. At the end of the run, the agent's final Claude Code session_id is bound to that new JID's session entry — so when the user later opens that conversation and sends a follow-up, it picks up where the agent left off instead of cold-starting.

**v2 status:** v2's session model may natively support this via `messaging_group_agents` wiring and the central DB. Read `docs/architecture.md` and `docs/db-central.md` first. Likely v2 has a more elegant solution; if so, drop our pattern and use v2's. If not, port it.

**How to apply (if needed):**
1. Add a `Map<sourceGroup, jid[]>` instance in the host runner (probably in `session-manager.ts` or the equivalent).
2. Wire the channel's `config.onNewConversationCreated?.(channelType, sourceGroup, platformId)` callback (see `01-channels-hwmapp.md`) to push into the map.
3. After each interactive turn AND each scheduled task run, drain the map for the run's source group and bind the run's final session_id to each drained jid.

## Auto-rebind on JID change

**Where v1 has it:** `src/index.ts` (`registerGroup` and message dispatcher — lines ~727–752 in current code). Original commit: `231ff80` "Auto-rebind accomplice registration to new conversation jids".

**Intent:** iMessage occasionally reassigns the SQLite ROWID for an ongoing thread (e.g. when a participant is added). When a message arrives on an unregistered JID that matches a prefix of a registered one, swap the registration in-place so the agent's group folder keeps pointing at the right chat.

**v2 status:** Likely OBSOLETE — v2 keys by `(channelType, platformId)` tuple; iMessage's platformId in v2 is probably the contact handle, not the ROWID, so it doesn't change. Verify by reading `add-imessage` skill if v2 has one. If v2's iMessage uses ROWID, port this; otherwise drop.

## `new_conversation` IPC handler

**Where v1 has it:** `src/ipc.ts` — `processTaskIpc()` switch has a `'new_conversation'` case that validates `isMain`, reads `title` and `content`, and calls `deps.startConversation(title, content, sourceGroup)`. Companion type addition to `IpcDeps` interface.

**Intent:** Agents in the main group can spawn brand-new conversations on the platform (e.g. morning briefing creates a "Morning briefing — May 21" conversation).

**v2 status:** v2 has its own IPC mechanism (likely via the inbound.db queue + tool-result writes). Read v2's container/agent-runner and the host-side polling code. The MCP tool invocation pattern may have changed.

**How to apply:**
1. In the v2 IPC handler (wherever the equivalent `processTaskIpc` lives), add a `new_conversation` case.
2. Validate the source agent is allowed to call it (v1 used `isMain`; v2's equivalent is "owner agent group" or similar — see CHANGELOG v2.0.0 entity model).
3. Look up the hwmapp adapter via `getChannelAdapter('hwmapp')` and call its non-standard `startConversation(title, content, sourceGroup)` method.

## Status event streaming

**Where v1 has it:** `container/agent-runner/src/index.ts` — `summarizeToolUse(name, input)` function + tool-use extraction loop in `runQuery()`. Status events flow up via `ContainerOutput.statusEvent` and are forwarded to channels via `sendStatusUpdate?(jid, text)`.

**Intent:** Show "Reading email.ts" / "Grepping for q3 revenue" / "Searching the web" as transient status under the typing bubble while Claude is working. Without this, the user just sees a typing indicator for 30s with no feedback.

**v2 status:** v2 has its own typing/status mechanism in `src/modules/typing.ts` (per CHANGELOG v2.0.0: "Modules barrel — default modules (typing, mount-security)"). Read it first. v2 may have a cleaner pattern.

**How to apply:** See `03-container-agent-runner.md` for the summarization function. Plumb to channels via whatever v2 provides for transient status. If v2 has nothing equivalent, add a `sendStatusUpdate?(platformId, text)` optional method on ChannelAdapter (mirroring the pattern in v1 types.ts).

## env var additions in `src/config.ts`

Three trivial additions:
- `IMESSAGE_CONTACT` — iMessage handle Burnie should respond to.
- `CREDENTIAL_PROXY_PORT` — int, default 3001. **DROP** if v2 OneCLI doesn't need it.
- `HOST_BROWSER_PORT` — int, default 8765. Used by `host-browser` skill to reach the Mac mini's host browser service.

## DB additions

`src/db.ts` has one custom function: `rebindRegisteredGroupJid(oldJid, newJid)` — simple UPDATE on `registered_groups`. Tied to the auto-rebind feature above. Drop if auto-rebind is dropped.

## `types.ts` additions

Two optional methods added to v1 `Channel` interface:
- `sendStatusUpdate?(jid, text)` — see status-event section above.
- `startConversation?(title, content, sourceGroup)` — see `01-channels-hwmapp.md`.

In v2, both should land on `ChannelAdapter` (or `ChannelSetup` for callbacks the host provides). The recommended placement is:
- `onNewConversationCreated?` and `sendStatusUpdate?` callbacks → `ChannelSetup` (host-provided).
- `startConversation?` method → optional method on `ChannelAdapter`.

## Drop list

These v1 customizations are intentionally dropped:
- `src/credential-proxy.ts` + `.test.ts` (Adam's call — trust v2 OneCLI Vault).
- v1's `Channel` interface, `ChannelOpts`, `RegisteredGroup` from `types.ts` (replaced by v2 equivalents).
- v1's per-group folder DB pattern in `db.ts` — superseded by v2 central DB + session DBs.

## Reapply order

Within step 4 of the migration plan, work in this order so each replay validates cleanly:

1. `types.ts` additions (interface extensions) — needed for the rest to typecheck.
2. `config.ts` env-var additions.
3. `db.ts` rebind helper (or skip).
4. `ipc.ts` new_conversation case.
5. Status-event plumbing in `container/agent-runner/` (see `03-container-agent-runner.md`).
6. `index.ts` / `session-manager.ts` session-binding + auto-rebind.

Validate `npm run build` clean after each step; isolates which step breaks if any do.
