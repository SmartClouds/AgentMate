import type { SubscriptionUsage, SubscriptionWindow, SubscriptionWindowKey } from '@runova/core';
import type { RawLimit, RawLimits } from './logParsers';

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/**
 * Name a Codex window by how long it runs, not by its slot: a ChatGPT plan puts
 * the 5h session in `primary` and the week in `secondary`, while a free account
 * has a single 30-day window in `primary`.
 */
function describeWindow(minutes: number | null): { key: SubscriptionWindowKey; label: string } {
  if (minutes != null && minutes <= DAY_MINUTES) {
    const hours = Math.max(1, Math.round(minutes / 60));
    return { key: 'session', label: `Session (${hours}h)` };
  }
  if (minutes != null && minutes <= WEEK_MINUTES) return { key: 'week', label: 'Weekly' };
  return { key: 'month', label: 'Monthly' };
}

function toWindow(limit: RawLimit, now: number): SubscriptionWindow {
  const { key, label } = describeWindow(limit.minutes);
  const resetMs = limit.resetAt ? Date.parse(limit.resetAt) : NaN;
  // The numbers are as of the last Codex turn. A reset that has already passed
  // means the window rolled over since, so nothing of it is spent yet.
  if (!Number.isNaN(resetMs) && resetMs <= now) {
    return { key, label, percent: 0, resetAt: null };
  }
  return { key, label, percent: limit.percent, resetAt: limit.resetAt };
}

function planLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Codex's plan limits from the newest rate-limit snapshot in its logs. An API
 * key login reports no limits, so it gets no subscription block at all.
 */
export function codexSubscription(
  limits: RawLimits | undefined,
  now = Date.now(),
): SubscriptionUsage | undefined {
  if (!limits || limits.windows.length === 0) return undefined;

  const seen = new Set<SubscriptionWindowKey>();
  const windows: SubscriptionWindow[] = [];
  for (const limit of limits.windows) {
    const window = toWindow(limit, now);
    if (seen.has(window.key)) continue;
    seen.add(window.key);
    windows.push(window);
  }

  const planId = limits.planType?.trim().toLowerCase();
  return {
    mode: 'subscription',
    plan: planId ? { id: planId, label: planLabel(planId) } : null,
    windows,
    source: 'account',
    // As of the Codex turn that reported them, not this scan.
    readAt: new Date(limits.at).toISOString(),
  };
}
