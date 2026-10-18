import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FileSiteConnectionInput, FileSiteInput } from '../../../shared/deployFilesTypes';
import { setElectronPath } from '../../../test/main/electronMock';
import { tempDir } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';
import type { StoredFileSite } from './types';

/**
 * The FTP and SFTP sites the user added (E23), in `deploy-files.json`. A password or key
 * passphrase is only ever on disk sealed with the Servers vault and never in what the renderer
 * gets; every change goes through one queue; the local and remote folders are checked and
 * tidied before anything is saved.
 */

const userData = useTempUserData();
let sites: typeof import('./store');
let vault: typeof import('../../ssh/vault');

const SECRET = 'hunter2-plaintext-that-must-not-leak';
const FINGERPRINT = 'ab'.repeat(32);
let folder = '';

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

function input(overrides: Partial<FileSiteInput> = {}): FileSiteInput {
  return {
    label: 'Marketing site',
    protocol: 'sftp',
    connection: custom(),
    remoteRoot: '/var/www/site',
    localFolder: folder,
    projectIds: ['p1'],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    ...overrides,
  };
}

function onDisk(): string {
  return readFileSync(userData.dataFile('deploy-files.json'), 'utf-8');
}

function customOf(site: StoredFileSite) {
  if (site.connection.kind !== 'custom') throw new Error('expected a login of its own');
  return site.connection;
}

// The first import transforms the whole main-process store graph, which takes a while on a busy
// machine; doing it once here keeps that out of the first test's hook timeout.
beforeAll(async () => {
  await import('./store');
}, 120_000);

beforeEach(async () => {
  folder = realpathSync(tempDir('agentmate-site-'));
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: folder, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: folder, createdAt: '2026-01-01T00:00:00Z' },
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
  sites = await import('./store');
  vault = await import('../../ssh/vault');
});

describe('reading and writing', () => {
  it('starts empty when there is no file', async () => {
    expect(await sites.readFileSites()).toEqual([]);
    expect(await sites.getFileSite('nope')).toBeNull();
  });

  it('saves a site and reads it back', async () => {
    const created = await sites.createFileSite(input(), 1000);
    expect(created).toMatchObject({
      label: 'Marketing site',
      protocol: 'sftp',
      remoteRoot: '/var/www/site',
      localFolder: folder,
      projectIds: ['p1'],
      deployOnSave: false,
      quietSeconds: 5,
      ignorePatterns: [],
      capabilities: null,
      lastDeploy: null,
      needsReview: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(created.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await sites.getFileSite(created.id)).toEqual(created);
    expect(JSON.parse(onDisk())).toMatchObject({ version: 1, sites: [{ id: created.id }] });
  });

  it('keeps the secret sealed on disk', async () => {
    const created = await sites.createFileSite(input());
    expect(onDisk()).not.toContain(SECRET);
    const envelope = customOf(created).secretEnvelope;
    expect(envelope).not.toBeNull();
    expect(await vault.decryptSecret(envelope as never)).toBe(SECRET);
  });

  it('runs changes one after another so none is lost', async () => {
    await Promise.all([
      sites.createFileSite(input({ label: 'A' })),
      sites.createFileSite(input({ label: 'B' })),
      sites.createFileSite(input({ label: 'C' })),
    ]);
    expect((await sites.readFileSites()).map((site) => site.label).sort()).toEqual(['A', 'B', 'C']);
  });

  it('keeps going after a change that throws, and writes nothing for it', async () => {
    await expect(
      sites.mutateFileSites((state) => {
        state.sites.push({ id: 'half' } as StoredFileSite);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await sites.createFileSite(input());
    expect(await sites.readFileSites()).toHaveLength(1);
  });

  it('drops malformed records instead of trusting them', async () => {
    const good = await sites.createFileSite(input());
    userData.writeData('deploy-files.json', {
      version: 1,
      sites: [
        good,
        { ...good, id: 'bad-protocol', protocol: 'scp' },
        { ...good, id: 'bad-connection', connection: { kind: 'carrier pigeon' } },
        { ...good, id: good.id },
        'nonsense',
      ],
    });
    expect((await sites.readFileSites()).map((site) => site.id)).toEqual([good.id]);
  });

  it('keeps a site whose local folder is gone, so it can say the folder is missing', async () => {
    const created = await sites.createFileSite(input());
    userData.writeData('deploy-files.json', {
      version: 1,
      sites: [{ ...created, localFolder: join(folder, 'moved-away') }],
    });
    expect(await sites.readFileSites()).toHaveLength(1);
  });

  it('keeps a record whose values drifted out of range, and brings them back in', async () => {
    const created = await sites.createFileSite(input());
    userData.writeData('deploy-files.json', {
      version: 1,
      sites: [{ ...created, quietSeconds: 1, label: 'x'.repeat(130) }],
    });
    const [read] = await sites.readFileSites();
    expect(read.quietSeconds).toBe(2);
    expect(customOf(read).secretEnvelope).toEqual(customOf(created).secretEnvelope);
  });

  it('refuses a file that is not JSON, so a write cannot wipe it', async () => {
    writeFileSync(userData.dataFile('deploy-files.json'), '{ not json', 'utf-8');
    await expect(sites.readFileSites()).rejects.toThrow(/deploy-files\.json/);
    await expect(sites.createFileSite(input())).rejects.toThrow(/deploy-files\.json/);
    expect(onDisk()).toBe('{ not json');
  });
});

describe('toPublicFileSite', () => {
  it('says whether there is a secret and never carries it', async () => {
    const created = await sites.createFileSite(input());
    const envelope = customOf(created).secretEnvelope;
    const shown = sites.toPublicFileSite(created);
    expect(shown.connection).toEqual({
      kind: 'custom',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: null,
      tlsPin: null,
      tlsServername: null,
      hasSecret: true,
    });
    const text = JSON.stringify(shown);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secretEnvelope');
    expect(text).not.toContain(envelope?.ciphertext ?? 'never');
  });

  it('says there is none for a login without one', async () => {
    const created = await sites.createFileSite(
      input({ connection: custom({ secret: undefined }) }),
    );
    expect(sites.toPublicFileSite(created).connection).toMatchObject({ hasSecret: false });
  });

  it('passes a saved server through', async () => {
    const created = await sites.createFileSite(
      input({ connection: { kind: 'saved', sshServerId: 'srv-1' } }),
    );
    expect(sites.toPublicFileSite(created).connection).toEqual({
      kind: 'saved',
      sshServerId: 'srv-1',
    });
  });
});

describe('checking what the dialog sent', () => {
  it('trims the label and the login', async () => {
    const created = await sites.createFileSite(
      input({
        label: '  Shop  ',
        connection: custom({ host: ' example.com ', username: ' deploy ' }),
      }),
    );
    expect(created.label).toBe('Shop');
    expect(customOf(created)).toMatchObject({ host: 'example.com', username: 'deploy' });
  });

  it('uses only a password for FTP and FTPS', async () => {
    const created = await sites.createFileSite(
      input({
        protocol: 'ftps',
        connection: custom({ port: 21, authMethod: 'privateKey', privateKeyPath: '/k/id' }),
      }),
    );
    expect(customOf(created)).toMatchObject({ authMethod: 'password', privateKeyPath: null });
  });

  it('keeps a key path for an SFTP key login, and drops it for a password', async () => {
    const keyPath = join(folder, 'id_ed25519');
    const withKey = await sites.createFileSite(
      input({ connection: custom({ authMethod: 'privateKey', privateKeyPath: keyPath }) }),
    );
    expect(customOf(withKey).privateKeyPath).toBe(keyPath);
    const withPassword = await sites.createFileSite(
      input({ connection: custom({ privateKeyPath: keyPath }) }),
    );
    expect(customOf(withPassword).privateKeyPath).toBeNull();
  });

  it('takes no trusted host key or certificate from the dialog', async () => {
    const created = await sites.createFileSite(
      input({ connection: custom({ hostKeyFingerprint: FINGERPRINT, tlsPin: FINGERPRINT }) }),
    );
    expect(customOf(created)).toMatchObject({ hostKeyFingerprint: null, tlsPin: null });
  });

  it('keeps the certificate name for FTPS, and drops an empty one', async () => {
    const named = await sites.createFileSite(
      input({ protocol: 'ftps', connection: custom({ tlsServername: ' host.shared.example ' }) }),
    );
    expect(customOf(named).tlsServername).toBe('host.shared.example');
    const empty = await sites.createFileSite(
      input({ protocol: 'ftps', connection: custom({ tlsServername: '  ' }) }),
    );
    expect(customOf(empty).tlsServername).toBeNull();
  });

  it('accepts a server saved in Remote for SFTP', async () => {
    const created = await sites.createFileSite(
      input({ connection: { kind: 'saved', sshServerId: 'srv-1' } }),
    );
    expect(created.connection).toEqual({ kind: 'saved', sshServerId: 'srv-1' });
  });

  it.each([
    ['/var/www/', '/var/www'],
    ['/', '/'],
    ['//var//www/./site//', '/var/www/site'],
    [' /public_html ', '/public_html'],
    ['/My Site/ünïcode', '/My Site/ünïcode'],
  ])('tidies the remote folder %j to %j', async (given, expected) => {
    const created = await sites.createFileSite(input({ remoteRoot: given }));
    expect(created.remoteRoot).toBe(expected);
  });

  it('brings the quiet period into range', async () => {
    expect((await sites.createFileSite(input({ quietSeconds: 0 }))).quietSeconds).toBe(2);
    expect((await sites.createFileSite(input({ quietSeconds: 999 }))).quietSeconds).toBe(120);
    expect((await sites.createFileSite(input({ quietSeconds: Number.NaN }))).quietSeconds).toBe(5);
    expect((await sites.createFileSite(input({ quietSeconds: 7.6 }))).quietSeconds).toBe(8);
  });

  it('keeps each project once', async () => {
    const created = await sites.createFileSite(input({ projectIds: ['p1', 'p2', 'p1'] }));
    expect(created.projectIds).toEqual(['p1', 'p2']);
  });

  it('keeps the ignore lines and drops blank ones', async () => {
    const created = await sites.createFileSite(
      input({ ignorePatterns: ['*.log', '  ', '!keep.log', ''] }),
    );
    expect(created.ignorePatterns).toEqual(['*.log', '!keep.log']);
  });

  it('takes the deploy folder by its real path', async () => {
    const created = await sites.createFileSite(
      input({ localFolder: join(folder, '.', 'x', '..') }),
    );
    expect(created.localFolder).toBe(folder);
  });

  it.each([
    ['an empty label', { label: '   ' }, /name/],
    ['a label over 120 characters', { label: 'x'.repeat(121) }, /120/],
    ['an unknown protocol', { protocol: 'scp' as never }, /protocol/],
    [
      'a saved server for FTP',
      { protocol: 'ftp', connection: { kind: 'saved', sshServerId: 'srv-1' } },
      /SFTP/,
    ],
    [
      'a saved server that is gone',
      { connection: { kind: 'saved', sshServerId: 'gone' } },
      /saved server/,
    ],
    ['an empty host', { connection: custom({ host: '  ' }) }, /host/],
    ['a host with a space', { connection: custom({ host: 'exa mple.com' }) }, /host/],
    ['port 0', { connection: custom({ port: 0 }) }, /port/],
    ['port 70000', { connection: custom({ port: 70_000 }) }, /port/],
    ['a port that is not whole', { connection: custom({ port: 22.5 }) }, /port/],
    ['an empty username', { connection: custom({ username: ' ' }) }, /username/],
    [
      'a key login without a key',
      { connection: custom({ authMethod: 'privateKey', privateKeyPath: null }) },
      /key/,
    ],
    [
      'a relative key path',
      { connection: custom({ authMethod: 'privateKey', privateKeyPath: 'id_rsa' }) },
      /key/,
    ],
    ['a relative remote folder', { remoteRoot: 'var/www' }, /remote folder/],
    ['an empty remote folder', { remoteRoot: '' }, /remote folder/],
    ['a remote folder with ..', { remoteRoot: '/var/../etc' }, /\.\./],
    ['a remote folder with a backslash', { remoteRoot: '/var\\www' }, /backslash/],
    ['a Windows remote folder', { remoteRoot: 'C:\\inetpub' }, /remote folder/],
    ['a relative local folder', { localFolder: 'site' }, /folder/],
    [
      'too many ignore lines',
      { ignorePatterns: Array.from({ length: 201 }, (_, i) => `f${i}`) },
      /200/,
    ],
    ['an ignore line over 500 characters', { ignorePatterns: ['x'.repeat(501)] }, /500/],
    ['ignore lines that are not text', { ignorePatterns: [5 as never] }, /ignore/],
  ] as [string, Partial<FileSiteInput>, RegExp][])(
    'rejects %s',
    async (_label, overrides, message) => {
      const attempt = sites.createFileSite(input(overrides));
      await expect(attempt).rejects.toThrow(/\[files:invalidInput\]/);
      await expect(attempt).rejects.toThrow(message);
    },
  );

  it('rejects a project that is gone with its own code', async () => {
    await expect(sites.createFileSite(input({ projectIds: ['p1', 'gone'] }))).rejects.toThrow(
      /\[files:projectUnknown\]/,
    );
  });

  describe('the local folder', () => {
    it('must exist', async () => {
      await expect(
        sites.createFileSite(input({ localFolder: join(folder, 'missing') })),
      ).rejects.toThrow(/does not exist/);
    });

    it('must be a folder', async () => {
      const file = join(folder, 'index.html');
      writeFileSync(file, '<h1>hi</h1>');
      await expect(sites.createFileSite(input({ localFolder: file }))).rejects.toThrow(/folder/);
    });

    it('cannot be the home folder itself', async () => {
      // The harness puts home inside userData, which is refused for a reason of its own.
      const home = realpathSync(tempDir('agentmate-home-'));
      setElectronPath('home', home);
      await expect(sites.createFileSite(input({ localFolder: home }))).rejects.toThrow(/home/);
      const inside = join(home, 'site');
      mkdirSync(inside);
      expect((await sites.createFileSite(input({ localFolder: inside }))).localFolder).toBe(
        realpathSync(inside),
      );
    });

    it('cannot be the root of a drive', async () => {
      await expect(
        sites.createFileSite(input({ localFolder: parse(folder).root })),
      ).rejects.toThrow(/root/);
    });

    it("cannot be inside AgentMate's own data", async () => {
      const inside = join(userData.dir, 'data');
      await expect(sites.createFileSite(input({ localFolder: inside }))).rejects.toThrow(
        /AgentMate/,
      );
      await expect(sites.createFileSite(input({ localFolder: userData.dir }))).rejects.toThrow(
        /AgentMate/,
      );
    });
  });
});

describe('updateFileSite', () => {
  it('keeps the stored secret when none is sent', async () => {
    const created = await sites.createFileSite(input());
    const updated = await sites.updateFileSite(
      created.id,
      input({ label: 'Renamed', connection: custom({ secret: undefined }) }),
      2000,
    );
    expect(updated.label).toBe('Renamed');
    expect(updated.updatedAt).toBe(2000);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(customOf(updated).secretEnvelope).toEqual(customOf(created).secretEnvelope);
  });

  it('replaces the secret when a new one is sent', async () => {
    const created = await sites.createFileSite(input());
    const updated = await sites.updateFileSite(
      created.id,
      input({ connection: custom({ secret: 'a new one' }) }),
    );
    expect(await vault.decryptSecret(customOf(updated).secretEnvelope as never)).toBe('a new one');
  });

  it.each([
    ['the sign-in method', { authMethod: 'privateKey' as const, privateKeyPath: '/k/id' }],
    ['the host', { host: 'other.example.com' }],
    ['the port', { port: 2222 }],
    ['the username', { username: 'someone-else' }],
  ])('drops the stored secret when %s changes without a new one', async (_label, change) => {
    const created = await sites.createFileSite(input());
    const updated = await sites.updateFileSite(
      created.id,
      input({ connection: custom({ ...change, secret: undefined }) }),
    );
    expect(customOf(updated).secretEnvelope).toBeNull();
  });

  it('drops the stored secret when the protocol changes without a new one', async () => {
    const created = await sites.createFileSite(input({ protocol: 'ftps' }));
    const updated = await sites.updateFileSite(
      created.id,
      input({ protocol: 'ftp', connection: custom({ secret: undefined }) }),
    );
    expect(customOf(updated).secretEnvelope).toBeNull();
  });

  it('keeps a trusted host key and pin while the host stays, and forgets them when it moves', async () => {
    const created = await sites.createFileSite(input());
    await sites.setHostKeyFingerprint(created.id, FINGERPRINT);
    await sites.setTlsPin(created.id, FINGERPRINT);
    const same = await sites.updateFileSite(
      created.id,
      input({ label: 'x', connection: custom({ secret: undefined, hostKeyFingerprint: null }) }),
    );
    expect(customOf(same)).toMatchObject({ hostKeyFingerprint: FINGERPRINT, tlsPin: FINGERPRINT });
    const moved = await sites.updateFileSite(
      created.id,
      input({ connection: custom({ host: 'new.example.com' }) }),
    );
    expect(customOf(moved)).toMatchObject({ hostKeyFingerprint: null, tlsPin: null });
    const portMoved = await sites.updateFileSite(
      created.id,
      input({ connection: custom({ host: 'new.example.com', port: 2200 }) }),
    );
    expect(customOf(portMoved).hostKeyFingerprint).toBeNull();
  });

  it('keeps what deploys left, and forgets what the server test found once the target moves', async () => {
    const created = await sites.createFileSite(input());
    const capabilities = { atomicReplace: true, mtime: 'exact' as const, checkedAt: 5 };
    const lastDeploy = {
      at: 9,
      state: 'done' as const,
      trigger: 'user' as const,
      uploaded: 1,
      deleted: 0,
      failed: 0,
    };
    await sites.setCapabilities(created.id, capabilities);
    await sites.setLastDeploy(created.id, lastDeploy);
    const relabelled = await sites.updateFileSite(
      created.id,
      input({ label: 'New', connection: custom({ secret: undefined }) }),
    );
    expect(relabelled).toMatchObject({ capabilities, lastDeploy });
    const moved = await sites.updateFileSite(created.id, input({ remoteRoot: '/elsewhere' }));
    expect(moved).toMatchObject({ capabilities: null, lastDeploy });
  });

  it('refuses a site that is gone', async () => {
    await expect(sites.updateFileSite('gone', input())).rejects.toThrow(/\[files:siteUnknown\]/);
  });

  it('checks the input the same way as a new site', async () => {
    const created = await sites.createFileSite(input());
    await expect(sites.updateFileSite(created.id, input({ remoteRoot: 'rel' }))).rejects.toThrow(
      /\[files:invalidInput\]/,
    );
  });
});

describe('the small setters', () => {
  it('records what happened to the site', async () => {
    const created = await sites.createFileSite(input());
    const review = { reason: 'conflicts' as const, message: '2 files changed', at: 3 };
    expect((await sites.setNeedsReview(created.id, review))?.needsReview).toEqual(review);
    expect((await sites.setNeedsReview(created.id, null))?.needsReview).toBeNull();
    expect((await sites.setDeployOnSave(created.id, true))?.deployOnSave).toBe(true);
    const stored = await sites.getFileSite(created.id);
    expect(stored?.deployOnSave).toBe(true);
  });

  it('gives null for a site that is gone', async () => {
    expect(await sites.setNeedsReview('gone', null)).toBeNull();
    expect(await sites.setDeployOnSave('gone', true)).toBeNull();
  });

  it('refuses a host key that is not a SHA-256 fingerprint, and a key for a saved server', async () => {
    const created = await sites.createFileSite(input());
    await expect(sites.setHostKeyFingerprint(created.id, 'nope')).rejects.toThrow(
      /\[files:invalidInput\]/,
    );
    const saved = await sites.createFileSite(
      input({ connection: { kind: 'saved', sshServerId: 'srv-1' } }),
    );
    await expect(sites.setHostKeyFingerprint(saved.id, FINGERPRINT)).rejects.toThrow(
      /\[files:invalidInput\]/,
    );
  });
});

describe('removeFileSite', () => {
  it('removes the site with its base, journal and history', async () => {
    const created = await sites.createFileSite(input());
    const bases = await import('./bases');
    const history = await import('./history');
    await bases.readBase(created.id, bases.baseTargetOf(created));
    const journal = await bases.openJournal(created.id);
    await journal.append({ t: 'dir', path: 'css' });
    await journal.close();
    await history.appendHistory(created.id, {
      runId: 'r',
      siteId: created.id,
      trigger: 'user',
      state: 'done',
      startedAt: 1,
      finishedAt: 2,
      uploaded: 0,
      deleted: 0,
      adopted: 0,
      skipped: 0,
      bytes: 0,
      failed: [],
      atomic: true,
      error: null,
    });
    const dir = join(userData.dir, 'data', 'deploy-files');
    expect(await sites.removeFileSite(created.id)).toBe(true);
    expect(await sites.readFileSites()).toEqual([]);
    expect(existsSync(join(dir, 'bases', `${created.id}.json`))).toBe(false);
    expect(existsSync(join(dir, 'bases', `${created.id}.journal.jsonl`))).toBe(false);
    expect(existsSync(join(dir, 'history', `${created.id}.json`))).toBe(false);
    expect(await sites.removeFileSite(created.id)).toBe(false);
  });
});

describe('pruning projects', () => {
  it('lets go of a deleted project and keeps the site', async () => {
    const created = await sites.createFileSite(input({ projectIds: ['p1', 'p2'] }));
    await sites.pruneOrphanFileSites({ projectIds: ['p2'] });
    expect((await sites.getFileSite(created.id))?.projectIds).toEqual(['p1']);
    await sites.pruneOrphanFileSites({ projectIds: ['p1'] });
    expect((await sites.getFileSite(created.id))?.projectIds).toEqual([]);
  });

  it('sweeps against the projects that still exist', async () => {
    const created = await sites.createFileSite(input({ projectIds: ['p1', 'p2'] }));
    expect(await sites.pruneFileSiteProjects(new Set(['p2']))).toEqual([created.id]);
    expect((await sites.getFileSite(created.id))?.projectIds).toEqual(['p2']);
    expect(await sites.pruneFileSiteProjects(new Set(['p2']))).toEqual([]);
  });

  it('catches a project that is gone even when it is not named', async () => {
    const created = await sites.createFileSite(input({ projectIds: ['p1', 'p2'] }));
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Shop', folderPath: folder, createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await sites.pruneOrphanFileSites();
    expect((await sites.getFileSite(created.id))?.projectIds).toEqual(['p1']);
  });

  it('never throws, even when the file cannot be read', async () => {
    writeFileSync(userData.dataFile('deploy-files.json'), '{ not json', 'utf-8');
    await expect(sites.pruneOrphanFileSites({ projectIds: ['p1'] })).resolves.toBeUndefined();
    expect(onDisk()).toBe('{ not json');
  });
});

describe('the sealed secrets', () => {
  it('move to a new passkey and back to the keychain', async () => {
    const created = await sites.createFileSite(input());
    await sites.createFileSite(input({ connection: { kind: 'saved', sshServerId: 'srv-1' } }));
    const unregister = sites.registerFileSitesSealedStore();
    try {
      expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
      const moved = customOf((await sites.getFileSite(created.id)) as StoredFileSite);
      expect(moved.secretEnvelope?.mode).toBe('passphrase');
      expect(await vault.decryptSecret(moved.secretEnvelope as never)).toBe(SECRET);
      expect(onDisk()).not.toContain(SECRET);

      vault.lockVault();
      expect(await vault.unlockVault('a servers passkey')).toBe(true);
      expect((await vault.setPasskey(null)).ok).toBe(true);
      const back = customOf((await sites.getFileSite(created.id)) as StoredFileSite);
      expect(back.secretEnvelope?.mode).toBe('safeStorage');
      expect(await vault.decryptSecret(back.secretEnvelope as never)).toBe(SECRET);
    } finally {
      unregister();
    }
  });

  const moveFake = async (envelope: { ciphertext: string }) => ({
    mode: 'safeStorage' as const,
    ciphertext: `moved:${envelope.ciphertext}`,
  });

  it('never writes a moved secret over one saved after the move was prepared', async () => {
    const created = await sites.createFileSite(input());
    const commit = await sites.fileSitesSealedStore.prepare(moveFake as never);
    const edited = await sites.updateFileSite(
      created.id,
      input({ connection: custom({ secret: 'a newer password' }) }),
    );
    const newer = customOf(edited).secretEnvelope?.ciphertext ?? '';
    expect(await vault.decryptSecret(customOf(edited).secretEnvelope as never)).toBe(
      'a newer password',
    );

    await commit();

    // The newer secret moves too, rather than the old one taking its place.
    const after = customOf((await sites.getFileSite(created.id)) as StoredFileSite);
    expect(after.secretEnvelope?.ciphertext).toBe(`moved:${newer}`);
  });

  it('keeps a moved secret when an edit that leaves the secret out lands right after', async () => {
    const created = await sites.createFileSite(input());
    const original = customOf(created).secretEnvelope?.ciphertext ?? '';
    const commit = await sites.fileSitesSealedStore.prepare(moveFake as never);
    let release: () => void = () => undefined;
    const held = sites.mutateFileSites(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const editing = sites.updateFileSite(
      created.id,
      input({ label: 'Renamed', connection: custom({ secret: undefined }) }),
    );
    // Let the edit get as far as it can while the store is busy.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const committing = commit();
    release();
    await Promise.all([held, editing, committing]);

    const after = customOf((await sites.getFileSite(created.id)) as StoredFileSite);
    expect(after.secretEnvelope?.ciphertext).toBe(`moved:${original}`);
    expect((await sites.getFileSite(created.id))?.label).toBe('Renamed');
  });

  it('cannot seal a new secret while the passkey is locked', async () => {
    expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
    vault.lockVault();
    await expect(sites.createFileSite(input())).rejects.toThrow(/\[files:vaultLocked\]/);
  });
});

describe('change listeners', () => {
  it('hear every write with the sites as saved, project pruning included', async () => {
    const heard: string[][] = [];
    const stop = sites.onFileSitesChanged((list) => heard.push(list.map((site) => site.id)));
    const created = await sites.createFileSite(input());
    await sites.setLastDeploy(created.id, null);
    await sites.pruneFileSiteProjects(new Set(['p2']));
    stop();
    await sites.setDeployOnSave(created.id, true);

    // setLastDeploy(null) on a site without one writes nothing, so it is not heard.
    expect(heard).toEqual([[created.id], [created.id]]);
  });

  it('keep the store working when one throws', async () => {
    const stop = sites.onFileSitesChanged(() => {
      throw new Error('a closed window');
    });
    try {
      const created = await sites.createFileSite(input());
      expect(await sites.getFileSite(created.id)).not.toBeNull();
    } finally {
      stop();
    }
  });
});
