import { wordPressError } from '../../../shared/wordpressErrors';
import { cleanSiteOrigin } from './siteText';

/**
 * How the WordPress client reaches a site (E19). The client hands over a finished request and
 * gets back the status, headers and body; everything about signing and checking stays in the
 * client. Injectable, so tests can drive the client against the fake connector with Node's
 * fetch, while the app uses Electron's network stack (net.fetch), which honours the system
 * proxy and the operating system's certificate store.
 *
 * What net.fetch does in Electron 43 (checked against a local server):
 * - `redirect: 'manual'` never hands back the 3xx: the call rejects with "Redirect was
 *   cancelled". Node's fetch returns the 3xx response instead. Both become `[wp:redirected]`;
 *   signed calls never follow a redirect.
 * - `credentials: 'omit'` sends no cookies, even when the session's jar has some for the host
 *   (a redirect's Set-Cookie still lands in the jar), so every request here sets it.
 * - Binary request and response bodies arrive byte for byte.
 * - An untrusted certificate rejects with `net::ERR_CERT_*` (AUTHORITY_INVALID, DATE_INVALID,
 *   COMMON_NAME_INVALID); other failures are `net::ERR_*` codes (NAME_NOT_RESOLVED,
 *   CONNECTION_REFUSED, UNSAFE_PORT for ports Chromium blocks). TLS checks are never turned off.
 * - A 401 with `WWW-Authenticate: Basic` comes back as a plain 401 response; an Authorization
 *   header set on the request goes through.
 * - An aborted signal rejects with an AbortError.
 */

export interface WpHttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Aborted for a cancel or a timeout; its reason is the error to throw. */
  signal: AbortSignal;
  /** Bytes past which the reply is refused and the read stopped. */
  maxResponseBytes: number;
}

export interface WpHttpResponse {
  status: number;
  header(name: string): string | null;
  body: Uint8Array;
}

export type WpTransport = (request: WpHttpRequest) => Promise<WpHttpResponse>;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const NODE_TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the site';
  }
}

function causeCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : '';
}

/** Turns a network failure into a `[wp:code]` error the renderer can explain. */
export function networkError(error: unknown, request: WpHttpRequest): Error {
  if (request.signal.aborted) {
    const reason = request.signal.reason;
    return reason instanceof Error ? reason : wordPressError('cancelled', 'Stopped.');
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode(error);
  const host = hostOf(request.url);
  if (/redirect/i.test(message)) return redirectedError(null);
  if (/ERR_CERT_/.test(message) || NODE_TLS_CODES.has(code)) {
    return wordPressError(
      'tlsUntrusted',
      `This computer does not trust the HTTPS certificate of ${host} (it may be self-signed, expired or for another name). Trust the certificate in the operating system, or fix it on the server.`,
    );
  }
  if (/ERR_UNSAFE_PORT/.test(message)) {
    return wordPressError(
      'unreachable',
      `${host} uses a port that the network stack refuses to connect to. Use the site's usual web port.`,
    );
  }
  if (/ERR_TIMED_OUT/.test(message) || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return wordPressError('timeout', `${host} took too long to answer.`);
  }
  const detail = message.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? code;
  return wordPressError(
    'unreachable',
    `Could not reach ${host}${detail ? ` (${detail})` : ''}. Check the address and this computer's connection.`,
  );
}

export function redirectedError(location: string | null): Error {
  const origin = cleanSiteOrigin(location);
  return wordPressError(
    'redirected',
    `The site answered with a redirect${origin ? ` to ${origin}` : ''}, and Runova never follows one with a signed call. Check the site address (https, www) under Settings > General in wp-admin, then make a new connection key.`,
  );
}

async function readCapped(response: Response, request: WpHttpRequest): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  const tooLarge = () =>
    wordPressError(
      'foreignResponse',
      `The site sent back more than ${Math.round(request.maxResponseBytes / (1024 * 1024))} MB, which the connector never does.`,
    );
  if (Number.isFinite(declared) && declared > request.maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > request.maxResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A transport over any WHATWG fetch: Electron's net.fetch in the app, Node's fetch in tests. */
export function createFetchTransport(fetchImpl: FetchLike): WpTransport {
  return async (request) => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body as Uint8Array<ArrayBuffer> } : {}),
        signal: request.signal,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      throw networkError(error, request);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw redirectedError(response.headers.get('location'));
    }
    let body: Uint8Array;
    try {
      body = await readCapped(response, request);
    } catch (error) {
      if (error instanceof Error && /^\[wp:/.test(error.message)) throw error;
      throw networkError(error, request);
    }
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      body,
    };
  };
}
