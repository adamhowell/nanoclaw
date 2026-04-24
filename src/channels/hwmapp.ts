/**
 * HWM app channel for NanoClaw.
 *
 * Connects outbound to app.hardworkmontage.com via WebSocket (ActionCable
 * protocol). Receives user messages from the HWM web UI, delivers them to
 * the agent, and streams responses back through the relay.
 */

import WebSocket from 'ws';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

import { ChannelOpts, registerChannel } from './registry.js';

// Kept as `accomplice:` to preserve compatibility with existing chat_jids in
// messages.db and the routing in router.ts findChannel(). Renaming would
// require migrating every stored chat_jid.
const JID_PREFIX = 'accomplice:';
const RECONNECT_DELAY = 5000;

// Env var names kept for compatibility with existing .env files.
const envVars = readEnvFile(['ACCOMPLICE_URL', 'ACCOMPLICE_TOKEN']);
const HWM_URL = process.env.ACCOMPLICE_URL || envVars.ACCOMPLICE_URL;
const HWM_TOKEN =
  process.env.ACCOMPLICE_TOKEN || envVars.ACCOMPLICE_TOKEN;

/** Maps conversation JID -> pending assistant message ID on the HWM side */
type PendingResponses = Map<string, number>;

/** Opening-message content waiting for a conversation_started confirmation */
type PendingNewConversation = { title: string; content: string };

class HwmAppChannel implements Channel {
  name = 'hwmapp';

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identifier: string;
  private pendingResponses: PendingResponses = new Map();
  private pendingNewConversations: PendingNewConversation[] = [];

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.identifier = JSON.stringify({ channel: 'AgentRelayChannel' });
  }

  async connect(): Promise<void> {
    this.doConnect();
  }

  private doConnect(): void {
    const url = `${HWM_URL}?agent_token=${HWM_TOKEN}`;
    logger.info({ url: HWM_URL }, 'HWM app: connecting');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('HWM app: WebSocket connected');
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
        logger.error({ err }, 'HWM app: failed to parse frame');
      }
    });

    this.ws.on('close', (code: number) => {
      const wasConnected = this.connected;
      this.connected = false;
      logger.warn(
        { code },
        `HWM app: WebSocket closed, reconnecting in ${RECONNECT_DELAY / 1000}s`,
      );
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'HWM app: WebSocket error');
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
      logger.info('HWM app: subscribed to relay channel');
      return;
    }

    if (frame.type === 'reject_subscription') {
      logger.error(
        'HWM app: subscription rejected — check ACCOMPLICE_TOKEN',
      );
      return;
    }

    // Data message from HWM
    if (frame.message) {
      logger.info(
        { identifier: frame.identifier, expectedIdentifier: this.identifier },
        'HWM app: received data frame',
      );
      this.handleMessage(frame.message);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'user_message': {
        const jid = msg.conversation_jid as string;
        const messageId = msg.message_id as number;
        let content = msg.content as string;

        // Page context — hwm_app now sends the path + title of the page the
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

        // Append file URLs to message content so the agent can see them
        const files = msg.files as
          | Array<{ filename: string; content_type: string; url: string }>
          | undefined;
        if (files && files.length > 0) {
          const fileList = files
            .map(
              (f) => `[Attached: ${f.filename} (${f.content_type}) — ${f.url}]`,
            )
            .join('\n');
          content = content ? `${content}\n\n${fileList}` : fileList;
        }

        // Track pending response so we can route sendMessage back
        this.pendingResponses.set(jid, messageId);

        const newMsg: NewMessage = {
          id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'user',
          sender_name: 'User',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        this.onChatMetadata(
          jid,
          new Date().toISOString(),
          'HWM App',
          'hwmapp',
          false,
        );
        this.onMessage(jid, newMsg);
        break;
      }

      case 'new_conversation': {
        const jid = msg.conversation_jid as string;
        const name = (msg.name as string) || 'HWM App';
        this.onChatMetadata(
          jid,
          new Date().toISOString(),
          name,
          'hwmapp',
          false,
        );
        break;
      }

      case 'conversation_started': {
        // Response to an agent-initiated start_conversation action. Post the
        // queued opening message into the newly-created conversation.
        const jid = msg.conversation_jid as string;
        const title = (msg.title as string) || 'HWM App';
        if (!jid) {
          logger.warn({ msg }, 'HWM app: conversation_started missing jid');
          break;
        }

        this.onChatMetadata(
          jid,
          new Date().toISOString(),
          title,
          'hwmapp',
          false,
        );

        const pending =
          this.pendingNewConversations.find((p) => p.title === title) ||
          this.pendingNewConversations[0];
        if (!pending) {
          logger.warn(
            { jid, title },
            'HWM app: conversation_started with no pending opener',
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
          'HWM app: posted opening message into new conversation',
        );
        break;
      }

      default:
        logger.debug({ type: msg.type }, 'HWM app: unknown message type');
    }
  }

  async startConversation(title: string, content: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        { title },
        'HWM app: cannot start conversation — not connected',
      );
      return;
    }

    this.pendingNewConversations.push({ title, content });
    this.sendAction('start_conversation', { title });
    logger.info({ title }, 'HWM app: requested new conversation');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ jid }, 'HWM app: cannot send — not connected');
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

registerChannel('hwmapp', (opts: ChannelOpts) => {
  if (!HWM_URL || !HWM_TOKEN) {
    logger.info(
      'HWM app: skipping — ACCOMPLICE_URL or ACCOMPLICE_TOKEN not set',
    );
    return null;
  }
  return new HwmAppChannel(opts);
});
