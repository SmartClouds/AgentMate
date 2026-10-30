import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChatFollowerDeps,
  type ChatSessionSpec,
  createChatFollower,
  locateTranscript,
  readTranscript,
  type TranscriptCandidate,
} from './chatTranscript';

const POLL_MS = 20;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const T0 = Date.parse('2026-10-30T05:00:00.000Z');

function spec(overrides: Partial<ChatSessionSpec> = {}): ChatSessionSpec {
  return { sessionId: 's1', cliId: 'codex-cli', cwd: 'E:\\proj', startedAt: T0, ...overrides };
}

function candidate(path: string, startedAt: number | null): TranscriptCandidate {
  return { path, startedAt };
}

describe('locateTranscript', () => {
  const deps = (candidates: TranscriptCandidate[], claude: string | null = null) => ({
    claudeTranscriptPath: vi.fn(() => claude),
    candidates: vi.fn(async () => candidates),
  });

  it('takes the path Claude Code reported through its hooks', async () => {
    const d = deps([], 'C:\\u\\.claude\\projects\\E--proj\\abc.jsonl');
    const path = await locateTranscript(d, spec({ cliId: 'claude-code' }), new Set());
    expect(path).toBe('C:\\u\\.claude\\projects\\E--proj\\abc.jsonl');
    expect(d.claudeTranscriptPath).toHaveBeenCalledWith('s1');
    expect(d.candidates).not.toHaveBeenCalled();
  });

  it('waits for Claude Code when no hook has reported yet', async () => {
    expect(await locateTranscript(deps([]), spec({ cliId: 'openclaude' }), new Set())).toBeNull();
  });

  it('picks the first session the folder started after the tab did', async () => {
    const d = deps([
      candidate('/old.jsonl', T0 - 60_000),
      candidate('/later.jsonl', T0 + 30_000),
      candidate('/mine.jsonl', T0 + 2_000),
      candidate('/unknown.jsonl', null),
    ]);
    expect(await locateTranscript(d, spec(), new Set())).toBe('/mine.jsonl');
    expect(d.candidates).toHaveBeenCalledWith('codex-cli', 'E:\\proj');
  });

  it('allows a little clock slack before the tab started', async () => {
    const d = deps([candidate('/mine.jsonl', T0 - 3_000)]);
    expect(await locateTranscript(d, spec(), new Set())).toBe('/mine.jsonl');
  });

  it('skips a transcript another tab is already showing', async () => {
    const d = deps([candidate('/a.jsonl', T0 + 1_000), candidate('/b.jsonl', T0 + 2_000)]);
    expect(await locateTranscript(d, spec(), new Set(['/a.jsonl']))).toBe('/b.jsonl');
  });

  it('finds a resumed conversation by its id, however old it is', async () => {
    const d = deps([
      candidate('/rollout-2026-01-01T00-00-00-0199aaaa-bbbb.jsonl', T0 - 86_400_000),
      candidate('/fresh.jsonl', T0 + 1_000),
    ]);
    const path = await locateTranscript(d, spec({ conversationId: '0199aaaa-bbbb' }), new Set());
    expect(path).toBe('/rollout-2026-01-01T00-00-00-0199aaaa-bbbb.jsonl');
  });

  it('finds a resumed Gemini chat, whose file name has only the start of the id', async () => {
    const d = deps([candidate('/chats/session-2026-10-12T02-00-c3dd4fe7.jsonl', T0 - 999_999)]);
    const path = await locateTranscript(
      d,
      spec({ cliId: 'gemini-cli', conversationId: 'c3dd4fe7-6c57-4c93-805e-e2667bd3fdd1' }),
      new Set(),
    );
    expect(path).toBe('/chats/session-2026-10-12T02-00-c3dd4fe7.jsonl');
  });

  it('finds nothing for a CLI without a chat view', async () => {
    const d = deps([candidate('/a.jsonl', T0 + 1)]);
    expect(await locateTranscript(d, spec({ cliId: 'aider' }), new Set())).toBeNull();
  });
});

describe('readTranscript', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-chat-'));
    file = join(dir, 't.jsonl');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads whole lines and holds back one still being written', async () => {
    writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":');
    const first = await readTranscript(file, 0);
    expect(first).toEqual({ lines: ['{"a":1}', '{"b":2}'], nextOffset: 16, reset: false });

    appendFileSync(file, '3}\n');
    const second = await readTranscript(file, first.nextOffset);
    expect(second).toEqual({ lines: ['{"c":3}'], nextOffset: 24, reset: false });
  });

  it('counts bytes, not characters, so text in any language stays whole', async () => {
    writeFileSync(file, '{"t":"سلام"}\n');
    const first = await readTranscript(file, 0);
    appendFileSync(file, '{"t":"✓"}\n');
    expect((await readTranscript(file, first.nextOffset)).lines).toEqual(['{"t":"✓"}']);
  });

  it('starts over when the file got shorter', async () => {
    writeFileSync(file, '{"a":1}\n{"b":2}\n');
    const first = await readTranscript(file, 0);
    writeFileSync(file, '{"z":0}\n');
    expect(await readTranscript(file, first.nextOffset)).toEqual({
      lines: ['{"z":0}'],
      nextOffset: 8,
      reset: true,
    });
  });

  it('reads only the end of a very large file, from a line boundary', async () => {
    writeFileSync(file, '{"old":1}\n{"mid":2}\n{"new":3}\n');
    const read = await readTranscript(file, 0, { maxInitialBytes: 15 });
    expect(read.lines).toEqual(['{"new":3}']);
    expect(read.nextOffset).toBe(30);
  });

  it('reads nothing from a file that is gone', async () => {
    expect(await readTranscript(join(dir, 'missing.jsonl'), 0)).toEqual({
      lines: [],
      nextOffset: 0,
      reset: false,
    });
  });
});

describe('createChatFollower', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-chat-'));
    file = join(dir, 't.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function follower(locate: () => string | null) {
    const sent: { sessionId: string; lines: string[]; reset: boolean }[] = [];
    const deps: ChatFollowerDeps = {
      locate: vi.fn(async () => locate()),
      send: (payload) => sent.push(payload),
      pollMs: POLL_MS,
    };
    return { chat: createChatFollower(deps), sent, deps };
  }

  it('answers a subscribe with the transcript so far, then sends what is added', async () => {
    writeFileSync(file, '{"a":1}\n');
    const { chat, sent } = follower(() => file);
    expect(await chat.subscribe(spec())).toEqual({ status: 'ready', lines: ['{"a":1}'] });

    appendFileSync(file, '{"b":2}\n');
    await vi.waitFor(() =>
      expect(sent).toEqual([{ sessionId: 's1', lines: ['{"b":2}'], reset: false }]),
    );

    await pause(POLL_MS * 4);
    expect(sent).toHaveLength(1);
    chat.dispose();
  });

  it('keeps looking until the CLI has written a transcript', async () => {
    let path: string | null = null;
    const { chat, sent } = follower(() => path);
    expect(await chat.subscribe(spec())).toEqual({ status: 'waiting' });

    writeFileSync(file, '{"a":1}\n');
    path = file;
    await vi.waitFor(() =>
      expect(sent).toEqual([{ sessionId: 's1', lines: ['{"a":1}'], reset: true }]),
    );
    chat.dispose();
  });

  it('starts over when the session moves to another transcript', async () => {
    const other = join(dir, 'u.jsonl');
    writeFileSync(file, '{"a":1}\n');
    writeFileSync(other, '{"fresh":1}\n');
    let path = file;
    const { chat, sent } = follower(() => path);
    await chat.subscribe(spec({ cliId: 'claude-code' }));

    path = other;
    await vi.waitFor(() =>
      expect(sent).toEqual([{ sessionId: 's1', lines: ['{"fresh":1}'], reset: true }]),
    );
    chat.dispose();
  });

  it('stops reading once unsubscribed', async () => {
    writeFileSync(file, '{"a":1}\n');
    const { chat, sent, deps } = follower(() => file);
    await chat.subscribe(spec());
    chat.unsubscribe('s1');
    appendFileSync(file, '{"b":2}\n');
    await pause(POLL_MS * 5);
    expect(sent).toEqual([]);
    expect(deps.locate).toHaveBeenCalledTimes(1);
  });

  it('does not hand one transcript to two tabs', async () => {
    writeFileSync(file, '{"a":1}\n');
    const claims: Set<string>[] = [];
    const chat = createChatFollower({
      locate: async (_spec, claimed) => {
        claims.push(new Set(claimed));
        return claimed.has(file) ? null : file;
      },
      send: () => undefined,
      pollMs: POLL_MS,
    });
    expect(await chat.subscribe(spec({ sessionId: 's1' }))).toEqual(
      expect.objectContaining({ status: 'ready' }),
    );
    expect(await chat.subscribe(spec({ sessionId: 's2' }))).toEqual({ status: 'waiting' });
    // A session's own transcript does not count as taken when it looks again.
    expect(claims[1].has(file)).toBe(true);
    chat.dispose();
  });
});
