import { join } from 'node:path';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import type { RdpWindowState } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { sendToWindow } from '../ipc/send';
import { keepWindowsHidden } from '../testMode';
import { titleBarFrameOptions } from '../windowChrome';

/**
 * Each Remote Desktop session gets its own window, like Windows' Remote Desktop Connection:
 * resizable, maximizable, able to go full screen on any monitor, and closing it disconnects.
 * Unlike the single LAN remote-control window, several servers can be open at once.
 */

const windows = new Map<string, BrowserWindow>();
let handlersRegistered = false;

/**
 * Windows keeps the Windows key and the shortcuts built on it (Win+V, Win+D, Alt+Tab) for its own
 * shell, so the page never sees them. Chromium's Keyboard Lock hands them over, but only while the
 * page is in HTML full screen, which the window's own full screen doesn't count as. So a full
 * screen session window is put into both, and the page asks for the lock (useRdpKeyboardLock).
 * HTML full screen layers on top of the window's: leaving it keeps the window full screen.
 */
const ENTER_HTML_FULLSCREEN =
  'document.fullscreenElement ? undefined : document.documentElement.requestFullscreen()';
// Chromium leaves the page in HTML full screen when the window stops being full screen.
const EXIT_HTML_FULLSCREEN = 'document.fullscreenElement ? document.exitFullscreen() : undefined';

function runInPage(window: BrowserWindow, code: string): void {
  if (window.isDestroyed()) return;
  // Entering full screen takes a user gesture, which a script from main is allowed to claim.
  window.webContents.executeJavaScript(code, true).catch(() => undefined);
}

function stateOf(window: BrowserWindow): RdpWindowState {
  return { isMaximized: window.isMaximized(), isFullScreen: window.isFullScreen() };
}

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window && [...windows.values()].includes(window) ? window : null;
}

function registerWindowControlHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(IPC.rdpWindow.minimize, (event) => senderWindow(event)?.minimize());
  ipcMain.handle(IPC.rdpWindow.maximizeToggle, (event) => {
    const window = senderWindow(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle(IPC.rdpWindow.fullscreenToggle, (event) => {
    const window = senderWindow(event);
    window?.setFullScreen(!window.isFullScreen());
  });
  ipcMain.handle(IPC.rdpWindow.close, (event) => senderWindow(event)?.close());
  ipcMain.handle(IPC.rdpWindow.getState, (event): RdpWindowState => {
    const window = senderWindow(event);
    return window ? stateOf(window) : { isMaximized: false, isFullScreen: false };
  });
}

export interface OpenRdpWindowOptions {
  sessionId: string;
  title: string;
  fullScreen: boolean;
  /** Open maximized, taskbar visible. Ignored when `fullScreen` is on. */
  maximized: boolean;
  onClosed: () => void;
}

export function openRdpWindow(options: OpenRdpWindowOptions): BrowserWindow {
  registerWindowControlHandlers();

  const window = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 640,
    minHeight: 400,
    show: false,
    ...titleBarFrameOptions(),
    autoHideMenuBar: true,
    backgroundColor: '#050807',
    title: options.title,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once('ready-to-show', () => {
    if (options.fullScreen) {
      if (!keepWindowsHidden) window.show();
      window.setFullScreen(true);
      return;
    }
    if (keepWindowsHidden) return;
    // Maximizing also shows a hidden window, hence the guard above. Unlike full screen it leaves
    // the taskbar visible.
    if (options.maximized) window.maximize();
    window.show();
  });
  // The page sets its own title from React; keep the server's name on the taskbar instead.
  window.on('page-title-updated', (event) => event.preventDefault());

  const sendState = (): void => {
    if (!window.isDestroyed()) sendToWindow(window, IPC.rdpWindow.onStateChange, stateOf(window));
  };
  window.on('maximize', sendState);
  window.on('unmaximize', sendState);
  window.on('enter-full-screen', () => {
    sendState();
    runInPage(window, ENTER_HTML_FULLSCREEN);
  });
  window.on('leave-full-screen', () => {
    sendState();
    runInPage(window, EXIT_HTML_FULLSCREEN);
  });

  window.on('closed', () => {
    windows.delete(options.sessionId);
    options.onClosed();
  });

  const hash = `/rdp-session?session=${encodeURIComponent(options.sessionId)}`;
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }

  windows.set(options.sessionId, window);
  return window;
}

/** The open window of a Remote Desktop session, or null once it has closed. */
export function getRdpWindow(sessionId: string): BrowserWindow | null {
  const window = windows.get(sessionId);
  return window && !window.isDestroyed() ? window : null;
}

/**
 * An AI task reads the session's canvas, which Chromium stops painting in a covered or minimized
 * window unless throttling is off. Runs turn it off for their length and back on afterwards.
 */
export function setRdpWindowBackgroundThrottling(sessionId: string, enabled: boolean): void {
  getRdpWindow(sessionId)?.webContents.setBackgroundThrottling(enabled);
}

export function closeAllRdpWindows(): void {
  for (const window of windows.values()) window.close();
}
