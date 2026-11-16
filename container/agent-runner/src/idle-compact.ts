/**
 * FORK: compact a heavy conversation while nobody is waiting on it.
 *
 * Claude Code compacts when the context fills, which is always in the middle
 * of somebody's question. On 2026-11-16 a chat session that had been sitting
 * at 90k tokens for days hit the limit three screenshots into a new request
 * and spent two and a half minutes summarizing before it carried on.
 *
 * The container already sits idle for a few minutes after each turn before it
 * stands down. If the conversation is heavy at that point, run `/compact`
 * then, so the next message starts from a summary instead of the pile.
 *
 * Fork-owned file. One call site in poll-loop.ts, at the stand-down.
 */
import { touchHeartbeat } from './db/connection.js';
import type { AgentProvider, QueryInput } from './providers/types.js';

function log(msg: string): void {
  console.error(`[idle-compact] ${msg}`);
}

/** Context size past which a stand-down compacts first. 0 turns it off. */
export function idleCompactTokens(): number {
  const raw = process.env.NANOCLAW_IDLE_COMPACT_TOKENS;
  if (raw === undefined || raw.trim() === '') return 100_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const COMPACT_TIMEOUT_MS = Number(process.env.NANOCLAW_IDLE_COMPACT_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * Compacts `continuation` if its last turn carried more context than the
 * limit. Returns the continuation to store afterwards (the same one unless
 * the provider reports a new id). Never throws: a failed compaction leaves
 * the conversation exactly as it was.
 */
export async function compactIfHeavy(
  provider: AgentProvider,
  continuation: string,
  input: Pick<QueryInput, 'cwd' | 'systemContext'>,
): Promise<string> {
  const limit = idleCompactTokens();
  if (!limit || !provider.supportsNativeSlashCommands || !provider.contextTokens) return continuation;

  let tokens: number | null = null;
  try {
    tokens = provider.contextTokens(continuation);
  } catch {
    return continuation;
  }
  if (tokens === null || tokens < limit) return continuation;

  log(`Conversation at ${tokens.toLocaleString()} tokens (limit ${limit.toLocaleString()}) — compacting before standing down`);
  const started = Date.now();
  let next = continuation;
  const query = provider.query({ prompt: '/compact', continuation, cwd: input.cwd, systemContext: input.systemContext });
  const timer = setTimeout(() => {
    log('Compaction timed out — leaving the conversation as it was');
    query.abort();
  }, COMPACT_TIMEOUT_MS);
  // The host reads a quiet heartbeat as a stuck container.
  const beat = setInterval(touchHeartbeat, 5000);
  try {
    for await (const event of query.events) {
      touchHeartbeat();
      if (event.type === 'init') next = event.continuation;
      // Nothing here is delivered to anyone: the result of a compaction is
      // the summary, and that stays in the transcript.
      else if (event.type === 'result') query.end();
    }
    log(`Compacted in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    log(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    return continuation;
  } finally {
    clearTimeout(timer);
    clearInterval(beat);
  }
  return next;
}
