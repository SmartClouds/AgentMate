import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FABLE_WEEK_LABEL,
  metersFableWeekly,
  type SubscriptionPlan,
  type SubscriptionWindow,
  type UsageAccountMode,
} from '@runova/core';

// Claude Code account detection. Two questions to answer before the Usage card
// can show anything subscription-shaped:
//
//   1. Is this account on a subscription, or billing an API key? Subscription
//      users care about "how much of my 5-hour window is left"; API users care
//      about tokens and dollars, which the existing card already shows.
//   2. Which plan, so the window labels and the local estimate's budgets match.
//
// Both come off disk with no network: `~/.claude/.credentials.json` holds the
// OAuth grant and `~/.claude.json` holds the account profile the CLI caches.
// Only the profile is a live answer to question 2. The credentials file records
// `subscriptionType` once, at login, and leaves it there, so it's the fallback.

const CLAUDE_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Every credential file location the CLI might have written, best first. */
function credentialPaths(): string[] {
  const paths: string[] = [];
  const override = process.env[CLAUDE_DIR_ENV];
  if (override) paths.push(join(override, '.credentials.json'));
  paths.push(join(homedir(), '.claude', '.credentials.json'));
  paths.push(join(homedir(), '.config', 'claude', '.credentials.json'));
  return paths;
}

function profilePaths(): string[] {
  const paths: string[] = [];
  const override = process.env[CLAUDE_DIR_ENV];
  if (override) paths.push(join(override, '.claude.json'));
  paths.push(join(homedir(), '.claude.json'));
  paths.push(join(homedir(), '.config', 'claude', '.claude.json'));
  return paths;
}

async function readJson<T>(paths: string[]): Promise<T | null> {
  for (const path of paths) {
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as T;
    } catch {
      continue; // missing, unreadable, or malformed, try the next location
    }
  }
  return null;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface ProfileFile {
  oauthAccount?: {
    billingType?: string;
    organizationName?: string;
    seatTier?: string;
    /** Plan family as the account service reports it: 'claude_max', 'claude_pro'. */
    organizationType?: string;
    /** Tier the org's limits come from: 'default_claude_max_5x', 'default_claude_ai'. */
    organizationRateLimitTier?: string;
    /** Set when the member's own tier overrides the org's. Usually null. */
    userRateLimitTier?: string;
  };
  /** ISO date of the account's very first Claude Code token. */
  claudeCodeFirstTokenDate?: string;
  hasAvailableSubscription?: boolean;
}

export interface ClaudeAccount {
  mode: UsageAccountMode;
  plan: SubscriptionPlan | null;
  /** OAuth bearer for the live quota fetch. Never leaves the main process. */
  accessToken: string | null;
  /** True when the stored grant has expired and needs a CLI re-login. */
  tokenExpired: boolean;
  /**
   * Epoch ms of first-ever usage. The weekly estimate phases its window off
   * this, so the boundary has to be a date that never moves. Unlike the oldest
   * surviving log entry, that one walks forward as transcripts age out.
   */
  weeklyAnchor: number | null;
}

/**
 * Drop the decoration the account service puts on plan and tier strings so both
 * can be matched against one vocabulary: 'claude_max' and 'default_claude_max_5x'
 * both reduce to something starting with 'max'.
 */
function stripPlanPrefix(raw?: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^default_/, '')
    .replace(/^claude_/, '');
}

/**
 * Anthropic renamed the Max tiers: Max 5x is now "Max" and Max 20x is now "Ultra". The account
 * service still reports the old multipliers ('default_claude_max_20x'), and the usage estimate and
 * the rank below key off them, so the ids stay and only the label the user sees changes.
 */
const MAX_PLAN = (): SubscriptionPlan => ({ id: 'max5x', label: 'Max' });
const ULTRA_PLAN = (): SubscriptionPlan => ({ id: 'max20x', label: 'Ultra' });

/** Higher wins when login-time credentials and the live profile disagree. */
function planRank(plan: SubscriptionPlan): number {
  const id = plan.id.trim().toLowerCase();
  if (id === 'max20x' || id.includes('20x')) return 40;
  if (id === 'max5x' || id.includes('5x')) return 30;
  if (id.startsWith('max') || id === 'enterprise') return 25;
  if (id === 'team') return 20;
  if (id === 'pro') return 10;
  return 5;
}

function pickHighestPlan(
  plans: Array<SubscriptionPlan | null | undefined>,
): SubscriptionPlan | null {
  let best: SubscriptionPlan | null = null;
  for (const plan of plans) {
    if (!plan) continue;
    if (!best || planRank(plan) > planRank(best)) best = plan;
  }
  return best;
}

/**
 * The rate-limit tier is the plan whose limits actually apply. It survives as
 * `default_claude_max_5x` even when `subscriptionType` is still the 'pro' that
 * was written at first login, and even when `organizationType` is missing.
 */
function resolvePlanFromTier(rateLimitTier?: string | null): SubscriptionPlan | null {
  const tier = stripPlanPrefix(rateLimitTier ?? undefined);
  if (!tier) return null;
  if (tier.includes('20x') || tier.startsWith('ultra')) return ULTRA_PLAN();
  if (tier.includes('5x')) return MAX_PLAN();
  if (tier.startsWith('max')) return { id: 'max', label: 'Max' };
  if (tier === 'team' || tier.startsWith('team')) return { id: 'team', label: 'Team' };
  if (tier === 'enterprise' || tier.startsWith('enterprise')) {
    return { id: 'enterprise', label: 'Enterprise' };
  }
  // `default_claude_ai` strips down to 'ai'; that's Pro's rate-limit bucket.
  if (tier === 'ai' || tier === 'pro' || tier.startsWith('pro')) return { id: 'pro', label: 'Pro' };
  return null;
}

/**
 * Turn a plan-family string + a rate-limit tier into a display plan. The tier is
 * what distinguishes the Max levels ('…max_5x' / '…max_20x'); an unrecognized
 * family still yields a capitalized label rather than nothing, so a new plan name
 * shows up as itself instead of disappearing.
 */
function resolvePlan(subscriptionType?: string, rateLimitTier?: string): SubscriptionPlan | null {
  const type = stripPlanPrefix(subscriptionType);
  const fromTier = resolvePlanFromTier(rateLimitTier);
  if (!type) return fromTier;

  if (type.startsWith('ultra')) return ULTRA_PLAN();
  if (type.startsWith('max')) {
    // The multiplier lives in either field depending on CLI version.
    const source = `${type} ${stripPlanPrefix(rateLimitTier)}`;
    if (source.includes('20x')) return ULTRA_PLAN();
    if (source.includes('5x')) return MAX_PLAN();
    return fromTier?.id.startsWith('max') ? fromTier : { id: 'max', label: 'Max' };
  }
  if (type === 'pro') {
    // Stale credentials keep saying Pro after an upgrade; the tier is current.
    if (fromTier && planRank(fromTier) > planRank({ id: 'pro', label: 'Pro' })) return fromTier;
    return { id: 'pro', label: 'Pro' };
  }
  if (type === 'team') return { id: 'team', label: 'Team' };
  if (type === 'enterprise') return { id: 'enterprise', label: 'Enterprise' };
  return pickHighestPlan([
    fromTier,
    { id: type, label: type.charAt(0).toUpperCase() + type.slice(1) },
  ]);
}

const KNOWN_PLAN_IDS = new Set(['pro', 'max', 'max5x', 'max20x', 'team', 'enterprise']);

/**
 * Same as {@link resolvePlan} but refuses to guess. The profile's fields carry
 * values that aren't plan names at all ('default_claude_ai'), and capitalizing
 * one of those into a label would read as a plan the user has never heard of, so
 * anything unrecognized falls through to the next source instead.
 */
function resolveKnownPlan(
  subscriptionType?: string,
  rateLimitTier?: string,
): SubscriptionPlan | null {
  const plan = resolvePlan(subscriptionType, rateLimitTier);
  return plan && KNOWN_PLAN_IDS.has(plan.id) ? plan : null;
}

/** True when the CLI is configured to bill an API key / cloud vendor instead. */
function hasApiKeyBilling(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX,
  );
}

/**
 * Read the local Claude Code account state. An OAuth grant wins over an API key
 * because the CLI itself prefers it when both are present, so the card matches
 * what the user is actually being billed under.
 */
export async function readClaudeAccount(): Promise<ClaudeAccount> {
  const creds = await readJson<CredentialsFile>(credentialPaths());
  const profile = await readJson<ProfileFile>(profilePaths());
  const firstToken = profile?.claudeCodeFirstTokenDate
    ? Date.parse(profile.claudeCodeFirstTokenDate)
    : NaN;
  const weeklyAnchor = Number.isNaN(firstToken) ? null : firstToken;
  const oauth = creds?.claudeAiOauth;
  const account = profile?.oauthAccount;

  // Plan signals, highest capacity wins. Credentials are written once at login
  // and never refreshed, so after a Pro → Max upgrade they still say Pro.
  // The profile's org fields (and especially the rate-limit tier) are what the
  // CLI re-fetches, so they track the plan whose limits actually apply. Taking
  // the first non-null source used to let a leftover Pro seat/org string beat
  // a Max tier sitting next to it.
  const plan = pickHighestPlan([
    resolveKnownPlan(account?.seatTier, account?.userRateLimitTier ?? undefined),
    resolvePlanFromTier(account?.userRateLimitTier),
    resolveKnownPlan(
      account?.organizationType,
      account?.userRateLimitTier ?? account?.organizationRateLimitTier,
    ),
    resolvePlanFromTier(account?.organizationRateLimitTier),
    resolvePlan(oauth?.subscriptionType, oauth?.rateLimitTier),
    resolvePlanFromTier(oauth?.rateLimitTier),
  ]);

  if (!oauth?.subscriptionType && !plan) {
    return {
      mode: hasApiKeyBilling() ? 'api' : 'subscription',
      plan: null,
      accessToken: null,
      tokenExpired: false,
      weeklyAnchor,
    };
  }

  const expired = typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= Date.now();

  return {
    mode: 'subscription',
    plan,
    accessToken: expired ? null : (oauth?.accessToken ?? null),
    tokenExpired: expired,
    weeklyAnchor,
  };
}

// --- live quota fetch -----------------------------------------------------

// The CLI's own `/usage` reads the account's unified rate limits, keyed by
// window: a 5-hour session bucket, a rolling 7-day bucket, and (above Pro) a
// separate 7-day bucket for the top model. The response shape isn't a published
// contract, so parsing is deliberately loose: we look for the known window keys
// anywhere in the payload and accept any of the spellings seen in the wild
// rather than binding to one exact schema.

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 8_000;
// Anthropic keys this endpoint's rate-limit bucket off User-Agent. Node's
// default (and Electron's) lands in a bucket that 429s, especially on Max,
// so the card falls back to the local estimate and Max looks like Pro. The
// CLI's own /usage sends this prefix; anything else is treated as a scraper.
const USAGE_USER_AGENT = 'claude-code/2.1.80';

const WINDOW_LABELS: Record<string, { key: SubscriptionWindow['key']; label: string }> = {
  five_hour: { key: 'session', label: 'Session (5h)' },
  fivehour: { key: 'session', label: 'Session (5h)' },
  session: { key: 'session', label: 'Session (5h)' },
  seven_day: { key: 'week', label: 'Weekly' },
  sevenday: { key: 'week', label: 'Weekly' },
  week: { key: 'week', label: 'Weekly' },
  seven_day_fable: { key: 'week-fable', label: FABLE_WEEK_LABEL },
  sevendayfable: { key: 'week-fable', label: FABLE_WEEK_LABEL },
  week_fable: { key: 'week-fable', label: FABLE_WEEK_LABEL },
  // Same bucket, older spelling: it was the Opus-only weekly limit before Fable
  // took the top slot, and payloads in the wild still name it that way.
  seven_day_opus: { key: 'week-fable', label: FABLE_WEEK_LABEL },
  sevendayopus: { key: 'week-fable', label: FABLE_WEEK_LABEL },
  week_opus: { key: 'week-fable', label: FABLE_WEEK_LABEL },
};

/** Newer payloads list the same windows as a flat `limits` array instead. */
const LIMIT_KINDS: Record<string, SubscriptionWindow['key']> = {
  session: 'session',
  weekly_all: 'week',
  weekly_scoped: 'week-fable',
};

function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]/g, '_');
}

/** Pull a 0–100 utilization out of whichever field name the payload uses. */
function readPercent(node: Record<string, unknown>): number | null {
  for (const field of ['utilization', 'used_percent', 'usedPercent', 'percent', 'percent_used']) {
    const value = node[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Some payloads express utilization as a 0–1 fraction.
      const percent = value > 0 && value <= 1 ? value * 100 : value;
      return Math.max(0, Math.min(100, percent));
    }
  }
  return null;
}

/** Pull a reset timestamp, accepting both ISO strings and unix seconds. */
function readResetAt(node: Record<string, unknown>): string | null {
  for (const field of ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'expires_at']) {
    const value = node[field];
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Seconds vs milliseconds: anything below ~year 2300 in ms is seconds.
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
  }
  return null;
}

/**
 * Label for a `limits` entry. The scoped weekly window names the model it meters,
 * so read it off the payload rather than hardcoding today's top model, and fall
 * back to the constant when the scope is missing.
 */
function limitLabel(key: SubscriptionWindow['key'], node: Record<string, unknown>): string {
  if (key !== 'week-fable') return key === 'session' ? 'Session (5h)' : 'Weekly';
  const scope = node.scope as { model?: { display_name?: unknown } } | null | undefined;
  const model = scope?.model?.display_name;
  return typeof model === 'string' && model.trim() ? `Weekly (${model.trim()})` : FABLE_WEEK_LABEL;
}

/**
 * Walk the payload for objects sitting under a known window key that carry a
 * utilization number. Depth-limited so a surprising response can't send us
 * spelunking through a huge object graph.
 *
 * `fableWeek` still hides a zeroed Fable bucket on Pro (the endpoint has been
 * seen echoing one). A bucket with real utilization is kept even when the
 * local plan guess is Pro, because that guess is often stale credentials.
 */
function collectWindows(payload: unknown, fableWeek: boolean): SubscriptionWindow[] {
  const found = new Map<string, SubscriptionWindow>();

  function visit(node: unknown, depth: number): void {
    if (depth > 5 || node === null || typeof node !== 'object') return;
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      const match = WINDOW_LABELS[normalizeKey(rawKey)];
      const percent = match ? readPercent(value as Record<string, unknown>) : null;
      if (match && percent !== null && !found.has(match.key)) {
        found.set(match.key, {
          key: match.key,
          label: match.label,
          percent,
          resetAt: readResetAt(value as Record<string, unknown>),
        });
      }
      visit(value, depth + 1);
    }
  }

  visit(payload, 0);

  // Second pass over `limits`, filling only what the keys didn't cover. The
  // scoped weekly window lives here and nowhere else: the top-level bucket that
  // used to carry it (`seven_day_opus`) now comes back null, so without this the
  // Fable bar would never appear for a plan that has one.
  const limits = (payload as { limits?: unknown } | null)?.limits;
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (entry === null || typeof entry !== 'object') continue;
      const node = entry as Record<string, unknown>;
      const key = typeof node.kind === 'string' ? LIMIT_KINDS[normalizeKey(node.kind)] : undefined;
      if (!key || found.has(key)) continue;
      const percent = readPercent(node);
      if (percent === null) continue;
      found.set(key, { key, label: limitLabel(key, node), percent, resetAt: readResetAt(node) });
    }
  }

  // Stable display order regardless of the order the payload listed them in.
  const order: SubscriptionWindow['key'][] = ['session', 'week', 'week-fable'];
  return order.flatMap((key) => {
    const window = found.get(key);
    if (!window) return [];
    // Pro payloads have been seen echoing a zeroed Fable bucket. Hide that
    // empty row, but if the account actually used the bucket, the local plan
    // guess was wrong (stale Pro credentials after a Max upgrade) and the bar
    // should still show.
    if (key === 'week-fable' && !fableWeek && window.percent <= 0) return [];
    return [window];
  });
}

/** The account's windows and the ISO time the account reported them. */
export interface LiveWindows {
  windows: SubscriptionWindow[];
  readAt: string;
}

type LiveFetch =
  | { ok: true; windows: SubscriptionWindow[] }
  | { ok: false; rateLimited: boolean; retryAfterMs: number | null };

/** `Retry-After` in ms, from either of its two forms: seconds or an HTTP date. */
function parseRetryAfter(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Authoritative window state for the signed-in account, or a failure when it
 * can't be had (offline, expired grant, endpoint moved, rate limited). Never
 * throws: the caller falls back to the last reading or the local estimate.
 */
async function fetchLiveWindows(
  accessToken: string,
  plan: SubscriptionPlan | null,
): Promise<LiveFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': USAGE_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        rateLimited: res.status === 429,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
      };
    }
    const windows = collectWindows(await res.json(), metersFableWeekly(plan));
    return windows.length > 0
      ? { ok: true, windows }
      : { ok: false, rateLimited: false, retryAfterMs: null };
  } catch {
    return { ok: false, rateLimited: false, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

// Several widgets plus the Usage page all refresh independently, so an answer
// is held for a minute rather than fetched on every one of their ticks. A
// failure is not retried on every tick either, but how long it waits depends on
// why it failed: a timeout or a 5xx is worth trying again at the next poll,
// while a 429 means hammering makes it worse, so that one honours Retry-After
// and otherwise waits a good while.
const LIVE_TTL_OK_MS = 60_000;
const LIVE_TTL_FAIL_MS = 60_000;
const LIVE_TTL_RATE_LIMITED_MS = 300_000;
const LIVE_RETRY_AFTER_MAX_MS = 900_000;

interface LiveCache {
  at: number;
  /** The grant the answer belongs to. A new login or a refreshed grant is read straight away. */
  accessToken: string;
  live: LiveWindows | null;
  /** How long this entry may be reused, counted from `at`. */
  ttl: number;
}

let liveCache: LiveCache | null = null;

function failureTtl(result: Extract<LiveFetch, { ok: false }>): number {
  if (result.retryAfterMs !== null) {
    return Math.min(LIVE_RETRY_AFTER_MAX_MS, Math.max(LIVE_TTL_FAIL_MS, result.retryAfterMs));
  }
  return result.rateLimited ? LIVE_TTL_RATE_LIMITED_MS : LIVE_TTL_FAIL_MS;
}

/**
 * Cached wrapper around {@link fetchLiveWindows}. The windows come back with the
 * time the account reported them, which is earlier than now when the answer is
 * served from the cache.
 */
export async function getLiveWindows(
  accessToken: string,
  plan: SubscriptionPlan | null,
): Promise<LiveWindows | null> {
  const cached = liveCache;
  if (cached && cached.accessToken === accessToken && Date.now() - cached.at < cached.ttl) {
    return cached.live;
  }
  const result = await fetchLiveWindows(accessToken, plan);
  const at = Date.now();
  liveCache = result.ok
    ? {
        at,
        accessToken,
        live: { windows: result.windows, readAt: new Date(at).toISOString() },
        ttl: LIVE_TTL_OK_MS,
      }
    : { at, accessToken, live: null, ttl: failureTtl(result) };
  return liveCache.live;
}

/** Drop the cached quota so an explicit Refresh re-hits the account. */
export function clearLiveWindowCache(): void {
  liveCache = null;
}
