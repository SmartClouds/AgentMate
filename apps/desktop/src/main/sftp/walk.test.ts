import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { tempDir, writeTree } from '../../test/main/fixtures';
import { FakeSftpServer, SFTP_STATUS } from './testing/fakeSftpClient';
import { type LocalWalkFs, remoteEntryOf, walkLocal, walkRemote } from './walk';

/**
 * The recursive walks behind folder transfers (E25): pre-order, so a folder always comes before
 * what it holds; links to folders are never followed but reported, links to files are; whatever
 * vanishes during the walk is left out; the item cap and the abort signal stop it; and a remote
 * walk keeps at most 8 listings in flight.
 */

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** Junctions need no rights on Windows; file links need admin or developer mode there. */
function tryLink(target: string, path: string, kind: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? kind : undefined);
    return true;
  } catch {
    return false;
  }
}

const canLinkFiles = (() => {
  const dir = tempDir('runova-walk-probe-');
  writeFileSync(join(dir, 'a'), 'a');
  const ok = tryLink(join(dir, 'a'), join(dir, 'b'), 'file');
  rmSync(dir, { recursive: true, force: true });
  return ok;
})();

describe('walkLocal', () => {
  it('lists everything below the folder, pre-order and by name, with sizes and times', async () => {
    const root = tempDir('runova-walk-');
    writeTree(root, { 'a.txt': 'aaa', 'css/site.css': 'body{}', 'css/sub/x.css': 'x' });
    mkdirSync(join(root, 'empty'));
    const { items, skippedLinks } = await walkLocal(root, {});
    expect(items.map((item) => item.relPath)).toEqual([
      'a.txt',
      'css',
      'css/site.css',
      'css/sub',
      'css/sub/x.css',
      'empty',
    ]);
    expect(skippedLinks).toEqual([]);
    const file = items.find((item) => item.relPath === 'css/site.css');
    expect(file).toMatchObject({ isDirectory: false, size: 6 });
    expect(file?.mtimeMs).toBeGreaterThan(0);
    const folder = items.find((item) => item.relPath === 'css');
    expect(folder).toMatchObject({ isDirectory: true, size: 0 });
    if (process.platform === 'win32') expect(file?.mode).toBeNull();
    else expect(file?.mode).toBe(statSync(join(root, 'css', 'site.css')).mode & 0o7777);
  });

  it('does not descend into a linked folder, and reports it', async () => {
    const root = tempDir('runova-walk-');
    const outside = tempDir('runova-walk-outside-');
    writeTree(outside, { 'secret.txt': 'do not send' });
    writeTree(root, { 'keep.txt': 'k' });
    expect(tryLink(outside, join(root, 'linked'), 'junction')).toBe(true);
    const { items, skippedLinks } = await walkLocal(root, {});
    expect(items.map((item) => item.relPath)).toEqual(['keep.txt']);
    expect(skippedLinks).toEqual(['linked']);
  });

  it('reports a broken link', async () => {
    const root = tempDir('runova-walk-');
    const gone = tempDir('runova-walk-gone-');
    expect(tryLink(gone, join(root, 'dangling'), 'junction')).toBe(true);
    rmSync(gone, { recursive: true, force: true });
    const { items, skippedLinks } = await walkLocal(root, {});
    expect(items).toEqual([]);
    expect(skippedLinks).toEqual(['dangling']);
  });

  it.skipIf(!canLinkFiles)('follows a link to a file', async () => {
    const root = tempDir('runova-walk-');
    const outside = tempDir('runova-walk-outside-');
    writeTree(outside, { 'real.txt': '12345' });
    tryLink(join(outside, 'real.txt'), join(root, 'alias.txt'), 'file');
    const { items, skippedLinks } = await walkLocal(root, {});
    expect(items).toEqual([expect.objectContaining({ relPath: 'alias.txt', size: 5 })]);
    expect(skippedLinks).toEqual([]);
  });

  it('leaves out a file or folder that vanishes during the walk', async () => {
    const root = tempDir('runova-walk-');
    writeTree(root, { 'a.txt': 'a', 'b.txt': 'b', 'gone/x.txt': 'x' });
    const fs: LocalWalkFs = {
      readdir: (path) => fsPromises.readdir(path),
      stat: fsPromises.stat,
      lstat: async (path) => {
        if (path.endsWith('b.txt')) {
          throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
        }
        return fsPromises.lstat(path);
      },
    };
    const vanishing: LocalWalkFs = {
      ...fs,
      readdir: async (path) => {
        if (path.endsWith('gone')) {
          throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
        }
        return fsPromises.readdir(path);
      },
    };
    const { items } = await walkLocal(root, { fs: vanishing });
    expect(items.map((item) => item.relPath)).toEqual(['a.txt', 'gone']);
  });

  it('throws tooManyFiles past the cap', async () => {
    const root = tempDir('runova-walk-');
    writeTree(root, { 'a.txt': 'a', 'b/c.txt': 'c', 'b/d.txt': 'd' });
    expect((await walkLocal(root, { maxItems: 4 })).items).toHaveLength(4);
    expect(filesErrorCode(await caught(walkLocal(root, { maxItems: 3 })))).toBe('tooManyFiles');
  });

  it('stops when aborted', async () => {
    const root = tempDir('runova-walk-');
    writeTree(root, { 'a/1.txt': '1', 'b/2.txt': '2' });
    const before = new AbortController();
    before.abort();
    expect(filesErrorCode(await caught(walkLocal(root, { signal: before.signal })))).toBe(
      'cancelled',
    );

    const during = new AbortController();
    const fs: LocalWalkFs = {
      lstat: fsPromises.lstat,
      stat: fsPromises.stat,
      readdir: async (path) => {
        if (path.endsWith('a')) during.abort();
        return fsPromises.readdir(path);
      },
    };
    expect(filesErrorCode(await caught(walkLocal(root, { signal: during.signal, fs })))).toBe(
      'cancelled',
    );
  });

  it('fails with folderMissing when the folder itself is gone', async () => {
    const root = join(tempDir('runova-walk-'), 'nope');
    expect(filesErrorCode(await caught(walkLocal(root, {})))).toBe('folderMissing');
  });

  it('passes on other failures of the folder itself', async () => {
    const fs: LocalWalkFs = {
      lstat: fsPromises.lstat,
      stat: fsPromises.stat,
      readdir: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    const error = await caught(walkLocal(tempDir('runova-walk-'), { fs }));
    expect((error as { code?: string }).code).toBe('EACCES');
  });
});

function siteServer(): FakeSftpServer {
  const server = new FakeSftpServer();
  server
    .file('/srv/site/index.html', '<h1>hi</h1>', { mode: 0o640 })
    .file('/srv/site/css/site.css', 'body{}')
    .dir('/srv/site/empty')
    .file('/etc/passwd', 'root:x:0:0')
    .link('/srv/site/etc', '/etc')
    .link('/srv/site/alias.html', 'index.html')
    .link('/srv/site/broken', '/nowhere');
  return server;
}

describe('walkRemote', () => {
  it('lists everything pre-order, links to folders reported and not followed', async () => {
    const server = siteServer();
    const { items, skippedLinks } = await walkRemote(server.connect(), '/srv/site', {});
    expect(items.map((item) => item.relPath)).toEqual([
      'alias.html',
      'css',
      'css/site.css',
      'empty',
      'index.html',
    ]);
    expect(skippedLinks).toEqual(['broken', 'etc']);
    expect(items.find((item) => item.relPath === 'index.html')).toMatchObject({
      isDirectory: false,
      size: 11,
      mode: 0o640,
    });
    expect(items.find((item) => item.relPath === 'alias.html')).toMatchObject({ size: 11 });
    expect(items.find((item) => item.relPath === 'css')).toMatchObject({
      isDirectory: true,
      size: 0,
      mode: 0o755,
    });
    expect(server.callsOf('sftpListDetailed')).not.toContain('/srv/site/etc');
  });

  it('leaves out a folder that vanishes during the walk', async () => {
    const server = siteServer();
    server.failNext('sftpListDetailed', '/srv/site/css', SFTP_STATUS.noSuchFile);
    const { items } = await walkRemote(server.connect(), '/srv/site', {});
    expect(items.map((item) => item.relPath)).toEqual(['alias.html', 'css', 'empty', 'index.html']);
  });

  it('passes on any other listing failure, and the root missing', async () => {
    const server = siteServer();
    server.failNext('sftpListDetailed', '/srv/site/css', SFTP_STATUS.permissionDenied);
    const error = await caught(walkRemote(server.connect(), '/srv/site', {}));
    expect((error as { code?: number }).code).toBe(SFTP_STATUS.permissionDenied);
    const missing = await caught(walkRemote(server.connect(), '/srv/none', {}));
    expect((missing as { code?: number }).code).toBe(SFTP_STATUS.noSuchFile);
  });

  it('throws tooManyFiles past the cap', async () => {
    const server = siteServer();
    expect((await walkRemote(server.connect(), '/srv/site', { maxItems: 5 })).items).toHaveLength(
      5,
    );
    const error = await caught(walkRemote(server.connect(), '/srv/site', { maxItems: 4 }));
    expect(filesErrorCode(error)).toBe('tooManyFiles');
  });

  it('stops when aborted', async () => {
    const server = siteServer();
    const controller = new AbortController();
    const gate = server.gate('sftpListDetailed');
    const walking = caught(
      walkRemote(server.connect(), '/srv/site', { signal: controller.signal }),
    );
    await gate.waitFor(1);
    gate.release(1);
    await gate.waitFor(2);
    controller.abort();
    gate.open();
    expect(filesErrorCode(await walking)).toBe('cancelled');
  });

  it('keeps at most 8 listings in flight', async () => {
    const server = new FakeSftpServer();
    for (let index = 0; index < 20; index += 1) {
      server.file(`/big/d${String(index).padStart(2, '0')}/f.txt`, 'x');
    }
    const gate = server.gate('sftpListDetailed');
    const walking = walkRemote(server.connect(), '/big', {});
    await gate.waitFor(1);
    gate.release(1);
    await gate.waitFor(8);
    for (let spin = 0; spin < 20; spin += 1) await Promise.resolve();
    expect(gate.waiting).toBe(8);
    gate.open();
    const { items } = await walking;
    expect(items).toHaveLength(40);
    expect(items[0].relPath).toBe('d00');
    expect(items[1].relPath).toBe('d00/f.txt');
    expect(server.maxInFlight('sftpListDetailed')).toBeLessThanOrEqual(8);
  });
});

describe('remoteEntryOf', () => {
  it('reads an entry from its folder, links as links', async () => {
    const server = siteServer();
    const client = server.connect();
    expect(await remoteEntryOf(client, '/srv/site/etc')).toMatchObject({
      name: 'etc',
      isSymlink: true,
      isDirectory: true,
    });
    expect(await remoteEntryOf(client, '/srv/site/index.html')).toMatchObject({ size: 11 });
    expect(await remoteEntryOf(client, '/srv/site/none')).toBeNull();
    expect(await remoteEntryOf(client, '/nowhere/at/all')).toBeNull();
    expect(await remoteEntryOf(client, '/')).toMatchObject({ isDirectory: true, isSymlink: false });
  });

  it('shares one listing per folder through the cache', async () => {
    const server = siteServer();
    const client = server.connect();
    const cache = new Map();
    await remoteEntryOf(client, '/srv/site/index.html', cache);
    await remoteEntryOf(client, '/srv/site/css', cache);
    expect(server.callsOf('sftpListDetailed')).toEqual(['/srv/site']);
  });

  it('passes on a failure other than a missing folder', async () => {
    const server = siteServer();
    server.failNext('sftpListDetailed', SFTP_STATUS.permissionDenied);
    const error = await caught(remoteEntryOf(server.connect(), '/srv/site/index.html'));
    expect((error as { code?: number }).code).toBe(SFTP_STATUS.permissionDenied);
  });
});
