import type { KeyObject } from 'node:crypto';
import {
  decodeWpFrame,
  decodeWpResponse,
  encodeWpFrame,
  encodeWpMultipart,
  formatWpAuthField,
  isWpLegacyRestUrl,
  WP_AJAX_ACTION,
  WP_BATCH_MAX_BYTES,
  WP_BATCH_MIN_BYTES,
  WP_BATCH_START_BYTES,
  WP_LEGACY_AJAX_ACTION,
  WP_LEGACY_PROTOCOL_PREFIX,
  WP_PROTOCOL_PREFIX,
  WP_ROUTE_PARAM,
  type WpErrorCode,
  type WpLimits,
  type WpResponseBody,
  type WpRoute,
  type WpRouteMap,
  type WpSigningPrefix,
  wpCanonicalRequest,
  wpCanonicalResponse,
} from '@runova/core';
import {
  encodeWordPressError,
  isWordPressErrorCode,
  type WordPressErrorCode,
} from '../../../shared/wordpressErrors';
import {
  gunzipBytes,
  gzipBytes,
  randomBoundary,
  randomNonce,
  sha256Hex,
  signEd25519,
  verifyEd25519,
} from './crypto';
import { cleanSiteText } from './siteText';
import type { WpHttpResponse, WpTransport } from './transport';

/**
 * The signed client for one Runova Connector site (E19). Every call is a multipart POST with
 * `am_auth` and a gzip bundle, signed with this computer's key for the site (or unsigned for
 * `/hello`). Every reply must be an envelope signed by the site key pinned at pairing, over the
 * route, this request's nonce, the status and the payload hash, so a cached, replayed or
 * substituted reply is refused. Anything that is not an envelope (a CDN challenge, a host's error
 * page, a security plugin's block) is a foreign response, never read as data.
 *
 * The client never follows a redirect, fixes its clock once per call when the site says the
 * timestamp is stale, backs off on 429, and tries the REST URL, then admin-ajax, until one of
 * them answers with a verified reply; after that it stays with the one that worked. `/rescue/*`
 * calls fall back to rescue.php when the site itself is failing.
 *
 * A site connected before the rename has its REST address under the old namespace. Calls to it
 * go out the way a 1.63 app sends them (old ajax action, old signing prefix), which both the 1.63
 * plugin and the current one take, until the app saves the new addresses the site reports.
 */

export interface WpEndpoints {
  restUrl: string;
  ajaxUrl: string;
  rescueUrl: string | null;
}

export type WpEndpointKind = 'rest' | 'ajax';

export interface WpHttpAuth {
  username: string;
  password: string;
}

export interface WpClientOptions {
  transport: WpTransport;
  endpoints: WpEndpoints;
  /** The site's raw Ed25519 key, base64url: from the connection key, then from the store. */
  sitePublicKey: string;
  /** Null for `/hello` and `/pair`. */
  connectionId: string | null;
  /** Null only for `/hello`, which is unsigned. */
  privateKey: KeyObject | null;
  httpAuth?: WpHttpAuth | null;
  endpoint?: WpEndpointKind | null;
  /** Seconds to add to this computer's clock to get the site's. */
  clockOffset?: number;
  /** Milliseconds. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Per call, unless the call says otherwise. */
  timeoutMs?: number;
  /** The most a reply may be on the wire, and once unpacked. */
  maxResponseBytes?: number;
  maxUnpackedBytes?: number;
}

export interface WpCallOptions {
  signal?: AbortSignal;
  blobs?: Uint8Array[];
  timeoutMs?: number;
}

export interface WpCallResult<T> {
  data: T;
  blobs: Uint8Array[];
  durationMs: number;
}

/** The request body, or a function of the auth it goes out with (the pair proof needs that). */
export type WpRequestBody<R extends WpRoute> =
  | WpRouteMap[R]['request']
  | ((auth: { timestamp: number; nonce: string }) => WpRouteMap[R]['request']);

/** An error with its `[wp:code]` in the message, and what the site said beside it. */
export class WpRemoteError extends Error {
  constructor(
    readonly code: WordPressErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** The signed status, or the HTTP status of a foreign reply. */
    readonly status: number | null = null,
  ) {
    super(encodeWordPressError(code, message));
    this.name = 'WpRemoteError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE = 40 * 1024 * 1024;
const DEFAULT_MAX_UNPACKED = 48 * 1024 * 1024;
const RATE_LIMIT_RETRIES = 3;
/** Longer waits than this are reported instead of slept through. */
const MAX_RATE_WAIT_SECONDS = 30;

const PLUGIN_CODES: ReadonlySet<string> = new Set<WpErrorCode>([
  'badRequest',
  'unauthorized',
  'badSignature',
  'staleTimestamp',
  'replayed',
  'unknownConnection',
  'revoked',
  'readOnly',
  'fileModsDisabled',
  'notDirect',
  'disabled',
  'pathRejected',
  'itemUnknown',
  'itemProtected',
  'deployUnknown',
  'conflict',
  'syntaxError',
  'busy',
  'invalidState',
  'tooLarge',
  'rateLimited',
  'pairingInvalid',
  'pairingExpired',
  'protocolMismatch',
  'updateRefused',
  'internal',
]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `.../wp-json/runova/v1` + route, or the `?rest_route=` form plain permalinks give. */
export function wpRestRouteUrl(restUrl: string, route: WpRoute): string {
  const url = new URL(restUrl);
  const restRoute = url.searchParams.get('rest_route');
  if (restRoute !== null) {
    url.searchParams.set('rest_route', `${restRoute.replace(/\/+$/, '')}${route}`);
  } else {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${route}`;
  }
  return url.toString();
}

export function wpAjaxRouteUrl(
  ajaxUrl: string,
  route: WpRoute,
  action: string = WP_AJAX_ACTION,
): string {
  const url = new URL(ajaxUrl);
  url.searchParams.set('action', action);
  url.searchParams.set(WP_ROUTE_PARAM, route);
  return url.toString();
}

/** rescue.php takes the route the same way admin-ajax does (WP_ROUTE_PARAM). */
export function wpRescueRouteUrl(rescueUrl: string, route: WpRoute): string {
  const url = new URL(rescueUrl);
  url.searchParams.set(WP_ROUTE_PARAM, route);
  return url.toString();
}

function retryAfterSeconds(response: WpHttpResponse | null, details: Record<string, unknown>) {
  const fromDetails = details.retryAfter;
  if (typeof fromDetails === 'number' && Number.isFinite(fromDetails) && fromDetails >= 0) {
    return Math.ceil(fromDetails);
  }
  const raw = response?.header('retry-after')?.trim();
  const header = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(header) && header >= 0 ? Math.ceil(header) : null;
}

function foreignMessage(response: WpHttpResponse): string {
  const status = response.status;
  const server = response.header('server') ?? '';
  if (response.header('cf-mitigated') === 'challenge' || /cloudflare/i.test(server)) {
    return `Cloudflare answered instead of Runova Connector (HTTP ${status}), most likely with a bot check. Add a Cloudflare rule that skips challenges for /wp-json/runova/ and /wp-admin/admin-ajax.php.`;
  }
  if (status === 404) {
    return 'The site has no Runova Connector at that address (HTTP 404). Check that the plugin is installed and active.';
  }
  return `Something other than Runova Connector answered (HTTP ${status}). A firewall, a security plugin or the host may be blocking it.`;
}

export class WpClient {
  endpoint: WpEndpointKind | null;
  clockOffset: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: WpClientOptions) {
    this.endpoint = options.endpoint ?? null;
    this.clockOffset = options.clockOffset ?? 0;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get connectionId(): string | null {
    return this.options.connectionId;
  }

  /** The site was reached at its 1.63 addresses, so calls are signed the 1.63 way. */
  get legacy(): boolean {
    return isWpLegacyRestUrl(this.options.endpoints.restUrl);
  }

  /** What this client signs with, and expects replies to be signed with first. */
  get signingPrefix(): WpSigningPrefix {
    return this.legacy ? WP_LEGACY_PROTOCOL_PREFIX : WP_PROTOCOL_PREFIX;
  }

  /** The HTTP Basic header for the site, for the desktop's own GET of its home page. */
  basicAuthHeader(): string | null {
    const auth = this.options.httpAuth;
    return auth
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64')}`
      : null;
  }

  /** The site's clock, in Unix seconds, as far as this client knows it. */
  siteNow(): number {
    return Math.floor(this.now() / 1000) + this.clockOffset;
  }

  async call<R extends WpRoute>(
    route: R,
    body: WpRequestBody<R>,
    options: WpCallOptions = {},
  ): Promise<WpCallResult<WpRouteMap[R]['response']>> {
    let clockFixed = false;
    let rateTries = 0;
    for (;;) {
      try {
        return await this.viaEndpoints(route, body, options);
      } catch (error) {
        if (!(error instanceof WpRemoteError)) throw error;
        if (error.code === 'staleTimestamp' && !clockFixed) {
          const serverTime = error.details.serverTime;
          if (typeof serverTime === 'number' && Number.isSafeInteger(serverTime)) {
            this.clockOffset = serverTime - Math.floor(this.now() / 1000);
            clockFixed = true;
            continue;
          }
        }
        if (error.code === 'rateLimited') {
          const wait = error.details.retryAfter as number | null;
          if (rateTries < RATE_LIMIT_RETRIES && (wait === null || wait <= MAX_RATE_WAIT_SECONDS)) {
            rateTries += 1;
            await this.sleep((wait ?? 2 ** rateTries) * 1000, options.signal);
            continue;
          }
          throw new WpRemoteError(
            'rateLimited',
            wait && wait > MAX_RATE_WAIT_SECONDS
              ? `The site is limiting calls from this computer. Try again in about ${Math.ceil(wait / 60)} minutes.`
              : 'The site is limiting calls from this computer. Wait a few minutes and try again.',
            error.details,
            error.status,
          );
        }
        throw error;
      }
    }
  }

  private urlsFor(route: WpRoute): { kind: WpEndpointKind | 'rescue'; url: string }[] {
    const { restUrl, ajaxUrl, rescueUrl } = this.options.endpoints;
    const kinds: (WpEndpointKind | 'rescue')[] = this.endpoint ? [this.endpoint] : ['rest', 'ajax'];
    if (route.startsWith('/rescue/') && rescueUrl) kinds.push('rescue');
    return kinds.map((kind) => ({
      kind,
      url:
        kind === 'rest'
          ? wpRestRouteUrl(restUrl, route)
          : kind === 'ajax'
            ? wpAjaxRouteUrl(ajaxUrl, route, this.legacy ? WP_LEGACY_AJAX_ACTION : WP_AJAX_ACTION)
            : wpRescueRouteUrl(rescueUrl as string, route),
    }));
  }

  private async viaEndpoints<R extends WpRoute>(
    route: R,
    body: WpRequestBody<R>,
    options: WpCallOptions,
  ): Promise<WpCallResult<WpRouteMap[R]['response']>> {
    const candidates = this.urlsFor(route);
    let firstForeign: WpRemoteError | null = null;
    for (const candidate of candidates) {
      try {
        const result = await this.attempt(candidate.url, route, body, options);
        if (!this.endpoint && candidate.kind !== 'rescue') this.endpoint = candidate.kind;
        return result;
      } catch (error) {
        if (error instanceof WpRemoteError && error.code === 'foreignResponse') {
          firstForeign ??= error;
          continue;
        }
        throw error;
      }
    }
    throw firstForeign as WpRemoteError;
  }

  private async attempt<R extends WpRoute>(
    url: string,
    route: R,
    body: WpRequestBody<R>,
    options: WpCallOptions,
  ): Promise<WpCallResult<WpRouteMap[R]['response']>> {
    if (options.signal?.aborted) throw options.signal.reason;
    const timestamp = this.siteNow();
    const nonce = randomNonce();
    const requestBody =
      typeof body === 'function'
        ? (body as (auth: { timestamp: number; nonce: string }) => unknown)({ timestamp, nonce })
        : body;
    const bundle = gzipBytes(
      encodeWpFrame({ route, body: requestBody, blobs: options.blobs ?? [] }),
    );
    const { connectionId, privateKey } = this.options;
    const signature = privateKey
      ? signEd25519(
          privateKey,
          wpCanonicalRequest({
            route,
            timestamp,
            nonce,
            connectionId,
            bodySha256: sha256Hex(bundle),
            prefix: this.signingPrefix,
          }),
        )
      : null;
    const auth = formatWpAuthField({ connectionId, timestamp, nonce, signature });
    const multipart = encodeWpMultipart(auth, bundle, randomBoundary());
    const headers: Record<string, string> = {
      'Content-Type': multipart.contentType,
      Accept: 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    const basic = this.basicAuthHeader();
    if (basic) headers.Authorization = basic;

    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          new WpRemoteError(
            'timeout',
            `The site took longer than ${Math.round(timeoutMs / 1000)} seconds to answer.`,
          ),
        ),
      timeoutMs,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    const started = this.now();
    try {
      const response = await this.options.transport({
        url,
        method: 'POST',
        headers,
        body: multipart.body,
        signal,
        maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE,
      });
      const read = this.read<WpRouteMap[R]['response']>(route, nonce, response);
      return { ...read, durationMs: this.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  private read<T>(
    route: WpRoute,
    nonce: string,
    response: WpHttpResponse,
  ): { data: T; blobs: Uint8Array[] } {
    const envelope = decodeWpResponse(response.body);
    if (!envelope) {
      const www = response.header('www-authenticate') ?? '';
      if (response.status === 401 && /^\s*basic\b/i.test(www)) {
        throw new WpRemoteError(
          'httpAuthRequired',
          this.options.httpAuth
            ? 'The site did not accept the HTTP user name and password saved for it. Update them in the site settings.'
            : 'The site asks for an HTTP user name and password, as staging sites often do. Add them and try again.',
          {},
          401,
        );
      }
      if (response.status === 413) {
        throw new WpRemoteError(
          'tooLarge',
          'The web server refused a request this large.',
          {},
          413,
        );
      }
      if (response.status === 429) {
        throw new WpRemoteError(
          'rateLimited',
          'The site is limiting calls.',
          { retryAfter: retryAfterSeconds(response, {}) },
          429,
        );
      }
      throw new WpRemoteError('foreignResponse', foreignMessage(response), {}, response.status);
    }

    const { meta, payload } = envelope;
    if (meta.sig === '') {
      // Only the rate limiter answers unsigned, and nothing in such a reply is read.
      if (meta.status === 429) {
        throw new WpRemoteError(
          'rateLimited',
          'The site is limiting calls.',
          { retryAfter: retryAfterSeconds(response, {}) },
          429,
        );
      }
      throw new WpRemoteError(
        'badResponseSignature',
        'The site sent back an unsigned reply, so Runova did not trust it.',
      );
    }
    const bodySha256 = sha256Hex(payload);
    // A reply the site could not tie to a verified request (/hello, an early refusal) is signed
    // the way its address suggests, which may be the other prefix: rescue.php has no namespace.
    const prefixes: WpSigningPrefix[] = [
      this.signingPrefix,
      this.legacy ? WP_PROTOCOL_PREFIX : WP_LEGACY_PROTOCOL_PREFIX,
    ];
    const signedWith = (requestNonce: string, connectionId: string | null) =>
      prefixes.some((prefix) =>
        verifyEd25519(
          this.options.sitePublicKey,
          wpCanonicalResponse({
            route,
            requestNonce,
            connectionId,
            timestamp: meta.ts,
            httpStatus: meta.status,
            bodySha256,
            prefix,
          }),
          meta.sig,
        ),
      );
    if (!signedWith(nonce, this.options.connectionId)) {
      // A body over post_max_size makes PHP drop the whole form before the plugin runs, so its
      // "too large" reply cannot know our nonce or connection and is signed with `-` for both.
      // That one reply is accepted, only as "too large", and nothing in it is read: replaying it
      // can only make the next batch smaller.
      if (meta.status === 413 && signedWith('-', null)) {
        throw new WpRemoteError('tooLarge', 'The site refused a request this large.', {}, 413);
      }
      throw new WpRemoteError(
        'badResponseSignature',
        'A reply claimed to come from the site, but its signature did not match the site key saved at pairing. Something between this computer and the site may be changing replies.',
      );
    }

    const plain = gunzipBytes(payload, this.options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED);
    const frame = plain ? decodeWpFrame(plain) : null;
    const reply = frame?.body as WpResponseBody<T> | undefined;
    if (
      !frame ||
      frame.route !== route ||
      typeof reply !== 'object' ||
      reply === null ||
      typeof reply.ok !== 'boolean'
    ) {
      throw new WpRemoteError(
        'internal',
        'The connector sent back a signed reply Runova could not read.',
        {},
        meta.status,
      );
    }
    if (reply.ok) {
      // Every route answers with an object; anything else is not a reply this client reads.
      const data = (reply as { data?: unknown }).data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new WpRemoteError(
          'internal',
          'The connector sent back a signed reply Runova could not read.',
          {},
          meta.status,
        );
      }
      return { data: data as T, blobs: frame.blobs };
    }

    const error = (reply as { error?: unknown }).error as
      | { code?: unknown; message?: unknown; details?: unknown }
      | undefined;
    const code =
      typeof error?.code === 'string' &&
      PLUGIN_CODES.has(error.code) &&
      isWordPressErrorCode(error.code)
        ? error.code
        : 'internal';
    const details =
      typeof error?.details === 'object' && error.details !== null && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    const message = cleanSiteText(error?.message, 500) || `The site refused the call (${code}).`;
    if (code === 'rateLimited') {
      throw new WpRemoteError(
        code,
        message,
        { ...details, retryAfter: retryAfterSeconds(response, details) },
        meta.status,
      );
    }
    throw new WpRemoteError(code, message, details, meta.status);
  }
}

/** The request size cap for a site: 80% of what PHP takes, between the protocol's bounds. */
export function wpRequestCap(limits: Pick<WpLimits, 'maxRequestBytes'>): number {
  const cap = Math.floor(limits.maxRequestBytes * 0.8);
  return Math.max(WP_BATCH_MIN_BYTES, Math.min(WP_BATCH_MAX_BYTES, cap));
}

/**
 * Sizes upload and read batches: starts at 512 KiB, doubles after a quick success, halves on a
 * 413, and gives up below 64 KiB, which is almost always a web server's own body limit.
 */
export class WpBatchSizer {
  private size: number;

  constructor(
    private readonly cap: number,
    /** A batch that took less than this many milliseconds was quick. */
    private readonly quickMs: number = 2_500,
  ) {
    this.size = Math.min(WP_BATCH_START_BYTES, cap);
  }

  get current(): number {
    return this.size;
  }

  succeeded(durationMs: number): void {
    if (durationMs < this.quickMs) this.size = Math.min(this.size * 2, this.cap);
  }

  /** After a 413: halves, or throws once the batch cannot get smaller. */
  tooLarge(): void {
    if (this.size <= WP_BATCH_MIN_BYTES) {
      throw new WpRemoteError(
        'bodyTooLarge',
        `The web server refuses even ${WP_BATCH_MIN_BYTES / 1024} KB requests. On nginx, raise client_max_body_size (for example to 16m); on Apache, check LimitRequestBody.`,
      );
    }
    this.size = Math.max(WP_BATCH_MIN_BYTES, Math.floor(this.size / 2));
  }
}
