import {
  type ProviderUsage,
  type SubscriptionUsage,
  type SubscriptionWindow,
  type UsageWindow,
} from '@runova/core';
import {
  accumulate,
  buildCostSeries,
  buildSeries,
  type CursorEntry,
  type CursorUsageEvent,
  startOfLocalDay,
  toEntry,
} from './cursor';
import { getCursorAccount } from './cursorAccount';
import { type CursorPlanLimits, cursorPlanLimits } from './cursorSummary';
import { connectUsage, PartialUsageError } from './shared';

// Cursor usage read through the session the Cursor app already holds, so the
// card connects itself the way Claude Code's does instead of asking for a key.
//
// This replaces the Admin-API path as the default for a practical reason: that
// endpoint (`/teams/filtered-usage-events`) needs a *team* Admin key, which an
// individual Pro subscriber cannot issue at all. The dashboard endpoints below
// are what Cursor's own web UI calls, so they work for exactly the accounts the
// Admin API locks out. They are not a published contract, so every field is
// parsed defensively, same posture as the Claude quota fetch.
//
// Two endpoints, deliberately weighted differently:
//   /api/dashboard/get-filtered-usage-events  the per-call feed. Carries the
//     same event shape as the Admin API, so the Auto+Composer / API split, the
//     periods and the sparkline all reuse the parsing in `cursor.ts`.
//   /api/usage-summary                        a usage-based plan's limits:
//     the share of included usage spent this billing cycle (total, Auto, API).
//   /api/usage                                an older request-based plan's
//     request quota, the fallback when the summary has no limits.
// The limit endpoints only decorate the card with limit bars. When one fails the
// card keeps its tokens and says the limits are unknown, rather than hiding them.
// The feed is the card's substance. When it fails after the limits came back,
// they travel with the failure (see PartialUsageError), so nothing drops them.
//
// Cost comes from the events themselves (Cursor prices each call in `totalCents`),
// so no separate invoice call is needed.

const BASE_URL = 'https://cursor.com';
const TIMEOUT_MS = 10_000;

/** Cursor's dashboard authenticates with a "<userId>::<jwt>" cookie. */
function sessionCookie(userId: string, token: string): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
}

/** Why a call to Cursor failed. */
type CursorFailure = 'timeout' | 'unreachable' | 'rejected' | 'http' | 'unreadable';

/**
 * A failed call to Cursor, with the words a panel can show for it. `timeout` and `unreachable`
 * are the network failing, which is why no second attempt is made for either.
 */
export class CursorRequestError extends Error {
  readonly failure: CursorFailure;

  constructor(failure: CursorFailure, message: string) {
    super(message);
    this.name = 'CursorRequestError';
    this.failure = failure;
  }
}

async function request(path: string, cookie: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Only our own timer aborts this request, so an abort always means the wait ran out.
  const timedOut = (): CursorRequestError =>
    new CursorRequestError('timeout', 'Cursor did not answer in time.');
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
        headers: {
          Cookie: cookie,
          Accept: 'application/json',
          // Cursor CSRF-checks state-changing requests and answers a bare POST
          // with 403 "Invalid origin for state-changing request". Presenting the
          // dashboard's own origin is what makes the event feed readable at all.
          Origin: BASE_URL,
          Referer: `${BASE_URL}/dashboard`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw controller.signal.aborted
        ? timedOut()
        : new CursorRequestError('unreachable', 'Could not reach Cursor.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new CursorRequestError(
        'rejected',
        'Cursor session rejected. Sign in to the Cursor app again.',
      );
    }
    if (!res.ok) throw new CursorRequestError('http', `Cursor returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw controller.signal.aborted
        ? timedOut()
        : new CursorRequestError('unreadable', 'Cursor sent an answer Runova could not read.');
    }
  } finally {
    clearTimeout(timer);
  }
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const PAGE_SIZE = 1000;
/** Cap the paging loop. 30 days of heavy use, not an unbounded crawl. */
const MAX_PAGES = 20;

/**
 * Per-call usage events for the signed-in user. This is the dashboard's own
 * feed and carries the same event shape as the team Admin API, which is what
 * lets the Auto+Composer / API split be reused verbatim from {@link toEntry}.
 */
async function fetchEvents(cookie: string): Promise<CursorEntry[]> {
  const endDate = Date.now();
  const startDate = endDate - WINDOW_DAYS * DAY_MS;
  const entries: CursorEntry[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = (await request('/api/dashboard/get-filtered-usage-events', cookie, {
      startDate,
      endDate,
      page,
      pageSize: PAGE_SIZE,
    })) as {
      /** The dashboard feed's name for the rows; the Admin API says `usageEvents`. */
      usageEventsDisplay?: CursorUsageEvent[];
      usageEvents?: CursorUsageEvent[];
      totalUsageEventsCount?: number;
    };

    const events = Array.isArray(data?.usageEventsDisplay)
      ? data.usageEventsDisplay
      : Array.isArray(data?.usageEvents)
        ? data.usageEvents
        : [];
    for (const event of events) {
      const entry = toEntry(event);
      if (entry) entries.push(entry);
    }

    // This feed reports a grand total instead of a pagination block, so paging
    // is driven by how many rows we've actually taken.
    const total = data?.totalUsageEventsCount;
    const more = typeof total === 'number' ? page * PAGE_SIZE < total : false;
    if (!more || events.length === 0) break;
  }
  return entries;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** First present numeric field among `names`, accepting snake and camel case. */
function pick(node: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const direct = num(node[name]);
    if (direct != null) return direct;
    const snake = name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    const snakeVal = num(node[snake]);
    if (snakeVal != null) return snakeVal;
  }
  return null;
}

interface ModelBucket {
  requests: number;
  maxRequests: number | null;
  tokens: number;
}

/**
 * `/api/usage` answers with one object per model bucket plus a `startOfMonth`
 * marker, e.g. `{ "gpt-4": { numRequests, maxRequestUsage, numTokens }, … }`.
 * Rather than binding to today's bucket names, take any child object that
 * carries a request count, so new model buckets then count automatically.
 */
function collectBuckets(payload: unknown): { buckets: ModelBucket[]; startOfMonth: string | null } {
  const buckets: ModelBucket[] = [];
  let startOfMonth: string | null = null;

  if (payload === null || typeof payload !== 'object') return { buckets, startOfMonth };
  const root = payload as Record<string, unknown>;

  const rawStart = root.startOfMonth ?? root.start_of_month;
  if (typeof rawStart === 'string' && !Number.isNaN(Date.parse(rawStart))) {
    startOfMonth = new Date(rawStart).toISOString();
  }

  for (const value of Object.values(root)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const requests = pick(node, ['numRequests', 'numRequestsTotal']);
    const tokens = pick(node, ['numTokens']);
    if (requests == null && tokens == null) continue;
    buckets.push({
      requests: requests ?? 0,
      maxRequests: pick(node, ['maxRequestUsage']),
      tokens: tokens ?? 0,
    });
  }
  return { buckets, startOfMonth };
}

function monthResetAt(startOfMonth: string | null): string | null {
  const start = startOfMonth ? Date.parse(startOfMonth) : Date.now();
  if (Number.isNaN(start)) return null;
  const d = new Date(start);
  // Cursor's quota rolls on the subscription anniversary, one month from the
  // period start it reported.
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

/** The words a status bar panel or a card can show for a failed read. */
function describeError(error: unknown): string {
  return error instanceof CursorRequestError ? error.message : 'Could not read Cursor usage.';
}

/** True when the network itself failed, where asking Cursor a second question only costs a wait. */
function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof CursorRequestError &&
    (error.failure === 'timeout' || error.failure === 'unreachable')
  );
}

/** What the usage summary said: its limits, no limits, or a failure to ask. */
type PlanRead =
  | { kind: 'limits'; limits: CursorPlanLimits }
  | { kind: 'none' }
  | { kind: 'failed'; error: unknown };

/** Reads the usage summary. Never throws. */
async function readPlanLimits(cookie: string): Promise<PlanRead> {
  try {
    const limits = cursorPlanLimits(await request('/api/usage-summary', cookie));
    return limits ? { kind: 'limits', limits } : { kind: 'none' };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

interface RequestQuota {
  window: UsageWindow;
  windows: SubscriptionWindow[];
}

/**
 * An older request-based plan's monthly request quota, from `/api/usage`. Null when that endpoint
 * has no capped bucket to show, or cannot be read.
 */
async function readRequestQuota(cookie: string, userId: string): Promise<RequestQuota | null> {
  try {
    const payload = await request(`/api/usage?user=${encodeURIComponent(userId)}`, cookie);
    const { buckets, startOfMonth } = collectBuckets(payload);
    const requests = buckets.reduce((sum, b) => sum + b.requests, 0);
    // Only the plan bucket is capped; usage-based ones report no maximum.
    const maxRequests = buckets.reduce<number | null>(
      (max, b) => (b.maxRequests != null && b.maxRequests > (max ?? 0) ? b.maxRequests : max),
      null,
    );
    if (maxRequests == null || maxRequests <= 0) return null;
    const percent = Math.max(0, Math.min(100, (requests / maxRequests) * 100));
    const resetAt = monthResetAt(startOfMonth);
    return {
      window: { label: 'Requests', used: requests, total: maxRequests, percent, resetAt },
      windows: [{ key: 'month', label: 'Monthly requests', percent, resetAt }],
    };
  } catch {
    return null;
  }
}

/** The plan's limits, or the reason they are unknown. */
interface ResolvedLimits {
  /** False only when the limits could not be read, which is not the same as having none. */
  known: boolean;
  window?: UsageWindow;
  windows: SubscriptionWindow[];
  /** Why the limits are unknown, when they are. */
  error?: string;
}

/**
 * The plan's limits from the usage summary, falling back to the request quota where the summary
 * has nothing to show. A summary that answered with no limits means the plan has none. A summary
 * that failed leaves them unknown.
 */
async function resolveLimits(
  cookie: string,
  userId: string,
  plan: PlanRead,
): Promise<ResolvedLimits> {
  if (plan.kind === 'limits') {
    return { known: true, window: plan.limits.window, windows: [...plan.limits.windows] };
  }
  const quota =
    plan.kind === 'failed' && isNetworkFailure(plan.error)
      ? null
      : await readRequestQuota(cookie, userId);
  if (quota) return { known: true, window: quota.window, windows: quota.windows };
  if (plan.kind === 'none') return { known: true, windows: [] };
  return { known: false, windows: [], error: describeError(plan.error) };
}

/**
 * Live Cursor usage for the signed-in desktop app. Returns a `connect` snapshot,
 * not an error, when Cursor isn't installed or nobody is signed in, because
 * those are setup states the card already renders an action for.
 */
export async function fetchCursorSessionUsage(): Promise<ProviderUsage> {
  const account = getCursorAccount();
  if (!account.accessToken || !account.userId) return connectUsage('cursor');

  const cookie = sessionCookie(account.userId, account.accessToken);

  // The feed and the limits are read side by side, and neither result can hide the other. The feed
  // is wrapped so that it never rejects here, which keeps its failure from going unhandled while
  // the limits are still being read.
  const eventsRead = fetchEvents(cookie).then(
    (entries) => ({ ok: true as const, entries }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const plan = await readPlanLimits(cookie);
  const limits = await resolveLimits(cookie, account.userId, plan);
  const events = await eventsRead;
  const now = Date.now();

  // Known limits always come with a subscription, even without a plan name, so that they are
  // not dropped (F3) and so that an unlimited plan is never read as unknown.
  const subscription: SubscriptionUsage | undefined = limits.known
    ? { mode: 'subscription', plan: account.plan, windows: limits.windows, source: 'account' }
    : undefined;

  if (!events.ok) {
    const message = describeError(events.error);
    // With the limits unknown as well there is nothing to keep, so the read fails as a whole.
    if (!subscription) throw new Error(message);
    throw new PartialUsageError(message, { subscription, window: limits.window });
  }

  const usage: ProviderUsage = {
    providerId: 'cursor',
    status: 'ok',
    today: accumulate(events.entries, startOfLocalDay(now)),
    last7d: accumulate(events.entries, now - 7 * DAY_MS),
    last30d: accumulate(events.entries, now - WINDOW_DAYS * DAY_MS),
    window: limits.window,
    subscription,
    series: buildSeries(events.entries),
    costSeries: buildCostSeries(events.entries),
    currency: 'USD',
    updatedAt: new Date(now).toISOString(),
  };
  if (limits.error !== undefined) usage.limitsError = limits.error;
  return usage;
}
