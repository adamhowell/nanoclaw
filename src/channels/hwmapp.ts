/**
 * hwmapp channel — relay to hwm_app's AgentRelayChannel.
 *
 * Connects outbound via ActionCable WebSocket to
 * `wss://app.hardworkmontage.com/cable`. Receives user messages from
 * Adam's web UI, dispatches them to the agent, and streams replies
 * back as `message_complete` frames. Forwards page-context hints
 * (`[User context: viewing "..." at <url>]`) when hwm_app sends them.
 *
 * Attachments: each inbound `user_message` may carry `files[]` of
 * `{filename, content_type, url}`. We fetch each, base64-encode the
 * bytes, and surface them on the inbound message's `attachments`
 * array — v2's session manager (`extractAttachmentFiles`) writes them
 * to the session inbox so Claude Code's `Read` tool can see image /
 * PDF bytes natively. Per-file 20s fetch timeout; overall 30s ceiling;
 * 25 MB cap; URL fallback in text on failure.
 *
 * Historical naming: this channel used to talk to a standalone
 * "accomplice" service. The deploy-platform was merged into hwm_app
 * in April 2026. Env-var names are `HWM_RELAY_*`; `ACCOMPLICE_*` are
 * read as fallback so existing .env files on deployed Mac minis keep
 * working. The JID prefix `accomplice:` is preserved on purpose —
 * hwm_app's Conversation model still mints JIDs with that prefix for
 * DB back-compat.
 */

import WebSocket from 'ws';

import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'hwmapp';
const ACTION_CABLE_IDENTIFIER = JSON.stringify({ channel: 'AgentRelayChannel' });
const RECONNECT_DELAY_MS = 5_000;
// ActionCable pings every 3s. If we hear nothing for this long the socket is
// half-open (server gone, FIN never arrived) and ws.on('close') will never
// fire — force-terminate so the close→reconnect path runs.
const LIVENESS_TIMEOUT_MS = 15_000;
const LIVENESS_CHECK_MS = 5_000;
const ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;
const ATTACHMENT_TOTAL_TIMEOUT_MS = 30_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

const envVars = readEnvFile(['HWM_RELAY_URL', 'HWM_RELAY_TOKEN', 'ACCOMPLICE_URL', 'ACCOMPLICE_TOKEN']);
const RELAY_URL =
  process.env.HWM_RELAY_URL || envVars.HWM_RELAY_URL || process.env.ACCOMPLICE_URL || envVars.ACCOMPLICE_URL;
const RELAY_TOKEN =
  process.env.HWM_RELAY_TOKEN || envVars.HWM_RELAY_TOKEN || process.env.ACCOMPLICE_TOKEN || envVars.ACCOMPLICE_TOKEN;

type IncomingFile = {
  filename: string;
  content_type: string;
  url: string;
};

const THREAD_CONTEXT_FETCH_TIMEOUT_MS = 5_000;
const THREAD_CONTEXT_MESSAGE_LIMIT = 20;
const THREAD_CONTEXT_CHAR_BUDGET = 8_000;

/** wss://host/cable → https://host (the relay URL doubles as the API origin). */
function apiOrigin(): string | null {
  if (!RELAY_URL) return null;
  try {
    const u = new URL(RELAY_URL);
    const proto = u.protocol === 'ws:' ? 'http:' : 'https:';
    return `${proto}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Thread-context reinjection.
 *
 * When a user replies inside an hwm_app conversation that has no
 * messaging_group yet — typically a thread opened by a scheduled-task
 * session that has since ended — the router will auto-create a fresh
 * messaging group and session with NO memory of the thread. The agent
 * then can't even see the summary it posted two minutes earlier.
 *
 * Fix: detect the no-messaging-group case BEFORE routing and prepend
 * the conversation transcript (fetched from hwm_app's agent_api using
 * the relay token) so the first wake of the new session starts with
 * the full thread in front of it. Existing threads with live sessions
 * skip this entirely — their session transcript already has the
 * history.
 */
async function fetchThreadContext(jid: string): Promise<string | null> {
  const origin = apiOrigin();
  if (!origin || !RELAY_TOKEN) return null;
  const conversationId = jid.includes(':') ? jid.slice(jid.indexOf(':') + 1) : jid;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THREAD_CONTEXT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${origin}/agent_api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${THREAD_CONTEXT_MESSAGE_LIMIT}`,
      { headers: { Authorization: `Bearer ${RELAY_TOKEN}` }, signal: controller.signal },
    );
    if (!res.ok) {
      log.warn('hwmapp: thread-context fetch failed', { jid, status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      conversation?: { title?: string };
      messages?: Array<{ role: string; content: string; created_at: string }>;
    };
    const msgs = data.messages || [];
    if (msgs.length === 0) return null;

    let budget = THREAD_CONTEXT_CHAR_BUDGET;
    const lines: string[] = [];
    // Newest-first while budgeting so the most recent turns survive, then
    // restore chronological order for the prompt.
    for (const m of [...msgs].reverse()) {
      const line = `${m.role === 'user' ? 'User' : 'You (agent)'} [${m.created_at}]: ${m.content}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }
    lines.reverse();

    const title = data.conversation?.title ? ` titled "${data.conversation.title}"` : '';
    return (
      `[Thread context — this message is a reply in an existing hwm_app conversation${title}. ` +
      `Your session has no memory of it (the session that opened it has ended), so the earlier ` +
      `messages are reproduced below. Messages marked "You (agent)" were posted by you — treat ` +
      `their contents as your own prior statements and answer the user's reply in that context.]\n` +
      lines.join('\n---\n')
    );
  } catch (err) {
    log.warn('hwmapp: thread-context fetch errored', { jid, err });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type PendingNewConversation = {
  title: string;
  content: string;
  sourceGroup: string;
};

/**
 * The hwmapp adapter exposes `startConversation` as a non-standard
 * extension method beyond the base `ChannelAdapter` contract. The IPC
 * handler for the `new_conversation` MCP tool locates the adapter by
 * channelType and casts to this interface to call it.
 */
export interface HwmAppAdapter extends ChannelAdapter {
  startConversation(title: string, content: string, sourceGroup: string): Promise<void>;
}

function createAdapter(): HwmAppAdapter | null {
  if (!RELAY_URL || !RELAY_TOKEN) {
    log.info('hwmapp: skipping — HWM_RELAY_URL/TOKEN (or legacy ACCOMPLICE_URL/TOKEN) not set');
    return null;
  }

  let ws: WebSocket | null = null;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let lastActivityAt = Date.now();
  let config: ChannelSetup | null = null;

  // Routes assistant replies back to the originating user message.
  const pendingResponses = new Map<string, number>();
  // Queued openers waiting for a conversation_started confirmation.
  const pendingNewConversations: PendingNewConversation[] = [];

  function send(frame: object): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(frame));
  }

  function sendAction(action: string, data: Record<string, unknown>): void {
    send({
      command: 'message',
      identifier: ACTION_CABLE_IDENTIFIER,
      data: JSON.stringify({ action, ...data }),
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect();
    }, RECONNECT_DELAY_MS);
  }

  function stopLiveness(): void {
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
  }

  function startLiveness(): void {
    stopLiveness();
    lastActivityAt = Date.now();
    livenessTimer = setInterval(() => {
      const silentMs = Date.now() - lastActivityAt;
      if (silentMs > LIVENESS_TIMEOUT_MS) {
        log.warn('hwmapp: no server activity, terminating stale socket', { silentMs });
        stopLiveness();
        ws?.terminate();
      }
    }, LIVENESS_CHECK_MS);
  }

  function doConnect(): void {
    const url = `${RELAY_URL}?agent_token=${RELAY_TOKEN}`;
    log.info('hwmapp: connecting', { url: RELAY_URL });
    ws = new WebSocket(url);

    ws.on('open', () => {
      log.info('hwmapp: WebSocket connected');
      startLiveness();
      send({ command: 'subscribe', identifier: ACTION_CABLE_IDENTIFIER });
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      lastActivityAt = Date.now();
      try {
        const frame = JSON.parse(raw.toString());
        void handleFrame(frame);
      } catch (err) {
        log.error('hwmapp: failed to parse frame', { err });
      }
    });

    ws.on('close', (code: number) => {
      connected = false;
      stopLiveness();
      log.warn('hwmapp: WebSocket closed, reconnecting', {
        code,
        delayMs: RECONNECT_DELAY_MS,
      });
      scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('hwmapp: WebSocket error', { err: err.message });
    });
  }

  async function handleFrame(frame: {
    type?: string;
    identifier?: string;
    message?: Record<string, unknown>;
  }): Promise<void> {
    // ActionCable protocol frames
    if (frame.type === 'ping' || frame.type === 'welcome') return;

    if (frame.type === 'confirm_subscription') {
      connected = true;
      log.info('hwmapp: subscribed to relay channel');
      return;
    }

    if (frame.type === 'reject_subscription') {
      log.error('hwmapp: subscription rejected — check HWM_RELAY_TOKEN');
      return;
    }

    if (frame.message) {
      await handleMessage(frame.message);
    }
  }

  async function handleMessage(msg: Record<string, unknown>): Promise<void> {
    if (!config) {
      log.warn('hwmapp: received frame before setup completed', { type: msg.type });
      return;
    }

    switch (msg.type) {
      case 'user_message': {
        const jid = msg.conversation_jid as string;
        const messageId = msg.message_id as number;
        let text = (msg.content as string) || '';

        // Page context — hwm_app sends the URL + title of the page the
        // user was on. Resolves prompts like "summarize the email I'm
        // looking at" without pasting a link.
        const pageContext = msg.page_context as { url?: string; title?: string } | undefined;
        if (pageContext && (pageContext.url || pageContext.title)) {
          const url = (pageContext.url || '').toString().trim();
          const title = (pageContext.title || '').toString().trim();
          const absUrl = url.startsWith('http') ? url : `https://app.hardworkmontage.com${url}`;
          const hint = title ? `[User context: viewing "${title}" at ${absUrl}]` : `[User context: viewing ${absUrl}]`;
          text = text ? `${hint}\n${text}` : hint;
        }

        // Attachments: download bytes for each file (parallel, with
        // timeouts), pass to v2's session manager via the structured
        // attachments[] field. Falls back to a URL note in text on failure
        // so the agent at least knows something was attached.
        const files = msg.files as IncomingFile[] | undefined;
        const attachments: Array<{
          name: string;
          mimeType?: string;
          data: string;
        }> = [];
        const failedAttachments: IncomingFile[] = [];

        if (files && files.length > 0) {
          try {
            const results = await withTimeout(
              Promise.all(files.map(downloadAttachment)),
              ATTACHMENT_TOTAL_TIMEOUT_MS,
              'hwmapp.materializeAttachments',
            );
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const f = files[i];
              if (r) {
                attachments.push(r);
              } else {
                failedAttachments.push(f);
              }
            }
          } catch (err) {
            log.error('hwmapp: attachment materialization failed', { err, jid });
            failedAttachments.push(...files);
          }
        }

        if (failedAttachments.length > 0) {
          const lines = failedAttachments.map(
            (f) => `[Attached: ${f.filename} (${f.content_type}) — could not be downloaded; URL: ${f.url}]`,
          );
          text = text ? `${text}\n\n${lines.join('\n')}` : lines.join('\n');
        }

        // Thread-context reinjection: an unknown jid means the router is
        // about to auto-create a fresh messaging group + session that has
        // never seen this thread. Prepend the conversation transcript so
        // the follow-up doesn't arrive context-free (see fetchThreadContext).
        if (!getMessagingGroupByPlatform(CHANNEL_TYPE, jid)) {
          const threadContext = await fetchThreadContext(jid);
          if (threadContext) {
            text = text ? `${threadContext}\n\n${text}` : threadContext;
            log.info('hwmapp: injected thread context for new messaging group', { jid });
          }
        }

        // Track pending message ID BEFORE handing to the router so deliver()
        // can route the reply back to the right hwm_app message.
        pendingResponses.set(jid, messageId);

        const inbound: InboundMessage = {
          id: `hwmapp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          // Every hwmapp user_message is a direct address to the agent —
          // the chat surface is 1:1 between owner and agent, every
          // conversation jid is created by the authenticated owner, and
          // there is no background chatter to filter out. Setting
          // isMention is what unblocks the router's auto-create path for
          // new conversation jids — the router drops non-mention messages
          // on unknown messaging_groups to keep the DB clean on platforms
          // where the bot merely sits in a busy channel.
          isMention: true,
          content: {
            text,
            sender: 'user',
            senderId: `hwmapp:user`,
            attachments,
          },
        };

        try {
          await config.onInbound(jid, null, inbound);
        } catch (err) {
          log.error('hwmapp: onInbound threw', { err, jid });
        }
        break;
      }

      case 'new_conversation': {
        const jid = msg.conversation_jid as string;
        const name = (msg.name as string) || 'hwmapp';
        config.onMetadata(jid, name, false);
        break;
      }

      case 'conversation_started': {
        // Response to an agent-initiated start_conversation. Pop the matching
        // pending opener (by title; fall back to FIFO), post the opening
        // message, and notify the host so it can bind the session.
        const jid = msg.conversation_jid as string;
        const title = (msg.title as string) || 'hwmapp';
        if (!jid) {
          log.warn('hwmapp: conversation_started missing jid', { msg });
          break;
        }
        config.onMetadata(jid, title, false);

        const matchIdx = pendingNewConversations.findIndex((p) => p.title === title);
        const idx = matchIdx >= 0 ? matchIdx : 0;
        const pending = pendingNewConversations[idx];
        if (!pending) {
          log.warn('hwmapp: conversation_started with no pending opener', { jid, title });
          break;
        }
        pendingNewConversations.splice(idx, 1);

        sendAction('message_complete', {
          message_id: null,
          conversation_jid: jid,
          final_content: pending.content,
        });
        log.info('hwmapp: posted opening message into new conversation', { jid, title });
        // Notify the host via the optional onNewConversationCreated callback.
        // Cast — this is a custom extension on top of v2's ChannelSetup.
        const cb = (
          config as ChannelSetup & {
            onNewConversationCreated?: (channelType: string, sourceGroup: string, platformId: string) => void;
          }
        ).onNewConversationCreated;
        if (cb) cb(CHANNEL_TYPE, pending.sourceGroup, jid);
        break;
      }

      default:
        log.debug('hwmapp: unknown message type', { type: msg.type });
    }
  }

  const adapter: HwmAppAdapter = {
    name: 'hwmapp',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    // Per-conversation jids are created by the bearer-auth'd WebSocket
    // owner — they're implicitly authorized. Let the router clone the
    // channel's existing wiring onto new mgs instead of dropping them
    // into the channel-request approval gate (which has no UI surface
    // for hwm_app conversations anyway).
    inheritWiringOnAutoCreate: true,
    // Every hwmapp conversation jid is "the same user on a different
    // thread" — so a channel destination like `accomplice` ("the user")
    // must resolve to the SESSION'S mg at reply time, not the destination
    // row's static target. Otherwise replies always go to whichever jid
    // the destination was originally pointed at, regardless of which
    // conversation the inbound came from.
    channelDestinationsAreSessionScoped: true,

    async setup(c: ChannelSetup): Promise<void> {
      config = c;
      doConnect();
    },

    async teardown(): Promise<void> {
      stopLiveness();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
        ws = null;
      }
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      if (text === null) return undefined;

      const messageId = pendingResponses.get(platformId);
      sendAction('message_complete', {
        message_id: messageId ?? null,
        conversation_jid: platformId,
        final_content: text,
      });
      if (messageId !== undefined) {
        pendingResponses.delete(platformId);
      }
      return undefined;
    },

    async setTyping(platformId: string): Promise<void> {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      sendAction('typing', { conversation_jid: platformId, is_typing: true });
    },

    async startConversation(title: string, content: string, sourceGroup: string): Promise<void> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        log.warn('hwmapp: cannot start conversation — not connected', { title });
        return;
      }
      pendingNewConversations.push({ title, content, sourceGroup });
      sendAction('start_conversation', { title });
      log.info('hwmapp: requested new conversation', { title, sourceGroup });
    },
  };

  return adapter;
}

// --- Helpers ---

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

async function downloadAttachment(f: IncomingFile): Promise<{
  name: string;
  mimeType?: string;
  data: string;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    log.info('hwmapp: fetching attachment', { url: f.url, filename: f.filename });
    const resp = await fetch(f.url, { signal: controller.signal, redirect: 'follow' });
    if (!resp.ok) {
      log.warn('hwmapp: attachment fetch returned non-2xx', {
        url: f.url,
        status: resp.status,
        filename: f.filename,
      });
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      log.warn('hwmapp: attachment exceeds size cap, skipping', {
        filename: f.filename,
        bytes: buf.byteLength,
      });
      return null;
    }
    log.info('hwmapp: attachment materialized', {
      filename: f.filename,
      bytes: buf.byteLength,
    });
    return {
      name: f.filename,
      mimeType: f.content_type,
      data: buf.toString('base64'),
    };
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
    log.error(isTimeout ? 'hwmapp: attachment fetch timed out' : 'hwmapp: attachment download failed', {
      err: err instanceof Error ? err.message : String(err),
      url: f.url,
      filename: f.filename,
      isTimeout,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms timeout`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

registerChannelAdapter(CHANNEL_TYPE, { factory: createAdapter });
