import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sampling an emulator's CPU and memory.
 *
 * The expensive part is the sampler itself: on Windows it is a CIM query that takes most of a
 * second. So it runs only while a page is actually watching, never overlaps itself, and stops
 * the moment the last watcher goes away.
 */

const state = vi.hoisted(() => ({
  samples: 0,
  /** Resolves when the test says so, to hold a sample open. */
  gate: null as null | (() => void),
  result: {
    available: true,
    cpuReady: true,
    trees: new Map<
      number,
      { rootPid: number; found: boolean; cpuPercent: number; memBytes: number }
    >(),
  },
}));

vi.mock('../system/processTree', () => ({
  sampleProcessTrees: async () => {
    state.samples += 1;
    if (state.gate) await new Promise<void>((resolve) => (state.gate = resolve));
    return state.result;
  },
}));

async function load() {
  vi.resetModules();
  return import('./usage');
}

beforeEach(() => {
  state.samples = 0;
  state.gate = null;
  state.result = { available: true, cpuReady: true, trees: new Map() };
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the usage sampler', () => {
  it('does nothing until a window asks to watch', async () => {
    const { AndroidUsageSampler } = await load();
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: () => undefined,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(100);

    // A background Runova must not run a CIM query every few seconds forever.
    expect(state.samples).toBe(0);
    sampler.dispose();
  });

  it('samples while watched and stops when the last watcher leaves', async () => {
    const { AndroidUsageSampler } = await load();
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: () => undefined,
      intervalMs: 10,
    });

    sampler.watch(1, true);
    await vi.advanceTimersByTimeAsync(35);
    expect(state.samples).toBeGreaterThan(0);

    const taken = state.samples;
    sampler.watch(1, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(state.samples).toBe(taken);
    sampler.dispose();
  });

  it('keeps sampling while a second window is still watching', async () => {
    const { AndroidUsageSampler } = await load();
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: () => undefined,
      intervalMs: 10,
    });

    sampler.watch(1, true);
    sampler.watch(2, true);
    // Closing one window must not stop the meters in the other.
    sampler.watch(1, false);
    await vi.advanceTimersByTimeAsync(35);

    expect(state.samples).toBeGreaterThan(0);
    sampler.dispose();
  });

  it('does nothing when no emulator is running', async () => {
    const { AndroidUsageSampler } = await load();
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map(),
      emit: () => undefined,
      intervalMs: 10,
    });

    sampler.watch(1, true);
    await vi.advanceTimersByTimeAsync(50);

    expect(state.samples).toBe(0);
    sampler.dispose();
  });

  it('never overlaps two samples, since the Windows query is slow', async () => {
    const { AndroidUsageSampler } = await load();
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: () => undefined,
      intervalMs: 10,
    });
    state.gate = () => undefined;

    sampler.watch(1, true);
    await vi.advanceTimersByTimeAsync(100);

    expect(state.samples).toBe(1);
    sampler.dispose();
  });

  it('reports usage keyed by serial', async () => {
    const { AndroidUsageSampler } = await load();
    const emitted: unknown[] = [];
    state.result = {
      available: true,
      cpuReady: true,
      trees: new Map([[1000, { rootPid: 1000, found: true, cpuPercent: 12, memBytes: 2048 }]]),
    };
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: (event) => emitted.push(event),
      intervalMs: 10,
    });

    sampler.watch(1, true);
    await vi.advanceTimersByTimeAsync(15);

    expect(emitted[0]).toEqual({
      kind: 'usage',
      bySerial: { 'emulator-5554': { cpuPercent: 12, memoryBytes: 2048, cpuReady: true } },
    });
    sampler.dispose();
  });

  it('marks the first sample as not having a CPU rate yet', async () => {
    const { AndroidUsageSampler } = await load();
    const emitted: { bySerial: Record<string, { cpuReady: boolean }> }[] = [];
    state.result = {
      available: true,
      cpuReady: false,
      trees: new Map([[1000, { rootPid: 1000, found: true, cpuPercent: 0, memBytes: 2048 }]]),
    };
    const sampler = new AndroidUsageSampler({
      pidsBySerial: () => new Map([['emulator-5554', 1000]]),
      emit: (event) => emitted.push(event as never),
      intervalMs: 10,
    });

    sampler.watch(1, true);
    await vi.advanceTimersByTimeAsync(15);

    // CPU is a delta between two readings, so the first one genuinely has no rate to report.
    expect(emitted[0].bySerial['emulator-5554'].cpuReady).toBe(false);
    sampler.dispose();
  });
});
