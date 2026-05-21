/**
 * hwm_app relay channel for NanoClaw.
 *
 * Connects outbound to hwm_app's AgentRelayChannel over WebSocket
 * (ActionCable protocol). Receives user messages from the web UI,
 * delivers them to the agent, and streams responses back through
 * the relay.
 *
 * Historical naming: this channel used to talk to a standalone
 * "accomplice" service. The deploy-platform was merged into hwm_app
 * in April 2026. Env var names (HWM_RELAY_*) are the current path;
 * ACCOMPLICE_* are read as fallback so existing .env files on
 * deployed Mac minis keep working. The JID prefix `accomplice:` is
 * preserved on purpose — hwm_app's Conversation model still mints
 * JIDs with that prefix for back-compat with rows already in its DB.
 */

import fs from 'fs';
import path from 'path';

import WebSocket from 'ws';

import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'accomplice:';
const RECONNECT_DELAY = 5000;

const envVars = readEnvFile([
  'HWM_RELAY_URL',
  'HWM_RELAY_TOKEN',
  'ACCOMPLICE_URL',
  'ACCOMPLICE_TOKEN',
]);
const HWM_RELAY_URL =
  process.env.HWM_RELAY_URL ||
  envVars.HWM_RELAY_URL ||
  process.env.ACCOMPLICE_URL ||
  envVars.ACCOMPLICE_URL;
const HWM_RELAY_TOKEN =
  process.env.HWM_RELAY_TOKEN ||
  envVars.HWM_RELAY_TOKEN ||
  process.env.ACCOMPLICE_TOKEN ||
  envVars.ACCOMPLICE_TOKEN;

/** Maps conversation JID -> pending assistant message ID on the hwm_app side */
type PendingResponses = Map<string, number>;

/** Opening-message content waiting for a conversation_started confirmation.
 *  sourceGroup is the requesting group's folder, captured so the host can
 *  attribute the resulting conversation_jid back to the right run when
 *  conversation_started lands. */
type PendingNewConversation = {
  title: string;
  content: string;
  sourceGroup: string;
};

type IncomingFile = {
  filename: string;
  content_type: string;
  url: string;
};

class HwmChannel implements Channel {
  name = 'hwm';

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identifier: string;
  private pendingResponses: PendingResponses = new Map();
  private pendingNewConversations: PendingNewConversation[] = [];

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private onNewConversationCreated?: (sourceGroup: string, jid: string) => void;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.onNewConversationCreated = opts.onNewConversationCreated;
    this.identifier = JSON.stringify({ channel: 'AgentRelayChannel' });
  }

  async connect(): Promise<void> {
    this.doConnect();
  }

  private doConnect(): void {
    const url = `${HWM_RELAY_URL}?agent_token=${HWM_RELAY_TOKEN}`;
    logger.info({ url: HWM_RELAY_URL }, 'hwm: connecting');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('hwm: WebSocket connected');
      // Subscribe to the relay channel (ActionCable protocol)
      this.ws!.send(
        JSON.stringify({
          command: 'subscribe',
          identifier: this.identifier,
        }),
      );
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const frame = JSON.parse(raw.toString());
        this.handleFrame(frame);
      } catch (err) {
        logger.error({ err }, 'hwm: failed to parse frame');
      }
    });

    this.ws.on('close', (code: number) => {
      this.connected = false;
      logger.warn(
        { code },
        `hwm: WebSocket closed, reconnecting in ${RECONNECT_DELAY / 1000}s`,
      );
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'hwm: WebSocket error');
    });
  }

  private handleFrame(frame: {
    type?: string;
    identifier?: string;
    message?: Record<string, unknown>;
  }): void {
    // ActionCable protocol frames
    if (frame.type === 'ping') return;
    if (frame.type === 'welcome') return;

    if (frame.type === 'confirm_subscription') {
      this.connected = true;
      logger.info('hwm: subscribed to relay channel');
      return;
    }

    if (frame.type === 'reject_subscription') {
      logger.error('hwm: subscription rejected — check HWM_RELAY_TOKEN');
      return;
    }

    // Data message from hwm_app
    if (frame.message) {
      logger.info(
        { identifier: frame.identifier, expectedIdentifier: this.identifier },
        'hwm: received data frame',
      );
      // Fire and forget — handleMessage is async because it may fetch
      // attachments, but the WebSocket message handler is synchronous.
      this.handleMessage(frame.message).catch((err) => {
        logger.error({ err }, 'hwm: handleMessage failed');
      });
    }
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'user_message': {
        const jid = msg.conversation_jid as string;
        const messageId = msg.message_id as number;
        let content = msg.content as string;

        // Page context — hwm_app sends the path + title of the page the
        // user was on when they hit send, so prompts like "summarize the
        // email I'm looking at" can be resolved without pasting a URL.
        // Optional — older clients / scheduled-task runs don't include it.
        const pageContext = msg.page_context as
          | { url?: string; title?: string }
          | undefined;
        if (pageContext && (pageContext.url || pageContext.title)) {
          const url = (pageContext.url || '').toString().trim();
          const title = (pageContext.title || '').toString().trim();
          const absUrl = url.startsWith('http')
            ? url
            : `https://app.hardworkmontage.com${url}`;
          const hint = title
            ? `[User context: viewing "${title}" at ${absUrl}]`
            : `[User context: viewing ${absUrl}]`;
          content = content ? `${hint}\n${content}` : hint;
        }

        // Attachments: download each file into the group's working dir so
        // Claude Code's Read tool can actually see image/PDF bytes. The
        // CLI can't fetch URLs as image content — it only reads local
        // files. Falls back to the raw URL if the group isn't registered
        // yet or the download fails, so something useful still reaches
        // the agent. The whole step is wrapped in a hard timeout — if
        // anything in here hangs, the user message MUST still reach
        // Claude with at least the URL line.
        const files = msg.files as IncomingFile[] | undefined;
        if (files && files.length > 0) {
          let fileLines: string[];
          try {
            fileLines = await withTimeout(
              this.materializeAttachments(jid, files),
              ATTACHMENT_TOTAL_TIMEOUT_MS,
              'materializeAttachments',
            );
          } catch (err) {
            logger.error(
              { err, jid, fileCount: files.length },
              'hwm: attachment materialization failed; sending URLs as text',
            );
            fileLines = files.map(
              (f) =>
                `[Attached: ${f.filename} (${f.content_type}) — could not be downloaded; URL: ${f.url}]`,
            );
          }
          if (fileLines.length > 0) {
            content = content
              ? `${content}\n\n${fileLines.join('\n')}`
              : fileLines.join('\n');
          }
        }

        // Track pending response so we can route sendMessage back
        this.pendingResponses.set(jid, messageId);

        const newMsg: NewMessage = {
          id: `hwm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'user',
          sender_name: 'User',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        this.onChatMetadata(jid, new Date().toISOString(), 'hwm', 'hwm', false);
        this.onMessage(jid, newMsg);
        break;
      }

      case 'new_conversation': {
        const jid = msg.conversation_jid as string;
        const name = (msg.name as string) || 'hwm';
        this.onChatMetadata(jid, new Date().toISOString(), name, 'hwm', false);
        break;
      }

      case 'conversation_started': {
        // Response to an agent-initiated start_conversation action. Post the
        // queued opening message into the newly-created conversation.
        const jid = msg.conversation_jid as string;
        const title = (msg.title as string) || 'hwm';
        if (!jid) {
          logger.warn({ msg }, 'hwm: conversation_started missing jid');
          break;
        }

        this.onChatMetadata(jid, new Date().toISOString(), title, 'hwm', false);

        const pending =
          this.pendingNewConversations.find((p) => p.title === title) ||
          this.pendingNewConversations[0];
        if (!pending) {
          logger.warn(
            { jid, title },
            'hwm: conversation_started with no pending opener',
          );
          break;
        }
        this.pendingNewConversations = this.pendingNewConversations.filter(
          (p) => p !== pending,
        );

        this.sendAction('message_complete', {
          message_id: null,
          conversation_jid: jid,
          final_content: pending.content,
        });
        logger.info(
          { jid, title },
          'hwm: posted opening message into new conversation',
        );

        // Hand the new conversation_jid back to the host attributed to the
        // requesting group, so the host can bind this run's Claude Code
        // session to it when the run completes. Without this, scheduled
        // tasks that create a new conversation (e.g. daily Freshservice
        // report) lose their session as soon as the task exits — and the
        // user's follow-up reply in that conversation starts from scratch.
        if (this.onNewConversationCreated && pending.sourceGroup) {
          this.onNewConversationCreated(pending.sourceGroup, jid);
        }
        break;
      }

      default:
        logger.debug({ type: msg.type }, 'hwm: unknown message type');
    }
  }

  async startConversation(
    title: string,
    content: string,
    sourceGroup: string,
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ title }, 'hwm: cannot start conversation — not connected');
      return;
    }

    this.pendingNewConversations.push({ title, content, sourceGroup });
    this.sendAction('start_conversation', { title });
    logger.info({ title, sourceGroup }, 'hwm: requested new conversation');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ jid }, 'hwm: cannot send — not connected');
      return;
    }

    const messageId = this.pendingResponses.get(jid);

    this.sendAction('message_complete', {
      message_id: messageId || null,
      conversation_jid: jid,
      final_content: text,
    });

    // Clear pending — next response will use conversation_jid fallback
    if (messageId) {
      this.pendingResponses.delete(jid);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.sendAction('typing', {
      conversation_jid: jid,
      is_typing: isTyping,
    });
  }

  // --- Private helpers ---

  /**
   * Download each attachment to the group's mounted scratch space and
   * return prompt lines that point Claude Code at the local file. Falls
   * back to the raw URL on per-file failure so the agent at least knows
   * something was attached.
   */
  private async materializeAttachments(
    jid: string,
    files: IncomingFile[],
  ): Promise<string[]> {
    const group = this.registeredGroups()[jid];
    let groupRoot: string | null = null;
    if (group) {
      try {
        groupRoot = resolveGroupFolderPath(group.folder);
      } catch (err) {
        logger.warn(
          { err, jid, folder: group.folder },
          'hwm: cannot resolve group folder for attachments',
        );
      }
    } else {
      logger.warn(
        { jid },
        'hwm: no registered group for jid — sending attachment URLs raw',
      );
    }

    // Download in parallel so multiple files don't compound latency;
    // each download has its own timeout so one slow URL can't block.
    const results = await Promise.all(
      files.map(async (f) => {
        const localPath = groupRoot
          ? await downloadAttachment(f, jid, groupRoot)
          : null;
        return { f, localPath };
      }),
    );

    return results.map(({ f, localPath }) => {
      if (localPath) {
        // Be explicit so Claude Code reaches for the Read tool rather
        // than guessing from the filename.
        return `[Attached file at ${localPath} — read it with the Read tool. Original filename: ${f.filename} (${f.content_type})]`;
      }
      return `[Attached: ${f.filename} (${f.content_type}) — could not be downloaded; URL: ${f.url}]`;
    });
  }

  private sendAction(action: string, data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        command: 'message',
        identifier: this.identifier,
        data: JSON.stringify({ action, ...data }),
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, RECONNECT_DELAY);
  }
}

// The group folder is mounted into the container at /workspace/group
// (see container-runner.ts:96). Attachments live under attachments/
// inside that folder so Claude Code reads them via that container path.
const CONTAINER_GROUP_PATH = '/workspace/group';
const ATTACHMENTS_SUBDIR = 'attachments';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
const ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;
// Hard ceiling around the whole materialization step. If anything in
// the download/parallel orchestration hangs past this, we give up on
// the attachments and forward the user's text + URL-fallback lines so
// the agent always responds.
const ATTACHMENT_TOTAL_TIMEOUT_MS = 30_000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms timeout`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadAttachment(
  f: IncomingFile,
  jid: string,
  groupRoot: string,
): Promise<string | null> {
  const jidSeg = sanitizePathSegment(jid);
  const fileName = sanitizeFilename(f.filename);
  const hostDir = path.join(groupRoot, ATTACHMENTS_SUBDIR, jidSeg);
  const hostPath = path.join(hostDir, fileName);
  const containerPath = `${CONTAINER_GROUP_PATH}/${ATTACHMENTS_SUBDIR}/${jidSeg}/${fileName}`;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    ATTACHMENT_FETCH_TIMEOUT_MS,
  );

  try {
    logger.info(
      { url: f.url, filename: f.filename },
      'hwm: fetching attachment',
    );
    const resp = await fetch(f.url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) {
      logger.warn(
        { url: f.url, status: resp.status, filename: f.filename },
        'hwm: attachment fetch returned non-2xx',
      );
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      logger.warn(
        { filename: f.filename, bytes: buf.byteLength },
        'hwm: attachment exceeds size cap, skipping',
      );
      return null;
    }
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(hostPath, buf);
    logger.info(
      { filename: f.filename, bytes: buf.byteLength, containerPath },
      'hwm: attachment materialized',
    );
    return containerPath;
  } catch (err) {
    // AbortError shows up here when our timeout fires — log it specifically
    // so it's distinguishable from network/auth errors in the agent logs.
    const isTimeout =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError');
    logger.error(
      { err, url: f.url, filename: f.filename, isTimeout },
      isTimeout
        ? 'hwm: attachment fetch timed out'
        : 'hwm: attachment download failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeFilename(name: string): string {
  // Strip path separators and whitespace; keep the rest readable so
  // Claude can recognise screenshot.png vs invoice.pdf.
  const cleaned = name.replace(/[\\/\s]+/g, '_').trim();
  return cleaned || `file_${Date.now()}`;
}

function sanitizePathSegment(seg: string): string {
  // JIDs contain `:` (`accomplice:<uuid>`) which is fine on POSIX but
  // ugly in paths. Replace anything outside [A-Za-z0-9_.-] with `_`.
  return seg.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

registerChannel('hwm', (opts: ChannelOpts) => {
  if (!HWM_RELAY_URL || !HWM_RELAY_TOKEN) {
    logger.info(
      'hwm: skipping — HWM_RELAY_URL/HWM_RELAY_TOKEN (or legacy ACCOMPLICE_URL/ACCOMPLICE_TOKEN) not set',
    );
    return null;
  }
  return new HwmChannel(opts);
});
