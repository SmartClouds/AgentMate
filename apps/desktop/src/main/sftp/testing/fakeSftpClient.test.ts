import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import { mapSftpError } from '../../deploy/files/transport/errors';
import { describeSftpClientContract } from './contract';
import { FakeSftpServer, SFTP_STATUS, sftpStatusError } from './fakeSftpClient';

/**
 * The in-memory SFTP server the file manager's unit tests run on (E25). The contract pins it to
 * what a real OpenSSH server answers; the rest pins the knobs the engine and service tests use.
 */

describeSftpClientContract('in-memory fake', async () => {
  const server = new FakeSftpServer();
  const root = '/srv/contract';
  server.dir(root);
  const client = server.connect();
  return {
    client,
    root,
    seed: {
      dir: async (path, mode) => void server.dir(path, { mode }),
      file: async (path, content, options) => void server.file(path, content, options),
      link: async (path, target) => void server.link(path, target),
    },
    read: async (path) => server.read(path),
  };
});

let scratch = '';
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentmate-fake-sftp-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;
async function localFile(content: string): Promise<string> {
  counter += 1;
  const path = join(scratch, `src-${counter}`);
  await writeFile(path, content);
  return path;
}

describe('seeding and reading back', () => {
  it('makes parents, follows links on read, and tells a link from what it points at', () => {
    const server = new FakeSftpServer();
    server.file('/var/www/index.html', 'hi', { mode: 0o640 });
    server.link('/var/current', 'www');
    server.link('/var/broken', '/nowhere');

    expect(server.read('/var/current/index.html')).toEqual(Buffer.from('hi'));
    expect(server.modeOf('/var/www/index.html')).toBe(0o640);
    expect(server.modeOf('/var/www')).toBe(0o755);
    expect(server.exists('/var/broken')).toBe(true);
    expect(server.read('/var/broken')).toBeNull();
    expect(server.linkTarget('/var/current')).toBe('www');
    expect(server.exists('/var/missing')).toBe(false);
    expect(server.modeOf('/var/missing')).toBeNull();
  });

  it('starts with a home folder that realpath answers for .', async () => {
    const server = new FakeSftpServer({ home: '/home/ana' });
    const client = server.connect();

    await expect(client.sftpRealpath('.')).resolves.toBe('/home/ana');
    await expect(client.sftpRealpath('notes')).rejects.toMatchObject({
      code: SFTP_STATUS.noSuchFile,
    });
    server.dir('/home/ana/notes');
    await expect(client.sftpRealpath('notes')).resolves.toBe('/home/ana/notes');
  });

  it('writes an ls -l style longname with the owner and group', async () => {
    const server = new FakeSftpServer({ now: () => Date.UTC(2024, 0, 5, 10, 12) });
    server.file('/d/my file.txt', '1234', { mode: 0o4755, owner: 'deploy', group: 'www-data' });
    server.link('/d/ln', 'my file.txt');

    const entries = await server.connect().sftpListDetailed('/d');
    const file = entries.find((entry) => entry.name === 'my file.txt');
    const link = entries.find((entry) => entry.name === 'ln');

    expect(file?.longname).toBe(
      '-rwsr-xr-x    1 deploy   www-data        4 Jan  5  2024 my file.txt',
    );
    expect(file?.mode).toBe(0o4755);
    expect(link?.longname).toMatch(/^lrwxrwxrwx +1 deploy +deploy +11 Jan {2}5 {2}2024 ln$/);
  });

  it('answers with ssh2-shaped errors that mapSftpError understands', async () => {
    const server = new FakeSftpServer();
    server.failNext('sftpStat', SFTP_STATUS.permissionDenied);

    const failure = await server
      .connect()
      .sftpStat('/etc/shadow')
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 3, message: 'Permission denied' });
    expect(filesErrorCode(mapSftpError(failure, '/etc/shadow'))).toBe('permissionDenied');
  });
});

describe('failNext', () => {
  it('fails the next matching call once, then answers normally', async () => {
    const server = new FakeSftpServer();
    server.dir('/a');
    const client = server.connect();
    server.failNext('sftpMkdir', new Error('boom'));

    await expect(client.sftpMkdir('/a/x')).rejects.toThrow('boom');
    await expect(client.sftpMkdir('/a/x')).resolves.toBeUndefined();
  });

  it('can be limited to one path', async () => {
    const server = new FakeSftpServer();
    server.dir('/a').dir('/b');
    const client = server.connect();
    server.failNext('sftpListDetailed', '/b', sftpStatusError(SFTP_STATUS.failure));

    await expect(client.sftpListDetailed('/a')).resolves.toEqual([]);
    await expect(client.sftpListDetailed('/b')).rejects.toMatchObject({ code: 4 });
    await expect(client.sftpListDetailed('/b')).resolves.toEqual([]);
  });
});

describe('dropConnection', () => {
  it('closes the client: new calls reject with the real "is closed." text', async () => {
    const server = new FakeSftpServer({ host: 'web1.example' });
    const client = server.connect();

    client.dropConnection();

    expect(client.isOpen).toBe(false);
    await expect(client.sftpStat('/')).rejects.toThrow(
      'The SSH connection to web1.example is closed.',
    );
  });

  it('fails a call in flight with the "closed." text', async () => {
    const server = new FakeSftpServer({ host: 'web1.example' });
    const client = server.connect();
    const gate = server.gate('sftpStat');

    const pending = client.sftpStat('/').catch((error: unknown) => error);
    await gate.waitFor(1);
    server.dropConnection();

    expect(await pending).toMatchObject({
      message: 'The SSH connection to web1.example closed.',
    });
    expect(gate.waiting).toBe(0);
  });
});

describe('gate', () => {
  it('holds calls of one kind until they are released', async () => {
    const server = new FakeSftpServer();
    server.dir('/up');
    const client = server.connect();
    const gate = server.gate('uploadFile');
    const sources = await Promise.all([localFile('1'), localFile('2'), localFile('3')]);

    const uploads = sources.map((source, index) => client.uploadFile(source, `/up/${index}`));
    await gate.waitFor(3);
    expect(gate.waiting).toBe(3);
    expect(server.exists('/up/0')).toBe(false);
    // Other kinds of call are not held.
    await expect(client.sftpStat('/up')).resolves.toMatchObject({ isDirectory: true });

    gate.release(1);
    await uploads[0];
    expect(server.exists('/up/0')).toBe(true);
    expect(gate.waiting).toBe(2);

    gate.open();
    await Promise.all(uploads);
    expect(server.read('/up/2')).toEqual(Buffer.from('3'));
    expect(server.maxInFlight('uploadFile')).toBeGreaterThanOrEqual(1);
  });

  it('lets an abort through to a held transfer', async () => {
    const server = new FakeSftpServer();
    server.dir('/up');
    server.gate('uploadFile');
    const controller = new AbortController();

    const pending = server
      .connect()
      .uploadFile(await localFile('x'), '/up/x', { signal: controller.signal })
      .catch((error: unknown) => error);
    await server.gate('uploadFile').waitFor(1);
    controller.abort();

    expect(filesErrorCode(await pending)).toBe('cancelled');
    expect(server.exists('/up/x')).toBe(false);
  });
});

describe('uploads', () => {
  it('reports progress in progressSteps steps through a .part beside the target', async () => {
    const server = new FakeSftpServer({ progressSteps: 4 });
    server.dir('/up');
    const sent: number[] = [];
    const seen: string[][] = [];

    await server.connect().uploadFile(await localFile('abcdefgh'), '/up/f', {
      onProgress: (bytes) => {
        sent.push(bytes);
        seen.push(server.list('/up'));
      },
    });

    expect(sent).toEqual([2, 4, 6, 8]);
    expect(seen[0]).toEqual([expect.stringMatching(/^f\.agentmate-[0-9a-f]{8}\.part$/)]);
    expect(server.list('/up')).toEqual(['f']);
  });

  it('removes the .part and keeps the target when cancelled midway', async () => {
    const server = new FakeSftpServer({ progressSteps: 4 });
    server.file('/up/f', 'old');
    const controller = new AbortController();

    const failure = await server
      .connect()
      .uploadFile(await localFile('abcdefgh'), '/up/f', {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    expect(server.list('/up')).toEqual(['f']);
    expect(server.read('/up/f')).toEqual(Buffer.from('old'));
  });

  it('honours an explicit mode, and refuses a missing folder or a folder as the target', async () => {
    const server = new FakeSftpServer();
    server.dir('/up/sub');
    const client = server.connect();
    const source = await localFile('x');

    const result = await client.uploadFile(source, '/up/run.sh', { mode: 0o750 });
    expect(result.stat.mode).toBe(0o750);
    expect(server.modeOf('/up/run.sh')).toBe(0o750);

    await expect(client.uploadFile(source, '/nope/x')).rejects.toMatchObject({ code: 2 });
    await expect(client.uploadFile(source, '/up/sub')).rejects.toMatchObject({ code: 4 });
    await expect(client.uploadFile(join(scratch, 'missing'), '/up/y')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('downloads', () => {
  it('writes through a local .part and replaces the target only at the end', async () => {
    const server = new FakeSftpServer({ progressSteps: 2 });
    server.file('/d/f', 'abcd', { mtimeMs: 1_700_000_000_500 });
    const dir = await mkdtemp(join(scratch, 'dl-'));
    const target = join(dir, 'f');
    const during: string[][] = [];
    const progress: [number, number][] = [];

    const result = await server.connect().downloadFile('/d/f', target, {
      onProgress: (got, total) => {
        progress.push([got, total]);
        during.push(readdirSync(dir));
      },
    });

    expect(progress).toEqual([
      [2, 4],
      [4, 4],
    ]);
    expect(during[0]).toEqual([expect.stringMatching(/^f\.agentmate-[0-9a-f]{8}\.part$/)]);
    expect(result).toEqual({ size: 4, mtimeMs: 1_700_000_000_000, replaced: false });
    expect(await readdir(dir)).toEqual(['f']);
    expect((await stat(target)).mtimeMs).toBe(1_700_000_000_000);
  });

  it('removes the .part and leaves the local file when cancelled midway', async () => {
    const server = new FakeSftpServer({ progressSteps: 4 });
    server.file('/d/f', 'abcdefgh');
    const dir = await mkdtemp(join(scratch, 'dl-'));
    const target = join(dir, 'f');
    await writeFile(target, 'mine');
    const controller = new AbortController();

    const failure = await server
      .connect()
      .downloadFile('/d/f', target, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    expect(await readdir(dir)).toEqual(['f']);
    await expect(readFile(target, 'utf-8')).resolves.toBe('mine');
  });

  it('keeps the local mtime as it is when asked not to preserve it', async () => {
    const server = new FakeSftpServer();
    server.file('/d/f', 'x', { mtimeMs: 1_000_000_000_000 });
    const target = join(await mkdtemp(join(scratch, 'dl-')), 'f');

    await server.connect().downloadFile('/d/f', target, { preserveMtime: false });

    expect((await stat(target)).mtimeMs).toBeGreaterThan(1_500_000_000_000);
  });

  it('refuses a folder or a missing file', async () => {
    const server = new FakeSftpServer();
    server.dir('/d');
    const client = server.connect();
    const target = join(scratch, 'never');

    await expect(client.downloadFile('/d', target)).rejects.toMatchObject({ code: 4 });
    await expect(client.downloadFile('/d/none', target)).rejects.toMatchObject({ code: 2 });
  });
});

describe('the call log', () => {
  it('records each call in order with its path', async () => {
    const server = new FakeSftpServer();
    server.dir('/w');
    const client = server.connect();

    await client.sftpMkdir('/w/a');
    await client.sftpRename('/w/a', '/w/b');
    await client.sftpStat('/w/b');

    expect(server.calls.map(({ op, path, to }) => [op, path, to])).toEqual([
      ['sftpMkdir', '/w/a', undefined],
      ['sftpRename', '/w/a', '/w/b'],
      ['sftpStat', '/w/b', undefined],
    ]);
    expect(server.callsOf('sftpStat')).toEqual(['/w/b']);
    expect(server.calls.every((call) => call.clientId === client.id)).toBe(true);
  });
});

describe('the pool', () => {
  it('shares one client per server through acquire, and counts leases', async () => {
    const server = new FakeSftpServer();
    const { pool } = server;

    const first = await pool.acquire('s1');
    const second = await pool.acquire('s1');
    expect(second.client).toBe(first.client);
    expect(pool.outstanding).toBe(2);

    first.release();
    first.release();
    second.release();
    expect(pool.acquired).toBe(2);
    expect(pool.released).toBe(2);
    expect(pool.outstanding).toBe(0);
    // The shared connection stays open for the next lease, as the real pool keeps it.
    expect(first.client.isOpen).toBe(true);
  });

  it('replaces a shared client that dropped', async () => {
    const server = new FakeSftpServer();
    const first = await server.pool.acquire('s1');
    server.dropConnection();

    const next = await server.pool.acquire('s1');

    expect(next.client).not.toBe(first.client);
    expect(next.client.isOpen).toBe(true);
  });

  it('opens a client of its own with openSeparate and closes it on release', async () => {
    const server = new FakeSftpServer();
    const shared = await server.pool.acquire('s1');

    const separate = await server.pool.openSeparate('s1');

    expect(separate.client).not.toBe(shared.client);
    expect(server.pool.openedSeparate).toBe(1);
    separate.release();
    expect(separate.client.isOpen).toBe(false);
    expect(shared.client.isOpen).toBe(true);
  });

  it('fails a lease with failNext, as a locked vault would', async () => {
    const server = new FakeSftpServer();
    server.failNext('acquire', 's1', new Error('[ssh:vault-locked] Unlock first.'));

    await expect(server.pool.acquire('s1')).rejects.toThrow('vault-locked');
    await expect(server.pool.acquire('s1')).resolves.toBeDefined();
    expect(server.pool.acquired).toBe(2);
  });
});
