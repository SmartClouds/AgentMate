import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { estimateCost, type UsageTokens } from '@runova/core';
import type { AgentSessionModelUsage, AgentSessionUsage } from '../../shared/apiTypes';
import {
  collectLogFiles,
  type FileScanState,
  type LocalLogProvider,
  type LogFile,
  type RawUsageEntry,
  scanLogFile,
} from '../usage/logParsers';
import { makeTokens } from '../usage/shared';
import { type HistorySource, historySource } from './historySources';
import { opencodeSessionTable } from './opencodeStore';
import { type HistoryFs, localHistoryFs } from './sessionHistory';

// Tokens and estimated cost of one past conversation, for the history list's right-click menu.
//
// Claude Code and Codex log every token event in the conversation's own JSONL file, the same
// files the Usage page reads, so the parsing is shared with it. The difference is the scope:
// the Usage page keeps 30 days of events across all files, here a whole file is read however
// old it is. OpenCode keeps running totals on the session row, so those are read as they are.
// The other agents do not record tokens.

const UNAVAILABLE: AgentSessionUsage = { status: 'unavailable' };

/** The ids of every supported agent are UUIDs or `ses_...`; anything else never names a file. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Which parser reads each agent's transcript. OpenClaude writes Claude Code's format. */
const FILE_PARSER = new Map<string, LocalLogProvider>([
  ['claude-code', 'claude-code'],
  ['openclaude', 'claude-code'],
  ['codex', 'codex'],
]);

const MAX_CACHED_FILES = 40;

/**
 * Parse state per transcript. The conversation someone checks is usually the one still
 * running, so a repeat look should read only what was appended since, not the whole file.
 */
const fileStates = new Map<string, FileScanState>();
const opencodeCache = new Map<string, { mtimeMs: number; usage: AgentSessionUsage }>();
/** Requests for the same conversation share one read; two scans of one file would race. */
const inflight = new Map<string, Promise<AgentSessionUsage>>();

/** Forgets everything read so far. For tests. */
export function clearSessionUsageCaches(): void {
  fileStates.clear();
  opencodeCache.clear();
  inflight.clear();
}

function rememberState(path: string, state: FileScanState): void {
  fileStates.delete(path);
  fileStates.set(path, state);
  while (fileStates.size > MAX_CACHED_FILES) {
    const oldest = fileStates.keys().next().value;
    if (oldest === undefined) break;
    fileStates.delete(oldest);
  }
}

/**
 * Totals and cost for a list of token events. Claude Code logs one line per content block of a
 * message, all with that message's id and usage, so each id counts once. Priced model by model;
 * a model with no price leaves its tokens out of the cost and marks the cost as partial.
 */
export function summarizeUsage(entries: readonly RawUsageEntry[]): AgentSessionUsage {
  const seen = new Set<string>();
  const byModel = new Map<string, UsageTokens>();
  for (const entry of entries) {
    if (entry.id) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
    }
    const tokens = makeTokens(entry.input, entry.output, entry.cacheRead, entry.cacheWrite);
    // Placeholder messages (Claude's "<synthetic>" ones) carry no tokens and no price.
    if (tokens.total === 0) continue;
    const sum = byModel.get(entry.model) ?? makeTokens(0, 0, 0, 0);
    sum.input += tokens.input;
    sum.output += tokens.output;
    sum.cacheRead += tokens.cacheRead;
    sum.cacheWrite += tokens.cacheWrite;
    sum.total += tokens.total;
    byModel.set(entry.model, sum);
  }

  const total = makeTokens(0, 0, 0, 0);
  const models: AgentSessionModelUsage[] = [];
  let costUsd: number | null = null;
  let costPartial = false;
  for (const [model, tokens] of byModel) {
    total.input += tokens.input;
    total.output += tokens.output;
    total.cacheRead += tokens.cacheRead;
    total.cacheWrite += tokens.cacheWrite;
    total.total += tokens.total;
    const cost = estimateCost(model, tokens);
    if (cost === null) costPartial = true;
    else costUsd = (costUsd ?? 0) + cost;
    models.push({ model, tokens, costUsd: cost });
  }
  models.sort((a, b) => b.tokens.total - a.tokens.total);
  return {
    status: 'ok',
    tokens: total,
    costUsd,
    costPartial: costPartial && costUsd !== null,
    models,
  };
}

async function statLogFile(path: string): Promise<LogFile | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { path, mtimeMs: info.mtimeMs, size: info.size } : null;
  } catch {
    return null;
  }
}

async function transcriptUsage(
  parser: LocalLogProvider,
  id: string,
  source: HistorySource,
): Promise<AgentSessionUsage> {
  const main = await statLogFile(source.path);
  if (!main) return UNAVAILABLE;
  const files = [main];
  if (parser === 'claude-code') {
    // Subagent transcripts sit in a folder named after the session and hold their own usage,
    // which the Usage page counts too. Their message ids never repeat the parent's.
    files.push(...(await collectLogFiles(join(dirname(source.path), id), 0)));
  }
  const entries: RawUsageEntry[] = [];
  for (const file of files) {
    const state = await scanLogFile(parser, file, fileStates.get(file.path));
    if (!state) {
      if (file === main) return UNAVAILABLE;
      continue; // a subagent log that vanished mid-read
    }
    rememberState(file.path, state);
    for (const entry of state.entries) entries.push(entry);
  }
  return summarizeUsage(entries);
}

const opencodeUsageSql = (table: string): string => `SELECT model, cost, tokens_input,
  tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM ${table} WHERE id = ?`;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** The session row stores the model as JSON like `{"id":"...","providerID":"..."}`. */
export function opencodeModelId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as { id?: unknown }).id;
      return typeof id === 'string' && id ? id : null;
    }
  } catch {
    /* a bare model id */
  }
  return raw;
}

/**
 * OpenCode sums a session's tokens and cost on its row. Sessions it spawned for subtasks are
 * listed as conversations of their own, so they are not folded into the parent here (unlike
 * Claude Code's subagents, which have no entry of their own).
 */
async function opencodeUsage(
  fs: HistoryFs,
  id: string,
  source: HistorySource,
): Promise<AgentSessionUsage> {
  const { queryDb } = fs;
  const { dbPath } = source;
  if (!queryDb || !dbPath) return UNAVAILABLE;
  // Querying can mean copying a database of hundreds of MB, so a session is read again only
  // after it was updated.
  const cached = opencodeCache.get(id);
  if (cached && cached.mtimeMs === source.mtimeMs) return cached.usage;

  const table = await opencodeSessionTable((sql) => queryDb(dbPath, sql));
  const row = (await queryDb(dbPath, opencodeUsageSql(table), [id]))[0];
  if (!row) return UNAVAILABLE;
  const tokens = makeTokens(
    count(row.tokens_input),
    // Reasoning tokens are billed as output, and Codex's are counted that way too.
    count(row.tokens_output) + count(row.tokens_reasoning),
    count(row.tokens_cache_read),
    count(row.tokens_cache_write),
  );
  const model = opencodeModelId(row.model);
  // OpenCode priced the run with the provider's own rates; ours cover models it left at zero.
  const recorded = count(row.cost);
  const costUsd = recorded > 0 ? recorded : model ? estimateCost(model, tokens) : null;
  const usage: AgentSessionUsage = {
    status: 'ok',
    tokens,
    costUsd,
    costPartial: false,
    models: model ? [{ model, tokens, costUsd }] : [],
  };
  opencodeCache.set(id, { mtimeMs: source.mtimeMs, usage });
  return usage;
}

/**
 * Usage of a conversation the history list showed, by the agent and id the list gave. The
 * transcript is found through what the list remembered, never a path from the caller.
 */
export function readSessionUsage(
  provider: string,
  id: string,
  fs: HistoryFs = localHistoryFs,
): Promise<AgentSessionUsage> {
  const parser = FILE_PARSER.get(provider);
  if (!parser && provider !== 'opencode') return Promise.resolve({ status: 'unsupported' });
  if (!ID_PATTERN.test(id)) return Promise.resolve(UNAVAILABLE);
  const source = historySource(provider, id);
  if (!source) return Promise.resolve(UNAVAILABLE);

  const key = `${provider}\u0000${id}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (parser ? transcriptUsage(parser, id, source) : opencodeUsage(fs, id, source))
    .catch((): AgentSessionUsage => UNAVAILABLE)
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
