import type { AndroidEvent } from '@runova/core';
import { sampleProcessTrees } from '../system/processTree';

/**
 * CPU and memory per running emulator.
 *
 * The sampler underneath is not cheap. On Windows it is a `Win32_Process` CIM query that takes
 * most of a second, so this only runs while a page is actually on screen asking for it, never
 * overlaps itself, and does nothing at all when no emulator is running. A background Runova
 * costs nothing.
 *
 * Watching is refcounted per window: closing one of two open windows must not stop the meters in
 * the other.
 */

export interface UsageSamplerDeps {
  /** The pid behind each running emulator we launched. Adopted ones have no pid and are skipped. */
  pidsBySerial(): Map<string, number>;
  emit(event: AndroidEvent): void;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 3000;

export class AndroidUsageSampler {
  private readonly watchers = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;

  constructor(private readonly deps: UsageSamplerDeps) {}

  private get intervalMs(): number {
    return this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** `windowId` so two open windows each count once and the last one out turns it off. */
  watch(windowId: number, enabled: boolean): void {
    if (enabled) this.watchers.add(windowId);
    else this.watchers.delete(windowId);

    if (this.watchers.size > 0) this.ensureTimer();
    else this.stopTimer();
  }

  private ensureTimer(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // The previous query can still be running on a slow machine; a second one would queue up
    // behind it and make everything worse.
    if (this.sampling) return;

    const pids = this.deps.pidsBySerial();
    if (pids.size === 0) return;

    this.sampling = true;
    try {
      const sample = await sampleProcessTrees([...pids.values()]);
      if (!sample.available) return;

      const bySerial: Record<
        string,
        { cpuPercent: number; memoryBytes: number; cpuReady: boolean }
      > = {};
      for (const [serial, pid] of pids) {
        const tree = sample.trees.get(pid);
        if (!tree?.found) continue;
        bySerial[serial] = {
          cpuPercent: tree.cpuPercent,
          memoryBytes: tree.memBytes,
          // False on the first sample on Windows and Linux, where CPU is a delta between two
          // readings. The card shows "measuring" rather than a 0% that reads as an idle emulator.
          cpuReady: sample.cpuReady,
        };
      }
      if (Object.keys(bySerial).length > 0) this.deps.emit({ kind: 'usage', bySerial });
    } catch {
      // A failed sample is not worth surfacing: the meters just do not move this tick.
    } finally {
      this.sampling = false;
    }
  }

  dispose(): void {
    this.stopTimer();
    this.watchers.clear();
  }
}
