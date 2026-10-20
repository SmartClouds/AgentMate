import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { app, shell } from 'electron';
import { filesError } from '../../shared/deployFilesErrors';
import { isValidEntryName } from '../../shared/sftpNames';
import type { SftpListing, SftpLocalEntry, SftpLocalPlace } from '../../shared/sftpTypes';
import { type LocalRootsOptions, listLocalRoots } from '../fs/localRoots';
import { limiter } from '../util/limiter';
import { toLocalCodedError } from './errors';
import { safeLocalName } from './localNames';

/**
 * The local pane of the SFTP file manager (E25): this computer's places, folder listings, and
 * the few changes the pane makes itself (new folder, rename, delete). Failures are coded with
 * `toLocalCodedError`, naming the path.
 *
 * These functions do not sandbox anything on their own. The IPC layer passes a `guard`,
 * `(path) => localBrowse.assertEntryWritable(ownerId, path)` (see ./localBrowse.ts), which
 * judges each entry by the folder it is in, and every write runs each path it changes past it
 * before touching the disk. Listing needs no guard: reading
 * anywhere is the point of the pane, and the service records `listing.path` afterwards.
 */

/** Checks a path a write is about to change; rejects to stop it. */
export type LocalWriteGuard = (path: string) => Promise<unknown>;

export interface LocalWriteOptions {
  guard?: LocalWriteGuard;
}

/** Names Windows and its tools keep in folders as clutter; shown only with hidden files on. */
const HIDDEN_NAMES = new Set([
  'desktop.ini',
  'thumbs.db',
  '$recycle.bin',
  'system volume information',
]);
/** How many entries of one folder are stat'ed at once. */
const STAT_CONCURRENCY = 64;

const USER_PLACES = [
  { id: 'home', name: 'home', label: 'Home' },
  { id: 'desktop', name: 'desktop', label: 'Desktop' },
  { id: 'documents', name: 'documents', label: 'Documents' },
  { id: 'downloads', name: 'downloads', label: 'Downloads' },
] as const;

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function userFolder(name: (typeof USER_PLACES)[number]['name']): string | null {
  try {
    return app.getPath(name);
  } catch {
    // Electron throws for a folder the platform has no notion of.
    return null;
  }
}

/**
 * The Places menu: Home, Desktop, Documents and Downloads when they exist (each once), then every
 * drive on Windows, or `/` elsewhere. `options` is for tests, as in `listLocalRoots`.
 */
export async function localPlaces(options: LocalRootsOptions = {}): Promise<SftpLocalPlace[]> {
  const places: SftpLocalPlace[] = [];
  const seen = new Set<string>();
  for (const place of USER_PLACES) {
    const path = userFolder(place.name);
    if (!path || seen.has(resolve(path)) || !(await isFolder(path))) continue;
    seen.add(resolve(path));
    places.push({ id: place.id, label: place.label, path, kind: place.id });
  }
  for (const root of listLocalRoots(options)) {
    if (root.kind === 'drive') {
      const letter = root.path.charAt(0);
      places.push({
        id: `drive:${letter}`,
        label: `Drive (${letter}:)`,
        path: root.path,
        kind: 'drive',
      });
    } else if (root.kind === 'root') {
      places.push({ id: 'root', label: root.name, path: root.path, kind: 'root' });
    }
  }
  return places;
}

function isRoot(path: string): boolean {
  return parse(path).root === path;
}

function isHidden(name: string): boolean {
  return name.startsWith('.') || HIDDEN_NAMES.has(name.toLowerCase());
}

/**
 * One entry, links followed for what they lead to. A broken link (or junction) is listed as an
 * empty file, and an entry that cannot be looked at at all (`pagefile.sys` at the top of C:) as
 * an empty file with no time, so one bad entry never fails the folder.
 */
async function entryOf(dir: string, name: string): Promise<SftpLocalEntry> {
  const path = join(dir, name);
  const hidden = isHidden(name);
  let own: Stats;
  try {
    own = await lstat(path);
  } catch {
    return {
      name,
      path,
      isDirectory: false,
      isSymlink: false,
      size: 0,
      mtimeMs: 0,
      mode: null,
      hidden,
    };
  }
  const isSymlink = own.isSymbolicLink();
  let target: Stats | null = own;
  if (isSymlink) target = await stat(path).catch(() => null);
  const shown = target ?? own;
  const isDirectory = target?.isDirectory() ?? false;
  return {
    name,
    path,
    isDirectory,
    isSymlink,
    size: isDirectory || !target ? 0 : target.size,
    mtimeMs: Math.floor(shown.mtimeMs),
    mode: process.platform === 'win32' ? null : shown.mode & 0o7777,
    hidden,
  };
}

/**
 * A folder of this computer. `path` in the answer is `dir` resolved (links not followed), the
 * folder the service records as writable for the window. `folderMissing` when it is gone,
 * `invalidInput` for a file, `permissionDenied` when it may not be read. Entries come in the
 * order the disk gives them; the renderer sorts.
 */
export async function localList(dir: string): Promise<SftpListing<SftpLocalEntry>> {
  const path = resolve(dir);
  try {
    if (!(await stat(path)).isDirectory()) {
      throw filesError('invalidInput', `${path} is a file, not a folder.`);
    }
    const names = await readdir(path);
    const limit = limiter(STAT_CONCURRENCY);
    const entries = await Promise.all(names.map((name) => limit(() => entryOf(path, name))));
    return { path, parent: isRoot(path) ? null : dirname(path), entries };
  } catch (error) {
    throw toLocalCodedError(error, path);
  }
}

/** Refuses a name that is not one entry, or that this computer cannot hold (`a:b` on Windows). */
function assertName(name: string): void {
  if (!isValidEntryName(name) || safeLocalName(name).changed) {
    throw filesError('invalidInput', 'That name cannot be used for a file or folder here.');
  }
}

function assertNotRoot(path: string): void {
  if (isRoot(path)) {
    throw filesError('invalidInput', `${path} is the top of a drive and cannot be changed.`);
  }
}

/** `lstat`, or null when nothing is there. */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Makes `name` in `parent` and answers its path. `exists` when the name is taken. */
export async function localMkdir(
  parent: string,
  name: string,
  { guard }: LocalWriteOptions = {},
): Promise<string> {
  assertName(name);
  const folder = resolve(parent);
  const target = join(folder, name);
  await guard?.(target);
  try {
    await mkdir(target);
    return target;
  } catch (error) {
    // ENOENT here means the folder it goes in is gone, so that is the path to name.
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw toLocalCodedError(error, missing ? folder : target);
  }
}

/**
 * Renames `path` within its folder and answers the new path. `exists` when the new name is taken
 * (a rename would silently replace a file), except by `path` itself, so changing only the case
 * of a name works where names ignore case. The guard sees the old path and then the new one.
 */
export async function localRename(
  path: string,
  newName: string,
  { guard }: LocalWriteOptions = {},
): Promise<string> {
  assertName(newName);
  const source = resolve(path);
  assertNotRoot(source);
  const target = join(dirname(source), newName);
  await guard?.(source);
  await guard?.(target);
  try {
    const from = await lstat(source, { bigint: true });
    if (target === source) return target;
    const existing = await lstat(target, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const sameFile =
      existing !== null &&
      existing.ino === from.ino &&
      existing.dev === from.dev &&
      target.toLowerCase() === source.toLowerCase();
    if (existing && !sameFile) {
      throw filesError('exists', `${target} is already there.`);
    }
    await rename(source, target);
    return target;
  } catch (error) {
    throw toLocalCodedError(error, source);
  }
}

/**
 * Moves each path to the Trash (`shell.trashItem`), or with `permanent` removes it for good,
 * folders with everything inside. A link or junction is removed itself, never what it leads to.
 * Every path goes past the guard before anything is deleted. A path already gone is skipped, so
 * retrying a call that stopped halfway is safe. Stops at the first failure.
 */
export async function localDelete(
  paths: string[],
  { permanent, guard }: LocalWriteOptions & { permanent: boolean },
): Promise<void> {
  const targets = paths.map((path) => resolve(path));
  for (const target of targets) {
    assertNotRoot(target);
    await guard?.(target);
  }
  for (const target of targets) {
    try {
      if (!(await lstatOrNull(target))) continue;
      if (permanent) {
        await rm(target, { recursive: true, force: true });
      } else {
        await shell.trashItem(target).catch((error: unknown) => {
          if (typeof (error as { code?: unknown } | null)?.code === 'string') throw error;
          const reason = error instanceof Error ? error.message : String(error);
          throw filesError('server', `Could not move ${target} to the Trash: ${reason}`);
        });
      }
    } catch (error) {
      throw toLocalCodedError(error, target);
    }
  }
}
