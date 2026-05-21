import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Called by the channel when an agent-initiated conversation is confirmed
  // created by the platform (e.g. hwm_app posted-back `conversation_started`).
  // The host tracks these per-group so that when the run that requested the
  // new conversation completes with a Claude Code session id, that session
  // gets bound to the new conversation_jid — letting user follow-ups resume
  // the agent's context instead of starting a fresh one.
  onNewConversationCreated?: (sourceGroup: string, jid: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
