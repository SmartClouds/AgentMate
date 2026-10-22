import type {
  MetricsResolution,
  MetricsSample,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { formatBytes } from '@/lib/format';

/**
 * The numbers behind a server's Overview charts: which stretch of history each range shows and
 * at what resolution, how live samples join what was already on screen, and how a reading is
 * put into words.
 */

export type MetricsRange = 'live' | '6h' | '48h' | '30d';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How much live history the core keeps in memory, and the app with it. */
export const LIVE_WINDOW_MS = 15 * MINUTE;

export interface RangeOption {
  value: MetricsRange;
  /** The button's text. */
  label: string;
  /** What the charts show, in a sentence: "the last 15 minutes". */
  description: string;
  resolution: MetricsResolution;
  spanMs: number;
  /** How often stored history is fetched again; live ranges stream instead. */
  refreshMs: number | null;
}

export const RANGES: readonly RangeOption[] = [
  {
    value: 'live',
    label: 'Live',
    description: 'the last 15 minutes, every 2 seconds',
    resolution: 'live',
    spanMs: LIVE_WINDOW_MS,
    refreshMs: null,
  },
  {
    value: '6h',
    label: '6 hours',
    description: 'the last 6 hours, one point a minute',
    resolution: 'minute',
    spanMs: 6 * HOUR,
    refreshMs: MINUTE,
  },
  {
    value: '48h',
    label: '2 days',
    description: 'the last 2 days, one point a minute',
    resolution: 'minute',
    spanMs: 2 * DAY,
    refreshMs: MINUTE,
  },
  {
    value: '30d',
    label: '30 days',
    description: 'the last 30 days, one point every 15 minutes',
    resolution: 'quarterHour',
    spanMs: 30 * DAY,
    refreshMs: 15 * MINUTE,
  },
];

export function rangeOption(range: MetricsRange): RangeOption {
  return RANGES.find((option) => option.value === range) ?? RANGES[0];
}

/**
 * Samples from both lists in time order, one per moment (a later copy wins, so a reconnect that
 * replays a few samples changes nothing), and none older than `windowMs` before the newest.
 */
export function mergeSamples(
  current: readonly MetricsSample[],
  incoming: readonly MetricsSample[],
  windowMs: number,
): MetricsSample[] {
  const byTime = new Map<number, MetricsSample>();
  for (const sample of current) byTime.set(sample.atUnixMs, sample);
  for (const sample of incoming) byTime.set(sample.atUnixMs, sample);
  const sorted = [...byTime.values()].sort((a, b) => a.atUnixMs - b.atUnixMs);
  const newest = sorted.at(-1)?.atUnixMs;
  if (newest === undefined) return sorted;
  const oldest = newest - windowMs;
  return sorted.filter((sample) => sample.atUnixMs >= oldest);
}

function share(used: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
}

export function memoryPercent(sample: MetricsSample): number {
  return share(sample.memoryUsedBytes, sample.memoryTotalBytes);
}

/** What the memory percentage stands for: "7.30 GB of 8.00 GB". */
export function memoryAmounts(sample: MetricsSample): string {
  return `${formatBytes(sample.memoryUsedBytes)} of ${formatBytes(sample.memoryTotalBytes)}`;
}

export function swapPercent(sample: MetricsSample): number {
  return share(sample.swapUsedBytes, sample.swapTotalBytes);
}

export function diskPercent(sample: MetricsSample): number {
  return share(sample.diskUsedBytes, sample.diskTotalBytes);
}

/** "0 B/s", "412 KB/s", "1.21 MB/s". */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** A whole percentage for tiles and ticks: "7%", "100%". */
export function wholePercent(percent: number): string {
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

/**
 * A round top for a rate axis, so its ticks read as plain numbers: the first 1, 2 or 5 times a
 * power of 1024 at or above the highest value. A quiet server still gets a 1 KB/s scale.
 */
export function niceRateMax(values: readonly number[]): number {
  const highest = Math.max(1024, ...values.filter(Number.isFinite));
  let base = 1;
  while (base * 1024 <= highest) base *= 1024;
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024]) {
    if (base * step >= highest) return base * step;
  }
  return base * 1024;
}

/** A moment on a chart's time axis: the clock for a day or less, the date as well for longer. */
export function formatAxisTime(unixMs: number, spanMs: number): string {
  const date = new Date(unixMs);
  const clock = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(spanMs <= LIVE_WINDOW_MS ? { second: '2-digit' } : {}),
    hour12: false,
  });
  if (spanMs <= DAY) return clock;
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return spanMs > 7 * DAY ? day : `${day} ${clock}`;
}

/** The same moment in a tooltip or table, to the second for live data. */
export function formatPointTime(unixMs: number, spanMs: number): string {
  const date = new Date(unixMs);
  const clock = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(spanMs <= LIVE_WINDOW_MS ? { second: '2-digit' } : {}),
    hour12: false,
  });
  if (spanMs <= DAY) return clock;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock}`;
}
