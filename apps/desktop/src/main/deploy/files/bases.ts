import { randomUUID } from 'node:crypto';
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BaseEntry, BaseMap } from '@agentmat/core';
import { app } from 'electron';
import { z } from 'zod';
import { filesError } from '../../../shared/deployFilesErrors';
import type { FileSiteProtocol } from '../../../shared/deployFilesTypes';
import type { StoredFileSite } from './types';

/**
 * What the last deploy of each FTP or SFTP site left on the server (E23), one base file per site
 * under `deploy-files/bases/` in the app's data folder, outside every project folder.
 *
 * FTP has no transactions, so a run does not write the base at the end. It appends one line to
 * the site's journal (`<siteId>.journal.jsonl`) for every file it finished, and the journal is
 * folded into the base when the run ends, or at the next startup if the app stopped part way. A
 * run that fails or is cancelled therefore keeps what it finished, and the next one does not send
 * those files again. Every event can be applied twice without harm, so a crash between writing
 * the folded base and deleting the journal is harmless too.
 *
 * A base belongs to one target: the protocol, the server, the remote folder and the local folder.
 * When the site is pointed somewhere else, the old base no longer says anything about what is
 * there, so it reads as empty and the next deploy is a first deploy again.
 */

/**
 * Where a base was recorded. For a login of the site's own, `host`, `port` and `username` are the
 * login's (another account on the same server can see other files); for a server saved in
 * Remote, `host` is `saved:<sshServerId>` and `port` and `username` are null, since the saved
 * server's address can change without the files on it changing.
 */
export interface BaseTarget {
  protocol: FileSiteProtocol;
  host: string;
  port: number | null;
  username: string | null;
  remoteRoot: string;
  localFolder: string;
}

export interface FilesBase {
  version: 1;
  target: BaseTarget;
  files: BaseMap;
  /** Folders AgentMate created on the server, the only ones it may remove again. */
  createdDirs: string[];
}

export type JournalEvent =
  /** A file arrived on the server. */
  | { t: 'put'; path: string; entry: BaseEntry }
  /** A file was deleted on the server. */
  | { t: 'del'; path: string }
  /** AgentMate created a folder on the server. */
  | { t: 'dir'; path: string }
  /** AgentMate removed a folder it had created. */
  | { t: 'rmdir'; path: string }
  /** Deleted here and already gone from the server: it only leaves the base. */
  | { t: 'drop'; path: string };

export interface FilesJournal {
  /** Adds one line. Appends made without waiting still land in the order they were made. */
  append: (event: JournalEvent) => Promise<void>;
  close: () => Promise<void>;
}

const SITE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PATH = 4096;
const JOURNAL_SUFFIX = '.journal.jsonl';

const pathSchema = z.string().max(MAX_PATH);

const observationSchema = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nullable(),
  via: z.enum(['sftp', 'mlsd', 'mdtm']).nullable(),
});

const entrySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  localMtimeMs: z.number(),
  remote: observationSchema.nullable(),
});

const targetSchema = z.object({
  protocol: z.enum(['sftp', 'ftps', 'ftp']),
  host: z.string(),
  port: z.number().int().nullable(),
  // A base from before the username was kept reads as null: the same target for a saved server,
  // another one (so empty) for a login of the site's own.
  username: z.string().nullable().default(null),
  remoteRoot: z.string(),
  localFolder: z.string(),
});

const eventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('put'), path: pathSchema, entry: entrySchema }),
  z.object({ t: z.literal('del'), path: pathSchema }),
  z.object({ t: z.literal('dir'), path: pathSchema }),
  z.object({ t: z.literal('rmdir'), path: pathSchema }),
  z.object({ t: z.literal('drop'), path: pathSchema }),
]);

/** `<userData>/data/deploy-files`, where every FTP and SFTP site file beside the store lives. */
export function deployFilesDir(): string {
  return join(app.getPath('userData'), 'data', 'deploy-files');
}

function basesDir(): string {
  return join(deployFilesDir(), 'bases');
}

/** A site id becomes a file name, so it must not be able to name anything else. */
export function checkSiteId(siteId: string): string {
  if (typeof siteId !== 'string' || !SITE_ID.test(siteId)) {
    throw filesError('invalidInput', 'That site id is not valid.');
  }
  return siteId;
}

function baseFile(siteId: string): string {
  return join(basesDir(), `${checkSiteId(siteId)}.json`);
}

function journalFile(siteId: string): string {
  return join(basesDir(), `${checkSiteId(siteId)}${JOURNAL_SUFFIX}`);
}

/** Written to a temporary name and renamed over, readable only by the user. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The parsed file, null when there is none or it is not JSON. */
export async function readJsonOrNull(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The target a site's base is recorded against. */
export function baseTargetOf(
  site: Pick<StoredFileSite, 'protocol' | 'connection' | 'remoteRoot' | 'localFolder'>,
): BaseTarget {
  const { connection } = site;
  return {
    protocol: site.protocol,
    host: connection.kind === 'saved' ? `saved:${connection.sshServerId}` : connection.host,
    port: connection.kind === 'saved' ? null : connection.port,
    username: connection.kind === 'saved' ? null : connection.username,
    remoteRoot: site.remoteRoot,
    localFolder: site.localFolder,
  };
}

/** Whether two bases were recorded against the same place. */
export function sameTarget(a: BaseTarget, b: BaseTarget): boolean {
  return (
    a.protocol === b.protocol &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.remoteRoot === b.remoteRoot &&
    a.localFolder === b.localFolder
  );
}

function emptyBase(target: BaseTarget): FilesBase {
  return { version: 1, target: { ...target }, files: {}, createdDirs: [] };
}

/** A base that cannot be read counts as none; entries that are not shaped right are dropped. */
function parseBase(value: unknown): FilesBase | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const target = targetSchema.safeParse(record.target);
  if (!target.success) return null;
  const files: BaseMap = {};
  if (typeof record.files === 'object' && record.files !== null && !Array.isArray(record.files)) {
    for (const [path, entry] of Object.entries(record.files)) {
      const parsed = entrySchema.safeParse(entry);
      if (parsed.success && path.length <= MAX_PATH) files[path] = parsed.data;
    }
  }
  const createdDirs = Array.isArray(record.createdDirs)
    ? [...new Set(record.createdDirs.filter((dir): dir is string => typeof dir === 'string'))]
    : [];
  return { version: 1, target: target.data, files, createdDirs };
}

/** Every line that is an event; a line cut short by a crash, or anything else, is skipped. */
function parseJournal(raw: string): JournalEvent[] {
  const events: JournalEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = eventSchema.safeParse(value);
    if (parsed.success) events.push(parsed.data as JournalEvent);
  }
  return events;
}

function applyEvent(base: FilesBase, event: JournalEvent): void {
  switch (event.t) {
    case 'put':
      base.files[event.path] = event.entry;
      break;
    case 'del':
    case 'drop':
      delete base.files[event.path];
      break;
    case 'dir':
      if (!base.createdDirs.includes(event.path)) base.createdDirs.push(event.path);
      break;
    case 'rmdir':
      base.createdDirs = base.createdDirs.filter((dir) => dir !== event.path);
      break;
  }
}

const siteQueues = new Map<string, Promise<unknown>>();

/** Runs base work for one site one step at a time; other sites do not wait. */
function inSiteQueue<T>(siteId: string, work: () => Promise<T>): Promise<T> {
  const previous = siteQueues.get(siteId) ?? Promise.resolve();
  const next = previous.then(work);
  const settled = next.catch(() => undefined);
  siteQueues.set(siteId, settled);
  void settled.then(() => {
    if (siteQueues.get(siteId) === settled) siteQueues.delete(siteId);
  });
  return next;
}

async function foldUnqueued(siteId: string): Promise<FilesBase | null> {
  let raw: string | null;
  try {
    raw = await readFile(journalFile(siteId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    raw = null;
  }
  const base = parseBase(await readJsonOrNull(baseFile(siteId)));
  if (raw === null) return base;
  if (!base) {
    // Nothing to say which target the journal was written against, so it cannot be trusted.
    await rm(journalFile(siteId), { force: true });
    return null;
  }
  for (const event of parseJournal(raw)) applyEvent(base, event);
  await writePrivateJson(baseFile(siteId), base);
  await rm(journalFile(siteId), { force: true });
  return base;
}

/**
 * The site's base for this target, with any journal a stopped run left behind folded in first.
 * When there is no base yet, or it was recorded against another target, an empty one for this
 * target is written, so a journal opened afterwards always has the right base beneath it.
 */
export async function readBase(siteId: string, target: BaseTarget): Promise<FilesBase> {
  checkSiteId(siteId);
  return inSiteQueue(siteId, async () => {
    const base = await foldUnqueued(siteId);
    if (base && sameTarget(base.target, target)) return base;
    const fresh = emptyBase(target);
    await writePrivateJson(baseFile(siteId), fresh);
    return fresh;
  });
}

/**
 * The site's base for this target as it stands, with any journal applied in memory only. Nothing
 * is written or deleted, so it is safe while a run is appending to the journal: folding then
 * would delete the journal under the run, and the run's fold would lose what it finished. With
 * no base yet, or one for another target, it answers an empty base for this target.
 *
 * The journal is read before the base. A fold writes the base and then deletes the journal, so
 * read the other way round a fold in between could leave the old base and no journal; this way
 * round the worst case applies the same events twice, which changes nothing.
 */
export async function peekBase(siteId: string, target: BaseTarget): Promise<FilesBase> {
  checkSiteId(siteId);
  return inSiteQueue(siteId, async () => {
    let raw: string | null;
    try {
      raw = await readFile(journalFile(siteId), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = null;
    }
    const base = parseBase(await readJsonOrNull(baseFile(siteId)));
    if (!base || !sameTarget(base.target, target)) return emptyBase(target);
    if (raw !== null) for (const event of parseJournal(raw)) applyEvent(base, event);
    return base;
  });
}

/**
 * Opens the site's journal for a run. Call `readBase` with the run's target first, and
 * `foldJournal` once the journal is closed.
 */
export async function openJournal(siteId: string): Promise<FilesJournal> {
  const path = journalFile(siteId);
  await mkdir(basesDir(), { recursive: true });
  const handle: FileHandle = await open(path, 'a', 0o600);
  let pending: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    append: (event) => {
      if (closed) return Promise.reject(new Error('The journal is closed.'));
      const line = `${JSON.stringify(event)}\n`;
      const write = pending.then(() => handle.appendFile(line, 'utf-8'));
      pending = write.catch(() => undefined);
      return write;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pending;
      await handle.close();
    },
  };
}

/** Applies the journal to the base, writes the base, and deletes the journal. */
export async function foldJournal(siteId: string): Promise<FilesBase | null> {
  checkSiteId(siteId);
  return inSiteQueue(siteId, () => foldUnqueued(siteId));
}

/** Forgets what was deployed, keeping the target, so the next deploy is a first deploy. */
export async function resetBase(siteId: string): Promise<void> {
  checkSiteId(siteId);
  return inSiteQueue(siteId, async () => {
    const base = parseBase(await readJsonOrNull(baseFile(siteId)));
    await rm(journalFile(siteId), { force: true });
    if (base) await writePrivateJson(baseFile(siteId), emptyBase(base.target));
    else await rm(baseFile(siteId), { force: true });
  });
}

/** Deletes the base and the journal of a removed site. */
export async function removeBaseFiles(siteId: string): Promise<void> {
  checkSiteId(siteId);
  return inSiteQueue(siteId, async () => {
    await rm(journalFile(siteId), { force: true });
    await rm(baseFile(siteId), { force: true });
  });
}

/**
 * Folds every journal a stopped run left behind, at startup. Returns how many it found. Never
 * throws: a journal that cannot be folded now is tried again by the next `readBase`.
 */
export async function foldAllJournals(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(basesDir());
  } catch {
    return 0;
  }
  let found = 0;
  for (const name of names) {
    if (!name.endsWith(JOURNAL_SUFFIX)) continue;
    const siteId = name.slice(0, -JOURNAL_SUFFIX.length);
    if (!SITE_ID.test(siteId)) continue;
    found += 1;
    await foldJournal(siteId).catch(() => undefined);
  }
  return found;
}
