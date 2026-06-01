/**
 * Conversation MCP tools: new_conversation.
 *
 * Lets the agent open a brand-new hwm_app conversation for an unprompted
 * message (morning briefing, alert, digest) instead of posting into the
 * chat it was last bound to. As with scheduling, the container can't reach
 * the channel adapter directly (it lives in the host process), so this is
 * sent as a `kind:'system'` action via messages_out. The host's
 * `new_conversation` delivery action drives the hwmapp adapter's
 * startConversation() round-trip, which mints the Conversation server-side
 * and posts `content` as its opening message.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const newConversation: McpToolDefinition = {
  tool: {
    name: 'new_conversation',
    description:
      'Open a brand-new chat conversation and post an opening message into it, ' +
      'instead of replying in the current conversation. Use for unprompted output ' +
      'like a scheduled briefing, alert, or digest. The new conversation shows up ' +
      "in the user's chat sidebar with the given title.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short title for the new conversation (shown in the sidebar)' },
        content: { type: 'string', description: 'The opening message to post into the new conversation (Markdown)' },
      },
      required: ['title', 'content'],
    },
  },
  async handler(args) {
    const title = (args.title as string)?.trim();
    const content = args.content as string;
    if (!title || !content) return err('title and content are required');

    const r = getSessionRouting();
    const id = generateId();

    // Routed as a system action — the host's new_conversation delivery action
    // picks this up and calls the channel adapter's startConversation().
    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ action: 'new_conversation', title, content }),
    });

    log(`new_conversation: ${id} (title: ${title})`);
    return ok(`New conversation requested (title: ${title}). It will appear in the chat sidebar.`);
  },
};

registerTools([newConversation]);
