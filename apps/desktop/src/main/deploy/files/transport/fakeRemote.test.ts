import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import { describeRemoteFilesContract } from './contract';
import { createFakeRemote, type FakeRemoteOptions } from './fakeRemote';

/** The in-memory server other tests deploy to, held to the same contract as the real ones. */

function harnessFor(options: FakeRemoteOptions) {
  return async () => {
    const fake = createFakeRemote(options);
    fake.setDir('/srv/site');
    return {
      remote: fake.remote,
      root: '/srv/site',
      readFile: async (path: string) => fake.readBytes(path),
      modeOf: async (path: string) => fake.modeOf(path),
      setMode: async (path: string, mode: number) => fake.setMode(path, mode),
    };
  };
}

describeRemoteFilesContract('fake SFTP', harnessFor({}));
describeRemoteFilesContract('fake FTP with MLSD', harnessFor({ protocol: 'ftp' }));
describeRemoteFilesContract('fake FTP, LIST only', harnessFor({ protocol: 'ftp', noMlsd: true }));
describeRemoteFilesContract('fake server without times', harnessFor({ noMtime: true }));
describeRemoteFilesContract(
  'fake FTP that refuses to rename over a file',
  harnessFor({ protocol: 'ftps', renameOverwriteRefused: true }),
);
describeRemoteFilesContract('fake SFTP without posix-rename', harnessFor({ noAtomicRename: true }));
describeRemoteFilesContract('fake slow server', harnessFor({ latencyMs: 1 }));

describe('createFakeRemote', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'runova-fake-remote-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function local(content: string) {
    const path = join(scratch, `f-${Math.random().toString(16).slice(2)}`);
    await writeFile(path, content);
    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
    };
  }

  it('seeds files with their folders, times and modes', async () => {
    const fake = createFakeRemote();
    fake.setFile('/srv/site/css/a.css', 'body{}', { mtimeMs: 1_000_500, mode: 0o600 });

    expect(fake.readFile('/srv/site/css/a.css')).toBe('body{}');
    expect(fake.modeOf('/srv/site/css/a.css')).toBe(0o600);
    expect(await fake.remote.list('/srv/site')).toEqual([
      {
        name: 'css',
        path: '/srv/site/css',
        isDirectory: true,
        size: 0,
        mtimeMs: expect.any(Number),
        via: 'sftp',
      },
    ]);
    // SFTP version 3 only carries whole seconds.
    expect(await fake.remote.stat('/srv/site/css/a.css')).toEqual({
      isDirectory: false,
      size: 6,
      mtimeMs: 1_000_000,
      via: 'sftp',
    });
  });

  it('stamps uploads with its own clock', async () => {
    const fake = createFakeRemote({ protocol: 'ftp', noMlsd: true });
    fake.setDir('/srv');
    fake.clock.set(2_000_000);
    const file = await local('x');

    const result = await fake.remote.putFile(file.path, '/srv/x.txt', file);
    fake.clock.advance(5000);

    expect(result.stat).toEqual({ isDirectory: false, size: 1, mtimeMs: 2_000_000, via: 'mdtm' });
    expect((await fake.remote.list('/srv'))?.[0]).toMatchObject({ mtimeMs: null, via: null });
    expect(fake.clock.now()).toBe(2_005_000);
  });

  it('logs every call with the connection it came through', async () => {
    const fake = createFakeRemote();
    fake.setDir('/srv');
    const second = fake.open();

    await fake.remote.list('/srv');
    await second.stat('/srv/nope');

    expect(fake.calls).toEqual([
      { op: 'list', path: '/srv', connection: 1 },
      { op: 'stat', path: '/srv/nope', connection: 2 },
    ]);
  });

  it('opens connections for a target through its opener', async () => {
    const fake = createFakeRemote();
    const target = {
      protocol: 'sftp' as const,
      login: { kind: 'saved' as const, sshServerId: 's1' },
      remoteRoot: '/srv',
    };

    const remote = await fake.opener(target, { purpose: 'run' });

    expect(fake.opened).toEqual([{ target, purpose: 'run' }]);
    expect(remote).not.toBe(fake.remote);
  });

  it('drops the connection at the given call and refuses work after that', async () => {
    const fake = createFakeRemote({ dropConnectionAt: 2 });
    fake.setDir('/srv');

    await fake.remote.list('/srv');
    const dropped = await fake.remote.list('/srv').catch((error: unknown) => error);
    const after = await fake.remote.stat('/srv').catch((error: unknown) => error);

    expect(filesErrorCode(dropped)).toBe('unreachable');
    expect(filesErrorCode(after)).toBe('unreachable');
    expect(await fake.open().stat('/srv')).toMatchObject({ isDirectory: true });
  });

  it('breaks an upload off after some bytes and leaves the old file and a part file', async () => {
    const fake = createFakeRemote({ failAfterBytes: 10 });
    fake.setFile('/srv/big.txt', 'old');
    const file = await local('x'.repeat(200_000));

    const failure = await fake.remote
      .putFile(file.path, '/srv/big.txt', file)
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('unreachable');
    expect(fake.readFile('/srv/big.txt')).toBe('old');
    expect(fake.paths().filter((path) => path.endsWith('.part'))).toHaveLength(1);
  });

  it('learns that renames over a file are refused only after it happens', async () => {
    const fake = createFakeRemote({ protocol: 'ftp', renameOverwriteRefused: true });
    fake.setDir('/srv');
    const file = await local('v');

    expect((await fake.remote.capabilities()).atomicReplace).toBe(true);
    expect((await fake.remote.putFile(file.path, '/srv/v', file)).atomic).toBe(true);
    expect((await fake.remote.putFile(file.path, '/srv/v', file)).atomic).toBe(false);
    expect((await fake.remote.capabilities()).atomicReplace).toBe(false);
  });

  it('says from the start when a server cannot rename over a file', async () => {
    const fake = createFakeRemote({ noAtomicRename: true });

    expect(await fake.remote.capabilities()).toEqual({ atomicReplace: false, mtime: 'exact' });
    expect(await createFakeRemote({ noMtime: true }).remote.capabilities()).toEqual({
      atomicReplace: true,
      mtime: 'none',
    });
  });

  it('refuses to put a file into a folder that is not there', async () => {
    const fake = createFakeRemote();
    const file = await local('x');

    const failure = await fake.remote
      .putFile(file.path, '/nowhere/x', file)
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('remoteFolderMissing');
  });

  it('can be told to fail a path with a coded error', async () => {
    const fake = createFakeRemote();
    fake.setFile('/srv/locked.txt', 'x');
    fake.failOn('/srv/locked.txt', 'permissionDenied');

    const failure = await fake.remote.remove('/srv/locked.txt').catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('permissionDenied');
  });

  it('starts at the home folder for a relative realpath', async () => {
    const fake = createFakeRemote({ home: '/home/deploy' });

    expect(await fake.remote.realpath('.')).toBe('/home/deploy');
    expect(await fake.remote.realpath('www/../site')).toBe('/home/deploy/site');
  });

  it('refuses calls after close', async () => {
    const fake = createFakeRemote();
    await fake.remote.close();

    await expect(fake.remote.list('/')).rejects.toThrow(/closed/);
  });
});
