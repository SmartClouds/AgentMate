import { describe, expect, it } from 'vitest';
import { limiter } from './limiter';

describe('limiter', () => {
  it('runs at most the given number of calls at once, in arrival order', async () => {
    const queue = limiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const work = (id: number) =>
      queue(async () => {
        started.push(id);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return id;
      });

    const all = Promise.all([1, 2, 3, 4].map(work));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([1, 2]);
    while (releases.length) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(await all).toEqual([1, 2, 3, 4]);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('frees the slot when a call fails', async () => {
    const queue = limiter(1);

    await expect(queue(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue(async () => 'next')).resolves.toBe('next');
  });
});
