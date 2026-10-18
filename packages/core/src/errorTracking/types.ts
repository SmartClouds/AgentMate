/**
 * Error tracking (E24): a project's errors as an error tracker such as Sentry records them, in a
 * shape that does not depend on the provider. The parsers turn a provider's JSON into these and
 * redact on the way in, so nothing here holds a header, a cookie, an email or an IP address.
 */

export type ErrorTrackingProvider = 'sentry';

export type ErrorLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

export type ErrorIssueStatus = 'unresolved' | 'resolved' | 'ignored';

/** One grouped error, as the issue list shows it. */
export interface ErrorIssue {
  /** The provider's issue id. */
  id: string;
  /** The readable id, such as `WEB-3F`. */
  shortId: string;
  title: string;
  /** Where it happened, usually a function or a route. */
  culprit: string;
  level: ErrorLevel;
  status: ErrorIssueStatus;
  /** Events in the issue's lifetime. */
  count: number;
  userCount: number;
  /** ISO 8601. */
  firstSeen: string;
  lastSeen: string;
  /** The issue's page at the provider. */
  permalink: string;
  /** The provider project the issue belongs to. */
  remoteProjectId: string;
  remoteProjectSlug: string;
  /** Events per bucket over the requested period, oldest first. Empty when the provider sent none. */
  trend: number[];
}

/** One frame of a stack trace. */
export interface ErrorFrame {
  /** The file as the app knows it, such as `src/routes/checkout.ts`. */
  filename: string;
  function: string | null;
  module: string | null;
  lineNo: number | null;
  colNo: number | null;
  /** True for the app's own code, false for libraries and the runtime. */
  inApp: boolean;
  /** Source lines around the frame, as `[lineNo, text]`, when the provider has them. */
  context: Array<[number, string]>;
}

/** One exception of a chain. The provider lists the cause first and the thrown one last. */
export interface ErrorException {
  type: string;
  value: string;
  module: string | null;
  /** Whether the app caught it, when the provider knows. */
  handled: boolean | null;
  /** Outermost call first, the throwing frame last, the way the providers send them. */
  frames: ErrorFrame[];
}

export interface ErrorBreadcrumb {
  /** ISO 8601, or null when the crumb had no time. */
  timestamp: string | null;
  category: string | null;
  level: string | null;
  message: string;
}

/** The request the error happened in, stripped to what helps and leaks nothing. */
export interface ErrorRequest {
  method: string | null;
  /** Scheme, host and path. Query values are masked, credentials and fragment dropped. */
  url: string;
}

export interface ErrorTag {
  key: string;
  value: string;
}

/** The latest event of an issue: what actually happened, once. */
export interface ErrorEvent {
  eventId: string;
  /** ISO 8601. */
  dateCreated: string;
  platform: string | null;
  /** A plain message event's text, when there is no exception. */
  message: string | null;
  /** Cause first, the thrown exception last. */
  exceptions: ErrorException[];
  /** The last breadcrumbs, oldest first, at most `MAX_BREADCRUMBS`. */
  breadcrumbs: ErrorBreadcrumb[];
  request: ErrorRequest | null;
  tags: ErrorTag[];
  environment: string | null;
  release: string | null;
  /** The user's id only. Never an email, a name or an address. */
  userId: string | null;
}

/** Breadcrumbs kept per event. */
export const MAX_BREADCRUMBS = 40;

/** Characters a fix prompt may hold, the same budget a failed pipeline gets. */
export const ERROR_PROMPT_CHAR_CAP = 12_000;

/** One page of a provider's Link header. */
export interface PageLinks {
  next: string | null;
  previous: string | null;
}

/** A provider project, for linking it to an AgentMate project. */
export interface RemoteProject {
  id: string;
  slug: string;
  name: string;
  platform: string | null;
}

/** An organization a token can see. */
export interface RemoteOrganization {
  slug: string;
  name: string;
  /** The host this organization's data is served from (a data region), when the provider says. */
  regionUrl: string | null;
}

/** A Sentry host the user typed, cleaned up. */
export interface SentryHost {
  /** `https://sentry.io`, `https://de.sentry.io` or a self-hosted base, with no trailing slash. */
  baseUrl: string;
  /** The org slug when the host is `<org>.sentry.io`. */
  orgSlugHint: string | null;
}

/** The scopes the issue list needs, and the one resolve and ignore need. */
export const SENTRY_READ_SCOPES = ['org:read', 'project:read', 'event:read'] as const;
export const SENTRY_WRITE_SCOPE = 'event:write';

/** What a project is matched against when suggesting which provider projects belong to it. */
export interface LinkCandidateProject {
  name: string;
  folderPath: string | null;
  repoUrl: string | null;
}

/** How far back the issue list looks. */
export type ErrorPeriod = '24h' | '7d' | '14d';
