import { encodeScreenTile } from '@shared/remoteProtocol';
import type { CaptureSurface } from './capture';
import { getCaptureProvider } from './capture';

/**
 * Host-side screen capture.
 *
 * The **primary** path is now a plain `MediaStreamTrack` handed straight to
 * WebRTC (see rtcHost.ts): capture → encoder → network, with frames never
 * entering JavaScript. Nothing in this module touches those frames.
 *
 * The JPEG tile pipeline below is a **fallback only**, for controllers that
 * cannot negotiate WebRTC. It is created lazily the first time a peer actually
 * needs tiles and torn down completely when none do, so a session where every
 * controller runs WebRTC allocates no canvas, no video element, and performs no
 * GPU→CPU readback at all.
 */

const TILE = 128;
/**
 * Ceiling on the *captured* (pre-per-peer-scaling) resolution. This used to
 * sit at 1600, which meant a maximized/large controller window had no real
 * pixels above 1600px on its longest edge to receive no matter how good the
 * network was: CSS had to upscale a sub-1600px stream to fill the window,
 * which reads as blur. `QualityGovernor`'s per-peer `scaleResolutionDownBy`
 * (see qualityGovernor.ts's `displayScale`) already downscales for a small
 * controller window or a poor link, so raising this ceiling only spends more
 * encode budget on a peer that actually has the display size and bandwidth
 * to use it.
 */
const MAX_EDGE = 2560;
/** Rate the fallback tile encoder ticks at. */
const TILE_FPS = 15;
/** Rate requested from the OS capturer; WebRTC consumers get the full rate. */
const CAPTURE_FPS = 60;
const JPEG_QUALITY = 0.6;
/**
 * Tile path last-resort safety net: resend the whole frame periodically.
 * Dropped-tile healing normally happens much sooner (the main process requests
 * a refresh as soon as a backpressured socket drains), and viewers skip tiles
 * whose bytes didn't change, so this resend is invisible to them.
 */
const FULL_REFRESH_MS = 30_000;
/**
 * Whether to ask the platform to exclude the OS cursor from capture so the
 * controller draws it from the cursor DataChannel instead.
 *
 * Off deliberately. The cursor plane is fully wired and carries real positions,
 * but those positions are normalized against the *primary* display, while
 * getDisplayMedia may be capturing a different display or a single window. With
 * the cursor still drawn into the frames, a mismatch is invisible; with it
 * excluded, a multi-monitor host would show its cursor in the wrong place and
 * have nothing to fall back on. Flip this on once capture and cursor agree on
 * which surface they describe (native providers report both).
 */
const EXCLUDE_CURSOR_FROM_CAPTURE = false;
/**
 * Tiles encoded concurrently per tick. convertToBlob() runs on Chromium's
 * background thread pool, so overlapping encodes cuts a motion-heavy tick
 * (dozens of changed tiles) to a fraction of the serial time.
 */
const ENCODE_CONCURRENCY = 4;

interface TileEncoder {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** Reused across tiles; rows are written at TILE stride and clipped on put. */
  scratch: ImageData;
}

/** The fallback-only pixel pipeline. Absent whenever no peer needs tiles. */
interface TilePipeline {
  video: HTMLVideoElement;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  encoders: TileEncoder[];
  width: number;
  height: number;
  prev: Uint8ClampedArray | null;
  frameId: number;
  timer: number | null;
  stopping: boolean;
  lastFullFrameAt: number;
}

const provider = getCaptureProvider();

let capturing = false;
let surface: CaptureSurface | null = null;
/**
 * Starts true to match the main process's `tileDemand` default. Main only
 * emits `onTileDemand` on a *change*, so a mismatched default here would leave
 * a joining controller with a black screen until something else flipped it.
 * Tiles therefore paint the screen during WebRTC negotiation and stop once
 * video is confirmed flowing.
 */
let tilesEnabled = true;
let pipeline: TilePipeline | null = null;
let ticking = false;

// Registered once, not per start(), so repeated host sessions don't stack
// listeners on the provider.
provider.onEnded(() => void stopScreenCapture());

export function isCapturing(): boolean {
  return capturing;
}

/** The live capture stream, shared with WebRTC peer connections (rtcHost.ts). */
export function getCaptureStream(): MediaStream | null {
  return provider.getStream();
}

export function getCaptureSurface(): CaptureSurface | null {
  return surface;
}

/** True when the OS cursor is drawn into captured frames (see cursor channel). */
export function isCursorBaked(): boolean {
  return provider.isCursorBaked();
}

export async function startScreenCapture(): Promise<void> {
  if (capturing) return;

  await provider.start({
    maxEdge: MAX_EDGE,
    frameRate: CAPTURE_FPS,
    excludeCursor: EXCLUDE_CURSOR_FROM_CAPTURE,
  });

  capturing = true;
  surface = provider.getSurface();
  if (surface?.width) {
    window.runova.remote.setScreenInfo({ width: surface.width, height: surface.height });
  }
  if (tilesEnabled) await ensureTilePipeline();
}

export async function stopScreenCapture(): Promise<void> {
  if (!capturing) return;
  capturing = false;
  destroyTilePipeline();
  // Back to the default main also resets to, so the next session agrees.
  tilesEnabled = true;
  surface = null;
  await provider.stop();
}

/** Suspend frame production without dropping WebRTC negotiation. */
export function pauseCapture(): void {
  provider.pause();
}

export function resumeCapture(): void {
  provider.resume();
}

export function isCapturePaused(): boolean {
  return provider.isPaused();
}

/**
 * Main tells us whether any connected controller still consumes JPEG tiles.
 * Enabling builds the pixel pipeline; disabling destroys it outright rather
 * than leaving it idling, so the fallback costs nothing when unused.
 */
export function setTilesEnabled(enabled: boolean): void {
  if (tilesEnabled === enabled) return;
  tilesEnabled = enabled;
  if (!enabled) {
    destroyTilePipeline();
    return;
  }
  if (capturing) void ensureTilePipeline();
}

/** Resend every tile on the next tick (e.g. a controller joined mid-stream). */
export function forceFullFrame(): void {
  if (pipeline) pipeline.prev = null;
}

// --- Fallback tile pipeline ----------------------------------------------------

async function ensureTilePipeline(): Promise<void> {
  if (pipeline) return;
  const stream = provider.getStream();
  if (!stream) return;

  // The tile path is the one consumer that needs pixels in JavaScript, so it
  // (and only it) pays for a video element and a readback canvas.
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });
  }
  // Another consumer may have torn things down while we awaited.
  if (!tilesEnabled || !capturing) {
    video.srcObject = null;
    return;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const encoders: TileEncoder[] = [];
  for (let i = 0; i < ENCODE_CONCURRENCY; i++) {
    const tileCanvas = new OffscreenCanvas(TILE, TILE);
    const tileCtx = tileCanvas.getContext('2d');
    if (tileCtx) {
      encoders.push({ canvas: tileCanvas, ctx: tileCtx, scratch: new ImageData(TILE, TILE) });
    }
  }
  if (!ctx || encoders.length === 0) {
    video.srcObject = null;
    return;
  }

  pipeline = {
    video,
    canvas,
    ctx,
    encoders,
    width,
    height,
    prev: null,
    frameId: 0,
    timer: null,
    stopping: false,
    lastFullFrameAt: Date.now(),
  };
  pipeline.timer = window.setInterval(() => void tick(), Math.round(1000 / TILE_FPS));
}

function destroyTilePipeline(): void {
  const p = pipeline;
  if (!p) return;
  pipeline = null;
  p.stopping = true;
  if (p.timer !== null) window.clearInterval(p.timer);
  p.video.pause();
  p.video.srcObject = null;
  // Drop the large buffers eagerly rather than waiting for GC.
  p.prev = null;
  p.canvas.width = 0;
  p.canvas.height = 0;
  for (const encoder of p.encoders) {
    encoder.canvas.width = 0;
    encoder.canvas.height = 0;
  }
  p.encoders.length = 0;
}

async function tick(): Promise<void> {
  const s = pipeline;
  if (!s || ticking || !tilesEnabled) return;
  ticking = true;
  try {
    // Periodic keyframe for the tile path: heal any viewer that missed tiles.
    if (Date.now() - s.lastFullFrameAt > FULL_REFRESH_MS) s.prev = null;
    if (s.prev === null) s.lastFullFrameAt = Date.now();

    s.ctx.drawImage(s.video, 0, 0, s.width, s.height);
    const frame = s.ctx.getImageData(0, 0, s.width, s.height).data;
    const frameId = s.frameId++;
    const prev = s.prev;

    const dirty: Array<{ tx: number; ty: number; tw: number; th: number }> = [];
    for (let ty = 0; ty < s.height; ty += TILE) {
      const th = Math.min(TILE, s.height - ty);
      for (let tx = 0; tx < s.width; tx += TILE) {
        const tw = Math.min(TILE, s.width - tx);
        if (prev && !tileChanged(frame, prev, s.width, tx, ty, tw, th)) continue;
        dirty.push({ tx, ty, tw, th });
      }
    }

    // Encode with a small pool, one canvas per in-flight tile: a shared canvas
    // would be overwritten before the async convertToBlob() reads it, and
    // strictly serial encoding wastes the whole wait on each encoder call.
    let next = 0;
    await Promise.all(
      s.encoders.slice(0, Math.min(ENCODE_CONCURRENCY, dirty.length)).map(async (encoder) => {
        while (!s.stopping) {
          const job = dirty[next++];
          if (!job) break;
          await encodeAndSend(s, encoder, frame, frameId, job.tx, job.ty, job.tw, job.th);
        }
      }),
    );
    // getImageData hands back a fresh buffer every call, so the new frame can
    // become the baseline by reference, no defensive copy needed.
    s.prev = frame;
  } catch {
    // A dropped frame is harmless; the next tick recovers.
  } finally {
    ticking = false;
  }
}

function tileChanged(
  cur: Uint8ClampedArray,
  prev: Uint8ClampedArray,
  width: number,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): boolean {
  const rowBytes = tw * 4;
  for (let y = 0; y < th; y++) {
    let i = ((ty + y) * width + tx) * 4;
    const end = i + rowBytes;
    for (; i < end; i += 4) {
      // Compare RGB (skip alpha, always 255 for an opaque screen grab).
      if (cur[i] !== prev[i] || cur[i + 1] !== prev[i + 1] || cur[i + 2] !== prev[i + 2]) {
        return true;
      }
    }
  }
  return false;
}

async function encodeAndSend(
  s: TilePipeline,
  encoder: TileEncoder,
  frame: Uint8ClampedArray,
  frameId: number,
  tx: number,
  ty: number,
  tw: number,
  th: number,
): Promise<void> {
  // Copy this tile's pixels into the encoder's reusable scratch buffer. Rows are
  // written at the scratch's full TILE stride and the canvas is sized to the
  // exact tile, so putImageData clips the unused right/bottom margin away,
  // which lets one allocation serve both full and edge tiles.
  const scratch = encoder.scratch;
  const stride = scratch.width * 4;
  for (let y = 0; y < th; y++) {
    const src = ((ty + y) * s.width + tx) * 4;
    scratch.data.set(frame.subarray(src, src + tw * 4), y * stride);
  }
  encoder.canvas.width = tw;
  encoder.canvas.height = th;
  encoder.ctx.putImageData(scratch, 0, 0);
  const blob = await encoder.canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  if (s.stopping) return;
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const encoded = encodeScreenTile({ frameId, x: tx, y: ty, w: tw, h: th, jpeg });
  // encodeScreenTile returns a freshly-allocated, tightly-packed Uint8Array, so
  // its backing buffer is exactly the bytes to hand to IPC.
  window.runova.remote.hostTile(encoded.buffer as ArrayBuffer);
}
