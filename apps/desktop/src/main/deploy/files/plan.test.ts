import { createHash } from 'node:crypto';
import { rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { RemoteTimeSource } from '@agentmat/core';
import { describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import type { FilesPlanView } from '../../../shared/deployFilesTypes';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import type { FilesBase } from './bases';
import {
  createPlanner,
  FILES_MASS_DELETE_SHARE_FLOOR,
  FILES_PLAN_TTL_MS,
  FILES_PLANS_PER_SITE,
  type PlannerDeps,
} from './plan';
import { createFakeRemote, type FakeRemoteOptions } from './transport/fakeRemote';
import type { OpenRemoteFiles } from './transport/types';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * The plan reads only what it needs from the server: the folders of the paths that changed here,
 * the deleted ones included, so every planned path is judged against what the server holds now.
 * It is kept in main for ten minutes and handed to the run once.
 */

const ROOT = '/srv/site';
const START = 1_700_000_000_000;

function site(overrides: Partial<StoredFileSite> = {}): StoredFileSite {
  return {
    id: 'site1',
    label: 'Site',
    protocol: 'sftp',
    connection: { kind: 'saved', sshServerId: 'server1' },
    remoteRoot: ROOT,
    localFolder: '/nowhere',
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

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function viaOf(options: FakeRemoteOptions): RemoteTimeSource | null {
  if (options.noMtime) return null;
  if (options.noMlsd) return 'mdtm';
  return (options.protocol ?? 'sftp') === 'sftp' ? 'sftp' : 'mlsd';
}

interface SetupOptions extends FakeRemoteOptions {
  remoteRoot?: string;
  overrides?: Partial<PlannerDeps>;
}

function setup(options: SetupOptions = {}) {
  const { remoteRoot = ROOT, overrides, ...fakeOptions } = options;
  const local = tempDir('agentmate-plan-');
  const fake = createFakeRemote(fakeOptions);
  fake.setDir(remoteRoot);
  const theSite = site({ localFolder: local, remoteRoot });
  const base: FilesBase = {
    version: 1,
    target: {
      protocol: 'sftp',
      host: 'saved:server1',
      port: null,
      username: null,
      remoteRoot,
      localFolder: local,
    },
    files: {},
    createdDirs: [],
  };
  const connect: FilesConnectTarget = {
    protocol: 'sftp',
    login: { kind: 'saved', sshServerId: 'server1' },
    remoteRoot,
  };
  let now = START;
  let ids = 0;
  const remotePath = (path: string) => (remoteRoot === '/' ? `/${path}` : `${remoteRoot}/${path}`);
  const planner = createPlanner({
    getSite: async (id) => (id === theSite.id ? theSite : null),
    connectTarget: async () => connect,
    peekBase: async () => structuredClone(base),
    openRemote: fake.opener,
    now: () => now,
    randomId: () => `plan${++ids}`,
    ...overrides,
  });

  /** A file the last deploy sent: here, on the server, and in the base as the server saw it. */
  function deployed(path: string, content: string, onServerMtimeMs = START): void {
    writeTree(local, { [path]: content });
    // Dated back, so an edit of the same size right after gets a new time and is hashed again.
    const past = new Date(START);
    utimesSync(join(local, path), past, past);
    fake.setFile(remotePath(path), content, { mtimeMs: onServerMtimeMs });
    const via = viaOf(fakeOptions);
    base.files[path] = {
      sha256: sha(content),
      size: Buffer.byteLength(content),
      localMtimeMs: statSync(join(local, path)).mtimeMs,
      remote: {
        size: Buffer.byteLength(content),
        mtimeMs: via ? Math.floor(onServerMtimeMs / 1000) * 1000 : null,
        via,
      },
    };
  }

  return {
    local,
    fake,
    base,
    planner,
    site: theSite,
    remotePath,
    deployed,
    write: (files: Record<string, string>) => writeTree(local, files),
    removeLocal: (path: string) => rmSync(join(local, path)),
    advance: (ms: number) => {
      now += ms;
    },
    listed: () =>
      fake.calls
        .filter((call) => call.op === 'list')
        .map((call) => call.path)
        .sort(),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return filesErrorCode(error);
  }
  return null;
}

function codeOfSync(work: () => unknown): string | null {
  try {
    work();
  } catch (error) {
    return filesErrorCode(error);
  }
  return null;
}

describe('plan: what is read on the server', () => {
  it('lists only the folders of the paths that changed, a deleted path included', async () => {
    const t = setup();
    t.deployed('keep/a.txt', 'keep');
    t.deployed('gone/b.txt', 'gone');
    t.removeLocal('gone/b.txt');
    t.write({ 'new/c.txt': 'new' });

    const view = await t.planner.plan('site1');

    expect(t.listed()).toEqual([`${ROOT}/gone`, `${ROOT}/new`]);
    expect(view.changes.map((change) => [change.path, change.action, change.remote])).toEqual([
      ['gone/b.txt', 'deleteRemote', 'unchanged'],
      ['new/c.txt', 'upload', 'missing'],
    ]);
  });

  it('lists the remote folder itself for a file at the top', async () => {
    const t = setup();
    t.write({ 'index.html': '<h1>hi</h1>' });
    await t.planner.plan('site1');
    expect(t.listed()).toEqual([ROOT]);
  });

  it('keys what the server holds by the path inside the site, also for a root of /', async () => {
    const t = setup({ remoteRoot: '/' });
    t.deployed('css/site.css', 'body{}');
    t.write({ 'css/site.css': 'body{color:red}' });
    t.fake.setFile('/css/site.css', 'body{color:blue}');

    const view = await t.planner.plan('site1');

    expect(t.listed()).toEqual(['/css']);
    expect(view.changes).toHaveLength(1);
    expect(view.changes[0]).toMatchObject({
      path: 'css/site.css',
      action: 'conflict',
      conflict: 'changedOnServer',
      server: { size: Buffer.byteLength('body{color:blue}'), via: 'sftp' },
    });
  });

  it('takes a folder missing on the server as listed, so its files are missing there', async () => {
    const t = setup();
    t.deployed('docs/a.txt', 'one');
    t.write({ 'docs/a.txt': 'two' });
    t.fake.delete(`${ROOT}/docs`);

    const view = await t.planner.plan('site1');

    expect(view.changes[0]).toMatchObject({
      path: 'docs/a.txt',
      remote: 'missing',
      action: 'conflict',
      conflict: 'deletedOnServer',
    });
    const kept = t.planner.take('site1', view.planId);
    expect(kept.existingDirs).not.toContain('docs');
  });

  it('reports a server folder that already holds files on a first deploy', async () => {
    const t = setup();
    t.write({ 'index.html': 'same', 'about.html': 'different' });
    t.fake.setFile(`${ROOT}/index.html`, 'SAME');
    t.fake.setFile(`${ROOT}/about.html`, 'other size');
    t.fake.setFile(`${ROOT}/theirs.html`, 'not ours');

    const view = await t.planner.plan('site1');

    expect(view.firstDeploy).toEqual({ existing: 2, sameSize: 1 });
    expect(view.changes.map((change) => [change.path, change.conflict])).toEqual([
      ['about.html', 'existsOnServer'],
      ['index.html', 'existsOnServer'],
    ]);
  });

  it('reports no first deploy when no file would be written over', async () => {
    const t = setup();
    t.write({ 'index.html': 'new' });
    t.fake.setFile(`${ROOT}/theirs.html`, 'not ours');

    const view = await t.planner.plan('site1');

    expect(view.firstDeploy).toBeNull();
    expect(view.changes.map((change) => change.action)).toEqual(['upload']);
  });

  it('reports no first deploy over an empty server folder', async () => {
    const t = setup();
    t.write({ 'index.html': 'new' });
    expect((await t.planner.plan('site1')).firstDeploy).toBeNull();
  });

  it('keeps part files a stopped upload left for the run, and never takes them for site files', async () => {
    const t = setup();
    t.write({ 'new/c.txt': 'new' });
    t.fake.setFile(`${ROOT}/new/c.txt.agentmate-0123abcd.part`, 'ne');

    const view = await t.planner.plan('site1');

    expect(view.changes[0]).toMatchObject({ path: 'new/c.txt', remote: 'missing' });
    expect(view.firstDeploy).toBeNull();
    const kept = t.planner.take('site1', view.planId);
    expect(kept.partFiles).toEqual([`${ROOT}/new/c.txt.agentmate-0123abcd.part`]);
    expect(kept.existingDirs).toContain('new');
  });

  it('keeps the backups a stopped replace left for the run, and never takes them for site files', async () => {
    const t = setup();
    t.write({ 'new/c.txt': 'new' });
    t.fake.setFile(`${ROOT}/new/c.txt.agentmate-0123abcd.old`, 'old');

    const view = await t.planner.plan('site1');

    expect(view.firstDeploy).toBeNull();
    const kept = t.planner.take('site1', view.planId);
    expect(kept.backupFiles).toEqual([`${ROOT}/new/c.txt.agentmate-0123abcd.old`]);
    expect(kept.partFiles).toEqual([]);
  });

  it('keeps at most 8 listings in flight', async () => {
    const t = setup({ latencyMs: 5 });
    const files: Record<string, string> = {};
    for (let index = 0; index < 20; index++) files[`d${index}/f.txt`] = `file ${index}`;
    t.write(files);
    let inFlight = 0;
    let most = 0;
    const opener: OpenRemoteFiles = async (target, options) => {
      const remote = await t.fake.opener(target, options);
      return {
        ...remote,
        list: async (dir) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          try {
            return await remote.list(dir);
          } finally {
            inFlight -= 1;
          }
        },
      };
    };
    const planner = createPlanner({
      getSite: async () => t.site,
      connectTarget: async () => ({
        protocol: 'sftp',
        login: { kind: 'saved', sshServerId: 'server1' },
        remoteRoot: ROOT,
      }),
      peekBase: async () => structuredClone(t.base),
      openRemote: opener,
      now: () => START,
      randomId: () => 'plan',
    });

    const view = await planner.plan('site1');

    expect(view.changes).toHaveLength(20);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it('closes the connection, also when a listing fails', async () => {
    const t = setup();
    t.write({ 'locked/a.txt': 'a' });
    t.fake.setDir(`${ROOT}/locked`);
    t.fake.failOn(`${ROOT}/locked`, 'permissionDenied');

    expect(await codeOf(t.planner.plan('site1'))).toBe('permissionDenied');
    expect(t.fake.calls.filter((call) => call.op === 'close')).toHaveLength(1);
  });

  it('refuses a deploy folder that is gone without reading the server', async () => {
    const t = setup();
    rmSync(t.local, { recursive: true, force: true });
    expect(await codeOf(t.planner.plan('site1'))).toBe('folderMissing');
    expect(t.fake.opened).toHaveLength(0);
  });

  it('refuses a site that is not saved', async () => {
    const t = setup();
    expect(await codeOf(t.planner.plan('other'))).toBe('siteUnknown');
  });
});

describe('plan: times on an FTP server without MLSD', () => {
  it('asks the server for the time of each planned file it already has', async () => {
    const t = setup({ protocol: 'ftp', noMlsd: true });
    t.deployed('a.txt', 'one');
    t.write({ 'a.txt': 'two', 'b.txt': 'new' });

    const view = await t.planner.plan('site1');

    expect(view.changes.map((change) => [change.path, change.action, change.remote])).toEqual([
      ['a.txt', 'upload', 'unchanged'],
      ['b.txt', 'upload', 'missing'],
    ]);
    const stats = t.fake.calls.filter((call) => call.op === 'stat').map((call) => call.path);
    expect(stats).toEqual([`${ROOT}/a.txt`]);
    expect(view.notices).not.toContain('mdtmCapped');
  });

  it('sees a file changed on the server only in time', async () => {
    const t = setup({ protocol: 'ftp', noMlsd: true });
    t.deployed('a.txt', 'one');
    t.write({ 'a.txt': 'two' });
    t.fake.setFile(`${ROOT}/a.txt`, 'ONE', { mtimeMs: START + 61_000 });

    const view = await t.planner.plan('site1');

    expect(view.changes[0]).toMatchObject({ action: 'conflict', conflict: 'changedOnServer' });
  });

  it('compares sizes only past the cap, and says so', async () => {
    const t = setup({ protocol: 'ftp', noMlsd: true, overrides: { mdtmCap: 1 } });
    t.deployed('a.txt', 'one');
    t.deployed('b.txt', 'one');
    t.write({ 'a.txt': 'two', 'b.txt': 'two' });

    const view = await t.planner.plan('site1');

    expect(t.fake.calls.filter((call) => call.op === 'stat')).toHaveLength(0);
    expect(view.notices).toContain('mdtmCapped');
    expect(view.changes.map((change) => change.remote)).toEqual(['sizeOnly', 'sizeOnly']);
  });
});

describe('plan: notices', () => {
  it('says changes are judged by size alone when the server has no times', async () => {
    const t = setup({ protocol: 'ftp', noMtime: true });
    t.deployed('a.txt', 'one');
    t.write({ 'a.txt': 'two' });
    const view = await t.planner.plan('site1');
    expect(view.notices).toEqual(['sizeOnly']);
    expect(view.changes[0]).toMatchObject({ remote: 'sizeOnly', unverified: true });
  });

  it('says the server cannot replace a file in one step', async () => {
    const t = setup({ noAtomicRename: true });
    t.write({ 'a.txt': 'new' });
    const view = await t.planner.plan('site1');
    expect(view.notices).toEqual(['notAtomic']);
  });

  it('says every time moved by the same hours, and does not take it for edits', async () => {
    const t = setup();
    t.deployed('a.txt', 'one');
    t.deployed('b.txt', 'one');
    t.write({ 'a.txt': 'two', 'b.txt': 'two' });
    t.fake.setFile(`${ROOT}/a.txt`, 'one', { mtimeMs: START + 3_600_000 });
    t.fake.setFile(`${ROOT}/b.txt`, 'one', { mtimeMs: START + 3_600_000 });

    const view = await t.planner.plan('site1');

    expect(view.clockShiftHours).toBe(1);
    expect(view.notices).toEqual(['clockShift']);
    expect(view.changes.map((change) => change.action)).toEqual(['upload', 'upload']);
  });
});

describe('plan: files the walk leaves out', () => {
  it('never plans a deployed file that is now ignored as a delete, nor counts it', async () => {
    const t = setup();
    t.deployed('keep.txt', 'keep');
    t.deployed('secret.txt', 'secret');
    t.deployed('logs/a.log', 'log');
    t.site.ignorePatterns = ['secret.txt', 'logs/'];
    t.write({ 'new.txt': 'new' });

    const view = await t.planner.plan('site1');

    expect(view.changes.map((change) => [change.path, change.action])).toEqual([
      ['new.txt', 'upload'],
    ]);
    expect(view.deleteCount).toBe(0);
    expect(view.massDelete).toBe(false);
    expect(t.fake.readFile(t.remotePath('secret.txt'))).toBe('secret');
  });
});

describe('plan: mass delete', () => {
  it('flags more than 20 deletes', async () => {
    const t = setup();
    for (let index = 0; index < 79; index++) t.deployed(`keep/${index}.txt`, `keep ${index}`);
    for (let index = 0; index < 21; index++) {
      t.deployed(`gone/${index}.txt`, `gone ${index}`);
      t.removeLocal(`gone/${index}.txt`);
    }
    const view = await t.planner.plan('site1');
    expect(view.deleteCount).toBe(21);
    expect(view.massDelete).toBe(true);
  });

  it('flags more than a quarter of the base, from 5 deletes on', async () => {
    const t = setup();
    for (let index = 0; index < 16; index++) t.deployed(`${index}.txt`, `file ${index}`);
    for (let index = 0; index < FILES_MASS_DELETE_SHARE_FLOOR; index++) {
      t.removeLocal(`${index}.txt`);
    }
    const view = await t.planner.plan('site1');
    expect(view.deleteCount).toBe(5);
    expect(view.massDelete).toBe(true);
  });

  it('does not flag a few deletes of a small site, however large a share they are', async () => {
    const t = setup();
    for (let index = 0; index < 6; index++) t.deployed(`${index}.txt`, `file ${index}`);
    for (const index of [0, 1, 2, 3]) t.removeLocal(`${index}.txt`);
    const view = await t.planner.plan('site1');
    expect(view.deleteCount).toBe(4);
    expect(view.massDelete).toBe(false);
  });

  it('does not flag a few deletes', async () => {
    const t = setup();
    for (let index = 0; index < 10; index++) t.deployed(`${index}.txt`, `file ${index}`);
    for (const index of [0, 1]) t.removeLocal(`${index}.txt`);
    const view = await t.planner.plan('site1');
    expect(view.massDelete).toBe(false);
  });

  it('flags an empty deploy folder over a base that is not', async () => {
    const t = setup();
    t.deployed('a.txt', 'one');
    t.removeLocal('a.txt');
    t.fake.setFile(`${ROOT}/a.txt`, 'edited on the server');
    const view = await t.planner.plan('site1');
    expect(view.deleteCount).toBe(0);
    expect(view.massDelete).toBe(true);
  });
});

describe('plan: kept in main', () => {
  it('hands the plan to the run once, with what the run needs', async () => {
    const t = setup();
    t.deployed('a.txt', 'one');
    t.write({ 'a.txt': 'two' });

    const view = await t.planner.plan('site1');

    expect(view).toMatchObject({
      planId: 'plan1',
      siteId: 'site1',
      createdAt: START,
      expiresAt: START + FILES_PLAN_TTL_MS,
      uploadBytes: 3,
    });
    expect(FILES_PLAN_TTL_MS).toBe(10 * 60 * 1000);
    const kept = t.planner.take('site1', view.planId);
    expect(kept.view).toEqual(view);
    expect(kept.local['a.txt']?.sha256).toBe(sha('two'));
    expect(kept.base.files['a.txt']?.sha256).toBe(sha('one'));
    expect(kept.remoteRoot).toBe(ROOT);
    expect(kept.capabilities).toEqual({ atomicReplace: true, mtime: 'exact' });
    expect(codeOfSync(() => t.planner.take('site1', view.planId))).toBe('planExpired');
  });

  it('expires after ten minutes', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const view = await t.planner.plan('site1');
    t.advance(FILES_PLAN_TTL_MS + 1);
    expect(codeOfSync(() => t.planner.take('site1', view.planId))).toBe('planExpired');
  });

  it('is not handed out for another site', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const view = await t.planner.plan('site1');
    expect(codeOfSync(() => t.planner.take('site2', view.planId))).toBe('planExpired');
    expect(t.planner.take('site1', view.planId).view.planId).toBe('plan1');
  });

  it('keeps an older plan of the site when a newer one is made (a review stays open)', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const first = await t.planner.plan('site1');
    const second = await t.planner.plan('site1');
    expect(t.planner.take('site1', second.planId).view.planId).toBe('plan2');
    expect(t.planner.take('site1', first.planId).view.planId).toBe('plan1');
    expect(codeOfSync(() => t.planner.take('site1', first.planId))).toBe('planExpired');
  });

  it('keeps at most 4 plans of a site, dropping the oldest', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const views: FilesPlanView[] = [];
    for (let index = 0; index < 5; index += 1) views.push(await t.planner.plan('site1'));
    expect(FILES_PLANS_PER_SITE).toBe(4);
    expect(codeOfSync(() => t.planner.take('site1', views[0].planId))).toBe('planExpired');
    for (const view of views.slice(1)) {
      expect(t.planner.take('site1', view.planId).view.planId).toBe(view.planId);
    }
  });

  it('still expires every kept plan after ten minutes', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const first = await t.planner.plan('site1');
    const second = await t.planner.plan('site1');
    t.advance(FILES_PLAN_TTL_MS + 1);
    expect(codeOfSync(() => t.planner.take('site1', first.planId))).toBe('planExpired');
    expect(codeOfSync(() => t.planner.take('site1', second.planId))).toBe('planExpired');
  });

  it('opens the server unattended for a background plan only', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    await t.planner.plan('site1');
    await t.planner.plan('site1', { unattended: true });
    expect(t.fake.opened.map((open) => open.unattended ?? false)).toEqual([false, true]);
  });

  it('forgets the plans of a site', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const view = await t.planner.plan('site1');
    t.planner.forget('site1');
    expect(codeOfSync(() => t.planner.take('site1', view.planId))).toBe('planExpired');
  });

  it('takes back a plan a run gave back, under the same id and expiry, unless the site was forgotten', async () => {
    const t = setup();
    t.write({ 'a.txt': 'new' });
    const view = await t.planner.plan('site1');
    t.planner.giveBack(t.planner.take('site1', view.planId));
    const again = t.planner.take('site1', view.planId);
    expect(again.view).toEqual(view);

    t.planner.forget('site1');
    t.planner.giveBack(again);
    expect(codeOfSync(() => t.planner.take('site1', view.planId))).toBe('planExpired');

    const later = await t.planner.plan('site1');
    const taken = t.planner.take('site1', later.planId);
    t.advance(FILES_PLAN_TTL_MS + 1);
    t.planner.giveBack(taken);
    expect(codeOfSync(() => t.planner.take('site1', later.planId))).toBe('planExpired');
  });

  it('never keeps a plan that was under way when the site was forgotten', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const t = setup({
      overrides: {
        openRemote: async (target, options) => {
          reached();
          await held;
          return t.fake.opener(target, options);
        },
      },
    });
    t.write({ 'a.txt': 'new' });

    const planning = codeOf(t.planner.plan('site1'));
    await reading;
    // An ignore line added, say: what the plan read no longer holds.
    t.planner.forget('site1');
    release();

    expect(await planning).toBe('planExpired');
    // Another site's plan, or the next one of this site, is not held back.
    const next = await t.planner.plan('site1');
    expect(t.planner.take('site1', next.planId).view.planId).toBe(next.planId);
  });
});
