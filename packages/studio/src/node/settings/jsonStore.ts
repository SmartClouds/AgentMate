import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { readJsonFile, writeFileAtomic } from '../fs/atomicWrite.js';

/**
 * A small JSON file Studio owns (its settings, the list of known videos). Changes run one at a
 * time through `mutate`, and the file is only written when something changed. A file that does
 * not parse is copied aside before anything replaces it, so a bad write never costs the user what
 * was in it.
 */
export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly schema: z.ZodType<T>,
    private readonly defaults: () => T,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<T> {
    return (await this.load()).data;
  }

  /** Changes the data in place (or returns new data) and saves it. Resolves to the saved data. */
  mutate(change: (draft: T) => T | undefined | void): Promise<T> {
    const run = this.queue.then(async () => {
      const { data, broken } = await this.load();
      const before = JSON.stringify(data);
      const draft = structuredClone(data);
      const next = (change(draft) ?? draft) as T;
      const after = JSON.stringify(next);
      if (after === before) return next;
      if (broken) await copyFile(this.file, `${this.file}.broken-${this.now()}`);
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<{ data: T; broken: boolean }> {
    const read = await readJsonFile(this.file);
    if (read.state === 'missing') return { data: this.defaults(), broken: false };
    if (read.state === 'ok') {
      const parsed = this.schema.safeParse(read.value);
      if (parsed.success) return { data: parsed.data, broken: false };
    }
    return { data: this.defaults(), broken: true };
  }
}
