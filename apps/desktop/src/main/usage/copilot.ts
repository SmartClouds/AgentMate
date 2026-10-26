import {
  COPILOT_LOG_FALLBACK_MODEL,
  emptyUsageTokens,
  estimateCost,
  type ProviderUsage,
  type UsagePeriod,
  type UsageProviderConfig,
  type UsageSegment,
  type UsageTokens,
} from '@runova/core';

export { parseCopilotUsageRecord } from './logParsers';

// GitHub Copilot usage from two sources. The local one reads the Copilot CLI's
// own JSONL session transcripts (see `parseCopilotUsageRecord` in logParsers.ts)
// and needs nothing from the user. The API one calls the org Copilot metrics
// endpoint, which reports per-day token breakdowns for chat, completions and
// the CLI, and needs a personal access token (with `manage_billing:copilot`,
// `read:org` or `read:enterprise`) plus the org slug. The API wins when both
// are configured; when it fails the local logs are used instead of failing the
// card, so a revoked token degrades to local data rather than an error.
//
// Neither source reports money, so dollars are estimated at list prices. A local
// record is priced at the model it names (the fallback when it names none). The
// API reports no model, so all of its tokens are priced at the fallback model.

const API_BASE = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const SERIES_DAYS = 14;

type CopilotSegmentKey = 'chat' | 'completions' | 'cli';

const SEGMENT_LABELS: Record<CopilotSegmentKey, string> = {
  chat: 'Chat',
  completions: 'Code completions',
  cli: 'CLI',
};

interface CopilotTokenUsage {
  prompt_tokens_sum?: number;
  output_tokens_sum?: number;
}

/** One day of `GET /orgs/{org}/copilot/metrics`. Unknown feature blocks are tolerated. */
export interface CopilotMetricsDay {
  date?: string;
  copilot_ide_chat?: { token_usage?: CopilotTokenUsage };
  copilot_ide_code_completions?: { token_usage?: CopilotTokenUsage };
  copilot_cli?: { token_usage?: CopilotTokenUsage };
  [feature: string]: unknown;
}

export interface CopilotApiOptions {
  apiKey: string;
  /** Org slug, or a github.com URL it was pasted from. */
  org: string;
}

/** One day-bucketed token event, already assigned to its chart segment. */
export interface CopilotApiEntry {
  at: number;
  segment: CopilotSegmentKey;
  tokens: UsageTokens;
}

function tokensOf(value: unknown): UsageTokens {
  const block = (value as { token_usage?: CopilotTokenUsage } | null)?.token_usage ?? {};
  const input =
    typeof block.prompt_tokens_sum === 'number' && Number.isFinite(block.prompt_tokens_sum)
      ? Math.max(0, block.prompt_tokens_sum)
      : 0;
  const output =
    typeof block.output_tokens_sum === 'number' && Number.isFinite(block.output_tokens_sum)
      ? Math.max(0, block.output_tokens_sum)
      : 0;
  return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
}

function addInto(target: UsageTokens, src: UsageTokens): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
  target.total += src.total;
}

/**
 * The org slug from what the user typed: a bare slug passes through, a pasted
 * `github.com/<org>` URL contributes its last path segment. Anything else is a
 * setup mistake, reported as one.
 */
export function normalizeCopilotOrg(org: string): string {
  const trimmed = org.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Set your GitHub organization to read Copilot metrics.');
  const slug = trimmed.includes('/') ? (trimmed.split('/').filter(Boolean).pop() ?? '') : trimmed;
  if (!/^[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`"${org.trim()}" is not a GitHub organization. Use the org slug from its URL.`);
  }
  return slug;
}

async function fetchMetricsDays(apiKey: string, org: string): Promise<CopilotMetricsDay[]> {
  const slug = normalizeCopilotOrg(org);
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const until = new Date(Date.now()).toISOString().slice(0, 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${API_BASE}/orgs/${encodeURIComponent(slug)}/copilot/metrics?since=${since}&until=${until}`,
      {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
        },
      },
    );
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitHub rejected the token (HTTP ${res.status}). It needs manage_billing:copilot, read:org or read:enterprise scope.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
    const data: unknown = await res.json();
    const days = Array.isArray(data)
      ? data
      : typeof data === 'object' &&
          data !== null &&
          Array.isArray((data as { data?: unknown }).data)
        ? ((data as { data: unknown[] }).data as unknown[])
        : null;
    if (!days) throw new Error('Unexpected Copilot metrics response');
    return days.filter((day): day is CopilotMetricsDay => typeof day === 'object' && day !== null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One entry per reported day and segment, at midday UTC. Days whose date does
 * not parse are skipped rather than bucketed wrongly.
 */
export function toCopilotEntries(days: CopilotMetricsDay[]): CopilotApiEntry[] {
  const entries: CopilotApiEntry[] = [];
  for (const day of days) {
    const at = typeof day.date === 'string' ? Date.parse(`${day.date}T12:00:00Z`) : NaN;
    if (Number.isNaN(at)) continue;
    const segments: Array<[CopilotSegmentKey, unknown]> = [
      ['chat', day.copilot_ide_chat],
      ['completions', day.copilot_ide_code_completions],
      ['cli', day.copilot_cli],
    ];
    for (const [segment, block] of segments) {
      const tokens = tokensOf(block);
      if (tokens.total > 0) entries.push({ at, segment, tokens });
    }
    // Features added after this code (code review, Copilot app, …) still count
    // toward the totals; they just have no segment row of their own.
    const extra = emptyUsageTokens();
    for (const [key, value] of Object.entries(day)) {
      if (
        key === 'date' ||
        key === 'copilot_ide_chat' ||
        key === 'copilot_ide_code_completions' ||
        key === 'copilot_cli'
      ) {
        continue;
      }
      addInto(extra, tokensOf(value));
    }
    if (extra.total > 0) entries.push({ at, segment: 'completions', tokens: extra });
  }
  return entries;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Fold entries since `sinceMs` into one period plus its chat/completions/CLI
 * split. All three segments are always present (possibly zero) so the card
 * renders a stable three-row layout. Cost is estimated at list prices with the
 * fallback model, which is what draws the card's Cost section; a slice with no
 * tokens prices as unknown rather than a free $0.00.
 */
export function accumulateCopilot(entries: CopilotApiEntry[], sinceMs: number): UsagePeriod {
  const segments: Record<CopilotSegmentKey, UsageSegment> = {
    chat: { key: 'chat', label: SEGMENT_LABELS.chat, tokens: emptyUsageTokens(), costUsd: null },
    completions: {
      key: 'completions',
      label: SEGMENT_LABELS.completions,
      tokens: emptyUsageTokens(),
      costUsd: null,
    },
    cli: { key: 'cli', label: SEGMENT_LABELS.cli, tokens: emptyUsageTokens(), costUsd: null },
  };
  const tokens = emptyUsageTokens();
  let cost = 0;
  let priced = false;
  for (const entry of entries) {
    if (entry.at < sinceMs) continue;
    addInto(segments[entry.segment].tokens, entry.tokens);
    addInto(tokens, entry.tokens);
    const entryCost = estimateCost(COPILOT_LOG_FALLBACK_MODEL, entry.tokens);
    if (entryCost != null) {
      segments[entry.segment].costUsd = (segments[entry.segment].costUsd ?? 0) + entryCost;
      cost += entryCost;
      priced = true;
    }
  }
  for (const key of ['chat', 'completions', 'cli'] as const) {
    if (segments[key].tokens.total <= 0) segments[key].costUsd = null;
  }
  return {
    tokens,
    costUsd: priced ? cost : null,
    segments: [segments.chat, segments.completions, segments.cli],
  };
}

function bucketDaily(
  entries: CopilotApiEntry[],
  value: (entry: CopilotApiEntry) => number,
): number[] {
  const startToday = startOfLocalDay(Date.now());
  const buckets = new Array<number>(SERIES_DAYS).fill(0);
  for (const entry of entries) {
    const dayIdx = Math.floor((startToday - startOfLocalDay(entry.at)) / DAY_MS);
    const idx = SERIES_DAYS - 1 - dayIdx;
    if (idx >= 0 && idx < SERIES_DAYS) buckets[idx] += value(entry);
  }
  return buckets;
}

/** Daily token totals for the last 14 days (oldest first) for the sparkline. */
function buildSeries(entries: CopilotApiEntry[]): number[] {
  return bucketDaily(entries, (entry) => entry.tokens.total);
}

/** Daily cost totals aligned with {@link buildSeries}. */
function buildCostSeries(entries: CopilotApiEntry[]): number[] {
  return bucketDaily(
    entries,
    (entry) => estimateCost(COPILOT_LOG_FALLBACK_MODEL, entry.tokens) ?? 0,
  );
}

/** Live Copilot usage from the org metrics API. */
export async function fetchCopilotApiUsage(options: CopilotApiOptions): Promise<ProviderUsage> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('Set a GitHub personal access token to read Copilot metrics.');
  const entries = toCopilotEntries(await fetchMetricsDays(apiKey, options.org));
  const now = Date.now();
  return {
    providerId: 'copilot',
    status: 'ok',
    today: accumulateCopilot(entries, startOfLocalDay(now)),
    last7d: accumulateCopilot(entries, now - 7 * DAY_MS),
    last30d: accumulateCopilot(entries, now - WINDOW_DAYS * DAY_MS),
    series: buildSeries(entries),
    costSeries: buildCostSeries(entries),
    currency: 'USD',
    updatedAt: new Date(now).toISOString(),
  };
}

export interface CopilotUsageDeps {
  scanLocal?: () => Promise<ProviderUsage>;
  fetchApi?: (options: CopilotApiOptions) => Promise<ProviderUsage>;
}

/**
 * Copilot usage, API first. A configured token + org reads the metrics API;
 * anything else (no token, or an API call that failed) reads the CLI's local
 * logs, which need no setup. The fallback is silent on purpose: a revoked
 * token degrades to local data rather than failing the card.
 */
export async function fetchCopilotUsage(
  config: UsageProviderConfig | undefined,
  deps: CopilotUsageDeps = {},
): Promise<ProviderUsage> {
  const scanLocal =
    deps.scanLocal ??
    (async () => {
      const { scanLocalProvider } = await import('./localScanner');
      return scanLocalProvider('copilot');
    });
  const apiKey = config?.apiKey?.trim();
  const org = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : '';
  if (apiKey && org) {
    try {
      const fetchApi = deps.fetchApi ?? fetchCopilotApiUsage;
      return await fetchApi({ apiKey, org });
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: surfaces the fallback so an API failure isn't silent
      console.warn('[usage] copilot API failed, falling back to local logs:', err);
      return scanLocal();
    }
  }
  return scanLocal();
}
