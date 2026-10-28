import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub Copilot usage, read two ways: the Copilot CLI's own session logs on disk
 * (credential-free, like Claude Code and Codex) and, when the user pastes a personal
 * access token plus their org, the org Copilot metrics API. The API wins when it is
 * configured; a failed API call falls back to the local logs rather than failing the
 * card. The network is stubbed per test, so no real GitHub account is touched.
 */

const { fetchCopilotApiUsage, fetchCopilotUsage, parseCopilotUsageRecord } = await import(
  './copilot'
);

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

/** A real `session.usage_record` line, as the CLI writes it under session-state. */
function usageRecord(
  at: number,
  fields: { model?: string; input?: number; output?: number; cacheRead?: number; id?: string } = {},
): string {
  return `${JSON.stringify({
    type: 'session.usage_record',
    id: fields.id ?? 'evt-1',
    timestamp: new Date(at).toISOString(),
    data: {
      usage: {
        model: fields.model ?? 'gpt-6-luna',
        inputTokens: fields.input ?? 100,
        outputTokens: fields.output ?? 50,
        cacheReadTokens: fields.cacheRead ?? 0,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
      },
    },
  })}\n`;
}

/** One day of the org metrics API, with the token breakdown the 2026 API reports. */
function metricsDay(date: string, chat = 0, completions = 0, cli = 0) {
  const block = (prompt: number, output: number) => ({
    token_usage: { prompt_tokens_sum: prompt, output_tokens_sum: output },
  });
  return {
    date,
    copilot_ide_chat: block(chat, Math.floor(chat / 2)),
    copilot_ide_code_completions: block(completions, Math.floor(completions / 4)),
    copilot_cli: block(cli, Math.floor(cli / 2)),
  };
}

function fakeGitHub(answer: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('parseCopilotUsageRecord', () => {
  it('reads a session.usage_record line with its model and token counts', () => {
    const entry = parseCopilotUsageRecord(usageRecord(NOW - 1_000).trim());

    expect(entry).toMatchObject({
      model: 'gpt-6-luna',
      input: 100,
      output: 50,
      id: 'evt-1',
    });
    expect(entry?.at).toBe(NOW - 1_000);
  });

  it('never counts reasoning tokens on top of the output total', () => {
    const entry = parseCopilotUsageRecord(usageRecord(NOW - 1_000).trim());

    // reasoningTokens is a share of outputTokens; the total must stay input + output.
    expect(entry?.output).toBe(50);
  });

  it('uses the session model for a record that names none, and the fallback otherwise', () => {
    const noModel = JSON.parse(usageRecord(NOW - 1_000)) as {
      data: { usage: Record<string, unknown> };
    };
    delete noModel.data.usage.model;

    expect(parseCopilotUsageRecord(JSON.stringify(noModel), 'gpt-4o')?.model).toBe('gpt-4o');
    expect(parseCopilotUsageRecord(JSON.stringify(noModel))?.model).toBe('gpt-5');
  });

  it('ignores other event types, invalid JSON, and missing timestamps', () => {
    expect(parseCopilotUsageRecord('{"type":"user.message","data":{}}')).toBeNull();
    expect(parseCopilotUsageRecord('not json at all')).toBeNull();
    expect(
      parseCopilotUsageRecord(
        JSON.stringify({ type: 'session.usage_record', data: { usage: { inputTokens: 1 } } }),
      ),
    ).toBeNull();
  });
});

describe('fetchCopilotApiUsage', () => {
  it('asks the org metrics endpoint with the token and the API version header', async () => {
    const fetchMock = fakeGitHub([metricsDay('2026-10-13', 100, 0, 0)]);

    await fetchCopilotApiUsage({ apiKey: 'ghp-test', org: 'acme' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/orgs/acme/copilot/metrics');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp-test');
    expect(headers['X-GitHub-Api-Version']).toBe('2026-03-10');
  });

  it('splits tokens into chat, completions and CLI segments that add up to the periods', async () => {
    fakeGitHub([
      metricsDay('2026-10-13', 1_000, 2_000, 500),
      metricsDay('2026-10-10', 0, 4_000, 0),
      metricsDay('2026-08-01', 9_999, 9_999, 9_999),
    ]);

    const usage = await fetchCopilotApiUsage({ apiKey: 'ghp-test', org: 'acme' });

    expect(usage.providerId).toBe('copilot');
    expect(usage.status).toBe('ok');
    // Today: 1000+500 chat, 2000+500 completions, 500+250 cli = 4750.
    expect(usage.today.tokens.total).toBe(4_750);
    // Last 7d adds 2026-10-10: 4000+1000 completions = 5000. The August day is
    // 73 days back, so last30d excludes it too.
    expect(usage.last7d.tokens.total).toBe(9_750);
    const keys = usage.today.segments?.map((s) => s.key).sort();
    expect(keys).toEqual(['chat', 'cli', 'completions']);
    const segmentTotal = (usage.today.segments ?? []).reduce((sum, s) => sum + s.tokens.total, 0);
    expect(segmentTotal).toBe(usage.today.tokens.total);
    expect(usage.series).toHaveLength(14);
    // Cost is estimated at list prices (gpt-5 rates), which is what draws the
    // card's Cost section: chat is (1000*1.25 + 500*10)/1e6.
    expect(usage.today.costUsd).toBeCloseTo(0.016875, 6);
    expect(usage.today.segments?.find((s) => s.key === 'chat')?.costUsd).toBeCloseTo(0.00625, 6);
    expect(usage.last7d.costUsd).toBeGreaterThan(usage.today.costUsd ?? 0);
    expect(usage.costSeries?.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('accepts a bare org pasted as a URL, and rejects a missing org', async () => {
    const fetchMock = fakeGitHub([]);
    await fetchCopilotApiUsage({ apiKey: 'ghp-test', org: 'https://github.com/acme' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/orgs/acme/');

    await expect(fetchCopilotApiUsage({ apiKey: 'ghp-test', org: '  ' })).rejects.toThrow(
      /organization/i,
    );
  });

  it('turns a rejected token into an error naming the PAT scope', async () => {
    fakeGitHub({ message: 'Bad credentials' }, 401);

    const usage = await fetchCopilotApiUsage({ apiKey: 'ghp-wrong', org: 'acme' }).catch(
      (err: unknown) => err,
    );

    expect(String((usage as Error).message)).toMatch(/token|scope|401/i);
  });
});

describe('fetchCopilotUsage', () => {
  it('prefers the API when a token and org are configured', async () => {
    const fetchMock = fakeGitHub([metricsDay('2026-10-13', 300, 0, 0)]);
    const scanLocal = vi.fn(async () => {
      throw new Error('must not scan when the API is configured');
    });

    const usage = await fetchCopilotUsage(
      { enabled: true, apiKey: 'ghp-test', baseUrl: 'acme' },
      { scanLocal },
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(scanLocal).not.toHaveBeenCalled();
    expect(usage.status).toBe('ok');
    expect(usage.today.tokens.total).toBe(450);
  });

  it('falls back to the local logs when the API call fails', async () => {
    fakeGitHub(new Error('network down'));
    const local = {
      providerId: 'copilot',
      status: 'ok' as const,
      today: {
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        costUsd: null,
      },
      last7d: {
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        costUsd: null,
      },
      last30d: {
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        costUsd: null,
      },
      currency: 'USD',
      updatedAt: new Date(NOW).toISOString(),
    };
    const scanLocal = vi.fn(async () => local);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const usage = await fetchCopilotUsage(
      { enabled: true, apiKey: 'ghp-test', baseUrl: 'acme' },
      { scanLocal },
    );

    expect(scanLocal).toHaveBeenCalled();
    expect(usage).toBe(local);
    expect(warn).toHaveBeenCalledWith(
      '[usage] copilot API failed, falling back to local logs:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('scans the local logs directly when no token is configured', async () => {
    const fetchMock = fakeGitHub([]);
    const scanLocal = vi.fn(async () => ({
      providerId: 'copilot',
      status: 'ok' as const,
      today: {
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        costUsd: null,
      },
      last7d: {
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        costUsd: null,
      },
      last30d: {
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        costUsd: null,
      },
      currency: 'USD',
      updatedAt: new Date(NOW).toISOString(),
    }));

    const usage = await fetchCopilotUsage({ enabled: true }, { scanLocal });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(scanLocal).toHaveBeenCalled();
    expect(usage.today.tokens.total).toBe(2);
  });

  it('covers the last 30 days of metrics, day-bucketed for the sparkline', async () => {
    const days = Array.from({ length: 30 }, (_, i) => {
      const date = new Date(NOW - i * DAY_MS).toISOString().slice(0, 10);
      return metricsDay(date, 100, 0, 0);
    });
    fakeGitHub(days);

    const usage = await fetchCopilotApiUsage({ apiKey: 'ghp-test', org: 'acme' });

    // 150 tokens per day for 30 days.
    expect(usage.last30d.tokens.total).toBe(4_500);
    expect(usage.series?.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
