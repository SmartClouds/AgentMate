import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { readJsonFile, writeFileAtomic } from './atomicWrite.js';

const tempDir = useTempDirs();

describe('writeFileAtomic', () => {
  it('writes a new file and replaces an existing one', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
  });

  it('leaves no temp file behind', async () => {
    const dir = await tempDir();
    await writeFileAtomic(join(dir, 'a.json'), 'x');
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('fails without touching anything when the folder is missing', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.json');
    await writeFile(file, 'old');
    await expect(writeFileAtomic(join(dir, 'missing', 'a.json'), 'new')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('old');
  });

  it('retries a rename Windows refuses for a moment, as an indexer or antivirus causes', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.json');
    let calls = 0;
    await writeFileAtomic(file, 'x', {
      rename: async (from, to) => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
        await rename(from, to);
      },
    });
    expect(calls).toBe(3);
    expect(await readFile(file, 'utf8')).toBe('x');
  });

  it('gives up after a few tries, keeps the old file and removes its temp file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'a.json');
    await writeFile(file, 'old');
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    await expect(
      writeFileAtomic(file, 'x', { rename: async () => Promise.reject(busy) }),
    ).rejects.toThrow('busy');
    expect(await readdir(dir)).toEqual(['a.json']);
    expect(await readFile(file, 'utf8')).toBe('old');
  });

  it('does not retry an error that waiting will not fix', async () => {
    const dir = await tempDir();
    let calls = 0;
    const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
    await expect(
      writeFileAtomic(join(dir, 'a.json'), 'x', {
        rename: async () => {
          calls += 1;
          throw gone;
        },
      }),
    ).rejects.toThrow('gone');
    expect(calls).toBe(1);
  });
});

describe('readJsonFile', () => {
  it('reads JSON, and says "missing" or "broken" instead of throwing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'ok.json'), '{"a":1}');
    await writeFile(join(dir, 'torn.json'), '{"a":');
    expect(await readJsonFile(join(dir, 'ok.json'))).toEqual({ state: 'ok', value: { a: 1 } });
    expect(await readJsonFile(join(dir, 'torn.json'))).toEqual({ state: 'broken' });
    expect(await readJsonFile(join(dir, 'none.json'))).toEqual({ state: 'missing' });
  });

  it('throws when the path cannot be read for another reason', async () => {
    const dir = await tempDir();
    await expect(readJsonFile(dir)).rejects.toThrow();
  });
});
