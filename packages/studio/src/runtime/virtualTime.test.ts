import { describe, expect, it, vi } from 'vitest';
import { installVirtualTime, VIRTUAL_EPOCH } from './virtualTime.js';

/** A stand-in for a page's window with the globals the clock replaces. */
function fakeWindow() {
  const win = {
    Date,
    Math: Object.create(Math) as Math,
    performance: { now: () => 123 },
    setTimeout: vi.fn(() => 0),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(() => 0),
    cancelAnimationFrame: vi.fn(),
  };
  return win as unknown as Window & typeof globalThis;
}

describe('installVirtualTime', () => {
  it('stops the clocks at zero until time is moved', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    expect(win.performance.now()).toBe(0);
    expect(win.Date.now()).toBe(VIRTUAL_EPOCH);
    expect(new win.Date().getTime()).toBe(VIRTUAL_EPOCH);
    // A date built from a value is left alone.
    expect(new win.Date(0).getTime()).toBe(0);
    clock.advanceTo(1500);
    expect(win.performance.now()).toBe(1500);
    expect(win.Date.now()).toBe(VIRTUAL_EPOCH + 1500);
    expect(clock.now()).toBe(1500);
  });

  it('runs timers in time order as time passes, each at its own moment', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    const seen: [string, number][] = [];
    win.setTimeout(() => seen.push(['b', win.performance.now()]), 200);
    win.setTimeout(() => seen.push(['a', win.performance.now()]), 100);
    const id = win.setTimeout(() => seen.push(['never', 0]), 150);
    win.clearTimeout(id);
    win.setTimeout((x: string) => seen.push([x, win.performance.now()]), 200, 'c');
    clock.advanceTo(150);
    expect(seen).toEqual([['a', 100]]);
    clock.advanceTo(1000);
    expect(seen).toEqual([
      ['a', 100],
      ['b', 200],
      ['c', 200],
    ]);
  });

  it('repeats intervals until cleared', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    const ticks: number[] = [];
    const id = win.setInterval(() => ticks.push(win.performance.now()), 100);
    clock.advanceTo(350);
    expect(ticks).toEqual([100, 200, 300]);
    win.clearInterval(id);
    clock.advanceTo(1000);
    expect(ticks).toHaveLength(3);
  });

  it('runs one animation frame per step, with the frame time, and queues new requests for the next', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    const frames: number[] = [];
    const loop = (time: number) => {
      frames.push(time);
      win.requestAnimationFrame(loop);
    };
    win.requestAnimationFrame(loop);
    const cancelled = win.requestAnimationFrame(() => frames.push(-1));
    win.cancelAnimationFrame(cancelled);
    clock.advanceTo(33);
    clock.advanceTo(66);
    expect(frames).toEqual([33, 66]);
  });

  it('gives the same random numbers for the same moment, whatever came before', () => {
    const a = fakeWindow();
    const clockA = installVirtualTime(a, { seed: 'scene-1' });
    clockA.advanceTo(500);
    const first = [a.Math.random(), a.Math.random()];

    const b = fakeWindow();
    const clockB = installVirtualTime(b, { seed: 'scene-1' });
    clockB.advanceTo(100);
    b.Math.random();
    clockB.advanceTo(500);
    expect([b.Math.random(), b.Math.random()]).toEqual(first);

    const c = fakeWindow();
    installVirtualTime(c, { seed: 'scene-2' }).advanceTo(500);
    expect(c.Math.random()).not.toBe(first[0]);
  });

  it('clamps a timer chain to 4 ms steps, so a polling loop cannot starve the timers after it', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    const spins: number[] = [];
    const spin = () => {
      spins.push(win.performance.now());
      win.setTimeout(spin, 0);
    };
    win.setTimeout(spin, 0);
    let later = -1;
    win.setTimeout(() => {
      later = win.performance.now();
    }, 10);
    clock.advanceTo(20);
    expect(later).toBe(10);
    // Five levels run at once, then each step waits 4 ms.
    expect(spins.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 4, 8]);
    expect(clock.problems).toEqual([]);
  });

  it('stops a timer that keeps multiplying, and keeps going after a callback throws', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    const fork = () => {
      win.setTimeout(fork, 0);
      win.setTimeout(fork, 0);
    };
    win.setTimeout(fork, 0);
    win.setTimeout(() => {
      throw new Error('boom');
    }, 0);
    clock.advanceTo(1000);
    expect(clock.problems.some((p) => /threw: boom/.test(p))).toBe(true);
    expect(clock.problems.some((p) => /without end/.test(p))).toBe(true);
  });

  it('keeps an interval at 4 ms or more', () => {
    const win = fakeWindow();
    const clock = installVirtualTime(win, { seed: 's' });
    let ticks = 0;
    win.setInterval(() => ticks++, 0);
    clock.advanceTo(40);
    // At 0, then every 4 ms up to and including 40.
    expect(ticks).toBe(11);
  });

  it('ignores a timer that is not a function and keeps the real timers for the runtime', () => {
    const win = fakeWindow();
    const realSet = win.setTimeout;
    const clock = installVirtualTime(win, { seed: 's' });
    expect(typeof win.setTimeout('code' as unknown as () => void, 10)).toBe('number');
    clock.advanceTo(100);
    clock.real.setTimeout(() => undefined, 1);
    expect(realSet).toHaveBeenCalled();
  });
});
