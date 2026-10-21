import { describe, expect, it } from 'vitest';
import { formatSpeed, linkQuality } from './linkQuality';

describe('linkQuality', () => {
  it('has no verdict until an answer time is known', () => {
    expect(linkQuality(null)).toBeNull();
  });

  it.each([
    [0, 'excellent', 4],
    [75, 'excellent', 4],
    [76, 'good', 3],
    [150, 'good', 3],
    [151, 'fair', 2],
    [300, 'fair', 2],
    [301, 'poor', 1],
    [2_000, 'poor', 1],
  ] as const)('rates %i ms as %s with %i bars', (ms, level, bars) => {
    expect(linkQuality(ms)).toMatchObject({ level, bars });
  });
});

describe('formatSpeed', () => {
  it('reads like a download speed', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(412 * 1024)).toBe('412 KB/s');
    expect(formatSpeed(1.21 * 1024 * 1024)).toBe('1.21 MB/s');
  });
});
