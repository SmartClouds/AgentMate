import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelPrice, MODEL_PRICES, type UsageTokens } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionUsage } from '../../shared/apiTypes';
import { tempDir } from '../../test/main/fixtures';
import { clearHistorySources, rememberHistorySource } from './historySources';
import type { HistoryFs } from './sessionHistory';
import { clearSessionUsageCaches, readSessionUsage, summarizeUsage } from './sessionUsage';

/**
 * The tokens and cost behind the history list's right-click menu. The transcripts are written to
 * a temp folder and registered the way the history listing registers them, because the module
 * only ever opens a file the list showed it.
 *
 * Prices come from the catalog, so the expected cost is worked out from `getModelPrice` instead
 * of a number typed in here.
 */

const PRICED = Object.keys(MODEL_PRICES)[0];
const UNPRICED = 'a-model-nobody-has-priced';
const SESSION = '0a1b2c3d-0000-4000-8000-000000000001';

let root = '';

function costOf(model: string, tokens: Omit<UsageTokens, 'total'>): number {
  const price = getModelPrice(model);
  if (!price) throw new Error(`${model} has no price`);
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

function claudeLine(fields: {
  model: string;
  id?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-17T10:00:00.000Z',
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

function codexTurnContext(model: string): string {
  return `${JSON.stringify({
    timestamp: '2026-09-17T10:00:00.000Z',
    type: 'turn_context',
    payload: { type: 'turn_context', model },
  })}\n`;
}

function codexTokenCount(fields: {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}) {
  return `${JSON.stringify({
    timestamp: '2026-09-17T10:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: fields.input,
          cached_input_tokens: fields.cached,
          output_tokens: fields.output,
          reasoning_output_tokens: fields.reasoning,
        },
      },
    },
  })}\n`;
}

/** Writes a Claude transcript and registers it as the list would. Returns its path. */
function claudeTranscript(lines: string[], id = SESSION): string {
  const dir = join(root, 'projects', 'demo');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.join(''), 'utf-8');
  rememberHistorySource('claude-code', id, { path, mtimeMs: 1 });
  return path;
}

function ok(usage: AgentSessionUsage): Extract<AgentSessionUsage, { status: 'ok' }> {
  if (usage.status !== 'ok') throw new Error(`expected usage, got ${usage.status}`);
  return usage;
}

beforeEach(() => {
  root = tempDir('agentmate-session-usage-');
});

afterEach(() => {
  clearHistorySources();
  clearSessionUsageCaches();
});

describe('summarizeUsage', () => {
  const base = { at: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  it('counts a message id once, however many lines carry it', () => {
    const usage = ok(
      summarizeUsage([
        { ...base, model: PRICED, id: 'msg_1', input: 10, output: 5 },
        { ...base, model: PRICED, id: 'msg_1', input: 10, output: 5 },
        { ...base, model: PRICED, id: 'msg_2', input: 1, cacheRead: 100 },
        // No id (Codex): every event is its own turn.
        { ...base, model: PRICED, input: 2 },
        { ...base, model: PRICED, input: 2 },
      ]),
    );
    expect(usage.tokens).toEqual({
      input: 15,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      total: 120,
    });
  });

  it('leaves out placeholder messages that carry no tokens', () => {
    const usage = ok(
      summarizeUsage([
        { ...base, model: '<synthetic>', id: 'msg_s' },
        { ...base, model: PRICED, id: 'msg_1', output: 4 },
      ]),
    );
    expect(usage.tokens.total).toBe(4);
    expect(usage.costPartial).toBe(false);
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 0, output: 4, cacheRead: 0, cacheWrite: 0 }),
    );
  });

  it('prices each model on its own tokens', () => {
    const usage = ok(
      summarizeUsage([
        {
          ...base,
          model: PRICED,
          id: 'a',
          input: 1000,
          output: 2000,
          cacheRead: 3000,
          cacheWrite: 400,
        },
        { ...base, model: PRICED, id: 'b', input: 10 },
      ]),
    );
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 1010, output: 2000, cacheRead: 3000, cacheWrite: 400 }),
    );
    expect(usage.costPartial).toBe(false);
  });

  it('lists each model with its own tokens and cost, the busiest first', () => {
    const [second] = Object.keys(MODEL_PRICES).filter((key) => key !== PRICED);
    const usage = ok(
      summarizeUsage([
        { ...base, model: PRICED, id: 'a', input: 100 },
        { ...base, model: second, id: 'b', input: 5000 },
        { ...base, model: UNPRICED, id: 'c', input: 20 },
      ]),
    );
    expect(usage.models.map((m) => m.model)).toEqual([second, PRICED, UNPRICED]);
    expect(usage.models[1].tokens.total).toBe(100);
    expect(usage.models[1].costUsd).toBeCloseTo(
      costOf(PRICED, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }),
    );
    expect(usage.models[2].costUsd).toBeNull();
  });

  it('marks the cost partial when only some of the tokens ran on a priced model', () => {
    const usage = ok(
      summarizeUsage([
        { ...base, model: PRICED, id: 'a', input: 1000 },
        { ...base, model: UNPRICED, id: 'b', input: 5000 },
      ]),
    );
    expect(usage.tokens.total).toBe(6000);
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }),
    );
    expect(usage.costPartial).toBe(true);
  });

  it('has no cost at all when no model in the run is priced', () => {
    const usage = ok(summarizeUsage([{ ...base, model: UNPRICED, id: 'a', input: 5000 }]));
    expect(usage.costUsd).toBeNull();
    expect(usage.costPartial).toBe(false);
  });

  it('reports an empty conversation as zero tokens', () => {
    expect(ok(summarizeUsage([])).tokens.total).toBe(0);
  });
});

describe('readSessionUsage, Claude Code transcripts', () => {
  it('adds up the conversation and the subagents it started, counting each message once', async () => {
    const path = claudeTranscript([
      claudeLine({ model: PRICED, id: 'msg_a', input: 10, output: 20 }),
      // The same message again, as Claude Code logs one line per content block.
      claudeLine({ model: PRICED, id: 'msg_a', input: 10, output: 20 }),
      claudeLine({ model: PRICED, id: 'msg_b', cacheRead: 500, cacheWrite: 50 }),
    ]);
    const subagents = join(path.slice(0, -'.jsonl'.length), 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-1.jsonl'),
      claudeLine({ model: PRICED, id: 'msg_c', input: 1, output: 2 }),
      'utf-8',
    );

    const usage = ok(await readSessionUsage('claude-code', SESSION));
    expect(usage.tokens).toEqual({
      input: 11,
      output: 22,
      cacheRead: 500,
      cacheWrite: 50,
      total: 583,
    });
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 11, output: 22, cacheRead: 500, cacheWrite: 50 }),
    );
  });

  it('reads OpenClaude transcripts the same way', async () => {
    const dir = join(root, 'openclaude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, claudeLine({ model: PRICED, id: 'msg_a', input: 7 }), 'utf-8');
    rememberHistorySource('openclaude', SESSION, { path, mtimeMs: 1 });

    expect(ok(await readSessionUsage('openclaude', SESSION)).tokens.input).toBe(7);
  });

  it('picks up what was appended since the last look, without counting the rest twice', async () => {
    const path = claudeTranscript([claudeLine({ model: PRICED, id: 'msg_a', input: 10 })]);
    expect(ok(await readSessionUsage('claude-code', SESSION)).tokens.input).toBe(10);

    appendFileSync(path, claudeLine({ model: PRICED, id: 'msg_b', input: 5 }), 'utf-8');
    expect(ok(await readSessionUsage('claude-code', SESSION)).tokens.input).toBe(15);
    // Nothing new: asking again changes nothing.
    expect(ok(await readSessionUsage('claude-code', SESSION)).tokens.input).toBe(15);
  });

  it('answers two simultaneous requests from one read', async () => {
    claudeTranscript([claudeLine({ model: PRICED, id: 'msg_a', input: 10 })]);
    const [first, second] = await Promise.all([
      readSessionUsage('claude-code', SESSION),
      readSessionUsage('claude-code', SESSION),
    ]);
    expect(ok(first).tokens.input).toBe(10);
    expect(second).toEqual(first);
  });

  it('is unavailable once the transcript is gone', async () => {
    const path = claudeTranscript([claudeLine({ model: PRICED, id: 'msg_a', input: 10 })]);
    rmSync(path);
    expect(await readSessionUsage('claude-code', SESSION)).toEqual({ status: 'unavailable' });
  });
});

describe('readSessionUsage, Codex rollouts', () => {
  it('sums the turns, with cached input as a cache read and reasoning inside the output', async () => {
    const dir = join(root, 'sessions');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-09-17T10-00-00-${SESSION}.jsonl`);
    writeFileSync(
      path,
      [
        codexTurnContext(PRICED),
        codexTokenCount({ input: 1000, cached: 400, output: 50, reasoning: 30 }),
        codexTokenCount({ input: 200, cached: 0, output: 10, reasoning: 0 }),
      ].join(''),
      'utf-8',
    );
    rememberHistorySource('codex', SESSION, { path, mtimeMs: 1 });

    const usage = ok(await readSessionUsage('codex', SESSION));
    // Codex counts cached tokens inside input, so they are split out of it. The 30 reasoning
    // tokens are part of the 50 output ones already.
    expect(usage.tokens).toEqual({
      input: 800,
      output: 60,
      cacheRead: 400,
      cacheWrite: 0,
      total: 1260,
    });
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 800, output: 60, cacheRead: 400, cacheWrite: 0 }),
    );
  });
});

describe('readSessionUsage, OpenCode sessions', () => {
  const dbPath = '/data/opencode.db';

  function fakeFs(queryDb: NonNullable<HistoryFs['queryDb']>): HistoryFs {
    return {
      scope: 'fake',
      caseInsensitive: false,
      join: (...parts) => parts.join('/'),
      home: async () => '/home/u',
      env: async () => undefined,
      list: async () => [],
      readRange: async () => '',
      queryDb,
    };
  }

  function listed(mtimeMs = 1): void {
    rememberHistorySource('opencode', 'ses_abc', { path: `${dbPath}#ses_abc`, mtimeMs, dbPath });
  }

  const row = {
    model: JSON.stringify({ id: PRICED, providerID: 'anthropic' }),
    cost: 0.42,
    tokens_input: 1000,
    tokens_output: 200,
    tokens_reasoning: 50,
    tokens_cache_read: 3000,
    tokens_cache_write: 100,
  };

  it('reads the totals off the session row, folding reasoning into output', async () => {
    const queryDb = vi.fn(async () => [row]);
    listed();
    const usage = ok(await readSessionUsage('opencode', 'ses_abc', fakeFs(queryDb)));
    expect(queryDb).toHaveBeenCalledWith(dbPath, expect.stringContaining('FROM session'), [
      'ses_abc',
    ]);
    expect(usage.tokens).toEqual({
      input: 1000,
      output: 250,
      cacheRead: 3000,
      cacheWrite: 100,
      total: 4350,
    });
    // OpenCode priced the run itself, and that figure wins.
    expect(usage.costUsd).toBe(0.42);
    expect(usage.models).toEqual([{ model: PRICED, tokens: usage.tokens, costUsd: 0.42 }]);
  });

  it('reads the totals off session_v2 on a database that has it', async () => {
    const queryDb = vi.fn(async (_dbPath: string, sql: string) =>
      sql.includes('sqlite_master') ? [{ name: 'session_v2' }, { name: 'session_message' }] : [row],
    );
    listed();
    const usage = ok(await readSessionUsage('opencode', 'ses_abc', fakeFs(queryDb)));
    expect(queryDb).toHaveBeenLastCalledWith(dbPath, expect.stringContaining('FROM session_v2'), [
      'ses_abc',
    ]);
    expect(usage.tokens.total).toBe(4350);
    expect(usage.costUsd).toBe(0.42);
  });

  it('names no model when the session row has none', async () => {
    listed();
    const usage = ok(
      await readSessionUsage(
        'opencode',
        'ses_abc',
        fakeFs(async () => [{ ...row, model: null }]),
      ),
    );
    expect(usage.models).toEqual([]);
  });

  it('falls back to the catalog price when OpenCode recorded no cost', async () => {
    listed();
    const usage = ok(
      await readSessionUsage(
        'opencode',
        'ses_abc',
        fakeFs(async () => [{ ...row, cost: 0 }]),
      ),
    );
    expect(usage.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 1000, output: 250, cacheRead: 3000, cacheWrite: 100 }),
    );
  });

  it('has no cost for an unpriced model with no recorded cost', async () => {
    listed();
    const unpriced = { ...row, cost: 0, model: UNPRICED };
    const usage = ok(
      await readSessionUsage(
        'opencode',
        'ses_abc',
        fakeFs(async () => [unpriced]),
      ),
    );
    expect(usage.costUsd).toBeNull();
  });

  it('asks the database again only after the session was updated', async () => {
    const queryDb = vi.fn(async () => [row]);
    const fs = fakeFs(queryDb);
    listed(1);
    await readSessionUsage('opencode', 'ses_abc', fs);
    await readSessionUsage('opencode', 'ses_abc', fs);
    // One read is a look at the schema and the session row.
    expect(queryDb).toHaveBeenCalledTimes(2);

    listed(2);
    await readSessionUsage('opencode', 'ses_abc', fs);
    expect(queryDb).toHaveBeenCalledTimes(4);
  });

  it('is unavailable on a database without the token columns, or without the session', async () => {
    listed();
    const old = fakeFs(async () => {
      throw new Error('no such column: tokens_input');
    });
    expect(await readSessionUsage('opencode', 'ses_abc', old)).toEqual({ status: 'unavailable' });

    clearSessionUsageCaches();
    expect(
      await readSessionUsage(
        'opencode',
        'ses_abc',
        fakeFs(async () => []),
      ),
    ).toEqual({
      status: 'unavailable',
    });
  });
});

describe('readSessionUsage, what it refuses', () => {
  it('says so for an agent that keeps no token counts', async () => {
    rememberHistorySource('gemini-cli', SESSION, { path: join(root, 'chat.json'), mtimeMs: 1 });
    expect(await readSessionUsage('gemini-cli', SESSION)).toEqual({ status: 'unsupported' });
    expect(await readSessionUsage('not-an-agent', SESSION)).toEqual({ status: 'unsupported' });
  });

  it('knows nothing of a conversation the history list never showed', async () => {
    expect(await readSessionUsage('claude-code', SESSION)).toEqual({ status: 'unavailable' });
  });

  it('turns away an id that could name a path', async () => {
    const path = claudeTranscript([claudeLine({ model: PRICED, id: 'msg_a', input: 10 })]);
    for (const id of ['../secret', 'a/b', 'a\\b', '', 'x'.repeat(200), 'two words']) {
      rememberHistorySource('claude-code', id, { path, mtimeMs: 1 });
      expect(await readSessionUsage('claude-code', id)).toEqual({ status: 'unavailable' });
    }
  });
});
