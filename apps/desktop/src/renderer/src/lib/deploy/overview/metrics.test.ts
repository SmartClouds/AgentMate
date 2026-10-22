import { metricsSample } from '@shared/deploy/testing/fakeCoreData';
import { describe, expect, it } from 'vitest';
import {
  diskPercent,
  formatAxisTime,
  formatPointTime,
  formatRate,
  LIVE_WINDOW_MS,
  memoryAmounts,
  memoryPercent,
  mergeSamples,
  niceRateMax,
  RANGES,
  rangeOption,
  swapPercent,
  wholePercent,
} from './metrics';

const KB = 1024;
const MB = 1024 * KB;

describe('ranges', () => {
  it('reads stored history at the resolution that covers each span', () => {
    expect(RANGES.map((range) => [range.value, range.resolution])).toEqual([
      ['live', 'live'],
      ['6h', 'minute'],
      ['48h', 'minute'],
      ['30d', 'quarterHour'],
    ]);
    expect(rangeOption('30d').spanMs).toBe(30 * 86_400_000);
    expect(rangeOption('nope' as never).value).toBe('live');
  });
});

describe('mergeSamples', () => {
  it('keeps time order and one sample per moment, the later copy winning', () => {
    const a = metricsSample(1_000, 0);
    const b = metricsSample(3_000, 1);
    const replayed = { ...metricsSample(3_000, 2), cpuPercent: 99 };
    const merged = mergeSamples([b, a], [replayed, metricsSample(2_000, 3)], LIVE_WINDOW_MS);
    expect(merged.map((sample) => sample.atUnixMs)).toEqual([1_000, 2_000, 3_000]);
    expect(merged[2].cpuPercent).toBe(99);
  });

  it('drops what is older than the window before the newest sample', () => {
    const merged = mergeSamples([metricsSample(0), metricsSample(10_000)], [], 5_000);
    expect(merged.map((sample) => sample.atUnixMs)).toEqual([10_000]);
    expect(mergeSamples([], [], 5_000)).toEqual([]);
  });
});

describe('shares', () => {
  it('turns used and total into a percentage, with nothing for an empty total', () => {
    const sample = {
      ...metricsSample(0),
      memoryUsedBytes: 2,
      memoryTotalBytes: 8,
      swapUsedBytes: 5,
      swapTotalBytes: 0,
      diskUsedBytes: 9,
      diskTotalBytes: 3,
    };
    expect(memoryPercent(sample)).toBe(25);
    expect(swapPercent(sample)).toBe(0);
    expect(diskPercent(sample)).toBe(100);
  });

  it('says how much memory is in use out of the whole', () => {
    const GB = 1024 * MB;
    const sample = { ...metricsSample(0), memoryUsedBytes: 7.3 * GB, memoryTotalBytes: 8 * GB };
    expect(memoryAmounts(sample)).toBe('7.30 GB of 8.00 GB');
    expect(memoryAmounts({ ...sample, memoryUsedBytes: 512 * MB })).toBe('512 MB of 8.00 GB');
  });
});

describe('words', () => {
  it('says rates and whole percentages plainly', () => {
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(412 * KB)).toBe('412 KB/s');
    expect(wholePercent(7.4)).toBe('7%');
    expect(wholePercent(140)).toBe('100%');
    expect(wholePercent(-3)).toBe('0%');
  });

  it('rounds a rate axis up to 1, 2 or 5 of a unit', () => {
    expect(niceRateMax([])).toBe(KB);
    expect(niceRateMax([300])).toBe(KB);
    expect(niceRateMax([400 * KB])).toBe(500 * KB);
    expect(niceRateMax([1.5 * MB, Number.NaN])).toBe(2 * MB);
    expect(niceRateMax([900 * MB])).toBe(1024 * MB);
  });

  it('shows the clock for short spans and the date as well for longer ones', () => {
    const at = new Date(2026, 9, 1, 14, 5, 9).getTime();
    expect(formatAxisTime(at, 6 * 3_600_000)).toMatch(/14.05/);
    expect(formatAxisTime(at, LIVE_WINDOW_MS)).toMatch(/14.05.09/);
    expect(formatAxisTime(at, 6 * 3_600_000)).not.toMatch(/09/);
    expect(formatAxisTime(at, 2 * 86_400_000)).toMatch(/Oct.*14.05|14.05.*Oct/);
    expect(formatAxisTime(at, 30 * 86_400_000)).not.toMatch(/14.05/);
    expect(formatPointTime(at, LIVE_WINDOW_MS)).toMatch(/14.05.09/);
    expect(formatPointTime(at, 6 * 3_600_000)).not.toMatch(/09$/);
    expect(formatPointTime(at, 30 * 86_400_000)).toMatch(/Oct/);
  });
});
