import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBrowserWindow, setElectronPath } from '../test/main/electronMock';

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'runova-window-state-'));
  setElectronPath('userData', userData);
  // The module caches what it read, so each test starts from a fresh copy.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(userData, { recursive: true, force: true });
});

function savedFile(): unknown {
  return JSON.parse(readFileSync(join(userData, 'data', 'window-state.json'), 'utf-8'));
}

describe('main window state', () => {
  it('opens at the default size the first time', async () => {
    const state = await import('./mainWindowState');
    const saved = state.loadMainWindowState();

    expect(saved).toEqual({ bounds: null, isMaximized: false });
    expect(state.mainWindowBounds(saved)).toEqual({ width: 1440, height: 860 });
  });

  it('comes back maximized after being closed maximized', async () => {
    const first = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    win.bounds = { x: 100, y: 80, width: 1200, height: 800 };
    first.trackMainWindowState(win as unknown as BrowserWindow, false);

    vi.spyOn(win, 'isMaximized').mockReturnValue(true);
    win.emit('maximize');
    win.emit('close');

    expect(savedFile()).toEqual({
      bounds: { x: 100, y: 80, width: 1200, height: 800 },
      isMaximized: true,
    });

    vi.resetModules();
    const next = await import('./mainWindowState');
    const restored = next.loadMainWindowState();
    expect(restored.isMaximized).toBe(true);
    expect(next.mainWindowBounds(restored)).toEqual({ x: 100, y: 80, width: 1200, height: 800 });
  });

  it('remembers a maximize that came without a maximize event', async () => {
    // macOS only sends the event at the end of a live resize, which a zoom does not always have.
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    state.trackMainWindowState(win as unknown as BrowserWindow, false);

    vi.spyOn(win, 'isMaximized').mockReturnValue(true);
    win.emit('close');

    expect(savedFile()).toMatchObject({ isMaximized: true });
  });

  it('forgets a maximize undone without an unmaximize event', async () => {
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    state.trackMainWindowState(win as unknown as BrowserWindow, true);

    win.emit('close');

    expect(savedFile()).toMatchObject({ isMaximized: false });
  });

  it('stays maximized when minimized from maximized and then closed', async () => {
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    state.trackMainWindowState(win as unknown as BrowserWindow, true);

    // A minimized window reports isMaximized() false; that must not be what gets saved.
    vi.spyOn(win, 'isMinimized').mockReturnValue(true);
    win.emit('minimize');
    win.emit('close');

    expect(savedFile()).toMatchObject({ isMaximized: true });
  });

  it('forgets maximized once the window is restored', async () => {
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    state.trackMainWindowState(win as unknown as BrowserWindow, true);

    win.emit('unmaximize');

    expect(savedFile()).toMatchObject({ isMaximized: false });
  });

  it('saves a resize once it settles', async () => {
    vi.useFakeTimers();
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    state.trackMainWindowState(win as unknown as BrowserWindow, false);

    win.bounds = { x: 10, y: 20, width: 1000, height: 700 };
    win.emit('resize');
    vi.advanceTimersByTime(1000);

    expect(savedFile()).toEqual({
      bounds: { x: 10, y: 20, width: 1000, height: 700 },
      isMaximized: false,
    });
  });

  it('drops a position that is no longer on any screen but keeps the size', async () => {
    const state = await import('./mainWindowState');
    const bounds = state.mainWindowBounds({
      bounds: { x: 5000, y: 3000, width: 1100, height: 750 },
      isMaximized: false,
    });

    expect(bounds).toEqual({ width: 1100, height: 750 });
  });

  it('maximizes before showing a window that was left maximized', async () => {
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    const maximize = vi.spyOn(win, 'maximize');
    const show = vi.spyOn(win, 'show');

    state.showMainWindow(win as unknown as BrowserWindow, { bounds: null, isMaximized: true });

    expect(maximize).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    // Showing first would flash the restored size before the window fills the screen.
    expect(maximize.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0]);
  });

  it('just shows a window that was not left maximized', async () => {
    const state = await import('./mainWindowState');
    const win = new FakeBrowserWindow();
    const maximize = vi.spyOn(win, 'maximize');

    state.showMainWindow(win as unknown as BrowserWindow, { bounds: null, isMaximized: false });

    expect(maximize).not.toHaveBeenCalled();
    expect(win.visible).toBe(true);
  });

  it('reads back a damaged file as the defaults', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(userData, 'data'), { recursive: true });
    writeFileSync(join(userData, 'data', 'window-state.json'), '{ not json');
    const state = await import('./mainWindowState');

    expect(state.loadMainWindowState()).toEqual({ bounds: null, isMaximized: false });
  });

  it('never opens below the minimum size', async () => {
    const state = await import('./mainWindowState');
    const bounds = state.mainWindowBounds({
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      isMaximized: false,
    });

    expect(bounds).toMatchObject({ width: 960, height: 600 });
  });
});
