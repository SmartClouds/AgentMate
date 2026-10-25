import { describe, expect, it } from 'vitest';
import {
  cubicBezier,
  ease,
  hashString,
  keyframes,
  lerp,
  noise2,
  progress,
  seededRandom,
  spring,
  tween,
} from './motion.js';

describe('easing', () => {
  it('starts at 0, ends at 1 and clamps outside', () => {
    for (const [name, fn] of Object.entries(ease)) {
      expect(fn(0), name).toBeCloseTo(0, 6);
      expect(fn(1), name).toBeCloseTo(1, 6);
      expect(fn(-1), name).toBeCloseTo(0, 6);
      expect(fn(2), name).toBeCloseTo(1, 6);
    }
  });

  it('draws CSS cubic beziers the way CSS does', () => {
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5);
    // ease-in-out is symmetric around the middle.
    expect(ease.inOut(0.5)).toBeCloseTo(0.5, 5);
    expect(ease.inOut(0.25) + ease.inOut(0.75)).toBeCloseTo(1, 5);
    expect(ease.in(0.5)).toBeLessThan(0.5);
    expect(ease.out(0.5)).toBeGreaterThan(0.5);
  });

  it('overshoots with back and bounces with bounce', () => {
    expect(Math.max(...[0.6, 0.7, 0.8].map(ease.outBack))).toBeGreaterThan(1);
    expect(ease.outBounce(0.5)).toBeGreaterThan(0.5);
    const elastic = Array.from({ length: 50 }, (_, i) => ease.outElastic(i / 50));
    expect(Math.max(...elastic)).toBeGreaterThan(1);
    expect(ease.inOutCubic(0.25)).toBeLessThan(0.25);
    expect(ease.inOutCubic(0.75)).toBeGreaterThan(0.75);
    expect(ease.inCubic(0.5)).toBeCloseTo(0.125);
  });
});

describe('progress, tween and keyframes', () => {
  it('holds before and after, and handles a zero-length span', () => {
    expect(progress(1, 2, 4)).toBe(0);
    expect(progress(3, 2, 4)).toBe(0.5);
    expect(progress(5, 2, 4)).toBe(1);
    expect(progress(2, 2, 2)).toBe(1);
    expect(progress(1, 2, 2)).toBe(0);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    expect(tween(3, 0, 100, 2, 4, ease.linear)).toBe(50);
  });

  it('runs through keyframes in time order, whatever order they are given in', () => {
    const frames = [
      { at: 2, value: 100, easing: ease.linear },
      { at: 0, value: 0 },
      { at: 4, value: 50, easing: ease.linear },
    ];
    expect(keyframes(-1, frames)).toBe(0);
    expect(keyframes(1, frames)).toBe(50);
    expect(keyframes(3, frames)).toBe(75);
    expect(keyframes(9, frames)).toBe(50);
    expect(keyframes(1, [])).toBe(0);
  });
});

describe('spring', () => {
  it('rests at 0 before release and settles at 1, under, critically and over damped', () => {
    expect(spring(-1)).toBe(0);
    for (const options of [{}, { stiffness: 100, damping: 20 }, { damping: 60 }]) {
      expect(spring(5, options)).toBeCloseTo(1, 3);
    }
    // Underdamped: overshoots on the way.
    const samples = Array.from({ length: 60 }, (_, i) => spring(i / 60, { damping: 8 }));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it('is a function of time alone', () => {
    expect(spring(0.37)).toBe(spring(0.37));
  });
});

describe('seeded randomness', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Array.from({ length: 5 }, seededRandom(43))).not.toEqual(seqA);
    expect(hashString('scene')).toBe(hashString('scene'));
    expect(hashString('scene')).not.toBe(hashString('scenes'));
  });

  it('gives smooth noise that repeats and stays in range', () => {
    expect(noise2(1, 3.3, 4.4)).toBe(noise2(1, 3.3, 4.4));
    const near = Math.abs(noise2(1, 3.3, 4.4) - noise2(1, 3.301, 4.4));
    expect(near).toBeLessThan(0.01);
    for (let i = 0; i < 50; i++) {
      const v = noise2(7, i * 0.37, i * 0.11);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
