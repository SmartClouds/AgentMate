import type {
  ContainerStatsBatch,
  ContainerStatsSample,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Live container figures on the Containers screen (E06): each running container's recent
 * samples, at most a few minutes of them, and the rates that the core's running totals give
 * (network and disk bytes per second between two samples).
 */

/** Three minutes at the stream's two seconds. */
export const MAX_POINTS = 90;

export type StatsHistory = ReadonlyMap<string, readonly ContainerStatsSample[]>;

/** Folds batches into the history: new samples go on the end, stopped containers drop out. */
export function mergeStats(
  history: StatsHistory,
  batches: readonly ContainerStatsBatch[],
  max = MAX_POINTS,
): StatsHistory {
  if (batches.length === 0) return history;
  const next = new Map(history);
  for (const batch of batches) {
    for (const sample of batch.samples) {
      const known = next.get(sample.containerId) ?? [];
      const last = known.at(-1);
      if (last && sample.atUnixMs <= last.atUnixMs) continue;
      next.set(sample.containerId, [...known, sample].slice(-max));
    }
    for (const id of batch.stopped) next.delete(id);
  }
  return next;
}

export interface Rates {
  atUnixMs: number[];
  receive: number[];
  transmit: number[];
  read: number[];
  write: number[];
}

/** Bytes per second between each sample and the one before it. A counter that went back is 0. */
export function ratesOf(samples: readonly ContainerStatsSample[]): Rates {
  const rates: Rates = { atUnixMs: [], receive: [], transmit: [], read: [], write: [] };
  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1];
    const after = samples[i];
    const seconds = (after.atUnixMs - before.atUnixMs) / 1000;
    if (seconds <= 0) continue;
    const per = (now: number, then: number) => Math.max(0, now - then) / seconds;
    rates.atUnixMs.push(after.atUnixMs);
    rates.receive.push(per(after.networkReceivedBytes, before.networkReceivedBytes));
    rates.transmit.push(per(after.networkTransmittedBytes, before.networkTransmittedBytes));
    rates.read.push(per(after.blockReadBytes, before.blockReadBytes));
    rates.write.push(per(after.blockWrittenBytes, before.blockWrittenBytes));
  }
  return rates;
}

/** Processor use as Docker shows it: 100% is one core, so four busy cores read 400%. */
export function cpuText(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** A memory limit Docker reports for a container without one is the host's memory. */
export function memoryShare(sample: ContainerStatsSample): number {
  return sample.memoryLimitBytes > 0 ? (sample.memoryUsedBytes / sample.memoryLimitBytes) * 100 : 0;
}
