import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, shell, type WebContents } from 'electron';
import icon from '../../../resources/icon.ico?asset';
import { IPC } from '../../shared/ipcChannels';
import type {
  SftpPopOutView,
  SftpSessionInfo,
  SftpWindowAction,
  SftpWindowState,
} from '../../shared/sftpTypes';
import { sendToWindow } from '../ipc/send';
import { focusMainWindow, getMainWindow } from '../mainWindow';
import { themeBackground } from '../splashWindow';
import { keepWindowsHidden } from '../testMode';
import { titleBarFrameOptions } from '../windowChrome';
import { currentWindowTheme } from '../windowGlass';

/**
 * The file manager in a window of its own (E25, F2), built like the Remote Desktop session
 * windows. One window per session: it is let into the session as another owner before its page
 * loads, so the page's own `sftp.open(serverId)` answers that same session and its queue and
 * conflicts reach both windows. Closing it (its X, or Back to main window) first hands its
 * sessions to the main window, so one it opened on its own after the main window disconnected
 * keeps going there with its transfers, then takes it out of them. With no main window left
 * (it closed, or the app is quitting) they end as the last owner goes. A crashed page does the
 * same: its sessions go to the main window and the window closes.
 *
 * The window holds the file manager's privileges, so its page never navigates away (a file
 * dropped on it would otherwise replace the page and keep them) and opens no windows of its own:
 * web links go to the browser.
 *
 * The page draws its own title bar, and its controls come back here through channels that act
 * on the asking window alone. The pop-outs close with the main window and at quit.
 */

/** What a pop-out needs from the sessions. */
export interface SftpWindowOwners {
  addOwner(sessionId: string, ownerId: number): void;
  adoptSessions(fromOwner: number, toOwner: number): void;
  dropOwner(ownerId: number): Promise<void>;
}

interface PopOut {
  window: BrowserWindow;
  sessionId: string;
  serverId: string;
}

const windows = new Map<string, PopOut>();
/** Main windows already told to take the pop-outs with them when they close. */
const watchedMainWindows = new WeakSet<BrowserWindow>();

function stateOf(window: BrowserWindow): SftpWindowState {
  return { isMaximized: window.isMaximized() };
}

function popOutOf(contents: WebContents): PopOut | null {
  for (const entry of windows.values()) {
    if (!entry.window.isDestroyed() && entry.window.webContents === contents) return entry;
  }
  return null;
}

function closeWithMainWindow(): void {
  // On Windows and Linux the app would otherwise linger with only the pop-outs open. macOS keeps
  // the app running without the main window, so the pop-outs stay too.
  if (process.platform === 'darwin') return;
  const main = getMainWindow();
  if (!main || watchedMainWindows.has(main)) return;
  watchedMainWindows.add(main);
  main.once('closed', closeAllSftpWindows);
}

/** Gives the pop-out's sessions to the main window, while there is one. */
function handToMainWindow(owners: SftpWindowOwners, ownerId: number): void {
  const main = getMainWindow();
  if (main && !main.isDestroyed()) owners.adoptSessions(ownerId, main.webContents.id);
}

/** Whether `url` is the app's own page, the only one the pop-out may show. */
function isAppPage(url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return target.origin === new URL(devServer).origin;
  const page = new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).href);
  return target.protocol === 'file:' && target.pathname === page.pathname;
}

/**
 * Opens the session's window at the folders of `view` (checked by the IPC layer), or brings it
 * to the front, where it is, when it is open already. Throws, with no window left behind, when
 * the session is gone.
 */
export function openSftpWindow(
  owners: SftpWindowOwners,
  info: SftpSessionInfo,
  view: SftpPopOutView = {},
): BrowserWindow {
  const open = windows.get(info.sessionId);
  if (open && !open.window.isDestroyed()) {
    // A window that left the session (its page reloaded after a crash) is let in again.
    owners.addOwner(info.sessionId, open.window.webContents.id);
    if (open.window.isMinimized()) open.window.restore();
    if (!keepWindowsHidden) open.window.show();
    open.window.focus();
    return open.window;
  }

  const theme = currentWindowTheme();
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    ...titleBarFrameOptions(),
    autoHideMenuBar: true,
    backgroundColor: themeBackground(theme),
    title: `${info.nickname} - Files`,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const ownerId = window.webContents.id;
  try {
    owners.addOwner(info.sessionId, ownerId);
  } catch (error) {
    window.destroy();
    throw error;
  }

  const entry: PopOut = { window, sessionId: info.sessionId, serverId: info.serverId };
  windows.set(info.sessionId, entry);

  window.once('ready-to-show', () => {
    if (!keepWindowsHidden) window.show();
  });
  // The page sets its own title from React; keep the server's name on the taskbar instead.
  window.on('page-title-updated', (event) => event.preventDefault());
  const sendState = (): void => {
    if (!window.isDestroyed()) sendToWindow(window, IPC.sftp.onWindowState, stateOf(window));
  };
  window.on('maximize', sendState);
  window.on('unmaximize', sendState);
  // Before the window goes, while its sessions are still there to hand over.
  window.on('close', () => handToMainWindow(owners, ownerId));
  // Registered before the IPC layer's own listener (on the first call), which drops the owner.
  window.webContents.on('render-process-gone', () => {
    handToMainWindow(owners, ownerId);
    if (!window.isDestroyed()) window.close();
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppPage(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('closed', () => {
    if (windows.get(info.sessionId) === entry) windows.delete(info.sessionId);
    void owners.dropOwner(ownerId).catch(() => undefined);
  });
  closeWithMainWindow();

  // The page reads the theme before its first paint, like the main window's does, and opens its
  // panes at the folders its opener showed.
  const query = new URLSearchParams({ server: info.serverId, theme });
  if (view.remotePath) query.set('remote', view.remotePath);
  if (view.localPath) query.set('local', view.localPath);
  const hash = `/sftp-window?${query}`;
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash });
  }
  return window;
}

/** Whether `contents` is an open pop-out's page, which the SFTP channels answer like the main window. */
export function isSftpWindow(contents: WebContents): boolean {
  return popOutOf(contents) !== null;
}

/** The main window and the open pop-outs, which share one session per server. */
export function sftpLinkedOwners(): number[] {
  const linked: number[] = [];
  const main = getMainWindow();
  if (main && !main.isDestroyed()) linked.push(main.webContents.id);
  for (const { window } of windows.values()) {
    if (!window.isDestroyed()) linked.push(window.webContents.id);
  }
  return linked;
}

/** Minimizes, maximizes (or restores) or closes the asking pop-out. Any other window is ignored. */
export function sftpWindowControl(contents: WebContents, action: SftpWindowAction): void {
  const window = popOutOf(contents)?.window;
  if (!window) return;
  if (action === 'minimize') window.minimize();
  else if (action === 'close') window.close();
  else if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}

export function sftpWindowState(contents: WebContents): SftpWindowState {
  const window = popOutOf(contents)?.window;
  return window ? stateOf(window) : { isMaximized: false };
}

/**
 * Hands the pop-out's sessions to the main window, brings it to the front on the pop-out's server
 * page (where its `open` finds the session), then closes the pop-out.
 */
export function sftpBackToMain(owners: SftpWindowOwners, contents: WebContents): void {
  const entry = popOutOf(contents);
  if (!entry) return;
  handToMainWindow(owners, contents.id);
  focusMainWindow(`/ssh-files/${encodeURIComponent(entry.serverId)}`);
  entry.window.close();
}

/** With the main window, and at quit. */
export function closeAllSftpWindows(): void {
  for (const { window } of [...windows.values()]) {
    if (!window.isDestroyed()) window.close();
  }
}
