import { secondsToFlicks } from '@agentmat/studio';
import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  tickLabel,
  tickStep,
  ticks,
  toFlicks,
  toPx,
} from './timeMath';

describe('timeline maths', () => {
  it('turns time into pixels and back at a zoom', () => {
    expect(toPx(secondsToFlicks(2.5), 100)).toBe(250);
    expect(toFlicks(250, 100)).toBe(secondsToFlicks(2.5));
  });

  it('fits the video into the width, within the zoom limits', () => {
    expect(fitZoom(secondsToFlicks(10), 1000)).toBe(92);
    expect(fitZoom(secondsToFlicks(36_000), 1000)).toBe(MIN_ZOOM);
    expect(fitZoom(secondsToFlicks(0.1), 1000)).toBe(MAX_ZOOM);
    expect(fitZoom(0, 1000)).toBe(60);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });

  it('spaces labelled ticks so the labels never crowd', () => {
    expect(tickStep(200)).toBe(0.5);
    expect(tickStep(50)).toBe(2);
    expect(tickStep(10)).toBe(10);
    expect(tickStep(0.01)).toBe(300);
    expect(ticks(3.2, 7, 2)).toEqual([2, 4, 6]);
    expect(ticks(-1, 1, 0.5)).toEqual([0, 0.5, 1]);
  });

  it('labels ticks in minutes and seconds', () => {
    expect(tickLabel(5)).toBe('0:05');
    expect(tickLabel(90)).toBe('1:30');
    expect(tickLabel(12.5)).toBe('0:12.5');
  });
});
