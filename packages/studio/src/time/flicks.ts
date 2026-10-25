/**
 * Studio measures time in flicks: 1/705,600,000 of a second. The number divides exactly by every
 * frame rate a video uses (24, 25, 30, 48, 50, 60) and by the 44.1 and 48 kHz sample rates, so a
 * clip boundary, a frame and an audio sample all land on whole numbers and nothing drifts, even
 * an hour into a timeline. Whole numbers of flicks stay exact in a double for about 148 days.
 */

export type Flicks = number;

export const FLICKS_PER_SECOND = 705_600_000;

export type Rounding = 'floor' | 'round' | 'ceil';

function round(value: number, mode: Rounding): number {
  if (mode === 'floor') return Math.floor(value);
  if (mode === 'ceil') return Math.ceil(value);
  return Math.round(value);
}

function flicksPerFrame(fps: number): number {
  const per = FLICKS_PER_SECOND / fps;
  if (!Number.isInteger(per)) throw new Error(`Studio cannot use a frame rate of ${fps}.`);
  return per;
}

function flicksPerSample(rate: number): number {
  const per = FLICKS_PER_SECOND / rate;
  if (!Number.isInteger(per)) throw new Error(`Studio cannot use a sample rate of ${rate}.`);
  return per;
}

export function secondsToFlicks(seconds: number): Flicks {
  return Math.round(seconds * FLICKS_PER_SECOND);
}

export function flicksToSeconds(flicks: Flicks): number {
  return flicks / FLICKS_PER_SECOND;
}

export function framesToFlicks(frames: number, fps: number): Flicks {
  return frames * flicksPerFrame(fps);
}

/** The frame showing at `flicks`. Floor by default: a frame stays up until the next one starts. */
export function flicksToFrame(flicks: Flicks, fps: number, mode: Rounding = 'floor'): number {
  return round(flicks / flicksPerFrame(fps), mode);
}

/** The nearest frame boundary, which is where every cut in a rendered video has to fall. */
export function quantizeToFrame(flicks: Flicks, fps: number): Flicks {
  return framesToFlicks(flicksToFrame(flicks, fps, 'round'), fps);
}

export function samplesToFlicks(samples: number, rate: number): Flicks {
  return samples * flicksPerSample(rate);
}

export function flicksToSamples(flicks: Flicks, rate: number, mode: Rounding = 'round'): number {
  return round(flicks / flicksPerSample(rate), mode);
}

/** `HH:MM:SS:FF`, the way an editor shows the playhead. */
export function formatTimecode(flicks: Flicks, fps: number): string {
  const totalFrames = flicksToFrame(Math.max(0, flicks), fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frames].map((n) => String(n).padStart(2, '0')).join(':');
}
