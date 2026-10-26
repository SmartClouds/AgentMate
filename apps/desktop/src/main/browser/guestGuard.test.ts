import { describe, expect, it } from 'vitest';
import { BROWSER_PARTITION } from '../../shared/browserGuest';
import {
  browserUserAgent,
  guestPermissionAllowed,
  guestShortcut,
  sanitizeWebviewAttach,
} from './guestGuard';

/**
 * The workspace browser loads arbitrary sites next to the app's own renderer, so the rules that
 * keep a guest page away from Node, the preload bridge and the app's session live here, as plain
 * functions the webview hooks in main/browser/guestSession.ts call.
 */

describe('sanitizeWebviewAttach', () => {
  function attach(
    params: Record<string, string> = {},
    webPreferences: Record<string, unknown> = {},
  ) {
    const prefs: Record<string, unknown> = { ...webPreferences };
    const all: Record<string, string> = { src: 'http://localhost:5173/', ...params };
    const allowed = sanitizeWebviewAttach(prefs, all);
    return { allowed, prefs, params: all };
  }

  it('lets a page load with node, the preload and nested webviews stripped', () => {
    const { allowed, prefs } = attach(
      {},
      {
        preload: 'C:/evil.js',
        preloadURL: 'file:///evil.js',
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        nodeIntegrationInWorker: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        webviewTag: true,
        experimentalFeatures: true,
      },
    );
    expect(allowed).toBe(true);
    expect(prefs).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
    });
  });

  it('pins every guest to the browser partition', () => {
    expect(attach({ partition: 'persist:other' }).params.partition).toBe(BROWSER_PARTITION);
    expect(attach().params.partition).toBe(BROWSER_PARTITION);
  });

  it('drops a preload passed as a webview attribute', () => {
    const { params } = attach({ preload: 'file:///evil.js' });
    expect(params.preload).toBeUndefined();
  });

  it.each(['http://localhost:3000/', 'https://example.com/', 'about:blank'])('allows %s', (src) => {
    expect(attach({ src }).allowed).toBe(true);
  });

  it.each([
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'chrome://gpu',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
    '',
  ])('refuses %j', (src) => {
    expect(attach({ src }).allowed).toBe(false);
  });
});

describe('guestShortcut', () => {
  const key = (input: Partial<Electron.Input>): Electron.Input =>
    ({
      type: 'keyDown',
      key: '',
      code: '',
      control: false,
      meta: false,
      shift: false,
      alt: false,
      isAutoRepeat: false,
      ...input,
    }) as Electron.Input;

  it.each([
    [{ key: 'C', shift: true, control: true }, 'win32', 'pick'],
    [{ key: 'c', shift: true, meta: true }, 'darwin', 'pick'],
    [{ key: 'l', control: true }, 'win32', 'focusAddress'],
    [{ key: 'l', meta: true }, 'darwin', 'focusAddress'],
    [{ key: 'r', control: true }, 'linux', 'reload'],
    [{ key: 'F5' }, 'win32', 'reload'],
    [{ key: 'R', control: true, shift: true }, 'win32', 'hardReload'],
    [{ key: 'ArrowLeft', alt: true }, 'win32', 'back'],
    [{ key: 'ArrowRight', alt: true }, 'linux', 'forward'],
    [{ key: '[', meta: true }, 'darwin', 'back'],
    [{ key: ']', meta: true }, 'darwin', 'forward'],
    [{ key: 'F12' }, 'win32', 'devtools'],
    [{ key: 'I', control: true, shift: true }, 'win32', 'devtools'],
    [{ key: 'i', meta: true, alt: true }, 'darwin', 'devtools'],
  ] as const)('maps %o on %s to %s', (input, platform, expected) => {
    expect(guestShortcut(key(input), platform)).toBe(expected);
  });

  it.each([
    [{ key: 'c', control: true }, 'win32'],
    [{ key: 'l', meta: true }, 'win32'],
    [{ key: 'Escape' }, 'win32'],
    [{ key: 'ArrowLeft' }, 'win32'],
    [{ key: 'a' }, 'darwin'],
  ] as const)('leaves %o on %s to the page', (input, platform) => {
    expect(guestShortcut(key(input), platform)).toBeNull();
  });

  it('only reacts to key presses, not releases or repeats', () => {
    expect(guestShortcut(key({ type: 'keyUp', key: 'F5' }), 'win32')).toBeNull();
    expect(guestShortcut(key({ key: 'F5', isAutoRepeat: true }), 'win32')).toBeNull();
  });
});

describe('browserUserAgent', () => {
  it('removes the Electron and app tokens so sites see a plain Chrome', () => {
    expect(
      browserUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) runova-desktop/1.51.0 Chrome/140.0.0.0 Electron/43.3.0 Safari/537.36',
      ),
    ).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    );
  });
});

describe('guestPermissionAllowed', () => {
  it('lets a page write to the clipboard and go fullscreen inside its tab', () => {
    expect(guestPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect(guestPermissionAllowed('fullscreen')).toBe(true);
  });

  it.each(['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'hid', 'serial'])(
    'refuses %s',
    (permission) => {
      expect(guestPermissionAllowed(permission)).toBe(false);
    },
  );
});
