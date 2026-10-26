import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import { PART_FILE, type RemoteFiles } from './types';

/**
 * One behaviour every `RemoteFiles` must have, whatever the protocol (E23). The in-memory fake
 * runs it in unit tests, and the SFTP and FTP transports run it against real servers in Docker,
 * so the deploy run can rely on the same answers from all of them.
 */

export interface ContractHarness {
  remote: RemoteFiles;
  /** An empty folder on the server for this one test, absolute and already resolved. */
  root: string;
  /** Reads a file behind the transport's back; null when it is not there. */
  readFile: (path: string) => Promise<Buffer | null>;
  /** The permission bits of a file (0o644). Left out when the harness cannot read them. */
  modeOf?: (path: string) => Promise<number | null>;
  setMode?: (path: string, mode: number) => Promise<void>;
  /** Runs after the test, after `remote.close()`. */
  dispose?: () => Promise<void>;
}

export interface ContractOptions {
  /** Per test, for real servers. */
  timeoutMs?: number;
}

interface LocalFile {
  path: string;
  sha256: string;
  size: number;
}

export function describeRemoteFilesContract(
  name: string,
  factory: () => Promise<ContractHarness>,
  options: ContractOptions = {},
): void {
  describe(`RemoteFiles contract: ${name}`, () => {
    let scratch = '';
    let harness: ContractHarness;
    let counter = 0;

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), 'runova-remote-contract-'));
    });
    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true });
    });
    beforeEach(async () => {
      harness = await factory();
    }, options.timeoutMs);
    afterEach(async () => {
      await harness.remote.close().catch(() => undefined);
      await harness.dispose?.();
    }, options.timeoutMs);

    async function local(content: string | Buffer): Promise<LocalFile> {
      counter += 1;
      const path = join(scratch, `file-${counter}`);
      const bytes = typeof content === 'string' ? Buffer.from(content) : content;
      await writeFile(path, bytes);
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }

    async function put(remotePath: string, content: string | Buffer) {
      const file = await local(content);
      return harness.remote.putFile(file.path, remotePath, {
        sha256: file.sha256,
        size: file.size,
      });
    }

    const at = (...parts: string[]): string => [harness.root, ...parts].join('/');
    const text = async (path: string): Promise<string | null> =>
      (await harness.readFile(path))?.toString('utf8') ?? null;
    const names = async (dir: string): Promise<string[]> =>
      ((await harness.remote.list(dir)) ?? []).map((entry) => entry.name).sort();
    const partsIn = async (dir: string): Promise<string[]> =>
      (await names(dir)).filter((entry) => PART_FILE.test(entry));
    const timed = options.timeoutMs;

    it(
      'resolves the login folder and the test folder to absolute paths',
      async () => {
        expect(await harness.remote.realpath('.')).toMatch(/^\//);
        expect(await harness.remote.realpath(harness.root)).toBe(harness.root);
      },
      timed,
    );

    it(
      'reports capabilities in the expected shape',
      async () => {
        const capabilities = await harness.remote.capabilities();
        expect(typeof capabilities.atomicReplace).toBe('boolean');
        expect(['exact', 'mdtm', 'none']).toContain(capabilities.mtime);
        expect(harness.remote.maxParallel).toBeGreaterThanOrEqual(1);
      },
      timed,
    );

    it(
      'makes nested folders once, without depending on a working folder',
      async () => {
        expect(await harness.remote.ensureDir(at('a', 'b'))).toBe(true);
        expect(await harness.remote.ensureDir(at('a', 'b'))).toBe(false);
        expect(await harness.remote.ensureDir(at('c'))).toBe(true);
        expect(await harness.remote.ensureDir(harness.root)).toBe(false);

        expect(await names(harness.root)).toEqual(['a', 'c']);
        expect(await names(at('a'))).toEqual(['b']);
        expect(await harness.remote.list(at('a', 'b', 'c'))).toBeNull();
      },
      timed,
    );

    it(
      'sends a new file, readable by the web server, under its own name only',
      async () => {
        const result = await put(at('index.html'), '<h1>hello</h1>');

        expect(await text(at('index.html'))).toBe('<h1>hello</h1>');
        expect(result.stat).toMatchObject({ isDirectory: false, size: 14 });
        expect(await partsIn(harness.root)).toEqual([]);
        if (harness.modeOf) expect(await harness.modeOf(at('index.html'))).toBe(0o644);
      },
      timed,
    );

    it(
      'replaces a file and keeps its mode',
      async () => {
        await put(at('config.php'), 'old');
        await harness.setMode?.(at('config.php'), 0o600);

        const result = await put(at('config.php'), 'new contents');

        expect(await text(at('config.php'))).toBe('new contents');
        expect(result.stat.size).toBe(12);
        expect(await names(harness.root)).toEqual(['config.php']);
        if (harness.modeOf && harness.setMode) {
          expect(await harness.modeOf(at('config.php'))).toBe(0o600);
        }
      },
      timed,
    );

    it(
      'keeps the old file and leaves no temporary file when the bytes do not match the plan',
      async () => {
        await put(at('app.js'), 'old');
        const file = await local('changed after the plan');

        const failure = await harness.remote
          .putFile(file.path, at('app.js'), { sha256: 'f'.repeat(64), size: file.size })
          .catch((error: unknown) => error);

        expect(filesErrorCode(failure)).toBe('localChanged');
        expect(await text(at('app.js'))).toBe('old');
        expect(await partsIn(harness.root)).toEqual([]);
      },
      timed,
    );

    it(
      'answers null for a folder that is not there',
      async () => {
        expect(await harness.remote.list(at('missing'))).toBeNull();
        expect(await harness.remote.stat(at('missing'))).toBeNull();
      },
      timed,
    );

    it(
      'lists files and folders without . and ..',
      async () => {
        await harness.remote.ensureDir(at('css'));
        await put(at('robots.txt'), 'User-agent: *');

        const entries = await harness.remote.list(harness.root);

        expect(entries?.map((entry) => entry.name).sort()).toEqual(['css', 'robots.txt']);
        const file = entries?.find((entry) => entry.name === 'robots.txt');
        expect(file).toMatchObject({ path: at('robots.txt'), isDirectory: false, size: 13 });
        expect(entries?.find((entry) => entry.name === 'css')?.isDirectory).toBe(true);
      },
      timed,
    );

    it(
      'removes a file, and a file that is already gone is fine',
      async () => {
        await put(at('old.txt'), 'bye');

        await harness.remote.remove(at('old.txt'));
        await harness.remote.remove(at('old.txt'));

        expect(await harness.remote.stat(at('old.txt'))).toBeNull();
        expect(await text(at('old.txt'))).toBeNull();
      },
      timed,
    );

    it(
      'removes only an empty folder',
      async () => {
        await harness.remote.ensureDir(at('full'));
        await put(at('full', 'keep.txt'), 'keep');
        await harness.remote.ensureDir(at('empty'));

        expect(await harness.remote.removeEmptyDir(at('full'))).toBe(false);
        expect(await harness.remote.removeEmptyDir(at('missing'))).toBe(false);
        expect(await harness.remote.removeEmptyDir(at('empty'))).toBe(true);

        expect(await names(harness.root)).toEqual(['full']);
        expect(await text(at('full', 'keep.txt'))).toBe('keep');
      },
      timed,
    );

    it(
      'handles names with spaces and non-ASCII letters',
      async () => {
        const folder = at('sub dir é');
        const file = `${folder}/my file ü 日本.txt`;
        expect(await harness.remote.ensureDir(folder)).toBe(true);

        await put(file, 'unicode');

        expect(await names(folder)).toEqual(['my file ü 日本.txt']);
        expect(await harness.remote.stat(file)).toMatchObject({ isDirectory: false, size: 7 });
        expect(await text(file)).toBe('unicode');
        await harness.remote.remove(file);
        expect(await harness.remote.removeEmptyDir(folder)).toBe(true);
      },
      timed,
    );

    it(
      'sends a file over 1 MB intact',
      async () => {
        const bytes = randomBytes(1_500_000);
        const sent: number[] = [];
        const file = await local(bytes);

        const result = await harness.remote.putFile(file.path, at('big.bin'), {
          sha256: file.sha256,
          size: file.size,
          onBytes: (count) => sent.push(count),
        });

        expect(result.stat.size).toBe(bytes.length);
        expect((await harness.readFile(at('big.bin')))?.equals(bytes)).toBe(true);
        expect(sent.at(-1)).toBe(bytes.length);
      },
      timed,
    );

    it(
      'keeps the old file when an upload is cancelled, and goes on working after it',
      async () => {
        await put(at('bundle.js'), 'old');
        const file = await local(randomBytes(1_200_000));
        const controller = new AbortController();

        const failure = await harness.remote
          .putFile(file.path, at('bundle.js'), {
            sha256: file.sha256,
            size: file.size,
            signal: controller.signal,
            onBytes: () => controller.abort(),
          })
          .catch((error: unknown) => error);

        expect(filesErrorCode(failure)).toBe('cancelled');
        expect(await text(at('bundle.js'))).toBe('old');
        await put(at('next.txt'), 'after the cancel');
        expect(await text(at('next.txt'))).toBe('after the cancel');
      },
      timed,
    );

    it(
      'renames a file to a name nothing has',
      async () => {
        await put(at('kept.txt'), 'kept');

        await harness.remote.rename(at('kept.txt'), at('moved.txt'));

        expect(await text(at('moved.txt'))).toBe('kept');
        expect(await harness.remote.stat(at('kept.txt'))).toBeNull();
      },
      timed,
    );

    it(
      'reports the same size and time from stat as from the listing',
      async () => {
        await put(at('page.html'), 'twelve bytes');
        await harness.remote.ensureDir(at('img'));

        const entry = (await harness.remote.list(harness.root))?.find(
          (candidate) => candidate.name === 'page.html',
        );
        const stat = await harness.remote.stat(at('page.html'));
        const capabilities = await harness.remote.capabilities();

        expect(stat).toMatchObject({ isDirectory: false, size: entry?.size });
        if (entry?.mtimeMs != null) {
          expect(stat?.mtimeMs).toBe(entry.mtimeMs);
          expect(stat?.via).toBe(entry.via);
        }
        if (capabilities.mtime === 'exact') expect(entry?.mtimeMs).not.toBeNull();
        if (capabilities.mtime === 'none') expect(stat?.mtimeMs ?? null).toBeNull();
        else expect(stat?.mtimeMs).toEqual(expect.any(Number));
        expect((await harness.remote.stat(at('img')))?.isDirectory).toBe(true);
      },
      timed,
    );
  });
}
