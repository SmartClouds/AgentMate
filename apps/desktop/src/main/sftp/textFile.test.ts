import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { SFTP_EDIT_MAX_BYTES } from '../../shared/sftpTypes';
import { tempDir } from '../../test/main/fixtures';
import { FakeSftpServer, SFTP_STATUS } from './testing/fakeSftpClient';
import { readText, writeText } from './textFile';

/**
 * Remote text files for the editor (E25): too large is refused before a byte is read, binary and
 * non UTF-8 files are refused, a byte order mark is stripped and remembered; a save checks the
 * file has not changed on the server since it was read, writes atomically with the old mode and
 * the hash, and always removes its temp file.
 */

const MTIME = 1_700_000_000_000;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function server(): FakeSftpServer {
  let now = MTIME;
  const fake = new FakeSftpServer({
    now: () => {
      now += 1000;
      return now;
    },
  });
  fake.file('/srv/site/index.html', '<h1>hi</h1>\n', { mode: 0o640, mtimeMs: MTIME });
  return fake;
}

describe('readText', () => {
  it('reads a text file with its size, time and mode', async () => {
    const fake = server();
    expect(await readText(fake.connect(), '/srv/site/index.html')).toEqual({
      path: '/srv/site/index.html',
      content: '<h1>hi</h1>\n',
      size: 12,
      mtimeMs: MTIME,
      mode: 0o640,
      bom: false,
    });
  });

  it('strips a byte order mark and says it was there', async () => {
    const fake = server();
    fake.file('/srv/a.txt', Buffer.concat([BOM, Buffer.from('héllo')]));
    const file = await readText(fake.connect(), '/srv/a.txt');
    expect(file).toMatchObject({ content: 'héllo', bom: true, size: 9 });
  });

  it('refuses a file over the limit before reading a byte', async () => {
    const fake = server();
    fake.file('/srv/big.log', Buffer.alloc(SFTP_EDIT_MAX_BYTES + 1, 0x61));
    const error = await caught(readText(fake.connect(), '/srv/big.log'));
    expect(filesErrorCode(error)).toBe('tooLarge');
    expect(fake.callsOf('sftpReadRange')).toEqual([]);
  });

  it('refuses a NUL byte in the first 8 KB, and a file that is not UTF-8', async () => {
    const fake = server();
    fake.file('/srv/app.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    fake.file('/srv/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(filesErrorCode(await caught(readText(fake.connect(), '/srv/app.bin')))).toBe('notText');
    expect(filesErrorCode(await caught(readText(fake.connect(), '/srv/latin1.txt')))).toBe(
      'notText',
    );
  });

  it('only looks for NUL in the first 8 KB', async () => {
    const fake = server();
    const bytes = Buffer.alloc(9000, 0x61);
    bytes[8500] = 0;
    fake.file('/srv/late.txt', bytes);
    expect((await readText(fake.connect(), '/srv/late.txt')).content).toHaveLength(9000);
  });

  it('fails for a missing file and for a folder', async () => {
    const fake = server();
    expect(filesErrorCode(await caught(readText(fake.connect(), '/srv/none.txt')))).toBe(
      'remoteFolderMissing',
    );
    expect(filesErrorCode(await caught(readText(fake.connect(), '/srv/site')))).toBe(
      'invalidInput',
    );
  });

  it('fails with changedOnServer when the file changes while it is read', async () => {
    const fake = server();
    const client = fake.connect();
    const gate = fake.gate('sftpReadRange');
    const reading = caught(readText(client, '/srv/site/index.html'));
    await gate.waitFor(1);
    fake.file('/srv/site/index.html', '<h1>hi there</h1>\n');
    gate.open();
    expect(filesErrorCode(await reading)).toBe('changedOnServer');
  });

  it('codes a failed read', async () => {
    const fake = server();
    fake.failNext('sftpStat', SFTP_STATUS.permissionDenied);
    expect(filesErrorCode(await caught(readText(fake.connect(), '/srv/site/index.html')))).toBe(
      'permissionDenied',
    );
  });
});

describe('writeText', () => {
  const base = { size: 12, mtimeMs: MTIME };

  it('saves atomically with the old mode and the hash, and answers the new entry', async () => {
    const fake = server();
    const client = fake.connect();
    const upload = vi.spyOn(client, 'uploadFile');
    const temp = tempDir('runova-edit-');
    const entry = await writeText(
      client,
      { path: '/srv/site/index.html', content: '<h1>bye</h1>\n', bom: false, base, force: false },
      temp,
    );
    expect(fake.read('/srv/site/index.html')?.toString()).toBe('<h1>bye</h1>\n');
    expect(fake.modeOf('/srv/site/index.html')).toBe(0o640);
    const expectedSha256 = createHash('sha256').update('<h1>bye</h1>\n').digest('hex');
    expect(upload).toHaveBeenCalledWith(expect.any(String), '/srv/site/index.html', {
      mode: 0o640,
      expectedSha256,
    });
    expect(entry).toMatchObject({
      name: 'index.html',
      path: '/srv/site/index.html',
      kind: 'file',
      isDirectory: false,
      isSymlink: false,
      size: 13,
      mode: 0o640,
      owner: null,
      group: null,
    });
    expect(entry.mtimeMs).toBeGreaterThan(MTIME);
    expect(readdirSync(temp)).toEqual([]);
  });

  it('writes the byte order mark back', async () => {
    const fake = server();
    fake.file('/srv/a.txt', Buffer.concat([BOM, Buffer.from('x')]), { mtimeMs: MTIME });
    await writeText(
      fake.connect(),
      {
        path: '/srv/a.txt',
        content: 'y',
        bom: true,
        base: { size: 4, mtimeMs: MTIME },
        force: false,
      },
      tempDir('runova-edit-'),
    );
    expect(fake.read('/srv/a.txt')).toEqual(Buffer.concat([BOM, Buffer.from('y')]));
  });

  it('refuses a file that changed on the server since it was read, unless forced', async () => {
    const fake = server();
    const client = fake.connect();
    const input = { path: '/srv/site/index.html', content: 'mine', bom: false, base, force: false };
    fake.file('/srv/site/index.html', 'theirs, longer', { mtimeMs: MTIME });
    expect(filesErrorCode(await caught(writeText(client, input, tempDir())))).toBe(
      'changedOnServer',
    );
    fake.file('/srv/site/index.html', '<h1>hi</h1>\n', { mtimeMs: MTIME + 5000 });
    expect(filesErrorCode(await caught(writeText(client, input, tempDir())))).toBe(
      'changedOnServer',
    );
    expect(fake.callsOf('uploadFile')).toEqual([]);
    await writeText(client, { ...input, force: true }, tempDir());
    expect(fake.read('/srv/site/index.html')?.toString()).toBe('mine');
  });

  it('refuses a file deleted on the server, unless forced', async () => {
    const fake = server();
    const client = fake.connect();
    const input = { path: '/srv/gone.txt', content: 'back', bom: false, base, force: false };
    expect(filesErrorCode(await caught(writeText(client, input, tempDir())))).toBe(
      'changedOnServer',
    );
    const entry = await writeText(client, { ...input, force: true }, tempDir());
    expect(entry.mode).toBe(0o644);
    expect(fake.read('/srv/gone.txt')?.toString()).toBe('back');
  });

  it('removes the temp file when the save fails', async () => {
    const fake = server();
    fake.failNext('uploadFile', SFTP_STATUS.permissionDenied);
    const temp = tempDir('runova-edit-');
    const error = await caught(
      writeText(
        fake.connect(),
        { path: '/srv/site/index.html', content: 'x', bom: false, base, force: false },
        temp,
      ),
    );
    expect(filesErrorCode(error)).toBe('permissionDenied');
    expect(readdirSync(temp)).toEqual([]);
  });

  it('writes through a link to its target and keeps the link', async () => {
    const fake = server();
    fake.link('/srv/current.html', 'site/index.html');
    const entry = await writeText(
      fake.connect(),
      { path: '/srv/current.html', content: 'via link', bom: false, base, force: false },
      tempDir(),
    );
    expect(fake.linkTarget('/srv/current.html')).toBe('site/index.html');
    expect(fake.read('/srv/site/index.html')?.toString()).toBe('via link');
    expect(entry).toMatchObject({
      path: '/srv/current.html',
      name: 'current.html',
      isSymlink: true,
    });
  });

  it('does not call a file reached through a linked folder a link', async () => {
    const fake = server();
    fake.link('/srv/current', 'site');
    const entry = await writeText(
      fake.connect(),
      { path: '/srv/current/index.html', content: 'x', bom: false, base, force: false },
      tempDir(),
    );
    expect(entry.isSymlink).toBe(false);
    expect(fake.read('/srv/site/index.html')?.toString()).toBe('x');
  });

  it('refuses a folder and text over the limit', async () => {
    const fake = server();
    const folder = { path: '/srv/site', content: 'x', bom: false, base, force: true };
    expect(filesErrorCode(await caught(writeText(fake.connect(), folder, tempDir())))).toBe(
      'invalidInput',
    );
    const huge = {
      path: '/srv/site/index.html',
      content: 'a'.repeat(SFTP_EDIT_MAX_BYTES + 1),
      bom: false,
      base,
      force: true,
    };
    expect(filesErrorCode(await caught(writeText(fake.connect(), huge, tempDir())))).toBe(
      'tooLarge',
    );
  });
});
