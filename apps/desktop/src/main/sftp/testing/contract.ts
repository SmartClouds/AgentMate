import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import type { SftpDetailedEntry, SftpFileClient } from '../client';

/**
 * What every `SftpFileClient` must do (E25). The in-memory fake runs this in the unit tests and
 * the real `SshConnection` runs it against OpenSSH in Docker (sftp.int.test.ts), so the engine and
 * the service can trust the fake to answer the way a server does.
 */

/** SFTP status codes, as ssh2 puts them on `error.code`. */
const NO_SUCH_FILE = 2;
const FAILURE = 4;

export interface SftpClientSeed {
  /** Makes a folder (and its parents), with `mode` when given. */
  dir: (path: string, mode?: number) => Promise<void>;
  /** Writes a file whose parent exists. */
  file: (
    path: string,
    content: string | Buffer,
    options?: { mode?: number; mtimeMs?: number },
  ) => Promise<void>;
  /** Makes a symbolic link at `path` holding `target` as written (absolute, or relative to its folder). */
  link: (path: string, target: string) => Promise<void>;
}

export interface SftpClientHarness {
  client: SftpFileClient;
  /** An empty folder on the server for this one test: absolute, resolved, no trailing slash. */
  root: string;
  /** Puts things on the server behind the client's back. Paths are absolute. */
  seed: SftpClientSeed;
  /** Reads a file behind the client's back; null when nothing is there. */
  read: (path: string) => Promise<Buffer | null>;
  /** Runs after each test, to close the connection and remove what the test left. */
  cleanup?: () => Promise<void>;
}

export interface SftpClientContractOptions {
  /** Per test and per hook, for real servers. */
  timeoutMs?: number;
}

/** A fixed time in whole seconds, the resolution SFTP version 3 has. */
const MTIME_MS = 1_700_000_000_000;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function describeSftpClientContract(
  name: string,
  harness: () => Promise<SftpClientHarness>,
  options: SftpClientContractOptions = {},
): void {
  describe(`SftpFileClient contract: ${name}`, () => {
    let scratch = '';
    let h: SftpClientHarness;
    let counter = 0;

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), 'agentmate-sftp-contract-'));
    });
    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
    });
    beforeEach(async () => {
      h = await harness();
    }, options.timeoutMs);
    afterEach(async () => {
      await h.cleanup?.();
    }, options.timeoutMs);

    const at = (...parts: string[]): string => [h.root, ...parts].join('/');
    async function localFile(content: string | Buffer): Promise<{ path: string; bytes: Buffer }> {
      counter += 1;
      const path = join(scratch, `local-${counter}`);
      const bytes = typeof content === 'string' ? Buffer.from(content) : content;
      await writeFile(path, bytes);
      return { path, bytes };
    }
    const byName = (entries: SftpDetailedEntry[], entry: string): SftpDetailedEntry | undefined =>
      entries.find((candidate) => candidate.name === entry);
    const t = options.timeoutMs;

    it(
      'lists a folder with modes, sizes and whole-second mtimes, without . and ..',
      async () => {
        await h.seed.dir(at('site'), 0o750);
        await h.seed.file(at('index.html'), 'hello', { mode: 0o640, mtimeMs: MTIME_MS });

        const entries = await h.client.sftpListDetailed(h.root);

        expect(entries.map((entry) => entry.name).sort()).toEqual(['index.html', 'site']);
        expect(byName(entries, 'index.html')).toMatchObject({
          isFile: true,
          isDirectory: false,
          isSymlink: false,
          brokenLink: false,
          size: 5,
          mtimeMs: MTIME_MS,
          mode: 0o640,
        });
        expect(byName(entries, 'site')).toMatchObject({
          isDirectory: true,
          isFile: false,
          isSymlink: false,
          mode: 0o750,
        });
        for (const entry of entries) {
          expect(entry.longname).toContain(entry.name);
          expect(entry.mtimeMs % 1000).toBe(0);
        }
      },
      t,
    );

    it(
      'follows working links and keeps broken ones, marked',
      async () => {
        await h.seed.dir(at('real'));
        await h.seed.file(at('real', 'a.txt'), 'abc');
        await h.seed.link(at('to-dir'), at('real'));
        await h.seed.link(at('to-file'), 'real/a.txt');
        await h.seed.link(at('dangling'), at('nowhere'));

        const entries = await h.client.sftpListDetailed(h.root);

        expect(byName(entries, 'to-dir')).toMatchObject({
          isDirectory: true,
          isFile: false,
          isSymlink: true,
          brokenLink: false,
        });
        expect(byName(entries, 'to-file')).toMatchObject({
          isFile: true,
          isSymlink: true,
          brokenLink: false,
          size: 3,
        });
        expect(byName(entries, 'dangling')).toMatchObject({
          isDirectory: false,
          isFile: false,
          isSymlink: true,
          brokenLink: true,
        });
      },
      t,
    );

    it(
      'rejects a listing of a folder that is not there',
      async () => {
        await expect(h.client.sftpListDetailed(at('missing'))).rejects.toMatchObject({
          code: NO_SUCH_FILE,
        });
      },
      t,
    );

    it(
      'resolves a path with realpath',
      async () => {
        await h.seed.dir(at('a'));
        await expect(h.client.sftpRealpath(at('a', '..'))).resolves.toBe(h.root);
      },
      t,
    );

    it(
      'stats through links, and answers null for nothing or a broken link',
      async () => {
        await h.seed.file(at('f.txt'), '12345', { mode: 0o600, mtimeMs: MTIME_MS });
        await h.seed.link(at('l.txt'), at('f.txt'));
        await h.seed.link(at('broken'), at('gone'));

        await expect(h.client.sftpStat(at('f.txt'))).resolves.toEqual({
          isDirectory: false,
          isFile: true,
          size: 5,
          mtimeMs: MTIME_MS,
          mode: 0o600,
        });
        await expect(h.client.sftpStat(at('l.txt'))).resolves.toMatchObject({ size: 5 });
        await expect(h.client.sftpStat(at('nothing'))).resolves.toBeNull();
        await expect(h.client.sftpStat(at('broken'))).resolves.toBeNull();
      },
      t,
    );

    it(
      'makes a folder, and refuses one that is there or has no parent',
      async () => {
        await h.client.sftpMkdir(at('new'));
        await expect(h.client.sftpStat(at('new'))).resolves.toMatchObject({ isDirectory: true });

        await expect(h.client.sftpMkdir(at('new'))).rejects.toMatchObject({ code: FAILURE });
        await expect(h.client.sftpMkdir(at('no', 'parent'))).rejects.toMatchObject({
          code: NO_SUCH_FILE,
        });
      },
      t,
    );

    it(
      'removes only an empty folder',
      async () => {
        await h.seed.dir(at('full'));
        await h.seed.file(at('full', 'x'), 'x');
        await h.seed.dir(at('empty'));

        await expect(h.client.sftpRmdir(at('full'))).rejects.toMatchObject({ code: FAILURE });
        await h.client.sftpRmdir(at('empty'));

        await expect(h.client.sftpStat(at('full', 'x'))).resolves.not.toBeNull();
        await expect(h.client.sftpStat(at('empty'))).resolves.toBeNull();
      },
      t,
    );

    it(
      'unlinks a link itself and leaves its target',
      async () => {
        await h.seed.dir(at('target'));
        await h.seed.file(at('target', 'keep'), 'keep');
        await h.seed.link(at('link'), at('target'));

        await h.client.sftpUnlink(at('link'));

        const names = (await h.client.sftpListDetailed(h.root)).map((entry) => entry.name);
        expect(names).toEqual(['target']);
        await expect(h.read(at('target', 'keep'))).resolves.toEqual(Buffer.from('keep'));
      },
      t,
    );

    it(
      'renames, and refuses to rename onto a name that is taken',
      async () => {
        await h.seed.file(at('a'), 'A');
        await h.seed.file(at('b'), 'B');

        await expect(h.client.sftpRename(at('a'), at('b'))).rejects.toMatchObject({
          code: FAILURE,
        });
        await expect(h.read(at('a'))).resolves.toEqual(Buffer.from('A'));
        await expect(h.read(at('b'))).resolves.toEqual(Buffer.from('B'));

        await h.client.sftpRename(at('a'), at('c'));
        await expect(h.read(at('a'))).resolves.toBeNull();
        await expect(h.read(at('c'))).resolves.toEqual(Buffer.from('A'));
      },
      t,
    );

    it(
      'changes the mode',
      async () => {
        await h.seed.file(at('run.sh'), '#!/bin/sh', { mode: 0o644 });

        await h.client.sftpChmod(at('run.sh'), 0o755);

        await expect(h.client.sftpStat(at('run.sh'))).resolves.toMatchObject({ mode: 0o755 });
      },
      t,
    );

    it(
      'reads a range, short at the end of the file',
      async () => {
        await h.seed.file(at('r.bin'), '0123456789');

        await expect(h.client.sftpReadRange(at('r.bin'), 2, 3)).resolves.toEqual(
          Buffer.from('234'),
        );
        await expect(h.client.sftpReadRange(at('r.bin'), 8, 10)).resolves.toEqual(
          Buffer.from('89'),
        );
      },
      t,
    );

    it(
      'uploads a file and downloads it back, byte for byte',
      async () => {
        const bytes = Buffer.alloc(200_000);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 251;
        const source = await localFile(bytes);
        const sent: number[] = [];

        const uploaded = await h.client.uploadFile(source.path, at('blob.bin'), {
          onProgress: (sentBytes) => sent.push(sentBytes),
        });

        expect(uploaded.sha256).toBe(sha256(bytes));
        expect(uploaded.replaced).toBe(false);
        expect(uploaded.stat).toMatchObject({ isFile: true, size: bytes.length, mode: 0o644 });
        expect(sent.at(-1)).toBe(bytes.length);
        await expect(h.read(at('blob.bin'))).resolves.toEqual(bytes);

        const target = join(scratch, `download-${counter}.bin`);
        const received: [number, number][] = [];
        const downloaded = await h.client.downloadFile(at('blob.bin'), target, {
          onProgress: (got, total) => received.push([got, total]),
        });

        expect(downloaded).toMatchObject({ size: bytes.length, replaced: false });
        expect(received.at(-1)).toEqual([bytes.length, bytes.length]);
        expect(sha256(await readFile(target))).toBe(sha256(bytes));
        expect((await stat(target)).mtimeMs).toBe(downloaded.mtimeMs);
        expect((await readdir(scratch)).filter((entry) => entry.endsWith('.part'))).toEqual([]);
      },
      t,
    );

    it(
      'keeps the mode of a file an upload replaces, and replaces a local file on download',
      async () => {
        await h.seed.file(at('conf'), 'old', { mode: 0o600 });
        const source = await localFile('new contents');

        const result = await h.client.uploadFile(source.path, at('conf'));

        expect(result.replaced).toBe(true);
        expect(result.stat.mode).toBe(0o600);
        await expect(h.read(at('conf'))).resolves.toEqual(Buffer.from('new contents'));

        const target = join(scratch, `existing-${counter}`);
        await writeFile(target, 'stale');
        const downloaded = await h.client.downloadFile(at('conf'), target);
        expect(downloaded.replaced).toBe(true);
        await expect(readFile(target, 'utf-8')).resolves.toBe('new contents');
      },
      t,
    );

    it(
      'never puts bytes with the wrong hash in place',
      async () => {
        await h.seed.file(at('page.html'), 'original');
        const source = await localFile('tampered');

        const failure = await h.client
          .uploadFile(source.path, at('page.html'), { expectedSha256: 'f'.repeat(64) })
          .catch((error: unknown) => error);

        expect(filesErrorCode(failure)).toBe('localChanged');
        await expect(h.read(at('page.html'))).resolves.toEqual(Buffer.from('original'));
      },
      t,
    );

    it(
      'leaves the target alone when a transfer is cancelled before it starts',
      async () => {
        await h.seed.file(at('kept'), 'kept');
        const source = await localFile('replacement');
        const target = join(scratch, `cancelled-${counter}`);
        await writeFile(target, 'local');

        const upload = await h.client
          .uploadFile(source.path, at('kept'), { signal: AbortSignal.abort() })
          .catch((error: unknown) => error);
        const download = await h.client
          .downloadFile(at('kept'), target, { signal: AbortSignal.abort() })
          .catch((error: unknown) => error);

        expect(filesErrorCode(upload)).toBe('cancelled');
        expect(filesErrorCode(download)).toBe('cancelled');
        await expect(h.read(at('kept'))).resolves.toEqual(Buffer.from('kept'));
        await expect(readFile(target, 'utf-8')).resolves.toBe('local');
      },
      t,
    );
  });
}
