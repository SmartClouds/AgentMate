import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { BlobStore } from './blobStore.js';

const tempDir = useTempDirs();

describe('BlobStore', () => {
  it('stores text by its sha256 under a two-letter folder and reads it back', async () => {
    const folder = await tempDir();
    const blobs = BlobStore.forVideo(folder);
    const hash = await blobs.put('سلام دنیا');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs.path(hash)).toBe(join(folder, 'blobs', hash.slice(0, 2), hash));
    expect(await blobs.text(hash)).toBe('سلام دنیا');
  });

  it('writes the same content once', async () => {
    const folder = await tempDir();
    const blobs = BlobStore.forVideo(folder);
    const a = await blobs.put(new Uint8Array([1, 2, 3]));
    const before = (await stat(blobs.path(a))).mtimeMs;
    const b = await blobs.put(new Uint8Array([1, 2, 3]));
    expect(b).toBe(a);
    expect((await stat(blobs.path(a))).mtimeMs).toBe(before);
    expect(await readdir(join(folder, 'blobs', a.slice(0, 2)))).toEqual([a]);
  });

  it('refuses anything that is not a hash, so no path can escape the folder', async () => {
    const blobs = BlobStore.forVideo(await tempDir());
    expect(() => blobs.path('../studio.db')).toThrow(/not a blob hash/);
    await expect(blobs.text('ab')).rejects.toThrow(/not a blob hash/);
  });
});
