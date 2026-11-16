import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { compactIfHeavy, idleCompactTokens } from './idle-compact.js';
import { lastContextTokens } from './providers/claude.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

function provider(tokens: number | null, events: ProviderEvent[], seen: QueryInput[]): AgentProvider {
  return {
    supportsNativeSlashCommands: true,
    isSessionInvalid: () => false,
    contextTokens: () => tokens,
    query(input: QueryInput): AgentQuery {
      seen.push(input);
      return {
        push() {},
        end() {},
        abort() {},
        events: (async function* () {
          for (const e of events) yield e;
        })(),
      };
    },
  } as unknown as AgentProvider;
}

afterEach(() => {
  delete process.env.NANOCLAW_IDLE_COMPACT_TOKENS;
});

describe('compactIfHeavy', () => {
  it('leaves a light conversation alone', async () => {
    const seen: QueryInput[] = [];
    const out = await compactIfHeavy(provider(70_000, [], seen), 'sess-a', { cwd: '/tmp' });
    expect(out).toBe('sess-a');
    expect(seen.length).toBe(0);
  });

  it('runs /compact on a heavy one, resuming the same conversation', async () => {
    const seen: QueryInput[] = [];
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 'sess-a' },
      { type: 'result', text: 'Context compacted.' },
    ];
    const out = await compactIfHeavy(provider(120_000, events, seen), 'sess-a', { cwd: '/tmp' });
    expect(out).toBe('sess-a');
    expect(seen.length).toBe(1);
    expect(seen[0].prompt).toBe('/compact');
    expect(seen[0].continuation).toBe('sess-a');
  });

  it('hands back a new id when the provider reports one', async () => {
    const events: ProviderEvent[] = [{ type: 'init', continuation: 'sess-b' }, { type: 'result', text: null }];
    expect(await compactIfHeavy(provider(120_000, events, []), 'sess-a', { cwd: '/tmp' })).toBe('sess-b');
  });

  it('is off at 0, and when the size is unknown', async () => {
    const seen: QueryInput[] = [];
    expect(await compactIfHeavy(provider(null, [], seen), 'sess-a', { cwd: '/tmp' })).toBe('sess-a');
    process.env.NANOCLAW_IDLE_COMPACT_TOKENS = '0';
    expect(idleCompactTokens()).toBe(0);
    expect(await compactIfHeavy(provider(500_000, [], seen), 'sess-a', { cwd: '/tmp' })).toBe('sess-a');
    expect(seen.length).toBe(0);
  });

  it('keeps the conversation when the compaction throws', async () => {
    const p = provider(120_000, [], []);
    p.query = () => ({
      push() {},
      end() {},
      abort() {},
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        throw new Error('stream closed');
      })(),
    });
    expect(await compactIfHeavy(p, 'sess-a', { cwd: '/tmp' })).toBe('sess-a');
  });
});

describe('lastContextTokens', () => {
  it('reads the last main-thread turn, skipping subagent turns', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-compact-')), 't.jsonl');
    const row = (u: object, extra: object = {}) => JSON.stringify({ type: 'assistant', message: { usage: u }, ...extra });
    fs.writeFileSync(
      file,
      [
        row({ input_tokens: 2, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 1_000 }),
        row({ input_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000 }),
        row({ input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 }, { isSidechain: true }),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ].join('\n') + '\n',
    );
    expect(lastContextTokens(file)).toBe(95_002);
    expect(lastContextTokens(file + '.missing')).toBeNull();
  });
});
