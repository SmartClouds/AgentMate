import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptLimiter } from './attemptLimiter';
import { ClipboardGuard, type ClipboardPort } from './clipboardGuard';
import { IdleTimer } from './idleLock';
import { resolveVaultTimers } from './timers';

describe('AttemptLimiter', () => {
  it('lets the first two failures through and then doubles the wait up to the cap', () => {
    const limiter = new AttemptLimiter({ freeFailures: 2, baseMs: 1000, maxMs: 8000 });
    const waits: number[] = [];
    let now = 0;
    for (let i = 0; i < 7; i++) {
      now += limiter.retryAfterMs(now);
      limiter.recordFailure(now);
      waits.push(limiter.retryAfterMs(now));
    }
    expect(waits).toEqual([0, 0, 1000, 2000, 4000, 8000, 8000]);
  });

  it('counts the wait down as time passes', () => {
    const limiter = new AttemptLimiter({ freeFailures: 0, baseMs: 1000, maxMs: 30_000 });
    limiter.recordFailure(10_000);
    expect(limiter.retryAfterMs(10_000)).toBe(1000);
    expect(limiter.retryAfterMs(10_400)).toBe(600);
    expect(limiter.retryAfterMs(11_000)).toBe(0);
  });

  it('starts over after a success', () => {
    const limiter = new AttemptLimiter({ freeFailures: 1, baseMs: 1000, maxMs: 30_000 });
    limiter.recordFailure(0);
    limiter.recordFailure(0);
    expect(limiter.retryAfterMs(0)).toBe(1000);
    limiter.reset();
    expect(limiter.retryAfterMs(0)).toBe(0);
  });

  it('can change its base delay later', () => {
    const limiter = new AttemptLimiter({ freeFailures: 0, baseMs: 1000, maxMs: 30_000 });
    limiter.setBaseMs(200);
    limiter.recordFailure(0);
    expect(limiter.retryAfterMs(0)).toBe(200);
  });
});

describe('IdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the idle period', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.arm(60_000);
    vi.advanceTimersByTime(59_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('pushes the deadline back on activity', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.arm(1000);
    vi.advanceTimersByTime(800);
    timer.touch();
    vi.advanceTimersByTime(800);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does nothing when set to never, stopped, or touched while not armed', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.touch();
    timer.arm(null);
    timer.touch();
    vi.advanceTimersByTime(10 ** 9);
    timer.arm(1000);
    timer.stop();
    timer.touch();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('re-arms with a new period, measured from now', () => {
    const onExpire = vi.fn();
    const timer = new IdleTimer(onExpire);
    timer.arm(10_000);
    vi.advanceTimersByTime(9000);
    timer.arm(5000);
    vi.advanceTimersByTime(4999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

describe('ClipboardGuard', () => {
  let clipboardText = '';
  const clipboard: ClipboardPort = {
    readText: () => clipboardText,
    writeText: (text) => {
      clipboardText = text;
    },
  };

  beforeEach(() => {
    clipboardText = 'before';
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies, reports when it will clear, and clears on time', () => {
    const onSettled = vi.fn();
    const guard = new ClipboardGuard(clipboard, onSettled);
    expect(guard.copy('S3CRET', 30_000)).toEqual({ clearsAt: 1_030_000 });
    expect(clipboardText).toBe('S3CRET');
    vi.advanceTimersByTime(29_999);
    expect(clipboardText).toBe('S3CRET');
    vi.advanceTimersByTime(1);
    expect(clipboardText).toBe('');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ cleared: true });
  });

  it('leaves the clipboard alone when something else was copied since', () => {
    const onSettled = vi.fn();
    const guard = new ClipboardGuard(clipboard, onSettled);
    guard.copy('S3CRET', 1000);
    clipboardText = 'my own note';
    vi.advanceTimersByTime(1000);
    expect(clipboardText).toBe('my own note');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ cleared: false });
  });

  it('restarts the timer for a second copy', () => {
    const onSettled = vi.fn();
    const guard = new ClipboardGuard(clipboard, onSettled);
    guard.copy('first', 1000);
    vi.advanceTimersByTime(900);
    guard.copy('second', 1000);
    vi.advanceTimersByTime(900);
    expect(clipboardText).toBe('second');
    vi.advanceTimersByTime(100);
    expect(clipboardText).toBe('');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('never clears when the delay is null', () => {
    const onSettled = vi.fn();
    const guard = new ClipboardGuard(clipboard, onSettled);
    expect(guard.copy('keep', null)).toEqual({ clearsAt: null });
    vi.advanceTimersByTime(10 ** 9);
    expect(clipboardText).toBe('keep');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('clears right away on request, only if the text is still ours', () => {
    const onSettled = vi.fn();
    const guard = new ClipboardGuard(clipboard, onSettled);
    expect(guard.clearIfOurs()).toBe(false);
    guard.copy('S3CRET', 60_000);
    expect(guard.clearIfOurs()).toBe(true);
    expect(clipboardText).toBe('');
    expect(onSettled).toHaveBeenCalledExactlyOnceWith({ cleared: true });
    vi.advanceTimersByTime(60_000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not keep the copied text around in memory', () => {
    const guard = new ClipboardGuard(clipboard, vi.fn());
    guard.copy('S3CRET-in-memory', 60_000);
    expect(JSON.stringify(guard)).not.toContain('S3CRET');
  });
});

describe('resolveVaultTimers', () => {
  const settings = { vaultAutoLockMinutes: 15, vaultClipboardClearSeconds: 30 };

  it('converts the settings, with 0 meaning never', () => {
    expect(resolveVaultTimers(settings, {}, true)).toEqual({
      autoLockMs: 15 * 60_000,
      clipboardClearMs: 30_000,
      backoffBaseMs: 1000,
    });
    expect(
      resolveVaultTimers({ vaultAutoLockMinutes: 0, vaultClipboardClearSeconds: 0 }, {}, true),
    ).toEqual({ autoLockMs: null, clipboardClearMs: null, backoffBaseMs: 1000 });
  });

  it('uses the test override only in an unpackaged build', () => {
    const env = {
      RUNOVA_VAULT_TEST_TIMERS: 'autoLockMs=4000,clipboardMs=2000,backoffBaseMs=300',
    };
    expect(resolveVaultTimers(settings, env, false)).toEqual({
      autoLockMs: 4000,
      clipboardClearMs: 2000,
      backoffBaseMs: 300,
    });
    expect(resolveVaultTimers(settings, env, true)).toEqual(resolveVaultTimers(settings, {}, true));
  });

  it('clamps overrides to a sane minimum and ignores junk', () => {
    const env = {
      RUNOVA_VAULT_TEST_TIMERS: 'autoLockMs=5,clipboardMs=abc,unknown=1,backoffBaseMs',
    };
    expect(resolveVaultTimers(settings, env, false)).toEqual({
      autoLockMs: 200,
      clipboardClearMs: 30_000,
      backoffBaseMs: 1000,
    });
  });
});
