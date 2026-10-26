import type { AgentHistoryProvider } from '@runova/core';

// Where each conversation the history list showed lives on this machine. The list items that
// reach the renderer carry no path (it is never given one to hand back), so main keeps the
// mapping here and looks a conversation up by the provider and id the renderer does send.

export interface HistorySource {
  /** The transcript file, or `<db>#<id>` for a conversation kept in a SQLite store. */
  path: string;
  /** The file's mtime when it was listed; for a SQLite conversation, its last update. */
  mtimeMs: number;
  /** The SQLite store holding the conversation, when it is not a plain file. */
  dbPath?: string;
}

const sources = new Map<string, HistorySource>();

const keyOf = (provider: AgentHistoryProvider, id: string): string => `${provider}\u0000${id}`;

export function rememberHistorySource(
  provider: AgentHistoryProvider,
  id: string,
  source: HistorySource,
): void {
  sources.set(keyOf(provider, id), source);
}

export function historySource(provider: string, id: string): HistorySource | undefined {
  return sources.get(keyOf(provider as AgentHistoryProvider, id));
}

/** Forgets every remembered location. For tests. */
export function clearHistorySources(): void {
  sources.clear();
}
