import { FLICKS_PER_SECOND } from '@runova/studio';

/** Pixels on the timeline and flicks in the video, at a zoom given in pixels per second. */

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 400;

export function clampZoom(pxPerSecond: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSecond));
}

export function toPx(flicks: number, pxPerSecond: number): number {
  return (flicks / FLICKS_PER_SECOND) * pxPerSecond;
}

export function toFlicks(px: number, pxPerSecond: number): number {
  return Math.round((px / pxPerSecond) * FLICKS_PER_SECOND);
}

/** The zoom that shows the whole video in `widthPx`, with a little room at the end. */
export function fitZoom(lengthFlicks: number, widthPx: number): number {
  const seconds = lengthFlicks / FLICKS_PER_SECOND;
  if (seconds <= 0 || widthPx <= 0) return 60;
  return clampZoom((widthPx * 0.92) / seconds);
}

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Seconds between labelled ticks, so labels stay at least `minPx` apart. */
export function tickStep(pxPerSecond: number, minPx = 70): number {
  return STEPS.find((step) => step * pxPerSecond >= minPx) ?? (STEPS.at(-1) as number);
}

/** The labelled ticks between two times, in seconds. */
export function ticks(startSeconds: number, endSeconds: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.floor(startSeconds / step) * step; t <= endSeconds; t += step) {
    if (t >= 0) out.push(Math.round(t * 1000) / 1000);
  }
  return out;
}

/** "0:05", "1:30", "12.5" for half seconds: how a tick is labelled. */
export function tickLabel(seconds: number): string {
  const whole = Math.floor(seconds);
  const label = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return seconds === whole ? label : `${label}.${Math.round((seconds - whole) * 10)}`;
}
