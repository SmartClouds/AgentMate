import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Keeps the render cache under its cap: scene chunk folders are deleted oldest first, by when a
 * render last used them (each render rewrites the folder's `inputs.json`). Folders the render that
 * just finished used are kept, so re-rendering it straight away costs nothing. Only the cache is
 * touched: history, blobs and finished videos live elsewhere.
 */
export async function pruneSceneCache(
  cacheRoot: string,
  capBytes: number,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const folders: { path: string; bytes: number; usedAt: number; kept: boolean }[] = [];
  for (const video of await readdir(cacheRoot).catch(() => [] as string[])) {
    const scenes = join(cacheRoot, video, 'scenes');
    for (const name of await readdir(scenes).catch(() => [] as string[])) {
      const path = join(scenes, name);
      let bytes = 0;
      let usedAt = 0;
      let kept = false;
      for (const file of await readdir(path).catch(() => [] as string[])) {
        const info = await stat(join(path, file)).catch(() => null);
        if (!info?.isFile()) continue;
        bytes += info.size;
        if (file === 'inputs.json') {
          usedAt = info.mtimeMs;
          kept = keep.has(await readFile(join(path, file), 'utf8').catch(() => ''));
        }
      }
      folders.push({ path, bytes, usedAt, kept });
    }
  }
  let total = folders.reduce((sum, f) => sum + f.bytes, 0);
  const removed: string[] = [];
  for (const folder of folders.filter((f) => !f.kept).sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= capBytes) break;
    await rm(folder.path, { recursive: true, force: true });
    total -= folder.bytes;
    removed.push(folder.path);
  }
  return removed;
}
