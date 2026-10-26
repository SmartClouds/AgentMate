import type { SubscriptionPlan, UsageTokens } from '@runova/core';
import { estimateCost, FABLE_WEEK_LABEL } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTokens } from './shared';
import { buildSessionBlocks, estimateSubscriptionWindows } from './subscriptionEstimate';

/**
 * The local reconstruction of a Claude Code subscription's rolling limits. Pure maths over a list
 * of priced token events, but it reads `Date.now()` in three places, so the clock is fixed for
 * every test here and the interesting cases are the block and window boundaries.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** A Wednesday, deliberately not on an hour boundary, so the flooring is visible. */
const NOW = new Date('2026-03-04T13:42:17.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

interface Entry {
  at: Date;
  model: string;
  tokens: UsageTokens;
}

/** One priced event. Input tokens only, which keeps the expected cost easy to reason about. */
function entry(when: Date, input: number, model = 'claude-opus-5'): Entry {
  return { at: when, model, tokens: makeTokens(input, 0, 0, 0) };
}

/** What the module will price this entry at, so no test hardcodes the price table. */
function cost(one: Entry): number {
  return estimateCost(one.model, one.tokens) ?? 0;
}

const PRO: SubscriptionPlan = { id: 'pro', label: 'Pro' };
const MAX: SubscriptionPlan = { id: 'max5x', label: 'Max 5x' };

describe('buildSessionBlocks', () => {
  it('returns nothing for no activity', () => {
    expect(buildSessionBlocks([])).toEqual([]);
  });

  it('opens a block on the hour containing the first message', () => {
    const [block] = buildSessionBlocks([entry(at(-18 * 60_000), 1000)]);

    // 13:24 falls in the 13:00 block, which runs to 18:00.
    expect(new Date(block.start).toISOString()).toBe('2026-03-04T13:00:00.000Z');
    expect(new Date(block.end).toISOString()).toBe('2026-03-04T18:00:00.000Z');
  });

  it('keeps everything inside the five hours in one block', () => {
    const entries = [
      entry(new Date('2026-03-04T10:10:00.000Z'), 1000),
      entry(new Date('2026-03-04T12:00:00.000Z'), 2000),
      entry(new Date('2026-03-04T14:59:59.000Z'), 3000),
    ];

    const blocks = buildSessionBlocks(entries);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].tokens).toBe(6000);
    expect(blocks[0].costUsd).toBeCloseTo(
      entries.reduce((sum, one) => sum + cost(one), 0),
      10,
    );
  });

  it('starts a fresh block for a message landing exactly on the old end', () => {
    const blocks = buildSessionBlocks([
      entry(new Date('2026-03-04T10:10:00.000Z'), 1000),
      // 10:00 + 5h, the first instant the old block no longer covers.
      entry(new Date('2026-03-04T15:00:00.000Z'), 1000),
    ]);

    expect(blocks).toHaveLength(2);
    expect(new Date(blocks[1].start).toISOString()).toBe('2026-03-04T15:00:00.000Z');
  });

  it('keeps a message one millisecond before the end in the old block', () => {
    const blocks = buildSessionBlocks([
      entry(new Date('2026-03-04T10:10:00.000Z'), 1000),
      entry(new Date('2026-03-04T14:59:59.999Z'), 1000),
    ]);

    expect(blocks).toHaveLength(1);
  });

  it('opens a block after an idle gap', () => {
    const blocks = buildSessionBlocks([
      entry(new Date('2026-03-04T02:00:00.000Z'), 1000),
      entry(new Date('2026-03-04T09:30:00.000Z'), 1000),
    ]);

    expect(blocks.map((one) => new Date(one.start).toISOString())).toEqual([
      '2026-03-04T02:00:00.000Z',
      '2026-03-04T09:00:00.000Z',
    ]);
  });

  it('sorts the entries before grouping them', () => {
    const blocks = buildSessionBlocks([
      entry(new Date('2026-03-04T12:00:00.000Z'), 1000),
      entry(new Date('2026-03-04T10:10:00.000Z'), 2000),
      entry(new Date('2026-03-04T20:00:00.000Z'), 4000),
    ]);

    // The scanners hand back whatever order the files came in, so the order is not a given.
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tokens).toBe(3000);
    expect(blocks[1].tokens).toBe(4000);
  });

  it('counts the tokens of an unpriced model but adds nothing to the cost', () => {
    const blocks = buildSessionBlocks([
      entry(new Date('2026-03-04T10:00:00.000Z'), 5000, 'mystery'),
    ]);

    // An unknown model has no price, and a missing price must not become a NaN cost.
    expect(blocks[0].tokens).toBe(5000);
    expect(blocks[0].costUsd).toBe(0);
  });

  it('adds up several models in the same block', () => {
    const entries = [
      entry(new Date('2026-03-04T10:00:00.000Z'), 1_000_000, 'claude-opus-5'),
      entry(new Date('2026-03-04T11:00:00.000Z'), 1_000_000, 'claude-fable-5-1'),
    ];

    const [block] = buildSessionBlocks(entries);

    expect(block.costUsd).toBeCloseTo(cost(entries[0]) + cost(entries[1]), 10);
    // Fable is the pricier of the two, so a plain token sum would understate this block.
    expect(cost(entries[1])).toBeGreaterThan(cost(entries[0]));
  });
});

describe('the session window', () => {
  it('is the only window when there is no activity at all', () => {
    const windows = estimateSubscriptionWindows([], PRO, null);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      key: 'session',
      label: 'Session (5h)',
      percent: 0,
      // Nothing to count down to: the next block opens on the next message.
      resetAt: null,
      usedTokens: 0,
      usedUsd: 0,
    });
  });

  it('reports the block in progress and when it ends', () => {
    const one = entry(new Date('2026-03-04T13:00:00.000Z'), 900_000);

    const [session] = estimateSubscriptionWindows([one], PRO, null);

    expect(session.resetAt).toBe('2026-03-04T18:00:00.000Z');
    expect(session.usedTokens).toBe(900_000);
    expect(session.usedUsd).toBeCloseTo(cost(one), 10);
    // Pro's session budget is 18 API-equivalent dollars.
    expect(session.percent).toBeCloseTo((cost(one) / 18) * 100, 6);
  });

  it('reports nothing in progress once the last block has ended', () => {
    const [session] = estimateSubscriptionWindows(
      [entry(new Date('2026-03-04T02:00:00.000Z'), 900_000)],
      PRO,
      null,
    );

    // 02:00 + 5h is well behind now, so the user is between blocks.
    expect(session.resetAt).toBeNull();
    expect(session.percent).toBe(0);
    expect(session.usedTokens).toBe(0);
  });

  it('treats a block ending exactly now as finished', () => {
    // A block from 08:00 to 13:00, against a now of 13:42.
    const [session] = estimateSubscriptionWindows(
      [entry(new Date('2026-03-04T08:30:00.000Z'), 1000)],
      PRO,
      null,
    );

    expect(session.resetAt).toBeNull();
  });

  it('clamps a blown session to a hundred percent', () => {
    const [session] = estimateSubscriptionWindows(
      [entry(new Date('2026-03-04T13:00:00.000Z'), 200_000_000)],
      PRO,
      null,
    );

    expect(session.percent).toBe(100);
  });

  it('raises the budget a completed block already exceeded', () => {
    const heavy = entry(new Date('2026-03-03T09:00:00.000Z'), 20_000_000);
    const active = entry(new Date('2026-03-04T13:00:00.000Z'), 900_000);

    const [session] = estimateSubscriptionWindows([heavy, active], PRO, null);

    // The constant was wrong for this account, so the observed maximum becomes the budget and
    // the live block shows real headroom instead of sitting pinned at 100%.
    expect(session.percent).toBeCloseTo((cost(active) / cost(heavy)) * 100, 6);
    expect(session.percent).toBeLessThan(100);
  });

  it('does not let the block in progress calibrate its own budget', () => {
    const active = entry(new Date('2026-03-04T13:00:00.000Z'), 20_000_000);

    const [session] = estimateSubscriptionWindows([active], PRO, null);

    // It has not had its full five hours to accumulate, so it stays at the plan constant.
    expect(session.percent).toBe(100);
  });

  it('gives a Max plan a larger session budget than Pro for the same spend', () => {
    const one = entry(new Date('2026-03-04T13:00:00.000Z'), 900_000);

    const pro = estimateSubscriptionWindows([one], PRO, null)[0];
    const max = estimateSubscriptionWindows([one], MAX, null)[0];

    expect(max.percent).toBeLessThan(pro.percent);
    expect(max.percent).toBeCloseTo(pro.percent / 5, 6);
  });

  it('falls back to the Pro budget for a plan it does not recognise', () => {
    const one = entry(new Date('2026-03-04T13:00:00.000Z'), 900_000);

    const unknown = estimateSubscriptionWindows([one], { id: 'galaxy', label: 'Galaxy' }, null)[0];
    const none = estimateSubscriptionWindows([one], null, null)[0];

    expect(unknown.percent).toBeCloseTo(
      estimateSubscriptionWindows([one], PRO, null)[0].percent,
      6,
    );
    expect(none.percent).toBe(unknown.percent);
  });
});

describe('the weekly window', () => {
  it('is phased off the anchor rather than the calendar week', () => {
    // Anchor two weeks and change before now, so the window under test is the third.
    const anchor = NOW.getTime() - 2 * WEEK - 3 * HOUR;
    const one = entry(at(-HOUR), 900_000);

    const week = estimateSubscriptionWindows([one], PRO, anchor)[1];

    expect(week.key).toBe('week');
    expect(week.resetAt).toBe(new Date(anchor + 3 * WEEK).toISOString());
    expect(week.usedTokens).toBe(900_000);
  });

  it('counts only the entries inside the window in progress', () => {
    const anchor = NOW.getTime() - 2 * WEEK - 3 * HOUR;
    const inside = entry(at(-HOUR), 500_000);
    const lastWeek = entry(new Date(anchor + WEEK + HOUR), 900_000);

    const week = estimateSubscriptionWindows([inside, lastWeek], PRO, anchor)[1];

    expect(week.usedTokens).toBe(500_000);
  });

  it('ignores activity from before the anchor and from the future', () => {
    const anchor = NOW.getTime() - 3 * HOUR;
    const week = estimateSubscriptionWindows(
      [
        entry(new Date(anchor - DAY), 111),
        entry(at(-HOUR), 222),
        // A transcript with a clock-skewed timestamp should not spend the quota either.
        entry(at(DAY), 333),
      ],
      PRO,
      anchor,
    )[1];

    expect(week.usedTokens).toBe(222);
  });

  it('counts an entry landing exactly on the anchor', () => {
    const anchor = NOW.getTime() - 3 * HOUR;

    const week = estimateSubscriptionWindows([entry(new Date(anchor), 444)], PRO, anchor)[1];

    expect(week.usedTokens).toBe(444);
  });

  it('uses the oldest entry as the anchor when none was given', () => {
    const oldest = new Date('2026-02-01T07:00:00.000Z');

    const week = estimateSubscriptionWindows(
      [entry(oldest, 1000), entry(at(-HOUR), 2000)],
      PRO,
      null,
    )[1];

    const index = Math.floor((NOW.getTime() - oldest.getTime()) / WEEK);
    expect(week.resetAt).toBe(new Date(oldest.getTime() + (index + 1) * WEEK).toISOString());
    // Only the recent entry is in the window in progress.
    expect(week.usedTokens).toBe(2000);
  });

  it('raises the weekly budget a completed week already exceeded', () => {
    const anchor = NOW.getTime() - 2 * WEEK - 3 * HOUR;
    const heavyWeek = entry(new Date(anchor + HOUR), 400_000_000);
    const thisWeek = entry(at(-HOUR), 900_000);

    const week = estimateSubscriptionWindows([heavyWeek, thisWeek], PRO, anchor)[1];

    expect(week.percent).toBeCloseTo((cost(thisWeek) / cost(heavyWeek)) * 100, 6);
  });

  it('is left out when there is nothing to anchor it to', () => {
    const windows = estimateSubscriptionWindows([], PRO, null);

    expect(windows.map((one) => one.key)).toEqual(['session']);
  });
});

describe('the Fable weekly window', () => {
  it('is added above Pro and counts Fable activity only', () => {
    const anchor = NOW.getTime() - 3 * HOUR;
    const fable = entry(at(-HOUR), 900_000, 'claude-fable-5-1');
    const sonnet = entry(at(-HOUR), 900_000, 'claude-sonnet-5');

    const windows = estimateSubscriptionWindows([fable, sonnet], MAX, anchor);

    expect(windows.map((one) => one.key)).toEqual(['session', 'week', 'week-fable']);
    const bucket = windows[2];
    expect(bucket.label).toBe(FABLE_WEEK_LABEL);
    expect(bucket.usedTokens).toBe(900_000);
    expect(bucket.usedUsd).toBeCloseTo(cost(fable), 10);
    // The shared weekly window still counts both.
    expect(windows[1].usedTokens).toBe(1_800_000);
  });

  it('shares the weekly phase, so both windows reset together', () => {
    const anchor = NOW.getTime() - 2 * WEEK - 3 * HOUR;

    const windows = estimateSubscriptionWindows(
      [entry(at(-HOUR), 1000, 'claude-fable-5-1')],
      MAX,
      anchor,
    );

    expect(windows[2].resetAt).toBe(windows[1].resetAt);
  });

  it('matches the model by family, not by an exact id', () => {
    const anchor = NOW.getTime() - 3 * HOUR;

    const bucket = estimateSubscriptionWindows(
      // What a transcript writes is not always the catalog id.
      [entry(at(-HOUR), 1000, 'Claude Fable 5.1 (preview)')],
      MAX,
      anchor,
    )[2];

    expect(bucket.usedTokens).toBe(1000);
  });

  it('is left out on Pro, which has no such bucket', () => {
    const anchor = NOW.getTime() - 3 * HOUR;

    const windows = estimateSubscriptionWindows(
      [entry(at(-HOUR), 1000, 'claude-fable-5-1')],
      PRO,
      anchor,
    );

    // A second bar there would just be an empty row.
    expect(windows.map((one) => one.key)).toEqual(['session', 'week']);
  });

  it('gives a Max tier with no published figure a third of its weekly budget', () => {
    const anchor = NOW.getTime() - 3 * HOUR;
    const fable = entry(at(-HOUR), 900_000, 'claude-fable-5-1');

    const windows = estimateSubscriptionWindows(
      [fable],
      { id: 'max50x', label: 'Max 50x' },
      anchor,
    );

    // An unlisted tier falls back to the Pro weekly budget of 90, so the Fable bucket is 30.
    expect(windows[2].percent).toBeCloseTo((cost(fable) / 30) * 100, 6);
  });

  it('is zero when the plan has the bucket but nothing used it', () => {
    const anchor = NOW.getTime() - 3 * HOUR;

    const windows = estimateSubscriptionWindows(
      [entry(at(-HOUR), 900_000, 'claude-sonnet-5')],
      MAX,
      anchor,
    );

    expect(windows[2]).toMatchObject({ percent: 0, usedTokens: 0, usedUsd: 0 });
    expect(windows[2].resetAt).not.toBeNull();
  });
});
