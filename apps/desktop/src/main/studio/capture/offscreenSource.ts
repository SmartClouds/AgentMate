import type { SceneFrame, SceneFrameSource } from '@agentmat/studio/node';
import { BrowserWindow, type NativeImage, type Session, session } from 'electron';
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

const prepared = new WeakSet<Session>();
/** Hosts some open scene window may reach (its project's allowlist), counted per window. */
const allowedHosts = new Map<string, number>();

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

  const waitPaints = (count: number) =>
    new Promise<void>((resolve) => {
      const target = paints + count;
      const started = Date.now();
      const check = () =>
        paints >= target || Date.now() - started > 1000 ? resolve() : setTimeout(check, 2);
      contents().invalidate();
      check();
    });

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
      await contents().executeJavaScript(
        `window.renderAt(${Number(t)}).then(() => window.__studio.afterPaint())`,
      );
      // Heavy pages (blur filters, big shadows) can take a few paints to show the new frame;
      // two was not always enough on the reference scenes, four was.
      await waitPaints(4);
      if (!latest) throw new Error('The scene window drew nothing.');
      const size = latest.getSize();
      return { width: size.width, height: size.height, bitmap: latest.toBitmap() };
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
