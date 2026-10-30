import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  webContents,
} from 'electron';
import { BROWSER_PARTITION } from '../../../shared/browserGuest';
import type { LoginPage } from './fillSession';

/**
 * Runova's login window: a plain browser window for one-click login. It shares the Workspace
 * browser's session, so a site signed in here is signed in there too, and that session already
 * has the browser's permission rules (see main/browser/guestSession.ts). The page gets no
 * preload and no Node; main fills it through executeJavaScript and nothing comes back but the
 * filler's yes or no answers.
 */

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function loginWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 820,
    minWidth: 480,
    minHeight: 400,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

export function asLoginPage(contents: WebContents): LoginPage {
  return {
    getURL: () => contents.getURL(),
    isDestroyed: () => contents.isDestroyed(),
    executeJavaScript: (code) => contents.executeJavaScript(code),
    on: (event, listener) => contents.on(event as 'did-finish-load', listener),
    removeListener: (event, listener) =>
      contents.removeListener(event as 'did-finish-load', listener),
  };
}

export function openLoginWindow(url: string): LoginPage {
  const win = new BrowserWindow(loginWindowOptions());
  const contents = win.webContents;
  // Sign-in popups (an SSO provider, say) open in the same window rather than a new one.
  contents.setWindowOpenHandler(({ url: next }) => {
    if (isWebUrl(next)) void contents.loadURL(next);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, next) => {
    if (!isWebUrl(next)) event.preventDefault();
  });
  void win.loadURL(url);
  return asLoginPage(contents);
}

/**
 * The Workspace browser tab with this webContents id, as a page to fill. Only a webview guest of
 * the main window qualifies, so the renderer can't point a fill at any other window.
 */
export function guestLoginPage(
  id: number,
  host: WebContents | null,
  fromId: (id: number) => WebContents | null | undefined = (n) => webContents.fromId(n),
): LoginPage | null {
  const guest = fromId(id);
  if (!guest || !host || guest.isDestroyed()) return null;
  if (guest.getType() !== 'webview' || guest.hostWebContents !== host) return null;
  return asLoginPage(guest);
}
