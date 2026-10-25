import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useTempDirs } from '../../test/tempDir.js';
import { JsonStore } from './jsonStore.js';

const tempDir = useTempDirs();
const schema = z.object({ version: z.literal(1), count: z.number(), names: z.array(z.string()) });
type Data = z.infer<typeof schema>;
const defaults = (): Data => ({ version: 1, count: 0, names: [] });

async function store() {
  const dir = await tempDir();
  return {
    dir,
    file: join(dir, 'data.json'),
    s: new JsonStore(join(dir, 'data.json'), schema, defaults, () => 42),
  };
}

describe('JsonStore', () => {
  it('reads defaults while there is no file, without writing one', async () => {
    const { dir, s } = await store();
    expect(await s.read()).toEqual(defaults());
    expect(await readdir(dir)).toEqual([]);
  });

  it('saves a change and reads it back', async () => {
    const { file, s } = await store();
    await s.mutate((d) => {
      d.count = 3;
    });
    expect(await s.read()).toMatchObject({ count: 3 });
    expect(JSON.parse(await readFile(file, 'utf8')).count).toBe(3);
  });

  it('runs changes one after another, so none is lost', async () => {
    const { s } = await store();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.mutate((d) => {
          d.names.push(`n${i}`);
          d.count += 1;
        }),
      ),
    );
    const data = await s.read();
    expect(data.count).toBe(20);
    expect(data.names).toHaveLength(20);
  });

  it('keeps a broken file aside instead of overwriting it, and starts from defaults', async () => {
    const { dir, file, s } = await store();
    await writeFile(file, '{"version":1,"count":');
    expect(await s.read()).toEqual(defaults());
    await s.mutate((d) => {
      d.count = 1;
    });
    expect((await readdir(dir)).sort()).toEqual(['data.json', 'data.json.broken-42']);
    expect(await readFile(join(dir, 'data.json.broken-42'), 'utf8')).toBe('{"version":1,"count":');
  });

  it('treats a file that parses but does not fit the schema as broken', async () => {
    const { dir, file, s } = await store();
    await writeFile(file, '{"version":1,"count":"three"}');
    expect(await s.read()).toEqual(defaults());
    await s.mutate((d) => {
      d.count = 1;
    });
    expect(await readdir(dir)).toContain('data.json.broken-42');
  });

  it('keeps going after a change that throws', async () => {
    const { s } = await store();
    await expect(
      s.mutate(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await s.mutate((d) => {
      d.count = 5;
    });
    expect((await s.read()).count).toBe(5);
  });

  it('does not write when nothing changed', async () => {
    const { dir, s } = await store();
    await s.mutate(() => undefined);
    expect(await readdir(dir)).toEqual([]);
  });
});
