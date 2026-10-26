import { useEffect, useState } from 'react';

export type SystemStatsSample = Awaited<ReturnType<typeof window.runova.system.sample>>;

const SAMPLE_INTERVAL_MS = 2000;
const MAX_SAMPLES = 60;

export interface SystemStatsHistoryOptions {
  /** Set false to stop sampling (the last history is kept and returned). */
  enabled?: boolean;
  /** Gap between samples. Sampling shells out to the OS, so keep it modest. */
  intervalMs?: number;
  /** How many samples the returned history keeps. */
  maxSamples?: number;
}

/** Survives unmounts so leaving and reopening the dashboard doesn't wipe the charts. */
let cachedHistory: SystemStatsSample[] = [];

export function useSystemStatsHistory(
  options: SystemStatsHistoryOptions = {},
): SystemStatsSample[] {
  const { enabled = true, intervalMs = SAMPLE_INTERVAL_MS, maxSamples = MAX_SAMPLES } = options;
  // Seeded from the cache so a revisit redraws the last samples immediately
  // instead of shimmering from scratch while the first new one arrives.
  const [history, setHistory] = useState<SystemStatsSample[]>(cachedHistory);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      const started = Date.now();
      try {
        const sample = await window.runova.system.sample();
        if (cancelled) return;
        setHistory((prev) => {
          const next = [...prev.slice(-(MAX_SAMPLES - 1)), sample];
          cachedHistory = next;
          return next;
        });
      } catch {
        // Transient IPC/ping failures just skip a tick, the chart keeps its history.
      }
      if (cancelled) return;
      const wait = Math.max(0, intervalMs - (Date.now() - started));
      timeoutId = setTimeout(() => void tick(), wait);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [enabled, intervalMs]);

  return maxSamples < history.length ? history.slice(-maxSamples) : history;
}
