import { describe, expect, it } from 'vitest';
import { monthAssessments, pacificDay } from './usage';

/**
 * Google counts the free checks per calendar month in Pacific time. `getMetrics` gives daily score
 * buckets from `startTime` on; this month's checks are the sum of this month's days.
 */

function day(count: number) {
  return { overallMetrics: { scoreBuckets: { '10': String(count - 1), '90': 1 } } };
}

describe('pacificDay', () => {
  it('reads the date as it is in California', () => {
    expect(pacificDay(new Date('2026-11-01T06:00:00Z'))).toBe('2026-10-31');
    expect(pacificDay(new Date('2026-11-01T09:00:00Z'))).toBe('2026-11-01');
  });
});

describe('monthAssessments', () => {
  it('adds up this month only, across keys', () => {
    const now = new Date('2026-10-30T18:00:00Z');
    const usage = monthAssessments(
      [
        // Sep 29, Sep 30, Oct 1, Oct 2 (Pacific midnight is 07:00 UTC in October).
        { startTime: '2026-09-29T07:00:00Z', scoreMetrics: [day(100), day(100), day(5), day(7)] },
        { startTime: '2026-10-15T07:00:00Z', scoreMetrics: [day(3)] },
      ],
      now,
    );
    expect(usage).toEqual({ month: '2026-10', assessments: 15 });
  });

  it('counts nothing for keys without metrics', () => {
    expect(
      monthAssessments(
        [{}, { startTime: 'not a date', scoreMetrics: [day(4)] }],
        new Date('2026-10-30T18:00:00Z'),
      ),
    ).toEqual({ month: '2026-10', assessments: 0 });
  });

  it('ignores counts that are not numbers', () => {
    expect(
      monthAssessments(
        [
          {
            startTime: '2026-10-01T07:00:00Z',
            scoreMetrics: [{ overallMetrics: { scoreBuckets: { '10': 'x', '20': '2' } } }],
          },
        ],
        new Date('2026-10-02T18:00:00Z'),
      ).assessments,
    ).toBe(2);
  });
});
