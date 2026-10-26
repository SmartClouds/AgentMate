import { join } from 'node:path';
import type { ThemeMode } from '@runova/core';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import icon from '../../resources/icon.ico?asset';
import { IPC } from '../shared/ipcChannels';
import { sendToWindow } from './ipc/send';
import { supportsBackgroundMaterial } from './windowGlass';

/** Long enough to read the logo on a fast machine instead of seeing it blink. */
const MIN_VISIBLE_MS = 700;
/** Matches the fade in splash.html before the window is destroyed. */
const FADE_MS = 180;
/** If the app window never says it's ready, show it anyway rather than strand the user. */
const HANDOFF_TIMEOUT_MS = 15_000;
/** How long startup waits for the splash to finish loading before it carries on anyway. */
const SPLASH_LOAD_TIMEOUT_MS = 2_000;
/** Chromium's ERR_ABORTED: a load replaced by another one, not a failure. */
const ERR_ABORTED = -3;

let splash: BrowserWindow | null = null;
let shownAt = 0;
let lastStatus = '';

/** The `--background` of each theme in index.css, so the main window opens on its own color. */
const THEME_BACKGROUNDS: Record<Exclude<ThemeMode, 'system'>, string> = {
  light: '#f5f5f5',
  dark: '#0a0a0a',
  'vscode-dark': '#1f1f1f',
  vs2026: '#181921',
};

export function resolveStartupTheme(theme: ThemeMode): Exclude<ThemeMode, 'system'> {
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return theme;
}

export function themeBackground(theme: ThemeMode): string {
  return THEME_BACKGROUNDS[resolveStartupTheme(theme)];
}

/**
 * The small glass window shown while the app starts, the way Visual Studio
 * does it. It is a static page rather than the React bundle, so it paints
 * right away, and it goes as soon as the main window reports it has loaded.
 *
 * Resolves once the splash is on screen with its logo, status and progress bar
 * loaded. Startup waits for that before its long synchronous stretch: while
 * the main process is busy it can't answer the splash's requests (they all go
 * through the CSP header hook), so the splash would sit half drawn until the
 * work was done.
 */
export function showSplash(theme: ThemeMode): Promise<void> {
  if (getSplash()) return Promise.resolve();
  const dark = resolveStartupTheme(theme) !== 'light';
  const acrylic = supportsBackgroundMaterial();
  const mac = process.platform === 'darwin';
  // Native blur on Windows 11 and macOS; everywhere else the page draws its own tint.
  const glass = acrylic || mac ? 'native' : 'css';

  const win = new BrowserWindow({
    width: 520,
    height: 320,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    ...(acrylic ? { backgroundMaterial: 'acrylic' as const } : {}),
    ...(mac ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const } : {}),
    // Acrylic draws nothing on a transparent window, so only the fallback path uses it.
    transparent: !acrylic,
    icon,
    title: app.getName(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  splash = win;

  let painted = false;
  let loaded = false;
  let resolveSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const timer = setTimeout(resolveSettled, SPLASH_LOAD_TIMEOUT_MS);
  const settle = (): void => {
    if (!painted || !loaded) return;
    clearTimeout(timer);
    resolveSettled();
  };

  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    shownAt = Date.now();
    win.show();
    painted = true;
    settle();
  });
  win.webContents.on('did-finish-load', () => {
    if (lastStatus) sendToWindow(win, IPC.splash.onStatus, lastStatus);
    loaded = true;
    settle();
  });
  win.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) {
      loaded = true;
      painted = true;
      settle();
    }
  });
  win.on('closed', () => {
    if (splash === win) splash = null;
    painted = true;
    loaded = true;
    settle();
  });

  const query = {
    theme: dark ? 'dark' : 'light',
    glass,
    platform: process.platform,
    version: app.isPackaged ? app.getVersion() : 'dev',
  };
  if (process.env.ELECTRON_RENDERER_URL) {
    const params = new URLSearchParams(query).toString();
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/splash.html?${params}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/splash.html'), { query });
  }
  return settled;
}

/** One line under the logo saying what startup is busy with. */
export function setSplashStatus(status: string): void {
  lastStatus = status;
  sendToWindow(splash, IPC.splash.onStatus, status);
}

export function getSplash(): BrowserWindow | null {
  return splash && !splash.isDestroyed() ? splash : null;
}

/**
 * Hands over to the main window: waits out the minimum time so the splash
 * doesn't flicker, shows `next`, then fades the splash away.
 */
export function finishSplash(next: () => void): void {
  const win = getSplash();
  if (!win) {
    next();
    return;
  }
  const wait = shownAt ? Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAt)) : 0;
  setTimeout(() => {
    next();
    sendToWindow(win, IPC.splash.onClose);
    setTimeout(() => {
      if (!win.isDestroyed()) win.destroy();
    }, FADE_MS);
  }, wait);
}

/**
 * Keeps `win` hidden behind the splash until its renderer sends
 * `app:rendererReady` (see AppShell), then swaps them. A crash, a failed load
 * or the timeout reveals the window too, so startup can never get stuck on
 * the splash.
 *
 * `show` puts the window up; pass one that maximizes when the window should open that way.
 */
export function handOffWhenReady(win: BrowserWindow, show: () => void = () => win.show()): void {
  let done = false;
  const reveal = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    ipcMain.removeListener(IPC.app.rendererReady, onReady);
    finishSplash(() => {
      if (win.isDestroyed()) return;
      show();
      win.focus();
    });
  };
  // Widget, pet and session windows run the same bundle, so only this window's word counts.
  const onReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender === win.webContents) reveal();
  };
  const timer = setTimeout(reveal, HANDOFF_TIMEOUT_MS);
  ipcMain.on(IPC.app.rendererReady, onReady);
  win.webContents.once('render-process-gone', reveal);
  win.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) reveal();
  });
  // Closed before it was ever shown (quit during startup): take the splash with it.
  win.once('closed', () => {
    done = true;
    clearTimeout(timer);
    ipcMain.removeListener(IPC.app.rendererReady, onReady);
    getSplash()?.destroy();
  });
}
