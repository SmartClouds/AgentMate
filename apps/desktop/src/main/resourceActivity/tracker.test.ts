import type { DockerObservation, EmulatorObservation } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceActivityTracker, type TrackerDeps } from './tracker';

/**
 * The tracker is a scheduler around pure reducers, so what matters here is the scheduling: one
 * reading at a time, backing off when Docker is gone, alerting once per idle stretch, and
 * stopping only what it knows about. Time is faked, so a 20 minute idle stretch costs nothing.
 */

const SEC = 1000;
const MIN = 60 * SEC;
const TICK = 30 * SEC;
const FIRST = 10 * SEC;

function container(overrides: Partial<DockerObservation> = {}): DockerObservation {
  return {
    id: 'c1',
    name: 'postgres',
    image: 'postgres:16',
    cpuPercent: 0,
    memBytes: 1000,
    netBytes: 100,
    blockBytes: 100,
    ...overrides,
  };
}

function emulator(overrides: Partial<EmulatorObservation> = {}): EmulatorObservation {
  return {
    serial: 'emulator-5554',
    avdName: 'Pixel_7',
    cpuPercent: 2,
    memBytes: 4000,
    measurable: true,
    ...overrides,
  };
}

interface Harness {
  tracker: ResourceActivityTracker;
  deps: {
    sampleDocker: ReturnType<typeof vi.fn>;
    sampleEmulators: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    stopContainer: ReturnType<typeof vi.fn>;
    stopEmulator: ReturnType<typeof vi.fn>;
  };
  settings: { idleMinutes: number; notify: boolean };
}

function setup(overrides: Partial<TrackerDeps> = {}): Harness {
  const settings = { idleMinutes: 20, notify: true };
  const deps = {
    sampleDocker: vi.fn(async () => ({ available: true, containers: [container()] })),
    sampleEmulators: vi.fn(async (): Promise<EmulatorObservation[] | null> => null),
    getSettings: vi.fn(async () => ({ ...settings })),
    notify: vi.fn(),
    stopContainer: vi.fn(async () => ({ ok: true })),
    stopEmulator: vi.fn(async () => ({ ok: true })),
  };
  const tracker = new ResourceActivityTracker({
    ...deps,
    tickMs: TICK,
    firstTickMs: FIRST,
    dockerRetryMs: 2 * MIN,
    ...overrides,
  });
  return { tracker, deps, settings };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduling', () => {
  it('waits for the first delay, then reads on every tick', async () => {
    const { tracker, deps } = setup();
    tracker.start();

    await vi.advanceTimersByTimeAsync(FIRST - 1);
    expect(deps.sampleDocker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(deps.sampleDocker).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it('never starts a reading while the last one is still running', async () => {
    let release: (() => void) | undefined;
    const slow = vi.fn(
      () =>
        new Promise<{ available: boolean; containers: DockerObservation[] }>((resolve) => {
          release = () => resolve({ available: true, containers: [] });
        }),
    );
    const { tracker } = setup({ sampleDocker: slow });
    tracker.start();

    await vi.advanceTimersByTimeAsync(FIRST + 5 * TICK);
    expect(slow).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(slow).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it('shares one reading between callers that ask at the same time', async () => {
    const { tracker, deps } = setup();
    await Promise.all([tracker.sampleNow(), tracker.sampleNow(), tracker.snapshot()]);
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);
  });

  it('stops reading once disposed', async () => {
    const { tracker, deps } = setup();
    tracker.start();
    await vi.advanceTimersByTimeAsync(FIRST);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(10 * TICK);
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);
  });

  it('does not start twice', async () => {
    const { tracker, deps } = setup();
    tracker.start();
    tracker.start();
    await vi.advanceTimersByTimeAsync(FIRST);
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('keeps ticking after a reading throws', async () => {
    const { tracker, deps } = setup();
    deps.sampleEmulators.mockRejectedValueOnce(new Error('boom'));
    deps.getSettings.mockRejectedValueOnce(new Error('settings unreadable'));
    tracker.start();
    await vi.advanceTimersByTimeAsync(FIRST + TICK);
    expect(deps.sampleEmulators).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });
});

describe('snapshot', () => {
  it('reads once on the first call even though the timer never started', async () => {
    const { tracker, deps } = setup();

    const first = await tracker.snapshot();
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);
    expect(first.docker).toBe('ready');
    expect(first.resources.map((one) => one.name)).toEqual(['postgres']);

    await tracker.snapshot();
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);
  });

  it('reads again when asked for a fresh one', async () => {
    const { tracker, deps } = setup();
    await tracker.snapshot();
    await tracker.snapshot({ fresh: true });
    expect(deps.sampleDocker).toHaveBeenCalledTimes(2);
  });

  it('keeps one chart point per reading, totals per kind', async () => {
    const { tracker, deps } = setup();
    deps.sampleEmulators.mockResolvedValue([emulator({ cpuPercent: 40, memBytes: 9000 })]);

    await tracker.sampleNow();
    await vi.advanceTimersByTimeAsync(TICK);
    await tracker.sampleNow();
    const { history } = await tracker.snapshot();

    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      dockerCount: 1,
      dockerMem: 1000,
      emulatorCount: 1,
      emulatorCpu: 40,
      emulatorMem: 9000,
    });
  });

  it('reports when the tracker started watching', async () => {
    const { tracker } = setup();
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const snapshot = await tracker.snapshot();
    expect(snapshot.watchingSince).toBeLessThanOrEqual(startedAt);
  });

  it('judges idleness against the current setting with no re-reading', async () => {
    const { tracker, deps, settings } = setup();
    tracker.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const reads = deps.sampleDocker.mock.calls.length;

    expect((await tracker.snapshot()).resources[0]?.idle).toBe(false);
    settings.idleMinutes = 5;
    const snapshot = await tracker.snapshot();

    expect(snapshot.idleMinutes).toBe(5);
    expect(snapshot.resources[0]?.idle).toBe(true);
    // Changing the threshold did not cost a Docker read.
    expect(deps.sampleDocker).toHaveBeenCalledTimes(reads);
    tracker.dispose();
  });

  it('reads again instead of trusting numbers that are more than two ticks old', async () => {
    const { tracker, deps, settings } = setup();
    settings.idleMinutes = 1;
    await tracker.sampleNow();
    // The computer slept: no timer ran for an hour.
    vi.setSystemTime(Date.now() + 60 * MIN);

    const snapshot = await tracker.snapshot();

    expect(deps.sampleDocker).toHaveBeenCalledTimes(2);
    // Time nobody was watching is not idle time, so the clock starts over.
    expect(snapshot.resources[0]).toMatchObject({ idle: false, idleForMs: 0 });
  });

  it('answers from memory while readings keep arriving on time', async () => {
    const { tracker, deps } = setup();
    tracker.start();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    const reads = deps.sampleDocker.mock.calls.length;

    await tracker.snapshot();
    await tracker.snapshot();

    expect(deps.sampleDocker).toHaveBeenCalledTimes(reads);
    tracker.dispose();
  });
});

describe('Docker availability', () => {
  it('marks Docker unavailable and drops its containers', async () => {
    const { tracker, deps } = setup();
    await tracker.sampleNow();
    deps.sampleDocker.mockResolvedValue({ available: false, containers: [] });
    await vi.advanceTimersByTimeAsync(TICK);
    await tracker.sampleNow();

    const snapshot = await tracker.snapshot();
    expect(snapshot.docker).toBe('unavailable');
    expect(snapshot.resources).toEqual([]);
  });

  it('leaves Docker alone for the retry delay after it could not be reached', async () => {
    const { tracker, deps } = setup();
    deps.sampleDocker.mockResolvedValue({ available: false, containers: [] });

    await tracker.sampleNow();
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK);
    await tracker.sampleNow();
    await vi.advanceTimersByTimeAsync(TICK);
    await tracker.sampleNow();
    expect(deps.sampleDocker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    await tracker.sampleNow();
    expect(deps.sampleDocker).toHaveBeenCalledTimes(2);
  });

  it('comes back when Docker starts', async () => {
    const { tracker, deps } = setup();
    deps.sampleDocker.mockResolvedValueOnce({ available: false, containers: [] });
    await tracker.sampleNow();

    await vi.advanceTimersByTimeAsync(3 * MIN);
    await tracker.sampleNow();

    const snapshot = await tracker.snapshot();
    expect(snapshot.docker).toBe('ready');
    expect(snapshot.resources).toHaveLength(1);
  });

  it('treats a throwing reader as Docker being unavailable', async () => {
    const { tracker, deps } = setup();
    deps.sampleDocker.mockRejectedValue(new Error('spawn docker ENOENT'));
    await tracker.sampleNow();
    expect((await tracker.snapshot()).docker).toBe('unavailable');
  });

  it('reports emulators as unavailable when there is nothing to look at', async () => {
    const { tracker } = setup();
    expect((await tracker.snapshot()).emulators).toBe('unavailable');
  });

  it('lists emulators beside containers', async () => {
    const { tracker, deps } = setup();
    deps.sampleEmulators.mockResolvedValue([emulator()]);
    const snapshot = await tracker.snapshot();
    expect(snapshot.emulators).toBe('ready');
    expect(snapshot.resources.map((one) => one.kind).sort()).toEqual(['docker', 'emulator']);
  });
});

describe('idle alerts', () => {
  async function runFor(tracker: ResourceActivityTracker, ms: number): Promise<void> {
    tracker.start();
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('alerts once when something has been idle for the threshold', async () => {
    const { tracker, deps } = setup();
    await runFor(tracker, 19 * MIN);
    expect(deps.notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith({
      title: '1 idle container',
      body: 'postgres has been idle for 20 min. Open the Dashboard to stop it.',
    });

    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('batches containers that go idle on the same reading into one alert', async () => {
    const { tracker, deps } = setup();
    deps.sampleDocker.mockResolvedValue({
      available: true,
      containers: [container({ id: 'a', name: 'db' }), container({ id: 'b', name: 'redis' })],
    });
    await runFor(tracker, 22 * MIN);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0]?.[0].title).toBe('2 idle containers');
    tracker.dispose();
  });

  it('stays quiet when alerts are off, and does not replay them when turned on later', async () => {
    const { tracker, deps, settings } = setup();
    settings.notify = false;
    await runFor(tracker, 25 * MIN);
    expect(deps.notify).not.toHaveBeenCalled();
    expect((await tracker.snapshot()).resources[0]?.idle).toBe(true);

    settings.notify = true;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deps.notify).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('alerts again after the resource was busy and then went quiet', async () => {
    const { tracker, deps } = setup();
    await runFor(tracker, 22 * MIN);
    expect(deps.notify).toHaveBeenCalledTimes(1);

    deps.sampleDocker.mockResolvedValue({
      available: true,
      containers: [container({ cpuPercent: 80 })],
    });
    await vi.advanceTimersByTimeAsync(TICK + 1);
    deps.sampleDocker.mockResolvedValue({ available: true, containers: [container()] });

    await vi.advanceTimersByTimeAsync(22 * MIN);
    expect(deps.notify).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it('never alerts about something that stays busy', async () => {
    const { tracker, deps } = setup();
    deps.sampleDocker.mockResolvedValue({
      available: true,
      containers: [container({ cpuPercent: 30 })],
    });
    await runFor(tracker, 60 * MIN);
    expect(deps.notify).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('does not count time the machine was asleep', async () => {
    const { tracker, deps } = setup();
    await runFor(tracker, 5 * MIN);
    tracker.dispose();

    // The timers did not run for an hour, as when a laptop sleeps.
    vi.setSystemTime(Date.now() + 60 * MIN);
    await tracker.sampleNow();
    expect(deps.notify).not.toHaveBeenCalled();
    expect((await tracker.snapshot()).resources[0]?.idle).toBe(false);
  });
});

describe('stop', () => {
  async function seeded(): Promise<Harness> {
    const harness = setup();
    harness.deps.sampleDocker.mockResolvedValue({
      available: true,
      containers: [container({ id: 'a', name: 'db' }), container({ id: 'b', name: 'redis' })],
    });
    harness.deps.sampleEmulators.mockResolvedValue([emulator()]);
    await harness.tracker.sampleNow();
    return harness;
  }

  it('stops a container and an emulator through the right function', async () => {
    const { tracker, deps } = await seeded();

    const outcome = await tracker.stop([
      { kind: 'docker', id: 'a' },
      { kind: 'emulator', id: 'emulator-5554' },
    ]);

    expect(deps.stopContainer).toHaveBeenCalledWith('a');
    expect(deps.stopEmulator).toHaveBeenCalledWith('emulator-5554');
    expect(outcome.results.map((one) => [one.name, one.ok])).toEqual([
      ['db', true],
      ['Pixel_7', true],
    ]);
  });

  it('drops what it stopped from the returned snapshot straight away', async () => {
    const { tracker } = await seeded();
    const outcome = await tracker.stop([{ kind: 'docker', id: 'a' }]);
    expect(outcome.snapshot.resources.map((one) => one.name).sort()).toEqual(['Pixel_7', 'redis']);
  });

  it('keeps a resource it failed to stop, with the reason', async () => {
    const { tracker, deps } = await seeded();
    deps.stopContainer.mockResolvedValue({ ok: false, error: 'permission denied' });

    const outcome = await tracker.stop([{ kind: 'docker', id: 'a' }]);

    expect(outcome.results[0]).toMatchObject({ ok: false, message: 'permission denied' });
    expect(outcome.snapshot.resources.map((one) => one.name)).toContain('db');
  });

  it('turns a throw into a failed result', async () => {
    const { tracker, deps } = await seeded();
    deps.stopEmulator.mockRejectedValue(new Error('adb went away'));

    const outcome = await tracker.stop([{ kind: 'emulator', id: 'emulator-5554' }]);

    expect(outcome.results[0]).toMatchObject({ ok: false, message: 'adb went away' });
  });

  it('refuses anything it is not tracking', async () => {
    const { tracker, deps } = await seeded();

    const outcome = await tracker.stop([{ kind: 'docker', id: 'not-mine' }]);

    expect(deps.stopContainer).not.toHaveBeenCalled();
    expect(outcome.results[0]).toMatchObject({ ok: false, skipped: 'gone' });
  });

  it('stops a duplicate reference only once', async () => {
    const { tracker, deps } = await seeded();
    await tracker.stop([
      { kind: 'docker', id: 'a' },
      { kind: 'docker', id: 'a' },
    ]);
    expect(deps.stopContainer).toHaveBeenCalledTimes(1);
  });

  it('skips something that is not idle when told to stop only idle ones', async () => {
    const { tracker, deps } = await seeded();

    const outcome = await tracker.stop([{ kind: 'docker', id: 'a' }], { onlyIfIdle: true });

    expect(deps.stopContainer).not.toHaveBeenCalled();
    expect(outcome.results[0]).toMatchObject({ ok: false, skipped: 'active' });
  });

  it('stops idle ones when told to stop only idle ones', async () => {
    const { tracker, deps } = await seeded();
    // Readings have to keep arriving, or the quiet stretch looks like a gap rather than idle time.
    tracker.start();
    await vi.advanceTimersByTimeAsync(21 * MIN);

    const outcome = await tracker.stop(
      [
        { kind: 'docker', id: 'a' },
        { kind: 'docker', id: 'b' },
      ],
      { onlyIfIdle: true },
    );

    expect(deps.stopContainer).toHaveBeenCalledTimes(2);
    expect(outcome.results.every((one) => one.ok)).toBe(true);
  });

  it('keeps the order it was asked in even when stops finish out of order', async () => {
    const { tracker, deps } = await seeded();
    deps.stopContainer.mockImplementation(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 500 : 10));
      return { ok: true };
    });

    const pending = tracker.stop([
      { kind: 'docker', id: 'a' },
      { kind: 'docker', id: 'b' },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await pending;

    expect(outcome.results.map((one) => one.name)).toEqual(['db', 'redis']);
  });

  it('never runs more than a few stops at once', async () => {
    const harness = setup();
    const ids = Array.from({ length: 10 }, (_, index) => `c${index}`);
    harness.deps.sampleDocker.mockResolvedValue({
      available: true,
      containers: ids.map((id) => container({ id, name: id })),
    });
    await harness.tracker.sampleNow();

    let running = 0;
    let peak = 0;
    harness.deps.stopContainer.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running -= 1;
      return { ok: true };
    });

    const pending = harness.tracker.stop(ids.map((id) => ({ kind: 'docker' as const, id })));
    await vi.advanceTimersByTimeAsync(2000);
    await pending;

    expect(peak).toBeLessThanOrEqual(4);
    expect(harness.deps.stopContainer).toHaveBeenCalledTimes(10);
  });
});
