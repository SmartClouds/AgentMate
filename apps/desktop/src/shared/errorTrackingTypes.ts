import type {
  ErrorEvent,
  ErrorIssue,
  ErrorIssueStatus,
  ErrorPeriod,
  ErrorTrackingProvider,
  RemoteOrganization,
  RemoteProject,
} from '@runova/core';

/**
 * Error tracking (E24): what crosses IPC between the Monitoring page's Errors tab and the main
 * process. A stored token never appears in any of these; the renderer only learns which scopes
 * it has. Issues and events are already redacted by the core parsers.
 */

/** A saved connection to one organization at one provider. */
export interface ErrorConnectionSummary {
  id: string;
  provider: ErrorTrackingProvider;
  /** What the user calls it; the org name by default. */
  label: string;
  /** The API base the user gave, such as `https://sentry.io`. */
  host: string;
  /** The host the org's data is served from (a data region), used for every call. */
  apiBase: string;
  orgSlug: string;
  orgName: string;
  /** The scopes the token reported, or null when the provider would not say. */
  scopes: string[] | null;
  /** Resolve and ignore work. False once a write was refused for a missing scope. */
  canWrite: boolean;
  /** The token is sealed with a passkey that is not unlocked yet. */
  locked: boolean;
  createdAt: number;
  /** The last time a call with this token worked. */
  checkedAt: number | null;
  /** Why the last call failed, such as "Token rejected", or null. */
  problem: string | null;
}

/** A provider project linked to a Runova project. One project can have several. */
export interface ErrorProjectLink {
  projectId: string;
  connectionId: string;
  remoteProjectId: string;
  remoteSlug: string;
  remoteName: string;
}

/** Host and token, before anything is saved. */
export interface ErrorTokenCheckInput {
  provider: ErrorTrackingProvider;
  host: string;
  token: string;
}

/** What a token can do, so the dialog can show it before saving. */
export interface ErrorTokenCheck {
  /** The cleaned up host. */
  host: string;
  organizations: RemoteOrganization[];
  /** Null when the provider would not say. */
  scopes: string[] | null;
  /** Read scopes the token lacks (empty when scopes are unknown). */
  missingScopes: string[];
  canWrite: boolean | null;
  /** A hint for the user, such as an org auth token that cannot read issues. */
  warning: string | null;
}

export interface ErrorConnectInput extends ErrorTokenCheckInput {
  orgSlug: string;
  label?: string;
}

/** The status filter of the issue list. `all` sends no status to the provider. */
export type ErrorStatusFilter = ErrorIssueStatus | 'all';

export type ErrorIssueSort = 'lastSeen' | 'events' | 'users' | 'newest';

export interface ErrorIssueQuery {
  /** One project's issues, or every linked project's when absent. */
  projectId?: string;
  status: ErrorStatusFilter;
  period: ErrorPeriod;
  environment?: string | null;
  sort: ErrorIssueSort;
  /** Free text, passed to the provider's search. */
  search?: string;
  /** From the last page's `nextCursor`. */
  cursor?: string | null;
  /** Skips the main process's short cache, for the Refresh button. */
  refresh?: boolean;
}

/** An issue as the list shows it, with where it came from. */
export interface ErrorIssueSummary extends ErrorIssue {
  connectionId: string;
  /** The Runova project the provider project is linked to. */
  projectId: string;
  /** First seen inside the period the list looks at. */
  isNew: boolean;
}

/** A connection the page could not read this time. */
export interface ErrorSourceFailure {
  connectionId: string;
  label: string;
  message: string;
  locked: boolean;
}

export interface ErrorIssuePage {
  issues: ErrorIssueSummary[];
  /** Opaque; pass back as `cursor` for more, or null when there is no more. */
  nextCursor: string | null;
  /** Connections that failed while others answered. */
  failures: ErrorSourceFailure[];
  fetchedAt: number;
}

/** Addresses one issue at one connection. */
export interface ErrorIssueRef {
  connectionId: string;
  issueId: string;
}

export interface ErrorIssueDetail {
  issue: ErrorIssueSummary;
  /** The latest event, or null when the provider has none to show. */
  event: ErrorEvent | null;
  /** Whether resolve and ignore can be offered. */
  canWrite: boolean;
}

export interface ErrorStatusChange extends ErrorIssueRef {
  status: ErrorIssueStatus;
  /** For `ignored`: minutes until it comes back, or none for good. */
  ignoreMinutes?: number | null;
}

/** Main to renderer: connections, links or issues changed. */
export interface ErrorTrackingChangedEvent {
  reason: 'connections' | 'links' | 'issues';
}

export type { RemoteOrganization, RemoteProject };

/** The two texts an issue turns into: the prompt for an agent and the plain copy. */
export interface ErrorIssuePrompt {
  prompt: string;
  copy: string;
}
