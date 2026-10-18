import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filesError, filesErrorCode } from '../../../../shared/deployFilesErrors';
import type { SftpEntry, SftpStat, UploadFileOptions } from '../../../ssh/connection';
import { describeRemoteFilesContract } from './contract';
import { normalizeRemote, parentOf } from './remotePath';
import { createSftpRemote, type SftpFilesConnection } from './sftpRemote';

/**
 * The SFTP transport over a stand-in for `SshConnection`'s SFTP calls, answering the way ssh2
 * does: numeric SFTP status codes on errors, whole-second times. Real servers run the same
 * contract in sftpRemote.int.test.ts.
 */

const sftpError = (code: number, message: string) => Object.assign(new Error(message), { code });

interface Node {
  dir: boolean;
  data: Buffer;
  mode: number;
  mtime: number;
}

function fakeConnection(options: { posixRename?: boolean; delayMs?: number } = {}) {
  const nodes = new Map<string, Node>([
    ['/', { dir: true, data: Buffer.alloc(0), mode: 0o755, mtime: 1 }],
  ]);
  let active = 0;
  let peak = 0;
  const calls: string[] = [];
  const failures = new Map<string, Error>();
  const track = async <T>(name: string, path: string, work: () => T | Promise<T>): Promise<T> => {
    calls.push(`${name} ${path}`);
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      const failure = failures.get(`${name} ${path}`);
      if (failure) throw failure;
      return await work();
    } finally {
      active -= 1;
    }
  };
  const statOf = (node: Node): SftpStat => ({
    isDirectory: node.dir,
    isFile: !node.dir,
    size: node.dir ? 4096 : node.data.length,
    mtimeMs: node.mtime * 1000,
    mode: node.mode,
  });
  const children = (dir: string) =>
    [...nodes.keys()].filter((path) => path !== dir && parentOf(path) === dir);
  let clock = 1_700_000_000;

  const connection: SftpFilesConnection = {
    get isOpen() {
      return true;
    },
    sftpRealpath: (path) =>
      track('realpath', path, () => {
        const resolved = path === '.' ? '/' : normalizeRemote(path);
        if (!nodes.has(resolved)) throw sftpError(2, 'No such file');
        return resolved;
      }),
    sftpList: (dir) =>
      track('list', dir, (): SftpEntry[] => {
        if (!nodes.get(dir)?.dir) throw sftpError(2, 'No such file');
        return children(dir).map((path) => {
          const stat = statOf(nodes.get(path) as Node);
          return { name: path.slice(path.lastIndexOf('/') + 1), ...stat };
        });
      }),
    sftpStat: (path) =>
      track('stat', path, () => {
        const node = nodes.get(path);
        return node ? statOf(node) : null;
      }),
    sftpMkdir: (path) =>
      track('mkdir', path, () => {
        if (nodes.has(path)) throw sftpError(4, 'Failure');
        if (!nodes.get(parentOf(path) ?? '/')?.dir) throw sftpError(2, 'No such file');
        nodes.set(path, { dir: true, data: Buffer.alloc(0), mode: 0o755, mtime: clock });
      }),
    sftpUnlink: (path) =>
      track('unlink', path, () => {
        if (nodes.get(path)?.dir !== false) throw sftpError(2, 'No such file');
        nodes.delete(path);
      }),
    sftpRmdir: (path) =>
      track('rmdir', path, () => {
        if (!nodes.get(path)?.dir) throw sftpError(2, 'No such file');
        if (children(path).length > 0) throw sftpError(4, 'Failure');
        nodes.delete(path);
      }),
    sftpRename: (from, to) =>
      track('rename', from, () => {
        const node = nodes.get(from);
        if (!node) throw sftpError(2, 'No such file');
        if (nodes.has(to)) throw sftpError(4, 'Failure');
        nodes.delete(from);
        nodes.set(to, node);
      }),
    sftpSupports: async (extension) =>
      extension === 'posix-rename@openssh.com' && options.posixRename !== false,
    uploadFile: (localPath: string, remotePath: string, upload: UploadFileOptions) =>
      track('upload', remotePath, async () => {
        if (!nodes.get(parentOf(remotePath) ?? '/')?.dir) throw sftpError(2, 'No such file');
        const bytes = await readFile(localPath);
        let sent = 0;
        while (sent < bytes.length) {
          if (upload.signal?.aborted) throw filesError('cancelled', 'cancelled');
          sent = Math.min(bytes.length, sent + 65_536);
          upload.onProgress?.(sent);
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (upload.signal?.aborted) throw filesError('cancelled', 'cancelled');
        if (createHash('sha256').update(bytes).digest('hex') !== upload.expectedSha256) {
          throw filesError('localChanged', 'changed');
        }
        const existing = nodes.get(remotePath);
        clock += 1;
        nodes.set(remotePath, {
          dir: false,
          data: bytes,
          mode: upload.mode ?? existing?.mode ?? 0o644,
          mtime: clock,
        });
        return {
          stat: statOf(nodes.get(remotePath) as Node),
          atomic: !existing || options.posixRename !== false,
          replaced: Boolean(existing),
        };
      }),
  };
  return { connection, nodes, calls, failures, peak: () => peak };
}

describeRemoteFilesContract('SFTP over a stand-in connection', async () => {
  const fake = fakeConnection();
  fake.nodes.set('/srv', { dir: true, data: Buffer.alloc(0), mode: 0o755, mtime: 1 });
  return {
    remote: createSftpRemote(fake.connection, () => undefined),
    root: '/srv',
    readFile: async (path) => fake.nodes.get(path)?.data ?? null,
    modeOf: async (path) => fake.nodes.get(path)?.mode ?? null,
    setMode: async (path, mode) => {
      const node = fake.nodes.get(path);
      if (node) node.mode = mode;
    },
  };
});

describe('createSftpRemote', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'agentmate-sftp-remote-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  const dir = (fake: ReturnType<typeof fakeConnection>, path: string) =>
    fake.nodes.set(path, { dir: true, data: Buffer.alloc(0), mode: 0o755, mtime: 1 });

  it('is the SFTP transport with four uploads at a time', () => {
    const remote = createSftpRemote(fakeConnection().connection, () => undefined);
    expect(remote.protocol).toBe('sftp');
    expect(remote.maxParallel).toBe(4);
  });

  it('reports exact times from SFTP in whole seconds', async () => {
    const fake = fakeConnection();
    fake.nodes.set('/a.txt', { dir: false, data: Buffer.from('x'), mode: 0o644, mtime: 1234 });
    const remote = createSftpRemote(fake.connection, () => undefined);

    expect(await remote.stat('/a.txt')).toEqual({
      isDirectory: false,
      size: 1,
      mtimeMs: 1_234_000,
      via: 'sftp',
    });
    expect((await remote.list('/'))?.[0]).toMatchObject({ path: '/a.txt', via: 'sftp' });
  });

  it('lists at most eight folders at once', async () => {
    const fake = fakeConnection({ delayMs: 5 });
    for (let index = 0; index < 20; index += 1) dir(fake, `/d${index}`);
    const remote = createSftpRemote(fake.connection, () => undefined);

    await Promise.all(Array.from({ length: 20 }, (_, index) => remote.list(`/d${index}`)));

    expect(fake.peak()).toBe(8);
  });

  it('makes only the missing folders, from the deepest one that exists, and remembers them', async () => {
    const fake = fakeConnection();
    dir(fake, '/srv');
    dir(fake, '/srv/site');
    const remote = createSftpRemote(fake.connection, () => undefined);

    expect(await remote.ensureDir('/srv/site/assets/img')).toBe(true);
    expect(fake.calls).toEqual([
      'stat /srv/site/assets/img',
      'stat /srv/site/assets',
      'stat /srv/site',
      'mkdir /srv/site/assets',
      'mkdir /srv/site/assets/img',
    ]);
    fake.calls.length = 0;
    expect(await remote.ensureDir('/srv/site/assets')).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('takes a folder someone else made at the same moment', async () => {
    const fake = fakeConnection();
    const remote = createSftpRemote(fake.connection, () => undefined);
    fake.failures.set('mkdir /race', sftpError(4, 'Failure'));
    const mkdir = fake.connection.sftpMkdir;
    fake.connection.sftpMkdir = async (path, options) => {
      dir(fake, path);
      return mkdir(path, options);
    };

    expect(await remote.ensureDir('/race')).toBe(false);
  });

  it('refuses to make a folder where a file is', async () => {
    const fake = fakeConnection();
    fake.nodes.set('/file', { dir: false, data: Buffer.from('x'), mode: 0o644, mtime: 1 });
    const remote = createSftpRemote(fake.connection, () => undefined);

    const failure = await remote.ensureDir('/file/sub').catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('server');
  });

  it('sends at most four files at once and passes the hash, the signal and progress on', async () => {
    const fake = fakeConnection({ delayMs: 5 });
    const remote = createSftpRemote(fake.connection, () => undefined);
    const path = join(scratch, 'four.txt');
    await writeFile(path, 'four');
    const sha256 = createHash('sha256').update('four').digest('hex');
    const onBytes = vi.fn();

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        remote.putFile(path, `/f${index}.txt`, { sha256, size: 4, onBytes }),
      ),
    );

    expect(fake.peak()).toBe(4);
    expect(results[0]).toEqual({
      stat: { isDirectory: false, size: 4, mtimeMs: expect.any(Number), via: 'sftp' },
      atomic: true,
    });
    expect(onBytes).toHaveBeenCalledWith(4);
  });

  it('learns from a replace whether this server replaces files in one step', async () => {
    const fake = fakeConnection({ posixRename: false });
    const remote = createSftpRemote(fake.connection, () => undefined);
    const path = join(scratch, 'replace.txt');
    await writeFile(path, 'r');
    const file = { sha256: createHash('sha256').update('r').digest('hex'), size: 1 };

    expect((await remote.capabilities()).atomicReplace).toBe(false);
    await remote.putFile(path, '/r.txt', file);
    expect((await remote.putFile(path, '/r.txt', file)).atomic).toBe(false);
    expect(await remote.capabilities()).toEqual({ atomicReplace: false, mtime: 'exact' });

    const openssh = createSftpRemote(fakeConnection().connection, () => undefined);
    expect((await openssh.capabilities()).atomicReplace).toBe(true);
  });

  it('counts a server whose plain rename replaces files as atomic once it has seen one', async () => {
    const fake = fakeConnection({ posixRename: false });
    const upload = fake.connection.uploadFile;
    fake.connection.uploadFile = async (...args) => ({ ...(await upload(...args)), atomic: true });
    const remote = createSftpRemote(fake.connection, () => undefined);
    const path = join(scratch, 'plain.txt');
    await writeFile(path, 'p');
    const file = { sha256: createHash('sha256').update('p').digest('hex'), size: 1 };

    await remote.putFile(path, '/p.txt', file);
    expect((await remote.capabilities()).atomicReplace).toBe(false);
    await remote.putFile(path, '/p.txt', file);
    expect((await remote.capabilities()).atomicReplace).toBe(true);
  });

  it('codes failures', async () => {
    const fake = fakeConnection();
    dir(fake, '/locked');
    fake.failures.set('list /locked', sftpError(3, 'Permission denied'));
    fake.failures.set('unlink /locked/a', sftpError(3, 'Permission denied'));
    fake.failures.set('rmdir /locked', sftpError(3, 'Permission denied'));
    fake.failures.set('stat /gone', new Error('The SSH connection to example.com closed.'));
    const remote = createSftpRemote(fake.connection, () => undefined);
    const code = (work: Promise<unknown>) => work.then(() => null, filesErrorCode);

    expect(await code(remote.list('/locked'))).toBe('permissionDenied');
    expect(await code(remote.remove('/locked/a'))).toBe('permissionDenied');
    expect(await code(remote.removeEmptyDir('/locked'))).toBe('permissionDenied');
    expect(await code(remote.stat('/gone'))).toBe('unreachable');
    expect(await code(remote.realpath('/nowhere'))).toBe('remoteFolderMissing');
    expect(
      await code(remote.putFile(join(scratch, 'x'), '/nowhere/x', { sha256: '', size: 0 })),
    ).toBe('remoteFolderMissing');
  });

  it('hands the connection back once, however often it is closed', async () => {
    const release = vi.fn();
    const remote = createSftpRemote(fakeConnection().connection, release);

    await remote.close();
    await remote.close();

    expect(release).toHaveBeenCalledTimes(1);
    await expect(remote.list('/')).rejects.toSatisfy(
      (error) => filesErrorCode(error) === 'unreachable',
    );
  });
});
