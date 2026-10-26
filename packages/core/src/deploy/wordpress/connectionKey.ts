import { WP_PROTOCOL_VERSION, type WpScope } from './protocol.js';

/**
 * The connection key a WordPress admin copies out of wp-admin (or `wp runova key create`)
 * and pastes into Runova: `amwp1.` then base64url of a JSON object. It carries everything the
 * first contact needs, including the site's whole Ed25519 public key, so even the first reply is
 * checked against a key the admin handed over rather than one the network offered.
 *
 * The key holds a pairing secret. It is good once, for 15 minutes, and is never logged, stored or
 * echoed back in an error.
 */

export const WP_KEY_PREFIX = 'amwp1.';

export interface WpConnectionKey {
  /** home_url(): the site people visit. */
  siteUrl: string;
  /** rest_url('runova/v1'), already in `?rest_route=` form when permalinks are plain. */
  restUrl: string;
  /** admin_url('admin-ajax.php'), the fallback when the REST API is blocked. */
  ajaxUrl: string;
  pairingId: string;
  /** 32 random bytes, base64url. */
  pairingSecret: string;
  /** The site's raw 32-byte Ed25519 public key, base64url. */
  sitePublicKey: string;
  scope: WpScope;
  /** Unix seconds after which the key no longer pairs. */
  expiresAt: number;
  label?: string;
}

export type WpConnectionKeyError = 'format' | 'version' | 'fields' | 'url' | 'expired';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((char, index) => [char, index]),
);

/** base64url without padding (RFC 4648 section 5). */
export function wpBase64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out +=
      ALPHABET[(chunk >> 18) & 63] +
      ALPHABET[(chunk >> 12) & 63] +
      ALPHABET[(chunk >> 6) & 63] +
      ALPHABET[chunk & 63];
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const chunk = bytes[index] << 16;
    out += ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63];
  } else if (rest === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out +=
      ALPHABET[(chunk >> 18) & 63] + ALPHABET[(chunk >> 12) & 63] + ALPHABET[(chunk >> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url: no padding, no other alphabet, and the unused low bits of the last
 * character must be zero, so every byte string has exactly one accepted spelling. Null otherwise.
 */
export function wpBase64UrlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const values: number[] = [];
  for (const char of text) {
    const value = LOOKUP[char];
    if (value === undefined) return null;
    values.push(value);
  }
  const out = new Uint8Array(Math.floor((values.length * 3) / 4));
  let at = 0;
  let index = 0;
  for (; index + 3 < values.length; index += 4) {
    const chunk =
      (values[index] << 18) |
      (values[index + 1] << 12) |
      (values[index + 2] << 6) |
      values[index + 3];
    out[at++] = (chunk >> 16) & 255;
    out[at++] = (chunk >> 8) & 255;
    out[at++] = chunk & 255;
  }
  const rest = values.length - index;
  if (rest === 2) {
    if ((values[index + 1] & 15) !== 0) return null;
    out[at++] = ((values[index] << 2) | (values[index + 1] >> 4)) & 255;
  } else if (rest === 3) {
    if ((values[index + 2] & 3) !== 0) return null;
    const chunk = (values[index] << 12) | (values[index + 1] << 6) | values[index + 2];
    out[at++] = (chunk >> 10) & 255;
    out[at++] = (chunk >> 2) & 255;
  }
  return out;
}

/** base64url of exactly `length` bytes. */
export function isWpBase64UrlBytes(text: unknown, length: number): text is string {
  if (typeof text !== 'string') return false;
  return wpBase64UrlDecode(text)?.length === length;
}

/**
 * How a URL travels: HTTPS, plain HTTP to this computer (allowed for development), or plain HTTP
 * over the network (refused unless the user opts in for that site). Anything that is not an
 * http(s) URL counts as plain HTTP, the strictest answer.
 */
export function wpTransportSecurity(url: string): 'https' | 'local-http' | 'plain-http' {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'plain-http';
  }
  if (parsed.protocol === 'https:') return 'https';
  if (parsed.protocol !== 'http:') return 'plain-http';
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return 'local-http';
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local-http';
  return 'plain-http';
}

/** The weakest of the key's three URLs, which is what the connection gets. */
export function wpKeyTransportSecurity(
  key: Pick<WpConnectionKey, 'siteUrl' | 'restUrl' | 'ajaxUrl'>,
): 'https' | 'local-http' | 'plain-http' {
  const all = [key.siteUrl, key.restUrl, key.ajaxUrl].map(wpTransportSecurity);
  if (all.includes('plain-http')) return 'plain-http';
  if (all.includes('local-http')) return 'local-http';
  return 'https';
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const PAIRING_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/**
 * Reads a pasted key. Whitespace anywhere is dropped first, since keys get wrapped and indented
 * on the way from wp-admin to the clipboard.
 */
export function parseWpConnectionKey(
  text: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true; key: WpConnectionKey } | { ok: false; error: WpConnectionKeyError } {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith('amwp') || compact.length > 4096) return { ok: false, error: 'format' };
  if (!compact.startsWith(WP_KEY_PREFIX)) return { ok: false, error: 'version' };
  const bytes = wpBase64UrlDecode(compact.slice(WP_KEY_PREFIX.length));
  if (!bytes) return { ok: false, error: 'format' };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, error: 'format' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'format' };
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== WP_PROTOCOL_VERSION) return { ok: false, error: 'version' };
  if (
    typeof raw.i !== 'string' ||
    !PAIRING_ID.test(raw.i) ||
    !isWpBase64UrlBytes(raw.s, 32) ||
    !isWpBase64UrlBytes(raw.k, 32) ||
    (raw.c !== 'read' && raw.c !== 'write') ||
    typeof raw.x !== 'number' ||
    !Number.isSafeInteger(raw.x) ||
    (raw.l !== undefined && (typeof raw.l !== 'string' || [...raw.l].length > 100))
  ) {
    return { ok: false, error: 'fields' };
  }
  if (!isHttpUrl(raw.u) || !isHttpUrl(raw.r) || !isHttpUrl(raw.a))
    return { ok: false, error: 'url' };
  if (raw.x <= nowSeconds) return { ok: false, error: 'expired' };
  const key: WpConnectionKey = {
    siteUrl: raw.u,
    restUrl: raw.r,
    ajaxUrl: raw.a,
    pairingId: raw.i,
    pairingSecret: raw.s,
    sitePublicKey: raw.k,
    scope: raw.c,
    expiresAt: raw.x,
  };
  if (typeof raw.l === 'string' && raw.l.trim() !== '') key.label = raw.l.trim();
  return { ok: true, key };
}

/** The inverse of parseWpConnectionKey, with the keys in the order the plugin writes them. */
export function formatWpConnectionKey(key: WpConnectionKey): string {
  const json: Record<string, unknown> = {
    v: WP_PROTOCOL_VERSION,
    u: key.siteUrl,
    r: key.restUrl,
    a: key.ajaxUrl,
    i: key.pairingId,
    s: key.pairingSecret,
    k: key.sitePublicKey,
    c: key.scope,
    x: key.expiresAt,
  };
  if (key.label !== undefined) json.l = key.label;
  return WP_KEY_PREFIX + wpBase64UrlEncode(new TextEncoder().encode(JSON.stringify(json)));
}
