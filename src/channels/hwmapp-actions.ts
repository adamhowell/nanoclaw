/**
 * Host-side delivery action for the hwmapp `new_conversation` MCP tool.
 *
 * The container can't reach the channel adapter directly (it lives in the
 * host process), so the tool writes a `kind:'system'` outbound row with
 * `{ action:'new_conversation', title, content }`. The delivery loop routes
 * system actions here (see delivery.ts handleSystemAction), and we drive the
 * hwmapp adapter's startConversation() round-trip: it sends a
 * `start_conversation` frame, hwm_app mints a Conversation and replies
 * `conversation_started`, and the adapter posts `content` as the opening
 * message into the fresh jid (also updating the user's chat sidebar).
 */
import { registerDeliveryAction } from '../delivery.js';
import { getChannelAdapter } from './channel-registry.js';
import { log } from '../log.js';
import type { HwmAppAdapter } from './hwmapp.js';

registerDeliveryAction('new_conversation', async (content, session) => {
  const rawTitle = typeof content.title === 'string' ? content.title.trim() : '';
  const title = rawTitle || 'New chat';
  const body = typeof content.content === 'string' ? content.content : '';
  if (!body) {
    log.warn('new_conversation: empty content, skipping', { sessionId: session.id, title });
    return;
  }

  const adapter = getChannelAdapter('hwmapp') as HwmAppAdapter | undefined;
  if (!adapter || typeof adapter.startConversation !== 'function') {
    log.warn('new_conversation: hwmapp adapter unavailable', { sessionId: session.id, title });
    return;
  }

  await adapter.startConversation(title, body, session.agent_group_id);
  log.info('new_conversation: requested new hwmapp conversation', { sessionId: session.id, title });
});
