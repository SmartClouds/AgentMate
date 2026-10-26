import {
  CLAUDE_WEEKLY_METERED_MODEL,
  estimateCost,
  FABLE_WEEK_LABEL,
  metersFableWeekly,
  type SubscriptionPlan,
  type SubscriptionWindow,
} from '@runova/core';
import type { UsageEntry } from './shared';

// Local reconstruction of the rolling limits a Claude Code subscription is
// metered against. This is the fallback for when the account can't be reached;
// everything it produces is explicitly an estimate, and the card labels it as
// such, because none of the numbers below are published figures.
//
// Three things are reconstructed:
//
//   Session (5h). Usage is metered in 5-hour blocks that start with your first
//   message after an idle gap, not on a wall-clock schedule. So the block
//   boundaries are derived from the transcript timestamps themselves.
//
//   Weekly. A 7-day window phased off the account's first-ever token date, the
//   one anchor available locally that doesn't move as old transcripts age out.
//
//   Weekly (Fable). Above Pro, Fable is charged against its own weekly bucket
//   as well as the shared one. Same phase as the weekly window, counting only
//   Fable activity; Pro has no such bucket, so the window is left out entirely.
//
// Consumption is measured in API-equivalent dollars rather than raw tokens.
// A cache read costs a tenth of a fresh input token and Opus several times a
// Sonnet one, so a token count would rank a cache-heavy hour far above a short
// Opus session that actually ate more of the quota.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SESSION_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** One 5-hour metering block reconstructed from activity. */
interface SessionBlock {
  start: number;
  end: number;
  tokens: number;
  costUsd: number;
}

interface PlanBudget {
  session: number;
  week: number;
  /** Fable's own weekly bucket. Absent on plans that don't have one (Pro). */
  fableWeek?: number;
}

/**
 * Per-plan budgets in API-equivalent dollars. These are calibration constants,
 * not quoted limits. Anthropic doesn't publish the numbers, so they're sized
 * from the plans' relative multipliers and then corrected per-account by
 * `calibrate()` below.
 */
const PLAN_BUDGETS: Record<string, PlanBudget> = {
  pro: { session: 18, week: 90 },
  // Max is sold as 5× / 20× Pro usage. The previous Max 5× session figure
  // (35) was only ~2× Pro, so a Max account's estimate bars filled like Pro.
  max: { session: 90, week: 450, fableWeek: 150 },
  max5x: { session: 90, week: 450, fableWeek: 150 },
  max20x: { session: 360, week: 1800, fableWeek: 600 },
  team: { session: 90, week: 450, fableWeek: 150 },
  enterprise: { session: 90, week: 450, fableWeek: 150 },
};

const FALLBACK_BUDGET = PLAN_BUDGETS.pro;

/** Roughly a third of the weekly allowance, for a Max tier we don't have figures for. */
const FABLE_WEEK_SHARE = 1 / 3;

function budgetsFor(plan: SubscriptionPlan | null): PlanBudget {
  return (plan && PLAN_BUDGETS[plan.id]) || FALLBACK_BUDGET;
}

/** Entries billed against the Fable bucket, matched the way pricing matches ids. */
function isFableModel(model: string): boolean {
  return model.toLowerCase().includes(CLAUDE_WEEKLY_METERED_MODEL.family.toLowerCase());
}

function floorToHour(ms: number): number {
  return ms - (ms % HOUR_MS);
}

/**
 * Group entries into 5-hour blocks. A block opens on the hour containing its
 * first message and closes 5 hours later, or as soon as the gap since the last
 * message reaches 5 hours, at which point the next message opens a fresh one.
 */
export function buildSessionBlocks(entries: UsageEntry[]): SessionBlock[] {
  const sorted = [...entries].sort((a, b) => a.at.getTime() - b.at.getTime());
  const blocks: SessionBlock[] = [];
  let current: SessionBlock | null = null;
  let lastAt = 0;

  for (const entry of sorted) {
    const at = entry.at.getTime();
    if (!current || at >= current.end || at - lastAt >= SESSION_MS) {
      current = {
        start: floorToHour(at),
        end: floorToHour(at) + SESSION_MS,
        tokens: 0,
        costUsd: 0,
      };
      blocks.push(current);
    }
    current.tokens += entry.tokens.total;
    current.costUsd += estimateCost(entry.model, entry.tokens) ?? 0;
    lastAt = at;
  }

  return blocks;
}

/**
 * Raise a budget that the account has demonstrably exceeded. If a completed
 * window spent more than the constant above allows, the constant is wrong for
 * this account (a plan we mis-detected, or figures that have since moved), and
 * clamping every window to 100% would hide real headroom. The observed maximum
 * is the one lower bound we can trust.
 */
function calibrate(budget: number, observedMax: number): number {
  return Math.max(budget, observedMax);
}

function toPercent(used: number, budget: number): number {
  if (budget <= 0) return 0;
  return Math.max(0, Math.min(100, (used / budget) * 100));
}

/** The 5-hour block in progress right now, if the user is inside one. */
function activeBlock(blocks: SessionBlock[], now: number): SessionBlock | null {
  const last = blocks[blocks.length - 1];
  return last && now < last.end ? last : null;
}

/**
 * Bucket activity into 7-day windows phased off `anchor`, so a boundary lands on
 * the same weekday/time the account first used Claude Code, matching how the
 * real weekly limit tracks account history rather than a calendar week.
 *
 * Returns the window in progress plus the priciest *completed* one, which is
 * what calibrates the weekly budget. Without that calibration a heavy user sits
 * pinned at 100% forever, which reads as "quota exhausted" when it only means
 * the constant below is too small for this account.
 */
function weekBuckets(
  entries: UsageEntry[],
  anchor: number,
  now: number,
): {
  current: { start: number; end: number; tokens: number; costUsd: number };
  completedMax: number;
} {
  const currentIndex = Math.floor((now - anchor) / WEEK_MS);
  const start = anchor + currentIndex * WEEK_MS;
  const current = { start, end: start + WEEK_MS, tokens: 0, costUsd: 0 };
  const completed = new Map<number, number>();

  for (const entry of entries) {
    const at = entry.at.getTime();
    if (at < anchor || at > now) continue;
    const cost = estimateCost(entry.model, entry.tokens) ?? 0;
    const index = Math.floor((at - anchor) / WEEK_MS);
    if (index === currentIndex) {
      current.tokens += entry.tokens.total;
      current.costUsd += cost;
    } else {
      completed.set(index, (completed.get(index) ?? 0) + cost);
    }
  }

  let completedMax = 0;
  for (const cost of completed.values()) completedMax = Math.max(completedMax, cost);
  return { current, completedMax };
}

/**
 * Reconstruct the session and weekly windows from local transcript activity.
 * `weeklyAnchor` should be the account's first-token date; without it the
 * oldest surviving entry is used, which is stable enough within a retention
 * period but will drift once transcripts age out.
 */
export function estimateSubscriptionWindows(
  entries: UsageEntry[],
  plan: SubscriptionPlan | null,
  weeklyAnchor: number | null,
): SubscriptionWindow[] {
  const now = Date.now();
  const budgets = budgetsFor(plan);
  const blocks = buildSessionBlocks(entries);
  const windows: SubscriptionWindow[] = [];

  // Only completed blocks calibrate the budget. The one in progress hasn't
  // had its full 5 hours to accumulate yet.
  const completed = blocks.filter((b) => b.end <= now);
  const sessionBudget = calibrate(
    budgets.session,
    completed.reduce((max, b) => Math.max(max, b.costUsd), 0),
  );

  const active = activeBlock(blocks, now);
  windows.push({
    key: 'session',
    label: 'Session (5h)',
    percent: active ? toPercent(active.costUsd, sessionBudget) : 0,
    // With no active block the next session starts on demand, so there is
    // nothing to count down to.
    resetAt: active ? new Date(active.end).toISOString() : null,
    usedTokens: active?.tokens ?? 0,
    usedUsd: active?.costUsd ?? 0,
  });

  const anchor = weeklyAnchor ?? (entries.length > 0 ? oldestEntryMs(entries) : null);
  if (anchor !== null) {
    const { current: week, completedMax } = weekBuckets(entries, anchor, now);
    const weekBudget = calibrate(budgets.week, completedMax);
    windows.push({
      key: 'week',
      label: 'Weekly',
      percent: toPercent(week.costUsd, weekBudget),
      resetAt: new Date(week.end).toISOString(),
      usedTokens: week.tokens,
      usedUsd: week.costUsd,
    });

    // The extra bucket only exists above Pro. It shares the weekly phase, so
    // the same anchor applies, only the entries counted differ.
    if (metersFableWeekly(plan)) {
      const fable = weekBuckets(
        entries.filter((e) => isFableModel(e.model)),
        anchor,
        now,
      );
      const fableBudget = calibrate(
        budgets.fableWeek ?? budgets.week * FABLE_WEEK_SHARE,
        fable.completedMax,
      );
      windows.push({
        key: 'week-fable',
        label: FABLE_WEEK_LABEL,
        percent: toPercent(fable.current.costUsd, fableBudget),
        resetAt: new Date(fable.current.end).toISOString(),
        usedTokens: fable.current.tokens,
        usedUsd: fable.current.costUsd,
      });
    }
  }

  return windows;
}

function oldestEntryMs(entries: UsageEntry[]): number {
  let oldest = Infinity;
  for (const entry of entries) oldest = Math.min(oldest, entry.at.getTime());
  return oldest;
}
