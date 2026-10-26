import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BaseMap,
  createFileSiteIgnoreRules,
  deniedReasonForSync,
  findWpCaseCollisions,
  type IgnoreLayer,
  type IgnoreRules,
  LEGACY_IGNORE_FILE,
  type LocalFileMap,
  syncPathFolder,
  validateSyncPath,
} from '@runova/core';
import { filesError } from '../../../shared/deployFilesErrors';
import type { FilesLeftOut, FilesLeftOutReason } from '../../../shared/deployFilesTypes';
import { type HashCache, hashFile } from '../hashFile';

/**
 * What an FTP or SFTP site's deploy folder holds on this computer (E23), in the shape the planner
 * reads. The rules are those of the WordPress walker (localManifest.ts), for a whole folder:
 * - the hard deny list (validateSyncPath) leaves agent settings, Runova's files, version
 *   control and secrets out, whatever any ignore file says; `php.ini` and `.user.ini` may go;
 * - the ignore layers (the folder's `.runovaignore`, then the site's own patterns) leave out
 *   what the user said, both ways;
 * - the default list leaves out build output and editor folders, unless the last deploy already
 *   sent the file;
 * - links (symlinks, junctions) are never followed or sent, and files too large, names that are
 *   not UTF-8, and names that differ only by case are left out.
 * Every path left out is reported, so the review can say so.
 */

export interface FilesWalkOptions {
  /** The deploy folder, absolute (the store already resolved any link in it). */
  root: string;
  /** The site's own ignore lines. */
  ignorePatterns: readonly string[];
  /** Paths in the base: the default ignore list does not apply to them. */
  tracked?: ReadonlySet<string>;
  /** Keyed by the path relative to the root; seedHashCache fills it from the base. */
  hashes?: HashCache;
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface FilesLocalWalk {
  /** False when the deploy folder is missing or is not a folder. */
  exists: boolean;
  files: LocalFileMap;
  /** Sorted by path. */
  leftOut: FilesLeftOut[];
  /** Every folder that holds a file to send, at any depth, sorted; the root (`''`) is not listed. */
  dirs: string[];
}

/** More files than this stops the walk: a site this large is better left to another tool. */
export const FILES_MAX_FILES = 50_000;
/** Uploads stream, so a large file is fine; past this one is left out. */
export const FILES_MAX_FILE_BYTES = 2 * 1024 ** 3;
/** A denied folder with more files than this is reported once, as `folder/`. */
const DENIED_LIST_MAX = 100;
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The base's hashes, keyed by relative path, so a file unchanged since the deploy is not read. */
export function seedHashCache(base: BaseMap, cache: HashCache = new Map()): HashCache {
  for (const [path, entry] of Object.entries(base)) {
    if (!cache.has(path)) {
      cache.set(path, { size: entry.size, mtimeMs: entry.localMtimeMs, sha256: entry.sha256 });
    }
  }
  return cache;
}

/**
 * The base without the paths a walk left out (ignored, too large, a link, a case collision, a
 * name that is not UTF-8). Such a file was not deleted here, it is only no longer sent, so it
 * must not plan as a delete on the server; it shows under Left out with its reason instead. A
 * left-out folder (`logs/`) covers every path under it.
 */
export function baseWithoutLeftOut(base: BaseMap, leftOut: readonly FilesLeftOut[]): BaseMap {
  if (leftOut.length === 0) return base;
  const left = new Set(leftOut.map((item) => item.path));
  const kept: BaseMap = {};
  for (const [path, entry] of Object.entries(base)) {
    let out = left.has(path);
    for (let end = path.indexOf('/'); !out && end >= 0; end = path.indexOf('/', end + 1)) {
      out = left.has(path.slice(0, end + 1));
    }
    if (!out) kept[path] = entry;
  }
  return kept;
}

async function isFolder(path: string): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  return info?.isDirectory() ?? false;
}

/**
 * The folder's own ignore file. One written before the app was renamed has the old name and still
 * counts; when both are there, `.runovaignore` is the one read.
 */
async function readOwnIgnoreFile(root: string): Promise<{ name: string; text: string } | null> {
  for (const name of ['.runovaignore', LEGACY_IGNORE_FILE]) {
    const path = join(root, name);
    const info = await lstat(path).catch(() => null);
    if (!info) continue;
    // A linked or oversized ignore file is not read: rules come only from files in the folder.
    if (!info.isFile() || info.size > MAX_IGNORE_FILE_BYTES) return null;
    return { name, text: await readFile(path, 'utf-8') };
  }
  return null;
}

/** The site's ignore layers, in order: the folder's .runovaignore, then the site's patterns. */
async function siteIgnoreRules(root: string, patterns: readonly string[]): Promise<IgnoreRules> {
  const own = await readOwnIgnoreFile(root);
  const layers: IgnoreLayer[] = [
    ...(own === null ? [] : [{ source: own.name, text: own.text, negations: true }]),
    { source: 'site settings', text: patterns.join('\n'), negations: true },
  ];
  const compiled = createFileSiteIgnoreRules(layers);
  if (!compiled.ok) {
    throw filesError(
      'invalidInput',
      `Line ${compiled.line} of ${compiled.source} cannot be read: ${compiled.reason}. Fix it and try again.`,
    );
  }
  return compiled.rules;
}

/** Up to DENIED_LIST_MAX files under a denied folder, or the folder itself when there are more. */
async function deniedEntries(
  absolute: string,
  path: string,
  reason: FilesLeftOutReason,
): Promise<FilesLeftOut[]> {
  const found: string[] = [];
  const visit = async (folder: string, prefix: string): Promise<boolean> => {
    const children = await readdir(folder, { withFileTypes: true }).catch(() => [] as Dirent[]);
    children.sort((a, b) => byPath(a.name, b.name));
    for (const child of children) {
      const childPath = `${prefix}/${child.name}`;
      if (child.isDirectory() && !child.isSymbolicLink()) {
        if (!(await visit(join(folder, child.name), childPath))) return false;
      } else {
        found.push(childPath);
        if (found.length > DENIED_LIST_MAX) return false;
      }
    }
    return true;
  };
  const complete = await visit(absolute, path);
  if (!complete || found.length === 0) return [{ path: `${path}/`, reason }];
  return found.map((entry) => ({ path: entry, reason }));
}

export async function walkSiteFolder(options: FilesWalkOptions): Promise<FilesLocalWalk> {
  const { root } = options;
  const tracked = options.tracked ?? new Set<string>();
  const maxFiles = options.maxFiles ?? FILES_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? FILES_MAX_FILE_BYTES;
  const walk: FilesLocalWalk = { exists: false, files: {}, leftOut: [], dirs: [] };
  if (!(await isFolder(root))) return walk;
  walk.exists = true;
  const rules = await siteIgnoreRules(root, options.ignorePatterns);
  const leaveOut = (path: string, reason: FilesLeftOutReason) =>
    walk.leftOut.push({ path, reason });

  const trackedFolders = new Set<string>();
  for (const path of tracked) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      trackedFolders.add(parts.slice(0, index).join('/'));
    }
  }
  let count = 0;

  const visit = async (folder: string, prefix: string): Promise<void> => {
    options.signal?.throwIfAborted();
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => byPath(a.name, b.name));
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(folder, child.name);
      const isFolder = child.isDirectory() && !child.isSymbolicLink();
      if (child.name.includes('\ufffd')) {
        leaveOut(isFolder ? `${path}/` : path, 'notUtf8');
        continue;
      }
      const check = validateSyncPath(path);
      if (!check.ok) {
        if (check.reason === 'hardDenied') {
          const reason = deniedReasonForSync(path);
          if (isFolder) walk.leftOut.push(...(await deniedEntries(absolute, path, reason)));
          else leaveOut(path, reason);
        } else {
          leaveOut(isFolder ? `${path}/` : path, 'invalidPath');
        }
        continue;
      }
      if (child.isSymbolicLink()) {
        leaveOut(path, 'symlink');
        continue;
      }
      if (isFolder) {
        const userExcluded = rules.excluded(path);
        const defaultExcluded = !userExcluded && rules.excludedUnlessTracked(path);
        if (
          (userExcluded || (defaultExcluded && !trackedFolders.has(path))) &&
          rules.canSkipFolder(path)
        ) {
          leaveOut(`${path}/`, 'ignored');
          continue;
        }
        await visit(absolute, path);
        continue;
      }
      if (!child.isFile()) {
        leaveOut(path, 'invalidPath');
        continue;
      }
      if (rules.excluded(path) || (rules.excludedUnlessTracked(path) && !tracked.has(path))) {
        leaveOut(path, 'ignored');
        continue;
      }
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        leaveOut(path, 'symlink');
        continue;
      }
      if (info.size > maxFileBytes) {
        leaveOut(path, 'tooLarge');
        continue;
      }
      count += 1;
      if (count > maxFiles) {
        throw filesError(
          'tooManyFiles',
          `The deploy folder holds more than ${maxFiles} files, more than Runova sends for one site. Leave folders the server does not need out with .runovaignore or the site's ignore patterns.`,
        );
      }
      options.signal?.throwIfAborted();
      walk.files[path] = {
        sha256: await hashFile(absolute, info.size, info.mtimeMs, options.hashes, path),
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }
  };
  await visit(root, '');

  for (const group of findWpCaseCollisions(Object.keys(walk.files))) {
    for (const path of group) {
      delete walk.files[path];
      leaveOut(path, 'caseCollision');
    }
  }
  walk.leftOut.sort((a, b) => byPath(a.path, b.path) || byPath(a.reason, b.reason));

  const dirs = new Set<string>();
  for (const path of Object.keys(walk.files)) {
    for (let folder = syncPathFolder(path); folder !== ''; folder = syncPathFolder(folder)) {
      if (dirs.has(folder)) break;
      dirs.add(folder);
    }
  }
  walk.dirs = [...dirs].sort(byPath);

  // The cache only keeps what was sent, so files deleted or left out do not pile up in it.
  if (options.hashes) {
    for (const path of options.hashes.keys()) {
      if (!(path in walk.files)) options.hashes.delete(path);
    }
  }
  return walk;
}
