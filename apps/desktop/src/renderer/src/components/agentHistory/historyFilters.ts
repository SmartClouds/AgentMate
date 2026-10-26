import type { AgentHistorySession } from '@runova/core';

/**
 * The pure half of the AI history list: filtering, day and folder grouping, path shortening.
 * Shared by the workspace history section and the remote server panel so both read the same.
 */

export type HistoryProvider = AgentHistorySession['provider'];
export type ProviderFilter = 'all' | HistoryProvider;

export const PROVIDER_LABEL: Record<HistoryProvider, string> = {
  'claude-code': 'Claude',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  'gemini-cli': 'Gemini',
  'qwen-cli': 'Qwen',
  'cursor-cli': 'Cursor',
  'continue-cli': 'Continue',
  'grok-cli': 'Grok',
  'cline-cli': 'Cline',
  opencode: 'OpenCode',
  'freebuff-cli': 'FreeBuff',
};

export interface HistoryFilter {
  query: string;
  provider: ProviderFilter;
  /** Include runs started by tools (`claude -p`, `codex exec`). */
  showBackground: boolean;
}

export interface DayGroup {
  label: string;
  items: AgentHistorySession[];
}

export interface FolderGroup {
  /** The folder the conversations ran in, or null when the CLI did not record one. */
  folder: string | null;
  items: AgentHistorySession[];
  /** The newest `updatedAt` in the group. */
  latest: number;
}

export function dayBucket(at: number, now: Date): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (at >= startOfToday) return 'Today';
  if (at >= startOfToday - day) return 'Yesterday';
  if (at >= startOfToday - 6 * day) return 'This week';
  if (at >= startOfToday - 29 * day) return 'This month';
  return 'Older';
}

function matchesProvider(session: AgentHistorySession, provider: ProviderFilter): boolean {
  return provider === 'all' || session.provider === provider;
}

export function filterSessions(
  sessions: readonly AgentHistorySession[],
  { query, provider, showBackground }: HistoryFilter,
): AgentHistorySession[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter(
    (s) =>
      (showBackground || !s.background) &&
      matchesProvider(s, provider) &&
      (!needle ||
        [s.title, s.firstPrompt, s.lastPrompt, s.gitBranch, s.model, s.id].some((field) =>
          field?.toLowerCase().includes(needle),
        )),
  );
}

/** How many runs started by tools the provider filter would let through. */
export function backgroundCount(
  sessions: readonly AgentHistorySession[],
  provider: ProviderFilter,
): number {
  return sessions.filter((s) => s.background && matchesProvider(s, provider)).length;
}

/** Conversations per agent, for the agent filter menu counts. */
export function countByProvider(
  sessions: readonly AgentHistorySession[],
): Map<HistoryProvider, number> {
  const counts = new Map<HistoryProvider, number>();
  for (const session of sessions) {
    counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
  }
  return counts;
}

/** Splits an already sorted list into day runs, keeping its order. */
export function groupByDay(sessions: readonly AgentHistorySession[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const session of sessions) {
    const label = dayBucket(session.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(session);
    else groups.push({ label, items: [session] });
  }
  return groups;
}

function folderKey(cwd: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Groups conversations by the folder they ran in, the most recently active folder first.
 * Conversations with no recorded folder share one group at the end.
 */
export function groupByFolder(sessions: readonly AgentHistorySession[]): FolderGroup[] {
  const byFolder = new Map<string | null, FolderGroup>();
  for (const session of sessions) {
    const folder = folderKey(session.cwd);
    const group = byFolder.get(folder);
    if (group) {
      group.items.push(session);
      group.latest = Math.max(group.latest, session.updatedAt);
    } else {
      byFolder.set(folder, { folder, items: [session], latest: session.updatedAt });
    }
  }
  const unknown = byFolder.get(null);
  byFolder.delete(null);
  const groups = [...byFolder.values()].sort((a, b) => b.latest - a.latest);
  return unknown ? [...groups, unknown] : groups;
}

/** A POSIX path with the home folder written as `~`, matched on whole segments only. */
export function displayPath(path: string, home?: string | null): string {
  const base = home?.replace(/\/+$/, '');
  if (!base) return path;
  if (path === base) return '~';
  if (path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}
