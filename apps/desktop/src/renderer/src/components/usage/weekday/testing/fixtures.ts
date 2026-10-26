import {
  emptyUsageTokens,
  type ProjectDaily,
  type ProjectDailyUsage,
  type ProviderUsage,
  type UsagePeriod,
} from '@runova/core';
import { addDays, weekdayOfDay } from '@/lib/projectWeekday';

/** Tuesday 13 October 2026: the last day of every fixture window. */
export const END_DAY = '2026-10-13';

const emptyPeriod: UsagePeriod = { tokens: emptyUsageTokens(), costUsd: null };

/** Twenty-eight daily values, oldest first, each taken from the weekday its day falls on. */
export function byWeekday(weekdayValues: readonly number[], endDay = END_DAY, days = 28): number[] {
  return Array.from({ length: days }, (_, index) => {
    const day = addDays(endDay, index - (days - 1));
    const weekday = day === null ? null : weekdayOfDay(day);
    return weekday === null ? 0 : (weekdayValues[weekday] ?? 0);
  });
}

/**
 * One project's row of the split. The per-weekday values are Sunday first (index 0 is Sunday), and
 * each day of the window takes the value of its weekday.
 */
export function projectRow(options: {
  key: string;
  name: string;
  path?: string | null;
  tokens: readonly number[];
  costUsd?: readonly number[];
  unpriced?: readonly number[];
  endDay?: string;
}): ProjectDailyUsage {
  const endDay = options.endDay ?? END_DAY;
  return {
    key: options.key,
    name: options.name,
    path: options.path ?? null,
    tokens: byWeekday(options.tokens, endDay),
    costUsd: byWeekday(options.costUsd ?? options.tokens.map(() => 0), endDay),
    unpricedTokens: byWeekday(options.unpriced ?? options.tokens.map(() => 0), endDay),
  };
}

export function splitOf(projects: ProjectDailyUsage[], endDay = END_DAY): ProjectDaily {
  return { endDay, projects };
}

/** A provider's usage, carrying the split when one is given. */
export function usageOf(providerId: string, daily?: ProjectDaily): ProviderUsage {
  return {
    providerId,
    status: 'ok',
    today: emptyPeriod,
    last7d: emptyPeriod,
    last30d: emptyPeriod,
    currency: 'USD',
    updatedAt: '2026-10-13T12:00:00.000Z',
    ...(daily ? { projectDaily: daily } : {}),
  };
}
