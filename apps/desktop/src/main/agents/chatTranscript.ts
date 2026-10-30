import { open } from 'node:fs/promises';
import { chatReaderFor } from '@runova/core';
import type { ChatAppend, ChatSessionSpec, ChatSubscribeResult } from '../../shared/apiTypes';

export type { ChatAppend, ChatSessionSpec, ChatSubscribeResult };

/**
 * Finds and follows the transcript an agent CLI writes while it runs in a Workspace tab, so the
 * tab's chat view can show the conversation. The CLI keeps running in its terminal; this only
 * reads the file it writes.
 */

/** A transcript the CLI kept for the tab's folder, with when its session started. */
export interface TranscriptCandidate {
  path: string;
  startedAt: number | null;
}

export interface LocateDeps {
  /** The path Claude Code reported for the session through its hooks. */
  claudeTranscriptPath(sessionId: string): string | null;
  /** Transcripts the CLI kept for a folder (Codex rollouts, Gemini chats). */
  candidates(cliId: string, cwd: string): Promise<TranscriptCandidate[]>;
}

/** CLIs that report their transcript through hooks, so its path can change mid-session. */
const HOOK_REPORTED = new Set(['claude-code', 'openclaude']);
/** How far before the tab opened a session may have started, for clocks a little apart. */
const START_SLACK_MS = 5_000;
/** The most of a transcript read when a chat view first opens. */
const MAX_INITIAL_BYTES = 8 * 1024 * 1024;

export async function locateTranscript(
  deps: LocateDeps,
  spec: ChatSessionSpec,
  claimed: ReadonlySet<string>,
): Promise<string | null> {
  if (!chatReaderFor(spec.cliId)) return null;
  if (HOOK_REPORTED.has(spec.cliId)) return deps.claudeTranscriptPath(spec.sessionId);
  const candidates = await deps.candidates(spec.cliId, spec.cwd);
  const { conversationId } = spec;
  if (conversationId) {
    // Gemini names a chat file after only the first block of its session id.
    const short = conversationId.split('-')[0];
    const resumed = candidates.find(
      (one) => one.path.includes(conversationId) || (short && one.path.includes(short)),
    );
    if (resumed) return resumed.path;
  }
  const fresh = candidates
    .filter(
      (one): one is { path: string; startedAt: number } =>
        one.startedAt !== null &&
        one.startedAt >= spec.startedAt - START_SLACK_MS &&
        !claimed.has(one.path),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
  return fresh[0]?.path ?? null;
}

export interface TranscriptRead {
  /** Complete lines only; one still being written waits for the next read. */
  lines: string[];
  nextOffset: number;
  /** The file got shorter than the offset, so it was replaced and is read from the start. */
  reset: boolean;
}

/**
 * Reads the lines added to a transcript since `fromOffset`, a byte offset. A first read of a very
 * large file starts near its end, at a line boundary, so opening a chat stays quick.
 */
export async function readTranscript(
  path: string,
  fromOffset: number,
  options: { maxInitialBytes?: number } = {},
): Promise<TranscriptRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const reset = size < fromOffset;
    let start = reset ? 0 : fromOffset;
    const maxInitial = options.maxInitialBytes ?? MAX_INITIAL_BYTES;
    const trimmed = start === 0 && size > maxInitial;
    if (trimmed) start = size - maxInitial;
    if (size === start) return { lines: [], nextOffset: start, reset };
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let chunk = buffer.subarray(0, bytesRead);
    let base = start;
    if (trimmed) {
      // The first line is probably cut in half.
      const firstBreak = chunk.indexOf(0x0a);
      chunk = firstBreak < 0 ? chunk.subarray(chunk.length) : chunk.subarray(firstBreak + 1);
      base = start + (firstBreak + 1);
    }
    const lastBreak = chunk.lastIndexOf(0x0a);
    if (lastBreak < 0) return { lines: [], nextOffset: base, reset };
    const lines = chunk
      .subarray(0, lastBreak)
      .toString('utf8')
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0);
    return { lines, nextOffset: base + lastBreak + 1, reset };
  } catch {
    return { lines: [], nextOffset: fromOffset, reset: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface ChatFollowerDeps {
  locate(spec: ChatSessionSpec, claimed: ReadonlySet<string>): Promise<string | null>;
  send(payload: ChatAppend): void;
  pollMs?: number;
}

interface Followed {
  spec: ChatSessionSpec;
  path: string | null;
  offset: number;
  timer: NodeJS.Timeout | null;
  busy: boolean;
}

/**
 * Keeps the open chat views fed. Each subscribed session's transcript is checked on a short poll
 * (a stat when nothing changed), which works the same on every OS where `fs.watch` does not.
 */
export function createChatFollower(deps: ChatFollowerDeps) {
  const pollMs = deps.pollMs ?? 750;
  const followed = new Map<string, Followed>();

  function claimedBy(others: string): Set<string> {
    const claimed = new Set<string>();
    for (const [id, one] of followed) if (id !== others && one.path) claimed.add(one.path);
    return claimed;
  }

  /** Finds the transcript again when it can move, or when none was found yet. */
  async function relocate(one: Followed): Promise<boolean> {
    if (one.path && !HOOK_REPORTED.has(one.spec.cliId)) return false;
    const path = await deps.locate(one.spec, claimedBy(one.spec.sessionId));
    if (!path || path === one.path) return false;
    one.path = path;
    one.offset = 0;
    return true;
  }

  async function tick(one: Followed): Promise<void> {
    if (one.busy) return;
    one.busy = true;
    try {
      const moved = await relocate(one);
      if (!one.path || followed.get(one.spec.sessionId) !== one) return;
      const read = await readTranscript(one.path, one.offset);
      if (followed.get(one.spec.sessionId) !== one) return;
      one.offset = read.nextOffset;
      if (read.lines.length > 0 || moved || read.reset) {
        deps.send({
          sessionId: one.spec.sessionId,
          lines: read.lines,
          reset: moved || read.reset,
        });
      }
    } finally {
      one.busy = false;
    }
  }

  function schedule(one: Followed): void {
    one.timer = setTimeout(async () => {
      if (followed.get(one.spec.sessionId) !== one) return;
      await tick(one).catch(() => undefined);
      if (followed.get(one.spec.sessionId) === one) schedule(one);
    }, pollMs);
    // Reading a chat is never a reason to keep the app running.
    one.timer.unref?.();
  }

  function stop(sessionId: string): void {
    const one = followed.get(sessionId);
    if (one?.timer) clearTimeout(one.timer);
    followed.delete(sessionId);
  }

  return {
    async subscribe(spec: ChatSessionSpec): Promise<ChatSubscribeResult> {
      stop(spec.sessionId);
      const one: Followed = { spec, path: null, offset: 0, timer: null, busy: true };
      followed.set(spec.sessionId, one);
      try {
        one.path = await deps.locate(spec, claimedBy(spec.sessionId));
        if (one.path) {
          const read = await readTranscript(one.path, 0);
          one.offset = read.nextOffset;
          return { status: 'ready', lines: read.lines };
        }
        return { status: 'waiting' };
      } finally {
        one.busy = false;
        if (followed.get(spec.sessionId) === one) schedule(one);
      }
    },

    unsubscribe: stop,

    dispose(): void {
      for (const id of [...followed.keys()]) stop(id);
    },
  };
}

export type ChatFollower = ReturnType<typeof createChatFollower>;
