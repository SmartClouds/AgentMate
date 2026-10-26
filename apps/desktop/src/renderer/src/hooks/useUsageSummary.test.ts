import {
  getUsageProvider,
  type ProviderUsage,
  USAGE_PROVIDER_REGISTRY,
  type UsagePeriod,
} from '@runova/core';
import { waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useUsageSummary } from './useUsageSummary';

/**
 * The aggregate behind the Token Usage summary tiles and the All agents card. Claude Code,
 * Codex, Cursor, GitHub Copilot, OpenCode and Gemini CLI connect themselves from local data, so
 * they are always tracked; everything else only counts once its config says enabled. What the tests pin down is
 * which providers are added up, which are skipped, and that a provider that failed to scan never
 * contributes a number.
 */

function period(total: number, costUsd: number | null = null): UsagePeriod {
  return {
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
    costUsd,
  };
}

function usage(overrides: Partial<ProviderUsage> & { providerId: string }): ProviderUsage {
  return {
    status: 'ok',
    today: period(0),
    last7d: period(0),
    last30d: period(0),
    currency: 'USD',
    updatedAt: '2026-04-01T12:00:00.000Z',
    ...overrides,
  };
}

const claude = usage({
  providerId: 'claude-code',
  today: period(1_000, 0.5),
  last7d: period(7_000, 3),
  last30d: period(30_000, 12),
  series: [1, 2, 3],
  costSeries: [0.1, 0.2, 0.3],
});

const codex = usage({
  providerId: 'codex',
  today: period(500, 0.25),
  last7d: period(2_000, 1),
  last30d: period(9_000, 4),
  series: [4, 5],
  costSeries: [0.4, 0.5],
});

/** The six providers that need no configuration at all. */
const AUTO_CONNECTED = 6;

describe('useUsageSummary', () => {
  it('reports pending until both the settings and the usage list have landed', async () => {
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [] },
    });

    expect(result.current.isPending).toBe(true);
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.todayTokens).toBe(0);
    expect(result.current.okCount).toBe(0);
  });

  it('counts the auto-connected providers even with nothing configured', async () => {
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [] },
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    // Claude Code, Codex, Cursor, Copilot, OpenCode and Gemini CLI read local data, so they are
    // tracked without a key.
    expect(result.current.trackedCount).toBe(AUTO_CONNECTED);
    expect(result.current.totalCount).toBe(USAGE_PROVIDER_REGISTRY.length);
  });

  it('adds up tokens, cost and the sparkline series across the tracked providers', async () => {
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [claude, codex] },
    });

    await waitFor(() => expect(result.current.okCount).toBe(2));
    expect(result.current.todayTokens).toBe(1_500);
    expect(result.current.weekTokens).toBe(9_000);
    expect(result.current.monthTokens).toBe(39_000);
    expect(result.current.todayCost).toBeCloseTo(0.75);
    expect(result.current.cost).toBe(result.current.todayCost);
    expect(result.current.hasCost).toBe(true);
    // The shorter series is padded with zeros rather than truncating the longer one.
    expect(result.current.series).toEqual([5, 7, 3]);
    expect(result.current.costSeries[0]).toBeCloseTo(0.5);
  });

  it('sorts the per-agent rows by the week, heaviest first', async () => {
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [codex, claude] },
    });

    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    expect(result.current.agents.map((row) => row.id)).toEqual(['claude-code', 'codex']);
    expect(result.current.agents[0].name).toBe(getUsageProvider('claude-code')?.name);
    expect(result.current.agents[0].weekTokens).toBe(7_000);
  });

  it('skips a provider whose scan failed instead of counting it as zero usage', async () => {
    const broken = usage({
      providerId: 'codex',
      status: 'error',
      error: 'could not read ~/.codex',
      today: period(999_999),
    });
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [claude, broken] },
    });

    await waitFor(() => expect(result.current.okCount).toBe(1));
    expect(result.current.todayTokens).toBe(1_000);
    // It is still tracked, it just has no numbers to contribute.
    expect(result.current.trackedCount).toBe(AUTO_CONNECTED);
    expect(result.current.agents.map((row) => row.id)).toEqual(['claude-code']);
  });

  it('counts an API provider only once its config is enabled', async () => {
    const openai = usage({ providerId: 'openai', today: period(250, 1) });
    const disabled = renderHookWithProviders(() => useUsageSummary(), {
      bridge: {
        'settings.get': { usageProviderConfigs: { openai: { enabled: false } } },
        'usage.list': [openai],
      },
    });

    await waitFor(() => expect(disabled.result.current.isPending).toBe(false));
    expect(disabled.result.current.todayTokens).toBe(0);
    expect(disabled.result.current.trackedCount).toBe(AUTO_CONNECTED);

    const enabled = renderHookWithProviders(() => useUsageSummary(), {
      bridge: {
        'settings.get': { usageProviderConfigs: { openai: { enabled: true, apiKey: 'sk-x' } } },
        'usage.list': [openai],
      },
    });

    await waitFor(() => expect(enabled.result.current.todayTokens).toBe(250));
    expect(enabled.result.current.trackedCount).toBe(AUTO_CONNECTED + 1);
  });

  it('leaves hasCost false when no tracked provider can price its calls', async () => {
    const free = usage({ providerId: 'claude-code', today: period(400), last7d: period(900) });
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [free] },
    });

    await waitFor(() => expect(result.current.okCount).toBe(1));
    expect(result.current.hasCost).toBe(false);
    expect(result.current.cost).toBe(0);
  });

  it('settles on zeroes rather than throwing when the usage scan rejects', async () => {
    const { result } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: {
        'settings.get': {},
        'usage.list': () => Promise.reject(new Error('usage scan crashed')),
      },
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.okCount).toBe(0);
    expect(result.current.todayTokens).toBe(0);
    // The tiles still know how many providers are tracked, they just have no numbers.
    expect(result.current.trackedCount).toBe(AUTO_CONNECTED);
  });

  it('asks the main process for nothing while it is disabled', async () => {
    const { result, bridge } = renderHookWithProviders(() => useUsageSummary(false), {
      bridge: { 'settings.get': {}, 'usage.list': [claude] },
    });

    await waitFor(() => expect(result.current.todayTokens).toBe(0));
    // Never touched, so the mocks behind these paths were not even created.
    expect(() => bridge.$fn('usage.list')).toThrow();
    expect(() => bridge.$fn('settings.get')).toThrow();
  });

  it('registers no bridge subscriptions, so nothing is left behind on unmount', async () => {
    const { result, bridge, unmount } = renderHookWithProviders(() => useUsageSummary(), {
      bridge: { 'settings.get': {}, 'usage.list': [claude] },
    });
    await waitFor(() => expect(result.current.okCount).toBe(1));

    // This hook polls rather than subscribing; the assertion guards against a listener
    // being added later without an unsubscribe.
    expect(bridge.$listenerCount('usage.onUpdate')).toBe(0);
    unmount();
    expect(bridge.$listenerCount('usage.onUpdate')).toBe(0);
  });
});
