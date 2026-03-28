/**
 * Accomplice channel for NanoClaw.
 *
 * Connects outbound to accomplice.ai via WebSocket (ActionCable protocol).
 * Receives user messages from the web UI, delivers them to the agent,
 * and streams responses back through the relay.
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

const JID_PREFIX = 'accomplice:';
const RECONNECT_DELAY = 5000;

const envVars = readEnvFile(['ACCOMPLICE_URL', 'ACCOMPLICE_TOKEN']);
const ACCOMPLICE_URL = process.env.ACCOMPLICE_URL || envVars.ACCOMPLICE_URL;
const ACCOMPLICE_TOKEN =
  process.env.ACCOMPLICE_TOKEN || envVars.ACCOMPLICE_TOKEN;

/** Maps conversation JID -> pending assistant message ID on the Accomplice side */
type PendingResponses = Map<string, number>;

class AccompliceChannel implements Channel {
  name = 'accomplice';

  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identifier: string;
  private pendingResponses: PendingResponses = new Map();

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.identifier = JSON.stringify({ channel: 'NanoclawRelayChannel' });
  }

  async connect(): Promise<void> {
    this.doConnect();
  }

  private doConnect(): void {
    const url = `${ACCOMPLICE_URL}?nanoclaw_token=${ACCOMPLICE_TOKEN}`;
    logger.info({ url: ACCOMPLICE_URL }, 'Accomplice: connecting');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('Accomplice: WebSocket connected');
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
        logger.error({ err }, 'Accomplice: failed to parse frame');
      }
    });

    this.ws.on('close', (code: number) => {
      const wasConnected = this.connected;
      this.connected = false;
      logger.warn(
        { code },
        `Accomplice: WebSocket closed, reconnecting in ${RECONNECT_DELAY / 1000}s`,
      );
      this.scheduleReconnect();
      if (wasConnected) {
        // Clear pending responses on disconnect
        this.pendingResponses.clear();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'Accomplice: WebSocket error');
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
      logger.info('Accomplice: subscribed to relay channel');
      return;
    }

    if (frame.type === 'reject_subscription') {
      logger.error(
        'Accomplice: subscription rejected — check ACCOMPLICE_TOKEN',
      );
      return;
    }

    // Data message from Accomplice
    if (frame.message) {
      logger.info(
        { identifier: frame.identifier, expectedIdentifier: this.identifier },
        'Accomplice: received data frame',
      );
      this.handleMessage(frame.message);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'user_message': {
        const jid = msg.conversation_jid as string;
        const messageId = msg.message_id as number;
        const content = msg.content as string;

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
          'Accomplice',
          'accomplice',
          false,
        );
        this.onMessage(jid, newMsg);
        break;
      }

      case 'new_conversation': {
        const jid = msg.conversation_jid as string;
        const name = (msg.name as string) || 'Accomplice';
        this.onChatMetadata(
          jid,
          new Date().toISOString(),
          name,
          'accomplice',
          false,
        );
        break;
      }

      default:
        logger.debug({ type: msg.type }, 'Accomplice: unknown message type');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({ jid }, 'Accomplice: cannot send — not connected');
      return;
    }

    const messageId = this.pendingResponses.get(jid);
    if (!messageId) {
      logger.warn({ jid }, 'Accomplice: no pending response for JID');
      return;
    }

    this.sendAction('message_complete', {
      message_id: messageId,
      final_content: text,
    });

    // Clear pending after sending final response
    this.pendingResponses.delete(jid);
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

registerChannel('accomplice', (opts: ChannelOpts) => {
  if (!ACCOMPLICE_URL || !ACCOMPLICE_TOKEN) {
    logger.info(
      'Accomplice: skipping — ACCOMPLICE_URL or ACCOMPLICE_TOKEN not set',
    );
    return null;
  }
  return new AccompliceChannel(opts);
});
