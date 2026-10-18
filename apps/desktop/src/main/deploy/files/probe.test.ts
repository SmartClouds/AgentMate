import { describe, expect, it } from 'vitest';
import { filesError, filesErrorCode } from '../../../shared/deployFilesErrors';
import { browseRemote, testConnection } from './probe';
import { FilesTransportError } from './transport/errors';
import { createFakeRemote, type FakeRemoteOptions } from './transport/fakeRemote';
import type { OpenRemoteFiles, RemoteFiles } from './transport/types';
import type { FilesConnectTarget } from './types';

/** Test connection: a checklist the site form shows, and what it learned about the server. */

const target: FilesConnectTarget = {
  protocol: 'sftp',
  remoteRoot: '/srv/site',
  login: { kind: 'saved', sshServerId: 'server-1' },
};
const PROBE = '/srv/site/agentmate-probe-0badf00d.txt';
const options = { now: () => 1234, randomHex: () => '0badf00d' };

function server(flags: FakeRemoteOptions = {}) {
  const fake = createFakeRemote(flags);
  fake.setDir('/srv/site');
  return fake;
}

const statuses = (result: Awaited<ReturnType<typeof testConnection>>) =>
  Object.fromEntries(result.steps.map((step) => [step.step, step.status]));

describe('testConnection', () => {
  it('walks every step on a good server and leaves nothing behind', async () => {
    const fake = server();

    const result = await testConnection(target, fake.opener, options);

    expect(result).toEqual({
      ok: true,
      steps: [
        { step: 'reach', status: 'ok', message: null },
        { step: 'login', status: 'ok', message: null },
        { step: 'folder', status: 'ok', message: null },
        { step: 'write', status: 'ok', message: null },
        { step: 'replace', status: 'ok', message: null },
        { step: 'time', status: 'ok', message: null },
        { step: 'cleanup', status: 'ok', message: null },
      ],
      capabilities: { atomicReplace: true, mtime: 'exact', checkedAt: 1234 },
      remoteRoot: '/srv/site',
      hostKey: null,
      certificate: null,
      error: null,
    });
    expect(fake.paths()).toEqual(['/srv', '/srv/site']);
    expect(fake.calls.at(-1)?.op).toBe('close');
    expect(fake.calls.some((call) => call.path === PROBE && call.op === 'putFile')).toBe(true);
  });

  it('opens a fresh login, not a shared one', async () => {
    const fake = server();

    await testConnection(target, fake.opener, options);

    expect(fake.opened).toEqual([{ target, purpose: 'run' }]);
  });

  it('reads times with MDTM on a server without MLSD', async () => {
    const result = await testConnection(target, server({ protocol: 'ftp', noMlsd: true }).opener);

    expect(result.capabilities?.mtime).toBe('mdtm');
    expect(statuses(result).time).toBe('ok');
  });

  it('warns that changes are judged by size on a server without times', async () => {
    const result = await testConnection(target, server({ noMtime: true }).opener);

    expect(result.ok).toBe(true);
    expect(result.capabilities?.mtime).toBe('none');
    expect(result.steps.find((step) => step.step === 'time')).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/size/),
    });
  });

  it('counts a server that claims times but gives none for the probe as having none', async () => {
    const fake = server();
    const open: OpenRemoteFiles = async (...args) => {
      const remote = await fake.opener(...args);
      return {
        ...remote,
        stat: async (path) => ({ ...(await remote.stat(path))!, mtimeMs: null }),
      };
    };

    const result = await testConnection(target, open);

    expect(result.capabilities?.mtime).toBe('none');
  });

  it('warns when the server cannot replace a file in one step', async () => {
    const result = await testConnection(target, server({ noAtomicRename: true }).opener);

    expect(result.ok).toBe(true);
    expect(result.capabilities?.atomicReplace).toBe(false);
    expect(result.steps.find((step) => step.step === 'replace')).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/one step/),
    });
  });

  it('stops at the first step when the server cannot be reached', async () => {
    const open: OpenRemoteFiles = async () => {
      throw filesError('unreachable', 'Could not reach example.com:22.');
    };

    const result = await testConnection(target, open);

    expect(statuses(result)).toEqual({
      reach: 'failed',
      login: 'skipped',
      folder: 'skipped',
      write: 'skipped',
      replace: 'skipped',
      time: 'skipped',
      cleanup: 'skipped',
    });
    expect(result).toMatchObject({
      ok: false,
      capabilities: null,
      error: { code: 'unreachable', message: 'Could not reach example.com:22.' },
    });
  });

  it('reaches the server but fails the login on a refused password', async () => {
    const open: OpenRemoteFiles = async () => {
      throw filesError('auth', 'Authentication failed.');
    };

    const result = await testConnection(target, open);

    expect(statuses(result)).toMatchObject({ reach: 'ok', login: 'failed', folder: 'skipped' });
    expect(result.error?.code).toBe('auth');
  });

  it('carries the host key and the certificate the user has to decide on', async () => {
    const hostKey = { presented: 'ab'.repeat(32), stored: null };
    const certificate = {
      fingerprint256: 'cd'.repeat(32),
      subject: 'CN=x',
      issuer: 'CN=x',
      names: ['x'],
      validTo: 'never',
      reason: 'selfSigned' as const,
    };

    const unknown = await testConnection(target, async () => {
      throw new FilesTransportError('hostKeyUnknown', 'Not trusted yet.', { hostKey });
    });
    const untrusted = await testConnection(target, async () => {
      throw new FilesTransportError('tlsUntrusted', 'Self-signed.', { certificate });
    });

    expect(unknown).toMatchObject({
      hostKey,
      certificate: null,
      error: { code: 'hostKeyUnknown' },
    });
    expect(untrusted).toMatchObject({
      hostKey: null,
      certificate,
      error: { code: 'tlsUntrusted' },
    });
  });

  it('fails the folder step for a folder that is not there', async () => {
    const fake = createFakeRemote();

    const result = await testConnection(target, fake.opener);

    expect(statuses(result)).toMatchObject({
      reach: 'ok',
      login: 'ok',
      folder: 'failed',
      write: 'skipped',
      cleanup: 'skipped',
    });
    expect(result).toMatchObject({ capabilities: null, remoteRoot: null });
    expect(result.error?.code).toBe('remoteFolderMissing');
    expect(fake.calls.at(-1)?.op).toBe('close');
  });

  it('fails the folder step for a file where the folder should be', async () => {
    const fake = createFakeRemote();
    fake.setFile('/srv/site', 'not a folder');

    const result = await testConnection(target, fake.opener);

    expect(result.error?.code).toBe('remoteFolderMissing');
  });

  it('still learns the server and cleans up when writing is refused', async () => {
    const fake = server();
    fake.failOn(PROBE, 'permissionDenied');

    const result = await testConnection(target, fake.opener, options);

    expect(statuses(result)).toMatchObject({
      folder: 'ok',
      write: 'failed',
      replace: 'skipped',
      time: 'ok',
      cleanup: 'warning',
    });
    expect(result).toMatchObject({
      ok: false,
      capabilities: { atomicReplace: true, mtime: 'exact' },
      error: { code: 'permissionDenied' },
    });
  });

  it('warns when the probe file could not be removed', async () => {
    const fake = server();
    const open: OpenRemoteFiles = async (...args) => {
      const remote: RemoteFiles = await fake.opener(...args);
      return {
        ...remote,
        remove: async () => {
          throw filesError('permissionDenied', 'no');
        },
      };
    };

    const result = await testConnection(target, open, options);

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.step === 'cleanup')).toMatchObject({
      status: 'warning',
      message: expect.stringContaining('agentmate-probe-0badf00d.txt'),
    });
  });

  it('fails the replace step on its own when only the second write is refused', async () => {
    const fake = server();
    let puts = 0;
    const open: OpenRemoteFiles = async (...args) => {
      const remote: RemoteFiles = await fake.opener(...args);
      return {
        ...remote,
        putFile: async (...put) => {
          puts += 1;
          if (puts === 2) throw filesError('diskFull', 'full');
          return remote.putFile(...put);
        },
      };
    };

    const result = await testConnection(target, open, options);

    expect(statuses(result)).toMatchObject({ write: 'ok', replace: 'failed', cleanup: 'ok' });
    expect(result.error?.code).toBe('diskFull');
    expect(fake.paths()).toEqual(['/srv', '/srv/site']);
  });
});

describe('browseRemote', () => {
  it('lists the folders of the login folder, sorted, with its parent', async () => {
    const fake = createFakeRemote({ home: '/home/deploy' });
    fake.setDir('/home/deploy/www');
    fake.setDir('/home/deploy/Backups');
    fake.setDir('/home/deploy/apps');
    fake.setFile('/home/deploy/notes.txt', 'x');

    expect(await browseRemote(fake.remote, null)).toEqual({
      path: '/home/deploy',
      parent: '/home',
      folders: [
        { name: 'apps', path: '/home/deploy/apps' },
        { name: 'Backups', path: '/home/deploy/Backups' },
        { name: 'www', path: '/home/deploy/www' },
      ],
    });
  });

  it('has no parent at the top', async () => {
    const fake = createFakeRemote();
    fake.setDir('/srv');

    expect(await browseRemote(fake.remote, '/')).toMatchObject({ path: '/', parent: null });
  });

  it('says when the folder is not there', async () => {
    const fake = createFakeRemote();

    const failure = await browseRemote(fake.remote, '/nope/').catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('remoteFolderMissing');
  });
});
