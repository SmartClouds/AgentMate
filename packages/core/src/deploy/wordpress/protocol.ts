import type { ProjectWordPressItem } from '../../types/index.js';

/**
 * The wire contract between AgentMate and the AgentMate Connector WordPress plugin (E19). Pure
 * data: no Node or browser APIs, so the renderer, the main process and the vector generator all
 * read the same definitions. The PHP plugin mirrors every constant and shape here, and the shared
 * vectors in `vectors/protocol-v1.json` keep the two sides byte for byte in step.
 *
 * Every call is a `POST multipart/form-data` with two parts: the text field `am_auth` (see
 * canonical.ts) and the file part `bundle`, which holds gzip of a request frame (see bundle.ts).
 * Every reply is `application/octet-stream`: a response envelope whose meta carries the site's
 * Ed25519 signature, wrapped around gzip of a response frame. Keeping the auth in a form field
 * and the payload gzipped lets calls through hosts that strip headers and firewalls that flag
 * `.php` or `.htaccess` in a request body.
 */

export const WP_PROTOCOL_VERSION = 1;
/**
 * The connector release bundled with this app (the plugin header's Version). A site running an
 * older one still works while its protocol matches; the app just offers the newer zip.
 */
export const WP_CONNECTOR_VERSION = '1.60.0';
/** Every time on the wire, and every time the plugin reports, is whole Unix seconds. */
export type WpUnixSeconds = number;
/** First line of every canonical string. */
export const WP_PROTOCOL_PREFIX = 'agentmate-wp/v1';
export const WP_AUTH_FIELD = 'am_auth';
export const WP_BUNDLE_FIELD = 'bundle';
export const WP_BUNDLE_FILENAME = 'bundle.bin';
export const WP_REST_NAMESPACE = 'agentmate/v1';
/** `admin-ajax.php?action=agentmate_connector&route=<route>`, for sites whose REST API is blocked. */
export const WP_AJAX_ACTION = 'agentmate_connector';
/**
 * The query parameter that names the route on the admin-ajax and rescue endpoints:
 * `<rescueUrl>?route=/rescue/status`. Same multipart body, same signed reply, on every endpoint.
 * The client uses the rescue URL from `/hello` only for `/rescue/*` routes, only when it is on the
 * same origin as one of the key's URLs, and only after the REST and ajax endpoints answered with
 * something that is not a signed envelope.
 */
export const WP_ROUTE_PARAM = 'route';

/*
 * How the client reads a reply (the plugin must give it what it needs):
 * - The signed `meta.status` is the status; the HTTP status may have been changed on the way.
 * - An empty `sig` is accepted only with `meta.status` 429 (the rate limiter skips signing to save
 *   CPU). The wait comes from the HTTP Retry-After header, or `details.retryAfter` (seconds) on a
 *   signed `rateLimited` error.
 * - `staleTimestamp` errors carry `details.serverTime`; the client fixes its clock once and retries.
 * - A `tooLarge` error, or a plain HTTP 413 from something in front of WordPress, halves the batch.
 *   A body over post_max_size makes PHP drop the form before the plugin runs, so that one reply
 *   is signed with `-` for both the nonce and the connection, and is accepted only with a signed
 *   status of 413, only as `tooLarge`.
 * - A commit reply with any `syntaxErrors`, `conflicts` or `refusals` is a failure whatever its
 *   state; the client then calls `/deploy/abort`.
 */
/** How far a request's timestamp may be from the site's clock, either way. */
export const WP_TIMESTAMP_WINDOW_SECONDS = 300;
/** How long a connection key from wp-admin can be used to pair. */
export const WP_PAIRING_TTL_SECONDS = 900;
/** Wrong pair proofs before a pairing is burned. */
export const WP_PAIRING_MAX_ATTEMPTS = 5;

/** Frame limits, checked before anything in a frame is trusted. */
export const WP_MAX_FRAME_HEADER_BYTES = 1024 * 1024;
export const WP_MAX_FRAME_BLOBS = 1000;
/** Hard caps on what one item may hold, on both sides. */
export const WP_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WP_MAX_FILES_PER_ITEM = 20_000;
export const WP_MAX_PATH_BYTES = 400;
export const WP_MAX_SEGMENT_BYTES = 200;
/** Where the client starts and stops when it sizes request batches (it adapts in between). */
export const WP_BATCH_START_BYTES = 512 * 1024;
export const WP_BATCH_MIN_BYTES = 64 * 1024;
export const WP_BATCH_MAX_BYTES = 16 * 1024 * 1024;

/** Every route the plugin answers. The route string is what gets signed, whatever URL carried it. */
export const WP_ROUTES = {
  hello: '/hello',
  pair: '/pair',
  siteInfo: '/site/info',
  itemsList: '/items/list',
  itemsManifest: '/items/manifest',
  filesRead: '/files/read',
  deployBegin: '/deploy/begin',
  deployUpload: '/deploy/upload',
  deployCommit: '/deploy/commit',
  deployVerify: '/deploy/verify',
  deployFinalize: '/deploy/finalize',
  deployRollback: '/deploy/rollback',
  deployAbort: '/deploy/abort',
  deployHistory: '/deploy/history',
  auditList: '/audit/list',
  connectionRevoke: '/connection/revoke',
  connectorUpdate: '/connector/update',
  rescueStatus: '/rescue/status',
  rescueRollback: '/rescue/rollback',
} as const;

export type WpRoute = (typeof WP_ROUTES)[keyof typeof WP_ROUTES];

const ROUTE_SET: ReadonlySet<string> = new Set(Object.values(WP_ROUTES));

export function isWpRoute(value: unknown): value is WpRoute {
  return typeof value === 'string' && ROUTE_SET.has(value);
}

/** Routes a read-only key may not call. */
export const WP_WRITE_ROUTES: readonly WpRoute[] = [
  WP_ROUTES.deployBegin,
  WP_ROUTES.deployUpload,
  WP_ROUTES.deployCommit,
  WP_ROUTES.deployVerify,
  WP_ROUTES.deployFinalize,
  WP_ROUTES.deployRollback,
  WP_ROUTES.deployAbort,
  WP_ROUTES.connectorUpdate,
  WP_ROUTES.rescueRollback,
];

/** Routes that need no connection: `/hello` is unsigned, `/pair` is signed with the new key. */
export const WP_UNAUTHENTICATED_ROUTES: readonly WpRoute[] = [WP_ROUTES.hello, WP_ROUTES.pair];

export type WpScope = 'read' | 'write';

/** A theme, plugin or mu-plugin, by its folder (or single file) name under its root. */
export type WpItemRef = ProjectWordPressItem;

export interface WpItem extends WpItemRef {
  /** The name from the theme or plugin header; the slug when there is none. */
  name: string;
  version: string;
  /** A single-file plugin or mu-plugin (`hello.php`), not a folder. */
  isFile: boolean;
  active: boolean;
  networkActive: boolean;
  /** Whether PHP can write to it (always false when file changes are switched off). */
  writable: boolean;
  /** The connector itself, its guard or its data folder: never written, never listed for sync. */
  protected: boolean;
  /** A child theme's parent (its `Template` header). */
  parentTheme?: string;
  /** A plugin's main file, relative to the plugins folder (`akismet/akismet.php`). */
  mainFile?: string;
}

export interface WpManifestEntry {
  /** Relative to the item root, `/`-separated; for a single-file item, the slug itself. */
  path: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
}

export interface WpSkippedEntry {
  path: string;
  reason: WpPathRejectReason | 'symlink' | 'unreadable' | 'notUtf8' | 'tooLarge' | 'tooMany';
}

/** The reasons a path is refused (see pathPolicy.ts; the order of checks is part of the contract). */
export type WpPathRejectReason =
  | 'empty'
  | 'tooLong'
  | 'controlChar'
  | 'backslash'
  | 'absolute'
  | 'driveLetter'
  | 'colon'
  | 'emptySegment'
  | 'traversal'
  | 'segmentTooLong'
  | 'trailingDotOrSpace'
  | 'reservedName'
  | 'hardDenied';

export interface WpLimits {
  /** The largest request body the site takes, from post_max_size and upload_max_filesize. */
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxFileBytes: number;
  /** How long one call may work before it returns and asks to be called again. */
  timeBudgetSeconds: number;
  maxPathsPerRead: number;
  manifestPageSize: number;
  maxFilesPerItem: number;
}

export type WpDeployState =
  | 'open'
  | 'applying'
  | 'applied'
  | 'done'
  | 'rolledBack'
  | 'aborted'
  | 'expired';

export type WpRollbackReason =
  | 'requested'
  | 'healthCheck'
  | 'fatalError'
  | 'notConfirmed'
  | 'interrupted';

export interface WpPendingDeploy {
  deployId: string;
  state: WpDeployState;
  /** Unix seconds; past it the guard rolls the deploy back. */
  deadline: WpUnixSeconds;
}

export interface WpSiteInfo {
  siteName: string;
  homeUrl: string;
  siteUrl: string;
  wpVersion: string;
  phpVersion: string;
  pluginVersion: string;
  protocol: number;
  multisite: boolean;
  activeTheme: { stylesheet: string; template: string };
  https: boolean;
  serverTime: WpUnixSeconds;
  /** DISALLOW_FILE_MODS: the site owner switched file changes off, so nothing can be deployed. */
  fileModsDisabled: boolean;
  /** DISALLOW_FILE_EDIT: only the built-in editors are off; deploys still work. */
  fileEditDisabled: boolean;
  /** What get_filesystem_method() said; anything but `direct` means no writes. */
  filesystemMethod: string;
  /** AGENTMATE_CONNECTOR_READ_ONLY in wp-config.php. */
  readOnlyByConstant: boolean;
  /**
   * The connector can replace itself when a write connection asks (`/connector/update`): its folder
   * is a real folder PHP may rename. Absent from connectors that predate the route, so read it as
   * false when missing. File changes being switched off is reported by the fields above.
   */
  selfUpdate?: boolean;
  sodium: 'native' | 'compat';
  limits: WpLimits;
  guard: { installed: boolean; rescueUrl: string | null };
  loopback: 'ok' | 'failed' | 'unknown';
  connection: {
    id: string;
    label: string;
    scope: WpScope;
    createdAt: WpUnixSeconds;
    expiresAt: WpUnixSeconds | null;
  };
  pendingDeploy: WpPendingDeploy | null;
}

/**
 * One file change in a deploy. `expected` is what the client believes is on the site now: a
 * sha256, null for "must not exist yet", or `any` to overwrite whatever is there (a forced deploy).
 */
export interface WpDeployOp {
  op: 'put' | 'delete';
  item: WpItemRef;
  path: string;
  /** Put only: the new content's hash and size. */
  sha256?: string;
  size?: number;
  expected: string | null | 'any';
}

export interface WpDeployItem extends WpItemRef {
  /** The deploy may create this item's folder; without it a missing item is refused. */
  create?: boolean;
}

export interface WpHealthCheck {
  /** `external` is the desktop's own GET of the home page, added on its side. */
  name: 'home' | 'ajaxPing' | 'external';
  status: number | null;
  /** Null when the check could not run at all (loopback blocked), which is not a failure. */
  ok: boolean | null;
  detail: string;
}

export interface WpConflict {
  item: WpItemRef;
  path: string;
  expected: string | null;
  actual: string | null;
}

export interface WpRefusal {
  item: WpItemRef;
  path: string;
  reason: WpRefusalReason;
  /** Only conflicts with the active theme or plugins can be forced; path and syntax refusals never. */
  forceable: boolean;
}

export type WpRefusalReason =
  | WpPathRejectReason
  | 'itemUnknown'
  | 'itemProtected'
  | 'notWritable'
  | 'symlink'
  | 'tooLarge'
  | 'deletesActivePluginMainFile'
  | 'touchesActiveThemeCore';

export interface WpSyntaxError {
  item: WpItemRef;
  path: string;
  line: number;
  message: string;
}

export interface WpDeployRecord {
  deployId: string;
  state: WpDeployState;
  reason?: WpRollbackReason;
  label: string;
  startedAt: WpUnixSeconds;
  finishedAt: WpUnixSeconds | null;
  connectionLabel: string;
  puts: number;
  deletes: number;
  /** A snapshot is still kept and nothing it covers changed since. */
  canRollback: boolean;
}

export interface WpAuditEntry {
  id: number;
  at: WpUnixSeconds;
  event: WpAuditEvent;
  connectionLabel: string | null;
  ip: string;
  detail: string;
}

export type WpAuditEvent =
  | 'keyCreated'
  | 'paired'
  | 'pairFailed'
  | 'authFailed'
  | 'rateLimited'
  | 'revoked'
  | 'pulled'
  | 'deployStarted'
  | 'deployDone'
  | 'deployRolledBack'
  | 'deployAborted'
  | 'connectorUpdated'
  | 'connectorRolledBack'
  | 'settingsChanged';

export type WpErrorCode =
  | 'badRequest'
  | 'unauthorized'
  | 'badSignature'
  | 'staleTimestamp'
  | 'replayed'
  | 'unknownConnection'
  | 'revoked'
  | 'readOnly'
  | 'fileModsDisabled'
  | 'notDirect'
  | 'disabled'
  | 'pathRejected'
  | 'itemUnknown'
  | 'itemProtected'
  | 'deployUnknown'
  | 'conflict'
  | 'syntaxError'
  | 'busy'
  | 'invalidState'
  | 'tooLarge'
  | 'rateLimited'
  | 'pairingInvalid'
  | 'pairingExpired'
  | 'protocolMismatch'
  /** A connector update the site will not take; `details.reason` is a WpUpdateRefusal. */
  | 'updateRefused'
  | 'internal';

export interface WpErrorBody {
  code: WpErrorCode;
  /** Plain English from the site; shown as text, never as markup. */
  message: string;
  /** `staleTimestamp` carries `serverTime`; `busy` carries `deployId`; others may carry more. */
  details?: Record<string, unknown>;
}

/** The body of every response frame. */
export type WpResponseBody<T> = { ok: true; data: T } | { ok: false; error: WpErrorBody };

// Request and response shapes, route by route.

export interface WpHelloResponse {
  protocol: number;
  pluginVersion: string;
  /** Raw 32-byte Ed25519 public key, base64url. Must equal the one in the connection key. */
  sitePublicKey: string;
  serverTime: WpUnixSeconds;
  capabilities: string[];
  rescueUrl: string | null;
  multisite: boolean;
  siteName: string;
}

export interface WpPairRequest {
  pairingId: string;
  /** Raw 32-byte Ed25519 public key, base64url. The request is signed with its private half. */
  desktopPublicKey: string;
  deviceName: string;
  /** HMAC-SHA256(pairing secret, wpCanonicalPair(...)), base64url. */
  proof: string;
}

export interface WpPairResponse {
  connectionId: string;
  scope: WpScope;
  label: string;
  expiresAt: WpUnixSeconds | null;
  siteName: string;
  serverTime: WpUnixSeconds;
}

export interface WpManifestRequest {
  item: WpItemRef;
  cursor?: string | null;
}

export interface WpManifestResponse {
  isFile: boolean;
  entries: WpManifestEntry[];
  skipped: WpSkippedEntry[];
  /** Null on the last page. */
  cursor: string | null;
}

export interface WpFileReadRequest {
  item: WpItemRef;
  files: { path: string; offset?: number; length?: number }[];
}

/** One per requested file, in order, each with one blob (empty when missing). */
export interface WpFileReadResult {
  path: string;
  offset: number;
  length: number;
  /** The whole file's size and hash, so a client reading in pieces can check the result. */
  size: number;
  sha256: string;
  /** Gone since the manifest was read. */
  missing?: boolean;
}

export interface WpDeployBeginRequest {
  label: string;
  items: WpDeployItem[];
  ops: WpDeployOp[];
  /** Go ahead over conflicts and forceable refusals. */
  force?: boolean;
}

export interface WpDeployBeginResponse {
  /** Null when conflicts or refusals stopped the deploy before anything was opened. */
  deployId: string | null;
  limits: WpLimits;
  baseline: WpHealthCheck[];
  conflicts: WpConflict[];
  refusals: WpRefusal[];
}

export interface WpDeployUploadRequest {
  deployId: string;
  /** One blob per chunk, in order. `op` is the index of a put in the begin request's ops. */
  chunks: { op: number; offset: number; final: boolean }[];
}

export interface WpDeployUploadResponse {
  received: { op: number; nextOffset: number }[];
}

export interface WpDeployCommitResponse {
  state: WpDeployState;
  progress: { done: number; total: number };
  conflicts?: WpConflict[];
  syntaxErrors?: WpSyntaxError[];
  refusals?: WpRefusal[];
}

export interface WpDeployVerifyResponse {
  state: WpDeployState;
  healthy: boolean | null;
  checks: WpHealthCheck[];
}

export interface WpDeployStateResponse {
  state: WpDeployState;
  reason?: WpRollbackReason;
}

export interface WpDeployRollbackResponse extends WpDeployStateResponse {
  restored: number;
  removed: number;
  conflicts?: WpConflict[];
}

export interface WpRescueStatusResponse {
  pending: WpPendingDeploy | null;
  last: WpDeployRecord | null;
}

/** What a connector update may hold, checked by both sides. The shipped plugin is well under it. */
export const WP_UPDATE_MAX_FILES = 400;
export const WP_UPDATE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const WP_UPDATE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
/** The only file types a connector update may carry (the plugin zip's text files). */
export const WP_UPDATE_FILE_PATTERN = /\.(php|txt|md|css|js|json|xml|html)$/i;

/**
 * One file of the new connector, relative to the plugin folder (`src/Plugin.php`). The request
 * carries one blob per file, in this order, holding that file's bytes.
 */
export interface WpConnectorUpdateFile {
  path: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
}

export interface WpConnectorUpdateRequest {
  /** The version being installed; it must match the plugin header in the files. */
  version: string;
  files: WpConnectorUpdateFile[];
}

/** Why a site refused an update, in `details.reason` of an `updateRefused` error. */
export type WpUpdateRefusal =
  /** The files are older than what runs on the site. */
  | 'downgrade'
  /** The files are not a connector this plugin can install (missing parts, bad header, bad path). */
  | 'badPackage'
  /** The new version needs a newer PHP or WordPress than the site has. */
  | 'requirements'
  /** The plugin folder is a symlink, or PHP may not rename it. */
  | 'notReplaceable';

export interface WpConnectorUpdateResponse {
  /** `rolledBack`: the new files made the site fail its health check, so the old ones are back. */
  state: 'updated' | 'rolledBack';
  fromVersion: string;
  /** The version that was asked for, whether or not it stayed. */
  version: string;
  files: number;
  checks: WpHealthCheck[];
}

/** Route to request and response body. The request body is the frame's `b`. */
export interface WpRouteMap {
  '/hello': { request: Record<string, never>; response: WpHelloResponse };
  '/pair': { request: WpPairRequest; response: WpPairResponse };
  '/site/info': { request: Record<string, never>; response: WpSiteInfo };
  '/items/list': { request: Record<string, never>; response: { items: WpItem[] } };
  '/items/manifest': { request: WpManifestRequest; response: WpManifestResponse };
  '/files/read': { request: WpFileReadRequest; response: { files: WpFileReadResult[] } };
  '/deploy/begin': { request: WpDeployBeginRequest; response: WpDeployBeginResponse };
  '/deploy/upload': { request: WpDeployUploadRequest; response: WpDeployUploadResponse };
  '/deploy/commit': {
    request: { deployId: string; force?: boolean };
    response: WpDeployCommitResponse;
  };
  '/deploy/verify': { request: { deployId: string }; response: WpDeployVerifyResponse };
  '/deploy/finalize': { request: { deployId: string }; response: WpDeployStateResponse };
  '/deploy/rollback': {
    request: { deployId: string; force?: boolean };
    response: WpDeployRollbackResponse;
  };
  '/deploy/abort': { request: { deployId: string }; response: WpDeployStateResponse };
  '/deploy/history': { request: { limit: number }; response: { deploys: WpDeployRecord[] } };
  '/audit/list': {
    request: { limit: number; before?: number };
    response: { entries: WpAuditEntry[] };
  };
  '/connection/revoke': { request: Record<string, never>; response: { revoked: true } };
  '/connector/update': { request: WpConnectorUpdateRequest; response: WpConnectorUpdateResponse };
  '/rescue/status': { request: Record<string, never>; response: WpRescueStatusResponse };
  '/rescue/rollback': { request: { deployId: string }; response: WpDeployStateResponse };
}
