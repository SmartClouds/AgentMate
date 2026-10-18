import { describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import type { SshEndpoint } from '../../ssh/connectConfig';
import { HostKeyChangedError } from '../../ssh/connectConfig';
import type { SshConnection } from '../../ssh/connection';
import { VaultLockedError } from '../../ssh/vaultErrors';
import { createOpenRemoteFiles, readHostKey } from './connect';
import type { FilesTransportError } from './transport/errors';
import type { FilesConnectTarget } from './types';

/** How a site's target becomes a connection: the pool, a login of its own, or FTP. */

const KEY = 'a1'.repeat(32);

function stubConnection() {
  return {
    isOpen: true,
    close: vi.fn(),
    sftpRealpath: vi.fn(async () => '/home/deploy'),
  } as unknown as SshConnection & { close: ReturnType<typeof vi.fn> };
}

function custom(
  protocol: 'sftp' | 'ftp' | 'ftps',
  login: Partial<Extract<FilesConnectTarget['login'], { kind: 'custom' }>> = {},
): FilesConnectTarget {
  return {
    protocol,
    remoteRoot: '/srv/site',
    login: {
      kind: 'custom',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: KEY,
      tlsPin: null,
      tlsServername: null,
      secret: 'pw',
      ...login,
    },
  };
}

const saved: FilesConnectTarget = {
  protocol: 'sftp',
  remoteRoot: '/srv/site',
  login: { kind: 'saved', sshServerId: 'server-1' },
};

const failure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

describe('openRemoteFiles for a server saved in Remote', () => {
  function pool() {
    const connection = stubConnection();
    const release = vi.fn();
    return {
      connection,
      release,
      acquire: vi.fn(async () => ({ connection, release })),
      openSeparate: vi.fn(async () => ({ connection, release })),
    };
  }

  it('opens a connection of its own for a run and gives it back on close', async () => {
    const fake = pool();
    const open = createOpenRemoteFiles({ pool: () => fake });

    const remote = await open(saved, { purpose: 'run' });
    expect(await remote.realpath('.')).toBe('/home/deploy');
    await remote.close();

    expect(fake.openSeparate).toHaveBeenCalledWith('server-1');
    expect(fake.acquire).not.toHaveBeenCalled();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('shares the pooled connection for browsing', async () => {
    const fake = pool();
    const open = createOpenRemoteFiles({ pool: () => fake });

    const remote = await open(saved, { purpose: 'browse' });
    await remote.close();

    expect(fake.acquire).toHaveBeenCalledWith('server-1');
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it('codes a locked vault and a changed host key', async () => {
    const locked = createOpenRemoteFiles({
      pool: () => ({ ...pool(), openSeparate: async () => Promise.reject(new VaultLockedError()) }),
    });
    const changed = createOpenRemoteFiles({
      pool: () => ({
        ...pool(),
        acquire: async () =>
          Promise.reject(
            new HostKeyChangedError('example.com', 22, { stored: 'a', presented: 'b' }),
          ),
      }),
    });

    expect(filesErrorCode(await failure(locked(saved, { purpose: 'run' })))).toBe('vaultLocked');
    const error = (await failure(changed(saved, { purpose: 'browse' }))) as FilesTransportError;
    expect(error.code).toBe('hostKeyChanged');
    expect(error.hostKey).toEqual({ presented: 'b', stored: 'a' });
  });

  it('refuses an unattended open of a saved server whose host key was never trusted', async () => {
    const fake = pool();
    const savedHostKey = vi.fn(async (_serverId: string) => null);
    const open = createOpenRemoteFiles({ pool: () => fake, savedHostKey });

    for (const purpose of ['run', 'browse'] as const) {
      const error = await failure(open(saved, { purpose, unattended: true }));
      expect(filesErrorCode(error)).toBe('hostKeyUnknown');
    }

    expect(savedHostKey).toHaveBeenCalledWith('server-1');
    expect(fake.openSeparate).not.toHaveBeenCalled();
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it('opens a saved server unattended once its host key is trusted, and for a person either way', async () => {
    const fake = pool();
    const trusted = createOpenRemoteFiles({ pool: () => fake, savedHostKey: async () => KEY });
    const untrusted = createOpenRemoteFiles({ pool: () => fake, savedHostKey: async () => null });

    await (await trusted(saved, { purpose: 'run', unattended: true })).close();
    await (await untrusted(saved, { purpose: 'run' })).close();

    expect(fake.openSeparate).toHaveBeenCalledTimes(2);
  });

  it('hands back a connection that arrives after a cancel', async () => {
    const fake = pool();
    const controller = new AbortController();
    fake.openSeparate.mockImplementation(async () => {
      controller.abort();
      return { connection: fake.connection, release: fake.release };
    });
    const open = createOpenRemoteFiles({ pool: () => fake });

    const error = await failure(open(saved, { purpose: 'run', signal: controller.signal }));

    expect(filesErrorCode(error)).toBe('cancelled');
    expect(fake.release).toHaveBeenCalled();
  });
});

describe('openRemoteFiles for an SFTP site with a login of its own', () => {
  it('logs in with the trusted key and never trusts a new one on its own', async () => {
    const connection = stubConnection();
    const openSsh = vi.fn(async (_endpoint: SshEndpoint, _hooks: object) => connection);
    const open = createOpenRemoteFiles({ openSsh });

    const remote = await open(custom('sftp'), { purpose: 'run' });
    await remote.close();

    const [endpoint, hooks] = openSsh.mock.calls[0];
    expect(endpoint).toEqual({
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'pw',
      passphrase: undefined,
      privateKeyPath: undefined,
      storedFingerprint: KEY,
    });
    expect(hooks).toEqual({});
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('uses the secret as the key passphrase for a key login', async () => {
    const openSsh = vi.fn(async (_endpoint: SshEndpoint, _hooks: object) => stubConnection());
    const open = createOpenRemoteFiles({ openSsh });

    await open(custom('sftp', { authMethod: 'privateKey', privateKeyPath: '/k', secret: 'pass' }), {
      purpose: 'browse',
    });

    expect(openSsh.mock.calls[0][0]).toMatchObject({
      authMethod: 'privateKey',
      privateKeyPath: '/k',
      passphrase: 'pass',
      password: undefined,
    });
  });

  it('refuses a server whose key was never trusted, without sending the login', async () => {
    const openSsh = vi.fn();
    const probeHostKey = vi.fn(async () => 'b2'.repeat(32));
    const open = createOpenRemoteFiles({ openSsh, probeHostKey });

    const error = (await failure(
      open(custom('sftp', { hostKeyFingerprint: null }), { purpose: 'run' }),
    )) as FilesTransportError;

    expect(error.code).toBe('hostKeyUnknown');
    expect(error.hostKey).toEqual({ presented: 'b2'.repeat(32), stored: null });
    expect(probeHostKey).toHaveBeenCalledWith('example.com', 22);
    expect(openSsh).not.toHaveBeenCalled();
  });

  it('codes a failed login', async () => {
    const open = createOpenRemoteFiles({
      openSsh: async () =>
        Promise.reject(
          new Error('Authentication failed. Check the username, password, or private key.'),
        ),
    });

    expect(filesErrorCode(await failure(open(custom('sftp'), { purpose: 'run' })))).toBe('auth');
  });

  it('starts nothing once cancelled', async () => {
    const openSsh = vi.fn();
    const open = createOpenRemoteFiles({ openSsh });

    const error = await failure(
      open(custom('sftp'), { purpose: 'run', signal: AbortSignal.abort() }),
    );

    expect(filesErrorCode(error)).toBe('cancelled');
    expect(openSsh).not.toHaveBeenCalled();
  });

  it('closes a connection that arrives after a cancel', async () => {
    const connection = stubConnection();
    const controller = new AbortController();
    const open = createOpenRemoteFiles({
      openSsh: async () => {
        controller.abort();
        return connection;
      },
    });

    const error = await failure(
      open(custom('sftp'), { purpose: 'run', signal: controller.signal }),
    );

    expect(filesErrorCode(error)).toBe('cancelled');
    expect(connection.close).toHaveBeenCalled();
  });
});

describe('openRemoteFiles for FTP and FTPS', () => {
  it('hands FTP and FTPS to the FTP transport with the signal', async () => {
    const remote = { protocol: 'ftps' } as never;
    const openFtp = vi.fn(async () => remote);
    const open = createOpenRemoteFiles({ openFtp });
    const signal = new AbortController().signal;

    expect(await open(custom('ftps'), { purpose: 'browse', signal })).toBe(remote);
    expect(openFtp).toHaveBeenCalledWith(custom('ftps'), { signal });
  });
});

describe('readHostKey', () => {
  it('reads the key a custom SFTP login presents', async () => {
    const probeHostKey = vi.fn(async () => 'c3'.repeat(32));

    expect(await readHostKey(custom('sftp', { port: 2222 }), { probeHostKey })).toBe(
      'c3'.repeat(32),
    );
    expect(probeHostKey).toHaveBeenCalledWith('example.com', 2222);
  });

  it('codes an unreachable server and refuses targets without a host key of their own', async () => {
    const probeHostKey = async () => Promise.reject(new Error('Could not reach example.com:22.'));

    expect(filesErrorCode(await failure(readHostKey(custom('sftp'), { probeHostKey })))).toBe(
      'unreachable',
    );
    expect(filesErrorCode(await failure(readHostKey(saved)))).toBe('invalidInput');
    expect(filesErrorCode(await failure(readHostKey(custom('ftp'))))).toBe('invalidInput');
  });
});
