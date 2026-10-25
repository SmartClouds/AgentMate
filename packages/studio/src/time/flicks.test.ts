import { describe, expect, it } from 'vitest';
import {
  FLICKS_PER_SECOND,
  flicksToFrame,
  flicksToSamples,
  flicksToSeconds,
  formatTimecode,
  framesToFlicks,
  quantizeToFrame,
  samplesToFlicks,
  secondsToFlicks,
} from './flicks.js';

describe('flicks', () => {
  it('divides a second exactly for every frame rate and sample rate Studio uses', () => {
    for (const fps of [24, 25, 30, 48, 50, 60]) {
      expect(FLICKS_PER_SECOND % fps).toBe(0);
    }
    for (const rate of [44_100, 48_000]) {
      expect(FLICKS_PER_SECOND % rate).toBe(0);
    }
  });

  it('converts seconds both ways, rounding to whole flicks', () => {
    expect(secondsToFlicks(1)).toBe(FLICKS_PER_SECOND);
    expect(secondsToFlicks(2.5)).toBe(FLICKS_PER_SECOND * 2.5);
    expect(Number.isInteger(secondsToFlicks(1 / 3))).toBe(true);
    expect(flicksToSeconds(FLICKS_PER_SECOND * 3)).toBe(3);
  });

  it('maps frames to flicks with no drift, even an hour in', () => {
    const hourOfFrames = 30 * 3600;
    expect(framesToFlicks(hourOfFrames, 30)).toBe(FLICKS_PER_SECOND * 3600);
    expect(flicksToFrame(framesToFlicks(hourOfFrames, 30), 30)).toBe(hourOfFrames);
    expect(framesToFlicks(1, 24)).toBe(29_400_000);
  });

  it('floors a time between frames to the frame showing at that moment', () => {
    const almostTwo = framesToFlicks(2, 30) - 1;
    expect(flicksToFrame(almostTwo, 30)).toBe(1);
    expect(flicksToFrame(almostTwo, 30, 'round')).toBe(2);
    expect(flicksToFrame(almostTwo, 30, 'ceil')).toBe(2);
  });

  it('quantizes a time to the nearest frame boundary', () => {
    const frame = framesToFlicks(1, 30);
    expect(quantizeToFrame(frame * 4 + 10, 30)).toBe(frame * 4);
    expect(quantizeToFrame(frame * 4 + frame - 10, 30)).toBe(frame * 5);
  });

  it('is sample exact at 48 kHz and 44.1 kHz', () => {
    expect(samplesToFlicks(48_000, 48_000)).toBe(FLICKS_PER_SECOND);
    expect(samplesToFlicks(1, 48_000)).toBe(14_700);
    expect(samplesToFlicks(1, 44_100)).toBe(16_000);
    expect(flicksToSamples(FLICKS_PER_SECOND * 2, 48_000)).toBe(96_000);
  });

  it('refuses a frame or sample rate it cannot divide exactly', () => {
    expect(() => framesToFlicks(1, 29.97)).toThrow(/frame rate/);
    expect(() => samplesToFlicks(1, 22_050.5)).toThrow(/sample rate/);
  });

  it('formats a timecode as hours, minutes, seconds and frames', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(framesToFlicks(30 * 61 + 7, 30), 30)).toBe('00:01:01:07');
    expect(formatTimecode(secondsToFlicks(3600 * 2 + 5), 24)).toBe('02:00:05:00');
  });

  it('treats a negative time as zero in a timecode', () => {
    expect(formatTimecode(-5, 30)).toBe('00:00:00:00');
  });
});
