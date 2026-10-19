import { describe, expect, it } from 'vitest';
import { codexSubscription } from './codexLimits';

/**
 * Codex's plan limits come from the newest rate-limit snapshot in its logs. What matters is
 * that each window is named by how long it runs (a free plan has one 30-day window where a
 * paid one has a 5h session and a week), and that a window whose reset has passed since the
 * last turn reads as fresh rather than as the stale number it last logged.
 */

const now = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR_MS = 3_600_000;
const later = (hours: number): string => new Date(now + hours * HOUR_MS).toISOString();

describe('codexSubscription', () => {
  it('names a paid plan session and week by their length', () => {
    const subscription = codexSubscription(
      {
        windows: [
          { minutes: 300, percent: 22, resetAt: later(2) },
          { minutes: 10080, percent: 41, resetAt: later(50) },
        ],
        planType: 'plus',
        at: now - HOUR_MS,
      },
      now,
    );

    expect(subscription).toEqual({
      mode: 'subscription',
      plan: { id: 'plus', label: 'Plus' },
      windows: [
        { key: 'session', label: 'Session (5h)', percent: 22, resetAt: later(2) },
        { key: 'week', label: 'Weekly', percent: 41, resetAt: later(50) },
      ],
      source: 'account',
      // As of the turn that reported them an hour ago, so the status bar does not call them new.
      readAt: new Date(now - HOUR_MS).toISOString(),
    });
  });

  it('reads a single 30-day window as the monthly limit', () => {
    const subscription = codexSubscription(
      {
        windows: [{ minutes: 43200, percent: 21, resetAt: later(400) }],
        planType: 'free',
        at: now,
      },
      now,
    );

    expect(subscription?.plan).toEqual({ id: 'free', label: 'Free' });
    expect(subscription?.windows).toEqual([
      { key: 'month', label: 'Monthly', percent: 21, resetAt: later(400) },
    ]);
  });

  it('treats a window whose reset has passed as rolled over', () => {
    const subscription = codexSubscription(
      { windows: [{ minutes: 300, percent: 97, resetAt: later(-1) }], planType: null, at: now },
      now,
    );

    expect(subscription?.windows).toEqual([
      { key: 'session', label: 'Session (5h)', percent: 0, resetAt: null },
    ]);
    expect(subscription?.plan).toBeNull();
  });

  it('gives no subscription when the logs report no limits', () => {
    expect(codexSubscription(undefined, now)).toBeUndefined();
    expect(codexSubscription({ windows: [], planType: 'plus', at: now }, now)).toBeUndefined();
  });
});
