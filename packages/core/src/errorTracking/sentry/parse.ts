import { z } from 'zod';
import { redactErrorText, redactRequestUrl } from '../redact.js';
import {
  type ErrorBreadcrumb,
  type ErrorEvent,
  type ErrorException,
  type ErrorFrame,
  type ErrorIssue,
  type ErrorIssueStatus,
  type ErrorLevel,
  type ErrorRequest,
  type ErrorTag,
  MAX_BREADCRUMBS,
  type RemoteOrganization,
  type RemoteProject,
} from '../types.js';

/**
 * Sentry's JSON to the neutral types. Lenient: a malformed entry is dropped, not fatal. Every
 * string kept is redacted here, so nothing downstream sees a raw header, cookie, email or IP.
 *
 * What is never read at all: request headers, cookies, body and environment, frame `vars`, and
 * every user field but the id. The schemas leave them out, so they cannot leak by accident.
 */

const MAX_TITLE = 1_000;
const MAX_VALUE = 4_000;
const MAX_LINE = 500;
const MAX_CRUMB = 1_000;
const MAX_SHORT = 200;

function clean(value: string, max: number): string {
  const redacted = redactErrorText(value);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)} (trimmed)`;
}

/** A string, or null for anything else (missing, wrong type). */
const optionalText = z.string().nullish().catch(null);
/** Sentry ids are strings, GlitchTip and older payloads sometimes send numbers. */
const id = z.union([z.string().min(1), z.number()]).transform(String);
const optionalId = id.nullish().catch(null);
const optionalNumber = z.number().nullish().catch(null);
/** `count` arrives as a string, `userCount` as a number; either may be missing. */
const countValue = z.union([z.string(), z.number()]).nullish().catch(null);
const looseObject = z.record(z.string(), z.unknown()).nullish().catch(null);
const looseArray = z.array(z.unknown()).nullish().catch(null);

function toCount(value: string | number | null | undefined): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function list<T>(raw: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parse).filter((entry): entry is T => entry !== null);
}

// Issues

const LEVELS = new Map<string, ErrorLevel>([
  ['fatal', 'fatal'],
  ['error', 'error'],
  ['warning', 'warning'],
  ['warn', 'warning'],
  ['info', 'info'],
  ['debug', 'debug'],
]);

const STATUSES = new Map<string, ErrorIssueStatus>([
  ['resolved', 'resolved'],
  ['resolvedInNextRelease', 'resolved'],
  ['resolved_in_next_release', 'resolved'],
  ['ignored', 'ignored'],
  ['muted', 'ignored'],
  ['archived', 'ignored'],
]);

/** Sentry's newer "archived" states are sent as `unresolved` with an `archived_*` substatus. */
function statusOf(status: string | null | undefined, substatus: string | null | undefined) {
  if (substatus?.startsWith('archived')) return 'ignored';
  return STATUSES.get(status ?? '') ?? 'unresolved';
}

/** Events per bucket from `stats`: the 24h series, else 14d, else whichever period is there. */
function trendOf(stats: Record<string, unknown> | null | undefined): number[] {
  if (!stats) return [];
  const key = ['24h', '14d'].find((period) => period in stats) ?? Object.keys(stats)[0];
  const series = key === undefined ? null : stats[key];
  if (!Array.isArray(series)) return [];
  return series.flatMap((point) =>
    Array.isArray(point) && typeof point[1] === 'number' ? [point[1]] : [],
  );
}

const issueSchema = z.object({
  id,
  shortId: z.string(),
  title: z.string(),
  culprit: optionalText,
  level: optionalText,
  status: optionalText,
  substatus: optionalText,
  count: countValue,
  userCount: countValue,
  firstSeen: optionalText,
  lastSeen: optionalText,
  permalink: optionalText,
  project: z.object({ id: optionalId, slug: optionalText }).nullish().catch(null),
  stats: looseObject,
});

export function parseSentryIssue(raw: unknown): ErrorIssue | null {
  const parsed = issueSchema.safeParse(raw);
  if (!parsed.success) return null;
  const issue = parsed.data;
  return {
    id: issue.id,
    shortId: clean(issue.shortId, MAX_SHORT),
    title: clean(issue.title, MAX_TITLE),
    culprit: clean(issue.culprit ?? '', MAX_TITLE),
    level: LEVELS.get(issue.level ?? '') ?? 'error',
    status: statusOf(issue.status, issue.substatus),
    count: toCount(issue.count),
    userCount: toCount(issue.userCount),
    firstSeen: issue.firstSeen ?? '',
    lastSeen: issue.lastSeen ?? '',
    permalink: clean(issue.permalink ?? '', MAX_LINE),
    remoteProjectId: issue.project?.id ?? '',
    remoteProjectSlug: issue.project?.slug ?? '',
    trend: trendOf(issue.stats),
  };
}

/** A list response; anything that is not an array reads as empty. */
export function parseSentryIssues(raw: unknown): ErrorIssue[] {
  return list(raw, parseSentryIssue);
}

// Events

const contextLine = z.tuple([z.number(), z.string()]);

const frameSchema = z.object({
  filename: optionalText,
  absPath: optionalText,
  module: optionalText,
  function: optionalText,
  lineNo: optionalNumber,
  colNo: optionalNumber,
  inApp: z.boolean().nullish().catch(null),
  context: looseArray,
});

function parseFrame(raw: unknown): ErrorFrame | null {
  const parsed = frameSchema.safeParse(raw);
  if (!parsed.success) return null;
  const frame = parsed.data;
  const filename = frame.filename || frame.absPath || frame.module;
  if (!filename) return null;
  return {
    filename: clean(filename, MAX_LINE),
    function: frame.function ? clean(frame.function, MAX_LINE) : null,
    module: frame.module ? clean(frame.module, MAX_LINE) : null,
    lineNo: frame.lineNo ?? null,
    colNo: frame.colNo ?? null,
    inApp: frame.inApp === true,
    context: list(frame.context, (entry) => {
      const line = contextLine.safeParse(entry);
      return line.success ? [line.data[0], clean(line.data[1], MAX_LINE)] : null;
    }),
  };
}

const exceptionSchema = z.object({
  type: optionalText,
  value: optionalText,
  module: optionalText,
  mechanism: z
    .object({ handled: z.boolean().nullish().catch(null) })
    .nullish()
    .catch(null),
  stacktrace: z.object({ frames: looseArray }).nullish().catch(null),
});

function parseException(raw: unknown): ErrorException | null {
  const parsed = exceptionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const exception = parsed.data;
  if (!exception.type && !exception.value) return null;
  return {
    type: clean(exception.type || 'Error', MAX_TITLE),
    value: clean(exception.value ?? '', MAX_VALUE),
    module: exception.module ? clean(exception.module, MAX_LINE) : null,
    handled: exception.mechanism?.handled ?? null,
    frames: list(exception.stacktrace?.frames, parseFrame),
  };
}

const breadcrumbSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).nullish().catch(null),
  category: optionalText,
  level: optionalText,
  message: optionalText,
  data: looseObject,
});

/** Sentry sends ISO strings, the SDKs' raw crumbs seconds since the epoch. */
function crumbTime(value: string | number | null | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number') return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A short line for a crumb with no message: `GET /api/cart 200`, `/cart -> /pay`, `key=value`. */
function crumbSummary(data: Record<string, unknown> | null | undefined): string {
  if (!data) return '';
  if (typeof data.url === 'string') {
    const method = typeof data.method === 'string' ? redactErrorText(data.method) : null;
    const status = typeof data.status_code === 'number' ? String(data.status_code) : null;
    return [method, redactRequestUrl(data.url), status].filter(Boolean).join(' ');
  }
  if (typeof data.from === 'string' && typeof data.to === 'string') {
    return redactErrorText(`${data.from} -> ${data.to}`);
  }
  const pairs = Object.entries(data).filter(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value),
  );
  return redactErrorText(pairs.map(([key, value]) => `${key}=${String(value)}`).join(' '));
}

function parseBreadcrumb(raw: unknown): ErrorBreadcrumb | null {
  const parsed = breadcrumbSchema.safeParse(raw);
  if (!parsed.success) return null;
  const crumb = parsed.data;
  const message = crumb.message ? redactErrorText(crumb.message) : crumbSummary(crumb.data);
  if (!message) return null;
  return {
    timestamp: crumbTime(crumb.timestamp),
    category: crumb.category ? clean(crumb.category, MAX_SHORT) : null,
    level: crumb.level ? clean(crumb.level, MAX_SHORT) : null,
    message: message.length <= MAX_CRUMB ? message : `${message.slice(0, MAX_CRUMB)} (trimmed)`,
  };
}

const requestSchema = z.object({ method: optionalText, url: z.string().min(1) });

function parseRequest(raw: unknown): ErrorRequest | null {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    method: parsed.data.method ? clean(parsed.data.method, MAX_SHORT) : null,
    url: redactRequestUrl(parsed.data.url),
  };
}

const tagSchema = z.union([
  z.object({ key: z.string().min(1), value: z.string() }),
  z.tuple([z.string().min(1), z.string()]).transform(([key, value]) => ({ key, value })),
]);

/** The user tags (`user`, `user.email`, `user.ip`) are dropped whole; the id is kept apart. */
function parseTag(raw: unknown): ErrorTag | null {
  const parsed = tagSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { key, value } = parsed.data;
  if (key === 'user' || key.startsWith('user.')) return null;
  return { key: clean(key, MAX_SHORT), value: clean(value, MAX_LINE) };
}

const entrySchema = z.object({ type: z.string(), data: z.unknown() });

const eventSchema = z.object({
  eventID: optionalId,
  id: optionalId,
  dateCreated: optionalText,
  platform: optionalText,
  message: optionalText,
  entries: looseArray,
  tags: looseArray,
  user: z.object({ id: optionalId }).nullish().catch(null),
  release: z
    .union([z.string(), z.object({ version: optionalText })])
    .nullish()
    .catch(null),
});

export function parseSentryEvent(raw: unknown): ErrorEvent | null {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;
  const eventId = event.eventID ?? event.id;
  if (!eventId) return null;

  const entries = list(event.entries, (entry) => {
    const parsedEntry = entrySchema.safeParse(entry);
    return parsedEntry.success ? parsedEntry.data : null;
  });
  const entryData = (type: string) => entries.filter((entry) => entry.type === type);
  const values = (type: string) =>
    entryData(type).flatMap((entry) => {
      const data = looseObject.parse(entry.data);
      return Array.isArray(data?.values) ? data.values : [];
    });

  const tags = list(event.tags, parseTag);
  const tag = (key: string) => tags.find((entry) => entry.key === key)?.value ?? null;
  const release =
    typeof event.release === 'string' ? event.release : (event.release?.version ?? null);

  const entryMessage = entryData('message')
    .map((entry) => looseObject.parse(entry.data))
    .map((data) => data?.formatted ?? data?.message)
    .find((text): text is string => typeof text === 'string' && text.length > 0);
  const message = event.message || entryMessage;

  return {
    eventId,
    dateCreated: event.dateCreated ?? '',
    platform: event.platform ?? null,
    message: message ? clean(message, MAX_VALUE) : null,
    exceptions: list(values('exception'), parseException),
    breadcrumbs: list(values('breadcrumbs'), parseBreadcrumb).slice(-MAX_BREADCRUMBS),
    request: entryData('request').map((entry) => parseRequest(entry.data))[0] ?? null,
    tags,
    environment: tag('environment'),
    release: tag('release') ?? (release ? clean(release, MAX_SHORT) : null),
    userId: event.user?.id ? clean(event.user.id, MAX_SHORT) : null,
  };
}

// Organizations, projects, environments

const organizationSchema = z.object({
  slug: z.string().min(1),
  name: optionalText,
  links: z.object({ regionUrl: optionalText }).nullish().catch(null),
});

export function parseSentryOrganizations(raw: unknown): RemoteOrganization[] {
  return list(raw, (entry) => {
    const parsed = organizationSchema.safeParse(entry);
    if (!parsed.success) return null;
    const { slug, name, links } = parsed.data;
    return { slug, name: clean(name || slug, MAX_SHORT), regionUrl: links?.regionUrl || null };
  });
}

const projectSchema = z.object({
  id,
  slug: z.string().min(1),
  name: optionalText,
  platform: optionalText,
});

export function parseSentryProjects(raw: unknown): RemoteProject[] {
  return list(raw, (entry) => {
    const parsed = projectSchema.safeParse(entry);
    if (!parsed.success) return null;
    const { id: projectId, slug, name, platform } = parsed.data;
    return {
      id: projectId,
      slug,
      name: clean(name || slug, MAX_SHORT),
      platform: platform ?? null,
    };
  });
}

const environmentSchema = z.object({
  name: z.string().min(1),
  isHidden: z.boolean().nullish().catch(null),
});

/** Environment names, without hidden ones. */
export function parseSentryEnvironments(raw: unknown): string[] {
  return list(raw, (entry) => {
    const parsed = environmentSchema.safeParse(entry);
    return parsed.success && parsed.data.isHidden !== true ? parsed.data.name : null;
  });
}
