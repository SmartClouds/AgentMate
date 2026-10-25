import { describe, expect, it } from 'vitest';
import { runDuration, spanDuration } from './runStatus';

describe('spanDuration', () => {
  it('reads seconds, minutes and hours the way GitHub does', () => {
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:45Z')).toBe('45s');
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:01:05Z')).toBe('1m 5s');
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T11:02:30Z')).toBe('2h 2m');
  });

  it('shows a step that took no time as 0s instead of hiding it', () => {
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:00Z')).toBe('0s');
    expect(spanDuration('2026-03-15T09:00:00.000Z', '2026-03-15T09:00:00.400Z')).toBe('0s');
  });

  it('is empty when a time is missing, so a step that has not started shows nothing', () => {
    expect(spanDuration(null, '2026-03-15T09:00:45Z')).toBe('');
    expect(spanDuration('2026-03-15T09:00:00Z', null)).toBe('');
    expect(spanDuration(undefined, undefined)).toBe('');
  });

  it('is empty for a reversed or unreadable pair', () => {
    expect(spanDuration('2026-03-15T09:01:00Z', '2026-03-15T09:00:00Z')).toBe('');
    expect(spanDuration('not a date', '2026-03-15T09:00:00Z')).toBe('');
  });

  it('counts up to the given clock while the end is still open', () => {
    const now = Date.parse('2026-03-15T09:02:03Z');
    expect(spanDuration('2026-03-15T09:00:00Z', null, now)).toBe('2m 3s');
    // A finished span ignores the clock.
    expect(spanDuration('2026-03-15T09:00:00Z', '2026-03-15T09:00:10Z', now)).toBe('10s');
  });
});

describe('runDuration', () => {
  it('still measures from created to updated', () => {
    expect(
      runDuration({ createdAt: '2026-03-15T09:00:00Z', updatedAt: '2026-03-15T09:04:12Z' }),
    ).toBe('4m 12s');
    expect(runDuration({ createdAt: 'nope', updatedAt: '2026-03-15T09:04:12Z' })).toBe('');
  });
});
