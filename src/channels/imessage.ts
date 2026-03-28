/**
 * iMessage channel for NanoClaw.
 *
 * Uses macOS AppleScript to read and send iMessages.
 * Polls for new messages by tracking the last-seen message date.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { POLL_INTERVAL } from '../config.js';
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

const execFileAsync = promisify(execFile);

const JID_PREFIX = 'imessage:';
const envVars = readEnvFile(['IMESSAGE_CONTACT']);
const IMESSAGE_CONTACT =
  process.env.IMESSAGE_CONTACT || envVars.IMESSAGE_CONTACT;

/**
 * Run an AppleScript snippet and return stdout trimmed.
 */
async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 10000,
  });
  return stdout.trim();
}

/**
 * Read recent messages from a specific chat via AppleScript.
 * Returns lines of "SENDER_SEP_TEXT_SEP_DATE" for parsing.
 */
async function getRecentMessages(
  chatId: string,
): Promise<
  Array<{ sender: string; text: string; date: string; isFromMe: boolean }>
> {
  // Get the last 20 messages from this chat.
  // AppleScript returns them newest-first, so we reverse.
  const script = `
    tell application "Messages"
      set targetChat to chat id "${chatId}"
      set msgs to messages of targetChat
      set msgCount to count of msgs
      set startIdx to msgCount - 19
      if startIdx < 1 then set startIdx to 1
      set output to ""
      repeat with i from startIdx to msgCount
        set m to item i of msgs
        set msgText to text of m
        set msgDate to date of m as string
        set fromMe to is_from_me of m
        set senderHandle to ""
        try
          set senderHandle to handle of sender of m
        end try
        set output to output & senderHandle & "|||" & fromMe & "|||" & msgText & "|||" & msgDate & "\\n"
      end repeat
      return output
    end tell
  `;

  try {
    const raw = await osascript(script);
    if (!raw) return [];

    return raw
      .split('\n')
      .filter((line) => line.includes('|||'))
      .map((line) => {
        const [sender, fromMe, text, date] = line.split('|||');
        return {
          sender: sender || 'unknown',
          text: text || '',
          date: date || '',
          isFromMe: fromMe === 'true',
        };
      });
  } catch (err) {
    logger.debug({ err, chatId }, 'Failed to read iMessage messages');
    return [];
  }
}

/**
 * Resolve the AppleScript chat ID for a given contact (phone or email).
 */
async function resolveChatId(contact: string): Promise<string | null> {
  const script = `
    tell application "Messages"
      set allChats to every chat
      repeat with c in allChats
        set cid to id of c
        if cid contains "${contact}" then
          return cid
        end if
      end repeat
      return "NOT_FOUND"
    end tell
  `;

  try {
    const result = await osascript(script);
    if (result === 'NOT_FOUND') return null;
    return result;
  } catch (err) {
    logger.warn({ err, contact }, 'Failed to resolve iMessage chat ID');
    return null;
  }
}

/**
 * Send a message to a specific chat.
 */
async function sendToChat(chatId: string, text: string): Promise<void> {
  // Escape backslashes and double quotes for AppleScript string
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
    tell application "Messages"
      set targetChat to chat id "${chatId}"
      send "${escaped}" to targetChat
    end tell
  `;
  await osascript(script);
}

class IMessageChannel implements Channel {
  name = 'imessage';
  private contact: string;
  private chatId: string | null = null;
  private jid: string;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenDate = '';
  private sentByBot = new Set<string>(); // track texts we sent so we can skip them on poll
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(contact: string, opts: ChannelOpts) {
    this.contact = contact;
    this.jid = `${JID_PREFIX}${contact}`;
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
  }

  async connect(): Promise<void> {
    // Resolve the AppleScript chat ID for this contact
    this.chatId = await resolveChatId(this.contact);
    if (!this.chatId) {
      logger.error(
        { contact: this.contact },
        'Could not find iMessage chat for contact. Send them a message first, then restart.',
      );
      return;
    }

    logger.info(
      { contact: this.contact, chatId: this.chatId },
      'iMessage channel connected',
    );
    this.connected = true;

    // Emit chat metadata
    this.onChatMetadata(
      this.jid,
      new Date().toISOString(),
      `iMessage: ${this.contact}`,
      'imessage',
      false,
    );

    // Set lastSeenDate to now so we don't replay old messages
    this.lastSeenDate = new Date().toString();

    // Start polling for new messages
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL);
  }

  private async poll(): Promise<void> {
    if (!this.chatId) return;

    try {
      const messages = await getRecentMessages(this.chatId);
      if (messages.length === 0) return;

      // Find messages newer than lastSeenDate
      for (const msg of messages) {
        if (!msg.date || !msg.text) continue;
        // Skip already-seen messages
        if (msg.date <= this.lastSeenDate) continue;
        // Skip messages the bot sent (matched by text content)
        if (msg.isFromMe && this.sentByBot.has(msg.text)) {
          this.sentByBot.delete(msg.text);
          continue;
        }

        this.lastSeenDate = msg.date;

        const newMsg: NewMessage = {
          id: `imsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: this.jid,
          sender: msg.sender || this.contact,
          sender_name: msg.sender || this.contact,
          content: msg.text,
          timestamp: new Date().toISOString(),
          is_from_me: msg.isFromMe,
          is_bot_message: false,
        };

        this.onMessage(this.jid, newMsg);
      }
    } catch (err) {
      logger.debug({ err }, 'iMessage poll error');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.chatId) {
      logger.warn({ jid }, 'Cannot send iMessage: no chat ID resolved');
      return;
    }
    this.sentByBot.add(text);
    await sendToChat(this.chatId, text);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }
}

// Self-register the channel
registerChannel('imessage', (opts: ChannelOpts) => {
  if (!IMESSAGE_CONTACT) return null;
  return new IMessageChannel(IMESSAGE_CONTACT, opts);
});
