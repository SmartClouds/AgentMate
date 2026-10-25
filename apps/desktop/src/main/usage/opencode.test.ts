import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpencodeUsage,
  opencodeUsageModelId,
  scanOpencodeUsage,
  toOpencodeEntries,
} from './opencode';

/**
 * OpenCode's Token Usage card reads the CLI's SQLite session rows, one total
 * per conversation dated by its last update, and draws the same chart UI as a
 * Codex card: headline, day/week/month compare and the 14-day sparkline. The
 * tests pin the row-to-chart mapping, the cost preference (OpenCode's recorded
 * figure wins, the catalog estimate covers the rest) and the scan's empty and
 * failure states.
 */

const DAY_MS = 86_400_000;

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_a',
    directory: '/work/app',
    model: '{"id":"claude-opus-5-5","providerID":"anthropic"}',
    cost: 0,
    time_updated: Date.now(),
    tokens_input: 1000,
    tokens_output: 200,
    tokens_reasoning: 50,
    tokens_cache_read: 3000,
    tokens_cache_write: 7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('opencodeUsageModelId', () => {
  it('reads the id out of the JSON the session row stores', () => {
    expect(opencodeUsageModelId('{"id":"gpt-5","providerID":"openai"}')).toBe('gpt-5');
  });

  it('passes a bare model id through, and blanks to null', () => {
    expect(opencodeUsageModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(opencodeUsageModelId(null)).toBeNull();
    expect(opencodeUsageModelId('')).toBeNull();
    expect(opencodeUsageModelId('{}')).toBe('{}');
  });
});

describe('toOpencodeEntries', () => {
  it('turns one session row into one event dated by its last update', () => {
    const at = new Date(2026, 8, 17, 12).getTime();
    const entries = toOpencodeEntries([row({ time_updated: at })], 0);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      at,
      folder: '/work/app',
      model: 'claude-opus-5-5',
    });
    // Reasoning is billed as output, the way Codex counts it.
    expect(entries[0].tokens).toMatchObject({
      input: 1000,
      output: 250,
      cacheRead: 3000,
      cacheWrite: 7,
      total: 4257,
    });
  });

  it('counts a sub-session as an event of its own, on top of its parent', () => {
    const entries = toOpencodeEntries(
      [
        row({ id: 'parent', tokens_input: 1000, tokens_output: 0, tokens_reasoning: 0 }),
        row({ id: 'child', parent_id: 'parent', tokens_input: 400, tokens_output: 0 }),
      ],
      0,
    );

    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, e) => sum + e.tokens.input, 0)).toBe(1400);
  });

  it('takes the cost OpenCode recorded, else the catalog estimate', () => {
    const [paid] = toOpencodeEntries([row({ cost: 1.5 })], 0);
    expect(paid.cost).toBe(1.5);

    const [estimated] = toOpencodeEntries([row({ cost: 0 })], 0);
    expect(estimated.cost).toBeGreaterThan(0);

    const [unpriced] = toOpencodeEntries([row({ cost: 0, model: 'some-unpriced-model-xyz' })], 0);
    expect(unpriced.cost).toBeNull();
  });

  it('falls back to a priced model when the row names none', () => {
    const [entry] = toOpencodeEntries([row({ model: null })], 0);
    expect(entry.model).toBeTruthy();
    expect(entry.cost).toBeGreaterThan(0);
  });

  it('leaves out rows outside retention, without a time, or with nothing counted', () => {
    const now = Date.now();
    const entries = toOpencodeEntries(
      [
        row({ id: 'old', time_updated: now - 60 * DAY_MS }),
        row({ id: 'no-time', time_updated: null }),
        row({
          id: 'empty',
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost: 0,
        }),
        row({ id: 'bad', tokens_input: 'lots', tokens_output: -5, cost: 'free' }),
      ],
      now - 31 * DAY_MS,
    );

    // Only the 'bad' row survives: its negative and non-numeric counts read as
    // zero except for the reasoning share folded into output.
    expect(entries.map((e) => e.model)).toHaveLength(1);
    expect(entries[0].tokens.output).toBe(50);
  });

  it('ignores values that are not counts', () => {
    const [entry] = toOpencodeEntries(
      [row({ tokens_input: 'lots', tokens_output: -5, tokens_cache_read: null })],
      0,
    );
    expect(entry.tokens).toMatchObject({ input: 0, output: 50, cacheRead: 0 });
  });

  it('reads a missing folder as null', () => {
    const [entry] = toOpencodeEntries([row({ directory: null })], 0);
    expect(entry.folder).toBeNull();
  });
});

describe('buildOpencodeUsage', () => {
  it('buckets sessions into today, week and month by their last update', () => {
    vi.useFakeTimers();
    try {
      const noon = new Date(2026, 9, 5, 12, 0, 0).getTime();
      vi.setSystemTime(noon);
      const usage = buildOpencodeUsage(
        toOpencodeEntries(
          [
            row({ id: 'today', time_updated: noon - 60_000, tokens_input: 1000, cost: 1 }),
            row({
              id: 'week',
              time_updated: noon - 3 * DAY_MS,
              tokens_input: 2000,
              cost: 2,
            }),
            row({
              id: 'month',
              time_updated: noon - 20 * DAY_MS,
              tokens_input: 4000,
              cost: 4,
            }),
          ],
          0,
        ),
      );

      expect(usage.providerId).toBe('opencode');
      expect(usage.status).toBe('ok');
      expect(usage.today.tokens.input).toBe(1000);
      expect(usage.today.costUsd).toBeCloseTo(1);
      expect(usage.last7d.tokens.input).toBe(3000);
      expect(usage.last7d.costUsd).toBeCloseTo(3);
      expect(usage.last30d.tokens.input).toBe(7000);
      expect(usage.last30d.costUsd).toBeCloseTo(7);
      expect(usage.currency).toBe('USD');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws the 14-day token and cost sparklines from the same events as the headline', () => {
    vi.useFakeTimers();
    try {
      const noon = new Date(2026, 9, 5, 12, 0, 0).getTime();
      vi.setSystemTime(noon);
      const usage = buildOpencodeUsage(
        toOpencodeEntries(
          [
            row({ id: 'a', time_updated: noon - 60_000, tokens_input: 100, cost: 0.1 }),
            row({
              id: 'b',
              time_updated: noon - 2 * DAY_MS,
              tokens_input: 300,
              cost: 0.3,
            }),
          ],
          0,
        ),
      );

      expect(usage.series).toHaveLength(14);
      expect(usage.costSeries).toHaveLength(14);
      // Newest bucket holds today's session, an older bucket the one from 2 days ago.
      expect(usage.series?.[13]).toBeGreaterThan(0);
      expect(usage.series?.[11]).toBeGreaterThan(0);
      expect(usage.series?.[10] ?? 0).toBe(0);
      const tokenSum = (usage.series ?? []).reduce((a, b) => a + b, 0);
      expect(tokenSum).toBe(usage.last30d.tokens.total);
      const costSum = (usage.costSeries ?? []).reduce((a, b) => a + b, 0);
      expect(costSum).toBeCloseTo(usage.last30d.costUsd ?? 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the project split the scan built, for the weekday chart', () => {
    const usage = buildOpencodeUsage([], {
      endDay: '2026-10-05',
      projects: [],
    });
    expect(usage.projectDaily?.endDay).toBe('2026-10-05');
  });

  it('has no cost when no session could be priced', () => {
    const usage = buildOpencodeUsage(
      toOpencodeEntries([row({ cost: 0, model: 'some-unpriced-model-xyz' })], 0),
    );
    expect(usage.today.costUsd).toBeNull();
  });
});

describe('scanOpencodeUsage', () => {
  const DB = '/home/me/.local/share/opencode/opencode.db';

  function deps(overrides: Partial<Parameters<typeof scanOpencodeUsage>[0]> = {}) {
    return {
      sinceMs: 0,
      now: new Date(2026, 9, 5, 12).getTime(),
      findDb: async () => DB,
      queryDb: async () => [row()],
      knownProjects: async () => ({ projects: [], worktrees: [] }),
      ...overrides,
    };
  }

  // What sqlite_master says for an OpenCode 2.x database; the sessions query gets one row.
  const v2Db = async (_dbPath: string, sql: string, _params: unknown[]) =>
    sql.includes('sqlite_master') ? [{ name: 'session_v2' }, { name: 'session_message' }] : [row()];

  it('checks which tables the database has, then asks for sessions since retention', async () => {
    const queryDb = vi.fn(async (_dbPath: string, _sql: string, _params: unknown[]) => [row()]);
    const usage = await scanOpencodeUsage(deps({ sinceMs: 12345, queryDb }));

    expect(queryDb).toHaveBeenCalledTimes(2);
    expect(queryDb.mock.calls[0][1]).toContain('sqlite_master');
    expect(queryDb.mock.calls[1][0]).toBe(DB);
    expect(queryDb.mock.calls[1][1]).toContain('FROM session WHERE');
    expect(queryDb.mock.calls[1][2]).toEqual([12345]);
    expect(usage.status).toBe('ok');
    expect(usage.today.tokens.total).toBeGreaterThan(0);
  });

  it('reads sessions from session_v2 on a database that has it', async () => {
    const queryDb = vi.fn(v2Db);
    const usage = await scanOpencodeUsage(deps({ sinceMs: 12345, queryDb }));

    expect(queryDb).toHaveBeenCalledTimes(2);
    expect(queryDb.mock.calls[1][1]).toContain('FROM session_v2 WHERE');
    expect(queryDb.mock.calls[1][2]).toEqual([12345]);
    expect(usage.today.tokens.total).toBeGreaterThan(0);
  });

  it('splits tokens by folder so the weekday chart can draw them', async () => {
    const now = new Date(2026, 9, 5, 12).getTime();
    const usage = await scanOpencodeUsage(
      deps({
        now,
        queryDb: async () => [row({ directory: '/work/app', time_updated: now - 60_000 })],
        knownProjects: async () => ({
          projects: [{ id: 'p1', name: 'App', folderPath: '/work/app' }],
          worktrees: [],
        }),
      }),
    );

    expect(usage.projectDaily?.projects.map((p) => p.name)).toContain('App');
  });

  it('draws empty zeros on a machine without OpenCode, like a fresh Codex install', async () => {
    const queryDb = vi.fn(async () => []);
    const usage = await scanOpencodeUsage(deps({ findDb: async () => null, queryDb }));

    expect(queryDb).not.toHaveBeenCalled();
    expect(usage.status).toBe('ok');
    expect(usage.today.tokens.total).toBe(0);
    expect(usage.today.costUsd).toBeNull();
    expect(usage.series).toHaveLength(14);
  });

  it('still names the folders when the project list cannot be read', async () => {
    const now = new Date(2026, 9, 5, 12).getTime();
    const usage = await scanOpencodeUsage(
      deps({
        now,
        queryDb: async () => [row({ directory: '/work/side', time_updated: now - 60_000 })],
        knownProjects: async () => {
          throw new Error('store unavailable');
        },
      }),
    );

    expect(usage.status).toBe('ok');
    expect(usage.last30d.tokens.total).toBeGreaterThan(0);
    expect(usage.projectDaily?.projects.map((p) => p.name)).toContain('side');
  });

  it('throws when the database cannot be read, so the page shows the card error', async () => {
    await expect(
      scanOpencodeUsage(
        deps({
          queryDb: async () => {
            throw new Error('no such column: tokens_input');
          },
        }),
      ),
    ).rejects.toThrow('no such column');
  });
});
