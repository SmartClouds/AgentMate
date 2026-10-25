import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { pruneSceneCache } from './cachePrune.js';

const tempDir = useTempDirs();

async function folder(root: string, video: string, name: string, bytes: number, usedAt: number) {
  const dir = join(root, video, 'scenes', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'chunk-0000.mkv'), Buffer.alloc(bytes));
  await writeFile(join(dir, 'inputs.json'), `inputs of ${name}`);
  const when = new Date(usedAt);
  await utimes(join(dir, 'inputs.json'), when, when);
  return dir;
}

describe('pruneSceneCache', () => {
  it('deletes the least recently used scene folders until the cache fits, keeping the ones in use', async () => {
    const root = await tempDir();
    const oldest = await folder(root, 'v1', 'old', 1000, 1_000_000);
    await folder(root, 'v1', 'kept', 1000, 500_000);
    const middle = await folder(root, 'v2', 'middle', 1000, 2_000_000);
    await folder(root, 'v2', 'newest', 1000, 3_000_000);
    // Other files in the cache root (thumbnails, a stray file) are left alone.
    await writeFile(join(root, 'stray.txt'), 'x');

    const removed = await pruneSceneCache(root, 2200, new Set(['inputs of kept']));
    expect(removed).toEqual([oldest, middle]);
    expect(await readdir(join(root, 'v1', 'scenes'))).toEqual(['kept']);
    expect(await readdir(join(root, 'v2', 'scenes'))).toEqual(['newest']);
  });

  it('does nothing when the cache fits, or is not there yet', async () => {
    const root = await tempDir();
    await folder(root, 'v1', 'a', 100, 1_000_000);
    expect(await pruneSceneCache(root, 10_000, new Set())).toEqual([]);
    expect(await pruneSceneCache(join(root, 'missing'), 0, new Set())).toEqual([]);
  });

  it('keeps everything in use even when that alone is over the cap', async () => {
    const root = await tempDir();
    await folder(root, 'v1', 'a', 5000, 1_000_000);
    expect(await pruneSceneCache(root, 10, new Set(['inputs of a']))).toEqual([]);
  });
});
