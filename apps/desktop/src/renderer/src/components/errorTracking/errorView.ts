import {
  type ErrorIssueStatus,
  type ErrorLevel,
  type ErrorPeriod,
  type Project,
  SENTRY_READ_SCOPES,
  SENTRY_WRITE_SCOPE,
} from '@agentmat/core';
import type {
  ErrorIssuePage,
  ErrorIssueRef,
  ErrorIssueSort,
  ErrorIssueSummary,
  ErrorSourceFailure,
  ErrorStatusFilter,
  ErrorTokenCheck,
} from '@shared/errorTrackingTypes';
import type { ChipTone } from '@/components/pageKit';

/**
 * The Errors tab's pure parts (E24): labels, colours and the small reshapes the list and the
 * optimistic status changes need, kept out of the components so they are tested on their own.
 */

export const LEVEL_META: Record<
  ErrorLevel,
  { label: string; tone: ChipTone; stripe: string; text: string }
> = {
  fatal: {
    label: 'Fatal',
    tone: 'destructive',
    stripe: 'bg-destructive shadow-[0_0_10px_hsl(var(--destructive)/0.65)]',
    text: 'text-destructive',
  },
  error: {
    label: 'Error',
    tone: 'destructive',
    stripe: 'bg-destructive/80',
    text: 'text-destructive',
  },
  warning: { label: 'Warning', tone: 'warning', stripe: 'bg-warning/85', text: 'text-warning' },
  info: { label: 'Info', tone: 'primary', stripe: 'bg-primary/70', text: 'text-primary' },
  debug: {
    label: 'Debug',
    tone: 'neutral',
    stripe: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
  },
};

export const STATUS_LABEL: Record<ErrorIssueStatus, string> = {
  unresolved: 'Unresolved',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

export const STATUS_ITEMS: { value: ErrorStatusFilter; label: string }[] = [
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'all', label: 'All' },
];

export const PERIOD_ITEMS: { value: ErrorPeriod; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '14d', label: '14d' },
];

export const SORT_OPTIONS: { value: ErrorIssueSort; label: string }[] = [
  { value: 'lastSeen', label: 'Last seen' },
  { value: 'events', label: 'Most events' },
  { value: 'users', label: 'Most users' },
  { value: 'newest', label: 'Newest' },
];

/** What the list asks for before the user touches a filter, shared with the tab's count. */
export const DEFAULT_STATUS: ErrorStatusFilter = 'unresolved';
export const DEFAULT_PERIOD: ErrorPeriod = '14d';
export const DEFAULT_SORT: ErrorIssueSort = 'lastSeen';

/** 87, 1.2k, 18k, 2.5M: an event or user count that fits a narrow column. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? Number(k.toFixed(1)) : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? Number(m.toFixed(1)) : Math.round(m)}M`;
}

/** The newest `bars` buckets of a trend, padded with zeros on the left. */
export function sparklineBars(trend: readonly number[], bars = 24): number[] {
  const shown = trend.slice(-bars);
  return [...Array.from({ length: bars - shown.length }, () => 0), ...shown];
}

/** The `?issue=` value for one issue. */
export function issueParam(ref: ErrorIssueRef): string {
  return `${ref.connectionId}:${ref.issueId}`;
}

export function parseIssueParam(value: string | null): ErrorIssueRef | null {
  if (!value) return null;
  // Issue ids are numbers, so the last colon is the separator even if a connection id had one.
  const at = value.lastIndexOf(':');
  if (at <= 0 || at === value.length - 1) return null;
  return { connectionId: value.slice(0, at), issueId: value.slice(at + 1) };
}

export function sameIssue(one: ErrorIssueSummary, ref: ErrorIssueRef): boolean {
  return one.connectionId === ref.connectionId && one.id === ref.issueId;
}

export interface IssueProjectGroup {
  projectId: string;
  projectName: string;
  issues: ErrorIssueSummary[];
}

/** The global page's sections: one per AgentMate project, in name order. */
export function groupIssuesByProject(
  issues: readonly ErrorIssueSummary[],
  projects: readonly Project[],
): IssueProjectGroup[] {
  const names = new Map(projects.map((one) => [one.id, one.name]));
  const groups = new Map<string, IssueProjectGroup>();
  for (const one of issues) {
    let group = groups.get(one.projectId);
    if (!group) {
      group = {
        projectId: one.projectId,
        // The main process sends '' for a provider project no AgentMate project is linked to.
        projectName:
          names.get(one.projectId) ??
          (one.projectId ? 'Unknown project' : 'Not linked to a project'),
        issues: [],
      };
      groups.set(one.projectId, group);
    }
    group.issues.push(one);
  }
  return [...groups.values()].sort((a, b) => {
    // A project that was deleted goes last rather than among the real names.
    const aKnown = names.has(a.projectId);
    const bKnown = names.has(b.projectId);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return a.projectName.localeCompare(b.projectName);
  });
}

/** Every loaded page as one list. A cursor can hand back an issue twice when issues move. */
export function mergeIssuePages(pages: readonly ErrorIssuePage[]): {
  issues: ErrorIssueSummary[];
  failures: ErrorSourceFailure[];
} {
  const seen = new Set<string>();
  const issues: ErrorIssueSummary[] = [];
  const failures = new Map<string, ErrorSourceFailure>();
  for (const one of pages) {
    for (const item of one.issues) {
      const key = `${item.connectionId}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(item);
    }
    for (const failure of one.failures) failures.set(failure.connectionId, failure);
  }
  return { issues, failures: [...failures.values()] };
}

/**
 * A page as it looks once an issue's status changed: gone from a list filtered to another status,
 * changed in place on the All list. The same object comes back when the issue is not on it.
 */
export function applyIssueStatus(
  current: ErrorIssuePage,
  ref: ErrorIssueRef,
  status: ErrorIssueStatus,
  filter: ErrorStatusFilter,
): ErrorIssuePage {
  if (!current.issues.some((one) => sameIssue(one, ref))) return current;
  const issues =
    filter === 'all' || filter === status
      ? current.issues.map((one) => (sameIssue(one, ref) ? { ...one, status } : one))
      : current.issues.filter((one) => !sameIssue(one, ref));
  return { ...current, issues };
}

const SENTRY_TOKEN_PATH = '/settings/account/api/auth-tokens/';

/** Where the user makes a personal auth token on the host they picked. */
export function tokenPageUrl(host: string): string {
  try {
    const url = new URL(host);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not web');
    return `${url.origin}${SENTRY_TOKEN_PATH}`;
  } catch {
    return `https://sentry.io${SENTRY_TOKEN_PATH}`;
  }
}

/** The scopes the token page asks for, as the copy button puts them on the clipboard. */
export const SCOPE_LIST_TEXT = [...SENTRY_READ_SCOPES, SENTRY_WRITE_SCOPE].join(', ');

export interface ScopeRow {
  scope: string;
  state: 'granted' | 'missing' | 'unknown';
  /** Only resolve and ignore need it. */
  optional: boolean;
}

/** The checklist a checked token shows: every read scope, then the optional write one. */
export function scopeChecklist(check: ErrorTokenCheck): ScopeRow[] {
  const known = check.scopes !== null;
  const read = SENTRY_READ_SCOPES.map(
    (scope): ScopeRow => ({
      scope,
      state: !known ? 'unknown' : check.missingScopes.includes(scope) ? 'missing' : 'granted',
      optional: false,
    }),
  );
  const write: ScopeRow = {
    scope: SENTRY_WRITE_SCOPE,
    state:
      check.canWrite === null || !known
        ? 'unknown'
        : check.canWrite || check.scopes?.includes(SENTRY_WRITE_SCOPE)
          ? 'granted'
          : 'missing',
    optional: true,
  };
  return [...read, write];
}
