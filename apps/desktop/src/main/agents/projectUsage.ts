import { dirname, join } from 'node:path';
import {
  AGENT_HISTORY_PROVIDERS,
  type AgentHistoryProvider,
  type AgentHistorySession,
} from '@runova/core';
import type { ProjectUsageReport, ProjectUsageUncounted } from '../../shared/apiTypes';
import type { LocalLogProvider, ScanCache } from '../usage/logParsers';
import { type HistorySource, historySource } from './historySources';
import { type OpencodeProject, readOpencodeProject } from './projectOpencode';
import { buildProjectReport, conversationKey, type ListedConversation } from './projectUsageReport';
import { type ScanInput, type ScanJob, type ScanOutput, trimScanCache } from './projectUsageScan';
import { runProjectScan } from './projectUsageWorkerClient';
import { collectHistory, localHistoryFs } from './sessionHistory';
import { ID_PATTERN } from './sessionUsage';

// What a whole project has spent, for the Usage tab of its page: the conversations every agent
// kept for its folder (and each git worktree's), read together. Listing them happens here, and so
// does asking OpenCode's database; parsing the transcripts happens on a worker thread
// (projectUsageScan.ts).

/** The newest this many conversations of a folder are read; the report says when there are more. */
export const PROJECT_SESSION_LIMIT = 1000;

/**
 * The agents read through the history listing. OpenCode is left out on purpose: the listing asks
 * its database twice per conversation for prompts the report never shows, and the database is
 * read synchronously, so on a long history that froze the main process for seconds. It has its
 * own reader (projectOpencode.ts) that needs one query.
 */
export const PROJECT_LISTED_PROVIDERS: readonly AgentHistoryProvider[] =
  AGENT_HISTORY_PROVIDERS.filter((provider) => provider !== 'opencode');

/** How many token events stay parsed between looks, so a repeat only reads what was appended. */
const CACHE_BUDGET_ENTRIES = 400_000;

/** Which parser reads each agent's transcript. OpenClaude writes Claude Code's format. */
const SCAN_PARSERS: Partial<Record<AgentHistoryProvider, LocalLogProvider>> = {
  'claude-code': 'claude-code',
  openclaude: 'claude-code',
  codex: 'codex',
};

export interface ProjectUsageDeps {
  list: (
    folder: string,
    limit: number,
    providers: readonly AgentHistoryProvider[],
  ) => Promise<AgentHistorySession[]>;
  source: (provider: string, id: string) => HistorySource | undefined;
  scan: (input: ScanInput) => Promise<ScanOutput>;
  opencode: (folders: readonly string[], sinceMs: number) => Promise<OpencodeProject>;
  now: () => number;
}

const defaultDeps = (): ProjectUsageDeps => ({
  // Listing also tells main where each transcript lives, which the scan jobs below rely on.
  list: (folder, limit, providers) => collectHistory(localHistoryFs, { folder, limit, providers }),
  source: historySource,
  scan: runProjectScan,
  opencode: (folders, sinceMs) => readOpencodeProject(localHistoryFs, folders, sinceMs),
  now: Date.now,
});

let scanCache: ScanCache = {};
const inflight = new Map<string, Promise<ProjectUsageReport>>();

/** Forgets what earlier looks parsed. For tests. */
export function clearProjectUsageCaches(): void {
  scanCache = {};
  inflight.clear();
}

/**
 * Where a period of `days` starts: midnight of the first of the last N calendar days, today
 * included, so the first day is whole and the chart's bars line up with it. Zero for no period.
 */
export function periodStart(now: number, days: number | null): number {
  if (days === null) return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

async function gather(
  folders: readonly string[],
  days: number | null,
  deps: ProjectUsageDeps,
): Promise<ProjectUsageReport> {
  const since = periodStart(deps.now(), days);

  // One at a time: each listing already reads hundreds of transcript heads in parallel.
  const found = new Map<string, AgentHistorySession>();
  let truncated = false;
  for (const folder of folders) {
    const listed = await deps.list(folder, PROJECT_SESSION_LIMIT, PROJECT_LISTED_PROVIDERS);
    if (listed.length >= PROJECT_SESSION_LIMIT) truncated = true;
    for (const session of listed) {
      const key = conversationKey(session.provider, session.id);
      if (!found.has(key)) found.set(key, session);
    }
  }

  const jobs: ScanJob[] = [];
  const uncounted = new Map<AgentHistoryProvider, number>();
  let unreadable = 0;
  for (const [key, session] of found) {
    const parser = SCAN_PARSERS[session.provider];
    if (parser) {
      const source = deps.source(session.provider, session.id);
      if (!source || !ID_PATTERN.test(session.id)) {
        if (session.updatedAt >= since) unreadable += 1;
        continue;
      }
      jobs.push({
        key,
        parser,
        path: source.path,
        // Subagent transcripts sit in a folder named after the conversation.
        subagentDir: parser === 'claude-code' ? join(dirname(source.path), session.id) : undefined,
        // A resumed conversation repeats the messages it continues; the one that started first
        // gets them.
        order: session.startedAt ?? session.updatedAt,
      });
    } else if (session.updatedAt >= since) {
      uncounted.set(session.provider, (uncounted.get(session.provider) ?? 0) + 1);
    }
  }

  let scanned: ScanOutput = { buckets: [], cache: {}, unreadable: [] };
  if (jobs.length > 0) {
    scanned = await deps.scan({ jobs, sinceMs: since, cache: scanCache });
    scanCache = trimScanCache({ ...scanCache, ...scanned.cache }, CACHE_BUDGET_ENTRIES);
  }
  const opencode = await deps.opencode(folders, since);

  const listed: ListedConversation[] = [
    ...[...found.values()].map((s) => ({
      provider: s.provider,
      id: s.id,
      title: s.title ?? s.firstPrompt,
      updatedAt: s.updatedAt,
    })),
    ...opencode.conversations,
  ];
  const uncountedList: ProjectUsageUncounted[] = [...uncounted]
    .map(([provider, conversations]) => ({ provider, conversations }))
    .sort((a, b) => b.conversations - a.conversations);

  return buildProjectReport({
    days,
    folders: folders.length,
    truncated,
    conversations: listed,
    buckets: scanned.buckets,
    recorded: opencode.rows,
    uncounted: uncountedList,
    unreadable: unreadable + scanned.unreadable.length + opencode.unreadable,
  });
}

/**
 * The report for the conversations kept in `folders` (a project's own folder and its worktrees)
 * over the last `days`, or all of it for null. Requests for the same thing at the same time share
 * one read. A failed read rejects, so the page can offer a retry rather than show a wrong total.
 */
export function readProjectUsage(
  folders: readonly string[],
  days: number | null,
  deps: ProjectUsageDeps = defaultDeps(),
): Promise<ProjectUsageReport> {
  const key = `${days ?? 'all'}\u0000${folders.join('\u0000')}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = gather(folders, days, deps).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
