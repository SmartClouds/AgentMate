import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  FileEntry,
  FileTarget,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/AgentMate.ServerCore.Contracts';
import { filesErrorCode, filesErrorMessage } from '../../../shared/deployFilesErrors';
import { toCodedError } from '../../sftp/errors';
import { describeSftpClientContract, type SftpClientHarness } from '../../sftp/testing/contract';
import { CoreHttpError } from '../connection/coreHttp';
import { coreFilesFailure, DockerFileClient, type DockerFilesBackend } from './client';
import { type FakeDockerFiles, startFakeDockerFiles } from './testing/fakeBackend';

/**
 * The Docker file client (E27): the E25 client contract on a running container with a shell and
 * on a volume, both on the fake core, then what is particular to the core: what a stopped or
 * shell-less container refuses, how the core's coded errors reach the file manager, sessions
 * that end on the core, cancel and stall part way through a transfer, progress and ranges.
 */

const SERVER_ID = 'srv-1';
let contractCount = 0;

async function contractHarness(target: FileTarget): Promise<SftpClientHarness> {
  const fixture = await startFakeDockerFiles();
  const session = await fixture.connection().filesOpen(target);
  const client = new DockerFileClient({ serverId: SERVER_ID, session, backend: fixture.backend });
  const tree = fixture.core.files.tree(target);
  contractCount += 1;
  const root = `/contract-${contractCount}`;
  tree.dir(root);
  return {
    client,
    root,
    seed: {
      dir: async (path, mode) => {
        tree.dir(path, mode);
      },
      file: async (path, content, options) => {
        tree.file(path, content, options);
      },
      link: async (path, target) => {
        tree.link(path, target);
      },
    },
    read: async (path) => {
      try {
        return Buffer.from(tree.read(path).bytes);
      } catch {
        return null;
      }
    },
    cleanup: async () => {
      await client.close();
      await fixture.close();
    },
  };
}

describeSftpClientContract('Docker container on the fake core', () =>
  contractHarness({ kind: 'container', id: 'toolbox' }),
);
describeSftpClientContract('Docker volume on the fake core', () =>
  contractHarness({ kind: 'volume', id: 'old-cache' }),
);

let fixture: FakeDockerFiles;
let scratch: string;

beforeEach(async () => {
  fixture = await startFakeDockerFiles();
  scratch = await mkdtemp(join(tmpdir(), 'agentmate-docker-files-'));
});

afterEach(async () => {
  await fixture.close();
  await rm(scratch, { recursive: true, force: true });
});

async function open(
  target: FileTarget,
  options: { backend?: DockerFilesBackend; stallTimeoutMs?: number } = {},
) {
  const session = await fixture.connection().filesOpen(target);
  const client = new DockerFileClient({
    serverId: SERVER_ID,
    session,
    backend: options.backend ?? fixture.backend,
    ...(options.stallTimeoutMs ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
  });
  return { client, session, tree: fixture.core.files.tree(target) };
}

const VOLUME: FileTarget = { kind: 'volume', id: 'shop_uploads' };
const STOPPED: FileTarget = { kind: 'container', id: 'migrate-once' };

async function failure(work: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await work;
  } catch (error) {
    return error as Error & { code?: unknown };
  }
  throw new Error('expected a failure');
}

async function partsIn(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.endsWith('.part'));
}

function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 253;
  return bytes;
}

describe('DockerFileClient', () => {
  describe('the session', () => {
    it('reports what a running container allows, editing included', async () => {
      const { client } = await open({ kind: 'container', id: 'toolbox' });

      expect(client.capabilities()).toEqual({
        rename: true,
        remove: true,
        chmod: true,
        edit: true,
      });
      expect(client.limitation()).toBeNull();
      expect(client.isOpen).toBe(true);
    });

    it('starts relative paths and . at the session home', async () => {
      fixture.core.files.homes.set('toolbox', '/srv/app');
      const target: FileTarget = { kind: 'container', id: 'toolbox' };
      fixture.core.files.tree(target).dir('/srv/app/public');
      const { client } = await open(target);

      await expect(client.sftpRealpath('.')).resolves.toBe('/srv/app');
      await expect(client.sftpRealpath('public/..')).resolves.toBe('/srv/app');
    });

    it('closes its core session once, and refuses calls after that like a closed connection', async () => {
      const { client, session } = await open(VOLUME);

      await Promise.all([client.close(), client.close()]);

      expect(fixture.core.files.closed).toEqual([session.sessionId]);
      expect(client.isOpen).toBe(false);
      const refused = await failure(client.sftpListDetailed('/'));
      expect(refused.message).toMatch(/connection to shop_uploads is closed/);
      expect(filesErrorCode(toCodedError(refused, '/'))).toBe('unreachable');
    });
  });

  describe('a stopped or shell-less container', () => {
    it('lists, makes folders and moves files, though uploads are not atomic', async () => {
      const { client, tree } = await open(STOPPED);
      tree.file('/app/config.json', '{}');
      const local = join(scratch, 'up.txt');
      await writeFile(local, 'payload');

      expect(client.capabilities()).toEqual({
        rename: false,
        remove: false,
        chmod: false,
        edit: false,
      });
      expect(client.limitation()).toMatch(/stopped/);
      await client.sftpMkdir('/app/new');
      const uploaded = await client.uploadFile(local, '/app/new/up.txt');
      const downloaded = await client.downloadFile('/app/config.json', join(scratch, 'c.json'));

      expect(uploaded.atomic).toBe(false);
      expect(downloaded.size).toBe(2);
      expect((await client.sftpListDetailed('/app')).map((entry) => entry.name)).toEqual([
        'config.json',
        'new',
      ]);
    });

    it('turns down rename, delete and chmod as unsupported, with the reason', async () => {
      const { client, tree } = await open(STOPPED);
      tree.file('/a.txt', 'a').dir('/empty');

      for (const attempt of [
        client.sftpRename('/a.txt', '/b.txt'),
        client.sftpUnlink('/a.txt'),
        client.sftpRmdir('/empty'),
        client.sftpChmod('/a.txt', 0o600),
      ]) {
        const refused = await failure(attempt);
        expect(refused.code).toBe(8);
        expect(refused.message).toMatch(/The container is stopped/);
      }
      expect(tree.lstat('/a.txt')).not.toBeNull();
    });

    it('says when a listing without a shell was cut short', async () => {
      fixture.core.files.noShell.add('shop-api-1');
      fixture.core.files.scanCap = 2;
      const target: FileTarget = { kind: 'container', id: 'shop-api-1' };
      fixture.core.files.tree(target).file('/many/a', '').file('/many/b', '').file('/many/c', '');
      const { client } = await open(target);

      const listing = await client.sftpListing('/many');

      expect(listing.partial).toBe(true);
      expect(listing.entries.map((entry) => entry.name)).toEqual(['a', 'b']);
      expect(client.limitation()).toMatch(/no shell/);
    });
  });

  describe('links', () => {
    it('lists a working link as what it points at and stats through it', async () => {
      const { client, tree } = await open(VOLUME);
      tree
        .file('/real/data.bin', 'twelve bytes', { mode: 0o600 })
        .link('/real/latest', 'data.bin')
        .link('/real/up', '..')
        .link('/real/loop', 'loop');

      const entries = await client.sftpListDetailed('/real');
      const byName = (name: string) => entries.find((entry) => entry.name === name);

      expect(byName('latest')).toMatchObject({
        isFile: true,
        isSymlink: true,
        brokenLink: false,
        size: 12,
        mode: 0o600,
      });
      expect(byName('latest')?.longname).toMatch(/^lrwxrwxrwx +1 root +root .* latest$/);
      expect(byName('up')).toMatchObject({ isDirectory: true, isSymlink: true });
      expect(byName('loop')).toMatchObject({ isSymlink: true, brokenLink: true });
      await expect(client.sftpStat('/real/latest')).resolves.toMatchObject({ size: 12 });
      await expect(client.sftpStat('/real/loop')).resolves.toBeNull();
      await expect(client.sftpStat('/real/data.bin/inside')).resolves.toBeNull();
    });
  });

  describe('ls lines', () => {
    it('marks pipes, sockets, devices and the special permission bits the way ls does', async () => {
      const entry = (name: string, kind: FileEntry['kind'], mode: number, uid = 0): FileEntry => ({
        name,
        kind,
        size: 0,
        mtimeUnixMs: Date.UTC(2026, 9, 22, 6, 0),
        mode,
        uid,
        gid: uid,
        linkIsDirectory: false,
        brokenLink: false,
      });
      const entries = [
        entry('pipe', 'other', 0o010644),
        entry('socket', 'other', 0o140755),
        entry('tty', 'other', 0o020666),
        entry('disk', 'other', 0o060660),
        entry('odd', 'other', 0o000644),
        entry('su', 'file', 0o104755),
        entry('group', 'file', 0o102644, 1000),
        entry('tmp', 'directory', 0o041777),
      ];
      const backend: DockerFilesBackend = {
        withHub: (serverId, work) =>
          fixture.backend.withHub(serverId, (hub) =>
            work(
              Object.assign(Object.create(hub) as ICoreHub, {
                filesList: async () => ({ path: '/dev', entries, partial: false }),
              }),
            ),
          ),
        withCoreHttp: fixture.backend.withCoreHttp,
      };
      const { client } = await open(VOLUME, { backend });

      const lines = Object.fromEntries(
        (await client.sftpListDetailed('/dev')).map((one) => [one.name, one.longname]),
      );

      expect(lines.pipe).toMatch(/^prw-r--r-- /);
      expect(lines.socket).toMatch(/^srwxr-xr-x /);
      expect(lines.tty).toMatch(/^crw-rw-rw- /);
      expect(lines.disk).toMatch(/^brw-rw---- /);
      expect(lines.odd).toMatch(/^\?rw-r--r-- /);
      expect(lines.su).toMatch(/^-rwsr-xr-x +1 root +root /);
      expect(lines.group).toMatch(/^-rw-r-Sr-- +1 1000 +1000 /);
      expect(lines.tmp).toMatch(/^drwxrwxrwt /);
    });
  });

  describe('coreFilesFailure', () => {
    it('reads the code from a REST body, and the HTTP message when the body has no sentence', () => {
      expect(
        coreFilesFailure(
          new CoreHttpError('Not Found', 404, { code: 'notFound', message: 'Gone.' }),
        ),
      ).toEqual({ code: 'notFound', sentence: 'Gone.' });
      expect(coreFilesFailure(new CoreHttpError('Not Found', 404, { code: 'notFound' }))).toEqual({
        code: 'notFound',
        sentence: 'Not Found',
      });
      expect(coreFilesFailure(new CoreHttpError('Bad', 500, { code: 'whatever' }))).toBeNull();
      expect(coreFilesFailure(new CoreHttpError('Bad', 502, null))).toBeNull();
      expect(coreFilesFailure('[files:nonsense] Not ours.')).toBeNull();
    });
  });

  describe('the core’s errors', () => {
    it('maps a missing path to SFTP no such file', async () => {
      const { client } = await open(VOLUME);

      const refused = await failure(client.sftpListDetailed('/nothing'));

      expect(refused.code).toBe(2);
      expect(filesErrorCode(toCodedError(refused, '/nothing'))).toBe('remoteFolderMissing');
    });

    it('keeps the core’s sentence for permission, disk space and a taken name', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/a', 'a').file('/b', 'b');
      const local = join(scratch, 'big');
      await writeFile(local, 'bytes');

      fixture.core.files.failNext('list', 'permissionDenied', 'The folder is not readable.');
      const denied = await failure(client.sftpListDetailed('/'));
      fixture.core.files.failNext('write', 'diskFull', 'The volume has no room left.');
      const full = await failure(client.uploadFile(local, '/big'));
      const taken = await failure(client.sftpRename('/a', '/b'));

      expect(denied.code).toBe(3);
      expect(filesErrorCode(toCodedError(denied, '/'))).toBe('permissionDenied');
      expect(filesErrorMessage(toCodedError(denied, '/'))).toBe('The folder is not readable.');
      expect(filesErrorCode(toCodedError(full, '/big'))).toBe('diskFull');
      expect(filesErrorMessage(full)).toBe('The volume has no room left.');
      expect(taken.code).toBe(4);
      expect(filesErrorCode(toCodedError(taken, '/b'))).toBe('exists');
    });

    it('says only Admins can do this when the role is not enough', async () => {
      const { client } = await open(VOLUME);
      fixture.core.roles = ['operator'];

      const refused = await failure(client.sftpListDetailed('/'));
      const download = await failure(client.downloadFile('/x', join(scratch, 'x')));

      expect(refused.code).toBe(3);
      expect(filesErrorMessage(toCodedError(refused, '/'))).toMatch(/Only Admins/);
      expect(filesErrorCode(toCodedError(download, '/x'))).toBe('permissionDenied');
    });

    it('closes the client when the core has forgotten the session', async () => {
      const { client } = await open(VOLUME);
      fixture.core.files.expire();

      const refused = await failure(client.sftpListDetailed('/'));
      const calls = fixture.hubCalls;
      const later = await failure(client.sftpStat('/'));

      expect(refused.message).toMatch(/connection to shop_uploads closed/);
      expect(client.isOpen).toBe(false);
      expect(later.message).toMatch(/is closed/);
      expect(fixture.hubCalls).toBe(calls);
    });

    it('closes the client when its container is removed, over REST too', async () => {
      const { client, tree } = await open({ kind: 'container', id: 'toolbox' });
      tree.file('/f', 'f');
      fixture.core.docker.remove({ containerId: 'toolbox', removeVolumes: false, force: true });

      const refused = await failure(client.downloadFile('/f', join(scratch, 'f')));

      expect(client.isOpen).toBe(false);
      expect(filesErrorCode(toCodedError(refused, '/f'))).toBe('unreachable');
      expect(await partsIn(scratch)).toEqual([]);
    });

    it('closes the client when the hub connection is lost', async () => {
      const lost: DockerFilesBackend = {
        ...fixture.backend,
        withHub: async () => {
          throw new Error('Invocation canceled due to the underlying connection being closed.');
        },
      };
      const { client } = await open(VOLUME, { backend: lost });

      await failure(client.sftpListDetailed('/'));

      expect(client.isOpen).toBe(false);
    });
  });

  describe('downloads', () => {
    it('reports progress against the size and lands with the remote mtime', async () => {
      const { client, tree } = await open(VOLUME);
      const bytes = pattern(100_000);
      tree.file('/dump.sql', bytes, { mtimeMs: 1_700_000_123_000 });
      fixture.http.pace = { chunkBytes: 16_384, delayMs: 1 };
      const seen: Array<[number, number]> = [];

      const result = await client.downloadFile('/dump.sql', join(scratch, 'dump.sql'), {
        onProgress: (got, total) => seen.push([got, total]),
      });

      expect(result).toEqual({ size: 100_000, mtimeMs: 1_700_000_123_000, replaced: false });
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every(([, total]) => total === 100_000)).toBe(true);
      expect(seen.map(([got]) => got)).toEqual([...seen.map(([got]) => got)].sort((a, b) => a - b));
      expect(seen.at(-1)).toEqual([100_000, 100_000]);
      expect((await stat(join(scratch, 'dump.sql'))).mtimeMs).toBe(1_700_000_123_000);
      expect(fixture.http.requests.at(-1)?.headers.authorization).toBe('Bearer files-token-1');
    });

    it('leaves the local mtime alone when told to', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/a', 'a', { mtimeMs: 1_000_000_000_000 });

      await client.downloadFile('/a', join(scratch, 'a'), { preserveMtime: false });

      expect((await stat(join(scratch, 'a'))).mtimeMs).toBeGreaterThan(1_000_000_000_000);
    });

    it('stops part way when cancelled, keeping the old file and leaving no part', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/big.bin', pattern(400_000));
      fixture.http.pace = { chunkBytes: 4_096, delayMs: 20 };
      const target = join(scratch, 'big.bin');
      await writeFile(target, 'old');
      const controller = new AbortController();

      const refused = await failure(
        client.downloadFile('/big.bin', target, {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      );

      expect(filesErrorCode(refused)).toBe('cancelled');
      expect(await readFile(target, 'utf-8')).toBe('old');
      expect(await partsIn(scratch)).toEqual([]);
      expect(client.isOpen).toBe(true);
    });

    it('gives up when the bytes stop coming, and leaves no part', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/stuck.bin', pattern(50_000));
      fixture.http.stallAfterBytes = 1_000;

      const refused = await failure(
        client.downloadFile('/stuck.bin', join(scratch, 'stuck.bin'), { stallTimeoutMs: 200 }),
      );

      expect(filesErrorCode(refused)).toBe('timeout');
      expect(filesErrorMessage(refused)).toMatch(/stopped answering for 0\.2 s/);
      expect(await partsIn(scratch)).toEqual([]);
    });

    it('refuses a folder without leaving anything behind', async () => {
      const { client, tree } = await open(VOLUME);
      tree.dir('/folder');

      const refused = await failure(client.downloadFile('/folder', join(scratch, 'folder')));

      expect(refused.code).toBe(4);
      expect(await readdir(scratch)).toEqual([]);
    });
  });

  describe('uploads', () => {
    it('sends the bytes with the mode and reports every byte sent', async () => {
      const { client, tree } = await open(VOLUME);
      const local = join(scratch, 'site.tar');
      await writeFile(local, pattern(300_000));
      const sent: number[] = [];

      const result = await client.uploadFile(local, '/site.tar', {
        mode: 0o640,
        onProgress: (bytes) => sent.push(bytes),
      });

      expect(result).toMatchObject({ atomic: true, replaced: false });
      expect(result.stat).toMatchObject({ isFile: true, size: 300_000, mode: 0o640 });
      expect(sent.at(-1)).toBe(300_000);
      expect(Buffer.from(tree.read('/site.tar').bytes)).toEqual(pattern(300_000));
      const put = fixture.http.requests.find((request) => request.method === 'PUT');
      expect(put?.url).toMatch(/\?path=%2Fsite\.tar&mode=640$/);
    });

    it('sends an empty file', async () => {
      const { client, tree } = await open(VOLUME);
      const local = join(scratch, 'empty');
      await writeFile(local, '');

      const result = await client.uploadFile(local, '/empty');

      expect(result.stat.size).toBe(0);
      expect(tree.read('/empty').bytes.length).toBe(0);
    });

    it('stops part way when cancelled and the core writes nothing', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/keep.bin', 'old');
      const local = join(scratch, 'keep.bin');
      await writeFile(local, pattern(4_000_000));
      const controller = new AbortController();

      const refused = await failure(
        client.uploadFile(local, '/keep.bin', {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
      );

      expect(filesErrorCode(refused)).toBe('cancelled');
      expect(new TextDecoder().decode(tree.read('/keep.bin').bytes)).toBe('old');
    });

    it('gives up when the core takes the bytes and never answers', async () => {
      const { client } = await open(VOLUME);
      fixture.http.holdPuts = true;
      const local = join(scratch, 'held');
      await writeFile(local, 'held');

      const refused = await failure(client.uploadFile(local, '/held', { stallTimeoutMs: 200 }));

      expect(filesErrorCode(refused)).toBe('timeout');
    });

    it('cuts the body off before its end when the bytes hash to something else', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/page.html', 'original');
      const local = join(scratch, 'page.html');
      await writeFile(local, pattern(200_000));

      const refused = await failure(
        client.uploadFile(local, '/page.html', { expectedSha256: '0'.repeat(64) }),
      );

      expect(filesErrorCode(refused)).toBe('localChanged');
      await expect.poll(() => fixture.http.cutOffPuts).toEqual(['/page.html']);
      expect(new TextDecoder().decode(tree.read('/page.html').bytes)).toBe('original');
    });
  });

  describe('ranges', () => {
    it('reads a range with a Range header, through a link, and nothing past the end', async () => {
      const { client, tree } = await open(VOLUME);
      tree.file('/r.txt', '0123456789').link('/r-link', 'r.txt');

      await expect(client.sftpReadRange('/r-link', 2, 3)).resolves.toEqual(Buffer.from('234'));
      expect(fixture.http.requests.at(-1)?.headers.range).toBe('bytes=2-4');
      await expect(client.sftpReadRange('/r.txt', 10, 5)).resolves.toEqual(Buffer.alloc(0));
      await expect(client.sftpReadRange('/r.txt', 0, 0)).resolves.toEqual(Buffer.alloc(0));
    });
  });

  describe('folders', () => {
    it('gives a new folder the mode asked for', async () => {
      const { client } = await open(VOLUME);

      await client.sftpMkdir('/private', { mode: 0o700 });

      await expect(client.sftpStat('/private')).resolves.toMatchObject({
        isDirectory: true,
        mode: 0o700,
      });
    });
  });
});
