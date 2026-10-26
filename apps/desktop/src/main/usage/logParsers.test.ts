import { appendFileSync, mkdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINI_LOG_FALLBACK_MODEL } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import {
  collectLogFiles,
  type FileScanState,
  type LogFile,
  retentionSinceMs,
  type ScanCache,
  scanLogFile,
  scanProviderLogs,
} from './logParsers';

/**
 * Token usage is read straight out of the CLIs' own session logs, which are append-only JSONL
 * files that reach hundreds of megabytes. The scan therefore remembers a byte offset per file and
 * only reads what was appended since last time, so these tests care as much about the resume
 * bookkeeping as about the parsing itself.
 *
 * The providers are located through environment variables (CLAUDE_CONFIG_DIR, CODEX_HOME), which
 * is what lets a test point them at a temp folder.
 */

const HOUR_MS = 3_600_000;

let root = '';
let now = 0;

function claudeLine(fields: {
  at: number;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  id?: string;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(fields.at).toISOString(),
    message: {
      id: fields.id,
      model: fields.model,
      usage: {
        input_tokens: fields.input ?? 0,
        output_tokens: fields.output ?? 0,
        cache_read_input_tokens: fields.cacheRead ?? 0,
        cache_creation_input_tokens: fields.cacheWrite ?? 0,
      },
    },
  })}\n`;
}

function codexTurnContext(model: string, at: number): string {
  return `${JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: 'turn_context',
    payload: { type: 'turn_context', model },
  })}\n`;
}

function codexTokenCount(fields: {
  at: number;
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  usedPercent?: number;
  resetsAt?: number;
  /** The whole `rate_limits` object, for snapshots with more than a primary window. */
  rateLimits?: Record<string, unknown>;
}): string {
  return `${JSON.stringify({
    timestamp: new Date(fields.at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: fields.input ?? 0,
          cached_input_tokens: fields.cached ?? 0,
          output_tokens: fields.output ?? 0,
          reasoning_output_tokens: fields.reasoning ?? 0,
        },
      },
      rate_limits:
        fields.rateLimits ??
        (fields.usedPercent === undefined
          ? null
          : { primary: { used_percent: fields.usedPercent, resets_at: fields.resetsAt } }),
    },
  })}\n`;
}

/** Writes a Claude session transcript and returns its path. */
function writeClaudeLog(name: string, lines: string[]): string {
  const dir = join(root, 'claude', 'projects', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.join(''), 'utf-8');
  return file;
}

function writeCodexLog(name: string, lines: string[]): string {
  const dir = join(root, 'codex', 'sessions', '2026', '09', '17');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, lines.join(''), 'utf-8');
  return file;
}

/** One Copilot session directory, as the CLI lays it out under session-state. */
function writeCopilotLog(sessionId: string, lines: string[]): string {
  const dir = join(root, 'copilot', 'session-state', sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, lines.join(''), 'utf-8');
  return file;
}

function copilotStart(at: number, cwd: string): string {
  return `${JSON.stringify({
    type: 'session.start',
    id: 'evt-start',
    timestamp: new Date(at).toISOString(),
    data: { sessionId: 'ses-1', context: { cwd } },
  })}\n`;
}

function copilotUsage(fields: {
  at: number;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  id?: string;
}): string {
  return `${JSON.stringify({
    type: 'session.usage_record',
    id: fields.id ?? 'evt-1',
    timestamp: new Date(fields.at).toISOString(),
    data: {
      usage: {
        model: fields.model ?? 'gpt-6-luna',
        inputTokens: fields.input ?? 0,
        outputTokens: fields.output ?? 0,
        cacheReadTokens: fields.cacheRead ?? 0,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
      },
    },
  })}\n`;
}

async function scanClaude(cache: ScanCache = {}, sinceMs = now - 7 * 24 * HOUR_MS) {
  return scanProviderLogs('claude-code', cache, sinceMs);
}

async function scanCodex(cache: ScanCache = {}, sinceMs = now - 7 * 24 * HOUR_MS) {
  return scanProviderLogs('codex', cache, sinceMs);
}

async function scanCopilot(cache: ScanCache = {}, sinceMs = now - 7 * 24 * HOUR_MS) {
  return scanProviderLogs('copilot', cache, sinceMs);
}

beforeEach(() => {
  root = tempDir('runova-usage-logs-');
  now = Date.UTC(2026, 8, 17, 12, 0, 0);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('COPILOT_HOME', join(root, 'copilot'));
  vi.stubEnv('GEMINI_HOME', join(root, 'gemini'));
  // homedir() is the fallback root, and it must not be reached during a test.
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('retentionSinceMs', () => {
  it('keeps a day of slack over the 30 days that get reported', () => {
    // A boundary event must not vanish between the scan and the report.
    expect(retentionSinceMs()).toBe(now - 31 * 24 * HOUR_MS);
  });
});

describe('Claude Code logs', () => {
  it('reads token counts, the model and the message id', async () => {
    writeClaudeLog('session.jsonl', [
      claudeLine({
        at: now - HOUR_MS,
        model: 'test-model',
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 7,
        id: 'msg_1',
      }),
    ]);

    const result = await scanClaude();

    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'test-model',
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 7,
        id: 'msg_1',
      },
    ]);
  });

  it('ignores lines with no usage block, malformed JSON and unusable timestamps', async () => {
    writeClaudeLog('session.jsonl', [
      `${JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString() })}\n`,
      '{ not json at all\n',
      '\n',
      `${JSON.stringify({ timestamp: 'not-a-date', message: { model: 'test-model', usage: { input_tokens: 5 } } })}\n`,
      // A usage block with no model cannot be priced, so it is not an event.
      `${JSON.stringify({ timestamp: new Date(now).toISOString(), message: { usage: { input_tokens: 5 } } })}\n`,
      claudeLine({ at: now, model: 'test-model', input: 1 }),
    ]);

    const result = await scanClaude();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.input).toBe(1);
  });

  it('finds logs in nested project folders', async () => {
    const deep = join(root, 'claude', 'projects', 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(deep, 'deep.jsonl'),
      claudeLine({ at: now, model: 'test-model', input: 3 }),
      'utf-8',
    );

    const result = await scanClaude();

    expect(result.entries).toHaveLength(1);
  });

  it('leaves non-jsonl files alone', async () => {
    const dir = join(root, 'claude', 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.json'), claudeLine({ at: now, model: 'test-model' }), 'utf-8');

    expect((await scanClaude()).entries).toEqual([]);
  });

  it('resolves to nothing when the provider was never installed', async () => {
    const result = await scanClaude();

    expect(result.entries).toEqual([]);
    expect(result.cache).toEqual({});
  });

  it('only parses the bytes appended since the last scan', async () => {
    const file = writeClaudeLog('session.jsonl', [
      claudeLine({ at: now - 2 * HOUR_MS, model: 'test-model', input: 10, id: 'a' }),
    ]);

    const first = await scanClaude();
    expect(first.entries).toHaveLength(1);
    const offsetAfterFirst = first.cache[file]?.offset;
    expect(offsetAfterFirst).toBeGreaterThan(0);

    // The CLI appends another turn, and the mtime moves with it.
    appendFileSync(
      file,
      claudeLine({ at: now - HOUR_MS, model: 'test-model', input: 20, id: 'b' }),
    );
    vi.setSystemTime(now + 1_000);

    const second = await scanClaude(first.cache);

    // Both events are reported, and the new one was read from the stored offset.
    expect(second.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(second.cache[file]?.offset).toBeGreaterThan(offsetAfterFirst ?? 0);
  });

  it('reuses what it already extracted when a file has not changed', async () => {
    const file = writeClaudeLog('session.jsonl', [
      claudeLine({ at: now, model: 'test-model', input: 10, id: 'a' }),
    ]);

    const first = await scanClaude();
    // Rewriting the file's content without touching size or mtime would be invisible, which is
    // exactly the shortcut being asserted: an untouched file is not re-read.
    writeFileSync(
      file,
      claudeLine({ at: now, model: 'other-model', input: 99, id: 'zz' }),
      'utf-8',
    );
    const stateBefore = { ...first.cache[file], mtimeMs: first.cache[file]?.mtimeMs ?? 0 };
    const cache: ScanCache = { [file]: { ...stateBefore } as ScanCache[string] };

    const second = await scanProviderLogs('claude-code', cache, now - 7 * 24 * HOUR_MS);

    expect(second.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('holds back a half-written last line until it is complete', async () => {
    const complete = claudeLine({ at: now - HOUR_MS, model: 'test-model', input: 10, id: 'a' });
    const partial = claudeLine({ at: now, model: 'test-model', input: 20, id: 'b' }).slice(0, 40);
    const file = writeClaudeLog('session.jsonl', [complete, partial]);

    const first = await scanClaude();

    // The truncated tail is not an event yet, and the offset stopped at the line boundary.
    expect(first.entries.map((entry) => entry.id)).toEqual(['a']);
    expect(first.cache[file]?.offset).toBe(Buffer.byteLength(complete, 'utf-8'));

    // The CLI finishes writing that line.
    writeFileSync(
      file,
      complete + claudeLine({ at: now, model: 'test-model', input: 20, id: 'b' }),
      'utf-8',
    );
    vi.setSystemTime(now + 1_000);

    const second = await scanClaude(first.cache);
    expect(second.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('starts over when a log was rotated behind the stored offset', async () => {
    const file = writeClaudeLog('session.jsonl', [
      claudeLine({ at: now - 2 * HOUR_MS, model: 'test-model', input: 10, id: 'a' }),
      claudeLine({ at: now - 2 * HOUR_MS, model: 'test-model', input: 10, id: 'b' }),
    ]);
    const first = await scanClaude();
    expect(first.entries).toHaveLength(2);

    // A shorter file cannot be a continuation of the one that was read.
    truncateSync(file, 0);
    writeFileSync(
      file,
      claudeLine({ at: now, model: 'test-model', input: 1, id: 'fresh' }),
      'utf-8',
    );
    vi.setSystemTime(now + 1_000);

    const second = await scanClaude(first.cache);

    expect(second.entries.map((entry) => entry.id)).toEqual(['fresh']);
  });

  it('drops events that fell past the retention horizon', async () => {
    writeClaudeLog('session.jsonl', [
      claudeLine({ at: now - 60 * 24 * HOUR_MS, model: 'test-model', input: 10, id: 'old' }),
      claudeLine({ at: now - HOUR_MS, model: 'test-model', input: 10, id: 'recent' }),
    ]);

    const result = await scanClaude({}, now - 31 * 24 * HOUR_MS);

    expect(result.entries.map((entry) => entry.id)).toEqual(['recent']);
    // The cache does not carry them either, or it would grow without bound.
    const cached = Object.values(result.cache)[0];
    expect(cached?.entries.map((entry) => entry.id)).toEqual(['recent']);
  });

  it('skips a file whose mtime is older than the horizon without reading it', async () => {
    writeClaudeLog('stale.jsonl', [
      claudeLine({ at: now, model: 'test-model', input: 10, id: 'in-stale-file' }),
    ]);

    // A horizon past the file's mtime excludes it before a single byte is read. The mtime comes
    // from the filesystem, so it follows the real clock rather than the faked one.
    const result = await scanClaude({}, vi.getRealSystemTime() + 24 * HOUR_MS);

    expect(result.entries).toEqual([]);
    expect(result.cache).toEqual({});
  });
});

describe('Codex logs', () => {
  it('splits cached tokens out of the input count', async () => {
    // Codex reports input_tokens with the cached ones already included, so adding both would
    // double-count them in the total.
    writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now - 2 * HOUR_MS),
      codexTokenCount({ at: now - HOUR_MS, input: 1_000, cached: 400, output: 50, reasoning: 25 }),
    ]);

    const result = await scanCodex();

    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'test-model',
        input: 600,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
      },
    ]);
  });

  it('does not add reasoning tokens to the output count, they are already inside it', async () => {
    // Codex logs total_tokens as input + output, with reasoning a share of the output.
    writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now - 2 * HOUR_MS),
      codexTokenCount({ at: now - HOUR_MS, input: 100, cached: 0, output: 80, reasoning: 60 }),
    ]);

    const [entry] = (await scanCodex()).entries;

    expect(entry.output).toBe(80);
    expect(entry.input + entry.cacheRead + entry.output).toBe(180);
  });

  it('applies the model from the turn context to the events that follow', async () => {
    writeCodexLog('rollout.jsonl', [
      codexTurnContext('first-model', now - 3 * HOUR_MS),
      codexTokenCount({ at: now - 3 * HOUR_MS, input: 10, output: 1 }),
      codexTurnContext('second-model', now - 2 * HOUR_MS),
      codexTokenCount({ at: now - HOUR_MS, input: 20, output: 2 }),
    ]);

    const result = await scanCodex();

    expect(result.entries.map((entry) => entry.model)).toEqual(['first-model', 'second-model']);
  });

  it('remembers the model across a resumed read', async () => {
    // The model line stays in the part already consumed, so without carry-over state the next
    // chunk's events would be attributed to the fallback model.
    const file = writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now - 3 * HOUR_MS),
      codexTokenCount({ at: now - 3 * HOUR_MS, input: 10, output: 1 }),
    ]);

    const first = await scanCodex();
    expect(first.cache[file]?.model).toBe('test-model');

    appendFileSync(file, codexTokenCount({ at: now - HOUR_MS, input: 20, output: 2 }));
    vi.setSystemTime(now + 1_000);

    const second = await scanCodex(first.cache);

    expect(second.entries.map((entry) => entry.model)).toEqual(['test-model', 'test-model']);
  });

  it('ignores a token count with nothing in it', async () => {
    writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now),
      codexTokenCount({ at: now }),
    ]);

    expect((await scanCodex()).entries).toEqual([]);
  });

  it('reports the newest quota window and its reset time', async () => {
    const resetsAt = Math.floor((now + 4 * HOUR_MS) / 1000);
    writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now - 3 * HOUR_MS),
      codexTokenCount({ at: now - 3 * HOUR_MS, input: 10, output: 1, usedPercent: 12.4 }),
      codexTokenCount({ at: now - HOUR_MS, input: 10, output: 1, usedPercent: 63.7, resetsAt }),
    ]);

    const result = await scanCodex();

    expect(result.window).toMatchObject({
      label: 'Quota',
      used: 64,
      total: 100,
      percent: 63.7,
      resetAt: new Date(resetsAt * 1000).toISOString(),
      at: now - HOUR_MS,
    });
  });

  it('keeps a percentage inside 0 to 100 and allows a missing reset time', async () => {
    writeCodexLog('rollout.jsonl', [
      codexTokenCount({ at: now, input: 10, output: 1, usedPercent: 140 }),
    ]);

    const result = await scanCodex();

    expect(result.window?.percent).toBe(100);
    expect(result.window?.resetAt).toBeNull();
  });

  it('prefers the newest window across several session files', async () => {
    writeCodexLog('older.jsonl', [
      codexTokenCount({ at: now - 5 * HOUR_MS, input: 10, output: 1, usedPercent: 10 }),
    ]);
    writeCodexLog('newer.jsonl', [
      codexTokenCount({ at: now - HOUR_MS, input: 10, output: 1, usedPercent: 80 }),
    ]);

    const result = await scanCodex();

    expect(result.window?.percent).toBe(80);
  });

  it('keeps both the session and the weekly limit, and the plan they belong to', async () => {
    const sessionReset = Math.floor((now + 2 * HOUR_MS) / 1000);
    const weekReset = Math.floor((now + 50 * HOUR_MS) / 1000);
    writeCodexLog('rollout.jsonl', [
      codexTokenCount({
        at: now - HOUR_MS,
        input: 10,
        output: 1,
        rateLimits: {
          primary: { used_percent: 22, window_minutes: 300, resets_at: sessionReset },
          secondary: { used_percent: 140, window_minutes: 10080, resets_at: weekReset },
          plan_type: 'plus',
        },
      }),
    ]);

    const result = await scanCodex();

    expect(result.limits).toEqual({
      windows: [
        { minutes: 300, percent: 22, resetAt: new Date(sessionReset * 1000).toISOString() },
        { minutes: 10080, percent: 100, resetAt: new Date(weekReset * 1000).toISOString() },
      ],
      planType: 'plus',
      at: now - HOUR_MS,
    });
  });

  it('reads a free plan with a single 30-day limit and no second window', async () => {
    writeCodexLog('rollout.jsonl', [
      codexTokenCount({
        at: now,
        input: 10,
        output: 1,
        rateLimits: {
          primary: { used_percent: 21, window_minutes: 43200 },
          secondary: null,
          plan_type: 'free',
        },
      }),
    ]);

    const result = await scanCodex();

    expect(result.limits?.windows).toEqual([{ minutes: 43200, percent: 21, resetAt: null }]);
    expect(result.limits?.planType).toBe('free');
  });

  it('takes the limits from the newest snapshot across several session files', async () => {
    writeCodexLog('older.jsonl', [
      codexTokenCount({ at: now - 5 * HOUR_MS, input: 10, output: 1, usedPercent: 10 }),
    ]);
    writeCodexLog('newer.jsonl', [
      codexTokenCount({ at: now - HOUR_MS, input: 10, output: 1, usedPercent: 80 }),
    ]);

    const result = await scanCodex();

    expect(result.limits?.windows.map((w) => w.percent)).toEqual([80]);
    expect(result.limits?.planType).toBeNull();
  });

  it('reports no limits when the logs carry none, as with an API key login', async () => {
    writeCodexLog('rollout.jsonl', [codexTokenCount({ at: now, input: 10, output: 1 })]);

    expect((await scanCodex()).limits).toBeUndefined();
  });
});

describe('Copilot logs', () => {
  it('reads usage records with the model that served them', async () => {
    writeCopilotLog('ses-1', [
      copilotStart(now - 2 * HOUR_MS, 'E:\\work\\shop'),
      copilotUsage({ at: now - HOUR_MS, input: 100, output: 20, cacheRead: 5, id: 'evt-1' }),
    ]);

    const result = await scanCopilot();

    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'gpt-6-luna',
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        id: 'evt-1',
      },
    ]);
  });

  it('attributes entries to the folder the session ran in', async () => {
    writeCopilotLog('ses-1', [
      copilotStart(now - 2 * HOUR_MS, 'E:\\work\\shop'),
      copilotUsage({ at: now - HOUR_MS, input: 10, output: 1 }),
    ]);

    const result = await scanCopilot();

    expect(result.sources).toEqual([{ folder: 'E:\\work\\shop', count: 1 }]);
  });

  it('skips the tool-call chatter between usage records', async () => {
    writeCopilotLog('ses-1', [
      copilotStart(now - 2 * HOUR_MS, 'E:\\work\\shop'),
      '{"type":"tool.execution_start","id":"t1","timestamp":"2026-09-17T11:00:00.000Z","data":{}}\n',
      'not json at all\n',
      copilotUsage({ at: now - HOUR_MS, input: 10, output: 1 }),
    ]);

    const result = await scanCopilot();

    expect(result.entries).toHaveLength(1);
  });
});

describe('Gemini CLI logs', () => {
  // Today's CLI writes prompts and context but no token counts, so the parser
  // reads the Gemini API's own usageMetadata vocabulary whenever a record
  // carries one, and otherwise contributes nothing: the card stays at zero
  // until the CLI persists token usage.

  /** One chat file, as the CLI lays it out under `tmp/<hash>/chats/`. */
  function writeGeminiLog(hash: string, name: string, lines: string[]): string {
    const dir = join(root, 'gemini', 'tmp', hash, 'chats');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, lines.join(''), 'utf-8');
    return file;
  }

  function writeProjectRoot(hash: string, cwd: string): void {
    const dir = join(root, 'gemini', 'tmp', hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.project_root'), cwd, 'utf-8');
  }

  function geminiUsageLine(fields: {
    at: number;
    model?: string;
    prompt?: number;
    cached?: number;
    candidates?: number;
    thoughts?: number;
    id?: string;
  }): string {
    return `${JSON.stringify({
      timestamp: new Date(fields.at).toISOString(),
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.id ? { id: fields.id } : {}),
      usageMetadata: {
        promptTokenCount: fields.prompt ?? 0,
        cachedContentTokenCount: fields.cached ?? 0,
        candidatesTokenCount: fields.candidates ?? 0,
        ...(fields.thoughts === undefined ? {} : { thoughtsTokenCount: fields.thoughts }),
      },
    })}\n`;
  }

  /** A session file exactly as the CLI writes one today: meta + user batch, no tokens. */
  function geminiChatToday(id: string, at: number): string[] {
    return [
      `${JSON.stringify({ sessionId: id, startTime: new Date(at).toISOString(), kind: 'main' })}\n`,
      `${JSON.stringify({
        $set: {
          messages: [
            {
              id: 'm1',
              timestamp: new Date(at).toISOString(),
              type: 'user',
              content: [{ text: 'Fix it' }],
            },
          ],
        },
      })}\n`,
    ];
  }

  async function scanGemini(cache: ScanCache = {}, sinceMs = now - 7 * 24 * HOUR_MS) {
    return scanProviderLogs('gemini-cli', cache, sinceMs);
  }

  it('reads usageMetadata, splitting cached tokens out of the prompt count', async () => {
    // The prompt count already includes the cached ones, so adding both would
    // double-count them in the total.
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      geminiUsageLine({
        at: now - HOUR_MS,
        model: 'test-model',
        prompt: 1_000,
        cached: 400,
        candidates: 50,
        id: 'evt-1',
      }),
    ]);

    const result = await scanGemini();

    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'test-model',
        input: 600,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
        id: 'evt-1',
      },
    ]);
  });

  it('does not add thoughts tokens to the output count, they are already inside it', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      geminiUsageLine({
        at: now - HOUR_MS,
        model: 'test-model',
        prompt: 100,
        candidates: 80,
        thoughts: 60,
      }),
    ]);

    const [entry] = (await scanGemini()).entries;

    expect(entry?.output).toBe(80);
    expect((entry?.input ?? 0) + (entry?.cacheRead ?? 0) + (entry?.output ?? 0)).toBe(180);
  });

  it('reads a generic tokens object when there is no usageMetadata', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      `${JSON.stringify({
        timestamp: new Date(now - HOUR_MS).toISOString(),
        model: 'test-model',
        tokens: { inputTokens: 30, outputTokens: 7, cacheReadTokens: 3 },
      })}\n`,
    ]);

    const result = await scanGemini();

    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'test-model',
        input: 30,
        output: 7,
        cacheRead: 3,
        cacheWrite: 0,
      },
    ]);
  });

  it('prices an entry that never named a model at the Gemini fallback', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      geminiUsageLine({ at: now - HOUR_MS, prompt: 10, candidates: 2 }),
    ]);

    const [entry] = (await scanGemini()).entries;

    expect(entry?.model).toBe(GEMINI_LOG_FALLBACK_MODEL);
  });

  it('reads token-bearing messages inside a batched message list, once each', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      `${JSON.stringify({
        lastUpdated: new Date(now - HOUR_MS).toISOString(),
        $set: {
          messages: [
            { id: 'm1', type: 'user', content: [{ text: 'Fix it' }] },
            {
              id: 'm2',
              type: 'gemini',
              timestamp: new Date(now - HOUR_MS).toISOString(),
              model: 'test-model',
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
            },
          ],
        },
      })}\n`,
    ]);

    const result = await scanGemini();

    // The user message carries no payload, so only the assistant message lands.
    expect(result.entries).toEqual([
      {
        at: now - HOUR_MS,
        model: 'test-model',
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        id: 'm2',
      },
    ]);
  });

  it('contributes nothing for the files the CLI writes today: prompts, but no token counts', async () => {
    writeGeminiLog(
      'runova',
      'session-2026-09-17T10-00-a1.jsonl',
      geminiChatToday('a1', now - HOUR_MS),
    );
    writeProjectRoot('runova', 'E:\\work\\shop');

    const result = await scanGemini();

    expect(result.entries).toEqual([]);
    expect(result.cache).not.toEqual({});
  });

  it('ignores malformed JSON, unusable timestamps and empty usage blocks', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      '{ not json at all\n',
      `${JSON.stringify({ timestamp: 'not-a-date', usageMetadata: { promptTokenCount: 5 } })}\n`,
      geminiUsageLine({ at: now - HOUR_MS }),
      geminiUsageLine({ at: now - HOUR_MS, model: 'test-model', prompt: 1 }),
    ]);

    const result = await scanGemini();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.input).toBe(1);
  });

  it('attributes entries to the folder named by the hash sidecar', async () => {
    writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      geminiUsageLine({ at: now - HOUR_MS, model: 'test-model', prompt: 10, candidates: 1 }),
    ]);
    writeProjectRoot('runova', 'E:\\work\\shop');

    const result = await scanGemini();

    expect(result.sources).toEqual([{ folder: 'E:\\work\\shop', count: 1 }]);
  });

  it('still counts entries whose hash has no sidecar, just without a folder', async () => {
    writeGeminiLog('lonely', 'session-2026-09-17T10-00-b2.jsonl', [
      geminiUsageLine({ at: now - HOUR_MS, model: 'test-model', prompt: 10, candidates: 1 }),
    ]);

    const result = await scanGemini();

    expect(result.entries).toHaveLength(1);
    expect(result.sources).toEqual([{ folder: null, count: 1 }]);
  });

  it('resolves to nothing when the CLI was never installed', async () => {
    const result = await scanGemini();

    expect(result.entries).toEqual([]);
    expect(result.cache).toEqual({});
  });

  it('only parses the bytes appended since the last scan', async () => {
    const file = writeGeminiLog('runova', 'session-2026-09-17T10-00-a1.jsonl', [
      geminiUsageLine({ at: now - 2 * HOUR_MS, model: 'test-model', prompt: 10, id: 'a' }),
    ]);

    const first = await scanGemini();
    expect(first.entries).toHaveLength(1);

    appendFileSync(
      file,
      geminiUsageLine({ at: now - HOUR_MS, model: 'test-model', prompt: 20, id: 'b' }),
    );
    vi.setSystemTime(now + 1_000);

    const second = await scanGemini(first.cache);

    expect(second.entries.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

/**
 * One file at a time, which is what the per-conversation usage menu reads. These care about the
 * same resume bookkeeping as the provider scan, without a folder of logs around it.
 */
describe('scanLogFile', () => {
  const logFile = (path: string): LogFile => {
    const info = statSync(path);
    return { path, mtimeMs: info.mtimeMs, size: info.size };
  };

  const claude = (path: string, prev?: FileScanState) =>
    scanLogFile('claude-code', logFile(path), prev);

  it('reads a file it has not seen from the first line to the last', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now, model: 'm', id: 'a', input: 10 }),
      claudeLine({ at: now, model: 'm', id: 'b', output: 5 }),
    ]);

    const state = await claude(path);

    expect(state?.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(state?.offset).toBe(statSync(path).size);
  });

  it('hands back the very same state for a file that did not change, reading nothing', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now, model: 'm', id: 'a', input: 10 }),
    ]);
    const first = await claude(path);

    const second = await claude(path, first ?? undefined);

    expect(second).toBe(first);
  });

  it('reads only what was appended, and keeps what it already had', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now, model: 'm', id: 'a', input: 10 }),
    ]);
    const first = await claude(path);
    const firstOffset = first?.offset ?? 0;

    appendFileSync(path, claudeLine({ at: now, model: 'm', id: 'b', input: 20 }), 'utf-8');
    const second = await claude(path, first ?? undefined);

    expect(second?.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(second?.offset).toBe(statSync(path).size);
    expect(second?.offset).toBeGreaterThan(firstOffset);
  });

  it('does not read the earlier bytes again when a file only grew', async () => {
    const line = (input: number) => claudeLine({ at: now, model: 'm', id: 'a', input });
    const path = writeClaudeLog('a.jsonl', [line(10)]);
    const first = await claude(path);

    // Same length, other content: a full re-read would now see 99, a resumed one cannot.
    writeFileSync(path, line(99), 'utf-8');
    appendFileSync(path, claudeLine({ at: now, model: 'm', id: 'b', input: 20 }), 'utf-8');
    const second = await claude(path, first ?? undefined);

    expect(second?.entries.map((e) => [e.id, e.input])).toEqual([
      ['a', 10],
      ['b', 20],
    ]);
  });

  it('leaves a half-written last line for the next read instead of dropping it', async () => {
    const whole = claudeLine({ at: now, model: 'm', id: 'a', input: 10 });
    const next = claudeLine({ at: now, model: 'm', id: 'b', input: 20 });
    const path = writeClaudeLog('a.jsonl', [whole, next.slice(0, 30)]);

    const partial = await claude(path);
    expect(partial?.entries.map((e) => e.id)).toEqual(['a']);
    // The offset stops at the end of the last complete line.
    expect(partial?.offset).toBe(Buffer.byteLength(whole));

    appendFileSync(path, next.slice(30), 'utf-8');
    const complete = await claude(path, partial ?? undefined);
    expect(complete?.entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('starts over when the file is now shorter than what it had read', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now, model: 'm', id: 'a', input: 10 }),
      claudeLine({ at: now, model: 'm', id: 'b', input: 20 }),
    ]);
    const first = await claude(path);
    writeFileSync(path, claudeLine({ at: now, model: 'm', id: 'c', input: 1 }), 'utf-8');

    const second = await claude(path, first ?? undefined);

    expect(second?.entries.map((e) => e.id)).toEqual(['c']);
  });

  it('carries the model Codex named earlier into a read that resumes after it', async () => {
    const path = writeCodexLog('rollout.jsonl', [
      codexTurnContext('test-model', now - HOUR_MS),
      codexTokenCount({ at: now, input: 100, output: 10 }),
    ]);
    const first = await scanLogFile('codex', logFile(path), undefined);

    appendFileSync(path, codexTokenCount({ at: now, input: 200, output: 20 }), 'utf-8');
    const second = await scanLogFile('codex', logFile(path), first ?? undefined);

    expect(second?.entries.map((e) => [e.model, e.input])).toEqual([
      ['test-model', 100],
      ['test-model', 200],
    ]);
  });

  it('is null for a file that cannot be read, so the caller can skip it', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now, model: 'm', id: 'a', input: 10 }),
    ]);
    const info = logFile(path);

    await expect(
      scanLogFile('claude-code', { ...info, path: join(root, 'claude', 'gone.jsonl') }, undefined),
    ).resolves.toBeNull();
  });

  it('keeps events of any age, since a conversation is read whole', async () => {
    const path = writeClaudeLog('a.jsonl', [
      claudeLine({ at: now - 400 * 24 * HOUR_MS, model: 'm', id: 'old', input: 10 }),
    ]);

    expect((await claude(path))?.entries.map((e) => e.id)).toEqual(['old']);
  });
});

describe('collectLogFiles', () => {
  it('finds transcripts in nested folders and skips anything else', async () => {
    const dir = join(root, 'claude', 'projects', 'demo');
    mkdirSync(join(dir, 'session', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), '{}\n');
    writeFileSync(join(dir, 'session', 'subagents', 'agent-1.jsonl'), '{}\n');
    writeFileSync(join(dir, 'notes.txt'), 'x');

    const files = await collectLogFiles(dir, 0);

    expect(files.map((f) => f.path.slice(dir.length + 1).replaceAll('\\', '/')).sort()).toEqual([
      'session.jsonl',
      'session/subagents/agent-1.jsonl',
    ]);
  });

  it('skips files older than the cutoff, and a folder that does not exist', async () => {
    const dir = join(root, 'claude', 'projects', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl'), '{}\n');

    // Far in the future, since this file runs on a fake clock and the file's mtime is real.
    expect(await collectLogFiles(dir, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await collectLogFiles(join(root, 'nope'), 0)).toEqual([]);
  });
});
