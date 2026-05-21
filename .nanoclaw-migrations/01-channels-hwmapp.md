# 01 — Channels: hwmapp + imessage

## hwmapp adapter (the big one)

### Intent
Relay between NanoClaw and hwm_app (Adam's Rails app at `app.hardworkmontage.com`). Outbound WebSocket to `wss://app.hardworkmontage.com/cable`, subscribes to hwm_app's Rails ActionCable channel `AgentRelayChannel`. Carries user messages from the web UI into Burnie's container, streams replies back, downloads attached images/PDFs so Claude can `Read` them, forwards the page the user was looking at as context.

### Files
- Source (v1): `src/channels/hwmapp.ts` at HEAD `570b17c`
- Target (v2): create as a new channel in the fork, alongside `cli.ts`. Add it to `src/channels/index.ts` barrel.

### Required behavior to preserve verbatim

1. **WebSocket URL**: `${HWM_RELAY_URL}?agent_token=${HWM_RELAY_TOKEN}` where `HWM_RELAY_URL=wss://app.hardworkmontage.com/cable`. Env-var fallback chain: `HWM_RELAY_URL` → `ACCOMPLICE_URL`, same for token. Deployed `.env` files on the Mac mini still use the old `ACCOMPLICE_*` names — do not drop the fallback.
2. **ActionCable subscription identifier**: `{"channel":"AgentRelayChannel"}` — JSON-stringified. This is hwm_app's Rails channel class name; changing it breaks the relay end-to-end. Send `{"command":"subscribe","identifier":...}` on `open`. Wait for `{"type":"confirm_subscription"}` to flip `connected = true`.
3. **JID prefix `'accomplice:'`** — preserved on purpose. hwm_app's `Conversation` model still mints JIDs with this prefix for DB back-compat. `ownsJid` (or equivalent v2 routing) recognizes anything starting with `accomplice:`.
4. **Inbound frame types** (from hwm_app):
   - `user_message` → carries `conversation_jid`, `message_id`, `content`, optional `files[]` (each `{filename, content_type, url}`), optional `page_context` (`{url, title}`).
   - `new_conversation` → `{conversation_jid, name}` — metadata announcement.
   - `conversation_started` → `{conversation_jid, title}` — confirmation of an agent-initiated `start_conversation` request.
5. **Outbound actions** (to hwm_app, all wrapped in ActionCable's `{"command":"message","identifier":...,"data":JSON.stringify({action,...})}`):
   - `message_complete`: `{message_id, conversation_jid, final_content}`
   - `start_conversation`: `{title}`
   - `typing`: `{conversation_jid, is_typing}`
6. **Reconnect on close** with 5s delay, including code 1006 (abnormal close).
7. **pendingResponses Map** (`conversation_jid → message_id`) so assistant replies route back to the right hwm_app message.
8. **pendingNewConversations queue** with `{title, content, sourceGroup}` entries. When `conversation_started` arrives, pop matching entry by title and post the queued opening message via `message_complete`.
9. **`onNewConversationCreated(sourceGroup, jid)` callback** — fired after `conversation_started` lands, so the host can bind the run's Claude Code session to the new JID.

### Required attachment behavior to preserve

When `user_message` carries `files[]`, download each one to disk inside the group's mounted workspace and reference the local path in the text content. Claude Code's `Read` tool can read images/PDFs from local paths but NOT from URLs.

- Per-file URL fetch with 20s timeout via `AbortController`.
- Overall materialization wrapped in 30s timeout (`Promise.race`) so a slow URL can't stall message dispatch indefinitely.
- Files in parallel (`Promise.all`), each independently bounded.
- 25 MB per-file size cap.
- Filename sanitization: replace `/\\\s` with `_`; trim.
- JID path-segment sanitization: replace any non-`[A-Za-z0-9_.-]` with `_` (so `accomplice:abc` becomes `accomplice_abc` on disk).
- On failure or oversize: fall back to including the raw URL in the text line so the agent at least knows something was attached.
- Local path format on disk: `<groupFolder>/attachments/<sanitized-jid>/<sanitized-filename>`. Container path: `/workspace/group/attachments/<sanitized-jid>/<sanitized-filename>` (the v1 group folder is mounted at `/workspace/group`; verify the v2 mount path during port — may be `/workspace/agent-group/` or similar).
- Prompt line format: `[Attached file at <containerPath> — read it with the Read tool. Original filename: <name> (<contentType>)]`. The explicit Read-tool reference is important — without it Burnie guessed from the filename.

### Required page-context behavior to preserve

When `user_message` carries `page_context`, prepend a hint line to the content:

```
[User context: viewing "<title>" at <url>]
<original user text>
```

Resolve `<url>` to absolute by prepending `https://app.hardworkmontage.com` if it's a relative path.

### v1 → v2 mapping

| v1 (`Channel`) | v2 (`ChannelAdapter`) |
| --- | --- |
| `constructor(opts: ChannelOpts)` storing callbacks | `setup(config: ChannelSetup)` |
| `connect()` | `setup()` — same body, just gated on config |
| `disconnect()` | `teardown()` |
| `sendMessage(jid, text)` | `deliver(platformId, threadId, OutboundMessage)` — wrap text in `{kind:'chat', content:{text}}` |
| `onMessage(jid, newMsg)` callback | `config.onInbound(platformId, null, InboundMessage)` |
| `onChatMetadata(jid, ts, name, channel, isGroup)` | `config.onMetadata(platformId, name, isGroup)` |
| `setTyping(jid, isTyping)` | `setTyping?(platformId, threadId)` |
| `ownsJid(jid)` | gone — router routes by `channelType` |
| `startConversation(title, content, sourceGroup)` | **non-standard extension** — add as optional method on a `HwmAppAdapter` type that the IPC handler casts to. See pattern below. |
| JID `accomplice:<uuid>` | `channelType='hwmapp'`, `platformId='accomplice:<uuid>'` (keep full string with prefix), `threadId=null` |
| `supportsThreads` (implicit false) | declare `supportsThreads: false` |

### Reference implementation skeleton (port template)

The current v1 code lives at `git show 570b17c:src/channels/hwmapp.ts`. The v2 reference adapter is `git show upstream/main:src/channels/cli.ts`. Structure your port like:

```ts
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
// ...attachment helpers below

const envVars = readEnvFile(['HWM_RELAY_URL', 'HWM_RELAY_TOKEN', 'ACCOMPLICE_URL', 'ACCOMPLICE_TOKEN']);
const RELAY_URL = process.env.HWM_RELAY_URL || envVars.HWM_RELAY_URL || process.env.ACCOMPLICE_URL || envVars.ACCOMPLICE_URL;
const RELAY_TOKEN = process.env.HWM_RELAY_TOKEN || envVars.HWM_RELAY_TOKEN || process.env.ACCOMPLICE_TOKEN || envVars.ACCOMPLICE_TOKEN;

function createAdapter(): ChannelAdapter | null {
  if (!RELAY_URL || !RELAY_TOKEN) {
    log.info('hwmapp: missing creds; skipping');
    return null;
  }

  let ws: WebSocket | null = null;
  let connected = false;
  let config: ChannelSetup | null = null;
  const pendingResponses = new Map<string, number>();
  const pendingNewConversations: Array<{ title: string; content: string; sourceGroup: string }> = [];

  const adapter: ChannelAdapter = {
    name: 'hwmapp',
    channelType: 'hwmapp',
    supportsThreads: false,

    async setup(c: ChannelSetup) {
      config = c;
      doConnect();
    },
    async teardown() { /* close ws, clear timers */ },
    isConnected() { return connected; },

    async deliver(platformId, _threadId, message: OutboundMessage) {
      // 1. Extract text from message.content (which is `unknown` — see cli.ts:extractText for the pattern)
      // 2. Look up pending message_id by platformId in pendingResponses
      // 3. Send {"command":"message", identifier, data: {action:'message_complete', message_id, conversation_jid: platformId, final_content: text}}
      // 4. Clear from pendingResponses
      return undefined;
    },

    async setTyping(platformId) {
      // sendAction('typing', { conversation_jid: platformId, is_typing: true })
    },
  };

  // Non-standard extension (host casts to HwmAppAdapter to access it)
  (adapter as HwmAppAdapter).startConversation = async (title, content, sourceGroup) => {
    pendingNewConversations.push({ title, content, sourceGroup });
    sendAction('start_conversation', { title });
  };

  return adapter;
}

export interface HwmAppAdapter extends ChannelAdapter {
  startConversation(title: string, content: string, sourceGroup: string): Promise<void>;
}

registerChannelAdapter('hwmapp', { factory: createAdapter });
```

Frame handler maps to:

- `user_message` → assemble text (page_context + content + materialized attachments), then `await config.onInbound(jid, null, { id: ..., kind: 'chat', content: { text, sender:'user', senderId:'hwmapp:user' }, timestamp: ... })`. Store `message_id` in `pendingResponses[jid]` BEFORE calling onInbound, so deliver() finds it.
- `new_conversation` → `config.onMetadata(jid, name, false)`
- `conversation_started` → pop pending opener, send `message_complete` with the queued content, fire `onNewConversationCreated(sourceGroup, jid)` callback (which we wire through ChannelSetup — see below).

### `startConversation` extension wiring

v2's `ChannelSetup` doesn't have `onNewConversationCreated` either. Two ways to plumb it:

**Recommended:** extend `ChannelSetup` in `src/channels/adapter.ts` with an optional callback:
```ts
export interface ChannelSetup {
  // ...existing
  onNewConversationCreated?(channelType: string, sourceGroup: string, platformId: string): void;
}
```
Then hwmapp adapter just calls `config.onNewConversationCreated?.('hwmapp', sourceGroup, jid)`.

Less invasive alternative: keep the callback as a property on the `HwmAppAdapter` interface and let the host set it directly after construction. The recommended approach is cleaner because the IPC `new_conversation` handler (see `02-core-source.md` § ipc.ts) needs to discover an adapter that supports startConversation — having both methods on the same interface makes this lookup easy.

### Tests / validation

There were no unit tests for hwmapp.ts in v1. Add a minimal test that:
1. Mocks `ws.WebSocket`.
2. Asserts subscription identifier is `{"channel":"AgentRelayChannel"}`.
3. Asserts a `user_message` frame triggers `config.onInbound` with platformId equal to the JID.
4. Asserts `deliver` writes a `message_complete` frame with the right `conversation_jid` and `final_content`.

---

## imessage adapter (smaller, second)

### Intent
Polls the macOS Messages SQLite database (`~/Library/Messages/chat.db`) for new messages addressed to Burnie's iMessage contact, forwards them through the relay. Read-only on the iMessage side; writes via an outbox processed by `scripts/imessage_dispatch.rb`.

### Files
- v1: `src/channels/imessage.ts` at HEAD `570b17c`
- v2 target: same path; port to `ChannelAdapter`

### Behavior to preserve

- Poll interval, last-seen timestamp persisted to disk (so daemon restarts don't replay old messages).
- AppleScript dispatch via the `imessage_outbox/` directory the host watches.
- Maps each iMessage thread to a JID like `imessage:<contact_id>` or similar (read current code for exact format).
- Auto-rebind logic when iMessage assigns a new thread row id to an ongoing conversation (current behavior in `src/index.ts:registerGroup`).

### v1 → v2 mapping

Same mappings as hwmapp. `channelType='imessage'`, `supportsThreads=false`. No attachment downloading required (we don't relay iMessage images yet).

`upstream/channels` branch has an `add-imessage` skill — read `upstream/main:.claude/skills/add-imessage/SKILL.md` first; v2 may have an official iMessage channel we can use as the reference implementation. If yes, prefer the upstream version + Adam's adjustments; if no, port ours.

### Validation

Send an iMessage to Burnie's number from Adam's phone after the port. Check that:
1. Message arrives in nanoclaw logs.
2. Reply is dispatched via outbox.
3. Reply lands on Adam's phone.

---

## Channel registration

In `src/channels/index.ts` (the barrel), add:

```ts
import './hwmapp.js';
import './imessage.js';
```

Both adapters self-register via `registerChannelAdapter()` calls at module load time, matching v2's pattern.

If v2's channels live on a separate `upstream/channels` branch and the trunk only ships `cli`, we add our two channels to the trunk for this fork (they're not redistributable to other users). The `migrate-nanoclaw` skill's Phase 2.4 says "Copy any custom skills mentioned in the guide from the main tree into the worktree" — same principle applies to custom channels.
