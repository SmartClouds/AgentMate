import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FilesHistoryEntry } from '../../../shared/deployFilesTypes';
import { checkSiteId, deployFilesDir, readJsonOrNull, writePrivateJson } from './bases';

/**
 * The recent deploys of each FTP or SFTP site (E23), newest first, one file per site under
 * `deploy-files/history/`. Only the last 50 are kept. History is a record for the user, not
 * something a deploy depends on, so a file that does not parse reads as empty.
 */

export const FILES_HISTORY_LIMIT = 50;

const failureSchema = z.object({ path: z.string(), code: z.string(), message: z.string() });

const entrySchema = z
  .object({
    runId: z.string().min(1),
    siteId: z.string().min(1),
    trigger: z.enum(['user', 'deployOnSave']),
    state: z.enum(['done', 'partial', 'failed', 'cancelled']),
    startedAt: z.number(),
    finishedAt: z.number(),
    uploaded: z.number(),
    deleted: z.number(),
    adopted: z.number(),
    skipped: z.number(),
    bytes: z.number(),
    failed: z.array(failureSchema),
    atomic: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .passthrough();

function historyFile(siteId: string): string {
  return join(deployFilesDir(), 'history', `${checkSiteId(siteId)}.json`);
}

function parseHistory(value: unknown): FilesHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entrySchema.safeParse(entry).success)
    .slice(0, FILES_HISTORY_LIMIT) as FilesHistoryEntry[];
}

let queue: Promise<unknown> = Promise.resolve();

export async function readHistory(siteId: string): Promise<FilesHistoryEntry[]> {
  const path = historyFile(siteId);
  await queue;
  return parseHistory(await readJsonOrNull(path));
}

/** Puts a finished run at the top and lets the oldest past the limit go. */
export async function appendHistory(siteId: string, entry: FilesHistoryEntry): Promise<void> {
  const path = historyFile(siteId);
  const next = queue.then(async () => {
    const entries = parseHistory(await readJsonOrNull(path));
    await writePrivateJson(path, [entry, ...entries].slice(0, FILES_HISTORY_LIMIT));
  });
  queue = next.catch(() => undefined);
  return next;
}

export async function removeHistory(siteId: string): Promise<void> {
  const path = historyFile(siteId);
  const next = queue.then(() => rm(path, { force: true }));
  queue = next.catch(() => undefined);
  return next;
}
