/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

// The model occasionally calls send_message twice for one reply, a second or
// two apart, having already been told the first went. Adam saw Burnie answer
// him twice over iMessage; eleven of these since the 5th of August.
describe('send_message MCP tool — saying the same thing twice', () => {
  it('sends once when the same text goes to the same place twice', async () => {
    await sendMessage.handler({ to: 'peer', text: 'the coin is already shipped' });
    const second = (await sendMessage.handler({
      to: 'peer',
      text: 'the coin is already shipped',
    })) as { content: Array<{ text: string }> };

    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(second.content[0].text).toMatch(/[Aa]lready sent/);
  });

  it('says which message it was, so the agent can still edit it', async () => {
    const first = (await sendMessage.handler({ to: 'peer', text: 'hello' })) as {
      content: Array<{ text: string }>;
    };
    const again = (await sendMessage.handler({ to: 'peer', text: 'hello' })) as {
      content: Array<{ text: string }>;
    };

    const id = first.content[0].text.match(/id: (\d+)/)?.[1];
    expect(id).toBeTruthy();
    expect(again.content[0].text).toContain(`id: ${id}`);
  });

  it('lets different words through', async () => {
    await sendMessage.handler({ to: 'peer', text: 'hello' });
    await sendMessage.handler({ to: 'peer', text: 'goodbye' });

    expect(getUndeliveredMessages()).toHaveLength(2);
  });
});
