import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import {
  decodeWpFrame,
  encodeWpFrame,
  encodeWpResponse,
  formatWpConnectionKey,
  isValidWpDeviceName,
  isWpHardDenied,
  isWpRoute,
  parseWpAuthField,
  validateWpItemPath,
  WP_AJAX_ACTION,
  WP_CONNECTOR_VERSION,
  WP_PROTOCOL_VERSION,
  WP_ROUTE_PARAM,
  WP_ROUTES,
  WP_TIMESTAMP_WINDOW_SECONDS,
  WP_WRITE_ROUTES,
  type WpAuditEntry,
  type WpConflict,
  type WpConnectorUpdateRequest,
  type WpDeployItem,
  type WpDeployOp,
  type WpDeployRecord,
  type WpDeployState,
  type WpErrorCode,
  type WpHealthCheck,
  type WpItem,
  type WpItemRef,
  type WpLimits,
  type WpRefusal,
  type WpRollbackReason,
  type WpRoute,
  type WpScope,
  type WpSiteInfo,
  type WpSyntaxError,
  wpBase64UrlDecode,
  wpBase64UrlEncode,
  wpCanonicalPair,
  wpCanonicalRequest,
  wpCanonicalResponse,
  wpConnectorReleaseUrl,
  wpItemKey,
} from '@agentmat/core';
import { compareConnectorVersions } from '../connectorBundle';
import { gzipBytes, privateKeyFromSeed, signEd25519, verifyEd25519 } from '../crypto';
import { seedBytes, WP_VECTORS } from './vectors';

/**
 * An AgentMate Connector in memory, behind a real HTTP server, for the desktop's tests (E19). It
 * speaks protocol v1 the way the plugin does: multipart in, signed envelopes out, the REST,
 * admin-ajax and rescue.php URLs, pairing with a one-time key, signature, timestamp and nonce
 * checks, read-only scope, and the deploy state machine (open, applying, applied, done, rolled
 * back, aborted). The site key is the shared vectors' site seed.
 *
 * `switches` makes it misbehave the ways real sites do: a CDN challenge, a redirect, HTTP Basic,
 * an nginx 413, rate limiting, a bad signature, a skewed clock, a failing health check.
 */

export const FAKE_SITE_NAME = 'Fake Shop';

export interface FakeConnectorSwitches {
  /** Every call gets this HTML page, like a firewall or a CDN challenge. */
  foreign: { status: number; cloudflare?: boolean } | null;
  /** REST URLs answer with a 404 page, so the client has to use admin-ajax. */
  restBlocked: boolean;
  /** admin-ajax answers with WordPress's own "0". */
  ajaxBlocked: boolean;
  /** Regular URLs fail with a 500 page (a fatal error), so only rescue.php works. */
  siteFatal: boolean;
  /** Every call gets a 302 to this URL. */
  redirectTo: string | null;
  /** The site wants this HTTP Basic sign-in before anything else. */
  basicAuth: { username: string; password: string } | null;
  /** Request bodies larger than this get nginx's 413 page. */
  maxBodyBytes: number | null;
  /** The next N calls get the rate limiter's unsigned 429. */
  rateLimitNext: number;
  retryAfter: number | null;
  /** Replies are signed with a key other than the site's. */
  badSignature: boolean;
  /** Replies are signed over another request's nonce, as a replayed reply would be. */
  replayReply: boolean;
  /** `/hello` names this key instead of the site's own. */
  helloKey: string | null;
  /** Seconds the site's clock runs ahead of this computer's. */
  clockSkew: number;
  /** The protocol `/hello` and `/site/info` report. */
  protocol: number;
  /** Health checks after an apply fail, so the deploy rolls itself back. */
  healthFails: boolean;
  /** How many commit calls answer `applying` before the apply finishes. */
  commitSteps: number;
  /** Milliseconds to wait before answering. */
  delayMs: number;
  /** The status the home page answers with (the desktop's own health check). */
  homeStatus: number;
  /**
   * The connector has `/connector/update`. Off, it behaves like one that predates the route: the
   * route answers 404 and `/site/info` has no `selfUpdate`.
   */
  selfUpdate: boolean;
  /** With the route: PHP cannot swap the connector's folder here, so `/site/info` says `selfUpdate: false`. */
  notReplaceable: boolean;
  /** The site fails its health check after a connector update, so the update is undone. */
  updateHealthFails: boolean;
  /**
   * With the route: the connector can download an update from the GitHub release itself, and
   * `/site/info` says `updateDownload: true`. Off, it is a connector that only takes blobs.
   */
  updateDownload: boolean;
  /** An update the site downloads is refused with `downloadFailed` and this message. */
  downloadFails: string | null;
  /** A connector update is refused with this error (the site's own reasons: syntax, size, ...). */
  refuseUpdate: { code: WpErrorCode; message: string; details?: Record<string, unknown> } | null;
}

interface Pairing {
  secret: Uint8Array;
  scope: WpScope;
  label: string;
  expiresAt: number;
  attempts: number;
  used: boolean;
}

export interface FakeConnection {
  id: string;
  publicKey: string;
  scope: WpScope;
  label: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
}

interface FakeItem {
  item: WpItem;
  files: Map<string, Buffer>;
}

interface FakeDeploy {
  id: string;
  state: WpDeployState;
  reason?: WpRollbackReason;
  label: string;
  connectionLabel: string;
  items: WpDeployItem[];
  ops: WpDeployOp[];
  uploads: Map<number, Buffer[]>;
  /** What each touched file held before the apply (null: it did not exist). */
  snapshot: Map<string, Buffer | null> | null;
  /** What each touched file held right after the apply, to tell later edits apart. */
  applied: Map<string, string | null> | null;
  createdItems: string[];
  commitCalls: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface FakeRequestLog {
  route: string;
  endpoint: 'rest' | 'ajax' | 'rescue';
  connectionId: string | null;
  bytes: number;
}

class FakeError extends Error {
  constructor(
    readonly code: WpErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const STATUS: Record<WpErrorCode, number> = {
  badRequest: 400,
  unauthorized: 401,
  badSignature: 401,
  staleTimestamp: 401,
  replayed: 401,
  unknownConnection: 401,
  revoked: 401,
  readOnly: 403,
  fileModsDisabled: 403,
  notDirect: 403,
  disabled: 503,
  pathRejected: 422,
  itemUnknown: 404,
  itemProtected: 403,
  deployUnknown: 404,
  conflict: 409,
  syntaxError: 422,
  busy: 409,
  invalidState: 409,
  tooLarge: 413,
  rateLimited: 429,
  pairingInvalid: 401,
  pairingExpired: 410,
  protocolMismatch: 400,
  updateRefused: 422,
  internal: 500,
};

const ACTIVE: ReadonlySet<WpDeployState> = new Set(['open', 'applying', 'applied']);
const REST_PREFIX = '/wp-json/agentmate/v1';
const AJAX_PATH = '/wp-admin/admin-ajax.php';
const RESCUE_PATH = '/wp-content/plugins/agentmate-connector/rescue.php';
const OTHER_KEY = privateKeyFromSeed(new Uint8Array(32).fill(7));

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseMultipart(body: Buffer, contentType: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const boundary = /boundary=([A-Za-z0-9_-]+)/.exec(contentType)?.[1];
  if (!boundary) return out;
  const delimiter = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    at += delimiter.length;
    if (body.subarray(at, at + 2).toString() === '--') break;
    at += 2;
    const headerEnd = body.indexOf('\r\n\r\n', at);
    if (headerEnd === -1) break;
    const headers = body.subarray(at, headerEnd).toString('utf-8');
    const end = body.indexOf(next, headerEnd + 4);
    if (end === -1) break;
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (name) out.set(name, body.subarray(headerEnd + 4, end));
    at = end + 2;
  }
  return out;
}

function defaultLimits(): WpLimits {
  return {
    maxRequestBytes: 8 * 1024 * 1024,
    maxResponseBytes: 8 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    timeBudgetSeconds: 10,
    maxPathsPerRead: 200,
    manifestPageSize: 500,
    maxFilesPerItem: 20_000,
  };
}

export class FakeConnector {
  readonly switches: FakeConnectorSwitches = {
    foreign: null,
    restBlocked: false,
    ajaxBlocked: false,
    siteFatal: false,
    redirectTo: null,
    basicAuth: null,
    maxBodyBytes: null,
    rateLimitNext: 0,
    retryAfter: null,
    badSignature: false,
    replayReply: false,
    helloKey: null,
    clockSkew: 0,
    protocol: WP_PROTOCOL_VERSION,
    healthFails: false,
    commitSteps: 0,
    delayMs: 0,
    homeStatus: 200,
    selfUpdate: true,
    notReplaceable: false,
    updateHealthFails: false,
    updateDownload: true,
    downloadFails: null,
    refuseUpdate: null,
  };
  readonly limits: WpLimits = defaultLimits();
  readonly sitePublicKey = WP_VECTORS.keys.site.publicKey;
  readonly pairings = new Map<string, Pairing>();
  readonly connections = new Map<string, FakeConnection>();
  readonly items = new Map<string, FakeItem>();
  readonly deploys: FakeDeploy[] = [];
  readonly audit: WpAuditEntry[] = [];
  readonly requests: FakeRequestLog[] = [];
  /** Every upload chunk's size, in order. */
  readonly uploadSizes: number[] = [];
  /** The version the plugin reports; a connector update changes it. */
  pluginVersion: string = WP_CONNECTOR_VERSION;
  /** Every connector update that arrived and was not refused, with its outcome. */
  readonly updates: {
    version: string;
    files: string[];
    state: 'updated' | 'rolledBack';
    /** `download`: the site fetched this address itself; `upload`: the files came as blobs. */
    source: 'download' | 'upload';
    url?: string;
  }[] = [];
  /** Every release address the site was asked to download, including refused ones. */
  readonly downloads: string[] = [];
  activeTheme = { stylesheet: 'shop', template: 'shop' };
  private readonly siteKey = privateKeyFromSeed(seedBytes(WP_VECTORS.keys.site.seedHex));
  private readonly nonces = new Set<string>();
  private server: Server | null = null;
  private port = 0;

  /** Starts listening on a free loopback port. */
  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  get siteUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get restUrl(): string {
    return `${this.siteUrl}${REST_PREFIX}`;
  }

  get ajaxUrl(): string {
    return `${this.siteUrl}${AJAX_PATH}`;
  }

  get rescueUrl(): string {
    return `${this.siteUrl}${RESCUE_PATH}`;
  }

  /** The site's clock, Unix seconds. */
  now(): number {
    return Math.floor(Date.now() / 1000) + this.switches.clockSkew;
  }

  /** A one-time connection key, as wp-admin would show it. */
  createKey(
    options: {
      scope?: WpScope;
      label?: string;
      ttlSeconds?: number;
      urls?: { siteUrl: string; restUrl: string; ajaxUrl: string };
      sitePublicKey?: string;
    } = {},
  ): string {
    const pairingId = `pair-${randomUUID()}`;
    const secret = randomBytes(32);
    const scope = options.scope ?? 'write';
    const expiresAt = this.now() + (options.ttlSeconds ?? 900);
    this.pairings.set(pairingId, {
      secret,
      scope,
      label: options.label ?? '',
      expiresAt,
      attempts: 0,
      used: false,
    });
    return formatWpConnectionKey({
      siteUrl: options.urls?.siteUrl ?? this.siteUrl,
      restUrl: options.urls?.restUrl ?? this.restUrl,
      ajaxUrl: options.urls?.ajaxUrl ?? this.ajaxUrl,
      pairingId,
      pairingSecret: wpBase64UrlEncode(secret),
      sitePublicKey: options.sitePublicKey ?? this.sitePublicKey,
      scope,
      expiresAt: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 900),
      ...(options.label ? { label: options.label } : {}),
    });
  }

  /** Adds a theme, plugin or mu-plugin with its files. */
  addItem(item: WpItemRef, files: Record<string, string | Buffer>, extra: Partial<WpItem> = {}) {
    const isFile = extra.isFile ?? false;
    this.items.set(wpItemKey(item), {
      item: {
        ...item,
        name: extra.name ?? item.slug,
        version: extra.version ?? '1.0.0',
        isFile,
        active: extra.active ?? false,
        networkActive: extra.networkActive ?? false,
        writable: extra.writable ?? true,
        protected: extra.protected ?? false,
        ...(extra.parentTheme ? { parentTheme: extra.parentTheme } : {}),
        ...(extra.mainFile ? { mainFile: extra.mainFile } : {}),
      },
      files: new Map(
        Object.entries(files).map(([path, content]) => [
          path,
          Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
        ]),
      ),
    });
  }

  file(item: WpItemRef, path: string): string | null {
    return this.items.get(wpItemKey(item))?.files.get(path)?.toString('utf-8') ?? null;
  }

  setFile(item: WpItemRef, path: string, content: string | null): void {
    const found = this.items.get(wpItemKey(item));
    if (!found) throw new Error('No such item.');
    if (content === null) found.files.delete(path);
    else found.files.set(path, Buffer.from(content, 'utf-8'));
  }

  private record(event: WpAuditEntry['event'], connectionLabel: string | null, detail = '') {
    this.audit.unshift({
      id: this.audit.length + 1,
      at: this.now(),
      event,
      connectionLabel,
      ip: '127.0.0.1',
      detail,
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    if (this.switches.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.switches.delayMs));
    }
    const html = (status: number, text: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/html', ...headers });
      response.end(`<!doctype html><html><body>${text}</body></html>`);
    };
    const url = new URL(request.url ?? '/', this.siteUrl);

    if (this.switches.basicAuth) {
      const { username, password } = this.switches.basicAuth;
      const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      if (request.headers.authorization !== expected) {
        html(401, 'Authorization required', { 'WWW-Authenticate': 'Basic realm="staging"' });
        return;
      }
    }
    if (request.method === 'GET' && url.pathname === '/') {
      html(this.switches.homeStatus, FAKE_SITE_NAME);
      return;
    }
    if (this.switches.maxBodyBytes !== null && body.length > this.switches.maxBodyBytes) {
      html(413, '413 Request Entity Too Large', { Server: 'nginx' });
      return;
    }
    if (this.switches.redirectTo) {
      response.writeHead(302, { Location: this.switches.redirectTo });
      response.end();
      return;
    }
    if (this.switches.foreign) {
      const { status, cloudflare } = this.switches.foreign;
      html(
        status,
        'Just a moment...',
        cloudflare ? { Server: 'cloudflare', 'cf-mitigated': 'challenge' } : {},
      );
      return;
    }

    let endpoint: FakeRequestLog['endpoint'];
    let route: string | null;
    if (url.pathname.startsWith(REST_PREFIX)) {
      endpoint = 'rest';
      route = url.pathname.slice(REST_PREFIX.length);
      if (this.switches.restBlocked) {
        html(404, 'Not Found');
        return;
      }
    } else if (url.pathname === AJAX_PATH && url.searchParams.get('action') === WP_AJAX_ACTION) {
      endpoint = 'ajax';
      route = url.searchParams.get(WP_ROUTE_PARAM);
      if (this.switches.ajaxBlocked) {
        response.writeHead(400, { 'Content-Type': 'text/html' });
        response.end('0');
        return;
      }
    } else if (url.pathname === RESCUE_PATH) {
      endpoint = 'rescue';
      route = url.searchParams.get(WP_ROUTE_PARAM);
      if (!route?.startsWith('/rescue/')) {
        html(403, 'Forbidden');
        return;
      }
    } else {
      html(404, 'Not Found');
      return;
    }
    if (this.switches.siteFatal && endpoint !== 'rescue') {
      html(500, 'There has been a critical error on this website.');
      return;
    }
    if (!isWpRoute(route) || request.method !== 'POST') {
      html(404, 'No route');
      return;
    }
    if (route === WP_ROUTES.connectorUpdate && !this.switches.selfUpdate) {
      html(404, 'No route');
      return;
    }
    if (this.switches.rateLimitNext > 0) {
      this.switches.rateLimitNext -= 1;
      const envelope = encodeWpResponse(
        { ts: this.now(), status: 429, sig: '' },
        gzipBytes(encodeWpFrame({ route, body: {}, blobs: [] })),
      );
      response.writeHead(429, {
        'Content-Type': 'application/octet-stream',
        ...(this.switches.retryAfter === null
          ? {}
          : { 'Retry-After': String(this.switches.retryAfter) }),
      });
      response.end(Buffer.from(envelope));
      return;
    }

    const parts = parseMultipart(body, request.headers['content-type'] ?? '');
    const authText = parts.get('am_auth')?.toString('utf-8') ?? '';
    const bundle = parts.get('bundle') ?? Buffer.alloc(0);
    const auth = parseWpAuthField(authText);
    const nonce = auth?.nonce ?? '-';
    const connectionId = auth?.connectionId ?? null;
    this.requests.push({ route, endpoint, connectionId, bytes: body.length });

    let status = 200;
    let reply: { ok: true; data: unknown } | { ok: false; error: unknown };
    let blobs: Uint8Array[] = [];
    try {
      if (!auth) throw new FakeError('badRequest', 'The am_auth field is missing or malformed.');
      let plain: Buffer;
      try {
        plain = gunzipSync(bundle, { maxOutputLength: 80 * 1024 * 1024 });
      } catch {
        throw new FakeError('badRequest', 'The bundle is not gzip.');
      }
      const frame = decodeWpFrame(new Uint8Array(plain));
      if (!frame || frame.route !== route) throw new FakeError('badRequest', 'Bad frame.');
      const connection = this.authenticate(route, auth, sha(bundle), frame.body);
      const result = this.dispatch(route, frame.body, frame.blobs, connection, auth);
      reply = { ok: true, data: result.data };
      blobs = result.blobs ?? [];
    } catch (error) {
      if (!(error instanceof FakeError)) throw error;
      status = STATUS[error.code];
      reply = {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      };
    }
    const payload = gzipBytes(encodeWpFrame({ route, body: reply, blobs }));
    const ts = this.now();
    const signed = wpCanonicalResponse({
      route,
      requestNonce: this.switches.replayReply ? 'AAAAAAAAAAAAAAAAAAAAAA' : nonce,
      connectionId,
      timestamp: ts,
      httpStatus: status,
      bodySha256: sha(payload),
    });
    const sig = signEd25519(this.switches.badSignature ? OTHER_KEY : this.siteKey, signed);
    response.writeHead(status, { 'Content-Type': 'application/octet-stream' });
    response.end(Buffer.from(encodeWpResponse({ ts, status, sig }, payload)));
  }

  /** The plugin's checks, in its order: connection, signature, clock, nonce, scope. */
  private authenticate(
    route: WpRoute,
    auth: NonNullable<ReturnType<typeof parseWpAuthField>>,
    bundleSha: string,
    body: unknown,
  ): FakeConnection | null {
    if (route === WP_ROUTES.hello) return null;
    const canonical = wpCanonicalRequest({
      route,
      timestamp: auth.timestamp,
      nonce: auth.nonce,
      connectionId: auth.connectionId,
      bodySha256: bundleSha,
    });
    let connection: FakeConnection | null = null;
    let publicKey: string;
    if (route === WP_ROUTES.pair) {
      const request = body as { desktopPublicKey?: unknown };
      if (typeof request.desktopPublicKey !== 'string') {
        throw new FakeError('badRequest', 'No public key.');
      }
      publicKey = request.desktopPublicKey;
    } else {
      connection = auth.connectionId ? (this.connections.get(auth.connectionId) ?? null) : null;
      if (!connection) throw new FakeError('unknownConnection', 'This connection is unknown.');
      if (connection.revoked) throw new FakeError('revoked', 'This connection was revoked.');
      publicKey = connection.publicKey;
    }
    if (!auth.signature || !verifyEd25519(publicKey, canonical, auth.signature)) {
      this.record('authFailed', connection?.label ?? null);
      throw new FakeError('badSignature', 'The request signature is not valid.');
    }
    if (Math.abs(auth.timestamp - this.now()) > WP_TIMESTAMP_WINDOW_SECONDS) {
      throw new FakeError('staleTimestamp', 'The request time is too far from the site clock.', {
        serverTime: this.now(),
      });
    }
    if (this.nonces.has(auth.nonce)) throw new FakeError('replayed', 'That request was replayed.');
    this.nonces.add(auth.nonce);
    if (connection && connection.scope === 'read' && WP_WRITE_ROUTES.includes(route)) {
      throw new FakeError('readOnly', 'This connection can only read.');
    }
    return connection;
  }

  private dispatch(
    route: WpRoute,
    body: unknown,
    blobs: Uint8Array[],
    connection: FakeConnection | null,
    auth: NonNullable<ReturnType<typeof parseWpAuthField>>,
  ): { data: unknown; blobs?: Uint8Array[] } {
    const input = (body ?? {}) as Record<string, unknown>;
    switch (route) {
      case WP_ROUTES.hello:
        return {
          data: {
            protocol: this.switches.protocol,
            pluginVersion: this.pluginVersion,
            sitePublicKey: this.switches.helloKey ?? this.sitePublicKey,
            serverTime: this.now(),
            capabilities: ['deploy', 'rescue'],
            rescueUrl: this.rescueUrl,
            multisite: false,
            siteName: FAKE_SITE_NAME,
          },
        };
      case WP_ROUTES.pair:
        return { data: this.pair(input, auth) };
      case WP_ROUTES.siteInfo:
        return { data: this.siteInfo(connection as FakeConnection) };
      case WP_ROUTES.itemsList:
        return { data: { items: [...this.items.values()].map((entry) => entry.item) } };
      case WP_ROUTES.itemsManifest:
        return { data: this.manifest(input) };
      case WP_ROUTES.filesRead:
        return this.read(input);
      case WP_ROUTES.deployBegin:
        return { data: this.begin(input, connection as FakeConnection) };
      case WP_ROUTES.deployUpload:
        return { data: this.upload(input, blobs) };
      case WP_ROUTES.deployCommit:
        return { data: this.commit(input) };
      case WP_ROUTES.deployVerify:
        return { data: this.verify(input) };
      case WP_ROUTES.deployFinalize:
        return { data: this.finalize(input) };
      case WP_ROUTES.deployRollback:
      case WP_ROUTES.rescueRollback:
        return { data: this.rollback(input) };
      case WP_ROUTES.deployAbort:
        return { data: this.abort(input) };
      case WP_ROUTES.deployHistory:
        return {
          data: {
            deploys: this.deploys
              .slice()
              .reverse()
              .slice(0, Number(input.limit) || 20)
              .map((deploy) => this.recordOf(deploy)),
          },
        };
      case WP_ROUTES.auditList: {
        const before = typeof input.before === 'number' ? input.before : Number.POSITIVE_INFINITY;
        return {
          data: {
            entries: this.audit
              .filter((entry) => entry.id < before)
              .slice(0, Number(input.limit) || 50),
          },
        };
      }
      case WP_ROUTES.connectorUpdate:
        return { data: this.connectorUpdate(input, blobs, connection as FakeConnection) };
      case WP_ROUTES.connectionRevoke:
        (connection as FakeConnection).revoked = true;
        this.record('revoked', (connection as FakeConnection).label);
        return { data: { revoked: true } };
      case WP_ROUTES.rescueStatus: {
        const active = this.activeDeploy();
        const last = this.deploys.at(-1);
        return {
          data: {
            pending: active
              ? { deployId: active.id, state: active.state, deadline: this.now() + 180 }
              : null,
            last: last ? this.recordOf(last) : null,
          },
        };
      }
    }
    throw new FakeError('badRequest', 'Unknown route.');
  }

  private pair(
    input: Record<string, unknown>,
    auth: NonNullable<ReturnType<typeof parseWpAuthField>>,
  ) {
    const { pairingId, desktopPublicKey, deviceName, proof } = input;
    const pairing = typeof pairingId === 'string' ? this.pairings.get(pairingId) : undefined;
    if (!pairing || pairing.used || pairing.attempts >= 5) {
      throw new FakeError('pairingInvalid', 'This connection key is not valid.');
    }
    if (pairing.expiresAt < this.now()) {
      throw new FakeError('pairingExpired', 'This connection key has expired.');
    }
    if (typeof deviceName !== 'string' || !isValidWpDeviceName(deviceName)) {
      throw new FakeError('badRequest', 'The device name is not valid.');
    }
    const expected = wpBase64UrlEncode(
      createHmac('sha256', pairing.secret)
        .update(
          wpCanonicalPair({
            pairingId: pairingId as string,
            desktopPublicKey: desktopPublicKey as string,
            deviceName,
            timestamp: auth.timestamp,
            nonce: auth.nonce,
          }),
        )
        .digest(),
    );
    if (proof !== expected) {
      pairing.attempts += 1;
      this.record('pairFailed', null);
      throw new FakeError('pairingInvalid', 'The pairing proof is wrong.');
    }
    pairing.used = true;
    const connection: FakeConnection = {
      id: randomUUID(),
      publicKey: desktopPublicKey as string,
      scope: pairing.scope,
      label: pairing.label || deviceName,
      deviceName,
      createdAt: this.now(),
      expiresAt: null,
      revoked: false,
    };
    this.connections.set(connection.id, connection);
    this.record('paired', connection.label);
    return {
      connectionId: connection.id,
      scope: connection.scope,
      label: connection.label,
      expiresAt: null,
      siteName: FAKE_SITE_NAME,
      serverTime: this.now(),
    };
  }

  private activeDeploy(): FakeDeploy | null {
    return this.deploys.find((deploy) => ACTIVE.has(deploy.state)) ?? null;
  }

  private siteInfo(connection: FakeConnection): WpSiteInfo {
    const active = this.activeDeploy();
    return {
      siteName: FAKE_SITE_NAME,
      homeUrl: this.siteUrl,
      siteUrl: this.siteUrl,
      wpVersion: '6.8.2',
      phpVersion: '8.3.12',
      pluginVersion: this.pluginVersion,
      protocol: this.switches.protocol,
      multisite: false,
      activeTheme: this.activeTheme,
      https: false,
      serverTime: this.now(),
      fileModsDisabled: false,
      fileEditDisabled: false,
      filesystemMethod: 'direct',
      readOnlyByConstant: false,
      ...(this.switches.selfUpdate ? { selfUpdate: !this.switches.notReplaceable } : {}),
      ...(this.switches.selfUpdate && this.switches.updateDownload ? { updateDownload: true } : {}),
      sodium: 'native',
      limits: this.limits,
      guard: { installed: true, rescueUrl: this.rescueUrl },
      loopback: 'ok',
      connection: {
        id: connection.id,
        label: connection.label,
        scope: connection.scope,
        createdAt: connection.createdAt,
        expiresAt: connection.expiresAt,
      },
      pendingDeploy: active
        ? { deployId: active.id, state: active.state, deadline: this.now() + 180 }
        : null,
    };
  }

  /** `/connector/update`: checks the files the way the plugin does, then swaps the version. */
  private connectorUpdate(
    input: Record<string, unknown>,
    blobs: Uint8Array[],
    connection: FakeConnection,
  ) {
    const request = input as Partial<WpConnectorUpdateRequest>;
    const files = Array.isArray(request.files) ? request.files : null;
    // A connector without the download takes only blobs, so a download request has too few.
    const url =
      this.switches.updateDownload && request.download !== undefined
        ? request.download?.url
        : undefined;
    if (
      typeof request.version !== 'string' ||
      !files ||
      files.length !== (url === undefined ? blobs.length : files.length)
    ) {
      throw new FakeError('badRequest', 'Send a version and one blob per file.');
    }
    if (url !== undefined && (url !== wpConnectorReleaseUrl(request.version) || blobs.length > 0)) {
      throw new FakeError(
        'badRequest',
        'An update the site downloads names the release, no blobs.',
      );
    }
    if (this.activeDeploy()) {
      throw new FakeError('busy', 'Another deploy is still open on this site.', {
        deployId: this.activeDeploy()?.id,
      });
    }
    const refusal = this.switches.refuseUpdate;
    if (refusal) throw new FakeError(refusal.code, refusal.message, refusal.details);
    if (url !== undefined) {
      this.downloads.push(url);
      if (this.switches.downloadFails !== null) {
        throw new FakeError('updateRefused', this.switches.downloadFails, {
          reason: 'downloadFailed',
        });
      }
    }
    files.forEach((file, index) => {
      // A downloaded release is taken to match the list; the plugin's own tests check that.
      if (url !== undefined) return;
      if (sha(blobs[index]) !== file.sha256 || blobs[index].length !== file.size) {
        throw new FakeError('updateRefused', 'A file does not match its hash.', {
          reason: 'badPackage',
        });
      }
    });
    if (!files.some((file) => file.path === 'agentmate-connector.php')) {
      throw new FakeError('updateRefused', 'The main plugin file is missing.', {
        reason: 'badPackage',
      });
    }
    const fromVersion = this.pluginVersion;
    if (compareConnectorVersions(request.version, fromVersion) < 0) {
      throw new FakeError('updateRefused', 'That is older than the connector on this site.', {
        reason: 'downgrade',
      });
    }
    const paths = files.map((file) => file.path);
    const failed = this.switches.updateHealthFails;
    const checks: WpHealthCheck[] = [
      failed
        ? { name: 'home', status: 500, ok: false, detail: 'HTTP 500' }
        : { name: 'home', status: 200, ok: true, detail: 'HTTP 200' },
      { name: 'ajaxPing', status: 200, ok: true, detail: 'HTTP 200' },
    ];
    this.updates.push({
      version: request.version,
      files: paths,
      state: failed ? 'rolledBack' : 'updated',
      source: url === undefined ? 'upload' : 'download',
      ...(url === undefined ? {} : { url }),
    });
    if (failed) {
      this.record('connectorRolledBack', connection.label, `Tried ${request.version}.`);
    } else {
      this.pluginVersion = request.version;
      this.record('connectorUpdated', connection.label, `${fromVersion} to ${request.version}.`);
    }
    return {
      state: failed ? 'rolledBack' : 'updated',
      fromVersion,
      version: request.version,
      files: files.length,
      checks,
    };
  }

  private itemOf(value: unknown): FakeItem {
    const ref = value as WpItemRef | undefined;
    const found = ref ? this.items.get(wpItemKey(ref)) : undefined;
    if (!found) throw new FakeError('itemUnknown', 'That item is not on the site.');
    if (found.item.protected) throw new FakeError('itemProtected', 'That item is protected.');
    return found;
  }

  private manifest(input: Record<string, unknown>) {
    const found = this.itemOf(input.item);
    const paths = [...found.files.keys()].sort();
    const start = typeof input.cursor === 'string' ? Number(input.cursor) : 0;
    const page = paths.slice(start, start + this.limits.manifestPageSize);
    const entries = [];
    const skipped = [];
    for (const path of page) {
      const check = validateWpItemPath(path);
      if (!check.ok) {
        skipped.push({ path, reason: check.reason });
        continue;
      }
      const content = found.files.get(path) as Buffer;
      entries.push({ path, size: content.length, sha256: sha(content) });
    }
    const end = start + page.length;
    return {
      isFile: found.item.isFile,
      entries,
      skipped,
      cursor: end < paths.length ? String(end) : null,
    };
  }

  private read(input: Record<string, unknown>): { data: unknown; blobs: Uint8Array[] } {
    const found = this.itemOf(input.item);
    const requested = Array.isArray(input.files) ? input.files : [];
    if (requested.length > this.limits.maxPathsPerRead) {
      throw new FakeError('tooLarge', 'Too many files in one read.');
    }
    const files = [];
    const blobs: Uint8Array[] = [];
    for (const entry of requested as { path: string; offset?: number; length?: number }[]) {
      if (!validateWpItemPath(entry.path).ok || isWpHardDenied(entry.path)) {
        throw new FakeError('pathRejected', 'That path is refused.');
      }
      const content = found.files.get(entry.path);
      if (!content) {
        files.push({ path: entry.path, offset: 0, length: 0, size: 0, sha256: '', missing: true });
        blobs.push(new Uint8Array(0));
        continue;
      }
      const offset = entry.offset ?? 0;
      const length = Math.min(entry.length ?? content.length - offset, content.length - offset);
      const slice = content.subarray(offset, offset + length);
      files.push({
        path: entry.path,
        offset,
        length: slice.length,
        size: content.length,
        sha256: sha(content),
      });
      blobs.push(new Uint8Array(slice));
    }
    return { data: { files }, blobs };
  }

  private deployOf(input: Record<string, unknown>): FakeDeploy {
    const deploy = this.deploys.find((entry) => entry.id === input.deployId);
    if (!deploy) throw new FakeError('deployUnknown', 'No such deploy.');
    return deploy;
  }

  private currentSha(item: WpItemRef, path: string): string | null {
    const content = this.items.get(wpItemKey(item))?.files.get(path);
    return content ? sha(content) : null;
  }

  private begin(input: Record<string, unknown>, connection: FakeConnection) {
    const active = this.activeDeploy();
    if (active) {
      throw new FakeError('busy', 'Another deploy is running.', { deployId: active.id });
    }
    const items = (Array.isArray(input.items) ? input.items : []) as WpDeployItem[];
    const ops = (Array.isArray(input.ops) ? input.ops : []) as WpDeployOp[];
    const force = input.force === true;
    const conflicts: WpConflict[] = [];
    const refusals: WpRefusal[] = [];
    for (const item of items) {
      const found = this.items.get(wpItemKey(item));
      if (!found && !item.create) {
        refusals.push({ item, path: '', reason: 'itemUnknown', forceable: false });
      } else if (found?.item.protected) {
        refusals.push({ item, path: '', reason: 'itemProtected', forceable: false });
      }
    }
    for (const op of ops) {
      const check = validateWpItemPath(op.path);
      if (!check.ok) {
        refusals.push({ item: op.item, path: op.path, reason: check.reason, forceable: false });
        continue;
      }
      const found = this.items.get(wpItemKey(op.item));
      if (
        op.op === 'delete' &&
        found?.item.active &&
        found.item.mainFile === `${op.item.slug}/${op.path}`
      ) {
        refusals.push({
          item: op.item,
          path: op.path,
          reason: 'deletesActivePluginMainFile',
          forceable: true,
        });
      }
      if (op.expected === 'any' || force) continue;
      const actual = this.currentSha(op.item, op.path);
      if (actual !== op.expected) {
        conflicts.push({ item: op.item, path: op.path, expected: op.expected, actual });
      }
    }
    const blocking = refusals.some((refusal) => !refusal.forceable || !force);
    if (conflicts.length > 0 || blocking) {
      return { deployId: null, limits: this.limits, baseline: [], conflicts, refusals };
    }
    const deploy: FakeDeploy = {
      id: `dep-${randomUUID()}`,
      state: 'open',
      label: typeof input.label === 'string' ? input.label : '',
      connectionLabel: connection.label,
      items,
      ops,
      uploads: new Map(),
      snapshot: null,
      applied: null,
      createdItems: [],
      commitCalls: 0,
      startedAt: this.now(),
      finishedAt: null,
    };
    this.deploys.push(deploy);
    this.record('deployStarted', connection.label);
    const baseline: WpHealthCheck[] = [{ name: 'home', status: 200, ok: true, detail: '' }];
    return { deployId: deploy.id, limits: this.limits, baseline, conflicts, refusals };
  }

  private upload(input: Record<string, unknown>, blobs: Uint8Array[]) {
    const deploy = this.deployOf(input);
    if (deploy.state !== 'open') throw new FakeError('invalidState', 'The deploy is not open.');
    const chunks = (Array.isArray(input.chunks) ? input.chunks : []) as {
      op: number;
      offset: number;
      final: boolean;
    }[];
    if (chunks.length !== blobs.length)
      throw new FakeError('badRequest', 'Chunks and blobs differ.');
    chunks.forEach((chunk, index) => {
      const op = deploy.ops[chunk.op];
      if (!op || op.op !== 'put') throw new FakeError('badRequest', 'That op is not a put.');
      const parts = deploy.uploads.get(chunk.op) ?? [];
      const have = parts.reduce((sum, part) => sum + part.length, 0);
      if (chunk.offset !== have) throw new FakeError('badRequest', 'Chunk offset is wrong.');
      parts.push(Buffer.from(blobs[index]));
      this.uploadSizes.push(blobs[index].length);
      deploy.uploads.set(chunk.op, parts);
    });
    return {
      received: [...new Set(chunks.map((chunk) => chunk.op))].map((op) => ({
        op,
        nextOffset: (deploy.uploads.get(op) ?? []).reduce((sum, part) => sum + part.length, 0),
      })),
    };
  }

  private commit(input: Record<string, unknown>) {
    const deploy = this.deployOf(input);
    const total = deploy.ops.length;
    if (!ACTIVE.has(deploy.state)) {
      return { state: deploy.state, progress: { done: total, total } };
    }
    if (deploy.state === 'applied') return { state: 'applied', progress: { done: total, total } };
    const contents = new Map<number, Buffer>();
    const syntaxErrors: WpSyntaxError[] = [];
    deploy.ops.forEach((op, index) => {
      if (op.op !== 'put') return;
      const content = Buffer.concat(deploy.uploads.get(index) ?? []);
      if (content.length !== op.size || sha(content) !== op.sha256) {
        throw new FakeError('badRequest', `The upload of ${op.path} is incomplete.`);
      }
      if (op.path.endsWith('.php') && content.toString('utf-8').includes('SYNTAX_ERROR')) {
        syntaxErrors.push({ item: op.item, path: op.path, line: 1, message: 'syntax error' });
      }
      contents.set(index, content);
    });
    if (syntaxErrors.length > 0) {
      return { state: 'open', progress: { done: 0, total }, syntaxErrors };
    }
    deploy.commitCalls += 1;
    if (deploy.commitCalls <= this.switches.commitSteps) {
      deploy.state = 'applying';
      return {
        state: 'applying',
        progress: { done: Math.min(total, deploy.commitCalls), total },
      };
    }
    const snapshot = new Map<string, Buffer | null>();
    const applied = new Map<string, string | null>();
    for (const item of deploy.items) {
      if (!this.items.has(wpItemKey(item)) && item.create) {
        this.addItem(item, {});
        deploy.createdItems.push(wpItemKey(item));
      }
    }
    deploy.ops.forEach((op, index) => {
      const found = this.items.get(wpItemKey(op.item)) as FakeItem;
      const key = `${wpItemKey(op.item)}/${op.path}`;
      snapshot.set(key, found.files.get(op.path) ?? null);
      if (op.op === 'put') found.files.set(op.path, contents.get(index) as Buffer);
      else found.files.delete(op.path);
      applied.set(key, op.op === 'put' ? (op.sha256 as string) : null);
    });
    deploy.snapshot = snapshot;
    deploy.applied = applied;
    deploy.state = 'applied';
    return { state: 'applied', progress: { done: total, total } };
  }

  private restore(deploy: FakeDeploy): { restored: number; removed: number } {
    let restored = 0;
    let removed = 0;
    for (const [key, content] of deploy.snapshot ?? []) {
      const slash = key.indexOf('/');
      const [kind, slug] = key.slice(0, slash).split(':');
      const found = this.items.get(`${kind}:${slug}`);
      if (!found) continue;
      const path = key.slice(slash + 1);
      if (content === null) {
        found.files.delete(path);
        removed += 1;
      } else {
        found.files.set(path, content);
        restored += 1;
      }
    }
    for (const key of deploy.createdItems) this.items.delete(key);
    return { restored, removed };
  }

  private verify(input: Record<string, unknown>) {
    const deploy = this.deployOf(input);
    if (deploy.state !== 'applied') {
      return { state: deploy.state, healthy: null, checks: [] };
    }
    if (this.switches.healthFails) {
      this.restore(deploy);
      deploy.state = 'rolledBack';
      deploy.reason = 'healthCheck';
      deploy.finishedAt = this.now();
      this.record('deployRolledBack', deploy.connectionLabel, 'healthCheck');
      return {
        state: 'rolledBack',
        healthy: false,
        checks: [{ name: 'home', status: 500, ok: false, detail: 'The home page answered 500.' }],
      };
    }
    return {
      state: 'applied',
      healthy: true,
      checks: [
        { name: 'home', status: 200, ok: true, detail: '' },
        { name: 'ajaxPing', status: 200, ok: true, detail: '' },
      ],
    };
  }

  private finalize(input: Record<string, unknown>) {
    const deploy = this.deployOf(input);
    if (deploy.state === 'applied') {
      deploy.state = 'done';
      deploy.finishedAt = this.now();
      this.record('deployDone', deploy.connectionLabel);
    } else if (ACTIVE.has(deploy.state)) {
      throw new FakeError('invalidState', 'Only an applied deploy can be finalized.');
    }
    return { state: deploy.state, ...(deploy.reason ? { reason: deploy.reason } : {}) };
  }

  private rollback(input: Record<string, unknown>) {
    const deploy = this.deployOf(input);
    if (deploy.state === 'open') {
      deploy.state = 'aborted';
      deploy.finishedAt = this.now();
      return { state: 'aborted', restored: 0, removed: 0 };
    }
    if (deploy.state === 'done' && !input.force && !this.unchangedSince(deploy)) {
      throw new FakeError('conflict', 'Files changed since this deploy.', {
        conflicts: [],
      });
    }
    if (deploy.state === 'applying' || deploy.state === 'applied' || deploy.state === 'done') {
      const counts = this.restore(deploy);
      deploy.state = 'rolledBack';
      deploy.reason = 'requested';
      deploy.finishedAt = this.now();
      this.record('deployRolledBack', deploy.connectionLabel, 'requested');
      return { state: 'rolledBack', reason: 'requested', ...counts };
    }
    return {
      state: deploy.state,
      ...(deploy.reason ? { reason: deploy.reason } : {}),
      restored: 0,
      removed: 0,
    };
  }

  private unchangedSince(deploy: FakeDeploy): boolean {
    for (const [key, expected] of deploy.applied ?? []) {
      const slash = key.indexOf('/');
      const [kind, slug] = key.slice(0, slash).split(':');
      const actual = this.currentSha(
        { kind: kind as WpItemRef['kind'], slug },
        key.slice(slash + 1),
      );
      if (actual !== expected) return false;
    }
    return true;
  }

  private abort(input: Record<string, unknown>) {
    const deploy = this.deployOf(input);
    if (deploy.state === 'open') {
      deploy.state = 'aborted';
      deploy.finishedAt = this.now();
      this.record('deployAborted', deploy.connectionLabel);
    } else if (ACTIVE.has(deploy.state)) {
      throw new FakeError('invalidState', 'An applied deploy is rolled back, not aborted.');
    }
    return { state: deploy.state, ...(deploy.reason ? { reason: deploy.reason } : {}) };
  }

  private recordOf(deploy: FakeDeploy): WpDeployRecord {
    return {
      deployId: deploy.id,
      state: deploy.state,
      ...(deploy.reason ? { reason: deploy.reason } : {}),
      label: deploy.label,
      startedAt: deploy.startedAt,
      finishedAt: deploy.finishedAt,
      connectionLabel: deploy.connectionLabel,
      puts: deploy.ops.filter((op) => op.op === 'put').length,
      deletes: deploy.ops.filter((op) => op.op === 'delete').length,
      canRollback: deploy.state === 'done' && this.unchangedSince(deploy),
    };
  }
}

/** Decodes a key's pairing secret, for tests that check it never leaks. */
export function pairingSecretOf(key: string): string {
  const json = JSON.parse(
    new TextDecoder().decode(wpBase64UrlDecode(key.slice('amwp1.'.length)) ?? new Uint8Array()),
  ) as { s: string };
  return json.s;
}
