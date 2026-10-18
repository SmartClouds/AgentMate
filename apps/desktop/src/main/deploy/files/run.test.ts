import { existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import type {
  FilesDeployInput,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
} from '../../../shared/deployFilesTypes';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { RunnerDeps } from './run';
import { FilesTransportError } from './transport/errors';
import { createFakeRemote, type FakeRemoteOptions } from './transport/fakeRemote';
import type { OpenRemoteFiles, RemoteFiles } from './transport/types';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * A deploy run acts on the plan the user reviewed: it makes the folders, sends the files, deletes
 * what was deleted here, and removes the folders it made once they are empty. Every finished file
 * goes to the journal at once, so a run that fails or is cancelled is picked up where it stopped.
 * A change on the server is only ever overwritten by an explicit choice, and a file is only ever
 * deleted when the last deploy sent it and the server still has it as it was.
 */

const userData = useTempUserData();
let bases: typeof import('./bases');
let history: typeof import('./history');
let planModule: typeof import('./plan');
let runModule: typeof import('./run');

beforeEach(async () => {
  bases = await import('./bases');
  history = await import('./history');
  planModule = await import('./plan');
  runModule = await import('./run');
});

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

type Choices = (view: FilesPlanView) => Partial<FilesDeployInput>;

interface SetupOptions extends FakeRemoteOptions {
  /** Wraps every connection the run opens. */
  wrap?: (remote: RemoteFiles) => RemoteFiles;
  runner?: Partial<RunnerDeps>;
  now?: () => number;
}

function setup(options: SetupOptions = {}) {
  const { wrap, runner: runnerOverrides, now: clock, ...fakeOptions } = options;
  const local = tempDir('agentmate-run-');
  const fake = createFakeRemote(fakeOptions);
  fake.setDir(ROOT);
  const current = { site: site({ localFolder: local, protocol: fakeOptions.protocol ?? 'sftp' }) };
  const connect: FilesConnectTarget = {
    protocol: 'sftp',
    login: { kind: 'saved', sshServerId: 'server1' },
    remoteRoot: ROOT,
  };
  const now = clock ?? (() => START);
  let plans = 0;
  let runs = 0;
  const events: FilesProgressEvent[] = [];
  const runOpener: OpenRemoteFiles = async (target, openOptions) => {
    const remote = await fake.opener(target, openOptions);
    return wrap ? wrap(remote) : remote;
  };
  const planner = planModule.createPlanner({
    getSite: async (id) => (id === current.site.id ? current.site : null),
    connectTarget: async () => connect,
    openRemote: fake.opener,
    now,
    randomId: () => `plan${++plans}`,
  });
  const runner = runModule.createRunner({
    takePlan: planner.take,
    giveBackPlan: planner.giveBack,
    getSite: async (id) => (id === current.site.id ? current.site : null),
    connectTarget: async () => connect,
    openRemote: runOpener,
    now,
    randomId: () => `run${++runs}`,
    onProgress: (event) => events.push(event),
    ...runnerOverrides,
  });

  function inputOf(view: FilesPlanView, choices?: Choices): FilesDeployInput {
    return {
      siteId: 'site1',
      planId: view.planId,
      paths: view.changes.map((change) => change.path),
      conflicts: {},
      firstDeploy: null,
      reupload: [],
      ...choices?.(view),
    };
  }

  async function deploy(
    choices?: Choices,
    signal?: AbortSignal,
  ): Promise<{ view: FilesPlanView; result: FilesRunResult }> {
    const view = await planner.plan('site1');
    const result = await runner.run(inputOf(view, choices), 'user', signal);
    return { view, result };
  }

  return {
    local,
    fake,
    current,
    planner,
    runner,
    events,
    deploy,
    inputOf,
    write: (files: Record<string, string>) => writeTree(local, files),
    removeLocal: (path: string) => rmSync(join(local, path)),
    base: () => bases.peekBase('site1', bases.baseTargetOf(current.site)),
    puts: () =>
      fake.calls
        .filter((call) => call.op === 'putFile')
        .map((call) => call.path)
        .sort(),
    clearCalls: () => {
      fake.calls.length = 0;
    },
  };
}

function journalFile(): string {
  return join(userData.dir, 'data', 'deploy-files', 'bases', 'site1.journal.jsonl');
}

describe('run: a deploy', () => {
  it('sends the new files, makes their folders and records what the server saw', async () => {
    const t = setup();
    t.write({
      'index.html': '<h1>hi</h1>',
      'css/site.css': 'body{}',
      'css/img/logo.svg': '<svg/>',
    });

    const { result } = await t.deploy();

    expect(result).toMatchObject({
      runId: 'run1',
      siteId: 'site1',
      trigger: 'user',
      state: 'done',
      uploaded: 3,
      deleted: 0,
      adopted: 0,
      skipped: 0,
      bytes: 11 + 6 + 6,
      failed: [],
      atomic: true,
      error: null,
    });
    expect(t.fake.readFile(`${ROOT}/css/img/logo.svg`)).toBe('<svg/>');
    const base = await t.base();
    expect(Object.keys(base.files).sort()).toEqual([
      'css/img/logo.svg',
      'css/site.css',
      'index.html',
    ]);
    expect(base.files['index.html']?.remote).toEqual({ size: 11, mtimeMs: START, via: 'sftp' });
    expect(base.files['index.html']?.localMtimeMs).toBe(
      statSync(join(t.local, 'index.html')).mtimeMs,
    );
    expect(base.createdDirs.sort()).toEqual(['css', 'css/img']);
    expect(existsSync(journalFile())).toBe(false);
    expect(await history.readHistory('site1')).toEqual([result]);
    expect(t.fake.opened.map((open) => open.purpose)).toEqual(['browse', 'run']);
    const runConnection = t.fake.calls.find((call) => call.op === 'putFile')?.connection;
    expect(
      t.fake.calls.filter((call) => call.op === 'close' && call.connection === runConnection),
    ).toHaveLength(1);
  });

  it('sends only what changed the next time (AC1)', async () => {
    const t = setup();
    t.write({ 'index.html': 'one', 'css/site.css': 'body{}' });
    await t.deploy();
    t.write({ 'css/site.css': 'body{color:red}' });
    t.clearCalls();

    const { result } = await t.deploy();

    expect(t.puts()).toEqual([`${ROOT}/css/site.css`]);
    expect(t.fake.calls.filter((call) => call.op === 'ensureDir')).toHaveLength(0);
    expect(result).toMatchObject({ state: 'done', uploaded: 1 });
  });

  it('deletes a file deleted here, and never a file only on the server (AC2)', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a', 'b.txt': 'b' });
    await t.deploy();
    t.fake.setFile(`${ROOT}/theirs.txt`, 'not ours');
    t.removeLocal('a.txt');

    const { result } = await t.deploy();

    expect(result).toMatchObject({ state: 'done', deleted: 1, uploaded: 0 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBeNull();
    expect(t.fake.readFile(`${ROOT}/theirs.txt`)).toBe('not ours');
    expect(Object.keys((await t.base()).files)).toEqual(['b.txt']);
  });

  it('removes a folder it made once it is empty, never one it did not make or that still has files', async () => {
    const t = setup();
    t.fake.setDir(`${ROOT}/old`);
    t.write({ 'made/a.txt': 'a', 'kept/b.txt': 'b', 'old/c.txt': 'c' });
    await t.deploy();
    expect((await t.base()).createdDirs.sort()).toEqual(['kept', 'made']);
    t.fake.setFile(`${ROOT}/kept/theirs.txt`, 'not ours');
    t.removeLocal('made/a.txt');
    t.removeLocal('kept/b.txt');
    t.removeLocal('old/c.txt');

    const { result } = await t.deploy();

    expect(result).toMatchObject({ state: 'done', deleted: 3 });
    expect(t.fake.nodes.has(`${ROOT}/made`)).toBe(false);
    expect(t.fake.readFile(`${ROOT}/kept/theirs.txt`)).toBe('not ours');
    expect(t.fake.nodes.has(`${ROOT}/old`)).toBe(true);
    expect((await t.base()).createdDirs).toEqual(['kept']);
  });

  it('clears the part files a stopped upload left in the folders it read', async () => {
    const t = setup();
    t.fake.setFile(`${ROOT}/index.html.agentmate-0123abcd.part`, 'half');
    t.write({ 'index.html': 'whole' });

    await t.deploy();

    expect(t.fake.paths().filter((path) => path.startsWith(`${ROOT}/`))).toEqual([
      `${ROOT}/index.html`,
    ]);
  });

  it('deletes a backup a stopped replace left when its file is there, and puts it back when not', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a', 'b.txt': 'b' });
    await t.deploy();
    t.fake.setFile(`${ROOT}/a.txt.agentmate-0123abcd.old`, 'older a');
    t.fake.delete(`${ROOT}/b.txt`);
    t.fake.setFile(`${ROOT}/b.txt.agentmate-4567cdef.old`, 'b');
    t.write({ 'c.txt': 'c' });

    const { result } = await t.deploy();

    expect(result).toMatchObject({ state: 'done', uploaded: 1 });
    expect(t.fake.paths().filter((path) => path.startsWith(`${ROOT}/`))).toEqual([
      `${ROOT}/a.txt`,
      `${ROOT}/b.txt`,
      `${ROOT}/c.txt`,
    ]);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('a');
    expect(t.fake.readFile(`${ROOT}/b.txt`)).toBe('b');
  });

  it('sends again a file gone from the server when asked to', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    await t.deploy();
    t.fake.delete(`${ROOT}/a.txt`);
    // Only folders with a change here are listed, so a new file at the top lists the root.
    t.write({ 'b.txt': 'b' });

    const { view, result } = await t.deploy((plan) => ({ reupload: plan.missingOnServer }));

    expect(view.missingOnServer).toEqual(['a.txt']);
    expect(result).toMatchObject({ state: 'done', uploaded: 2 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('a');
  });

  it('never deletes a file renamed only in case, which a case-blind server holds as one', async () => {
    const t = setup({
      // A server that does not tell a.txt from A.txt, as on Windows and many shared hosts.
      wrap: (remote) => ({
        ...remote,
        stat: async (path) => {
          const found = t.fake.paths().find((one) => one.toLowerCase() === path.toLowerCase());
          return remote.stat(found ?? path);
        },
      }),
    });
    t.write({ 'a.txt': 'one', 'b.txt': 'b' });
    await t.deploy();
    t.removeLocal('a.txt');
    t.write({ 'A.txt': 'one!' });
    t.clearCalls();

    const { view, result } = await t.deploy();

    expect(view.changes.map((change) => [change.path, change.action])).toEqual([
      ['A.txt', 'upload'],
      ['a.txt', 'deleteRemote'],
    ]);
    expect(result).toMatchObject({ state: 'done', uploaded: 1, deleted: 0, failed: [] });
    expect(t.fake.calls.filter((call) => call.op === 'remove')).toEqual([]);
    expect(t.fake.readFile(`${ROOT}/A.txt`)).toBe('one!');
    expect(Object.keys((await t.base()).files).sort()).toEqual(['A.txt', 'b.txt']);
  });

  it('forgets a file deleted here and already gone from the server', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a', 'b.txt': 'b' });
    await t.deploy();
    t.removeLocal('a.txt');
    t.fake.delete(`${ROOT}/a.txt`);

    await t.deploy();

    expect(Object.keys((await t.base()).files)).toEqual(['b.txt']);
  });

  it('leaves the paths that were not picked pending', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a', 'b.txt': 'b' });

    const { result } = await t.deploy(() => ({ paths: ['a.txt'] }));

    expect(result).toMatchObject({ state: 'done', uploaded: 1, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/b.txt`)).toBeNull();
    const next = await t.planner.plan('site1');
    expect(next.changes.map((change) => change.path)).toEqual(['b.txt']);
  });
});

describe('run: changes on the server (AC3)', () => {
  async function changedOnServer() {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.write({ 'a.txt': 'mine' });
    t.fake.setFile(`${ROOT}/a.txt`, 'theirs!', { mtimeMs: START + 60_000 });
    return t;
  }

  it('never overwrites a conflict nobody chose for', async () => {
    const t = await changedOnServer();
    const { view, result } = await t.deploy();
    expect(view.changes[0]).toMatchObject({ action: 'conflict', conflict: 'changedOnServer' });
    expect(result).toMatchObject({ state: 'done', uploaded: 0, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('theirs!');
  });

  it('keeps the server file on skip', async () => {
    const t = await changedOnServer();
    const { result } = await t.deploy(() => ({ conflicts: { 'a.txt': 'skip' } }));
    expect(result).toMatchObject({ uploaded: 0, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('theirs!');
  });

  it('sends the local file on overwrite', async () => {
    const t = await changedOnServer();
    const { result } = await t.deploy(() => ({ conflicts: { 'a.txt': 'overwrite' } }));
    expect(result).toMatchObject({ uploaded: 1, skipped: 0 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('mine');
    expect((await t.planner.plan('site1')).changes).toEqual([]);
  });

  async function deletedHereChangedThere() {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.removeLocal('a.txt');
    t.fake.setFile(`${ROOT}/a.txt`, 'edited there');
    return t;
  }

  it('deletes a file changed on the server only when the review chose Delete (AC2)', async () => {
    const t = await deletedHereChangedThere();

    const { view, result } = await t.deploy(() => ({ conflicts: { 'a.txt': 'overwrite' } }));

    expect(view.changes[0]).toMatchObject({ local: 'deleted', action: 'conflict' });
    expect(result).toMatchObject({ state: 'done', deleted: 1, skipped: 0 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBeNull();
    expect((await t.base()).files).toEqual({});
    expect((await t.planner.plan('site1')).changes).toEqual([]);
  });

  it('keeps a file changed on the server on Keep, and it stays pending', async () => {
    const t = await deletedHereChangedThere();

    const { result } = await t.deploy(() => ({ conflicts: { 'a.txt': 'skip' } }));

    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('edited there');
    expect(Object.keys((await t.base()).files)).toEqual(['a.txt']);
    const next = await t.planner.plan('site1');
    expect(next.changes).toMatchObject([{ path: 'a.txt', local: 'deleted', action: 'conflict' }]);
  });

  const conflictsOf = (result: FilesRunResult) =>
    result.failed.filter((failure) => failure.code === 'conflict').map((failure) => failure.path);

  it('does not write over a file changed on the server after the plan, and it stays pending', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.write({ 'a.txt': 'mine' });
    const view = await t.planner.plan('site1');
    t.fake.setFile(`${ROOT}/a.txt`, 'theirs', { mtimeMs: START + 60_000 });

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(result).toMatchObject({ state: 'failed', uploaded: 0 });
    expect(conflictsOf(result)).toEqual(['a.txt']);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('theirs');
    expect((await t.base()).files['a.txt']?.size).toBe(3);
    const next = await t.planner.plan('site1');
    expect(next.changes).toMatchObject([{ path: 'a.txt', action: 'conflict' }]);
  });

  it('sees a change of time alone when the time comes from the same source', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.write({ 'a.txt': 'mine' });
    const view = await t.planner.plan('site1');
    t.fake.setFile(`${ROOT}/a.txt`, 'one', { mtimeMs: START + 60_000 });

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(conflictsOf(result)).toEqual(['a.txt']);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('one');
  });

  it('does not write over a file that turned up on the server after the plan', async () => {
    const t = setup();
    t.write({ 'new.txt': 'mine' });
    const view = await t.planner.plan('site1');
    t.fake.setFile(`${ROOT}/new.txt`, 'theirs');

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(conflictsOf(result)).toEqual(['new.txt']);
    expect(t.fake.readFile(`${ROOT}/new.txt`)).toBe('theirs');
  });

  it('does not delete a file changed on the server after the plan', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one', 'b.txt': 'b' });
    await t.deploy();
    t.removeLocal('a.txt');
    const view = await t.planner.plan('site1');
    t.fake.setFile(`${ROOT}/a.txt`, 'edited there');

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(result).toMatchObject({ deleted: 0 });
    expect(conflictsOf(result)).toEqual(['a.txt']);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('edited there');
    expect(Object.keys((await t.base()).files).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('holds an overwrite to the server file the conflict showed', async () => {
    const t = await changedOnServer();
    const view = await t.planner.plan('site1');
    t.fake.setFile(`${ROOT}/a.txt`, 'theirs, again', { mtimeMs: START + 120_000 });

    const result = await t.runner.run(
      t.inputOf(view, () => ({ conflicts: { 'a.txt': 'overwrite' } })),
      'user',
    );

    expect(conflictsOf(result)).toEqual(['a.txt']);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('theirs, again');
  });

  it('asks the server once per file it writes, and not at all in a folder it just made', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a', 'made/b.txt': 'b' });
    await t.deploy();
    const stats = t.fake.calls.filter((call) => call.op === 'stat').map((call) => call.path);
    expect(stats).toEqual([`${ROOT}/a.txt`]);
  });

  it('never deletes a file changed on the server without a choice, or on a first deploy choice', async () => {
    const t = await deletedHereChangedThere();

    const { result } = await t.deploy(() => ({ firstDeploy: 'overwrite' }));

    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('edited there');
  });
});

describe('run: a first deploy over files already there', () => {
  function existing() {
    const t = setup();
    t.write({ 'index.html': 'same', 'about.html': 'differs' });
    t.fake.setFile(`${ROOT}/index.html`, 'SAME');
    t.fake.setFile(`${ROOT}/about.html`, 'other size');
    return t;
  }

  it('takes same-size files as sent without sending them, and sends the rest', async () => {
    const t = existing();
    const { result } = await t.deploy(() => ({ firstDeploy: 'adoptSameSize' }));
    expect(result).toMatchObject({ state: 'done', adopted: 1, uploaded: 1 });
    expect(t.puts()).toEqual([`${ROOT}/about.html`]);
    expect(t.fake.readFile(`${ROOT}/index.html`)).toBe('SAME');
    const base = await t.base();
    expect(base.files['index.html']?.remote).toEqual({ size: 4, mtimeMs: START, via: 'sftp' });
    expect((await t.planner.plan('site1')).changes).toEqual([]);
  });

  it('lets a choice for one file win over the first deploy choice', async () => {
    const t = existing();
    const { result } = await t.deploy(() => ({
      firstDeploy: 'adoptSameSize',
      conflicts: { 'about.html': 'skip' },
    }));
    expect(result).toMatchObject({ adopted: 1, uploaded: 0, skipped: 1 });
  });

  it('sends every file on overwrite', async () => {
    const t = existing();
    const { result } = await t.deploy(() => ({ firstDeploy: 'overwrite' }));
    expect(result).toMatchObject({ adopted: 0, uploaded: 2 });
    expect(t.fake.readFile(`${ROOT}/index.html`)).toBe('same');
  });

  it('touches nothing that is there without a choice', async () => {
    const t = existing();
    const { result } = await t.deploy();
    expect(result).toMatchObject({ adopted: 0, uploaded: 0, skipped: 2 });
    expect(t.puts()).toEqual([]);
  });
});

describe('run: files edited during the run', () => {
  it('skips a file edited after the plan, and it stays pending', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one', 'b.txt': 'two' });
    const view = await t.planner.plan('site1');
    t.write({ 'a.txt': 'edited' });

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(result).toMatchObject({ state: 'done', uploaded: 1, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBeNull();
    const next = await t.planner.plan('site1');
    expect(next.changes.map((change) => change.path)).toEqual(['a.txt']);
  });

  it('skips a file that changed while it was being sent', async () => {
    const t = setup({
      wrap: (remote) => ({
        ...remote,
        putFile: async (localPath, remotePath, put) =>
          remote.putFile(localPath, remotePath, { ...put, sha256: 'f'.repeat(64) }),
      }),
    });
    t.write({ 'a.txt': 'one' });
    const { result } = await t.deploy();
    expect(result).toMatchObject({ state: 'done', uploaded: 0, skipped: 1, failed: [] });
  });

  it('sends a file only touched after the plan, and records its new time', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    const view = await t.planner.plan('site1');
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(t.local, 'a.txt'), later, later);

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(result).toMatchObject({ uploaded: 1, skipped: 0 });
    expect((await t.base()).files['a.txt']?.localMtimeMs).toBe(
      statSync(join(t.local, 'a.txt')).mtimeMs,
    );
  });

  it('does not delete a file that came back here after the plan', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.removeLocal('a.txt');
    const view = await t.planner.plan('site1');
    t.write({ 'a.txt': 'back' });

    const result = await t.runner.run(t.inputOf(view), 'user');

    expect(result).toMatchObject({ deleted: 0, skipped: 1 });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('one');
  });
});

describe('run: failures, cancel and resume (AC5)', () => {
  it('keeps what it finished when the connection drops, and the next run sends only the rest', async () => {
    const t = setup({ maxParallel: 1 });
    t.write({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    t.fake.failOn(`${ROOT}/b.txt`, 'unreachable');

    const { result } = await t.deploy();

    expect(result.state).toBe('partial');
    expect(result.uploaded).toBe(1);
    expect(result.error?.code).toBe('unreachable');
    expect(result.failed.map((failure) => [failure.path, failure.code])).toEqual([
      ['b.txt', 'unreachable'],
    ]);
    expect(t.fake.readFile(`${ROOT}/c.txt`)).toBeNull();
    expect(Object.keys((await t.base()).files)).toEqual(['a.txt']);

    t.fake.failOn(`${ROOT}/b.txt`, null);
    t.clearCalls();
    const again = await t.deploy();
    expect(again.view.changes.map((change) => change.path)).toEqual(['b.txt', 'c.txt']);
    expect(t.puts()).toEqual([`${ROOT}/b.txt`, `${ROOT}/c.txt`]);
    expect(again.result.state).toBe('done');
  });

  it('lists a file the server refused and goes on with the rest', async () => {
    const t = setup({ maxParallel: 1 });
    t.write({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    t.fake.failOn(`${ROOT}/b.txt`, 'permissionDenied');

    const { result } = await t.deploy();

    expect(result).toMatchObject({ state: 'partial', uploaded: 2, error: null });
    expect(result.failed).toEqual([
      { path: 'b.txt', code: 'permissionDenied', message: expect.any(String) },
    ]);
  });

  it('fails when nothing could be sent', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    t.fake.failOn(`${ROOT}/a.txt`, 'permissionDenied');
    const { result } = await t.deploy();
    expect(result.state).toBe('failed');
  });

  it('stops on cancel, keeps what it finished, and the next run sends only the rest', async () => {
    const controller = new AbortController();
    const t = setup({
      maxParallel: 1,
      wrap: (remote) => ({
        ...remote,
        putFile: async (localPath, remotePath, put) => {
          const done = await remote.putFile(localPath, remotePath, put);
          controller.abort();
          return done;
        },
      }),
    });
    t.write({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });

    const { result } = await t.deploy(undefined, controller.signal);

    expect(result).toMatchObject({ state: 'cancelled', uploaded: 1, error: null });
    expect(existsSync(journalFile())).toBe(false);
    expect(Object.keys((await t.base()).files)).toEqual(['a.txt']);
    const next = await t.planner.plan('site1');
    expect(next.changes.map((change) => change.path)).toEqual(['b.txt', 'c.txt']);
  });

  it('fails with nothing sent when it cannot connect, and still writes history', async () => {
    const t = setup({
      runner: {
        openRemote: async () => {
          throw new FilesTransportError('auth', 'The server refused the password.');
        },
      },
    });
    t.write({ 'a.txt': 'a' });

    const { result } = await t.deploy();

    expect(result).toMatchObject({ state: 'failed', uploaded: 0 });
    expect(result.error?.code).toBe('auth');
    expect(await history.readHistory('site1')).toHaveLength(1);
  });

  it('opens the server unattended for Deploy on save only', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const view = await t.planner.plan('site1');
    await t.runner.run(t.inputOf(view), 'deployOnSave');
    t.write({ 'a.txt': 'aa' });
    await t.deploy();
    const runs = t.fake.opened.filter((open) => open.purpose === 'run');
    expect(runs.map((open) => open.unattended ?? false)).toEqual([true, false]);
  });

  it('can run the same plan again when it could not connect, and not once anything was sent', async () => {
    let refuse = true;
    const t = setup({
      runner: {
        openRemote: async (target, options) => {
          if (refuse) {
            throw new FilesTransportError('hostKeyChanged', 'The server presented another key.');
          }
          return t.fake.opener(target, options);
        },
      },
    });
    t.write({ 'a.txt': 'a' });
    const view = await t.planner.plan('site1');

    const first = await t.runner.run(t.inputOf(view), 'user');
    expect(first).toMatchObject({ state: 'failed', uploaded: 0 });
    expect(first.error?.code).toBe('hostKeyChanged');

    // The key trusted, the same review is deployed.
    refuse = false;
    const second = await t.runner.run(t.inputOf(view), 'user');
    expect(second).toMatchObject({ state: 'done', uploaded: 1 });

    const third = await t.runner.run(t.inputOf(view), 'user').then(
      () => null,
      (error) => filesErrorCode(error),
    );
    expect(third).toBe('planExpired');
  });

  it('refuses a plan made before the site was edited', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const view = await t.planner.plan('site1');
    // A new ignore line, say: only an edit by a person moves updatedAt.
    t.current.site = { ...t.current.site, ignorePatterns: ['a.txt'], updatedAt: 2 };

    const code = await t.runner.run(t.inputOf(view), 'user').then(
      () => null,
      (error) => filesErrorCode(error),
    );

    expect(code).toBe('planExpired');
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBeNull();
  });

  it('refuses a plan that is gone, or a site pointed elsewhere since the plan', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const view = await t.planner.plan('site1');
    t.current.site = { ...t.current.site, remoteRoot: '/srv/other' };
    const code = await t.runner.run(t.inputOf(view), 'user').then(
      () => null,
      (error) => filesErrorCode(error),
    );
    expect(code).toBe('planExpired');
    const again = await t.runner.run(t.inputOf(view), 'user').then(
      () => null,
      (error) => filesErrorCode(error),
    );
    expect(again).toBe('planExpired');
    expect(t.fake.opened.map((open) => open.purpose)).toEqual(['browse']);
  });
});

describe('run: how it talks to the server', () => {
  async function mostInFlight(options: FakeRemoteOptions): Promise<number> {
    let inFlight = 0;
    let most = 0;
    const t = setup({
      ...options,
      latencyMs: 2,
      wrap: (remote) => ({
        ...remote,
        putFile: async (localPath, remotePath, put) => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          try {
            return await remote.putFile(localPath, remotePath, put);
          } finally {
            inFlight -= 1;
          }
        },
      }),
    });
    const files: Record<string, string> = {};
    for (let index = 0; index < 8; index++) files[`${index}.txt`] = `file ${index}`;
    t.write(files);
    const { result } = await t.deploy();
    expect(result.uploaded).toBe(8);
    return most;
  }

  it('sends up to 4 files at once over SFTP', async () => {
    const most = await mostInFlight({ protocol: 'sftp' });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
  });

  it('sends one file at a time over FTP', async () => {
    expect(await mostInFlight({ protocol: 'ftp' })).toBe(1);
  });

  it('reads the time again on FTP where the upload did not report it', async () => {
    const t = setup({
      protocol: 'ftp',
      noMlsd: true,
      wrap: (remote) => ({
        ...remote,
        putFile: async (localPath, remotePath, put) => {
          const done = await remote.putFile(localPath, remotePath, put);
          return { ...done, stat: { ...done.stat, mtimeMs: null, via: null } };
        },
      }),
    });
    t.write({ 'a.txt': 'a' });

    await t.deploy();

    expect((await t.base()).files['a.txt']?.remote).toEqual({
      size: 1,
      mtimeMs: START,
      via: 'mdtm',
    });
    // Once before the upload, to see nothing turned up there, and once for the time.
    expect(t.fake.calls.filter((call) => call.op === 'stat').map((call) => call.path)).toEqual([
      `${ROOT}/a.txt`,
      `${ROOT}/a.txt`,
    ]);
  });

  it('says when a replace was not done in one step', async () => {
    const t = setup({ renameOverwriteRefused: true });
    t.write({ 'a.txt': 'one' });
    await t.deploy();
    t.write({ 'a.txt': 'second' });
    const { result } = await t.deploy();
    expect(result).toMatchObject({ uploaded: 1, atomic: false });
  });
});

describe('run: progress', () => {
  it('goes through the phases and ends with the totals', async () => {
    const t = setup();
    t.write({ 'a.txt': 'aa', 'b.txt': 'bbb' });
    await t.deploy();
    const phases = t.events.map((event) => event.phase);
    expect([...new Set(phases)]).toEqual([
      'connecting',
      'checking',
      'folders',
      'uploading',
      'deleting',
      'cleaning',
      'done',
    ]);
    expect(t.events.at(-1)).toMatchObject({
      siteId: 'site1',
      runId: 'run1',
      trigger: 'user',
      phase: 'done',
      filesDone: 2,
      filesTotal: 2,
      bytesDone: 5,
      bytesTotal: 5,
    });
  });

  it('sends at most 10 updates a second', async () => {
    const t = setup();
    const files: Record<string, string> = {};
    for (let index = 0; index < 30; index++) files[`${index}.txt`] = 'x'.repeat(100);
    t.write(files);
    await t.deploy();
    // The clock never moves here, so each phase sends only the update that starts it.
    expect(t.events.filter((event) => event.phase === 'uploading')).toHaveLength(1);
  });

  it('sends updates within a phase as time goes by', async () => {
    let clock = START;
    const t = setup({ now: () => (clock += 30) });
    const files: Record<string, string> = {};
    for (let index = 0; index < 30; index++) files[`${index}.txt`] = 'x'.repeat(100);
    t.write(files);
    await t.deploy();
    const uploading = t.events.filter((event) => event.phase === 'uploading');
    expect(uploading.length).toBeGreaterThan(1);
    for (let index = 1; index < uploading.length; index++) {
      expect(uploading[index]?.filesDone).toBeGreaterThanOrEqual(
        uploading[index - 1]?.filesDone ?? 0,
      );
    }
  });
});
