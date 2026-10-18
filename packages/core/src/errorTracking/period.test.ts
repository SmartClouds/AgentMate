import { describe, expect, it } from 'vitest';
import { isNewIssue, periodMs } from './period.js';
import { sentryIssue, sentryIssueWarning } from './testing/sentryFixtures.js';

const HOUR = 60 * 60 * 1000;

describe('periodMs', () => {
  it('turns each period into milliseconds', () => {
    expect(periodMs('24h')).toBe(24 * HOUR);
    expect(periodMs('7d')).toBe(7 * 24 * HOUR);
    expect(periodMs('14d')).toBe(14 * 24 * HOUR);
  });
});

describe('isNewIssue', () => {
  // Sentry's own timestamps carry six fractional digits, which Date still reads.
  const now = Date.parse('2026-10-18T10:00:00Z');

  it('is new when first seen inside the period', () => {
    expect(isNewIssue(sentryIssue, '7d', now)).toBe(true);
    expect(isNewIssue(sentryIssue, '24h', Date.parse('2026-10-18T08:00:00Z'))).toBe(true);
    // A little in the future (the clocks disagree) still reads as new.
    expect(isNewIssue({ firstSeen: '2026-10-18T10:01:00Z' }, '24h', now)).toBe(true);
  });

  it('is not new when first seen before the period', () => {
    expect(isNewIssue(sentryIssueWarning, '14d', now)).toBe(false);
    expect(isNewIssue({ firstSeen: '2026-10-17T09:59:59Z' }, '24h', now)).toBe(false);
  });

  it('counts the exact start of the period as new', () => {
    expect(isNewIssue({ firstSeen: '2026-10-17T10:00:00Z' }, '24h', now)).toBe(true);
  });

  it('is not new when the date is missing or unreadable', () => {
    expect(isNewIssue({ firstSeen: '' }, '24h', now)).toBe(false);
    expect(isNewIssue({ firstSeen: 'yesterday' }, '24h', now)).toBe(false);
  });
});
