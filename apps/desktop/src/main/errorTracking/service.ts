import { randomUUID } from 'node:crypto';
import {
  buildErrorFixPrompt,
  type ErrorIssue,
  type ErrorPeriod,
  type ErrorPromptInput,
  formatErrorIssueForCopy,
  isNewIssue,
  type RemoteProject,
} from '@runova/core';
import { net } from 'electron';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type {
  ErrorConnectInput,
  ErrorConnectionSummary,
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssuePrompt,
  ErrorIssueQuery,
  ErrorIssueRef,
  ErrorIssueSort,
  ErrorIssueSummary,
  ErrorProjectLink,
  ErrorSourceFailure,
  ErrorStatusChange,
  ErrorTokenCheck,
  ErrorTokenCheckInput,
} from '../../shared/errorTrackingTypes';
import { isLoopbackHost } from '../health/probe';
import { decryptSecret, encryptSecret, isLockedEnvelope } from '../ssh/vault';
import { store } from '../store';
import {
  createSentryProvider,
  type ErrorProvider,
  type ErrorProviderAccess,
  errorKind,
} from './provider';
import type { SentryTransport } from './sentryClient';
import {
  broadcastErrorTrackingChanged,
  mutateErrorTracking,
  readErrorTracking,
  type StoredErrorConnection,
} from './store';

/**
 * Error tracking (E24): what the Errors tab asks of the main process, on top of the store and a
 * provider. A token is checked before it is saved, sealed with the Servers vault as soon as it
 * is, and only unsealed for the call that needs it. Each connection is asked only about the
 * provider projects linked to a Runova project, and one that fails does not stop the others.
 *
 * Lists are cached for a minute per query, since Sentry asks clients to poll lightly; the
 * Refresh button skips the cache, and anything this service changes drops it.
 */

export interface ErrorTrackingServiceDeps {
  provider: ErrorProvider;
  seal: (plaintext: string) => Promise<SecretEnvelope>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  isLocked: (envelope: SecretEnvelope) => boolean;
  now: () => number;
  /** The Runova projects, for names and to check a link's project exists. */
  projects: () => Promise<{ id: string; name: string }[]>;
}

export const ERROR_CACHE_MS = 60_000;
/** A connection's last good call is written down at most this often. */
const CHECKED_AT_STEP_MS = 60_000;
const ISSUES_PER_CONNECTION = 50;
const MAX_LABEL = 80;
/** The period an issue opened on its own is judged "new" against. */
const DETAIL_PERIOD: ErrorPeriod = '24h';

const LOCKED =
  'The vault is locked, so Runova cannot read the Sentry token. Unlock the vault with your passkey first.';
const GONE = 'That error tracking connection no longer exists.';
const BAD_CURSOR = 'That page of issues is no longer available. Refresh the list.';

class LockedConnectionError extends Error {
  constructor() {
    super(LOCKED);
    this.name = 'LockedConnectionError';
  }
}

function isSentryHost(hostname: string): boolean {
  return hostname === 'sentry.io' || hostname.endsWith('.sentry.io');
}

/**
 * The region host an organization's data is served from, if it is safe to send a token to. The
 * address comes from the server's own answer, so it is only taken on the host the user gave, or
 * on another sentry.io host (`us.sentry.io`, `de.sentry.io`) when the user gave a sentry.io one.
 * Anything else keeps the token on the host the user typed.
 */
export function regionBase(regionUrl: string | null, host: string): string | null {
  if (!regionUrl) return null;
  try {
    const url = new URL(regionUrl);
    const given = new URL(host).hostname;
    const sameHost = url.hostname === given;
    const sentryRegion = isSentryHost(given) && isSentryHost(url.hostname);
    if (!sameHost && !sentryRegion) return null;
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return url.origin;
    }
  } catch {
    // Not a URL: the host the user gave still works.
  }
  return null;
}

const SORTERS: Record<ErrorIssueSort, (a: ErrorIssue, b: ErrorIssue) => number> = {
  lastSeen: (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
  events: (a, b) => b.count - a.count,
  users: (a, b) => b.userCount - a.userCount,
  newest: (a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen),
};

function encodeCursor(cursors: Record<string, string>): string | null {
  if (Object.keys(cursors).length === 0) return null;
  return Buffer.from(JSON.stringify(cursors), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, string> {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((one) => typeof one === 'string')
    ) {
      return value as Record<string, string>;
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw new Error(BAD_CURSOR);
}

function findConnection(
  connections: StoredErrorConnection[],
  connectionId: string,
): StoredErrorConnection {
  const connection = connections.find((one) => one.id === connectionId);
  if (!connection) throw new Error(GONE);
  return connection;
}

export function createErrorTrackingService(
  overrides: Partial<ErrorTrackingServiceDeps> & { transport?: SentryTransport } = {},
) {
  const { transport, ...given } = overrides;
  const deps: ErrorTrackingServiceDeps = {
    provider: createSentryProvider({
      transport: transport ?? ((url, init) => net.fetch(url, init)),
    }),
    seal: encryptSecret,
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    now: Date.now,
    projects: () => store.getProjects(),
    ...given,
  };
  const { provider } = deps;
  const cache = new Map<string, { at: number; page: ErrorIssuePage }>();

  function summary(connection: StoredErrorConnection): ErrorConnectionSummary {
    const { tokenEnvelope, ...rest } = connection;
    return { ...rest, locked: deps.isLocked(tokenEnvelope) };
  }

  async function access(connection: StoredErrorConnection): Promise<ErrorProviderAccess> {
    if (deps.isLocked(connection.tokenEnvelope)) throw new LockedConnectionError();
    try {
      return { baseUrl: connection.apiBase, token: await deps.unseal(connection.tokenEnvelope) };
    } catch (error) {
      if ((error as Error | null)?.name === 'VaultLockedError') throw new LockedConnectionError();
      throw error;
    }
  }

  /**
   * Writes down how the last call through a connection went: a problem as soon as it changes, a
   * good call at most once a minute. A missing issue says nothing about the connection.
   */
  async function record(connection: StoredErrorConnection, error: unknown): Promise<void> {
    if (error instanceof LockedConnectionError || errorKind(error) === 'notFound') return;
    // A refused write is the missing write scope, which canWrite already says.
    if ((error as { scope?: unknown } | null)?.scope === provider.writeScope) return;
    const problem = error ? (error instanceof Error ? error.message : String(error)) : null;
    const now = deps.now();
    const stale = connection.checkedAt === null || now - connection.checkedAt >= CHECKED_AT_STEP_MS;
    if (problem === connection.problem && (problem !== null || !stale)) return;
    await mutateErrorTracking((state) => {
      const saved = state.connections.find((one) => one.id === connection.id);
      if (!saved) return;
      saved.problem = problem;
      if (!problem) saved.checkedAt = now;
    }).catch(() => undefined);
  }

  /** Runs one call through a connection and records how it went. */
  async function through<T>(
    connection: StoredErrorConnection,
    work: (access: ErrorProviderAccess) => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await work(await access(connection));
    } catch (error) {
      await record(connection, error);
      throw error;
    }
    await record(connection, null);
    return result;
  }

  async function checkToken(input: ErrorTokenCheckInput): Promise<ErrorTokenCheck> {
    const { baseUrl, orgSlugHint } = provider.normalizeHost(input.host);
    const token = input.token.trim();
    if (!token) throw new Error('Paste the token first.');
    const warning = provider.tokenWarning(token);
    const tokenAccess = { baseUrl, token };
    let scopes: string[] | null;
    let organizations: Awaited<ReturnType<ErrorProvider['organizations']>>;
    try {
      scopes = await provider.scopes(tokenAccess);
      organizations = await provider.organizations(tokenAccess);
    } catch (error) {
      if (warning) throw new Error(warning);
      throw error;
    }
    if (orgSlugHint) {
      organizations.sort((a, b) => Number(b.slug === orgSlugHint) - Number(a.slug === orgSlugHint));
    }
    return {
      host: baseUrl,
      organizations,
      scopes,
      missingScopes: scopes ? provider.readScopes.filter((scope) => !scopes.includes(scope)) : [],
      canWrite: scopes ? scopes.includes(provider.writeScope) : null,
      warning:
        warning ??
        (organizations.length === 0
          ? 'The token sees no organization. Check that it belongs to a member of the organization.'
          : null),
    };
  }

  /** The check a token must pass before it is saved for `orgSlug`. */
  async function checkForSaving(input: ErrorTokenCheckInput, orgSlug: string) {
    const check = await checkToken(input);
    const warning = provider.tokenWarning(input.token);
    if (warning) throw new Error(warning);
    if (check.missingScopes.length > 0) {
      throw new Error(
        `The token lacks ${check.missingScopes.join(', ')}. Create a token with ${provider.readScopes.join(', ')}.`,
      );
    }
    const organization = check.organizations.find((one) => one.slug === orgSlug);
    if (!organization) throw new Error(`The token cannot see the organization "${orgSlug}".`);
    return {
      check,
      organization,
      apiBase: regionBase(organization.regionUrl, check.host) ?? check.host,
    };
  }

  function issueSummary(
    issue: ErrorIssue,
    connectionId: string,
    projectId: string,
    period: ErrorPeriod,
  ): ErrorIssueSummary {
    return { ...issue, connectionId, projectId, isNew: isNewIssue(issue, period, deps.now()) };
  }

  function linkedProjectId(
    links: ErrorProjectLink[],
    connectionId: string,
    remoteProjectId: string,
  ): string {
    return (
      links.find(
        (one) => one.connectionId === connectionId && one.remoteProjectId === remoteProjectId,
      )?.projectId ?? ''
    );
  }

  async function issueDetail(ref: ErrorIssueRef): Promise<ErrorIssueDetail> {
    const { connections, links } = await readErrorTracking();
    const connection = findConnection(connections, ref.connectionId);
    const [issue, event] = await through(connection, (one) =>
      Promise.all([
        provider.issue(one, connection.orgSlug, ref.issueId),
        provider.latestEvent(one, connection.orgSlug, ref.issueId),
      ]),
    );
    const projectId = linkedProjectId(links, connection.id, issue.remoteProjectId);
    return {
      issue: issueSummary(issue, connection.id, projectId, DETAIL_PERIOD),
      event,
      canWrite: connection.canWrite,
    };
  }

  return {
    clearCache(): void {
      cache.clear();
    },

    checkToken,

    async listConnections(): Promise<ErrorConnectionSummary[]> {
      return (await readErrorTracking()).connections.map(summary);
    },

    async addConnection(input: ErrorConnectInput): Promise<ErrorConnectionSummary> {
      const { check, organization, apiBase } = await checkForSaving(input, input.orgSlug);
      const label = (input.label ?? '').trim().slice(0, MAX_LABEL) || organization.name;
      const now = deps.now();
      const connection: StoredErrorConnection = {
        id: randomUUID(),
        provider: provider.id,
        label,
        host: check.host,
        apiBase,
        orgSlug: organization.slug,
        orgName: organization.name,
        scopes: check.scopes,
        canWrite: check.canWrite ?? true,
        createdAt: now,
        checkedAt: now,
        problem: null,
        tokenEnvelope: await deps.seal(input.token.trim()),
      };
      await mutateErrorTracking((state) => {
        if (
          state.connections.some(
            (one) => one.apiBase === connection.apiBase && one.orgSlug === connection.orgSlug,
          )
        ) {
          throw new Error('That organization is already connected. Replace its token instead.');
        }
        state.connections.push(connection);
      });
      cache.clear();
      broadcastErrorTrackingChanged('connections');
      return summary(connection);
    },

    async removeConnection(connectionId: string): Promise<void> {
      await mutateErrorTracking((state) => {
        state.connections = state.connections.filter((one) => one.id !== connectionId);
        state.links = state.links.filter((one) => one.connectionId !== connectionId);
      });
      cache.clear();
      broadcastErrorTrackingChanged('connections');
    },

    async replaceToken(connectionId: string, token: string): Promise<ErrorConnectionSummary> {
      const current = findConnection((await readErrorTracking()).connections, connectionId);
      const { check, apiBase } = await checkForSaving(
        { provider: current.provider, host: current.host, token },
        current.orgSlug,
      );
      const envelope = await deps.seal(token.trim());
      const replaced = await mutateErrorTracking((state) => {
        const connection = findConnection(state.connections, connectionId);
        connection.tokenEnvelope = envelope;
        connection.apiBase = apiBase;
        connection.scopes = check.scopes;
        connection.canWrite = check.canWrite ?? true;
        connection.checkedAt = deps.now();
        connection.problem = null;
        return connection;
      });
      cache.clear();
      broadcastErrorTrackingChanged('connections');
      return summary(replaced);
    },

    async remoteProjects(connectionId: string): Promise<RemoteProject[]> {
      const connection = findConnection((await readErrorTracking()).connections, connectionId);
      return through(connection, (one) => provider.projects(one, connection.orgSlug));
    },

    /** Every environment of the linked provider projects. One that cannot be read is left out. */
    async environments(filter: { projectId?: string } = {}): Promise<string[]> {
      const { connections, links } = await readErrorTracking();
      const names = new Set<string>();
      await Promise.all(
        connections.map(async (connection) => {
          const slugs = new Set(
            links
              .filter(
                (one) =>
                  one.connectionId === connection.id &&
                  (filter.projectId === undefined || one.projectId === filter.projectId),
              )
              .map((one) => one.remoteSlug),
          );
          if (slugs.size === 0) return;
          let tokenAccess: ErrorProviderAccess;
          try {
            tokenAccess = await access(connection);
          } catch {
            return;
          }
          await Promise.all(
            [...slugs].map(async (slug) => {
              try {
                const found = await provider.environments(tokenAccess, connection.orgSlug, slug);
                for (const name of found) names.add(name);
              } catch {
                // That project's environments stay out of the picker.
              }
            }),
          );
        }),
      );
      return [...names].sort((a, b) => a.localeCompare(b));
    },

    async listLinks(filter: { projectId?: string } = {}): Promise<ErrorProjectLink[]> {
      const { links } = await readErrorTracking();
      return links.filter(
        (one) => filter.projectId === undefined || one.projectId === filter.projectId,
      );
    },

    /** Replaces the project's links. A link always belongs to the project it is saved under. */
    async setLinks(projectId: string, links: ErrorProjectLink[]): Promise<ErrorProjectLink[]> {
      if (!(await deps.projects()).some((project) => project.id === projectId)) {
        throw new Error('That project no longer exists.');
      }
      const saved = await mutateErrorTracking((state) => {
        const next: ErrorProjectLink[] = [];
        for (const one of links) {
          findConnection(state.connections, one.connectionId);
          const entry: ErrorProjectLink = {
            projectId,
            connectionId: one.connectionId,
            remoteProjectId: one.remoteProjectId,
            remoteSlug: one.remoteSlug,
            remoteName: one.remoteName,
          };
          const duplicate = next.some(
            (other) =>
              other.connectionId === entry.connectionId &&
              other.remoteProjectId === entry.remoteProjectId,
          );
          if (!duplicate) next.push(entry);
        }
        state.links = [...state.links.filter((one) => one.projectId !== projectId), ...next];
        return next;
      });
      cache.clear();
      broadcastErrorTrackingChanged('links');
      return saved;
    },

    async listIssues(query: ErrorIssueQuery): Promise<ErrorIssuePage> {
      const { refresh, ...rest } = query;
      const key = JSON.stringify(rest);
      const now = deps.now();
      const cached = cache.get(key);
      if (!refresh && cached && now - cached.at < ERROR_CACHE_MS) return cached.page;

      const cursors = query.cursor ? decodeCursor(query.cursor) : null;
      const { connections, links } = await readErrorTracking();
      const wanted = links.filter(
        (one) => query.projectId === undefined || one.projectId === query.projectId,
      );
      const asked = connections.filter(
        (connection) =>
          wanted.some((one) => one.connectionId === connection.id) &&
          (cursors === null || cursors[connection.id] !== undefined),
      );

      const issues: ErrorIssueSummary[] = [];
      const failures: ErrorSourceFailure[] = [];
      const next: Record<string, string> = {};
      await Promise.all(
        asked.map(async (connection) => {
          const own = wanted.filter((one) => one.connectionId === connection.id);
          const projects = [
            ...new Map(
              own.map((one) => [
                one.remoteProjectId,
                { id: one.remoteProjectId, slug: one.remoteSlug },
              ]),
            ).values(),
          ];
          try {
            const page = await through(connection, (one) =>
              provider.issues(one, connection.orgSlug, {
                projects,
                status: query.status,
                period: query.period,
                environment: query.environment,
                sort: query.sort,
                search: query.search,
                cursor: cursors?.[connection.id] ?? null,
                limit: ISSUES_PER_CONNECTION,
              }),
            );
            for (const issue of page.issues) {
              const projectId = linkedProjectId(own, connection.id, issue.remoteProjectId);
              if (projectId)
                issues.push(issueSummary(issue, connection.id, projectId, query.period));
            }
            if (page.next) next[connection.id] = page.next;
          } catch (error) {
            failures.push({
              connectionId: connection.id,
              label: connection.label,
              message: error instanceof Error ? error.message : String(error),
              locked: error instanceof LockedConnectionError,
            });
          }
        }),
      );

      issues.sort(SORTERS[query.sort]);
      const page: ErrorIssuePage = {
        issues,
        nextCursor: encodeCursor(next),
        failures,
        fetchedAt: now,
      };
      if (failures.length === 0) cache.set(key, { at: now, page });
      return page;
    },

    getIssue: issueDetail,

    async setIssueStatus(change: ErrorStatusChange): Promise<ErrorIssueSummary> {
      const { connections, links } = await readErrorTracking();
      const connection = findConnection(connections, change.connectionId);
      try {
        await through(connection, (one) =>
          provider.setStatus(one, connection.orgSlug, change.issueId, {
            status: change.status,
            ignoreMinutes: change.ignoreMinutes,
          }),
        );
      } catch (error) {
        if (errorKind(error) !== 'forbidden') throw error;
        await mutateErrorTracking((state) => {
          const saved = state.connections.find((one) => one.id === connection.id);
          if (saved) saved.canWrite = false;
        });
        broadcastErrorTrackingChanged('connections');
        throw new Error(
          `Sentry refused to change the issue because the token lacks the ${provider.writeScope} scope. Replace the token with one that has it to resolve and ignore from Runova.`,
        );
      }
      if (!connection.canWrite) {
        await mutateErrorTracking((state) => {
          const saved = state.connections.find((one) => one.id === connection.id);
          if (saved) saved.canWrite = true;
        });
        broadcastErrorTrackingChanged('connections');
      }
      cache.clear();
      const issue = await through(connection, (one) =>
        provider.issue(one, connection.orgSlug, change.issueId),
      );
      broadcastErrorTrackingChanged('issues');
      const projectId = linkedProjectId(links, connection.id, issue.remoteProjectId);
      // Sentry can lag a moment behind its own write; the change that just worked is the truth.
      return {
        ...issueSummary(issue, connection.id, projectId, DETAIL_PERIOD),
        status: change.status,
      };
    },

    async fixPrompt(ref: ErrorIssueRef): Promise<ErrorIssuePrompt> {
      const detail = await issueDetail(ref);
      const project = (await deps.projects()).find((one) => one.id === detail.issue.projectId);
      const input: ErrorPromptInput = {
        projectName: project?.name ?? detail.issue.remoteProjectSlug,
        issue: detail.issue,
        event: detail.event,
      };
      return { prompt: buildErrorFixPrompt(input), copy: formatErrorIssueForCopy(input) };
    },
  };
}

export type ErrorTrackingService = ReturnType<typeof createErrorTrackingService>;

let shared: ErrorTrackingService | null = null;

/** The app's service: Electron's network stack, the vault and the saved projects. */
export function getErrorTrackingService(): ErrorTrackingService {
  shared ??= createErrorTrackingService();
  return shared;
}
