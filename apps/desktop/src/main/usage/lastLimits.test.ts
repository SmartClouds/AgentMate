import { emptyUsageTokens, type ProviderUsage, type SubscriptionWindow } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { createLimitsMemory } from './lastLimits';

/**
 * A failed read must not take a provider's plan limits off the status bar, but stale numbers must
 * never pass for current ones. These pin the ways a read can come back and the rules that follow:
 * live limits are remembered, a read that finds no limits forgets them, and a failed read gets back
 * only the windows that have not reset yet.
 */

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const PLAN = { id: 'pro-plus', label: 'Pro+' };

function snapshot(over: Partial<ProviderUsage> = {}): ProviderUsage {
  const period = { tokens: emptyUsageTokens(), costUsd: null };
  return {
    providerId: 'cursor',
    status: 'ok',
    today: period,
    last7d: period,
    last30d: period,
    currency: 'USD',
    updatedAt: at(0),
    ...over,
  };
}

function limit(
  percent: number,
  resetAt: string | null = at(5 * HOUR),
  key: SubscriptionWindow['key'] = 'month',
): SubscriptionWindow {
  return { key, label: 'Monthly usage', percent, resetAt };
}

/** A read that came back with these windows. */
function withLimits(windows: SubscriptionWindow[]): Partial<ProviderUsage> {
  return { subscription: { mode: 'subscription', plan: PLAN, windows, source: 'account' } };
}

/** A read that failed and got no limits of its own. */
function failed(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return snapshot({ status: 'error', error: 'Could not reach Cursor.', ...over });
}

describe('the last known limits', () => {
  it('hands a failed read the limits of the last good read, with its plan and read time', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);

    const out = memory.attach('cursor', failed({ updatedAt: at(60_000) }), NOW + 60_000);

    expect(out.lastLimits).toEqual({ plan: PLAN, windows: [limit(41)], readAt: at(0) });
  });

  it('keeps a read that failed but still has its limits fresh, not stale', () => {
    const memory = createLimitsMemory();
    const salvaged = snapshot({
      status: 'error',
      error: 'Cursor did not answer in time.',
      ...withLimits([limit(41)]),
    });

    expect(memory.attach('cursor', salvaged, NOW).lastLimits).toBeUndefined();

    memory.observe('cursor', salvaged, NOW);
    const later = memory.attach('cursor', failed({ updatedAt: at(60_000) }), NOW + 60_000);
    expect(later.lastLimits?.windows).toEqual([limit(41)]);
  });

  it('hands back the remembered limits when a read reports a limits error', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);

    const out = memory.attach('cursor', snapshot({ limitsError: 'Cursor returned HTTP 500' }), NOW);

    expect(out.lastLimits?.windows).toEqual([limit(41)]);
  });

  it('hands back nothing for a failed read when no limits were ever read', () => {
    const memory = createLimitsMemory();

    expect(memory.attach('cursor', failed(), NOW).lastLimits).toBeUndefined();
  });

  it('forgets the old limits when a read finds the plan has none', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);
    memory.observe('cursor', snapshot({ ...withLimits([]), updatedAt: at(60_000) }), NOW);

    expect(
      memory.attach('cursor', failed({ updatedAt: at(120_000) }), NOW).lastLimits,
    ).toBeUndefined();
  });

  it('forgets the old limits when the account is signed out', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);
    memory.observe('cursor', snapshot({ status: 'connect', updatedAt: at(60_000) }), NOW);

    expect(memory.attach('cursor', failed(), NOW).lastLimits).toBeUndefined();
  });

  it('reads a Codex window that has rolled over as no limits, not as a failure', () => {
    const memory = createLimitsMemory();
    memory.observe(
      'codex',
      snapshot({ providerId: 'codex', ...withLimits([limit(22, at(HOUR))]) }),
      NOW,
    );
    memory.observe(
      'codex',
      snapshot({
        providerId: 'codex',
        updatedAt: at(60_000),
        ...withLimits([{ key: 'session', label: 'Session (5h)', percent: 0, resetAt: null }]),
      }),
      NOW,
    );

    expect(memory.attach('codex', failed({ providerId: 'codex' }), NOW).lastLimits).toBeUndefined();
  });

  it('drops remembered windows once their reset time has passed', () => {
    const memory = createLimitsMemory();
    memory.observe(
      'cursor',
      snapshot(withLimits([limit(64, at(2 * HOUR), 'session'), limit(71, at(48 * HOUR), 'week')])),
      NOW,
    );

    const later = memory.attach('cursor', failed(), NOW + 3 * HOUR);
    expect(later.lastLimits?.windows.map((w) => w.key)).toEqual(['week']);

    const muchLater = memory.attach('cursor', failed(), NOW + 49 * HOUR);
    expect(muchLater.lastLimits).toBeUndefined();
  });

  it('keeps a remembered window that has no reset time', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(30, null, 'week')])), NOW);

    const out = memory.attach('cursor', failed(), NOW + 100 * HOUR);

    expect(out.lastLimits?.windows).toEqual([limit(30, null, 'week')]);
  });

  it('does not let a read that finishes late overwrite a newer one', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot({ ...withLimits([limit(80)]), updatedAt: at(60_000) }), NOW);
    memory.observe('cursor', snapshot({ ...withLimits([limit(10)]), updatedAt: at(0) }), NOW);

    const out = memory.attach('cursor', failed({ updatedAt: at(120_000) }), NOW);

    expect(out.lastLimits?.windows[0].percent).toBe(80);
  });

  it('reads an unlimited plan whose token feed fails as having no limits', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);
    memory.observe('cursor', failed({ ...withLimits([]), updatedAt: at(60_000) }), NOW);

    expect(
      memory.attach('cursor', failed({ updatedAt: at(120_000) }), NOW).lastLimits,
    ).toBeUndefined();
  });

  it('never changes the snapshot it is given', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);
    const input = failed();

    const out = memory.attach('cursor', input, NOW);

    expect(out).not.toBe(input);
    expect(input.lastLimits).toBeUndefined();
  });

  it('keeps each provider limits to itself', () => {
    const memory = createLimitsMemory();
    memory.observe('cursor', snapshot(withLimits([limit(41)])), NOW);
    memory.observe(
      'claude-code',
      snapshot({ providerId: 'claude-code', ...withLimits([limit(64, at(3 * HOUR), 'session')]) }),
      NOW,
    );

    const out = memory.attach('cursor', failed(), NOW);

    expect(out.lastLimits?.windows).toEqual([limit(41)]);
  });
});

/**
 * When the Claude account does not answer, the scan still hands back windows, worked out from local
 * logs. Those are a guess: they must not be remembered as the account's numbers, and the numbers the
 * account last gave must still reach the status bar alongside them.
 */
describe('the last known limits next to an estimate', () => {
  function claude(over: Partial<ProviderUsage> = {}): ProviderUsage {
    return snapshot({ providerId: 'claude-code', ...over });
  }

  function estimate(windows: SubscriptionWindow[]): Partial<ProviderUsage> {
    return {
      subscription: {
        mode: 'subscription',
        plan: PLAN,
        windows,
        source: 'estimate',
        estimateReason: 'account unreachable',
      },
    };
  }

  it("hands an estimate the account's last reading", () => {
    const memory = createLimitsMemory();
    memory.observe('claude-code', claude(withLimits([limit(30, at(3 * HOUR), 'session')])), NOW);

    const out = memory.attach(
      'claude-code',
      claude({ ...estimate([limit(5, at(3 * HOUR), 'session')]), updatedAt: at(60_000) }),
      NOW + 60_000,
    );

    expect(out.lastLimits).toEqual({
      plan: PLAN,
      windows: [limit(30, at(3 * HOUR), 'session')],
      readAt: at(0),
    });
    // The estimate itself is left as it was, for the Usage page to show as estimated.
    expect(out.subscription?.source).toBe('estimate');
  });

  it('never remembers an estimate in place of a real reading', () => {
    const memory = createLimitsMemory();
    memory.observe('claude-code', claude(withLimits([limit(30, at(3 * HOUR), 'session')])), NOW);
    memory.observe(
      'claude-code',
      claude({ ...estimate([limit(5, at(3 * HOUR), 'session')]), updatedAt: at(60_000) }),
      NOW + 60_000,
    );

    const out = memory.attach('claude-code', failed({ providerId: 'claude-code' }), NOW + 120_000);

    expect(out.lastLimits?.windows).toEqual([limit(30, at(3 * HOUR), 'session')]);
  });

  it('remembers when the account answered, not when the scan carrying the answer ran', () => {
    const memory = createLimitsMemory();
    const read = claude({
      subscription: {
        mode: 'subscription',
        plan: PLAN,
        windows: [limit(30, at(3 * HOUR), 'session')],
        source: 'account',
        readAt: at(-40_000),
      },
    });
    memory.observe('claude-code', read, NOW);

    const out = memory.attach('claude-code', failed({ providerId: 'claude-code' }), NOW);

    expect(out.lastLimits?.readAt).toBe(at(-40_000));
  });
});
