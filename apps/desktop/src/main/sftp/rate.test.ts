import { describe, expect, it } from 'vitest';
import { RateMeter } from './rate';

/**
 * The transfer rate a batch shows (E25): nothing until there is a second to go on, a steady
 * stream gives its rate and an honest time left, bursts are averaged out, and the rate fades
 * once nothing moves.
 */

function meter(): { rate: RateMeter; advance: (ms: number) => void } {
  let now = 1_000_000;
  return {
    rate: new RateMeter(() => now),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('RateMeter', () => {
  it('says nothing before a second of samples', () => {
    const { rate, advance } = meter();
    expect(rate.bytesPerSecond()).toBeNull();
    expect(rate.eta(1000)).toBeNull();
    rate.add(50_000);
    advance(500);
    rate.add(50_000);
    expect(rate.bytesPerSecond()).toBeNull();
    advance(499);
    expect(rate.bytesPerSecond()).toBeNull();
  });

  it('gives the rate of a steady stream and the time left at it', () => {
    const { rate, advance } = meter();
    for (let step = 0; step < 30; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    expect(rate.bytesPerSecond()).toBeCloseTo(1_000_000, -4);
    expect(rate.eta(5_000_000)).toBe(5);
    expect(rate.eta(0)).toBe(0);
  });

  it('rounds the time left up to whole seconds', () => {
    const { rate, advance } = meter();
    for (let step = 0; step < 20; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    expect(rate.eta(1_500_000)).toBe(2);
  });

  it('smooths bursts into an average', () => {
    const { rate, advance } = meter();
    for (let second = 0; second < 4; second += 1) {
      rate.add(2_000_000);
      advance(1000);
    }
    // 2 MB arrives at the start of every second; the rate stays near 2 MB/s, not 2 MB per sample.
    const value = rate.bytesPerSecond() ?? 0;
    expect(value).toBeGreaterThan(1_500_000);
    expect(value).toBeLessThan(2_700_000);
  });

  it('decays when nothing moves, and goes quiet once the window is empty', () => {
    const { rate, advance } = meter();
    for (let step = 0; step < 30; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    const steady = rate.bytesPerSecond() ?? 0;
    advance(2000);
    const later = rate.bytesPerSecond() ?? 0;
    expect(later).toBeLessThan(steady);
    expect(later).toBeGreaterThan(0);
    advance(10_000);
    expect(rate.bytesPerSecond()).toBeNull();
    expect(rate.eta(1000)).toBeNull();
  });

  it('starts its clock again when bytes come after a long pause', () => {
    const { rate, advance } = meter();
    for (let step = 0; step < 20; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    advance(60_000);
    rate.add(100_000);
    expect(rate.bytesPerSecond()).toBeNull();
    for (let step = 0; step < 20; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    expect(rate.bytesPerSecond()).toBeCloseTo(1_050_000, -4);
  });

  it('ignores empty and negative samples', () => {
    const { rate, advance } = meter();
    rate.add(0);
    rate.add(-5);
    advance(2000);
    expect(rate.bytesPerSecond()).toBeNull();
  });

  it('starts over after reset', () => {
    const { rate, advance } = meter();
    for (let step = 0; step < 20; step += 1) {
      advance(100);
      rate.add(100_000);
    }
    rate.reset();
    expect(rate.bytesPerSecond()).toBeNull();
  });

  it('defaults to the wall clock', () => {
    const rate = new RateMeter();
    rate.add(10);
    expect(rate.bytesPerSecond()).toBeNull();
  });
});
