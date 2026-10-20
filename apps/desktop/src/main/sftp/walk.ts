import type { Stats } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { filesError } from '../../shared/deployFilesErrors';
import {
  baseName,
  joinRemote,
  normalizeRemote,
  parentOf,
} from '../deploy/files/transport/remotePath';
import { limiter } from '../util/limiter';
import type { SftpDetailedEntry, SftpFileClient } from './client';

/**
 * The recursive walks behind folder uploads and downloads (E25), one for this computer and one
 * for the server. Both list what is below a folder, pre-order (a folder before what it holds) and
 * by name within a folder, with paths relative to it and `/` between the parts.
 *
 * Links are leaves (D12): a link to a file counts as that file, but a link to a folder is never
 * descended into, and neither is a broken link; both are reported in `skippedLinks` instead, so
 * a transfer can show them as skipped. A file or folder that vanishes while the walk runs is
 * left out. The walk stops with `[files:tooManyFiles]` past `maxItems` and `[files:cancelled]`
 * when its signal aborts.
 */

export interface WalkItem {
  /** Below the folder walked, `/` between the parts: `css/site.css`. */
  relPath: string;
  isDirectory: boolean;
  /** Bytes; 0 for folders. A link's are its target's. */
  size: number;
  mtimeMs: number;
  /** Permission bits; null for local files on Windows, where they mean nothing. */
  mode: number | null;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** Past this many items the walk fails with `[files:tooManyFiles]`. Default unlimited. */
  maxItems?: number;
}

export interface WalkResult {
  items: WalkItem[];
  /** Links to folders and broken links that were not followed, sorted. */
  skippedLinks: string[];
}

/** The file system calls the local walk makes, so a test can make files vanish. */
export interface LocalWalkFs {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
}

/** How many remote folders are listed at once. */
export const REMOTE_LISTINGS_IN_FLIGHT = 8;
/** SFTP's "no such file" status, as ssh2 puts it on `error.code`. */
const SFTP_NO_SUCH_FILE = 2;

const nodeFs: LocalWalkFs = {
  readdir: (path) => readdir(path),
  lstat,
  stat,
};

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isNoSuchRemoteFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SFTP_NO_SUCH_FILE;
}

function cancelled(): Error {
  return filesError('cancelled', 'The walk through the folder was cancelled.');
}

function tooMany(maxItems: number): Error {
  return filesError(
    'tooManyFiles',
    `The selection holds more than ${maxItems.toLocaleString('en-US')} files and folders, more than one transfer takes. Pick fewer at a time.`,
  );
}

/** Counts items against the cap, and remembers the first reason to stop for every branch. */
class WalkGuard {
  private count = 0;
  private failure: Error | null = null;

  constructor(private readonly options: WalkOptions) {}

  check(): void {
    if (this.options.signal?.aborted) throw cancelled();
    if (this.failure) throw this.failure;
  }

  counted(): void {
    this.count += 1;
    const max = this.options.maxItems;
    if (max !== undefined && this.count > max) {
      this.failure = tooMany(max);
      throw this.failure;
    }
  }

  fail(error: unknown): never {
    this.failure ??= error as Error;
    throw error;
  }
}

/** Everything below `root` on this computer. */
export async function walkLocal(
  root: string,
  options: WalkOptions & { fs?: LocalWalkFs },
): Promise<WalkResult> {
  const fs = options.fs ?? nodeFs;
  const guard = new WalkGuard(options);
  const items: WalkItem[] = [];
  const skippedLinks: string[] = [];
  const modeOf = (info: Stats): number | null =>
    process.platform === 'win32' ? null : info.mode & 0o7777;

  const visit = async (folder: string, prefix: string): Promise<void> => {
    guard.check();
    let names: string[];
    try {
      names = await fs.readdir(folder);
    } catch (error) {
      if (!isGone(error)) throw error;
      if (prefix === '') {
        throw filesError('folderMissing', `${folder} is not on this computer any more.`);
      }
      return;
    }
    names.sort(byName);
    for (const name of names) {
      guard.check();
      const relPath = prefix ? `${prefix}/${name}` : name;
      const absolute = join(folder, name);
      let info: Stats;
      try {
        info = await fs.lstat(absolute);
      } catch (error) {
        if (isGone(error)) continue;
        throw error;
      }
      if (info.isSymbolicLink()) {
        const target = await fs.stat(absolute).catch(() => null);
        if (!target?.isFile()) {
          skippedLinks.push(relPath);
          continue;
        }
        info = target;
      }
      if (info.isDirectory()) {
        guard.counted();
        items.push({
          relPath,
          isDirectory: true,
          size: 0,
          mtimeMs: info.mtimeMs,
          mode: modeOf(info),
        });
        await visit(absolute, relPath);
      } else if (info.isFile()) {
        guard.counted();
        items.push({
          relPath,
          isDirectory: false,
          size: info.size,
          mtimeMs: info.mtimeMs,
          mode: modeOf(info),
        });
      }
    }
  };
  await visit(root, '');
  return { items, skippedLinks: skippedLinks.sort(byName) };
}

/**
 * Everything below `root` on the server, with at most `REMOTE_LISTINGS_IN_FLIGHT` listings at
 * once. A subfolder that is gone by the time it is listed is left out; any other listing failure,
 * and the root missing, rejects with the client's own error.
 */
export async function walkRemote(
  client: SftpFileClient,
  root: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const guard = new WalkGuard(options);
  const limit = limiter(REMOTE_LISTINGS_IN_FLIGHT);
  const skippedLinks: string[] = [];

  const visit = async (folder: string, prefix: string): Promise<WalkItem[]> => {
    guard.check();
    let entries: SftpDetailedEntry[];
    try {
      entries = await limit(() => {
        guard.check();
        return client.sftpListDetailed(folder);
      });
    } catch (error) {
      if (prefix !== '' && isNoSuchRemoteFile(error)) return [];
      return guard.fail(error);
    }
    guard.check();
    entries.sort((a, b) => byName(a.name, b.name));
    const parts: (WalkItem | Promise<WalkItem[]>)[] = [];
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymlink && (entry.brokenLink || entry.isDirectory)) {
        skippedLinks.push(relPath);
        continue;
      }
      if (!entry.isDirectory && !entry.isFile) continue;
      guard.counted();
      parts.push({
        relPath,
        isDirectory: entry.isDirectory,
        size: entry.isDirectory ? 0 : entry.size,
        mtimeMs: entry.mtimeMs,
        mode: entry.mode,
      });
      if (entry.isDirectory) parts.push(visit(joinRemote(folder, entry.name), relPath));
    }
    const settled = await Promise.all(parts);
    return settled.flat();
  };
  const items = await visit(normalizeRemote(root), '');
  return { items, skippedLinks: skippedLinks.sort(byName) };
}

/** Listings of folders by path, shared by lookups that would otherwise list one folder twice. */
export type RemoteListingCache = Map<string, Promise<SftpDetailedEntry[]>>;

/**
 * One remote entry as its folder lists it, so a link shows as a link (a stat would follow it).
 * Null when it, or the folder it would be in, is not there. `/` comes from a stat.
 */
export async function remoteEntryOf(
  client: SftpFileClient,
  path: string,
  cache?: RemoteListingCache,
): Promise<SftpDetailedEntry | null> {
  const normalized = normalizeRemote(path);
  const folder = parentOf(normalized);
  if (folder === null) {
    const info = await client.sftpStat('/');
    if (!info) return null;
    return { name: '/', ...info, isSymlink: false, brokenLink: false, longname: '' };
  }
  let listing = cache?.get(folder);
  if (!listing) {
    listing = client.sftpListDetailed(folder);
    cache?.set(folder, listing);
  }
  let entries: SftpDetailedEntry[];
  try {
    entries = await listing;
  } catch (error) {
    if (isNoSuchRemoteFile(error)) return null;
    throw error;
  }
  const name = baseName(normalized);
  return entries.find((entry) => entry.name === name) ?? null;
}
