import {
  emptyUsageTokens,
  type ProviderUsage,
  type UsagePeriod,
  type UsageProviderConfig,
  type UsageSegment,
  type UsageTokens,
} from '@runova/core';

// Cursor usage, read from the Cursor Admin API. Cursor keeps nothing usable on
// disk: `~/.cursor` holds settings, extensions and an AI-edit-tracking DB, but
// no token ledger. So unlike Claude Code and Codex, this provider has to go to
// the network.
//
// The endpoint is POST /teams/filtered-usage-events, authenticated with the
// admin key as the Basic-auth username and an empty password. It returns one
// row per model call, which is what lets us answer the question the card asks:
// how much went through Auto mode (included in the plan) versus how much was
// billed at API rates.

const BASE_URL = 'https://api.cursor.com';
const TIMEOUT_MS = 12_000;
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const SERIES_DAYS = 14;
const PAGE_SIZE = 1000;
/** Cap the paging loop. 30 days of a busy team, not an unbounded crawl. */
const MAX_PAGES = 20;

interface CursorTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Cursor prices the call for us, in cents. */
  totalCents?: number;
}

export interface CursorUsageEvent {
  /** Epoch ms, as a string in Cursor's responses. */
  timestamp?: string | number;
  model?: string;
  /**
   * The billing verdict. The Admin API spells it out ('Included in Pro',
   * 'Usage-based', 'Errored, Not Charged'); the dashboard feed sends the enum
   * ('USAGE_EVENT_KIND_INCLUDED_IN_PRO'). {@link normalizeKind} flattens both.
   */
  kindLabel?: string;
  kind?: string;
  /** What Cursor actually billed, in cents. Present on the dashboard feed. */
  chargedCents?: number;
  maxMode?: boolean;
  /** Request units consumed, for calls billed per request rather than per token. */
  requestsCosts?: number;
  isTokenBasedCall?: boolean;
  tokenUsage?: CursorTokenUsage | null;
}

interface CursorUsageResponse {
  usageEvents?: CursorUsageEvent[];
  pagination?: { numPages?: number; currentPage?: number; hasNextPage?: boolean };
}

/** One normalized call: when it happened, which bucket it belongs in, what it cost. */
export interface CursorEntry {
  at: number;
  segment: SegmentKey;
  tokens: UsageTokens;
  costUsd: number | null;
  requests: number;
}

type SegmentKey = 'auto' | 'api';

// 'Auto + Composer' rather than just 'Auto': the bucket covers Composer/agent
// calls too, and naming only Auto made the row read as if the rest were missing.
const SEGMENT_LABELS: Record<SegmentKey, string> = { auto: 'Auto + Composer', api: 'API' };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function postJson(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<CursorUsageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        // Cursor takes the API key as the Basic-auth username with no password.
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Cursor rejected the key. An Admin API key is required.');
    }
    if (!res.ok) throw new Error(`Cursor API returned HTTP ${res.status}`);
    const data: unknown = await res.json();
    if (typeof data !== 'object' || data === null) throw new Error('Unexpected Cursor response');
    return data as CursorUsageResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten either spelling of the billing verdict into lowercase words:
 * 'Errored, Not Charged' and 'USAGE_EVENT_KIND_ERRORED_NOT_CHARGED' both become
 * 'errored not charged'. The enum's shared `usage event kind` prefix is dropped
 * first, otherwise every event would look like it said "usage".
 */
function normalizeKind(event: CursorUsageEvent): string {
  return `${event.kindLabel ?? event.kind ?? ''}`
    .toLowerCase()
    .replace(/[_,-]+/g, ' ')
    .replace(/^\s*usage event kind\s*/, '')
    .trim();
}

/**
 * Split a call by which model the user actually invoked: Cursor's own pickers
 * (Auto, `default`, the Composer/agent models) versus an explicitly chosen
 * frontier model.
 *
 * Deliberately *not* split on Cursor's billing verdict. On a plan that includes
 * everything, every event comes back `INCLUDED_IN_PRO`, which collapses the
 * card to a single full-width bar and answers a question nobody asked. Grouping
 * by model keeps both buckets meaningful and matches what the labels claim.
 *
 * The corollary: this is a split of *what you ran*, not of what you were
 * charged for. Both buckets may well be plan-covered.
 */
export function classify(event: CursorUsageEvent): SegmentKey {
  const model = (event.model ?? '').trim().toLowerCase();
  if (
    model === '' ||
    model === 'auto' ||
    model === 'default' ||
    model.startsWith('auto-') ||
    model.startsWith('auto ') ||
    model.startsWith('composer')
  ) {
    return 'auto';
  }
  return 'api';
}

export function toEntry(event: CursorUsageEvent): CursorEntry | null {
  const at = Number(event.timestamp);
  if (!Number.isFinite(at) || at <= 0) return null;

  // Failed calls are shown but never billed, and counting them would overstate
  // consumption against what the Cursor dashboard reports.
  const kind = normalizeKind(event);
  if (kind.includes('errored') || kind.includes('not charged')) return null;

  const usage = event.tokenUsage ?? {};
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  // `chargedCents` is the money that actually hit the bill; `totalCents` is the
  // call's API-rate value, which on an included call is what the plan absorbed.
  // Prefer the former so the card's cost matches the invoice.
  const cents = typeof event.chargedCents === 'number' ? event.chargedCents : usage.totalCents;

  return {
    at,
    segment: classify(event),
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
    },
    costUsd: typeof cents === 'number' && Number.isFinite(cents) ? cents / 100 : null,
    requests: num(event.requestsCosts) || 1,
  };
}

async function fetchEvents(apiKey: string): Promise<CursorEntry[]> {
  const endDate = Date.now();
  const startDate = endDate - WINDOW_DAYS * DAY_MS;
  const entries: CursorEntry[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await postJson('/teams/filtered-usage-events', apiKey, {
      startDate,
      endDate,
      page,
      pageSize: PAGE_SIZE,
    });
    const events = Array.isArray(data.usageEvents) ? data.usageEvents : [];
    for (const event of events) {
      const entry = toEntry(event);
      if (entry) entries.push(entry);
    }
    const numPages = data.pagination?.numPages;
    const hasNext =
      data.pagination?.hasNextPage ?? (typeof numPages === 'number' ? page < numPages : false);
    if (!hasNext || events.length === 0) break;
  }

  return entries;
}

// --- aggregation ----------------------------------------------------------

function addInto(target: UsageTokens, src: UsageTokens): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
  target.total += src.total;
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Fold the calls since `sinceMs` into one period plus its Auto/API split. Both
 * segments are always present so the card renders a stable two-row layout even
 * on a day where only one of them was used.
 */
export function accumulate(entries: CursorEntry[], sinceMs: number): UsagePeriod {
  const segments: Record<SegmentKey, UsageSegment> = {
    auto: {
      key: 'auto',
      label: SEGMENT_LABELS.auto,
      tokens: emptyUsageTokens(),
      costUsd: 0,
      requests: 0,
    },
    api: {
      key: 'api',
      label: SEGMENT_LABELS.api,
      tokens: emptyUsageTokens(),
      costUsd: 0,
      requests: 0,
    },
  };
  const tokens = emptyUsageTokens();
  const priced: Record<SegmentKey, boolean> = { auto: false, api: false };
  let cost = 0;

  for (const entry of entries) {
    if (entry.at < sinceMs) continue;
    const segment = segments[entry.segment];
    addInto(segment.tokens, entry.tokens);
    addInto(tokens, entry.tokens);
    segment.requests = (segment.requests ?? 0) + entry.requests;
    if (entry.costUsd != null) {
      segment.costUsd = (segment.costUsd ?? 0) + entry.costUsd;
      cost += entry.costUsd;
      priced[entry.segment] = true;
    }
  }

  // A slice Cursor never priced reads as unknown, not as a free $0.00. Only
  // Auto genuinely costing nothing should render as zero.
  for (const key of ['auto', 'api'] as const) {
    if (!priced[key]) segments[key].costUsd = null;
  }

  return {
    tokens,
    costUsd: priced.auto || priced.api ? cost : null,
    segments: [segments.auto, segments.api],
  };
}

function bucketDaily(entries: CursorEntry[], value: (entry: CursorEntry) => number): number[] {
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
export function buildSeries(entries: CursorEntry[]): number[] {
  return bucketDaily(entries, (entry) => entry.tokens.total);
}

/** Daily cost totals aligned with {@link buildSeries}. */
export function buildCostSeries(entries: CursorEntry[]): number[] {
  return bucketDaily(entries, (entry) => entry.costUsd ?? 0);
}

/** Live Cursor usage, split into Auto-mode and API consumption. */
export async function fetchCursorUsage(cfg: UsageProviderConfig): Promise<ProviderUsage> {
  const apiKey = cfg.apiKey?.trim();
  if (!apiKey) throw new Error('No Cursor API key');

  const entries = await fetchEvents(apiKey);
  const now = Date.now();

  return {
    providerId: 'cursor',
    status: 'ok',
    today: accumulate(entries, startOfLocalDay(now)),
    last7d: accumulate(entries, now - 7 * DAY_MS),
    last30d: accumulate(entries, now - WINDOW_DAYS * DAY_MS),
    series: buildSeries(entries),
    costSeries: buildCostSeries(entries),
    currency: 'USD',
    updatedAt: new Date(now).toISOString(),
  };
}
