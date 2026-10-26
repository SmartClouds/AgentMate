import { dirname, join } from 'node:path';
import {
  type AgentHistoryProvider,
  type AgentHistorySession,
  getModelPrice,
  MODEL_PRICES,
} from '@runova/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileScanState } from '../usage/logParsers';
import type { HistorySource } from './historySources';
import type { OpencodeProject } from './projectOpencode';
import {
  clearProjectUsageCaches,
  PROJECT_LISTED_PROVIDERS,
  PROJECT_SESSION_LIMIT,
  type ProjectUsageDeps,
  periodStart,
  readProjectUsage,
} from './projectUsage';
import { conversationKey, type RecordedUsage } from './projectUsageReport';
import type { ScanInput, ScanOutput } from './projectUsageScan';

/**
 * The part of the project usage report that gathers the work: which conversations to read, what
 * goes to the worker and what stays behind. The listing, the worker and the database are stand-ins
 * here; what they would return is covered by their own tests.
 */

const PRICED = Object.keys(MODEL_PRICES)[0];
const NOW = new Date(2026, 8, 20, 15).getTime();
const day = (d: number, hour = 10): number => new Date(2026, 8, d, hour).getTime();

function session(
  provider: AgentHistoryProvider,
  id: string,
  overrides: Partial<AgentHistorySession> = {},
): AgentHistorySession {
  return {
    provider,
    id,
    title: `Chat ${id}`,
    firstPrompt: null,
    lastPrompt: null,
    cwd: null,
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: day(1),
    updatedAt: day(19),
    sizeBytes: 1,
    background: false,
    ...overrides,
  };
}

const emptyScan = async (): Promise<ScanOutput> => ({ buckets: [], cache: {}, unreadable: [] });

function deps(overrides: Partial<ProjectUsageDeps> = {}): ProjectUsageDeps {
  return {
    list: vi.fn(async () => []),
    source: (provider, id): HistorySource => ({
      path: join('logs', provider, `${id}.jsonl`),
      mtimeMs: 1,
    }),
    scan: vi.fn(emptyScan),
    opencode: vi.fn(async () => ({ conversations: [], rows: [], unreadable: 0 })),
    now: () => NOW,
    ...overrides,
  };
}

const lastScan = (d: ProjectUsageDeps): ScanInput => {
  const calls = vi.mocked(d.scan).mock.calls;
  return calls[calls.length - 1][0];
};

afterEach(() => clearProjectUsageCaches());

describe('periodStart', () => {
  it('starts at midnight of the first of the last N calendar days, today included', () => {
    expect(periodStart(NOW, 7)).toBe(new Date(2026, 8, 14, 0, 0, 0, 0).getTime());
    expect(periodStart(NOW, 1)).toBe(new Date(2026, 8, 20, 0, 0, 0, 0).getTime());
  });

  it('reads everything when there is no period', () => {
    expect(periodStart(NOW, null)).toBe(0);
  });
});

describe('readProjectUsage jobs', () => {
  it('sends Claude Code, OpenClaude and Codex transcripts to the worker with their start times', async () => {
    const d = deps({
      list: vi.fn(async () => [
        session('codex', 'cx', { startedAt: day(5) }),
        session('claude-code', 'cc', { startedAt: day(2) }),
        session('openclaude', 'oc', { startedAt: null, updatedAt: day(3) }),
      ]),
    });

    await readProjectUsage(['/proj'], null, d);

    const { jobs } = lastScan(d);
    expect(jobs.map((j) => [j.key, j.parser, j.order])).toEqual([
      [conversationKey('codex', 'cx'), 'codex', day(5)],
      [conversationKey('claude-code', 'cc'), 'claude-code', day(2)],
      [conversationKey('openclaude', 'oc'), 'claude-code', day(3)],
    ]);
  });

  it('points Claude style jobs at their subagent folder and Codex at none', async () => {
    const d = deps({
      list: vi.fn(async () => [session('claude-code', 'cc'), session('codex', 'cx')]),
    });

    await readProjectUsage(['/proj'], null, d);

    const jobs = lastScan(d).jobs;
    const claude = jobs.find((j) => j.parser === 'claude-code');
    const path = join('logs', 'claude-code', 'cc.jsonl');
    expect(claude).toMatchObject({ path, subagentDir: join(dirname(path), 'cc') });
    expect(jobs.find((j) => j.parser === 'codex')?.subagentDir).toBeUndefined();
  });

  it('reads the project folder and each worktree, once per conversation', async () => {
    const list = vi.fn(async (folder: string) =>
      folder === '/proj'
        ? [session('claude-code', 'main-1'), session('claude-code', 'both')]
        : [session('claude-code', 'wt-1'), session('claude-code', 'both')],
    );
    const d = deps({ list });

    const report = await readProjectUsage(['/proj', '/proj-wt'], null, d);

    expect(list).toHaveBeenCalledWith('/proj', PROJECT_SESSION_LIMIT, PROJECT_LISTED_PROVIDERS);
    expect(list).toHaveBeenCalledWith('/proj-wt', PROJECT_SESSION_LIMIT, PROJECT_LISTED_PROVIDERS);
    expect(
      lastScan(d)
        .jobs.map((j) => j.key)
        .sort(),
    ).toEqual(['both', 'main-1', 'wt-1'].map((id) => conversationKey('claude-code', id)).sort());
    expect(report).toMatchObject({ status: 'ok', folders: 2 });
  });

  it('hands the worker the period start, and the cache from the last look', async () => {
    const kept: FileScanState = { offset: 5, mtimeMs: 1, size: 5, entries: [] };
    const scan = vi.fn(
      async (_input: ScanInput): Promise<ScanOutput> => ({
        buckets: [],
        cache: { '/a.jsonl': kept },
        unreadable: [],
      }),
    );
    const d = deps({ list: vi.fn(async () => [session('claude-code', 'cc')]), scan });

    await readProjectUsage(['/proj'], 7, d);
    await readProjectUsage(['/proj'], 30, d);

    expect(scan.mock.calls[0][0].sinceMs).toBe(periodStart(NOW, 7));
    expect(scan.mock.calls[0][0].cache).toEqual({});
    expect(scan.mock.calls[1][0].sinceMs).toBe(periodStart(NOW, 30));
    expect(scan.mock.calls[1][0].cache).toEqual({ '/a.jsonl': kept });
  });

  it('does not start a worker when there is nothing to parse', async () => {
    const d = deps({ list: vi.fn(async () => [session('gemini-cli', 'g')]) });

    await readProjectUsage(['/proj'], null, d);

    expect(d.scan).not.toHaveBeenCalled();
  });

  it('shares one read between identical requests made at the same time', async () => {
    const d = deps({ list: vi.fn(async () => [session('claude-code', 'cc')]) });

    const [a, b] = await Promise.all([
      readProjectUsage(['/proj'], null, d),
      readProjectUsage(['/proj'], null, d),
    ]);

    expect(d.scan).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('fails the request, and allows a retry, when the worker fails', async () => {
    const scan = vi
      .fn<(input: ScanInput) => Promise<ScanOutput>>()
      .mockRejectedValueOnce(new Error('usage scan timed out'))
      .mockImplementation(emptyScan);
    const d = deps({ list: vi.fn(async () => [session('claude-code', 'cc')]), scan });

    await expect(readProjectUsage(['/proj'], null, d)).rejects.toThrow('timed out');
    await expect(readProjectUsage(['/proj'], null, d)).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('readProjectUsage report', () => {
  it('prices what the worker found', async () => {
    const key = conversationKey('claude-code', 'cc');
    const d = deps({
      list: vi.fn(async () => [session('claude-code', 'cc', { title: 'Billing' })]),
      scan: vi.fn(async () => ({
        buckets: [
          {
            key,
            day: '2026-09-19',
            model: PRICED,
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
        cache: {},
        unreadable: [],
      })),
    });

    const report = await readProjectUsage(['/proj'], null, d);

    const price = getModelPrice(PRICED);
    expect(report).toMatchObject({
      status: 'ok',
      conversations: 1,
      top: [{ id: 'cc', title: 'Billing' }],
    });
    if (report.status === 'ok') expect(report.costUsd).toBeCloseTo(price?.input ?? NaN, 10);
  });

  it('counts conversations of agents that keep no token log, but only inside the period', async () => {
    const d = deps({
      list: vi.fn(async () => [
        session('gemini-cli', 'g1', { updatedAt: day(19) }),
        session('gemini-cli', 'g2', { updatedAt: day(18) }),
        session('gemini-cli', 'g3', { updatedAt: day(1) }),
        session('cursor-cli', 'c1', { updatedAt: day(19) }),
      ]),
    });

    const all = await readProjectUsage(['/proj'], null, d);
    const week = await readProjectUsage(['/proj'], 7, d);

    expect(all).toMatchObject({
      uncounted: expect.arrayContaining([
        { provider: 'gemini-cli', conversations: 3 },
        { provider: 'cursor-cli', conversations: 1 },
      ]),
    });
    expect(week).toMatchObject({
      uncounted: expect.arrayContaining([{ provider: 'gemini-cli', conversations: 2 }]),
    });
  });

  it('says so when the project has more conversations than were read', async () => {
    const full = Array.from({ length: PROJECT_SESSION_LIMIT }, (_, i) =>
      session('gemini-cli', `g${i}`),
    );
    const d = deps({ list: vi.fn(async () => full) });

    const report = await readProjectUsage(['/proj'], null, d);

    expect(report).toMatchObject({ truncated: true });
  });

  it('counts the transcripts it could not find or read', async () => {
    const missing = conversationKey('claude-code', 'cc-2');
    const d = deps({
      list: vi.fn(async () => [
        session('claude-code', 'cc-1'),
        session('claude-code', 'cc-2'),
        session('codex', 'unlisted'),
      ]),
      // The listing did not register one of them.
      source: (_provider, id) =>
        id === 'unlisted' ? undefined : { path: join('logs', `${id}.jsonl`), mtimeMs: 1 },
      scan: vi.fn(async () => ({ buckets: [], cache: {}, unreadable: [missing] })),
    });

    const report = await readProjectUsage(['/proj'], null, d);

    expect(report).toMatchObject({ unreadable: 2 });
  });
});

describe('readProjectUsage with OpenCode', () => {
  const recorded = (id: string, overrides: Partial<RecordedUsage> = {}): RecordedUsage => ({
    key: conversationKey('opencode', id),
    day: '2026-09-19',
    model: PRICED,
    input: 1000,
    output: 250,
    cacheRead: 3000,
    cacheWrite: 0,
    recordedCostUsd: null,
    ...overrides,
  });

  const opencodeReturning = (read: Partial<OpencodeProject>) =>
    vi.fn(
      async (_folders: readonly string[], _sinceMs: number): Promise<OpencodeProject> => ({
        conversations: [],
        rows: [],
        unreadable: 0,
        ...read,
      }),
    );

  it('leaves OpenCode out of the history listing, which asks its database twice per session', async () => {
    const d = deps();

    await readProjectUsage(['/proj'], null, d);

    expect(PROJECT_LISTED_PROVIDERS).not.toContain('opencode');
    expect(PROJECT_LISTED_PROVIDERS).toEqual(
      expect.arrayContaining(['claude-code', 'openclaude', 'codex', 'gemini-cli', 'cursor-cli']),
    );
  });

  it('asks for the project folder and each worktree at once, from the period start', async () => {
    const opencode = opencodeReturning({});
    const d = deps({ opencode });

    await readProjectUsage(['/proj', '/proj-wt'], 7, d);

    expect(opencode).toHaveBeenCalledTimes(1);
    expect(opencode).toHaveBeenCalledWith(['/proj', '/proj-wt'], periodStart(NOW, 7));
  });

  it('adds what OpenCode kept to the report, under its own agent', async () => {
    const d = deps({
      opencode: opencodeReturning({
        conversations: [
          { provider: 'opencode', id: 'ses_a', title: 'Fix the build', updatedAt: day(19) },
          { provider: 'opencode', id: 'ses_b', title: null, updatedAt: day(18) },
        ],
        rows: [
          recorded('ses_a', { day: '2026-09-19' }),
          recorded('ses_b', { day: '2026-09-18', recordedCostUsd: 4.5 }),
        ],
      }),
    });

    const report = await readProjectUsage(['/proj'], null, d);

    if (report.status !== 'ok') throw new Error('expected a report');
    expect(d.scan).not.toHaveBeenCalled();
    expect(report.byDay.map((x) => x.day)).toEqual(['2026-09-18', '2026-09-19']);
    expect(report.tokens).toMatchObject({ input: 2000, output: 500, cacheRead: 6000 });
    expect(report.byAgent[0]).toMatchObject({ provider: 'opencode', conversations: 2 });
    // The cost OpenCode recorded for ses_b is used as it is, on top of the estimate for ses_a.
    expect(report.costUsd).toBeGreaterThan(4.5);
    expect(report.top.map((t) => t.title)).toContain('Fix the build');
  });

  it('counts what it could not read, next to the other agents', async () => {
    const d = deps({
      list: vi.fn(async () => [session('claude-code', 'cc')]),
      scan: vi.fn(async () => ({
        buckets: [],
        cache: {},
        unreadable: [conversationKey('claude-code', 'cc')],
      })),
      opencode: opencodeReturning({ unreadable: 1 }),
    });

    const report = await readProjectUsage(['/proj'], null, d);

    expect(report).toMatchObject({ unreadable: 2 });
  });
});
