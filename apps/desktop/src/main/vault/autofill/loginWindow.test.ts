import { describe, expect, it, vi } from 'vitest';
import { BROWSER_PARTITION } from '../../../shared/browserGuest';
import { FakeBrowserWindow } from '../../../test/main/electronMock';
import {
  asLoginPage,
  guestLoginPage,
  isWebUrl,
  loginWindowOptions,
  openLoginWindow,
} from './loginWindow';

/** Just enough of a webContents for the adapter and the guest checks. */
function contents(overrides: Record<string, unknown> = {}) {
  return {
    getURL: vi.fn(() => 'https://github.com/login'),
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(async () => 'ran'),
    on: vi.fn(),
    removeListener: vi.fn(),
    getType: vi.fn(() => 'webview'),
    hostWebContents: null as unknown,
    ...overrides,
  };
}

describe('the login window', () => {
  it('is a locked-down window on the shared browser session', () => {
    const options = loginWindowOptions();
    expect(options.webPreferences).toMatchObject({
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    });
    expect(options.webPreferences).not.toHaveProperty('preload');
  });

  it('opens a window and loads the site in it', () => {
    const load = vi.spyOn(FakeBrowserWindow.prototype, 'loadURL');
    openLoginWindow('https://github.com/login');
    const win = FakeBrowserWindow.instances.at(-1);
    expect(win?.options).toMatchObject(loginWindowOptions());
    expect(load).toHaveBeenCalledWith('https://github.com/login');
  });

  it('only goes to web pages', () => {
    expect(isWebUrl('https://github.com/')).toBe(true);
    expect(isWebUrl('http://router.local/')).toBe(true);
    expect(isWebUrl('file:///etc/passwd')).toBe(false);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('not a url')).toBe(false);
  });
});

describe('asLoginPage', () => {
  it('passes every call through to the webContents', async () => {
    const raw = contents();
    const page = asLoginPage(raw as never);
    const listener = () => undefined;
    expect(page.getURL()).toBe('https://github.com/login');
    expect(page.isDestroyed()).toBe(false);
    await expect(page.executeJavaScript('1')).resolves.toBe('ran');
    page.on('did-finish-load', listener);
    page.removeListener('did-finish-load', listener);
    expect(raw.on).toHaveBeenCalledWith('did-finish-load', listener);
    expect(raw.removeListener).toHaveBeenCalledWith('did-finish-load', listener);
  });
});

describe('guestLoginPage', () => {
  const host = { id: 1 };

  it('hands over a browser tab that belongs to the main window', () => {
    const guest = contents({ hostWebContents: host });
    expect(guestLoginPage(7, host as never, () => guest as never)).not.toBeNull();
  });

  it('refuses anything that is not one of the main window tabs', () => {
    const foreign = contents({ hostWebContents: { id: 2 } });
    const window = contents({ getType: () => 'window', hostWebContents: host });
    const gone = contents({ hostWebContents: host, isDestroyed: () => true });
    expect(guestLoginPage(7, host as never, () => foreign as never)).toBeNull();
    expect(guestLoginPage(7, host as never, () => window as never)).toBeNull();
    expect(guestLoginPage(7, host as never, () => gone as never)).toBeNull();
    expect(guestLoginPage(7, host as never, () => null)).toBeNull();
    expect(guestLoginPage(7, null, () => contents({ hostWebContents: host }) as never)).toBeNull();
  });
});
