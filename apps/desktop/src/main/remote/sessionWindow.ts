import { join } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import { IPC } from '../../shared/ipcChannels';
import { sendToWindow } from '../ipc/send';
import { keepWindowsHidden } from '../testMode';
import { titleBarFrameOptions } from '../windowChrome';

/**
 * The active remote-control session gets its own real, resizable/maximizable/
 * fullscreenable BrowserWindow (unlike the small fixed-size usage widgets in
 * `usage/widgetWindows.ts`) so the operator can resize it, drag it to another
 * monitor, or full-screen it independently of the main Runova window. Only
 * one controller connection exists at a time (`RemoteManager.connection` is
 * singular), so this manages a single window rather than a map.
 */

let win: BrowserWindow | null = null;
let onCloseHandler: (() => void) | null = null;
let handlersRegistered = false;

function loadSessionRoute(window: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/remote-session`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/remote-session' });
  }
}

/** Registered once; each handler resolves against whatever `win` currently is. */
function registerWindowControlHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(IPC.remoteSessionWindow.minimize, () => win?.minimize());
  ipcMain.handle(IPC.remoteSessionWindow.maximizeToggle, () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle(IPC.remoteSessionWindow.close, () => win?.close());
  ipcMain.handle(IPC.remoteSessionWindow.isMaximized, () => win?.isMaximized() ?? false);
}

function createSessionWindow(): BrowserWindow {
  registerWindowControlHandlers();

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    show: false,
    ...titleBarFrameOptions(),
    autoHideMenuBar: true,
    backgroundColor: '#050807',
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
    if (!keepWindowsHidden) window.show();
  });
  window.on('maximize', () =>
    sendToWindow(window, IPC.remoteSessionWindow.onMaximizedChange, true),
  );
  window.on('unmaximize', () =>
    sendToWindow(window, IPC.remoteSessionWindow.onMaximizedChange, false),
  );

  // Closing the session window ends the remote-control session, matching how
  // dedicated remote-desktop apps behave: the window IS the connection.
  window.on('closed', () => {
    win = null;
    onCloseHandler?.();
  });

  loadSessionRoute(window);
  win = window;
  return window;
}

export const sessionWindow = {
  /** Called once from RemoteManager.init() to disconnect when the window closes. */
  setOnClose(handler: () => void): void {
    onCloseHandler = handler;
  },

  open(): void {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return;
    }
    createSessionWindow();
  },

  get(): BrowserWindow | null {
    return win;
  },

  setTitle(title: string): void {
    win?.setTitle(title);
  },

  close(): void {
    win?.close();
  },
};
