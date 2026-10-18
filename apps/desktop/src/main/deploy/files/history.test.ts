import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FilesHistoryEntry } from '../../../shared/deployFilesTypes';
import { useTempUserData } from '../../../test/main/ipcHarness';

/** The recent deploys of each site, newest first, kept to the last 50. */

const userData = useTempUserData();
let history: typeof import('./history');

function run(index: number, overrides: Partial<FilesHistoryEntry> = {}): FilesHistoryEntry {
  return {
    runId: `run-${index}`,
    siteId: 's1',
    trigger: 'user',
    state: 'done',
    startedAt: index * 1000,
    finishedAt: index * 1000 + 500,
    uploaded: 2,
    deleted: 1,
    adopted: 0,
    skipped: 0,
    bytes: 1234,
    failed: [],
    atomic: true,
    error: null,
    ...overrides,
  };
}

function historyFile(siteId: string): string {
  return join(userData.dir, 'data', 'deploy-files', 'history', `${siteId}.json`);
}

beforeEach(async () => {
  history = await import('./history');
});

describe('history', () => {
  it('starts empty', async () => {
    expect(await history.readHistory('s1')).toEqual([]);
  });

  it('keeps the newest run first', async () => {
    await history.appendHistory('s1', run(1));
    await history.appendHistory('s1', run(2, { state: 'partial', failed: [] }));
    expect((await history.readHistory('s1')).map((entry) => entry.runId)).toEqual([
      'run-2',
      'run-1',
    ]);
  });

  it('keeps the last 50 runs', async () => {
    for (let index = 0; index < 55; index += 1) await history.appendHistory('s1', run(index));
    const entries = await history.readHistory('s1');
    expect(entries).toHaveLength(50);
    expect(entries[0].runId).toBe('run-54');
    expect(entries[49].runId).toBe('run-5');
  });

  it('loses nothing when runs finish at the same moment', async () => {
    await Promise.all([1, 2, 3].map((index) => history.appendHistory('s1', run(index))));
    expect(await history.readHistory('s1')).toHaveLength(3);
  });

  it('keeps each site apart', async () => {
    await history.appendHistory('s1', run(1));
    await history.appendHistory('s2', run(2, { siteId: 's2' }));
    expect((await history.readHistory('s1')).map((entry) => entry.runId)).toEqual(['run-1']);
  });

  it('reads a file that is not JSON as empty, and drops malformed entries', async () => {
    mkdirSync(join(userData.dir, 'data', 'deploy-files', 'history'), { recursive: true });
    writeFileSync(historyFile('s1'), '{ nope', 'utf-8');
    expect(await history.readHistory('s1')).toEqual([]);
    writeFileSync(
      historyFile('s1'),
      JSON.stringify([run(1), { runId: 5 }, 'nonsense', run(2, { state: 'exploded' as never })]),
      'utf-8',
    );
    expect((await history.readHistory('s1')).map((entry) => entry.runId)).toEqual(['run-1']);
  });

  it('removes the history of a removed site', async () => {
    await history.appendHistory('s1', run(1));
    await history.removeHistory('s1');
    expect(await history.readHistory('s1')).toEqual([]);
    await expect(history.removeHistory('never')).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('is readable only by the user', async () => {
    await history.appendHistory('s1', run(1));
    expect(statSync(historyFile('s1')).mode & 0o777).toBe(0o600);
  });
});
