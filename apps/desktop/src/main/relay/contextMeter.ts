import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** How much of a transcript's end is read: the latest reply is always near it. */
const TAIL_BYTES = 512 * 1024;

interface UsageLine {
  type?: unknown;
  isSidechain?: unknown;
  message?: {
    id?: unknown;
    usage?: {
      input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * How full a Claude Code session's context is, from the lines of its transcript: the latest
 * main-thread reply's input, cache read and cache creation tokens, which is what Claude Code's
 * own status line counts. Side requests and subagents (sidechains) write lines too and are
 * skipped. The latest reply wins rather than the largest: a side request can reuse a shorter
 * prefix, and after a compaction the context really is smaller.
 */
export function contextTokensFromLines(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let entry: UsageLine;
    try {
      entry = JSON.parse(line) as UsageLine;
    } catch {
      // The first line of a tail is usually cut in half.
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    return (
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens)
    );
  }
  return null;
}

/** Reads the end of a transcript and measures it. Null when it cannot be read or has no reply. */
export async function readContextTokens(path: string): Promise<number | null> {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return contextTokensFromLines(buffer.toString('utf8').split('\n'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The context window a Claude model id implies: 1M for the `[1m]` variants, else 200K. */
export function contextWindowFor(model: string | undefined): number | null {
  if (!model) return null;
  return /\[1m\]|1m-context|-1m\b/i.test(model) ? 1_000_000 : 200_000;
}
