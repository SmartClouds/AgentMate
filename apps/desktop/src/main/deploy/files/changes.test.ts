import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BaseEntry, BaseMap, LocalFileMap } from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import { filesError } from '../../../shared/deployFilesErrors';
import type { FilesChangesSnapshot, FilesLeftOut } from '../../../shared/deployFilesTypes';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { BaseTarget, FilesBase } from './bases';
import { type ChangesDeps, createChangesService } from './changes';
import { type FilesLocalWalk, type FilesWalkOptions, walkSiteFolder } from './localWalk';
import type { FolderSettleReason } from './siteWatcher';
import type { StoredFileSite } from './types';

/**
 * The live list of what changed in a site's deploy folder since the last deploy: walked when a
 * window first asks and again when the folder settles, published only when the list changed, and
 * never a list of deletes when the folder is simply gone.
 */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function site(overrides: Partial<StoredFileSite> = {}): StoredFileSite {
  return {
    id: 'site1',
    label: 'Site',
    protocol: 'sftp',
    connection: { kind: 'saved', sshServerId: 'server1' },
    remoteRoot: '/var/www',
    localFolder: '/work/site',
    projectIds: [],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    capabilities: null,
    lastDeploy: null,
    needsReview: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function entry(sha256: string, size: number): BaseEntry {
  return { sha256, size, localMtimeMs: 10, remote: null };
}

function walked(files: LocalFileMap, leftOut: FilesLeftOut[] = []): FilesLocalWalk {
  return { exists: true, files, leftOut, dirs: [] };
}

/** A walk that answers with `result` (or throws it), optionally held until `release`. */
function fakeWalk(initial: FilesLocalWalk | Error) {
  let result = initial;
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let running = 0;
  let maxRunning = 0;
  const calls: FilesWalkOptions[] = [];
  const walk = vi.fn(async (options: FilesWalkOptions) => {
    calls.push(options);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (gate) await gate;
      if (result instanceof Error) throw result;
      return structuredClone(result);
    } finally {
      running -= 1;
    }
  });
  return {
    walk,
    calls,
    get maxRunning() {
      return maxRunning;
    },
    set: (next: FilesLocalWalk | Error) => {
      result = next;
    },
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      open?.();
    },
  };
}

function fakeWatch() {
  const watchers: {
    root: string;
    onSettle: (reason: FolderSettleReason) => void;
    closed: boolean;
  }[] = [];
  const watch = vi.fn((root: string, onSettle: (reason: FolderSettleReason) => void) => {
    const watcher = { root, onSettle, closed: false };
    watchers.push(watcher);
    return {
      close: () => {
        watcher.closed = true;
      },
    };
  });
  return {
    watch,
    watchers,
    open: () => watchers.filter((watcher) => !watcher.closed),
    settle: (reason: FolderSettleReason = 'change') => {
      for (const watcher of watchers) if (!watcher.closed) watcher.onSettle(reason);
    },
  };
}

/** Lets the service's walks run to the end. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup(
  options: { walk?: FilesLocalWalk | Error; base?: BaseMap; sites?: StoredFileSite[] } = {},
) {
  const walk = fakeWalk(options.walk ?? walked({}));
  const watch = fakeWatch();
  let baseFiles: BaseMap = options.base ?? {};
  const sites = new Map((options.sites ?? [site()]).map((each) => [each.id, each]));
  const publish = vi.fn<(siteId: string, snapshot: FilesChangesSnapshot) => void>();
  const readBase = vi.fn(
    async (_siteId: string, target: BaseTarget): Promise<FilesBase> => ({
      version: 1,
      target,
      files: structuredClone(baseFiles),
      createdDirs: [],
    }),
  );
  let clock = 1000;
  const deps: ChangesDeps = {
    getSite: async (id) => sites.get(id) ?? null,
    walk: walk.walk,
    readBase,
    watch: watch.watch,
    now: () => clock,
    publish,
  };
  const service = createChangesService(deps);
  return {
    service,
    walk,
    watch,
    publish,
    readBase,
    sites,
    setBase: (files: BaseMap) => {
      baseFiles = files;
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('subscribing', () => {
  it('walks on the first subscribe and returns the pending changes', async () => {
    const t = setup({
      base: { 'index.html': entry(SHA_A, 10), 'old.css': entry(SHA_B, 7) },
      walk: walked({
        'index.html': { sha256: SHA_C, size: 12, mtimeMs: 20 },
        'new.js': { sha256: SHA_A, size: 30, mtimeMs: 20 },
        'same.txt': { sha256: SHA_B, size: 4, mtimeMs: 20 },
      }),
    });
    t.setBase({
      'index.html': entry(SHA_A, 10),
      'old.css': entry(SHA_B, 7),
      'same.txt': entry(SHA_B, 4),
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot).toEqual({
      siteId: 'site1',
      computedAt: 1000,
      state: 'ready',
      error: null,
      files: [
        { path: 'index.html', change: 'modified', size: 12 },
        { path: 'new.js', change: 'added', size: 30 },
        { path: 'old.css', change: 'deleted', size: 7 },
      ],
      totals: { added: 1, modified: 1, deleted: 1, bytes: 42 },
      leftOut: [],
      leftOutTruncated: false,
      localFileCount: 3,
      baseFileCount: 3,
      firstDeploy: false,
    });
    expect(t.watch.watch).toHaveBeenCalledWith('/work/site', expect.any(Function));
    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.service.snapshot('site1')).toEqual(snapshot);
  });

  it('walks with the site rules, the base paths as tracked and a hash cache from the base', async () => {
    const t = setup({
      sites: [site({ ignorePatterns: ['*.map'] })],
      base: { 'dist/app.js': entry(SHA_A, 10) },
      walk: walked({ 'dist/app.js': { sha256: SHA_A, size: 10, mtimeMs: 10 } }),
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    const options = t.walk.calls[0];
    expect(options.root).toBe('/work/site');
    expect(options.ignorePatterns).toEqual(['*.map']);
    expect([...(options.tracked ?? [])]).toEqual(['dist/app.js']);
    expect(options.hashes?.get('dist/app.js')).toEqual({ size: 10, mtimeMs: 10, sha256: SHA_A });
    expect(t.readBase).toHaveBeenCalledWith('site1', {
      protocol: 'sftp',
      host: 'saved:server1',
      port: null,
      username: null,
      remoteRoot: '/var/www',
      localFolder: '/work/site',
    });
    expect(snapshot.files).toEqual([]);
    expect(snapshot.firstDeploy).toBe(false);
  });

  it('keeps one hash cache per site across walks', async () => {
    const t = setup({ base: { 'a.html': entry(SHA_A, 1) } });
    await t.service.subscribe('site1', 'window1');
    await t.service.refresh('site1');
    expect(t.walk.calls[1].hashes).toBe(t.walk.calls[0].hashes);
  });

  it('gives a second subscriber the cached snapshot without walking', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }) });
    const first = await t.service.subscribe('site1', 'window1');
    const second = await t.service.subscribe('site1', 'window2');
    expect(second).toEqual(first);
    expect(t.walk.walk).toHaveBeenCalledTimes(1);
    expect(t.watch.watch).toHaveBeenCalledTimes(1);
  });

  it('walks once for two subscribers that arrive together', async () => {
    const t = setup();
    const [first, second] = await Promise.all([
      t.service.subscribe('site1', 'window1'),
      t.service.subscribe('site1', 'window2'),
    ]);
    expect(second).toEqual(first);
    expect(t.walk.walk).toHaveBeenCalledTimes(1);
    expect(t.watch.watch).toHaveBeenCalledTimes(1);
  });

  it('refuses a site it does not know', async () => {
    const t = setup();
    await expect(t.service.subscribe('nope', 'window1')).rejects.toThrow('[files:siteUnknown]');
    await expect(t.service.refresh('nope')).rejects.toThrow('[files:siteUnknown]');
    expect(t.watch.watch).not.toHaveBeenCalled();
  });

  it('says first deploy when the base has no files', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 5, mtimeMs: 1 } }) });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot.firstDeploy).toBe(true);
    expect(snapshot.baseFileCount).toBe(0);
    expect(snapshot.files).toEqual([{ path: 'a.html', change: 'added', size: 5 }]);
  });
});

describe('settling', () => {
  it('publishes after a settle only when the list changed', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }) });
    await t.service.subscribe('site1', 'window1');
    expect(t.publish).toHaveBeenCalledTimes(1);

    t.tick(5000);
    t.watch.settle('poll');
    await flush();
    expect(t.walk.walk).toHaveBeenCalledTimes(2);
    expect(t.publish).toHaveBeenCalledTimes(1);

    t.walk.set(
      walked({
        'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 },
        'b.html': { sha256: SHA_B, size: 2, mtimeMs: 1 },
      }),
    );
    t.tick(5000);
    t.watch.settle('change');
    await flush();
    expect(t.publish).toHaveBeenCalledTimes(2);
    const [siteId, snapshot] = t.publish.mock.calls[1];
    expect(siteId).toBe('site1');
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.html', 'b.html']);
    expect(snapshot.computedAt).toBe(11_000);
    expect(t.service.snapshot('site1')).toEqual(snapshot);
  });

  it('tells settle listeners when the pending files changed, a same-size edit included', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }) });
    const settled = vi.fn();
    t.service.onSettled(settled);
    await t.service.subscribe('site1', 'window1');
    expect(settled).toHaveBeenCalledTimes(1);

    t.watch.settle('poll');
    await flush();
    expect(settled).toHaveBeenCalledTimes(1);

    // The same path and size, other bytes: the list looks the same, but Deploy on save must know.
    t.walk.set(walked({ 'a.html': { sha256: SHA_B, size: 1, mtimeMs: 2 } }));
    t.watch.settle('change');
    await flush();
    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenLastCalledWith('site1', expect.objectContaining({ state: 'ready' }));
  });

  it('a listener that throws does not stop the others or the publish', async () => {
    const t = setup();
    const after = vi.fn();
    t.service.onSettled(() => {
      throw new Error('listener broke');
    });
    t.service.onSettled(after);
    await t.service.subscribe('site1', 'window1');
    expect(after).toHaveBeenCalledTimes(1);
    expect(t.publish).toHaveBeenCalledTimes(1);
  });

  it('a publish that throws does not fail the walk', async () => {
    const t = setup();
    t.publish.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot.state).toBe('ready');
    expect(t.service.snapshot('site1')).toEqual(snapshot);
  });

  it('never runs two walks at once, and walks once more after a settle during a walk', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    t.walk.hold();
    t.watch.settle();
    await flush();
    expect(t.walk.walk).toHaveBeenCalledTimes(2);

    t.walk.set(walked({ 'late.html': { sha256: SHA_A, size: 3, mtimeMs: 1 } }));
    t.watch.settle();
    t.watch.settle();
    await flush();
    expect(t.walk.walk).toHaveBeenCalledTimes(2);

    t.walk.release();
    await flush();
    expect(t.walk.walk).toHaveBeenCalledTimes(3);
    expect(t.walk.maxRunning).toBe(1);
    expect(t.service.snapshot('site1')?.files).toEqual([
      { path: 'late.html', change: 'added', size: 3 },
    ]);
  });

  it('refresh during a walk answers with the walk after it', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    t.walk.hold();
    t.watch.settle();
    await flush();
    t.walk.set(walked({ 'new.html': { sha256: SHA_A, size: 3, mtimeMs: 1 } }));
    const refreshed = t.service.refresh('site1');
    t.walk.release();
    expect((await refreshed).files).toEqual([{ path: 'new.html', change: 'added', size: 3 }]);
    expect(t.walk.walk).toHaveBeenCalledTimes(3);
  });

  it('reads the base again on every walk, so a deploy empties the list', async () => {
    const local = { 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } };
    const t = setup({ walk: walked(local) });
    expect((await t.service.subscribe('site1', 'window1')).files).toHaveLength(1);
    t.setBase({ 'a.html': entry(SHA_A, 1) });
    const after = await t.service.refresh('site1');
    expect(after.files).toEqual([]);
    expect(after.firstDeploy).toBe(false);
    expect(t.publish).toHaveBeenCalledTimes(2);
  });
});

describe('lifetime', () => {
  it('stops watching when the last subscriber leaves', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    await t.service.subscribe('site1', 'window2');
    t.service.unsubscribe('site1', 'window1');
    expect(t.watch.open()).toHaveLength(1);
    t.service.unsubscribe('site1', 'window2');
    expect(t.watch.open()).toHaveLength(0);
    expect(t.service.snapshot('site1')).toBeNull();
  });

  it('walks again on a subscribe after watching stopped, since the cache went stale', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    t.service.unsubscribe('site1', 'window1');
    await t.service.subscribe('site1', 'window1');
    expect(t.walk.walk).toHaveBeenCalledTimes(2);
    expect(t.watch.watch).toHaveBeenCalledTimes(2);
    expect(t.watch.open()).toHaveLength(1);
  });

  it('keeps watching for Deploy on save after the last window leaves', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    await t.service.keepWatching('site1', true);
    t.service.unsubscribe('site1', 'window1');
    expect(t.watch.open()).toHaveLength(1);
    expect(t.service.snapshot('site1')).not.toBeNull();
    await t.service.keepWatching('site1', false);
    expect(t.watch.open()).toHaveLength(0);
  });

  it('keepWatching on its own starts the watcher and walks', async () => {
    const t = setup();
    const settled = vi.fn();
    t.service.onSettled(settled);
    await t.service.keepWatching('site1', true);
    expect(t.watch.open()).toHaveLength(1);
    expect(t.walk.walk).toHaveBeenCalledTimes(1);
    expect(t.service.snapshot('site1')?.state).toBe('ready');
    expect(settled).toHaveBeenCalledTimes(1);

    await t.service.subscribe('site1', 'window1');
    expect(t.walk.walk).toHaveBeenCalledTimes(1);
    t.service.unsubscribe('site1', 'window1');
    expect(t.watch.open()).toHaveLength(1);
  });

  it('refresh of a site nobody watches walks without starting a watcher', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }) });
    const snapshot = await t.service.refresh('site1');
    expect(snapshot.files).toHaveLength(1);
    expect(t.watch.watch).not.toHaveBeenCalled();
    expect(t.service.snapshot('site1')).toBeNull();
  });

  it('siteUpdated restarts the watcher on the new folder and walks again', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    const firstCache = t.walk.calls[0].hashes;
    t.sites.set('site1', site({ localFolder: '/work/other', ignorePatterns: ['*.log'] }));
    t.walk.set(walked({ 'b.html': { sha256: SHA_B, size: 2, mtimeMs: 1 } }));
    await t.service.siteUpdated('site1');
    expect(t.watch.watchers.map((watcher) => [watcher.root, watcher.closed])).toEqual([
      ['/work/site', true],
      ['/work/other', false],
    ]);
    const options = t.walk.calls[1];
    expect(options.root).toBe('/work/other');
    expect(options.ignorePatterns).toEqual(['*.log']);
    expect(options.hashes).not.toBe(firstCache);
    expect(t.service.snapshot('site1')?.files).toEqual([
      { path: 'b.html', change: 'added', size: 2 },
    ]);
  });

  it('siteUpdated on a site nobody watches does nothing', async () => {
    const t = setup();
    await t.service.siteUpdated('site1');
    expect(t.walk.walk).not.toHaveBeenCalled();
    expect(t.watch.watch).not.toHaveBeenCalled();
  });

  it('siteRemoved stops watching and forgets the site, a walk in flight included', async () => {
    const t = setup();
    await t.service.subscribe('site1', 'window1');
    await t.service.keepWatching('site1', true);
    t.walk.hold();
    t.watch.settle();
    await flush();
    t.service.siteRemoved('site1');
    expect(t.watch.open()).toHaveLength(0);
    t.walk.set(walked({ 'late.html': { sha256: SHA_A, size: 3, mtimeMs: 1 } }));
    t.walk.release();
    await flush();
    expect(t.service.snapshot('site1')).toBeNull();
    expect(t.publish).toHaveBeenCalledTimes(1);

    // Forgotten: a new subscribe starts from nothing, keepWatching included.
    t.sites.set('site1', site());
    await t.service.subscribe('site1', 'window1');
    t.service.unsubscribe('site1', 'window1');
    expect(t.watch.open()).toHaveLength(0);
  });

  it('closeAll stops every watcher', async () => {
    const t = setup({ sites: [site(), site({ id: 'site2', localFolder: '/work/two' })] });
    await t.service.subscribe('site1', 'window1');
    await t.service.keepWatching('site2', true);
    expect(t.watch.open()).toHaveLength(2);
    t.service.closeAll();
    expect(t.watch.open()).toHaveLength(0);
    expect(t.service.snapshot('site1')).toBeNull();
    expect(t.service.snapshot('site2')).toBeNull();
  });
});

describe('a folder that cannot be listed', () => {
  it('says folderMissing and never lists the base as deleted', async () => {
    const t = setup({
      base: { 'a.html': entry(SHA_A, 1), 'b.html': entry(SHA_B, 2) },
      walk: { exists: false, files: {}, leftOut: [], dirs: [] },
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot).toMatchObject({
      state: 'folderMissing',
      error: null,
      files: [],
      totals: { added: 0, modified: 0, deleted: 0, bytes: 0 },
      localFileCount: 0,
      baseFileCount: 2,
      firstDeploy: false,
    });
  });

  it('publishes when the folder goes missing and when it comes back', async () => {
    const t = setup({ walk: walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }) });
    await t.service.subscribe('site1', 'window1');
    t.walk.set({ exists: false, files: {}, leftOut: [], dirs: [] });
    t.watch.settle('missing');
    await flush();
    expect(t.publish.mock.calls.at(-1)?.[1].state).toBe('folderMissing');
    t.walk.set(walked({ 'a.html': { sha256: SHA_A, size: 1, mtimeMs: 1 } }));
    t.watch.settle('change');
    await flush();
    expect(t.publish).toHaveBeenCalledTimes(3);
    expect(t.publish.mock.calls.at(-1)?.[1].state).toBe('ready');
  });

  it('says tooManyFiles with the message', async () => {
    const t = setup({
      base: { 'a.html': entry(SHA_A, 1) },
      walk: filesError('tooManyFiles', 'The deploy folder holds more than 50000 files.'),
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot).toMatchObject({
      state: 'tooManyFiles',
      error: 'The deploy folder holds more than 50000 files.',
      files: [],
      totals: { added: 0, modified: 0, deleted: 0, bytes: 0 },
    });
  });

  it('says error for an ignore file that cannot be read, or anything else that fails', async () => {
    const t = setup({
      walk: filesError('invalidInput', 'Line 3 of .agentmateignore cannot be read.'),
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot).toMatchObject({
      state: 'error',
      error: 'Line 3 of .agentmateignore cannot be read.',
      files: [],
    });
    t.walk.set(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const next = await t.service.refresh('site1');
    expect(next.state).toBe('error');
    expect(next.error).toContain('permission denied');
  });

  it('keeps watching after a failed walk and recovers on the next settle', async () => {
    const t = setup({ walk: filesError('invalidInput', 'Bad line.') });
    await t.service.subscribe('site1', 'window1');
    t.walk.set(walked({}));
    t.watch.settle();
    await flush();
    expect(t.service.snapshot('site1')?.state).toBe('ready');
  });
});

describe('left-out paths', () => {
  it('carries at most 500 and says when there were more', async () => {
    const leftOut: FilesLeftOut[] = Array.from({ length: 620 }, (_, index) => ({
      path: `logs/${String(index).padStart(4, '0')}.log`,
      reason: 'ignored',
    }));
    const t = setup({ walk: walked({}, leftOut) });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot.leftOut).toHaveLength(500);
    expect(snapshot.leftOut[0].path).toBe('logs/0000.log');
    expect(snapshot.leftOutTruncated).toBe(true);
  });

  it('never lists a deployed file the walk now leaves out as deleted', async () => {
    const t = setup({
      base: {
        'keep.txt': entry(SHA_A, 4),
        'secret.txt': entry(SHA_B, 6),
        'logs/a.log': entry(SHA_C, 3),
      },
      walk: walked({ 'keep.txt': { sha256: SHA_A, size: 4, mtimeMs: 10 } }, [
        { path: 'logs/', reason: 'ignored' },
        { path: 'secret.txt', reason: 'ignored' },
      ]),
    });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot.files).toEqual([]);
    expect(snapshot.totals.deleted).toBe(0);
    expect(snapshot.leftOut.map((item) => item.path)).toEqual(['logs/', 'secret.txt']);
  });

  it('is not truncated at or under the cap', async () => {
    const leftOut: FilesLeftOut[] = [{ path: '.env', reason: 'hardDenied' }];
    const t = setup({ walk: walked({}, leftOut) });
    const snapshot = await t.service.subscribe('site1', 'window1');
    expect(snapshot.leftOut).toEqual(leftOut);
    expect(snapshot.leftOutTruncated).toBe(false);
  });
});

describe('on a real folder', () => {
  it('lists what the walk finds, with what is left out', async () => {
    const root = realpathSync(tempDir('agentmate-changes-'));
    writeTree(root, {
      'index.html': '<h1>hi</h1>',
      'css/site.css': 'body{}',
      '.env': 'SECRET=1',
      'debug.log': 'noise',
    });
    const t = setup({ sites: [site({ localFolder: root })] });
    const service = createChangesService({
      getSite: async (id) => t.sites.get(id) ?? null,
      walk: walkSiteFolder,
      readBase: t.readBase,
      watch: t.watch.watch,
      now: () => 5,
      publish: t.publish,
    });
    t.setBase({ 'css/site.css': entry(SHA_A, 6) });
    const snapshot = await service.refresh('site1');
    expect(snapshot.state).toBe('ready');
    expect(snapshot.files).toEqual([
      { path: 'css/site.css', change: 'modified', size: 6 },
      { path: 'index.html', change: 'added', size: 11 },
    ]);
    expect(snapshot.leftOut.map((item) => item.path)).toEqual(
      expect.arrayContaining(['.env', 'debug.log']),
    );
    expect(snapshot.localFileCount).toBe(2);
    expect(t.watch.watch).not.toHaveBeenCalled();

    await rm(join(root, 'index.html'));
    await rm(join(root, 'css'), { recursive: true });
    const after = await service.refresh('site1');
    expect(after.files).toEqual([{ path: 'css/site.css', change: 'deleted', size: 6 }]);

    await rm(root, { recursive: true });
    const gone = await service.refresh('site1');
    expect(gone.state).toBe('folderMissing');
    expect(gone.files).toEqual([]);
  });
});

describe('the base it reads by default', () => {
  const userData = useTempUserData();

  it('applies a running journal without folding it, so the run keeps what it finished', async () => {
    const bases = await import('./bases');
    const changes = await import('./changes');
    const root = realpathSync(tempDir('agentmate-changes-'));
    writeTree(root, { 'a.txt': 'a' });
    const theSite = site({ localFolder: root });
    await bases.readBase('site1', bases.baseTargetOf(theSite));
    const journal = await bases.openJournal('site1');
    await journal.append({
      t: 'put',
      path: 'a.txt',
      entry: {
        sha256: createHash('sha256').update('a').digest('hex'),
        size: 1,
        localMtimeMs: statSync(join(root, 'a.txt')).mtimeMs,
        remote: null,
      },
    });
    const service = changes.createChangesService({
      getSite: async (id) => (id === theSite.id ? theSite : null),
      watch: fakeWatch().watch,
      now: () => 1,
      publish: () => undefined,
    });

    const snapshot = await service.refresh('site1');

    expect(snapshot.files).toEqual([]);
    expect(
      existsSync(join(userData.dir, 'data', 'deploy-files', 'bases', 'site1.journal.jsonl')),
    ).toBe(true);
    await journal.close();
  });
});
