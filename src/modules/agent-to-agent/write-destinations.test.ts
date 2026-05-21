import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import { createDestination } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-destinations' };
});

const TEST_DIR = '/tmp/nanoclaw-test-write-destinations';

function now(): string {
  return new Date().toISOString();
}

function readDestinationsRow(agentGroupId: string, sessionId: string, name: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const row = db.prepare('SELECT name, channel_type, platform_id, type FROM destinations WHERE name = ?').get(name) as
    | { name: string; channel_type: string | null; platform_id: string | null; type: string }
    | undefined;
  db.close();
  return row;
}

describe('writeDestinations — channelDestinationsAreSessionScoped', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });

    // Set up parallel mg pairs for the two channels — one session-scoped
    // (sc) channel, one default (un) channel. Each channel has a template
    // mg (the destination's static target) and a source mg (a different
    // conversation on the same channel that the session is bound to).
    for (const ch of ['ch-sc', 'ch-un']) {
      createMessagingGroup({
        id: `mg-${ch}-template`,
        channel_type: ch,
        platform_id: `${ch}-platform-TEMPLATE`,
        name: 'Template',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createMessagingGroup({
        id: `mg-${ch}-source`,
        channel_type: ch,
        platform_id: `${ch}-platform-SOURCE`,
        name: 'Source',
        is_group: 0,
        unknown_sender_policy: 'public',
        created_at: now(),
      });
      createDestination({
        agent_group_id: 'ag-1',
        local_name: `user-${ch}`,
        target_type: 'channel',
        target_id: `mg-${ch}-template`,
        created_at: now(),
      });
    }

    // Register both adapters up-front so registry state is identical for
    // both tests — flag value is what differs.
    const { registerChannelAdapter, initChannelAdapters } = await import('../../channels/channel-registry.js');
    registerChannelAdapter('ch-sc', {
      factory: () => ({
        name: 'ch-sc',
        channelType: 'ch-sc',
        supportsThreads: false,
        channelDestinationsAreSessionScoped: true,
        async setup() {},
        async teardown() {},
        isConnected() {
          return true;
        },
        async deliver() {
          return undefined;
        },
      }),
    });
    registerChannelAdapter('ch-un', {
      factory: () => ({
        name: 'ch-un',
        channelType: 'ch-un',
        supportsThreads: false,
        // channelDestinationsAreSessionScoped omitted (defaults to undefined)
        async setup() {},
        async teardown() {},
        isConnected() {
          return true;
        },
        async deliver() {
          return undefined;
        },
      }),
    });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('uses the session mg platform_id when the adapter is session-scoped', () => {
    createSession({
      id: 'sess-sc',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-ch-sc-source',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-1', 'sess-sc');

    writeDestinations('ag-1', 'sess-sc');

    const row = readDestinationsRow('ag-1', 'sess-sc', 'user-ch-sc');
    expect(row).toBeDefined();
    expect(row!.type).toBe('channel');
    expect(row!.channel_type).toBe('ch-sc');
    // Critical: platform_id is the SESSION'S mg, not the destination row's
    // `target_id` mg.
    expect(row!.platform_id).toBe('ch-sc-platform-SOURCE');
  });

  it('uses the destination target platform_id when the adapter is NOT session-scoped', () => {
    createSession({
      id: 'sess-un',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-ch-un-source',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-1', 'sess-un');

    writeDestinations('ag-1', 'sess-un');

    const row = readDestinationsRow('ag-1', 'sess-un', 'user-ch-un');
    expect(row).toBeDefined();
    expect(row!.platform_id).toBe('ch-un-platform-TEMPLATE');
  });
});
