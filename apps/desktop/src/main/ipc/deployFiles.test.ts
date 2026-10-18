import { realpathSync, writeFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import type {
  FileSite,
  FileSiteInput,
  FilesChangesSnapshot,
  FilesPlanView,
  FilesRunResult,
  FilesTestResult,
} from '../../shared/deployFilesTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  electronState,
  FakeBrowserWindow,
  fakeWebContents,
  queueDialog,
} from '../../test/main/electronMock';
import { tempDir, writeTree } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { FakeRemote } from '../deploy/files/transport/fakeRemote';

/**
 * The FTP and SFTP site channels (E23): every argument is checked before the service hears of it,
 * only the main window is answered, failures keep their `[files:code]` tag, and a password typed
 * into the dialog never comes back out of any of them.
 */

const userData = useTempUserData();
// The on* channels go from main to the windows; index.ts broadcasts them.
expectChannelsCovered(
  IPC.deployFiles,
  Object.entries(IPC.deployFiles)
    .filter(([name]) => name.startsWith('on'))
    .map(([, channel]) => channel),
);

const C = IPC.deployFiles;
const ROOT = '/srv/site';
const SECRET = 'ipc-secret-typed-into-the-dialog';
const HOST_KEY = 'ab'.repeat(32);
const CERT = 'ef'.repeat(32);

let fake: FakeRemote;
let local = '';
let allowed = true;
let events: unknown[] = [];
let watchers: { root: string; closed: boolean }[] = [];

beforeAll(async () => {
  await import('../deploy/files/service');
}, 120_000);

beforeEach(async () => {
  allowed = true;
  events = [];
  watchers = [];
  local = realpathSync(tempDir('agentmate-ipc-files-'));
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: local, createdAt: '2026-01-01T00:00:00Z' },
  ]);
  userData.writeData('ssh-servers.json', [
    {
      id: 'srv-1',
      nickname: 'web',
      host: 'web.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      createdAt: 1,
      lastConnectedAt: null,
    },
  ]);
  const { createFakeRemote } = await import('../deploy/files/transport/fakeRemote');
  fake = createFakeRemote();
  fake.setDir(ROOT);
  fake.setDir('/home/deploy');
  await loadIpc(
    () => import('./deployFiles'),
    async (ipc) => {
      const { createFilesService } = await import('../deploy/files/service');
      const service = createFilesService({
        events: {
          changes: (payload) => events.push(payload),
          progress: (payload) => events.push(payload),
          runFinished: (payload) => events.push(payload),
          needsReview: (payload) => events.push(payload),
          sitesChanged: (payload) => events.push(payload),
        },
        openRemote: fake.opener,
        readHostKey: async () => HOST_KEY,
        readCertificate: async () => ({
          fingerprint256: CERT,
          subject: 'CN=a',
          issuer: 'CN=a',
          names: ['a'],
          validTo: '2030-01-01',
          reason: 'selfSigned',
        }),
        watch: (root) => {
          const watcher = { root, closed: false };
          watchers.push(watcher);
          return {
            close: () => {
              watcher.closed = true;
            },
          };
        },
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      });
      ipc.registerDeployFilesHandlers({ service, guard: () => allowed });
    },
  );
});

function input(overrides: Partial<FileSiteInput> = {}): FileSiteInput {
  return {
    label: 'Shop',
    protocol: 'sftp',
    connection: { kind: 'saved', sshServerId: 'srv-1' },
    remoteRoot: ROOT,
    localFolder: local,
    projectIds: ['p1'],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    ...overrides,
  };
}

function ownLogin(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'custom' as const,
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password' as const,
    privateKeyPath: null,
    hostKeyFingerprint: HOST_KEY,
    tlsPin: null,
    tlsServername: null,
    secret: SECRET,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string | null; text: string }> {
  try {
    await promise;
  } catch (error) {
    return { code: filesErrorCode(error), text: (error as Error).message };
  }
  throw new Error('Expected the call to fail.');
}

describe('deployFiles channels: sites', () => {
  it('creates, lists, reads, updates and removes a site', async () => {
    const created = await invoke<FileSite>(C.create, input());
    expect(await invoke<FileSite[]>(C.list)).toEqual([created]);
    expect(await invoke<FileSite | null>(C.get, created.id)).toEqual(created);
    expect(await invoke<FileSite | null>(C.get, 'missing')).toBeNull();
    const updated = await invoke<FileSite>(C.update, created.id, input({ label: 'New name' }));
    expect(updated.label).toBe('New name');
    await invoke(C.remove, created.id);
    expect(await invoke<FileSite[]>(C.list)).toEqual([]);
  });

  it('checks every argument before the service hears of it', async () => {
    expect((await failure(invoke(C.get, 42))).code).toBe('invalidInput');
    expect((await failure(invoke(C.create, { label: 'x' }))).code).toBe('invalidInput');
    expect((await failure(invoke(C.update, 'a', null))).code).toBe('invalidInput');
    expect((await failure(invoke(C.remove, ''))).code).toBe('invalidInput');
    expect((await failure(invoke(C.setDeployOnSave, 'a', 'yes'))).code).toBe('invalidInput');
    expect((await failure(invoke(C.plan, 'site'))).code).toBe('invalidInput');
    expect((await failure(invoke(C.deploy, { siteId: 'a' }))).code).toBe('invalidInput');
    expect((await failure(invoke(C.validateIgnore, 'one line'))).code).toBe('invalidInput');
    expect((await failure(invoke(C.trustHostKey, 'a', 7))).code).toBe('invalidInput');
    expect((await failure(invoke(C.browseRemote, { siteId: 3 }))).code).toBe('invalidInput');
    expect((await failure(invoke(C.test, { site: input() }))).code).toBe('invalidInput');
  });

  it('refuses a project that does not exist', async () => {
    const result = await failure(invoke(C.create, input({ projectIds: ['gone'] })));
    expect(result.code).toBe('projectUnknown');
  });

  it('answers only the main window', async () => {
    allowed = false;
    const result = await failure(invoke(C.list));
    expect(result.text).toMatch(/main window/);
  });

  it('keeps the code of a failure the service did not code', async () => {
    // A file that is not JSON at all: the store refuses it without a code of its own.
    writeFileSync(userData.dataFile('deploy-files.json'), '{', 'utf-8');
    expect((await failure(invoke(C.list))).code).toBe('server');
  });

  it('opens the folder dialog on the calling window', async () => {
    const win = new FakeBrowserWindow();
    queueDialog('showOpenDialog', { canceled: false, filePaths: [local] });
    expect(await invokeFrom<string | null>(win.webContents, C.pickLocalFolder, local)).toBe(local);
    const call = electronState.dialogCalls.at(-1);
    expect(call?.args[0]).toBe(win);
    expect(call?.args[1]).toMatchObject({ defaultPath: local });
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invokeFrom(win.webContents, C.pickLocalFolder, 'relative/path')).toBeNull();
    expect(electronState.dialogCalls.at(-1)?.args[1]).not.toHaveProperty('defaultPath');
    expect((await failure(invoke(C.pickLocalFolder, 5))).code).toBe('invalidInput');
  });

  it('checks ignore lines, blank ones counted', async () => {
    expect(await invoke(C.validateIgnore, ['*.log', '', 'a['])).toMatchObject({
      ok: false,
      line: 3,
    });
    expect(await invoke(C.validateIgnore, ['*.log'])).toEqual({ ok: true });
  });
});

describe('deployFiles channels: changes, plan and deploy', () => {
  it('watches for the calling window, and lets go when the window goes away', async () => {
    writeTree(local, { 'a.txt': 'a' });
    const created = await invoke<FileSite>(C.create, input());
    const listeners = new Map<string, () => void>();
    const sender = {
      ...fakeWebContents(),
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      once: (event: string, listener: () => void) => listeners.set(event, listener),
    };
    const snapshot = await invokeFrom<FilesChangesSnapshot>(
      sender as never,
      C.subscribe,
      created.id,
    );
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.txt']);
    await invokeFrom<FilesChangesSnapshot>(sender as never, C.subscribe, created.id);
    expect([...listeners.keys()].sort()).toEqual([
      'destroyed',
      'did-navigate',
      'render-process-gone',
    ]);
    expect(watchers.map((watcher) => watcher.closed)).toEqual([false]);
    listeners.get('destroyed')?.();
    expect(watchers.map((watcher) => watcher.closed)).toEqual([true]);
    await invokeFrom(sender as never, C.unsubscribe, created.id);
    expect((await invoke<FilesChangesSnapshot>(C.changes, created.id)).files).toHaveLength(1);
  });

  it('plans, deploys, lists history, forgets and cancels', async () => {
    writeTree(local, { 'a.txt': 'a' });
    const created = await invoke<FileSite>(C.create, input());
    const view = await invoke<FilesPlanView>(C.plan, { siteId: created.id });
    const result = await invoke<FilesRunResult>(C.deploy, {
      siteId: created.id,
      planId: view.planId,
      paths: ['a.txt'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(result).toMatchObject({ state: 'done', uploaded: 1 });
    expect(await invoke(C.history, created.id)).toEqual([result]);
    await invoke(C.cancel, created.id);
    await invoke(C.forgetBase, created.id);
    expect((await invoke<FilesChangesSnapshot>(C.changes, created.id)).firstDeploy).toBe(true);
    const stale = await failure(
      invoke(C.deploy, {
        siteId: created.id,
        planId: view.planId,
        paths: [],
        conflicts: { 'a.txt': 'skip' },
        firstDeploy: null,
        reupload: [],
      }),
    );
    expect(stale.code).toBe('planExpired');
    expect(stale.text).toContain('[files:planExpired]');
  });

  it('turns Deploy on save on and off', async () => {
    const created = await invoke<FileSite>(C.create, input());
    expect((await invoke<FileSite>(C.setDeployOnSave, created.id, true)).deployOnSave).toBe(true);
    expect((await invoke<FileSite>(C.setDeployOnSave, created.id, false)).deployOnSave).toBe(false);
  });
});

describe('deployFiles channels: trust', () => {
  it('reads and trusts host keys and certificates through the site', async () => {
    const sftp = await invoke<FileSite>(C.create, input({ connection: ownLogin() }));
    expect(await invoke(C.hostKeyStatus, sftp.id)).toMatchObject({
      stored: HOST_KEY,
      presented: HOST_KEY,
    });
    await invoke(C.trustHostKey, sftp.id, HOST_KEY);
    const ftps = await invoke<FileSite>(
      C.create,
      input({ protocol: 'ftps', connection: ownLogin({ port: 21, hostKeyFingerprint: null }) }),
    );
    await invoke(C.trustCertificate, ftps.id, CERT);
    expect((await invoke<FileSite>(C.get, ftps.id)).connection).toMatchObject({ tlsPin: CERT });
    const changed = await failure(invoke(C.trustCertificate, ftps.id, HOST_KEY));
    expect(changed.code).toBe('tlsUntrusted');
  });
});

describe('deployFiles channels: no secret crosses', () => {
  it('never returns the password typed in, whatever the call', async () => {
    writeTree(local, { 'a.txt': 'a' });
    const site = await invoke<FileSite>(C.create, input({ connection: ownLogin() }));
    const answers: unknown[] = [site];
    const call = async (channel: string, ...args: unknown[]) => {
      try {
        answers.push(await invoke(channel, ...args));
      } catch (error) {
        answers.push((error as Error).message);
      }
    };
    await call(C.list);
    await call(C.get, site.id);
    await call(C.update, site.id, input({ label: 'Again', connection: ownLogin() }));
    await call(C.test, { siteId: site.id, site: input({ connection: ownLogin() }) });
    await call(C.test, { siteId: null, site: input({ connection: ownLogin(), remoteRoot: '' }) });
    await call(C.browseRemote, { siteId: site.id, site: null, path: null });
    await call(C.browseRemote, {
      siteId: null,
      site: input({ connection: ownLogin() }),
      path: '/',
    });
    await call(C.subscribe, site.id);
    await call(C.changes, site.id);
    await call(C.plan, { siteId: site.id });
    const plan = answers.at(-1) as FilesPlanView;
    await call(C.deploy, {
      siteId: site.id,
      planId: plan.planId,
      paths: ['a.txt'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    fake.failOn(`${ROOT}/a.txt`, 'permissionDenied');
    writeTree(local, { 'a.txt': 'changed' });
    await call(C.plan, { siteId: site.id });
    await call(C.history, site.id);
    await call(C.hostKeyStatus, site.id);
    await call(C.trustHostKey, site.id, HOST_KEY);
    await call(C.setDeployOnSave, site.id, true);
    await call(C.setDeployOnSave, site.id, false);
    await call(C.unsubscribe, site.id);
    await call(C.forgetBase, site.id);
    await call(C.remove, site.id);

    const text = JSON.stringify([answers, events]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secretEnvelope');
    expect(text).not.toContain('ciphertext');
    expect((answers[4] as FilesTestResult).ok).toBe(true);
    expect(answers.length).toBeGreaterThan(20);
  });
});
