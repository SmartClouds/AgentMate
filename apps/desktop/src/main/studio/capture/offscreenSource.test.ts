import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offscreen scene window, against a stand-in for Electron that paints when asked and lets the
 * test play the page: its readiness, its frames, its errors, and the attempts it makes to leave.
 */

type Listener = (...args: unknown[]) => void;

const state = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
  sessionRequests: null as
    | null
    | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
  permission: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void),
  permissionCheck: null as null | (() => boolean),
  handled: [] as string[],
  ready: true,
  pageErrors: [] as string[],
  /**
   * How long a page takes to paint a changed picture by itself. Until then, a paint asked for with
   * invalidate still shows the moment before, as a heavy page's does.
   */
  paintDelay: 2,
  /** Shows a picture on its way first (as canvas and blurred layers do), the final one this much later. */
  midwayMs: 0,
  /** A page that never shows the same picture twice. */
  flicker: false,
  failExec: false,
}));

interface FakeWindow {
  options: Record<string, unknown>;
  contentSize: [number, number] | null;
  destroyed: boolean;
  listeners: Record<string, Listener>;
  openHandler: ((d: { url: string }) => { action: string }) | null;
  scripts: string[];
  emit(name: string, ...args: unknown[]): void;
}

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false;
    contentSize: [number, number] | null = null;
    listeners: Record<string, Listener> = {};
    openHandler: FakeWindow['openHandler'] = null;
    scripts: string[] = [];
    webContents: Record<string, unknown>;
    constructor(readonly options: Record<string, unknown>) {
      state.windows.push(this as unknown as FakeWindow);
      const self = this;
      // What the page shows; a changed moment shows once the page paints it by itself.
      let shown = 0;
      let flick = 0;
      const paint = (value: number) => {
        const image = {
          getSize: () => ({ width: 4, height: 2 }),
          toBitmap: () => Buffer.from(new Uint8Array(32).fill(value)),
        };
        queueMicrotask(() => self.listeners.paint?.({}, {}, image));
      };
      const pid = 1000 + state.windows.length;
      this.webContents = {
        getOSProcessId: () => pid,
        setFrameRate: vi.fn(),
        on: (name: string, fn: Listener) => {
          self.listeners[name] = fn;
        },
        setWindowOpenHandler: (fn: FakeWindow['openHandler']) => {
          self.openHandler = fn;
        },
        loadURL: vi.fn(async () => undefined),
        invalidate: () => {
          flick += 1;
          paint(state.flicker ? flick % 256 : shown);
        },
        executeJavaScript: vi.fn(async (code: string) => {
          self.scripts.push(code);
          if (state.failExec) throw new Error('gone');
          const moment = /renderAt\(([\d.]+)\)/.exec(code);
          const target = moment ? Math.round(Number(moment[1]) * 30) + 1 : shown;
          if (target !== shown) {
            const midway = state.midwayMs;
            setTimeout(() => {
              shown = midway ? 200 : target;
              paint(shown);
              if (midway)
                setTimeout(() => {
                  shown = target;
                  paint(shown);
                }, midway);
            }, state.paintDelay);
          }
          if (code.includes('__studio.ready')) return state.ready;
          if (code.includes('errors.slice')) return state.pageErrors;
          return undefined;
        }),
      };
    }
    setContentSize(w: number, h: number) {
      this.contentSize = [w, h];
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
    emit(name: string, ...args: unknown[]) {
      this.listeners[name]?.(...args);
    }
  }
  const fakeSession = {
    protocol: { handle: (scheme: string) => state.handled.push(scheme) },
    webRequest: {
      onBeforeRequest: (fn: typeof state.sessionRequests) => {
        state.sessionRequests = fn;
      },
    },
    setPermissionRequestHandler: (fn: typeof state.permission) => {
      state.permission = fn;
    },
    setPermissionCheckHandler: (fn: typeof state.permissionCheck) => {
      state.permissionCheck = fn;
    },
  };
  const app = {
    getAppMetrics: () => [
      { pid: 1, memory: { workingSetSize: 999_999 } },
      { pid: 1001, memory: { workingSetSize: 2048 } },
      { pid: 1002, memory: { workingSetSize: 1024 } },
    ],
  };
  return { app, BrowserWindow, session: { fromPartition: () => fakeSession } };
});
vi.mock('../index', () => ({ studioService: () => ({}) }));

const { createOffscreenSource, SCENE_PARTITION, sceneWindowsMemoryBytes } = await import(
  './offscreenSource'
);

const request = (url: string) =>
  new Promise<boolean>((resolve) => state.sessionRequests?.({ url }, (r) => resolve(r.cancel)));

beforeEach(() => {
  state.windows.length = 0;
  state.ready = true;
  state.pageErrors = [];
  state.failExec = false;
  state.paintDelay = 2;
  state.midwayMs = 0;
  state.flicker = false;
});

describe('createOffscreenSource', () => {
  it("adds up the memory of the open scene pages only, not the app's other processes", async () => {
    const first = createOffscreenSource({ width: 8, height: 8, scale: 1 });
    const second = createOffscreenSource({ width: 8, height: 8, scale: 1 });
    await first.open('studio-scene://t-a/index.html');
    await second.open('studio-scene://t-b/index.html');
    expect(sceneWindowsMemoryBytes()).toBe((2048 + 1024) * 1024);
    await first.close();
    expect(sceneWindowsMemoryBytes()).toBe(1024 * 1024);
    await second.close();
    expect(sceneWindowsMemoryBytes()).toBe(0);
  });

  it('opens a hidden offscreen window at the output size, zoomed to the design size, in its own session', async () => {
    const source = createOffscreenSource({ width: 1920, height: 1080, scale: 0.25 });
    await source.open('studio-scene://t-x/index.html');
    const [win] = state.windows;
    expect(win?.options).toMatchObject({
      show: false,
      width: 480,
      height: 270,
      enableLargerThanScreen: true,
    });
    expect(win?.options.webPreferences).toMatchObject({
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 0.25,
    });
    expect(win?.contentSize).toEqual([480, 270]);
    expect(SCENE_PARTITION).toBe('studio-scenes');
    expect(state.handled).toEqual(['studio-scene']);
  });

  it('lets only scene pages and inline data through its session, and grants no permission', async () => {
    createOffscreenSource({ width: 100, height: 100, scale: 1 });
    expect(await request('studio-scene://t-x/index.html')).toBe(false);
    expect(await request('data:image/png;base64,AA')).toBe(false);
    expect(await request('https://example.com/a.js')).toBe(true);
    expect(await request('file:///C:/secret.txt')).toBe(true);
    const granted = await new Promise((resolve) => state.permission?.({}, 'media', resolve));
    expect(granted).toBe(false);
    expect(state.permissionCheck?.()).toBe(false);
  });

  it("opens the project's allowed hosts while its window is open, and closes them after", async () => {
    const source = createOffscreenSource({
      width: 100,
      height: 100,
      scale: 1,
      allowedHosts: ['cdn.example.com'],
    });
    expect(await request('https://cdn.example.com/lib.js')).toBe(true);
    await source.open('studio-scene://t-x/index.html');
    expect(await request('https://cdn.example.com/lib.js')).toBe(false);
    expect(await request('http://cdn.example.com/lib.js')).toBe(true);
    await source.close();
    expect(await request('https://cdn.example.com/lib.js')).toBe(true);
  });

  it('waits for the page to say it is ready, or gives up', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    expect(await source.waitReady(500)).toBe(true);
    state.ready = false;
    expect(await source.waitReady(120)).toBe(false);
  });

  it('draws a moment and hands back the painted frame', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    const frame = await source.frame(1.5);
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(2);
    expect(frame.bitmap.length).toBe(32);
    expect(state.windows[0]?.scripts.at(-1)).toContain('renderAt(1.5)');
    expect(state.windows[0]?.scripts.at(-1)).toContain('afterPaint');
  });

  it('asks for each paint it waits on, so a frame takes milliseconds, not the time limit', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    const started = Date.now();
    let last = await source.frame(0);
    for (let i = 1; i < 10; i++) last = await source.frame(i / 30);
    // A page paints once per invalidate; ten frames of a few paints each, well inside a second.
    expect(Date.now() - started).toBeLessThan(800);
    expect(last.bitmap[0]).toBe(10);
  });

  it('waits for the page to show the new moment, not a paint of the one before', async () => {
    state.paintDelay = 30;
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    expect((await source.frame(1)).bitmap[0]).toBe(31);
    expect((await source.frame(0.5)).bitmap[0]).toBe(16);
  });

  it('waits out a picture on its way, which quick paints would show twice', async () => {
    state.midwayMs = 15;
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    expect((await source.frame(2)).bitmap[0]).toBe(61);
  });

  it('takes a moment that looks like the one before without waiting long', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    await source.frame(1);
    const started = Date.now();
    // The same moment again: nothing changes, so the page paints nothing by itself.
    expect((await source.frame(1)).bitmap[0]).toBe(31);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('gives up waiting for a page that never settles, within about a second', async () => {
    state.flicker = true;
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    const started = Date.now();
    await source.frame(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('refuses navigation and new windows, and reports them with console errors and a crash', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.open('studio-scene://t-x/index.html');
    const win = state.windows[0] as FakeWindow;
    const nav = { preventDefault: vi.fn() };
    win.emit('will-navigate', nav, 'https://example.com/');
    expect(nav.preventDefault).toHaveBeenCalled();
    expect(win.openHandler?.({ url: 'https://example.com/popup' })).toEqual({ action: 'deny' });
    win.emit('console-message', { level: 'error', message: 'Scene went wrong' });
    win.emit('console-message', { level: 'error', message: 'Uncaught TypeError: x' });
    win.emit('console-message', { level: 'warning', message: 'just a warning' });
    win.emit('render-process-gone', {}, { reason: 'crashed' });
    state.pageErrors = ['Blocked connect-src: https://example.com/', 'Scene went wrong'];
    await source.close();
    expect(source.problems()).toEqual([
      'Blocked navigating away to https://example.com/',
      'Blocked opening a window: https://example.com/popup',
      'Console error: Scene went wrong',
      'The scene page stopped (crashed).',
      'Blocked connect-src: https://example.com/',
      'Scene went wrong',
    ]);
    expect(win.destroyed).toBe(true);
  });

  it('closes quietly when the page cannot answer, and throws on a frame from a closed window', async () => {
    const source = createOffscreenSource({ width: 100, height: 100, scale: 1 });
    await source.close();
    await source.open('studio-scene://t-x/index.html');
    state.failExec = true;
    await source.close();
    await expect(source.frame(0)).rejects.toThrow(/closed/);
  });
});
