import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevOs } from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import {
  type SpawnStreamingOptions,
  type SpawnStreamingResult,
  spawnStreaming,
} from '../../process/spawnStreaming';
import type { ResumableDownloadOptions } from '../../updater/resumableDownload';
import {
  assertAllowedUrl,
  createManagedKit,
  renameWithRetry,
  STUDIO_TOOL_HOSTS,
} from './managedSystem';

/**
 * The real-machine pieces under the Flutter and Android installers. Downloads and the network are
 * faked, but hashing, unpacking and the file operations run for real on a temp folder, because
 * those are where Windows paths with spaces and different archive types cause trouble.
 */

const onWindows = process.platform === 'win32';
const token = () => ({ cancelled: false, child: null });

const hostOs: DevOs = onWindows ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

function kit(
  workDir = tempDir('agentmate-managed-'),
  overrides: Partial<Parameters<typeof createManagedKit>[1]> = {},
  os: DevOs = hostOs,
) {
  const downloadRun = vi.fn<(options: ResumableDownloadOptions) => Promise<void>>(
    async () => undefined,
  );
  const abort = vi.fn();
  const netFetchText = vi.fn(async () => 'body');
  const instance = createManagedKit(
    {
      os,
      arch: 'x64',
      home: workDir,
      workDir,
    },
    {
      netFetchText,
      createDownload: () => ({ run: downloadRun, abort }),
      spawn: spawnStreaming,
      ...overrides,
    },
  );
  return { kit: instance, workDir, downloadRun, abort, netFetchText };
}

describe('assertAllowedUrl', () => {
  it.each([
    'https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json',
    'https://dl.google.com/android/repository/repository2-3.xml',
  ])('lets %s through', (url) => {
    expect(assertAllowedUrl(url).hostname).toMatch(/google/);
  });

  it.each([
    ['plain http', 'http://dl.google.com/android/repository/x.zip'],
    ['another host', 'https://evil.example/x.zip'],
    ['a look-alike host', 'https://dl.google.com.evil.example/x.zip'],
    ['a host with credentials in front', 'https://dl.google.com@evil.example/x.zip'],
    ['a file address', 'file:///C:/Windows/System32/config/SAM'],
    ['something that is not an address', 'not a url'],
  ])('refuses %s', (_label, url) => {
    expect(() => assertAllowedUrl(url)).toThrow('Refusing to download from that address.');
  });

  it("takes Studio's hosts when given them, and plain http only from a listed loopback server", () => {
    const pypi =
      'https://files.pythonhosted.org/packages/12/piper_tts-1.8.0-cp39-abi3-win_amd64.whl';
    expect(() => assertAllowedUrl(pypi)).toThrow('Refusing to download from that address.');
    expect(assertAllowedUrl(pypi, STUDIO_TOOL_HOSTS).hostname).toBe('files.pythonhosted.org');
    expect(() =>
      assertAllowedUrl('http://files.pythonhosted.org/x.whl', STUDIO_TOOL_HOSTS),
    ).toThrow();
    const test = new Set([...STUDIO_TOOL_HOSTS, '127.0.0.1']);
    expect(assertAllowedUrl('http://127.0.0.1:4100/github.com/x.tar.gz', test).port).toBe('4100');
    expect(() => assertAllowedUrl('http://127.0.0.1:4100/x', STUDIO_TOOL_HOSTS)).toThrow();
  });
});

describe('the network pieces', () => {
  it('fetches text only from an allowed address', async () => {
    const { kit: k, netFetchText } = kit();

    await expect(k.fetchText('https://evil.example/list.json')).rejects.toThrow(
      'Refusing to download from that address.',
    );
    expect(netFetchText).not.toHaveBeenCalled();

    await expect(
      k.fetchText('https://dl.google.com/android/repository/repository2-3.xml'),
    ).resolves.toBe('body');
  });

  it('downloads only from an allowed address', async () => {
    const { kit: k, downloadRun } = kit();

    await expect(
      k.download(
        {
          url: 'https://evil.example/x.zip',
          destPath: join(tempDir(), 'x.zip'),
          expectedSize: null,
        },
        { onProgress: vi.fn(), registerAbort: vi.fn() },
      ),
    ).rejects.toThrow('Refusing to download from that address.');
    expect(downloadRun).not.toHaveBeenCalled();
  });

  it('creates the folder the file goes in, passes progress up and hands over a way to stop', async () => {
    const { kit: k, downloadRun, abort } = kit();
    const dest = join(tempDir('agentmate-dl-'), 'deep', 'folder', 'x.zip');
    downloadRun.mockImplementation(
      async (options: {
        onProgress: (p: { transferred: number; total: number; bytesPerSecond: number }) => void;
      }) => {
        options.onProgress({ transferred: 5, total: 10, bytesPerSecond: 1 });
      },
    );
    const onProgress = vi.fn();
    const registerAbort = vi.fn();

    await k.download(
      { url: 'https://dl.google.com/android/repository/x.zip', destPath: dest, expectedSize: 10 },
      { onProgress, registerAbort },
    );

    expect(existsSync(join(dest, '..'))).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(5, 10);
    registerAbort.mock.calls[0]?.[0]();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(downloadRun).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://dl.google.com/android/repository/x.zip',
        destPath: dest,
        expectedSize: 10,
      }),
    );
  });

  it('tells the installer each time the connection drops and the download is retried', async () => {
    const { kit: k, downloadRun } = kit();
    downloadRun.mockImplementation(async (options) => {
      options.onReconnect(2, 4096);
    });
    const onReconnect = vi.fn();

    await k.download(
      {
        url: 'https://dl.google.com/android/repository/x.zip',
        destPath: join(tempDir('agentmate-dl-'), 'x.zip'),
        expectedSize: null,
      },
      { onProgress: vi.fn(), registerAbort: vi.fn(), onReconnect },
    );

    expect(onReconnect).toHaveBeenCalledExactlyOnceWith(2, 4096);
  });

  it('does not need anyone to be listening for dropped connections', async () => {
    const { kit: k, downloadRun } = kit();
    downloadRun.mockImplementation(async (options) => {
      options.onReconnect(1, 0);
    });

    await expect(
      k.download(
        {
          url: 'https://dl.google.com/android/repository/x.zip',
          destPath: join(tempDir('agentmate-dl-'), 'x.zip'),
          expectedSize: null,
        },
        { onProgress: vi.fn(), registerAbort: vi.fn() },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('hashFile', () => {
  it('computes SHA-1 and SHA-256 of a file', async () => {
    const dir = tempDir('agentmate-hash-');
    const file = join(dir, 'a.bin');
    writeFileSync(file, 'abc');
    const { kit: k } = kit(dir);

    expect(await k.hashFile(file, 'sha1')).toBe(createHash('sha1').update('abc').digest('hex'));
    expect(await k.hashFile(file, 'sha256')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(await k.hashFile(file, 'sha256')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('fails for a file that is not there', async () => {
    const { kit: k, workDir } = kit();

    await expect(k.hashFile(join(workDir, 'missing.bin'), 'sha1')).rejects.toThrow();
  });
});

describe('the file operations', () => {
  it('creates, checks, moves and removes folders', async () => {
    const { kit: k, workDir } = kit();
    const a = join(workDir, 'a', 'b');

    expect(await k.fs.exists(a)).toBe(false);
    await k.fs.mkdir(a);
    expect(await k.fs.exists(a)).toBe(true);
    expect(await k.fs.isEmptyDir(a)).toBe(true);

    writeFileSync(join(a, 'f.txt'), 'x');
    expect(await k.fs.isEmptyDir(a)).toBe(false);

    await k.fs.rename(join(workDir, 'a'), join(workDir, 'moved'));
    expect(existsSync(join(workDir, 'moved', 'b', 'f.txt'))).toBe(true);

    await k.fs.rm(join(workDir, 'moved'));
    expect(await k.fs.exists(join(workDir, 'moved'))).toBe(false);
  });

  it('does not mind removing something that is not there', async () => {
    const { kit: k, workDir } = kit();

    await expect(k.fs.rm(join(workDir, 'never-existed'))).resolves.toBeUndefined();
  });

  it('says a folder that does not exist is not an empty one', async () => {
    const { kit: k, workDir } = kit();

    expect(await k.fs.isEmptyDir(join(workDir, 'nope'))).toBe(false);
  });

  it('gives each caller a different short id', () => {
    const { kit: k } = kit();

    expect(k.randomId()).not.toBe(k.randomId());
    expect(k.randomId()).toMatch(/^[a-z0-9]{6,}$/);
  });
});

describe('extract', () => {
  function sampleArchive(extension: 'tar' | 'zip'): {
    archive: string;
    dest: string;
    workDir: string;
  } {
    const workDir = tempDir('agentmate-extract-');
    const source = join(workDir, 'source');
    writeTree(source, {
      'flutter/bin/flutter': 'echo flutter',
      'flutter/bin/cache/readme.txt': 'hello',
    });
    const archive = join(workDir, `sample with space.${extension}`);
    // bsdtar (Windows, macOS) picks the format from the extension with -a.
    const tar = onWindows
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    execFileSync(
      tar,
      extension === 'zip'
        ? ['-a', '-cf', archive, '-C', source, 'flutter']
        : ['-cf', archive, '-C', source, 'flutter'],
    );
    const dest = join(workDir, 'unpacked here');
    mkdirSync(dest);
    return { archive, dest, workDir };
  }

  it('unpacks a tar archive, from and into folders with spaces in their names', async () => {
    const { archive, dest, workDir } = sampleArchive('tar');
    const { kit: k } = kit(workDir);

    const result = await k.extract(archive, dest, { token: token(), onLine: vi.fn() });

    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(dest, 'flutter', 'bin', 'cache', 'readme.txt'), 'utf-8')).toBe(
      'hello',
    );
  });

  it.runIf(onWindows || process.platform === 'darwin')('unpacks a zip archive too', async () => {
    const { archive, dest, workDir } = sampleArchive('zip');
    const { kit: k } = kit(workDir);

    const result = await k.extract(archive, dest, { token: token(), onLine: vi.fn() });

    expect(result).toEqual({ ok: true });
    expect(existsSync(join(dest, 'flutter', 'bin', onWindows ? 'flutter' : 'flutter'))).toBe(true);
  });

  it('says so when the archive is not an archive', async () => {
    const workDir = tempDir('agentmate-extract-bad-');
    const archive = join(workDir, 'broken.zip');
    writeFileSync(archive, 'this is not an archive');
    const dest = join(workDir, 'out');
    mkdirSync(dest);
    const { kit: k } = kit(workDir);

    const result = await k.extract(archive, dest, { token: token(), onLine: vi.fn() });

    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });

  it('says so when the archive is missing', async () => {
    const workDir = tempDir('agentmate-extract-missing-');
    const dest = join(workDir, 'out');
    mkdirSync(dest);
    const { kit: k } = kit(workDir);

    const result = await k.extract(join(workDir, 'gone.zip'), dest, {
      token: token(),
      onLine: vi.fn(),
    });

    expect(result.ok).toBe(false);
  });
});

describe('which tool unpacks which archive', () => {
  // GNU tar, which is what Linux has, cannot read a zip. The Android command-line tools are a zip.
  const ARCHIVE = '/work/commandlinetools-23.0.zip';
  const DEST = '/sdk/.agentmate-cmdline-tools-abc123';
  const FINISHED: SpawnStreamingResult = {
    code: 0,
    log: '',
    timedOut: false,
    cancelled: false,
    notFound: false,
  };

  /** A spawn that records what it was asked to run. `missing` lists commands that are not installed. */
  function fakeSpawn(
    missing: string[] = [],
    run: (options: SpawnStreamingOptions) => Partial<SpawnStreamingResult> = () => ({}),
  ) {
    return vi.fn(async (options: SpawnStreamingOptions): Promise<SpawnStreamingResult> => {
      if (missing.includes(options.command)) return { ...FINISHED, code: null, notFound: true };
      return { ...FINISHED, ...run(options) };
    });
  }

  const extract = (os: DevOs, spawn: ReturnType<typeof fakeSpawn>, archive = ARCHIVE) =>
    kit('/work', { spawn }, os).kit.extract(archive, DEST, { token: token(), onLine: vi.fn() });

  const commandsRun = (spawn: ReturnType<typeof fakeSpawn>) =>
    spawn.mock.calls.map(([options]) => [options.command, ...options.args]);

  it('unpacks a zip on Linux with unzip', async () => {
    const spawn = fakeSpawn();

    expect(await extract('linux', spawn)).toEqual({ ok: true });

    expect(commandsRun(spawn)).toEqual([['unzip', '-q', ARCHIVE, '-d', DEST]]);
  });

  it('does not mind the capital letters in .ZIP', async () => {
    const spawn = fakeSpawn();

    await extract('linux', spawn, '/work/TOOLS.ZIP');

    expect(commandsRun(spawn)[0]?.[0]).toBe('unzip');
  });

  it('falls back to bsdtar for a zip on Linux when there is no unzip', async () => {
    const spawn = fakeSpawn(['unzip']);

    expect(await extract('linux', spawn)).toEqual({ ok: true });

    expect(commandsRun(spawn)).toEqual([
      ['unzip', '-q', ARCHIVE, '-d', DEST],
      ['bsdtar', '-xf', ARCHIVE, '-C', DEST],
    ]);
  });

  it('says what to install when a zip on Linux has neither unzip nor bsdtar', async () => {
    const spawn = fakeSpawn(['unzip', 'bsdtar']);

    expect(await extract('linux', spawn)).toEqual({
      ok: false,
      message: 'Install unzip (for example sudo apt install unzip) and try again.',
    });
  });

  it('reports what unzip said when it fails', async () => {
    const spawn = fakeSpawn([], (options) => {
      options.onLine?.('End-of-central-directory signature not found.');
      return { code: 9 };
    });
    const onLine = vi.fn();

    const result = await kit('/work', { spawn }, 'linux').kit.extract(ARCHIVE, DEST, {
      token: token(),
      onLine,
    });

    expect(commandsRun(spawn)[0]?.[0]).toBe('unzip');
    expect(result).toEqual({ ok: false, message: 'End-of-central-directory signature not found.' });
    expect(onLine).toHaveBeenCalledWith('End-of-central-directory signature not found.');
  });

  it('says so when unzip stops with nothing to show for it', async () => {
    const spawn = fakeSpawn([], () => ({ code: 3 }));

    expect(await extract('linux', spawn)).toEqual({
      ok: false,
      message: 'unzip stopped with code 3.',
    });
  });

  it('does not try bsdtar when unzip ran and failed', async () => {
    const spawn = fakeSpawn([], () => ({ code: 3 }));

    await extract('linux', spawn);

    expect(commandsRun(spawn).map(([command]) => command)).toEqual(['unzip']);
  });

  it.each([
    ['win32', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')],
    ['darwin', 'tar'],
  ] as const)('still unpacks a zip on %s with the system tar', async (os, tar) => {
    const spawn = fakeSpawn();

    expect(await extract(os, spawn)).toEqual({ ok: true });

    expect(commandsRun(spawn)).toEqual([[tar, '-xf', ARCHIVE, '-C', DEST]]);
  });

  it.each(['/work/flutter_linux.tar.xz', '/work/sample.tar'])(
    'unpacks the tarball %s on Linux with tar',
    async (archive) => {
      const spawn = fakeSpawn();

      expect(await extract('linux', spawn, archive)).toEqual({ ok: true });

      expect(commandsRun(spawn)).toEqual([['tar', '-xf', archive, '-C', DEST]]);
    },
  );

  it('says so when there is no tar to unpack a tarball with', async () => {
    const spawn = fakeSpawn(['tar']);

    expect(await extract('linux', spawn, '/work/flutter_linux.tar.xz')).toEqual({
      ok: false,
      message: 'The tar command was not found.',
    });
  });
});

describe('renameWithRetry', () => {
  // A virus scanner or the search indexer can hold a freshly unpacked folder for a moment on
  // Windows, and the move then fails with a permission or busy error that goes away by itself.
  const problem = (code: string) =>
    Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  const mover = () => vi.fn<(from: string, to: string) => Promise<void>>(async () => undefined);
  const noWait = () => vi.fn(async (_ms: number) => undefined);

  it('moves straight away when nothing is in the way', async () => {
    const rename = mover();
    const wait = noWait();

    await renameWithRetry('from', 'to', { rename, wait });

    expect(rename).toHaveBeenCalledExactlyOnceWith('from', 'to');
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EBUSY'])('tries again after %s and succeeds', async (code) => {
    const rename = mover();
    rename.mockRejectedValueOnce(problem(code)).mockRejectedValueOnce(problem(code));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).resolves.toBeUndefined();

    expect(rename).toHaveBeenCalledTimes(3);
    expect(rename).toHaveBeenLastCalledWith('from', 'to');
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('waits a little longer after each failed try', async () => {
    const rename = mover();
    rename
      .mockRejectedValueOnce(problem('EPERM'))
      .mockRejectedValueOnce(problem('EPERM'))
      .mockRejectedValueOnce(problem('EBUSY'));
    const wait = noWait();

    await renameWithRetry('from', 'to', { rename, wait });

    const delays = wait.mock.calls.map(([ms]) => ms);
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
  });

  it('gives up after a few tries and throws the last problem', async () => {
    const rename = mover();
    rename.mockRejectedValue(problem('EPERM'));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).rejects.toThrow('EPERM');

    expect(rename.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(rename.mock.calls.length).toBeLessThanOrEqual(8);
    expect(wait).toHaveBeenCalledTimes(rename.mock.calls.length - 1);
  });

  it('does not retry a problem that waiting would not fix', async () => {
    const rename = mover();
    rename.mockRejectedValue(problem('ENOENT'));
    const wait = noWait();

    await expect(renameWithRetry('from', 'to', { rename, wait })).rejects.toThrow('ENOENT');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
});
