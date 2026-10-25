/**
 * The motion helpers a scene animates with. Every one is a pure function of time, never of how
 * many frames came before, so any frame can be drawn on its own, in any order, and comes out the
 * same each time. That is what lets the render capture frame 900 without playing frames 1 to 899.
 */

export type Easing = (x: number) => number;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Cubic bezier easing, as CSS draws it, solved by Newton steps with a bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const bez = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (t: number, a: number, b: number) =>
    3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (x) => {
    const target = clamp01(x);
    if (target === 0 || target === 1) return target;
    let t = target;
    for (let i = 0; i < 8; i++) {
      const err = bez(t, x1, x2) - target;
      if (Math.abs(err) < 1e-7) return bez(t, y1, y2);
      const d = slope(t, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = target;
    for (let i = 0; i < 40; i++) {
      const v = bez(t, x1, x2);
      if (Math.abs(v - target) < 1e-7) break;
      if (v < target) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return bez(t, y1, y2);
  };
}

export const ease = {
  linear: (x: number) => clamp01(x),
  in: cubicBezier(0.42, 0, 1, 1),
  out: cubicBezier(0, 0, 0.58, 1),
  inOut: cubicBezier(0.42, 0, 0.58, 1),
  standard: cubicBezier(0.2, 0, 0, 1),
  inCubic: (x: number) => clamp01(x) ** 3,
  outCubic: (x: number) => 1 - (1 - clamp01(x)) ** 3,
  inOutCubic: (x: number) => {
    const t = clamp01(x);
    return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
  },
  outBack: (x: number) => {
    const t = clamp01(x);
    const c1 = 1.70158;
    return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
  outElastic: (x: number) => {
    const t = clamp01(x);
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1;
  },
  outBounce: (x: number) => {
    let t = clamp01(x);
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
} satisfies Record<string, Easing>;

/** Where `t` is between `start` and `end`, from 0 to 1. */
export function progress(t: number, start: number, end: number): number {
  if (end <= start) return t >= end ? 1 : 0;
  return clamp01((t - start) / (end - start));
}

export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/** A value moving from `from` to `to` between two times, held before and after. */
export function tween(
  t: number,
  from: number,
  to: number,
  start: number,
  end: number,
  easing: Easing = ease.inOut,
): number {
  return lerp(from, to, easing(progress(t, start, end)));
}

export interface Keyframe {
  at: number;
  value: number;
  /** Easing into this keyframe from the one before. */
  easing?: Easing;
}

/** A value through a list of keyframes, sorted by time; held before the first and after the last. */
export function keyframes(t: number, frames: readonly Keyframe[]): number {
  if (frames.length === 0) return 0;
  const sorted = [...frames].sort((a, b) => a.at - b.at);
  const first = sorted[0] as Keyframe;
  if (t <= first.at) return first.value;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i] as Keyframe;
    if (t <= next.at) {
      const prev = sorted[i - 1] as Keyframe;
      return tween(t, prev.value, next.value, prev.at, next.at, next.easing ?? ease.inOut);
    }
  }
  return (sorted.at(-1) as Keyframe).value;
}

export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
}

/**
 * A damped spring from 0 to 1, released at time 0, in closed form so it needs no stepping: the
 * value at 2.5 s is the same whether or not 2.4 s was ever drawn.
 */
export function spring(t: number, options: SpringOptions = {}): number {
  if (t <= 0) return 0;
  const k = options.stiffness ?? 170;
  const c = options.damping ?? 26;
  const m = options.mass ?? 1;
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/** A 32-bit hash of a string (FNV-1a), for seeding. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded random generator (mulberry32): the same seed gives the same sequence everywhere. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lattice(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise from 0 to 1, seeded; the same inputs always give the same value. */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = lattice(seed, xi, yi);
  const b = lattice(seed, xi + 1, yi);
  const c = lattice(seed, xi, yi + 1);
  const d = lattice(seed, xi + 1, yi + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
