import type { RenderFrameHost } from '../node/render/renderJob.js';
import type { SceneFrame, SceneFrameSource } from '../node/scenes/check.js';

/**
 * A stand-in for the desktop app's offscreen scene windows: each frame is one flat colour worked
 * out from the scene address and the time, so the same moment always gives the same picture, and
 * every frame of a video differs from the next.
 */

export interface FakeFrameHostOptions {
  /** Fails the nth frame asked for overall (1-based). */
  failAtFrame?: number;
  /** Calls this before drawing the nth frame overall (1-based), e.g. to cancel there. */
  onFrame?: (n: number) => void;
  /** Never says it is ready. */
  neverReady?: boolean;
  /** What `memoryBytes` reports. */
  memory?: () => number;
  /** Draws frames this many times larger than asked, as a scaled display would. */
  displayScale?: number;
  /** Draws every frame at this size whatever is asked, to keep tests of big outputs quick. */
  fixedSize?: { width: number; height: number };
  /**
   * Pages whose address contains this draw as a caption would: see-through, with the bottom quarter
   * half-white (premultiplied, as Chromium hands it over).
   */
  captionTree?: string;
}

export interface FakeFrameHost extends RenderFrameHost {
  opened: string[];
  closed: number;
  /** Frames drawn, warm-up frames included. */
  drawn: number;
}

function colour(url: string, t: number): [number, number, number] {
  let h = 2166136261;
  for (const ch of `${url}@${t.toFixed(6)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

export function fakeFrameHost(options: FakeFrameHostOptions = {}): FakeFrameHost {
  const host: FakeFrameHost = {
    opened: [],
    closed: 0,
    drawn: 0,
    open(input) {
      const scale = input.scale * (options.displayScale ?? 1);
      const width = options.fixedSize?.width ?? Math.round(input.width * scale);
      const height = options.fixedSize?.height ?? Math.round(input.height * scale);
      let url = '';
      const source: SceneFrameSource = {
        async open(address) {
          url = address;
          host.opened.push(address);
        },
        async waitReady() {
          return !options.neverReady;
        },
        async frame(t): Promise<SceneFrame> {
          host.drawn += 1;
          options.onFrame?.(host.drawn);
          if (options.failAtFrame === host.drawn)
            throw new Error('The scene page stopped (crashed).');
          const bitmap = new Uint8Array(width * height * 4);
          if (options.captionTree && url.includes(options.captionTree)) {
            for (let i = Math.floor(height * 0.75) * width * 4; i < bitmap.length; i++)
              bitmap[i] = 128;
            return { width, height, bitmap };
          }
          const [b, g, r] = colour(url, t);
          for (let i = 0; i < bitmap.length; i += 4) {
            bitmap[i] = b;
            bitmap[i + 1] = g;
            bitmap[i + 2] = r;
            bitmap[i + 3] = 255;
          }
          return { width, height, bitmap };
        },
        problems() {
          return options.failAtFrame ? ['The scene page stopped (crashed).'] : [];
        },
        async close() {
          host.closed += 1;
        },
      };
      return source;
    },
  };
  if (options.memory) host.memoryBytes = async () => (options.memory as () => number)();
  return host;
}
