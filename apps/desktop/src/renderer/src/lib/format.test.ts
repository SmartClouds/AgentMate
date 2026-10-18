import { describe, expect, it } from 'vitest';
import { formatBytes, formatCelsius, formatPercent } from './format';

describe('formatBytes', () => {
  it('reads nothing as zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    // A missing reading arrives as a negative or non-finite number often enough to matter.
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('keeps raw bytes whole and starts decimals at the next unit', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
  });

  it('never prints a four digit byte count', () => {
    // The step-up guard applies to raw bytes too, so 1000 B reads as a fraction of a KB
    // rather than as "1000 B".
    expect(formatBytes(1000)).toBe('0.98 KB');
    expect(formatBytes(1023)).toBe('1.00 KB');
  });

  it('shows about three significant digits at every size', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(58.4 * 1024 * 1024)).toBe('58.4 MB');
    expect(formatBytes(467 * 1024 * 1024)).toBe('467 MB');
    expect(formatBytes(9.28 * 1024 * 1024 * 1024)).toBe('9.28 GB');
  });

  it('steps up a unit rather than rounding to a four digit number', () => {
    // 999.6 MB would print as "1000 MB", which is both wrong-looking and four digits.
    expect(formatBytes(999.6 * 1024 * 1024)).toBe('0.98 GB');
    expect(formatBytes(1023.9 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('stops at terabytes, the largest unit it knows', () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.00 TB');
    expect(formatBytes(4096 * 1024 ** 4)).toBe('4096 TB');
  });
});

describe('formatPercent', () => {
  it('calls out a trace of CPU rather than printing 0.0%', () => {
    expect(formatPercent(0.04)).toBe('<0.1%');
    expect(formatPercent(0.0999)).toBe('<0.1%');
  });

  it('shows one decimal below ten percent and whole numbers above', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(0.1)).toBe('0.1%');
    expect(formatPercent(4.25)).toBe('4.3%');
    expect(formatPercent(10)).toBe('10%');
    expect(formatPercent(43.6)).toBe('44%');
    expect(formatPercent(100)).toBe('100%');
  });
});

describe('formatCelsius', () => {
  it('rounds to whole degrees, since sensors are not finer than that', () => {
    expect(formatCelsius(61)).toBe('61 °C');
    expect(formatCelsius(52.4)).toBe('52 °C');
    expect(formatCelsius(52.5)).toBe('53 °C');
    expect(formatCelsius(105)).toBe('105 °C');
  });
});
