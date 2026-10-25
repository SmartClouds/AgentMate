import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { BlobStore } from '../blobs/blobStore.js';

/**
 * A scene's code as an immutable tree: every file stored as a blob, listed in a manifest that is
 * itself a blob, and named by the manifest's hash. The same code always has the same name, so a
 * revision is cheap, an old revision stays playable forever, and the scene server can serve a tree
 * by hash without ever touching the folder the AI wrote it in.
 */

export const ALLOWED_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.woff2',
  '.woff',
  '.ttf',
  '.otf',
  '.glb',
  '.gltf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.txt',
]);

export const TREE_LIMITS = {
  files: 500,
  fileBytes: 50 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
};

const manifestSchema = z.object({
  version: z.literal(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});
export type TreeManifest = z.infer<typeof manifestSchema>;

export interface ImportedTree {
  treeHash: string;
  manifest: TreeManifest;
  /** Files left out, with why: a type that is not allowed, a link, too big. */
  skipped: string[];
}

export class TreeImportError extends Error {
  override name = 'TreeImportError';
}

/** A path inside a tree: forward slashes, no leading slash, no `..` and nothing hidden. */
export function isSafeTreePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function canonical(manifest: TreeManifest): string {
  return JSON.stringify({
    version: 1,
    files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

/** Stores a manifest and returns the tree's hash, which is the manifest blob's hash. */
export async function storeTree(blobs: BlobStore, manifest: TreeManifest): Promise<string> {
  const parsed = manifestSchema.parse(manifest);
  for (const file of parsed.files) {
    if (!isSafeTreePath(file.path)) throw new TreeImportError(`${file.path} is not a safe path.`);
  }
  if (!parsed.files.some((f) => f.path === 'index.html')) {
    throw new TreeImportError('A scene needs an index.html.');
  }
  return blobs.put(canonical(parsed));
}

export async function readTree(blobs: BlobStore, treeHash: string): Promise<TreeManifest> {
  return manifestSchema.parse(JSON.parse(await blobs.text(treeHash)));
}

/**
 * Reads the folder an AI wrote a scene into and stores it as a tree. Only regular files with an
 * allowed type are taken; links are never followed, since one could point anywhere on the disk.
 * Dot files and folders (a CLI's own settings) are left out quietly.
 */
export async function importTree(dir: string, blobs: BlobStore): Promise<ImportedTree> {
  const files: TreeManifest['files'] = [];
  const skipped: string[] = [];
  let total = 0;

  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(folder, entry.name);
      const path = relative(dir, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        skipped.push(`${path}: links are not followed`);
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (!ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        skipped.push(`${path}: this type of file is not taken`);
        continue;
      }
      if (info.size > TREE_LIMITS.fileBytes) {
        skipped.push(`${path}: larger than ${TREE_LIMITS.fileBytes / 1024 / 1024} MB`);
        continue;
      }
      if (files.length >= TREE_LIMITS.files) {
        throw new TreeImportError(`A scene can hold at most ${TREE_LIMITS.files} files.`);
      }
      total += info.size;
      if (total > TREE_LIMITS.totalBytes) {
        throw new TreeImportError(
          `A scene can hold at most ${TREE_LIMITS.totalBytes / 1024 / 1024} MB of files.`,
        );
      }
      const bytes = await readFile(full);
      files.push({ path, hash: await blobs.put(bytes), size: bytes.length });
    }
  };
  await walk(dir);
  if (files.length === 0) throw new TreeImportError('The scene folder has no usable files.');
  const manifest: TreeManifest = { version: 1, files };
  const treeHash = await storeTree(blobs, manifest);
  return { treeHash, manifest: manifestSchema.parse(JSON.parse(canonical(manifest))), skipped };
}

/** A tree from in-memory files, as a CLI in text mode returns them. */
export async function treeFromFiles(
  files: { path: string; content: string | Uint8Array }[],
  blobs: BlobStore,
): Promise<ImportedTree> {
  const skipped: string[] = [];
  // A path given twice keeps its last version, as writing the files in order would.
  const entries = new Map<string, TreeManifest['files'][number]>();
  for (const file of files) {
    const path = file.path.replace(/^\.\//, '');
    if (!isSafeTreePath(path)) {
      skipped.push(`${file.path}: not a safe path`);
      continue;
    }
    if (!ALLOWED_EXTENSIONS.has(extname(path).toLowerCase())) {
      skipped.push(`${path}: this type of file is not taken`);
      continue;
    }
    const bytes =
      typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    entries.set(path, { path, hash: await blobs.put(bytes), size: bytes.length });
  }
  if (entries.size === 0) throw new TreeImportError('The answer had no usable files.');
  const manifest: TreeManifest = { version: 1, files: [...entries.values()] };
  const treeHash = await storeTree(blobs, manifest);
  return { treeHash, manifest: manifestSchema.parse(JSON.parse(canonical(manifest))), skipped };
}

/** Finds a file in a tree by its path, or undefined. */
export function treeFile(
  manifest: TreeManifest,
  path: string,
): TreeManifest['files'][number] | undefined {
  return isSafeTreePath(path) ? manifest.files.find((f) => f.path === path) : undefined;
}

/** The hash a manifest would get, without storing it. */
export function treeHashOf(manifest: TreeManifest): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}
