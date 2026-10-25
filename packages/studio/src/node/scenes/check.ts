/**
 * Checks a scene before it is used: that it loads, draws something, draws the same picture for the
 * same moment, and does nothing it may not (errors, blocked requests, windows, navigation). The
 * pixels come from a `SceneFrameSource`, which the desktop app backs with a hidden offscreen
 * window; the judging is here, so it can be tested with made-up frames.
 */

export interface SceneFrame {
  width: number;
  height: number;
  /** BGRA, as Chromium hands frames over. */
  bitmap: Uint8Array;
}

export interface SceneFrameSource {
  open(url: string): Promise<void>;
  /** Resolves true once the page says it is ready, false when it does not within the time. */
  waitReady(timeoutMs: number): Promise<boolean>;
  frame(t: number): Promise<SceneFrame>;
  /** What the page and the window reported: errors, blocked requests, navigation, windows. */
  problems(): string[];
  close(): Promise<void>;
}

export interface SceneCheckResult {
  ok: boolean;
  /** Each one stops the scene from being used, worded for a fix round. */
  problems: string[];
  /** Worth knowing but allowed, such as a scene where nothing moves. */
  notes: string[];
  /** The frame half way through, for the scene's thumbnail. */
  thumbnail: SceneFrame | null;
}

export interface SceneCheckOptions {
  url: string;
  /** The scene's length in seconds. */
  duration: number;
  fps: number;
  readyTimeoutMs?: number;
}

/**
 * True when two frames show the same picture. Chromium's rasterizer can differ by a level or two
 * per channel depending on what it drew before (measured: at most 3 of 255 on the reference
 * scenes), so a few faint pixels are allowed. A scene that really draws something else, from the
 * real clock, unseeded randomness or state carried between frames, moves or changes far more.
 */
export function sameFrame(a: SceneFrame, b: SceneFrame): boolean {
  if (a.width !== b.width || a.height !== b.height || a.bitmap.length !== b.bitmap.length)
    return false;
  const pixels = a.bitmap.length / 4;
  const allowed = Math.max(1, Math.floor(pixels * 0.001));
  let differing = 0;
  for (let i = 0; i < a.bitmap.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      if (Math.abs((a.bitmap[i + k] as number) - (b.bitmap[i + k] as number)) > 16) {
        differing += 1;
        if (differing > allowed) return false;
        break;
      }
    }
  }
  return true;
}

/** True when every pixel is within a small distance of the first one. */
export function isBlank(frame: SceneFrame, tolerance = 6): boolean {
  const b = frame.bitmap;
  if (b.length < 4) return true;
  const [r0, g0, b0, a0] = [b[2] as number, b[1] as number, b[0] as number, b[3] as number];
  // Every 7th pixel is plenty to tell a picture from a flat fill, and keeps 4K cheap.
  for (let i = 0; i < b.length; i += 28) {
    if (
      Math.abs((b[i + 2] as number) - r0) > tolerance ||
      Math.abs((b[i + 1] as number) - g0) > tolerance ||
      Math.abs((b[i] as number) - b0) > tolerance ||
      Math.abs((b[i + 3] as number) - a0) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

const seconds = (t: number) => `${Math.round(t * 100) / 100} s`;

export async function checkScene(
  source: SceneFrameSource,
  options: SceneCheckOptions,
): Promise<SceneCheckResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  let thumbnail: SceneFrame | null = null;
  try {
    await source.open(options.url);
    if (!(await source.waitReady(options.readyTimeoutMs ?? 10_000))) {
      problems.push(
        'The scene did not finish loading within 10 seconds (Studio.scene was never called, or setup never finished).',
      );
      return { ok: false, problems, notes, thumbnail };
    }
    const last = Math.max(0, options.duration - 1 / options.fps);
    const times = [0, options.duration * 0.25, options.duration * 0.5, last];
    // The first frame a page draws can lag behind what it was asked for; it is thrown away.
    await source.frame(0);
    const frames: SceneFrame[] = [];
    for (const t of times) {
      const frame = await source.frame(t);
      if (t === times[2]) thumbnail = frame;
      if (isBlank(frame)) problems.push(`The frame at ${seconds(t)} is blank: nothing is drawn.`);
      frames.push(frame);
    }
    const again = await source.frame(times[2] as number);
    if (!sameFrame(again, frames[2] as SceneFrame)) {
      problems.push(
        `The frame at ${seconds(times[2] as number)} came out different when drawn a second time. render(t) must draw from t alone, not from earlier frames, the real clock or Math.random outside ctx.random.`,
      );
    }
    if (frames.every((f) => sameFrame(f, frames[0] as SceneFrame)) && options.duration > 1) {
      notes.push('Nothing moves: every checked frame is the same.');
    }
  } catch (error) {
    problems.push(
      `The scene could not be checked: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Closing reads the page's own error list, so what it reported is collected after.
    await source.close().catch(() => undefined);
    for (const p of source.problems()) if (!problems.includes(p)) problems.push(p);
  }
  return { ok: problems.length === 0, problems, notes, thumbnail };
}
