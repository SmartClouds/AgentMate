import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import { type HashCache, hashFile } from './hashFile';

/** The streamed SHA-256 both deploy walkers use, and the size and time cache in front of it. */

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('hashFile', () => {
  it('streams a file through SHA-256', async () => {
    const path = join(tempDir(), 'a.txt');
    writeFileSync(path, 'hello');
    expect(await hashFile(path, 5, 1)).toBe(sha('hello'));
  });

  it('reuses a cached hash while size and time are unchanged', async () => {
    const path = join(tempDir(), 'a.txt');
    writeFileSync(path, 'one');
    const cache: HashCache = new Map();
    expect(await hashFile(path, 3, 1, cache)).toBe(sha('one'));
    expect(cache.get(path)).toEqual({ size: 3, mtimeMs: 1, sha256: sha('one') });
    writeFileSync(path, 'two');
    expect(await hashFile(path, 3, 1, cache)).toBe(sha('one'));
    expect(await hashFile(path, 4, 1, cache)).toBe(sha('two'));
    expect(await hashFile(path, 3, 2, cache)).toBe(sha('two'));
  });

  it('can key the cache by another name, such as a path relative to a site', async () => {
    const path = join(tempDir(), 'a.txt');
    writeFileSync(path, 'one');
    const cache: HashCache = new Map([['css/a.txt', { size: 3, mtimeMs: 7, sha256: 'seeded' }]]);
    expect(await hashFile(path, 3, 7, cache, 'css/a.txt')).toBe('seeded');
    expect(await hashFile(path, 3, 8, cache, 'css/a.txt')).toBe(sha('one'));
    expect(cache.get('css/a.txt')?.mtimeMs).toBe(8);
    expect(cache.has(path)).toBe(false);
  });

  it('rejects when the file cannot be read', async () => {
    await expect(hashFile(join(tempDir(), 'missing.txt'), 1, 1)).rejects.toThrow();
  });
});
