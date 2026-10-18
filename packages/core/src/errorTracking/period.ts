import type { ErrorIssue, ErrorPeriod } from './types.js';

const HOUR_MS = 60 * 60 * 1000;

const PERIOD_MS: Record<ErrorPeriod, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '14d': 14 * 24 * HOUR_MS,
};

export function periodMs(period: ErrorPeriod): number {
  return PERIOD_MS[period];
}

/** First seen inside the period the list looks at. */
export function isNewIssue(
  issue: Pick<ErrorIssue, 'firstSeen'>,
  period: ErrorPeriod,
  now: number,
): boolean {
  const firstSeen = Date.parse(issue.firstSeen);
  // A date a little in the future (the clocks disagree) still reads as new.
  return Number.isFinite(firstSeen) && now - firstSeen <= periodMs(period);
}
