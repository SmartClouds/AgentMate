import type { RecaptchaUsage } from '../../../shared/deployRecaptchaTypes';
import type { GoogleKeyMetrics } from './client';

/**
 * This month's checks for a project, from each key's daily score metrics. Google counts the free
 * allowance per calendar month in Pacific time and starts each day of metrics at Pacific midnight,
 * so days are read as dates in that zone (from the middle of the day, which daylight saving
 * cannot push into a neighbor).
 */

const DAY_MS = 86_400_000;
const PACIFIC = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDay(date: Date): string {
  return PACIFIC.format(date);
}

export function monthAssessments(metrics: GoogleKeyMetrics[], now: Date): RecaptchaUsage {
  const month = pacificDay(now).slice(0, 7);
  let assessments = 0;
  for (const key of metrics) {
    const start = Date.parse(key.startTime ?? '');
    if (!Number.isFinite(start)) continue;
    (key.scoreMetrics ?? []).forEach((day, index) => {
      if (pacificDay(new Date(start + index * DAY_MS + DAY_MS / 2)).slice(0, 7) !== month) return;
      for (const count of Object.values(day.overallMetrics?.scoreBuckets ?? {})) {
        const value = Number(count);
        if (Number.isFinite(value)) assessments += value;
      }
    });
  }
  return { month, assessments };
}
