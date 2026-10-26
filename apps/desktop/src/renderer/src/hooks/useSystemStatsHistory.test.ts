import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';

/**
 * The hook polls the OS through the bridge and keeps a rolling window of samples. It also keeps
 * that window in a module level cache so leaving the dashboard and coming back redraws the chart
 * straight away, which is why every test here loads a fresh copy of the module unless it is the
 * one checking that the cache survives.
 */

type Loaded = typeof import('./useSystemStatsHistory').useSystemStatsHistory;

async function freshHook(): Promise<Loaded> {
  vi.resetModules();
  const module = await import('./useSystemStatsHistory');
  return module.useSystemStatsHistory;
}

/** A sample counter, so each tick is distinguishable in the returned history. */
function countingSampler(): () => Promise<{ cpu: number }> {
  let n = 0;
  return async () => ({ cpu: ++n });
}

function cpuValues(history: ReadonlyArray<unknown>): number[] {
  return history.map((entry) => (entry as { cpu: number }).cpu);
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('useSystemStatsHistory', () => {
  it('collects samples from the bridge', async () => {
    const useSystemStatsHistory = await freshHook();
    installRunovaBridge({ 'system.sample': countingSampler() });

    const { result } = renderHook(() => useSystemStatsHistory({ intervalMs: 5 }));

    await waitFor(() => expect(cpuValues(result.current).length).toBeGreaterThanOrEqual(3));
    // Samples arrive in order, oldest first, which is what the chart draws left to right.
    expect(cpuValues(result.current).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('does not sample at all when disabled', async () => {
    const useSystemStatsHistory = await freshHook();
    const bridge = installRunovaBridge({ 'system.sample': async () => ({ cpu: 1 }) });

    const { result } = renderHook(() => useSystemStatsHistory({ enabled: false }));

    expect(result.current).toEqual([]);
    // Nothing was called, so the mock behind the path was never even created.
    expect(() => bridge.$fn('system.sample')).toThrow();
  });

  it('keeps the ring buffer at sixty samples and trims the return to maxSamples', async () => {
    const useSystemStatsHistory = await freshHook();
    installRunovaBridge({ 'system.sample': countingSampler() });

    const { result, rerender } = renderHook(
      ({ maxSamples }: { maxSamples: number }) =>
        useSystemStatsHistory({ intervalMs: 0, maxSamples }),
      { initialProps: { maxSamples: 100 } },
    );

    // Sixty is the cap the hook keeps, so it never grows past that however long it polls.
    await waitFor(() => expect(result.current.length).toBe(60), { timeout: 10_000 });
    const oldest = cpuValues(result.current)[0] ?? 0;
    expect(oldest).toBeGreaterThan(1);

    rerender({ maxSamples: 5 });
    await waitFor(() => expect(result.current.length).toBe(5));
    const latest = cpuValues(result.current);
    expect(latest).toEqual([latest[0], latest[0] + 1, latest[0] + 2, latest[0] + 3, latest[0] + 4]);
  });

  it('skips a tick the bridge rejects instead of losing the history', async () => {
    const useSystemStatsHistory = await freshHook();
    let n = 0;
    installRunovaBridge({
      'system.sample': async () => {
        n += 1;
        if (n === 2) throw new Error('ping failed');
        return { cpu: n };
      },
    });

    const { result } = renderHook(() => useSystemStatsHistory({ intervalMs: 5 }));

    await waitFor(() => expect(cpuValues(result.current).length).toBeGreaterThanOrEqual(3));
    // The failed second sample is simply absent, the ones around it are still there.
    expect(cpuValues(result.current)).not.toContain(2);
    expect(cpuValues(result.current)[0]).toBe(1);
  });

  it('stops sampling once the component unmounts', async () => {
    const useSystemStatsHistory = await freshHook();
    const bridge = installRunovaBridge({ 'system.sample': countingSampler() });

    const { result, unmount } = renderHook(() => useSystemStatsHistory({ intervalMs: 5 }));
    await waitFor(() => expect(result.current.length).toBeGreaterThanOrEqual(2));
    unmount();

    const callsAtUnmount = bridge.$fn('system.sample').mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // At most the tick that was already in flight, never a new scheduled one.
    expect(bridge.$fn('system.sample').mock.calls.length).toBeLessThanOrEqual(callsAtUnmount + 1);
  });

  it('seeds a remount from the cached history so the chart does not start blank', async () => {
    const useSystemStatsHistory = await freshHook();
    installRunovaBridge({ 'system.sample': countingSampler() });

    const first = renderHook(() => useSystemStatsHistory({ intervalMs: 5 }));
    await waitFor(() => expect(first.result.current.length).toBeGreaterThanOrEqual(3));
    const before = first.result.current.length;
    first.unmount();

    // Same module, so the cache is the one the first mount filled.
    const second = renderHook(() => useSystemStatsHistory({ enabled: false }));
    expect(second.result.current.length).toBeGreaterThanOrEqual(before);
    expect(cpuValues(second.result.current)[0]).toBe(1);
  });
});
