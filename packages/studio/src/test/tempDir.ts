import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/** A fresh temp folder per test, removed afterwards. */
export function useTempDirs(): () => Promise<string> {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(
      made.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
    );
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-test-'));
    made.push(dir);
    return dir;
  };
}
