import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

/**
 * Path helpers for files on a server (E23). Every path a transport takes is absolute and POSIX,
 * whatever this computer runs, so they all go through `posix` here instead of `node:path`.
 */

/** `/srv/site/` and `/srv//site` both become `/srv/site`; `/` stays `/`. */
export function normalizeRemote(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function joinRemote(dir: string, ...names: string[]): string {
  return normalizeRemote(posix.join(dir, ...names));
}

/** The folder a path is in; null for `/`. */
export function parentOf(path: string): string | null {
  const normalized = normalizeRemote(path);
  return normalized === '/' ? null : posix.dirname(normalized);
}

export function baseName(path: string): string {
  return posix.basename(normalizeRemote(path));
}

/**
 * Every folder from the top down to `path` itself: `/srv/site/css` gives `/srv`, `/srv/site` and
 * `/srv/site/css`. Empty for `/`.
 */
export function folderChain(path: string): string[] {
  const segments = normalizeRemote(path).split('/').filter(Boolean);
  return segments.map((_segment, index) => `/${segments.slice(0, index + 1).join('/')}`);
}

/**
 * The temporary name an upload goes to before it takes the real one: in the same folder, so the
 * rename never crosses a file system, and without a leading dot, since some FTP servers hide or
 * refuse dot files. It matches `PART_FILE` in types.ts.
 */
export function partPathFor(remotePath: string, random = randomBytes(4).toString('hex')): string {
  return `${normalizeRemote(remotePath)}.runova-${random}.part`;
}

/** Where the old file waits while a replace moves it aside. It matches `BACKUP_FILE` in types.ts. */
export function backupPathFor(remotePath: string, random = randomBytes(4).toString('hex')): string {
  return `${normalizeRemote(remotePath)}.runova-${random}.old`;
}
