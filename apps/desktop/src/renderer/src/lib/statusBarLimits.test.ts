import { emptyUsageTokens, type ProviderUsage, type SubscriptionWindow } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { buildLimitChips, liveWindows, mergeProviderUsage } from './statusBarLimits';

/**
 * What the status bar draws for each provider, worked out from the usage list alone. A read that
 * failed must keep its item: dimmed with the last limits it had, or as a warning when it never had
 * any. Only an account with nothing to count down to, or a provider switched off, leaves the bar.
 */

const period = { tokens: emptyUsageTokens(), costUsd: null };
const READ_AT = '2026-03-01T12:00:00.000Z';
const LATER = new Date(Date.now() + 5 * 3_600_000).toISOString();
const PRO_PLUS = { id: 'pro-plus', label: 'Pro+' };

function usage(providerId: string, over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId,
    status: 'ok',
    today: period,
    last7d: period,
    last30d: period,
    currency: 'USD',
    updatedAt: READ_AT,
    ...over,
  };
}

function limit(
  percent: number,
  key: SubscriptionWindow['key'] = 'session',
  resetAt: string | null = LATER,
): SubscriptionWindow {
  return { key, label: 'Session (5h)', percent, resetAt };
}

function withLimits(
  windows: SubscriptionWindow[],
  plan: { id: string; label: string } | null = null,
) {
  return {
    subscription: { mode: 'subscription' as const, plan, windows, source: 'account' as const },
  };
}

describe('liveWindows', () => {
  it('keeps windows with a reset to count down to or some of the limit used', () => {
    const windows =
      usage(
        'codex',
        withLimits([limit(22), { key: 'week', label: 'Weekly', percent: 0, resetAt: null }]),
      ).subscription?.windows ?? [];

    expect(liveWindows(usage('codex', withLimits(windows)))).toEqual([limit(22)]);
  });
});

describe('buildLimitChips', () => {
  it('lists the providers in a fixed order', () => {
    const chips = buildLimitChips(
      [
        usage('cursor', withLimits([limit(41, 'month')], PRO_PLUS)),
        usage('codex', withLimits([limit(22)], { id: 'plus', label: 'Plus' })),
        usage('claude-code', withLimits([limit(64)], { id: 'max', label: 'Max' })),
      ],
      undefined,
    );

    expect(chips.map((c) => c.providerId)).toEqual(['claude-code', 'codex', 'cursor']);
  });

  it('draws a read with live limits as an ok chip', () => {
    const [chip] = buildLimitChips([usage('codex', withLimits([limit(22)], PRO_PLUS))], undefined);

    expect(chip).toMatchObject({
      providerId: 'codex',
      state: 'ok',
      plan: 'Pro+',
      asOf: READ_AT,
      problem: null,
    });
    expect(chip.windows).toEqual([limit(22)]);
  });

  it('leaves out a provider switched off in Settings, even when its read failed', () => {
    const chips = buildLimitChips(
      [usage('codex', { status: 'error', error: 'Could not reach Codex.' })],
      { codex: false },
    );

    expect(chips).toEqual([]);
  });

  it('has no chip for a provider with nothing to count down to', () => {
    const chips = buildLimitChips(
      [
        usage('cursor', { status: 'connect' }),
        usage('codex'),
        usage(
          'claude-code',
          withLimits([{ key: 'session', label: 'Session (5h)', percent: 0, resetAt: null }]),
        ),
      ],
      undefined,
    );

    expect(chips).toEqual([]);
  });

  it('keeps a failed read as a stale chip with the last limits it had', () => {
    const [chip] = buildLimitChips(
      [
        usage('cursor', {
          status: 'error',
          error: 'Cursor did not answer in time.',
          lastLimits: {
            plan: PRO_PLUS,
            windows: [limit(41, 'month')],
            readAt: '2026-03-01T11:48:00.000Z',
          },
        }),
      ],
      undefined,
    );

    expect(chip).toMatchObject({
      providerId: 'cursor',
      state: 'stale',
      plan: 'Pro+',
      asOf: '2026-03-01T11:48:00.000Z',
      problem: 'Cursor did not answer in time.',
    });
    expect(chip.windows).toEqual([limit(41, 'month')]);
  });

  it('shows an unavailable chip for a failed read with nothing to keep', () => {
    const [chip] = buildLimitChips(
      [usage('cursor', { status: 'error', error: 'Could not reach Cursor.' })],
      undefined,
    );

    expect(chip).toMatchObject({
      providerId: 'cursor',
      state: 'unavailable',
      windows: [],
      asOf: null,
      problem: 'Could not reach Cursor.',
    });
  });

  it('shows an unavailable chip when the limits could not be read but the rest could', () => {
    const [chip] = buildLimitChips(
      [usage('cursor', { limitsError: 'Cursor returned HTTP 500' })],
      undefined,
    );

    expect(chip).toMatchObject({
      state: 'unavailable',
      problem: 'Cursor returned HTTP 500',
    });
  });

  it('has no chips before the list has loaded', () => {
    expect(buildLimitChips(undefined, undefined)).toEqual([]);
  });
});

describe('buildLimitChips read time and estimates', () => {
  const ANSWERED_AT = '2026-03-01T11:56:00.000Z';

  function estimate(windows: SubscriptionWindow[], over: Partial<ProviderUsage> = {}) {
    return usage('claude-code', {
      subscription: {
        mode: 'subscription',
        plan: null,
        windows,
        source: 'estimate',
        estimateReason: 'signed out of the CLI',
      },
      ...over,
    });
  }

  it('dates a chip from when the limits were read, not from when the snapshot was built', () => {
    const read = usage('claude-code', withLimits([limit(12)]));
    if (read.subscription) read.subscription.readAt = ANSWERED_AT;

    const [chip] = buildLimitChips([read], undefined);

    expect(chip).toMatchObject({ state: 'ok', asOf: ANSWERED_AT });
  });

  it('falls back to the snapshot time when the read time is not known', () => {
    const [chip] = buildLimitChips([usage('claude-code', withLimits([limit(12)]))], undefined);

    expect(chip.asOf).toBe(READ_AT);
  });

  it('marks windows estimated from local logs, with the reason the account was not read', () => {
    const [chip] = buildLimitChips([estimate([limit(5)])], undefined);

    expect(chip).toMatchObject({
      state: 'estimate',
      windows: [limit(5)],
      asOf: READ_AT,
      problem: 'signed out of the CLI',
    });
  });

  it("shows the account's last reading rather than an estimate, as out of date", () => {
    const lastLimits = { plan: PRO_PLUS, windows: [limit(30)], readAt: ANSWERED_AT };

    const [chip] = buildLimitChips([estimate([limit(5)], { lastLimits })], undefined);

    expect(chip).toMatchObject({
      state: 'stale',
      plan: 'Pro+',
      windows: [limit(30)],
      asOf: ANSWERED_AT,
      problem: 'signed out of the CLI',
    });
  });
});

describe('mergeProviderUsage', () => {
  it('swaps in one provider without touching the others', () => {
    const list = [usage('cursor'), usage('codex')];
    const next = usage('cursor', { status: 'error', error: 'Could not reach Cursor.' });

    const merged = mergeProviderUsage(list, next);

    expect(merged).toEqual([next, list[1]]);
    expect(list[0].status).toBe('ok');
  });

  it('adds a provider the list does not have yet', () => {
    const merged = mergeProviderUsage([usage('codex')], usage('cursor'));

    expect(merged.map((u) => u.providerId)).toEqual(['codex', 'cursor']);
  });
});
