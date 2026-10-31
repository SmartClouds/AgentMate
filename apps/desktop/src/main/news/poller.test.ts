import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewsPoller } from './poller';

/**
 * When news is fetched (E42): 30 seconds after start, then every 30 minutes, backing off to 2
 * hours after 3 failures in a row and coming back after a success.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(results: boolean[] = []) {
  const poll = vi.fn(async () => results.shift() ?? true);
  const poller = createNewsPoller({ poll });
  return { poll, poller };
}

describe('the news poller', () => {
  it('waits 30 seconds after start before the first fetch', async () => {
    const { poll, poller } = setup();
    poller.start();

    await vi.advanceTimersByTimeAsync(29 * SECOND);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('then fetches every 30 minutes', async () => {
    const { poll, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND);

    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('backs off to 2 hours after 3 failures in a row and returns after a success', async () => {
    const { poll, poller } = setup([false, false, false, false, true, true]);
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND); // 1st, fails
    await vi.advanceTimersByTimeAsync(30 * MINUTE); // 2nd, fails
    await vi.advanceTimersByTimeAsync(30 * MINUTE); // 3rd, fails: back off
    expect(poll).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(119 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(MINUTE); // 4th, fails, still backing off
    expect(poll).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(120 * MINUTE); // 5th, succeeds
    expect(poll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(30 * MINUTE); // back to 30 minutes
    expect(poll).toHaveBeenCalledTimes(6);
  });

  it('counts a poll that throws as a failure and keeps going', async () => {
    const poll = vi.fn(async () => {
      throw new Error('boom');
    });
    const poller = createNewsPoller({ poll });
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND + 60 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('refreshes on demand and starts the 30 minutes over', async () => {
    const { poll, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    await expect(poller.refreshNow()).resolves.toBe(true);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('shares a refresh that is already running instead of starting another', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const poll = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const poller = createNewsPoller({ poll });

    const first = poller.refreshNow();
    const second = poller.refreshNow();
    finish(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('stops polling when stopped, and a second start does not double the timers', async () => {
    const { poll, poller } = setup();
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(poll).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
