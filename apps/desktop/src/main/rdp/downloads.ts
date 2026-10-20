import { randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/**
 * Writes files copied on the remote server into a folder the user picked. Names come from the
 * server, so every path component is cleaned and the result has to land inside that folder.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** One path component made safe on every OS. `null` for components that should be dropped. */
export function safeComponent(component: string): string | null {
  const trimmed = component.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  // A drive letter like `C:` at the start of a remote path carries no meaning here.
  if (/^[A-Za-z]:$/.test(trimmed)) return null;
  let cleaned = trimmed.replace(/[<>:"/\\|?*]/g, '_');
  cleaned = [...cleaned].map((char) => (char.charCodeAt(0) < 32 ? '_' : char)).join('');
  // Windows ignores trailing dots and spaces, which could make two names collide.
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (!cleaned) return null;
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}

/** Splits a remote relative folder (`a\b` or `a/b`) into safe components. */
export function safeRelativePath(path: string | undefined): string[] {
  if (!path) return [];
  return path
    .split(/[\\/]/)
    .map(safeComponent)
    .filter((part): part is string => part !== null);
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

interface Download {
  ownerId: number;
  folder: string;
  /** Top-level names from the server mapped to the name used on disk, after collisions. */
  rootNames: Map<string, string>;
  taken: Set<string>;
  files: Map<number, { handle: FileHandle; partPath: string; finalPath: string }>;
}

const downloads = new Map<string, Download>();

export function beginDownload(ownerId: number, folder: string): string {
  const downloadId = randomUUID();
  downloads.set(downloadId, {
    ownerId,
    folder: resolve(folder),
    rootNames: new Map(),
    taken: new Set(),
    files: new Map(),
  });
  return downloadId;
}

function get(downloadId: string, ownerId: number): Download {
  const download = downloads.get(downloadId);
  if (!download || download.ownerId !== ownerId) throw new Error('Unknown download.');
  return download;
}

async function uniqueRootName(download: Download, name: string): Promise<string> {
  const known = download.rootNames.get(name);
  if (known) return known;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let candidate = name;
  for (
    let n = 1;
    download.taken.has(candidate.toLowerCase()) || (await exists(join(download.folder, candidate)));
    n++
  ) {
    candidate = `${stem} (${n})${extension}`;
  }
  download.rootNames.set(name, candidate);
  download.taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Creates a folder entry, or opens a `.part` file for a file entry. Returns the final path so
 * the window can show where things went.
 */
export async function prepareEntry(
  downloadId: string,
  ownerId: number,
  index: number,
  entry: { name: string; path?: string; isDirectory: boolean },
): Promise<string> {
  const download = get(downloadId, ownerId);
  const name = safeComponent(entry.name) ?? 'unnamed';
  const parents = safeRelativePath(entry.path);

  let components: string[];
  if (parents.length === 0) {
    components = [await uniqueRootName(download, name)];
  } else {
    const [root, ...rest] = parents;
    components = [await uniqueRootName(download, root), ...rest, name];
  }

  const finalPath = resolve(download.folder, ...components);
  if (!finalPath.startsWith(download.folder + sep)) throw new Error('Refused an unsafe file name.');

  if (entry.isDirectory) {
    await mkdir(finalPath, { recursive: true });
    return finalPath;
  }

  await mkdir(resolve(finalPath, '..'), { recursive: true });
  const partPath = `${finalPath}.part`;
  const handle = await open(partPath, 'w');
  download.files.set(index, { handle, partPath, finalPath });
  return finalPath;
}

export async function writeChunk(
  downloadId: string,
  ownerId: number,
  index: number,
  bytes: Uint8Array,
): Promise<void> {
  const file = get(downloadId, ownerId).files.get(index);
  if (!file) throw new Error('This file was not prepared for download.');
  await file.handle.write(bytes);
}

export async function finishFile(
  downloadId: string,
  ownerId: number,
  index: number,
  ok: boolean,
): Promise<void> {
  const download = get(downloadId, ownerId);
  const file = download.files.get(index);
  if (!file) return;
  download.files.delete(index);
  await file.handle.close();
  if (ok) await rename(file.partPath, file.finalPath);
  else await rm(file.partPath, { force: true });
}

export function downloadFolder(downloadId: string, ownerId: number): string {
  return get(downloadId, ownerId).folder;
}

/**
 * The top-level files and folders a download has put (or is putting) in its folder, under the
 * names they ended up with. What gets copied to the clipboard when the download is a staging one.
 */
export function downloadRoots(downloadId: string, ownerId: number): string[] {
  const download = get(downloadId, ownerId);
  return [...download.rootNames.values()].map((name) => join(download.folder, name));
}

/** Drops a finished download's bookkeeping. The files on disk stay where they are. */
export function forgetDownload(downloadId: string, ownerId: number): void {
  get(downloadId, ownerId);
  downloads.delete(downloadId);
}

/** Closes and removes unfinished files of every download a closed window owned. */
export async function abandonDownloads(ownerId: number): Promise<void> {
  for (const [downloadId, download] of downloads) {
    if (download.ownerId !== ownerId) continue;
    downloads.delete(downloadId);
    for (const file of download.files.values()) {
      await file.handle.close().catch(() => undefined);
      await rm(file.partPath, { force: true }).catch(() => undefined);
    }
  }
}
