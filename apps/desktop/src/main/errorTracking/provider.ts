import {
  type ErrorEvent,
  type ErrorIssue,
  type ErrorIssueStatus,
  type ErrorPeriod,
  type ErrorTrackingProvider,
  normalizeSentryHost,
  parseLinkHeader,
  parseSentryEnvironments,
  parseSentryEvent,
  parseSentryIssue,
  parseSentryIssues,
  parseSentryOrganizations,
  parseSentryProjects,
  type RemoteOrganization,
  type RemoteProject,
  SENTRY_READ_SCOPES,
  SENTRY_WRITE_SCOPE,
} from '@agentmat/core';
import type { ErrorIssueSort, ErrorStatusFilter } from '../../shared/errorTrackingTypes';
import {
  createSentryClient,
  SentryApiError,
  type SentryStatusBody,
  type SentryTransport,
} from './sentryClient';

/**
 * An error tracker as the service sees it (E24): hosts, scopes, and the provider's data already
 * in AgentMate's own types. Sentry is the only one so far; a second provider is one more
 * implementation of `ErrorProvider` and nothing else changes.
 *
 * Every failure it throws carries a `kind` (see sentryClient.ts) next to a message that is safe
 * to show, which is how the service tells a missing scope from a dead network.
 */

/** Where to reach one organization's data, and with what. */
export interface ErrorProviderAccess {
  baseUrl: string;
  token: string;
}

export interface ErrorIssueRequest {
  projects: { id: string; slug: string }[];
  status: ErrorStatusFilter;
  period: ErrorPeriod;
  environment?: string | null;
  sort: ErrorIssueSort;
  search?: string;
  cursor?: string | null;
  limit: number;
}

export interface ErrorProviderStatusChange {
  status: ErrorIssueStatus;
  ignoreMinutes?: number | null;
}

export interface ErrorProvider {
  readonly id: ErrorTrackingProvider;
  readonly readScopes: readonly string[];
  readonly writeScope: string;
  /** Cleans up a typed host; throws a message for the user when it is not usable. */
  normalizeHost(input: string): { baseUrl: string; orgSlugHint: string | null };
  /** A hint when the token is of a kind that cannot do the job, else null. */
  tokenWarning(token: string): string | null;
  /** The token's scopes, or null when the provider would not say. */
  scopes(access: ErrorProviderAccess): Promise<string[] | null>;
  organizations(access: ErrorProviderAccess): Promise<RemoteOrganization[]>;
  projects(access: ErrorProviderAccess, org: string): Promise<RemoteProject[]>;
  environments(access: ErrorProviderAccess, org: string, projectSlug: string): Promise<string[]>;
  issues(
    access: ErrorProviderAccess,
    org: string,
    request: ErrorIssueRequest,
  ): Promise<{ issues: ErrorIssue[]; next: string | null }>;
  issue(access: ErrorProviderAccess, org: string, issueId: string): Promise<ErrorIssue>;
  /** Null when the issue has no event to show. */
  latestEvent(
    access: ErrorProviderAccess,
    org: string,
    issueId: string,
  ): Promise<ErrorEvent | null>;
  setStatus(
    access: ErrorProviderAccess,
    org: string,
    issueId: string,
    change: ErrorProviderStatusChange,
  ): Promise<void>;
}

/** The kind a provider failure carries, or null for anything else. */
export function errorKind(error: unknown): string | null {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : null;
}

export const SENTRY_SORT: Record<ErrorIssueSort, string> = {
  lastSeen: 'date',
  events: 'freq',
  users: 'user',
  newest: 'new',
};

/** The status filter and the search as one Sentry query. `all` sends no status at all. */
export function sentryIssueQuery(status: ErrorStatusFilter, search: string | undefined): string {
  const terms = status === 'all' ? [] : [`is:${status}`];
  const text = (search ?? '').trim();
  if (text) terms.push(text);
  return terms.join(' ');
}

/** Ignoring for a while sends minutes; ignoring for good archives it forever. */
export function sentryStatusBody(
  status: ErrorIssueStatus,
  ignoreMinutes: number | null | undefined,
): SentryStatusBody {
  if (status !== 'ignored') return { status };
  return ignoreMinutes
    ? { status, ignoreDuration: ignoreMinutes }
    : { status, substatus: 'archived_forever' };
}

/** Pages of projects read before giving up; 100 a page is far more than anyone links. */
const MAX_PROJECT_PAGES = 10;

const ORG_TOKEN_WARNING =
  'This is an organization auth token. Those are made for CI uploads and cannot read issues. Create a personal (user) auth token, or an internal integration token, with the scopes listed.';

export interface SentryProviderDeps {
  transport: SentryTransport;
  timeoutMs?: number;
  now?: () => number;
}

export function createSentryProvider(deps: SentryProviderDeps): ErrorProvider {
  const client = (access: ErrorProviderAccess) =>
    createSentryClient({
      baseUrl: access.baseUrl,
      token: access.token,
      transport: deps.transport,
      timeoutMs: deps.timeoutMs,
      now: deps.now,
    });

  return {
    id: 'sentry',
    readScopes: SENTRY_READ_SCOPES,
    writeScope: SENTRY_WRITE_SCOPE,
    normalizeHost: (input) => normalizeSentryHost(input),
    tokenWarning: (token) => (token.trim().startsWith('sntrys_') ? ORG_TOKEN_WARNING : null),

    async scopes(access) {
      return (await client(access).root()).scopes;
    },

    async organizations(access) {
      return parseSentryOrganizations(await client(access).listOrgs());
    },

    async projects(access, org) {
      const api = client(access);
      const projects: RemoteProject[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
        const reply = await api.listProjects(org, cursor);
        projects.push(...parseSentryProjects(reply.data));
        cursor = parseLinkHeader(reply.link).next;
        if (!cursor) break;
      }
      return projects;
    },

    async environments(access, org, projectSlug) {
      return parseSentryEnvironments(await client(access).listEnvironments(org, projectSlug));
    },

    async issues(access, org, request) {
      const reply = await client(access).listIssues(org, {
        projects: request.projects,
        environment: request.environment,
        statsPeriod: request.period,
        query: sentryIssueQuery(request.status, request.search),
        sort: SENTRY_SORT[request.sort],
        limit: request.limit,
        cursor: request.cursor,
      });
      return { issues: parseSentryIssues(reply.data), next: parseLinkHeader(reply.link).next };
    },

    async issue(access, org, issueId) {
      const issue = parseSentryIssue(await client(access).getIssue(org, issueId));
      if (!issue) throw new Error('Sentry sent an issue AgentMate could not read.');
      return issue;
    },

    async latestEvent(access, org, issueId) {
      try {
        return parseSentryEvent(await client(access).latestEvent(org, issueId));
      } catch (error) {
        if (error instanceof SentryApiError && error.kind === 'notFound') return null;
        throw error;
      }
    },

    async setStatus(access, org, issueId, change) {
      await client(access).updateStatus(
        org,
        issueId,
        sentryStatusBody(change.status, change.ignoreMinutes),
      );
    },
  };
}
