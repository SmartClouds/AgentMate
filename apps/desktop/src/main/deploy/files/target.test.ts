import { realpathSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FileSiteConnectionInput, FileSiteInput } from '../../../shared/deployFilesTypes';
import { tempDir } from '../../../test/main/fixtures';
import { useTempUserData } from '../../../test/main/ipcHarness';

/**
 * What a connect needs, built from a saved site or from the dialog's input right before the
 * connect: the login with its secret unsealed, which is never kept.
 */

const userData = useTempUserData();
let sites: typeof import('./store');
let target: typeof import('./target');
let vault: typeof import('../../ssh/vault');

const SECRET = 'the-site-password';
let folder = '';

function custom(
  overrides: Partial<Extract<FileSiteConnectionInput, { kind: 'custom' }>> = {},
): FileSiteConnectionInput {
  return {
    kind: 'custom',
    host: 'ftp.example.com',
    port: 21,
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
    label: 'Site',
    protocol: 'ftps',
    connection: custom(),
    remoteRoot: '/public_html/',
    localFolder: folder,
    projectIds: [],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    ...overrides,
  };
}

// The first import transforms the whole main-process store graph, which takes a while on a busy
// machine; doing it once here keeps that out of the first test's hook timeout.
beforeAll(async () => {
  await import('./store');
}, 120_000);

beforeEach(async () => {
  folder = realpathSync(tempDir('agentmate-site-'));
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
  target = await import('./target');
  vault = await import('../../ssh/vault');
});

describe('connectTargetOf', () => {
  it('names the saved server for a site that uses one', async () => {
    const site = await sites.createFileSite(
      input({ protocol: 'sftp', connection: { kind: 'saved', sshServerId: 'srv-1' } }),
    );
    expect(await target.connectTargetOf(site)).toEqual({
      protocol: 'sftp',
      login: { kind: 'saved', sshServerId: 'srv-1' },
      remoteRoot: '/public_html',
    });
  });

  it('unseals the secret of a login of its own', async () => {
    const site = await sites.createFileSite(
      input({ connection: custom({ tlsServername: 'shared.example.net' }) }),
    );
    const site2 = await sites.setTlsPin(site.id, 'cd'.repeat(32));
    expect(await target.connectTargetOf(site2 ?? site)).toEqual({
      protocol: 'ftps',
      login: {
        kind: 'custom',
        host: 'ftp.example.com',
        port: 21,
        username: 'deploy',
        authMethod: 'password',
        privateKeyPath: null,
        hostKeyFingerprint: null,
        tlsPin: 'cd'.repeat(32),
        tlsServername: 'shared.example.net',
        secret: SECRET,
      },
      remoteRoot: '/public_html',
    });
  });

  it('gives a null secret when there is none', async () => {
    const site = await sites.createFileSite(input({ connection: custom({ secret: undefined }) }));
    const built = await target.connectTargetOf(site);
    expect(built.login).toMatchObject({ kind: 'custom', secret: null });
  });

  it('says the vault is locked instead of failing later', async () => {
    expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
    const site = await sites.createFileSite(input());
    vault.lockVault();
    await expect(target.connectTargetOf(site)).rejects.toThrow(/\[files:vaultLocked\]/);
  });
});

describe('connectTargetOfInput', () => {
  it('uses the secret just typed for a site that is not saved yet', async () => {
    const built = await target.connectTargetOfInput(
      input({ connection: custom({ secret: 'typed' }) }),
      null,
    );
    expect(built).toMatchObject({
      protocol: 'ftps',
      login: { host: 'ftp.example.com', secret: 'typed' },
      remoteRoot: '/public_html',
    });
  });

  it('uses the stored secret when an edit leaves it out', async () => {
    const site = await sites.createFileSite(input());
    const built = await target.connectTargetOfInput(
      input({ connection: custom({ secret: undefined }) }),
      site,
    );
    expect(built.login).toMatchObject({ secret: SECRET });
  });

  it('does not reuse the stored secret for another login', async () => {
    const site = await sites.createFileSite(input());
    const built = await target.connectTargetOfInput(
      input({ connection: custom({ username: 'other', secret: undefined }) }),
      site,
    );
    expect(built.login).toMatchObject({ username: 'other', secret: null });
  });

  it('keeps a trusted host key or pin only while the host is the same', async () => {
    const created = await sites.createFileSite(input());
    const pinned = await sites.setTlsPin(created.id, 'cd'.repeat(32));
    if (!pinned) throw new Error('expected the site');
    const same = await target.connectTargetOfInput(
      input({ connection: custom({ secret: undefined }) }),
      pinned,
    );
    expect(same.login).toMatchObject({ tlsPin: 'cd'.repeat(32) });
    const moved = await target.connectTargetOfInput(
      input({ connection: custom({ host: 'new.example.com', tlsPin: 'ef'.repeat(32) }) }),
      pinned,
    );
    expect(moved.login).toMatchObject({ tlsPin: null });
  });

  it('checks the input like a save does', async () => {
    await expect(
      target.connectTargetOfInput(input({ remoteRoot: 'relative' }), null),
    ).rejects.toThrow(/\[files:invalidInput\]/);
  });

  it('builds a saved server target', async () => {
    const built = await target.connectTargetOfInput(
      input({ protocol: 'sftp', connection: { kind: 'saved', sshServerId: 'srv-1' } }),
      null,
    );
    expect(built).toEqual({
      protocol: 'sftp',
      login: { kind: 'saved', sshServerId: 'srv-1' },
      remoteRoot: '/public_html',
    });
  });
});
