import { sameFolder } from '@agentmat/core';
import { opencodeSessionTable } from './opencodeStore';
import { conversationKey, type ListedConversation, type RecordedUsage } from './projectUsageReport';
import { localDay } from './projectUsageScan';
import { findOpencodeDb, type HistoryFs } from './sessionHistory';
import { opencodeModelId } from './sessionUsage';

// OpenCode's side of the project usage report. Its conversations live in a SQLite database that
// is read synchronously, so every call blocks the main process for as long as it runs. The
// history listing asks the database twice per conversation (first and last prompt), which the
// report has no use for, and on a long history that froze the app for seconds. Here the session
// rows already hold what is needed (title, last update, token totals and the cost OpenCode
// recorded), so one query does it.
//
// Subtasks OpenCode starts are sessions of their own (a `parent_id` points at the parent). The
// parent's row holds only its own tokens and cost, never its children's: on a real database each
// parent's row matched the sum of its own messages exactly. So every row is added once, with no
// folding of children into parents.

const sessionsSql = (table: string): string => `SELECT id, directory, title, model, cost,
  time_updated, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
  FROM ${table} WHERE time_updated >= ? ORDER BY time_updated DESC`;

export interface OpencodeProject {
  conversations: ListedConversation[];
  /** Totals per conversation, dated by its last update (OpenCode keeps no per-message time). */
  rows: RecordedUsage[];
  /** Stands for the whole database when it could not be read: its sessions are not known. */
  unreadable: number;
}

const EMPTY: OpencodeProject = { conversations: [], rows: [], unreadable: 0 };

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * The OpenCode conversations started in any of `folders` and last updated at or after `sinceMs`,
 * with what they used. A machine without OpenCode, or a target that cannot run SQL, has none.
 */
export async function readOpencodeProject(
  fs: HistoryFs,
  folders: readonly string[],
  sinceMs: number,
): Promise<OpencodeProject> {
  const { queryDb } = fs;
  if (!queryDb) return EMPTY;
  const dbPath = await findOpencodeDb(fs, await fs.home()).catch(() => null);
  if (!dbPath) return EMPTY;

  let found: Record<string, unknown>[];
  try {
    const table = await opencodeSessionTable((sql) => queryDb(dbPath, sql));
    found = await queryDb(dbPath, sessionsSql(table), [sinceMs]);
  } catch {
    return { ...EMPTY, unreadable: 1 };
  }

  const conversations: ListedConversation[] = [];
  const rows: RecordedUsage[] = [];
  for (const record of found) {
    const { id, directory } = record;
    if (typeof id !== 'string' || !id || typeof directory !== 'string' || !directory) continue;
    if (!folders.some((folder) => sameFolder(directory, folder, fs.caseInsensitive))) continue;

    const updatedAt = positive(record.time_updated);
    const title = typeof record.title === 'string' && record.title ? record.title : null;
    conversations.push({ provider: 'opencode', id, title, updatedAt });

    const cost = positive(record.cost);
    rows.push({
      key: conversationKey('opencode', id),
      day: localDay(updatedAt),
      model: opencodeModelId(record.model),
      input: positive(record.tokens_input),
      // Reasoning tokens are billed as output, and Codex's are counted that way too.
      output: positive(record.tokens_output) + positive(record.tokens_reasoning),
      cacheRead: positive(record.tokens_cache_read),
      cacheWrite: positive(record.tokens_cache_write),
      recordedCostUsd: cost > 0 ? cost : null,
    });
  }
  return { conversations, rows, unreadable: 0 };
}
