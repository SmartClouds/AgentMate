import { BROWSER_PARTITION, type GuestShortcut } from '../../shared/browserGuest';

/**
 * Rules for the pages the workspace browser loads. They are arbitrary sites sitting next to the
 * app's own renderer, so a guest gets no Node, no preload, no nested webviews and its own
 * session, and only a handful of permissions.
 */

const LOCKED_PREFERENCES = {
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  experimentalFeatures: false,
} as const;

function loadable(src: string | undefined): boolean {
  if (src === 'about:blank') return true;
  try {
    const { protocol } = new URL(src ?? '');
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Called from `will-attach-webview`. Locks down the guest's preferences in place and returns
 * whether the webview may attach at all, which it may only for a web page.
 */
export function sanitizeWebviewAttach(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
): boolean {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  Object.assign(webPreferences, LOCKED_PREFERENCES);
  delete params.preload;
  params.partition = BROWSER_PARTITION;
  return loadable(params.src);
}

/** The browser action a key press in a page stands for, or null to leave it to the page. */
export function guestShortcut(
  input: Electron.Input,
  platform: NodeJS.Platform,
): GuestShortcut | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;
  const mac = platform === 'darwin';
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;

  if (key === 'F12') return 'devtools';
  if (key === 'F5' && !mod) return 'reload';
  if (mod && input.shift && key === 'c') return 'pick';
  if (mod && input.shift && key === 'i' && !mac) return 'devtools';
  if (mac && mod && input.alt && key === 'i') return 'devtools';
  if (mod && !input.alt && key === 'l' && !input.shift) return 'focusAddress';
  if (mod && !input.alt && key === 'r') return input.shift ? 'hardReload' : 'reload';
  if (!mac && input.alt && !input.control && !input.shift) {
    if (key === 'ArrowLeft') return 'back';
    if (key === 'ArrowRight') return 'forward';
  }
  if (mac && mod && !input.shift) {
    if (key === '[') return 'back';
    if (key === ']') return 'forward';
  }
  return null;
}

/** The session's user agent without the Electron and app tokens, so sites see plain Chrome. */
export function browserUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s(?:Electron|runova[\w-]*|Runova)\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/**
 * Whether a page may have a permission it asked for. Only harmless ones: a copy button and a
 * video going fullscreen within its tab. Camera, location, notifications and device access are
 * refused rather than prompted for, since nothing in the app would show the prompt.
 */
export function guestPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}
