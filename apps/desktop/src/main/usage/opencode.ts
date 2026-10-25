import { homedir } from 'node:os';
import {
  emptyUsageTokens,
  estimateCost,
  OPENCODE_LOG_FALLBACK_MODEL,
  type ProjectDaily,
  type ProviderUsage,
  type UsagePeriod,
  type UsageTokens,
} from '@agentmat/core';
import { opencodeSessionTable } from '../agents/opencodeStore';
import { retentionSinceMs } from './logParsers';
import type { KnownProjects } from './projectDaily';
import { buildProjectDaily } from './projectDaily';
import { makeTokens } from './shared';

// OpenCode's side of the Token Usage page. Its conversations live in a SQLite
// database (`opencode.db`), one row per session with running token totals and
// the cost OpenCode recorded, dated by the session's last update (OpenCode
// keeps no per-message times). Each row becomes one usage event, the same way
// a Codex `token_count` line is one event, so the card renders the identical
// chart UI: period chips, cost-led headline, Usage/Cost compare bars and the
// 14-day sparkline.
//
// Subtask sessions are rows of their own whose parent's row holds only its own
// tokens (verified against a real database in projectOpencode.ts), so every row
// is added once with no folding of children into parents.

const sessionsSql = (table: string): string => `SELECT id, directory, model, cost, time_updated,
  tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
  FROM ${table} WHERE time_updated >= ? ORDER BY time_updated DESC`;

const DAY_MS = 86_400_000;
const SERIES_DAYS = 14;

/** One OpenCode session as a chart event, dated by its last update. */
export interface OpencodeEntry {
  at: number;
  folder: string | null;
  model: string;
  tokens: UsageTokens;
  /** What this session cost: OpenCode's recorded figure, else the catalog estimate. */
  cost: number | null;
}

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** The session row stores the model as JSON like `{"id":"...","providerID":"..."}`. */
export function opencodeUsageModelId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === 'string' && id) return id;
    }
  } catch {
    /* a bare model id */
  }
  return raw;
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Session rows to chart events. Pure so tests pin the mapping without touching
 * the database. Rows outside the retention horizon, without a usable timestamp,
 * or with no tokens and no recorded cost are left out.
 */
export function toOpencodeEntries(
  rows: readonly Record<string, unknown>[],
  sinceMs: number,
): OpencodeEntry[] {
  const entries: OpencodeEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const at = row.time_updated;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < sinceMs) continue;
    const tokens = makeTokens(
      positive(row.tokens_input),
      // Reasoning tokens are billed as output, the way Codex counts them too.
      positive(row.tokens_output) + positive(row.tokens_reasoning),
      positive(row.tokens_cache_read),
      positive(row.tokens_cache_write),
    );
    const recorded = positive(row.cost);
    const recordedCost = recorded > 0 ? recorded : null;
    if (tokens.total <= 0 && recordedCost == null) continue;
    const model = opencodeUsageModelId(row.model) ?? OPENCODE_LOG_FALLBACK_MODEL;
    const cost = recordedCost ?? estimateCost(model, tokens);
    const directory = row.directory;
    entries.push({
      at,
      folder: typeof directory === 'string' && directory ? directory : null,
      model,
      tokens,
      cost,
    });
  }
  return entries;
}

function accumulateOpencode(entries: OpencodeEntry[], sinceMs: number): UsagePeriod {
  const tokens = emptyUsageTokens();
  let cost = 0;
  let priced = false;
  for (const entry of entries) {
    if (entry.at < sinceMs) continue;
    tokens.input += entry.tokens.input;
    tokens.output += entry.tokens.output;
    tokens.cacheRead += entry.tokens.cacheRead;
    tokens.cacheWrite += entry.tokens.cacheWrite;
    tokens.total += entry.tokens.total;
    if (entry.cost != null) {
      cost += entry.cost;
      priced = true;
    }
  }
  return { tokens, costUsd: priced ? cost : null };
}

function bucketDaily(entries: OpencodeEntry[], value: (entry: OpencodeEntry) => number): number[] {
  const startToday = startOfLocalDay(Date.now());
  const buckets = new Array<number>(SERIES_DAYS).fill(0);
  for (const entry of entries) {
    const dayIdx = Math.floor((startToday - startOfLocalDay(entry.at)) / DAY_MS);
    const idx = SERIES_DAYS - 1 - dayIdx;
    if (idx >= 0 && idx < SERIES_DAYS) buckets[idx] += value(entry);
  }
  return buckets;
}

/** Fold chart events into the normalized ProviderUsage shape the card draws. */
export function buildOpencodeUsage(
  entries: OpencodeEntry[],
  projectDaily?: ProjectDaily,
): ProviderUsage {
  const now = Date.now();
  const startToday = startOfLocalDay(now);
  const usage: ProviderUsage = {
    providerId: 'opencode',
    status: 'ok',
    today: accumulateOpencode(entries, startToday),
    last7d: accumulateOpencode(entries, now - 7 * DAY_MS),
    last30d: accumulateOpencode(entries, now - 30 * DAY_MS),
    series: bucketDaily(entries, (entry) => entry.tokens.total),
    costSeries: bucketDaily(entries, (entry) => entry.cost ?? 0),
    currency: 'USD',
    updatedAt: new Date(now).toISOString(),
  };
  if (projectDaily) usage.projectDaily = projectDaily;
  return usage;
}

export interface OpencodeScanDeps {
  sinceMs?: number;
  now?: number;
  findDb?: () => Promise<string | null>;
  queryDb?: (dbPath: string, sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  knownProjects?: () => Promise<KnownProjects>;
}

async function defaultFindDb(): Promise<string | null> {
  const { findOpencodeDb, localHistoryFs } = await import('../agents/sessionHistory');
  return findOpencodeDb(localHistoryFs, homedir()).catch(() => null);
}

async function defaultQueryDb(
  dbPath: string,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const { localHistoryFs } = await import('../agents/sessionHistory');
  if (!localHistoryFs.queryDb) return [];
  return localHistoryFs.queryDb(dbPath, sql, params);
}

async function defaultKnownProjects(): Promise<KnownProjects> {
  const { loadKnownProjects } = await import('./knownProjects');
  return loadKnownProjects();
}

/**
 * Usage for the OpenCode card: every session updated inside the retention
 * horizon, dated by its last update. A machine without OpenCode has none, so
 * the card draws the same empty zeros a fresh Codex install does. A database
 * that cannot be read throws, so the page folds it into the card's error state
 * instead of showing a wrong total.
 */
export async function scanOpencodeUsage(deps: OpencodeScanDeps = {}): Promise<ProviderUsage> {
  const sinceMs = deps.sinceMs ?? retentionSinceMs();
  const now = deps.now ?? Date.now();
  const findDb = deps.findDb ?? defaultFindDb;
  const queryDb = deps.queryDb ?? defaultQueryDb;

  const dbPath = await findDb();
  if (!dbPath) return buildOpencodeUsage([]);

  const table = await opencodeSessionTable((sql) => queryDb(dbPath, sql, []));
  const rows = await queryDb(dbPath, sessionsSql(table), [sinceMs]);
  const entries = toOpencodeEntries(rows, sinceMs);

  let projectDaily: ProjectDaily | undefined;
  try {
    const known = await (deps.knownProjects ?? defaultKnownProjects)().catch(() => undefined);
    projectDaily = buildProjectDaily(
      entries.map((entry) => ({
        at: new Date(entry.at),
        model: entry.model,
        tokens: entry.tokens,
        folder: entry.folder,
      })),
      { now, known },
    );
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: a broken project split should be visible, not silently missing
    console.warn('[usage] opencode project split failed:', err);
    projectDaily = undefined;
  }

  return buildOpencodeUsage(entries, projectDaily);
}
