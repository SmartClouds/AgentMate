import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import type {
  FileSite,
  FileSiteConnectionInput,
  FileSiteInput,
  FilesCertificateInfo,
  FilesChangesSnapshot,
  FilesNeedsReview,
  FilesNeedsReviewEvent,
  FilesProgressEvent,
  FilesRunResult,
} from '../../../shared/deployFilesTypes';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { FilesServiceDeps } from './service';
import { createFakeRemote } from './transport/fakeRemote';
import type { OpenRemoteFiles } from './transport/types';
import type { FilesConnectTarget } from './types';

/**
 * The facade the IPC handlers call (E23): the site store, Test connection, the plan and the run,
 * trust, and Deploy on save, joined up. One deploy, test, forget or remove per site at a time;
 * trust is only stored after the server was read again; a run's outcome lands on the site and
 * in the windows.
 */

const userData = useTempUserData();
let service: typeof import('./service');
let store: typeof import('./store');
let bases: typeof import('./bases');

const ROOT = '/srv/site';
const SECRET = 'service-test-secret-that-must-stay-in-main';
const HOST_KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const CERT = 'ef'.repeat(32);
/** Deploy on save walks, plans and deploys in the background, which takes a while under load. */
const SLOW = { timeout: 15_000 };

beforeAll(async () => {
  await import('./service');
}, 120_000);

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: '/x', createdAt: '2026-01-01T00:00:00Z' },
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
  service = await import('./service');
  store = await import('./store');
  bases = await import('./bases');
});

function certificate(fingerprint256 = CERT): FilesCertificateInfo {
  return {
    fingerprint256,
    subject: 'CN=ftp.example.com',
    issuer: 'CN=ftp.example.com',
    names: ['ftp.example.com'],
    validTo: '2030-01-01',
    reason: 'selfSigned',
  };
}

function custom(
  overrides: Partial<Extract<FileSiteConnectionInput, { kind: 'custom' }>> = {},
): FileSiteConnectionInput {
  return {
    kind: 'custom',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: null,
    hostKeyFingerprint: null,
    tlsPin: null,
    tlsServername: null,
    secret: SECRET,
    ...overrides,
  };
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function setup(overrides: Partial<FilesServiceDeps> = {}) {
  const local = realpathSync(tempDir('runova-service-'));
  const fake = createFakeRemote();
  fake.setDir(ROOT);
  fake.setDir('/home/deploy');
  fake.setDir('/home/deploy/www');
  const gates: { run?: Gate; browse?: Gate } = {};
  const openRemote: OpenRemoteFiles = async (target, options) => {
    const held = gates[options.purpose];
    if (held) await held.promise;
    return fake.opener(target, options);
  };
  const changes: FilesChangesSnapshot[] = [];
  const progress: FilesProgressEvent[] = [];
  const finished: FilesRunResult[] = [];
  const reviews: FilesNeedsReviewEvent[] = [];
  const sitesChanged: FileSite[][] = [];
  const notified: { site: FileSite; review: FilesNeedsReview }[] = [];
  const watched: { root: string; settle: () => void; closed: boolean }[] = [];
  const timers = new Map<number, () => void>();
  let timerIds = 0;
  let unlock: (() => void) | null = null;
  const readHostKey = vi.fn(async (_target: FilesConnectTarget) => HOST_KEY);
  const readCertificate = vi.fn(async (_target: FilesConnectTarget) => certificate());
  const files = service.createFilesService({
    events: {
      changes: (snapshot) => changes.push(snapshot),
      progress: (event) => progress.push(event),
      runFinished: (result) => finished.push(result),
      needsReview: (event) => reviews.push(event),
      sitesChanged: (sites) => sitesChanged.push(sites),
    },
    notify: (site, review) => notified.push({ site, review }),
    openRemote,
    readHostKey,
    readCertificate,
    watch: (root, settle) => {
      const entry = { root, settle: () => settle('change'), closed: false };
      watched.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
    onVaultUnlocked: (listener) => {
      unlock = listener;
      return () => {
        unlock = null;
      };
    },
    setTimeout: (fn) => {
      timerIds += 1;
      timers.set(timerIds, fn);
      return timerIds;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    ...overrides,
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

  async function deployAll(siteId: string) {
    const view = await files.plan(siteId);
    return files.deploy({
      siteId,
      planId: view.planId,
      paths: view.changes.map((change) => change.path),
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
  }

  return {
    files,
    fake,
    local,
    gates,
    events: { changes, progress, finished, reviews, sitesChanged },
    notified,
    watched,
    readHostKey,
    readCertificate,
    input,
    deployAll,
    unlock: () => unlock?.(),
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    timerCount: () => timers.size,
    write: (tree: Record<string, string>) => writeTree(local, tree),
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

describe('service: sites', () => {
  it('creates, lists and reads public sites, and tells the windows', async () => {
    const t = setup();
    const created = await t.files.create(t.input({ connection: custom({ host: 'h.example' }) }));
    expect(created.connection).toMatchObject({ kind: 'custom', hasSecret: true });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    expect(await t.files.list()).toEqual([created]);
    expect(await t.files.get(created.id)).toEqual(created);
    expect(await t.files.get('missing')).toBeNull();
    expect(t.events.sitesChanged.at(-1)).toEqual([created]);
    expect(JSON.stringify(t.events.sitesChanged)).not.toContain('secretEnvelope');
  });

  it('tells the windows when a deleted project is unlinked from a site', async () => {
    const t = setup();
    const created = await t.files.create(t.input());
    await store.pruneFileSiteProjects(new Set());
    expect(t.events.sitesChanged.at(-1)?.[0]).toMatchObject({ id: created.id, projectIds: [] });
  });

  it('refuses a project that does not exist', async () => {
    const t = setup();
    expect(await codeOf(t.files.create(t.input({ projectIds: ['nope'] })))).toBe('projectUnknown');
  });

  it('updates a site and refuses one that is gone', async () => {
    const t = setup();
    const created = await t.files.create(t.input());
    const updated = await t.files.update(created.id, t.input({ label: 'Renamed' }));
    expect(updated.label).toBe('Renamed');
    expect(await codeOf(t.files.update('gone', t.input()))).toBe('siteUnknown');
  });

  it('forgets the kept plans of a site that was edited', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    const view = await t.files.plan(created.id);
    await t.files.update(created.id, t.input({ label: 'Renamed' }));
    const deploy = t.files.deploy({
      siteId: created.id,
      planId: view.planId,
      paths: ['a.txt'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(await codeOf(deploy)).toBe('planExpired');
  });
});

describe('service: trust from the form', () => {
  it('stores the host key the dialog trusted once the server shows it again', async () => {
    const t = setup();
    const created = await t.files.create(
      t.input({ connection: custom({ hostKeyFingerprint: HOST_KEY.toUpperCase() }) }),
    );
    expect(t.readHostKey).toHaveBeenCalledTimes(1);
    expect(t.readHostKey.mock.calls[0]?.[0].login).toMatchObject({ host: 'example.com', port: 22 });
    expect(created.connection).toMatchObject({ hostKeyFingerprint: HOST_KEY });
  });

  it('saves nothing when the server shows another key', async () => {
    const t = setup();
    t.readHostKey.mockResolvedValueOnce(OTHER_KEY);
    const create = t.files.create(
      t.input({ connection: custom({ hostKeyFingerprint: HOST_KEY }) }),
    );
    expect(await codeOf(create)).toBe('hostKeyChanged');
    expect(await t.files.list()).toEqual([]);
  });

  it('does not read the server again when the key is the one already stored', async () => {
    const t = setup();
    const created = await t.files.create(
      t.input({ connection: custom({ hostKeyFingerprint: HOST_KEY }) }),
    );
    t.readHostKey.mockClear();
    const updated = await t.files.update(
      created.id,
      t.input({ label: 'Again', connection: custom({ hostKeyFingerprint: HOST_KEY }) }),
    );
    expect(t.readHostKey).not.toHaveBeenCalled();
    expect(updated.connection).toMatchObject({ hostKeyFingerprint: HOST_KEY });
  });

  it('pins the FTPS certificate the dialog trusted once the server sends it again', async () => {
    const t = setup();
    const created = await t.files.create(
      t.input({
        protocol: 'ftps',
        connection: custom({ port: 21, tlsPin: CERT, tlsServername: 'shared.host' }),
      }),
    );
    expect(t.readCertificate).toHaveBeenCalledTimes(1);
    expect(t.readCertificate.mock.calls[0]?.[0].login).toMatchObject({
      tlsServername: 'shared.host',
    });
    expect(created.connection).toMatchObject({ tlsPin: CERT, tlsServername: 'shared.host' });

    t.readCertificate.mockResolvedValueOnce(certificate(OTHER_KEY));
    const update = t.files.update(
      created.id,
      t.input({ protocol: 'ftps', connection: custom({ port: 21, tlsPin: OTHER_KEY.slice(2) }) }),
    );
    expect(await codeOf(update)).toBe('invalidInput');
    const changed = t.files.update(
      created.id,
      t.input({ protocol: 'ftps', connection: custom({ port: 21, tlsPin: HOST_KEY }) }),
    );
    expect(await codeOf(changed)).toBe('tlsUntrusted');
  });

  it('ignores trust in the form of a site that signs in through a saved server', async () => {
    const t = setup();
    await t.files.create(t.input());
    expect(t.readHostKey).not.toHaveBeenCalled();
  });
});

describe('service: Test connection and the folder browser', () => {
  it('tests a site that is not saved yet, with no folders picked', async () => {
    const t = setup();
    const result = await t.files.test({
      siteId: null,
      site: t.input({ localFolder: '', remoteRoot: '' }),
    });
    expect(result).toMatchObject({ ok: true, remoteRoot: '/home/deploy', error: null });
  });

  it('connects with the host key the dialog trusted', async () => {
    const t = setup();
    await t.files.test({
      siteId: null,
      site: t.input({ connection: custom({ hostKeyFingerprint: HOST_KEY }) }),
    });
    expect(t.fake.opened[0]?.target.login).toMatchObject({ hostKeyFingerprint: HOST_KEY });
  });

  it('reuses the stored secret and keeps what it learned for a saved site', async () => {
    const t = setup();
    const created = await t.files.create(
      t.input({ protocol: 'ftp', connection: custom({ port: 21 }) }),
    );
    const { secret: _secret, ...withoutSecret } = custom({ port: 21 }) as Extract<
      FileSiteConnectionInput,
      { kind: 'custom' }
    >;
    const result = await t.files.test({
      siteId: created.id,
      site: t.input({ protocol: 'ftp', connection: withoutSecret }),
    });
    expect(result.ok).toBe(true);
    expect(t.fake.opened[0]?.target.login).toMatchObject({ secret: SECRET });
    expect((await t.files.get(created.id))?.capabilities).toMatchObject({ atomicReplace: true });
  });

  it('keeps nothing it learned about a server the site does not point at yet', async () => {
    const t = setup();
    const created = await t.files.create(t.input());
    await t.files.test({ siteId: created.id, site: t.input({ remoteRoot: '/home/deploy' }) });
    expect((await t.files.get(created.id))?.capabilities).toBeNull();
  });

  it('refuses a test of a site that is gone', async () => {
    const t = setup();
    expect(await codeOf(t.files.test({ siteId: 'gone', site: t.input() }))).toBe('siteUnknown');
  });

  it('lists the folders of a site under creation, and of a saved one', async () => {
    const t = setup();
    const fresh = await t.files.browseRemote({
      siteId: null,
      site: t.input({ remoteRoot: '', localFolder: '' }),
      path: null,
    });
    expect(fresh).toEqual({
      path: '/home/deploy',
      parent: '/home',
      folders: [{ name: 'www', path: '/home/deploy/www' }],
    });
    const created = await t.files.create(t.input());
    const saved = await t.files.browseRemote({ siteId: created.id, site: null, path: '/srv' });
    expect(saved.folders).toEqual([{ name: 'site', path: ROOT }]);
    expect(t.fake.opened.every((open) => open.purpose === 'browse')).toBe(true);
    expect(await codeOf(t.files.browseRemote({ siteId: null, site: null, path: null }))).toBe(
      'invalidInput',
    );
  });
});

describe('service: deploys', () => {
  it('deploys, records the outcome on the site and tells the windows', async () => {
    const t = setup();
    t.write({ 'index.html': '<h1>hi</h1>' });
    const created = await t.files.create(t.input());
    const before = await t.files.subscribe(created.id, 'win1');
    expect(before.files.map((file) => file.path)).toEqual(['index.html']);

    const result = await t.deployAll(created.id);

    expect(result).toMatchObject({ state: 'done', uploaded: 1, trigger: 'user' });
    expect(t.fake.readFile(`${ROOT}/index.html`)).toBe('<h1>hi</h1>');
    expect(t.events.finished).toEqual([result]);
    expect(t.events.progress.length).toBeGreaterThan(0);
    expect((await t.files.get(created.id))?.lastDeploy).toEqual({
      at: result.finishedAt,
      state: 'done',
      trigger: 'user',
      uploaded: 1,
      deleted: 0,
      failed: 0,
    });
    // Refreshed before the deploy answered.
    expect(t.events.changes.at(-1)?.files).toEqual([]);
    expect((await t.files.changes(created.id)).files).toEqual([]);
    expect(await t.files.history(created.id)).toEqual([result]);
  });

  it('lets one deploy, test, forget or remove run at a time per site', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    const view = await t.files.plan(created.id);
    t.gates.run = gate();
    const first = t.files.deploy({
      siteId: created.id,
      planId: view.planId,
      paths: ['a.txt'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    const again = t.files.deploy({
      siteId: created.id,
      planId: view.planId,
      paths: [],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(await codeOf(again)).toBe('busy');
    expect(await codeOf(t.files.test({ siteId: created.id, site: t.input() }))).toBe('busy');
    expect(await codeOf(t.files.forgetBase(created.id))).toBe('busy');
    expect(await codeOf(t.files.remove(created.id))).toBe('busy');
    t.gates.run.open();
    expect((await first).state).toBe('done');
    t.gates.run = undefined;
    await t.files.forgetBase(created.id);
  });

  it('cancels the running deploy of a site', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    const view = await t.files.plan(created.id);
    t.gates.run = gate();
    const running = t.files.deploy({
      siteId: created.id,
      planId: view.planId,
      paths: ['a.txt'],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    await vi.waitFor(() => expect(t.events.progress.length).toBeGreaterThan(0), SLOW);
    await t.files.cancel(created.id);
    await t.files.cancel('nothing-running');
    t.gates.run.open();
    expect((await running).state).toBe('cancelled');
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBeNull();
  });

  it('lets go of the lock when the plan is gone', async () => {
    const t = setup();
    const created = await t.files.create(t.input());
    const deploy = t.files.deploy({
      siteId: created.id,
      planId: 'nope',
      paths: [],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(await codeOf(deploy)).toBe('planExpired');
    await t.files.forgetBase(created.id);
    expect(t.events.finished).toEqual([]);
  });

  it('clears a conflicts or failed review after a deploy by hand that worked', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    await store.setNeedsReview(created.id, { reason: 'conflicts', message: 'look', at: 1 });
    await t.deployAll(created.id);
    expect((await t.files.get(created.id))?.needsReview).toBeNull();
    expect(t.events.reviews).toContainEqual({ siteId: created.id, needsReview: null });

    await store.setNeedsReview(created.id, { reason: 'paused', message: 'locked', at: 2 });
    t.write({ 'b.txt': 'b' });
    await t.deployAll(created.id);
    expect((await t.files.get(created.id))?.needsReview).toMatchObject({ reason: 'paused' });
  });

  it('never folds the journal a run may be writing when it lists the changes', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    await t.deployAll(created.id);
    const journal = join(
      userData.dir,
      'data',
      'deploy-files',
      'bases',
      `${created.id}.journal.jsonl`,
    );
    writeFileSync(journal, `${JSON.stringify({ t: 'drop', path: 'a.txt' })}\n`);
    const snapshot = await t.files.changes(created.id);
    expect(existsSync(journal)).toBe(true);
    // The drop is seen: a.txt no longer counts as deployed.
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('answers the changes from the watched snapshot without walking again', async () => {
    const walk = vi.fn((await import('./localWalk')).walkSiteFolder);
    const t = setup({ walk });
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    await t.files.subscribe(created.id, 'win1');
    const walks = walk.mock.calls.length;
    expect((await t.files.changes(created.id)).files).toHaveLength(1);
    expect(walk.mock.calls.length).toBe(walks);
    t.files.unsubscribe(created.id, 'win1');
    await t.files.changes(created.id);
    expect(walk.mock.calls.length).toBe(walks + 1);
  });

  it('lets a window that closed go of every site it watched', async () => {
    const t = setup();
    const one = await t.files.create(t.input());
    const two = await t.files.create(t.input({ label: 'Two' }));
    await t.files.subscribe(one.id, 'win1');
    await t.files.subscribe(two.id, 'win1');
    await t.files.subscribe(two.id, 'win2');
    t.files.dropSubscriber('win1');
    expect(t.watched.map((entry) => entry.closed)).toEqual([true, false]);
  });
});

describe('service: forget and remove', () => {
  it('forgets what was deployed, so the next deploy is a first one again', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    await t.deployAll(created.id);
    const view = await t.files.plan(created.id);
    await t.files.forgetBase(created.id);
    const snapshot = await t.files.changes(created.id);
    expect(snapshot).toMatchObject({ firstDeploy: true });
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.txt']);
    const stale = t.files.deploy({
      siteId: created.id,
      planId: view.planId,
      paths: [],
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    });
    expect(await codeOf(stale)).toBe('planExpired');
    expect(await codeOf(t.files.forgetBase('gone'))).toBe('siteUnknown');
  });

  it('removes the site and what this computer kept, and never touches the server', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input({ deployOnSave: true }));
    await t.files.subscribe(created.id, 'win1');
    await t.deployAll(created.id);
    await t.files.remove(created.id);

    expect(await t.files.list()).toEqual([]);
    expect(await t.files.history(created.id)).toEqual([]);
    expect(
      existsSync(join(userData.dir, 'data', 'deploy-files', 'bases', `${created.id}.json`)),
    ).toBe(false);
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('a');
    expect(t.watched.every((entry) => entry.closed)).toBe(true);
    expect(t.events.sitesChanged.at(-1)).toEqual([]);
    await t.files.remove(created.id);
  });
});

describe('service: host keys and certificates', () => {
  async function ownLogin(t: ReturnType<typeof setup>) {
    return t.files.create(t.input({ connection: custom({ hostKeyFingerprint: HOST_KEY }) }));
  }

  it('says which key is stored and which the server shows', async () => {
    const t = setup();
    const created = await ownLogin(t);
    t.readHostKey.mockResolvedValueOnce(OTHER_KEY);
    expect(await t.files.hostKeyStatus(created.id)).toEqual({
      serverId: created.id,
      nickname: 'Shop',
      host: 'example.com',
      port: 22,
      stored: HOST_KEY,
      presented: OTHER_KEY,
    });
    const saved = await t.files.create(t.input());
    expect(await codeOf(t.files.hostKeyStatus(saved.id))).toBe('invalidInput');
    expect(await codeOf(t.files.hostKeyStatus('gone'))).toBe('siteUnknown');
  });

  it('trusts a new key only when the server still shows it', async () => {
    const t = setup();
    const created = await ownLogin(t);
    t.readHostKey.mockResolvedValue(OTHER_KEY);
    await t.files.trustHostKey(created.id, OTHER_KEY);
    expect((await t.files.get(created.id))?.connection).toMatchObject({
      hostKeyFingerprint: OTHER_KEY,
    });
    expect(await codeOf(t.files.trustHostKey(created.id, HOST_KEY))).toBe('hostKeyChanged');
    expect(await codeOf(t.files.trustHostKey(created.id, 'nope'))).toBe('invalidInput');
  });

  it('deploys the same review again once the new host key is trusted', async () => {
    let refuse = true;
    let opener: OpenRemoteFiles | null = null;
    const t = setup({
      openRemote: async (target, options) => {
        if (options.purpose === 'run' && refuse) {
          throw new Error('[files:hostKeyChanged] The server presented another key.');
        }
        return (opener as OpenRemoteFiles)(target, options);
      },
    });
    opener = t.fake.opener;
    t.write({ 'a.txt': 'a' });
    const created = await ownLogin(t);
    const view = await t.files.plan(created.id);
    const input = {
      siteId: created.id,
      planId: view.planId,
      paths: view.changes.map((change) => change.path),
      conflicts: {},
      firstDeploy: null,
      reupload: [],
    };

    const first = await t.files.deploy(input);
    expect(first.error?.code).toBe('hostKeyChanged');
    refuse = false;
    t.readHostKey.mockResolvedValue(OTHER_KEY);
    await t.files.trustHostKey(created.id, OTHER_KEY);

    expect(await t.files.deploy(input)).toMatchObject({ state: 'done', uploaded: 1 });
  });

  it('pins a certificate only when the server still sends it', async () => {
    const t = setup();
    const created = await t.files.create(
      t.input({ protocol: 'ftps', connection: custom({ port: 21 }) }),
    );
    await t.files.trustCertificate(created.id, CERT);
    expect((await t.files.get(created.id))?.connection).toMatchObject({ tlsPin: CERT });
    expect(await codeOf(t.files.trustCertificate(created.id, OTHER_KEY))).toBe('tlsUntrusted');
    const sftp = await ownLogin(t);
    expect(await codeOf(t.files.trustCertificate(sftp.id, CERT))).toBe('invalidInput');
  });
});

describe('service: Deploy on save', () => {
  it('watches the folder once it is turned on, and deploys after the quiet period', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    const on = await t.files.setDeployOnSave(created.id, true);
    expect(on.deployOnSave).toBe(true);
    await vi.waitFor(() => expect(t.timerCount()).toBe(1), SLOW);
    t.runTimers();
    await vi.waitFor(() => expect(t.events.finished).toHaveLength(1), SLOW);
    expect(t.events.finished[0]).toMatchObject({
      trigger: 'deployOnSave',
      state: 'done',
      uploaded: 1,
    });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('a');
    expect((await t.files.get(created.id))?.lastDeploy).toMatchObject({ trigger: 'deployOnSave' });
    // Nobody is there to trust a host key: the plan and the run both say so.
    expect(t.fake.opened.map((open) => [open.purpose, open.unattended ?? false])).toEqual([
      ['browse', true],
      ['run', true],
    ]);

    const off = await t.files.setDeployOnSave(created.id, false);
    expect(off.deployOnSave).toBe(false);
    expect(t.watched.every((entry) => entry.closed)).toBe(true);
    expect(await codeOf(t.files.setDeployOnSave('gone', true))).toBe('siteUnknown');
  }, 60_000);

  it('stops for a conflict, asks for a review and notifies once', async () => {
    const t = setup();
    t.write({ 'a.txt': 'one' });
    const created = await t.files.create(t.input());
    await t.deployAll(created.id);
    t.write({ 'a.txt': 'mine' });
    t.fake.setFile(`${ROOT}/a.txt`, 'theirs!', { mtimeMs: Date.now() + 120_000 });
    await t.files.setDeployOnSave(created.id, true);
    await vi.waitFor(() => expect(t.timerCount()).toBe(1), SLOW);
    t.runTimers();
    await vi.waitFor(() => expect(t.notified).toHaveLength(1), SLOW);
    expect(t.notified[0]?.site.id).toBe(created.id);
    expect(t.notified[0]?.review.reason).toBe('conflicts');
    expect(t.events.reviews.at(-1)).toMatchObject({
      siteId: created.id,
      needsReview: { reason: 'conflicts' },
    });
    expect((await t.files.get(created.id))?.needsReview).toMatchObject({ reason: 'conflicts' });
    expect(t.fake.readFile(`${ROOT}/a.txt`)).toBe('theirs!');
  }, 60_000);

  it('starts Deploy on save for every site that has it on, and stops on close', async () => {
    const t = setup();
    const created = await t.files.create(t.input({ deployOnSave: true }));
    await t.files.create(t.input({ label: 'Off' }));
    const other = setup();
    await other.files.start();
    await vi.waitFor(() => expect(other.watched).toHaveLength(1), SLOW);
    expect(other.watched[0]?.root).toBe(t.local);
    other.files.close();
    expect(other.watched[0]?.closed).toBe(true);
    expect(created.deployOnSave).toBe(true);
  });

  it('folds the journal a stopped run left behind at start', async () => {
    const t = setup();
    t.write({ 'a.txt': 'a' });
    const created = await t.files.create(t.input());
    await t.deployAll(created.id);
    const dir = join(userData.dir, 'data', 'deploy-files', 'bases');
    mkdirSync(dir, { recursive: true });
    const journal = join(dir, `${created.id}.journal.jsonl`);
    writeFileSync(journal, `${JSON.stringify({ t: 'drop', path: 'a.txt' })}\n`);
    await t.files.start();
    expect(existsSync(journal)).toBe(false);
    const site = await store.getFileSite(created.id);
    const base = await bases.peekBase(created.id, bases.baseTargetOf(site as never));
    expect(base.files).toEqual({});
  });
});

describe('service: ignore lines', () => {
  it('passes good lines, blank ones included', () => {
    expect(service.checkIgnoreLines(['*.log', '', '!keep.log', '# a note'])).toEqual({ ok: true });
  });

  it('names the first bad line by its number in the box', () => {
    const check = service.checkIgnoreLines(['*.log', '', 'a[', 'b[']);
    expect(check).toMatchObject({ ok: false, line: 3 });
    expect(check.ok === false && check.reason).toBeTruthy();
  });

  it('refuses a line that is too long, or one with a line break in it', () => {
    expect(service.checkIgnoreLines(['ok', 'x'.repeat(501)])).toMatchObject({ ok: false, line: 2 });
    expect(service.checkIgnoreLines(['a\nb'])).toMatchObject({ ok: false, line: 1 });
  });
});
