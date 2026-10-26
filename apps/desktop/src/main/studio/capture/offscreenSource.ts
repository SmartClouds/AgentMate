import type { SceneFrame, SceneFrameSource } from '@runova/studio/node';
import { app, BrowserWindow, type NativeImage, type Session, session } from 'electron';
import { handleStudioScenes } from '../protocol';

/**
 * Scene pages drawn in a hidden offscreen window, frame by frame, for checking a scene and (from
 * E34) rendering it. The S1 spike picked this over `capturePage` on a hidden window, which failed
 * on this hardware, and measured it frame-exact at 20 fps and more at 1080p.
 *
 * Scene code is untrusted, so the window lives in a session of its own that answers only
 * `studio-scene:` and cancels every other request, grants no permission, and has no preload.
 * Navigation and new windows are refused and reported.
 */

export const SCENE_PARTITION = 'studio-scenes';

/** How long a changed page gets to paint by itself before a frame is taken as it stands. */
const SELF_PAINT_MS = 80;
/**
 * How long a picture has to stay the same before it counts as drawn. Canvas and blurred layers
 * reach the screen a compositor frame or two late, and quick paints in between can repeat a
 * picture on its way; a frame and a half at 60 Hz outlasts that.
 */
const STEADY_MS = 25;

const prepared = new WeakSet<Session>();
/** Hosts some open scene window may reach (its project's allowlist), counted per window. */
const allowedHosts = new Map<string, number>();
/** The scene windows open now, whose page processes a render watches the memory of. */
const openWindows = new Set<BrowserWindow>();

/**
 * Memory the open scene pages use, in bytes. A render replaces its window when this passes its
 * cap, so a scene that leaks a little every frame cannot take the machine down over a long video.
 */
export function sceneWindowsMemoryBytes(): number {
  const pids = new Set<number>();
  for (const open of openWindows)
    if (!open.isDestroyed()) pids.add(open.webContents.getOSProcessId());
  return app
    .getAppMetrics()
    .filter((metric) => pids.has(metric.pid))
    .reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0);
}

function sceneSession(): Session {
  const ses = session.fromPartition(SCENE_PARTITION);
  if (prepared.has(ses)) return ses;
  prepared.add(ses);
  handleStudioScenes(ses.protocol);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let allowed = /^(studio-scene|data|blob|devtools):/.test(details.url);
    if (!allowed && details.url.startsWith('https://')) {
      allowed = allowedHosts.has(new URL(details.url).hostname);
    }
    callback({ cancel: !allowed });
  });
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

export interface OffscreenSourceOptions {
  /** The scene's design size, in CSS pixels. */
  width: number;
  height: number;
  /** Output pixels per CSS pixel: 0.25 for a quick check, 1 for 1080p, 2 for 4K. */
  scale: number;
  /** Hosts the scene's project lets it load from over https; none by default. */
  allowedHosts?: readonly string[];
}

export function createOffscreenSource(options: OffscreenSourceOptions): SceneFrameSource {
  const width = Math.round(options.width * options.scale);
  const height = Math.round(options.height * options.scale);
  const problems: string[] = [];
  let win: BrowserWindow | null = null;
  let latest: NativeImage | null = null;
  let paints = 0;

  const contents = () => {
    if (!win || win.isDestroyed()) throw new Error('The scene window is closed.');
    return win.webContents;
  };

  /**
   * Asks for one more paint. An offscreen page paints only when something on it changed, so one
   * `invalidate` gives one paint, and it is asked again on every poll; waiting on paints that
   * never come cost a render its whole time limit on every frame (under one frame a second).
   */
  const nextPaint = (after: number) =>
    new Promise<void>((resolve) => {
      const started = Date.now();
      const check = () => {
        if (paints > after || Date.now() - started > 100) {
          resolve();
          return;
        }
        contents().invalidate();
        setTimeout(check, 4);
      };
      check();
    });

  /**
   * The picture the page settled on after drawing a moment. A page whose picture changed paints
   * by itself, but a heavy one (blur filters, big shadows) can take a while, and paints asked for
   * meanwhile still show the moment before, the same pixels each time. So it first gives the page
   * a moment to paint on its own, then waits until the pixels stay the same for a moment. A
   * moment that looks like the one before paints nothing by itself and costs only that moment.
   */
  const settledFrame = async (paintsBefore: number): Promise<SceneFrame> => {
    const started = Date.now();
    while (paints === paintsBefore && Date.now() - started < SELF_PAINT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    let previous: { bitmap: Buffer; at: number } | null = null;
    for (;;) {
      await nextPaint(paints);
      const now = Date.now();
      const timedOut = now - started > 1000;
      if (!latest) {
        if (timedOut) throw new Error('The scene window drew nothing.');
        continue;
      }
      const bitmap = latest.toBitmap();
      const same = previous?.bitmap.equals(bitmap) ?? false;
      if (timedOut || (same && now - (previous?.at ?? now) >= STEADY_MS)) {
        const size = latest.getSize();
        return { width: size.width, height: size.height, bitmap };
      }
      if (!same) previous = { bitmap, at: now };
    }
  };

  return {
    async open(url) {
      for (const host of options.allowedHosts ?? [])
        allowedHosts.set(host, (allowedHosts.get(host) ?? 0) + 1);
      win = new BrowserWindow({
        show: false,
        width,
        height,
        useContentSize: true,
        frame: false,
        enableLargerThanScreen: true,
        backgroundColor: '#00000000',
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          session: sceneSession(),
          spellcheck: false,
          // Set before the page loads, so its first line of script already sees the design size.
          zoomFactor: options.scale,
        },
      });
      openWindows.add(win);
      // A window taller than the screen's work area is clipped at creation; set it again.
      win.setContentSize(width, height);
      const wc = win.webContents;
      wc.setFrameRate(240);
      wc.on('paint', (_event, _dirty, image) => {
        latest = image;
        paints += 1;
      });
      wc.on('will-navigate', (event, target) => {
        event.preventDefault();
        problems.push(`Blocked navigating away to ${target}`);
      });
      wc.setWindowOpenHandler(({ url: target }) => {
        problems.push(`Blocked opening a window: ${target}`);
        return { action: 'deny' };
      });
      wc.on('console-message', (event) => {
        // Uncaught errors and refused requests are reported by the runtime already, more clearly.
        if (event.level !== 'error' || /^(Uncaught|Refused to)/.test(event.message)) return;
        problems.push(`Console error: ${event.message}`);
      });
      wc.on('render-process-gone', (_event, details) => {
        problems.push(`The scene page stopped (${details.reason}).`);
      });
      await wc.loadURL(url);
    },

    async waitReady(timeoutMs) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const ready = await contents()
          .executeJavaScript('window.__studio ? window.__studio.ready === true : false')
          .catch(() => false);
        if (ready) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    },

    async frame(t): Promise<SceneFrame> {
      const paintsBefore = paints;
      await contents().executeJavaScript(
        `window.renderAt(${Number(t)}).then(() => window.__studio.afterPaint())`,
      );
      return settledFrame(paintsBefore);
    },

    problems() {
      return problems.slice();
    },

    async close() {
      if (!win || win.isDestroyed()) return;
      try {
        const errors: string[] = await win.webContents.executeJavaScript(
          'window.__studio ? window.__studio.errors.slice() : []',
        );
        for (const error of errors) if (!problems.includes(error)) problems.push(error);
      } catch {
        // A page that crashed has nothing more to say.
      }
      openWindows.delete(win);
      win.destroy();
      win = null;
      for (const host of options.allowedHosts ?? []) {
        const left = (allowedHosts.get(host) ?? 1) - 1;
        if (left <= 0) allowedHosts.delete(host);
        else allowedHosts.set(host, left);
      }
    },
  };
}
