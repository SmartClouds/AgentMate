import { redactHealthText } from '@runova/core';

/**
 * The Sentry Web API over HTTP (E24), nothing more: it sends the token, reads the JSON back and
 * turns every way a call can fail into a sentence for the user. Turning the JSON into Runova's
 * own types is the provider's job (provider.ts), so this file knows URLs and status codes only.
 *
 * The token goes in one header to the one base it was given. A redirect is refused rather than
 * followed, so the token never reaches another address, and every message that leaves here has
 * it masked. Bodies are read up to a cap so a runaway answer cannot fill memory.
 *
 * The transport is injected, as in health/probe.ts: the app passes Electron's net.fetch, which
 * honours the system proxy and certificate store, and the tests pass Node's fetch.
 */

export type SentryTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface SentryClientOptions {
  /** The API host, such as `https://sentry.io` or a data region; any path is kept. */
  baseUrl: string;
  token: string;
  transport: SentryTransport;
  timeoutMs?: number;
  now?: () => number;
}

export type SentryErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'rateLimited'
  | 'server'
  | 'http'
  | 'invalid'
  | 'tooLarge'
  | 'redirect'
  | 'timeout'
  | 'network';

/** A call that did not work, with a message that is safe to show. */
export class SentryApiError extends Error {
  readonly kind: SentryErrorKind;
  /** The HTTP status, or null when there was no answer. */
  readonly status: number | null;
  /** For `forbidden`: the scope the call needed. */
  readonly scope: string | null;

  constructor(kind: SentryErrorKind, message: string, status: number | null, scope: string | null) {
    super(message);
    this.name = 'SentryApiError';
    this.kind = kind;
    this.status = status;
    this.scope = scope;
  }
}

/** A list answer: the JSON and the `Link` header that pages it. */
export interface SentryReply {
  data: unknown;
  link: string | null;
}

/** A provider project as the issue list asks for it: by id, or by slug on the older paths. */
export interface SentryProjectRef {
  id: string;
  slug: string;
}

export interface SentryIssueParams {
  projects: SentryProjectRef[];
  environment?: string | null;
  statsPeriod: string;
  /** Sent even when empty: Sentry reads a missing query as `is:unresolved`. */
  query: string;
  sort: string;
  limit: number;
  cursor?: string | null;
}

export interface SentryStatusBody {
  status: 'resolved' | 'unresolved' | 'ignored';
  ignoreDuration?: number;
  substatus?: string;
}

export const SENTRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const SENTRY_TIMEOUT_MS = 15_000;

const SCOPE = {
  org: 'org:read',
  project: 'project:read',
  read: 'event:read',
  write: 'event:write',
} as const;

const REDIRECTED =
  'Sentry answered with a redirect. Runova does not follow redirects, so the token is never sent to another address. Check the host.';

const NODE_TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

class TooLargeError extends Error {}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > SENTRY_MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TooLargeError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > SENTRY_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf-8');
}

/** Every `code` and message along an error's `cause` chain, since fetch nests the useful one. */
function describeError(error: unknown): { codes: string[]; text: string; name: string } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object') {
      const { code, message } = current as { code?: unknown; message?: unknown };
      if (typeof code === 'string') codes.push(code);
      if (typeof message === 'string') messages.push(message);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      current = null;
    }
  }
  const name = (error as { name?: unknown } | null)?.name;
  return { codes, text: messages.join(' '), name: typeof name === 'string' ? name : '' };
}

function networkError(error: unknown, host: string, timeoutMs: number): SentryApiError {
  const { codes, text, name } = describeError(error);
  const has = (...wanted: string[]) =>
    wanted.some((code) => codes.includes(code) || text.includes(code));
  const fail = (kind: SentryErrorKind, message: string) =>
    new SentryApiError(kind, message, null, null);

  if (name === 'TimeoutError' || name === 'AbortError') {
    return fail('timeout', `Sentry did not answer within ${timeoutMs / 1000} s.`);
  }
  if (/redirect/i.test(text)) return fail('redirect', REDIRECTED);
  if (/ERR_CERT_|ERR_SSL_/.test(text) || codes.some((code) => NODE_TLS_CODES.has(code))) {
    const code = text.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? codes.find((c) => NODE_TLS_CODES.has(c));
    return fail(
      'network',
      `This computer does not trust the TLS certificate of ${host}${code ? ` (${code})` : ''}.`,
    );
  }
  if (has('ECONNREFUSED', 'ERR_CONNECTION_REFUSED')) {
    return fail('network', `The connection to ${host} was refused. Check the host.`);
  }
  if (has('ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED')) {
    return fail(
      'network',
      `The host name of ${host} could not be resolved. Check the address and this computer's DNS.`,
    );
  }
  if (has('ECONNRESET', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'UND_ERR_SOCKET')) {
    return fail('network', `The connection to ${host} was reset before it answered.`);
  }
  if (has('ETIMEDOUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'UND_ERR_CONNECT_TIMEOUT')) {
    return fail('network', `The connection to ${host} timed out.`);
  }
  const detail = text.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? codes[0] ?? text;
  return fail('network', `Could not reach ${host}${detail ? ` (${detail})` : ''}.`);
}

/** Seconds until Sentry takes requests again, from its own header or the standard one. */
function retryAfterSeconds(headers: Headers, now: number): number | null {
  const reset = Number(headers.get('x-sentry-rate-limit-reset'));
  if (headers.has('x-sentry-rate-limit-reset') && Number.isFinite(reset)) {
    return Math.max(1, Math.ceil(reset - now / 1000));
  }
  const after = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(after)) return Math.max(1, Math.ceil(after));
  return null;
}

function detailOf(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
    return typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

function statusError(
  status: number,
  headers: Headers,
  body: string,
  scope: string,
  now: number,
): SentryApiError {
  if (status === 401) {
    return new SentryApiError(
      'unauthorized',
      'Sentry rejected the token. It may be mistyped, expired or revoked.',
      status,
      null,
    );
  }
  if (status === 403) {
    return new SentryApiError(
      'forbidden',
      `Sentry refused this because the token lacks the ${scope} scope. Create a token that has it.`,
      status,
      scope,
    );
  }
  if (status === 404) {
    return new SentryApiError(
      'notFound',
      'Sentry could not find that. It may have been deleted, or the token cannot see it.',
      status,
      null,
    );
  }
  if (status === 429) {
    const seconds = retryAfterSeconds(headers, now);
    return new SentryApiError(
      'rateLimited',
      `Sentry is rate limiting requests, try again in ${seconds === null ? 'a minute' : `${seconds}s`}.`,
      status,
      null,
    );
  }
  if (status >= 500) {
    return new SentryApiError(
      'server',
      `Sentry had a problem answering (HTTP ${status}). Try again in a moment.`,
      status,
      null,
    );
  }
  const detail = detailOf(body);
  return new SentryApiError(
    'http',
    `Sentry refused the request (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    status,
    null,
  );
}

const segment = (value: string) => encodeURIComponent(value);

export function createSentryClient(options: SentryClientOptions) {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? SENTRY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    // The service only builds clients for hosts it checked; the base itself still names it.
  }

  const masked = (error: SentryApiError): SentryApiError =>
    new SentryApiError(
      error.kind,
      redactHealthText(error.message, [options.token]),
      error.status,
      error.scope,
    );

  async function call(
    path: string,
    scope: string,
    init: { method?: 'GET' | 'PUT'; params?: URLSearchParams; body?: unknown } = {},
  ): Promise<SentryReply> {
    const query = init.params?.toString();
    const url = `${base}${path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
      'User-Agent': 'Runova-ErrorTracking/1',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    let text: string;
    try {
      response = await options.transport(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (
        response.type === 'opaqueredirect' ||
        response.status === 0 ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new SentryApiError('redirect', REDIRECTED, response.status || null, null);
      }
      text = await readCapped(response);
    } catch (error) {
      if (error instanceof SentryApiError) throw masked(error);
      if (error instanceof TooLargeError) {
        throw new SentryApiError(
          'tooLarge',
          'Sentry sent more than 2 MB, so Runova stopped reading it.',
          null,
          null,
        );
      }
      throw masked(networkError(error, host, timeoutMs));
    }
    if (!response.ok)
      throw masked(statusError(response.status, response.headers, text, scope, now()));
    let data: unknown = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new SentryApiError(
          'invalid',
          'Sentry sent a reply that is not JSON. Check that the host is the Sentry API.',
          response.status,
          null,
        );
      }
    }
    return { data, link: response.headers.get('link') };
  }

  /** Runs the organization-scoped path, and the older one GlitchTip has when that is missing. */
  async function withFallback(
    primary: () => Promise<SentryReply>,
    legacy: () => Promise<SentryReply>,
  ): Promise<SentryReply> {
    try {
      return await primary();
    } catch (error) {
      if (!(error instanceof SentryApiError) || error.kind !== 'notFound') throw error;
      return legacy();
    }
  }

  function issueParams(params: SentryIssueParams, withProjects: boolean): URLSearchParams {
    const search = new URLSearchParams();
    if (withProjects) for (const project of params.projects) search.append('project', project.id);
    if (params.environment) search.set('environment', params.environment);
    search.set('statsPeriod', params.statsPeriod);
    search.set('query', params.query);
    search.set('sort', params.sort);
    search.set('limit', String(params.limit));
    if (params.cursor) search.set('cursor', params.cursor);
    return search;
  }

  const issuePath = (org: string, id: string) =>
    `/api/0/organizations/${segment(org)}/issues/${segment(id)}/`;
  const legacyIssuePath = (id: string) => `/api/0/issues/${segment(id)}/`;

  return {
    /** The token's scopes when the root says, else null. A rejected token still throws. */
    async root(): Promise<{ scopes: string[] | null }> {
      try {
        const { data } = await call('/api/0/', SCOPE.org);
        const scopes = (data as { auth?: { scopes?: unknown } } | null)?.auth?.scopes;
        return {
          scopes:
            Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')
              ? scopes
              : null,
        };
      } catch (error) {
        if (error instanceof SentryApiError && error.kind === 'unauthorized') throw error;
        return { scopes: null };
      }
    },

    async listOrgs(): Promise<unknown> {
      return (await call('/api/0/organizations/', SCOPE.org)).data;
    },

    listProjects(org: string, cursor?: string | null): Promise<SentryReply> {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      return call(`/api/0/organizations/${segment(org)}/projects/`, SCOPE.project, { params });
    },

    async listEnvironments(org: string, projectSlug: string): Promise<unknown> {
      const path = `/api/0/projects/${segment(org)}/${segment(projectSlug)}/environments/`;
      return (await call(path, SCOPE.project)).data;
    },

    listIssues(org: string, params: SentryIssueParams): Promise<SentryReply> {
      return withFallback(
        () =>
          call(`/api/0/organizations/${segment(org)}/issues/`, SCOPE.read, {
            params: issueParams(params, true),
          }),
        async () => {
          if (params.projects.length === 0) {
            throw statusError(404, new Headers(), '', SCOPE.read, now());
          }
          // The older path is one project at a time, so only a single project keeps its cursor.
          const replies = await Promise.all(
            params.projects.map((project) =>
              call(`/api/0/projects/${segment(org)}/${segment(project.slug)}/issues/`, SCOPE.read, {
                params: issueParams(params, false),
              }),
            ),
          );
          return {
            data: replies.flatMap((reply) => (Array.isArray(reply.data) ? reply.data : [])),
            link: replies.length === 1 ? replies[0].link : null,
          };
        },
      );
    },

    async getIssue(org: string, id: string): Promise<unknown> {
      const reply = await withFallback(
        () => call(issuePath(org, id), SCOPE.read),
        () => call(legacyIssuePath(id), SCOPE.read),
      );
      return reply.data;
    },

    async latestEvent(org: string, id: string): Promise<unknown> {
      const reply = await withFallback(
        () => call(`${issuePath(org, id)}events/latest/`, SCOPE.read),
        () => call(`${legacyIssuePath(id)}events/latest/`, SCOPE.read),
      );
      return reply.data;
    },

    async updateStatus(org: string, id: string, body: SentryStatusBody): Promise<unknown> {
      const reply = await withFallback(
        () => call(issuePath(org, id), SCOPE.write, { method: 'PUT', body }),
        () => call(legacyIssuePath(id), SCOPE.write, { method: 'PUT', body }),
      );
      return reply.data;
    },
  };
}

export type SentryClient = ReturnType<typeof createSentryClient>;
