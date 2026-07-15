/**
 * FORK: wiring inheritance for auto-created messaging groups.
 *
 * On channels that opt in (ChannelAdapter.inheritWiringOnAutoCreate — hwmapp,
 * where every new app conversation belongs to the same authenticated owner),
 * a newly auto-created messaging group copies a sibling mg's unknown-sender
 * policy AND its wirings, so the first message engages immediately instead of
 * hitting the channel-request approval gate. One template is the source for
 * both — no drift between policy and wiring.
 *
 * Channels that don't opt in get `null` here and keep upstream's behavior:
 * declared channel defaults for policy, explicit approval for wiring.
 */
import { log } from '../log.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupsByChannel,
} from '../db/messaging-groups.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';

export interface WiringTemplate {
  mg: MessagingGroup;
  wirings: MessagingGroupAgent[];
}

/** First sibling mg on the channel that has wirings, or null. */
export function findWiringTemplate(
  inheritOnAutoCreate: boolean | undefined,
  channelType: string,
): WiringTemplate | null {
  if (!inheritOnAutoCreate) return null;
  for (const sibling of getMessagingGroupsByChannel(channelType)) {
    const wirings = getMessagingGroupAgents(sibling.id);
    if (wirings.length > 0) return { mg: sibling, wirings };
  }
  return null;
}

/** Clone the template's wirings onto a new mg. Returns the wiring count. */
export function mirrorTemplateWirings(
  template: WiringTemplate,
  mgId: string,
  eventInfo: { channelType: string; platformId: string },
): number {
  const wiringNow = new Date().toISOString();
  for (const w of template.wirings) {
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mgId,
      agent_group_id: w.agent_group_id,
      session_mode: w.session_mode,
      priority: w.priority,
      engage_mode: w.engage_mode,
      engage_pattern: w.engage_pattern,
      sender_scope: w.sender_scope,
      ignored_message_policy: w.ignored_message_policy,
      created_at: wiringNow,
    });
  }
  log.info('Inherited wiring for auto-created messaging group', {
    messagingGroupId: mgId,
    channelType: eventInfo.channelType,
    platformId: eventInfo.platformId,
    wiringsCloned: template.wirings.length,
  });
  return template.wirings.length;
}
