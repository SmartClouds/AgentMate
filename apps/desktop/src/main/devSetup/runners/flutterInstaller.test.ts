import type { DevArch, DevOs } from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import type { CancelToken } from '../../process/spawnStreaming';
import { createFlutterInstaller, type FlutterInstallerDeps } from './flutterInstaller';
import type { ManagedKit } from './managed';
import type { RunHooks } from './packageManagerRunner';

/**
 * Installing Flutter by hand: Flutter has no winget package, so the app downloads the official
 * archive, checks it, unpacks it and puts it on the PATH. The machine is a made-up disk, so the
 * test can see the order things happen in, what gets cleaned up, and every way it can go wrong.
 */

const SHA = 'c2c875da25a1a1448d18ee4e8f398b2f6fce888b4775d8f9130538e16d826cb4';
const HASH = 'abaf9c523780a608bd46686fd5e53740a07077f8';

function manifestFor(os: 'windows' | 'macos' | 'linux' = 'windows', overrides = {}) {
  const archive =
    os === 'linux'
      ? 'stable/linux/flutter_linux_3.47.7-stable.tar.xz'
      : `stable/${os}/flutter_${os}_3.47.7-stable.zip`;
  return JSON.stringify({
    base_url: 'https://storage.googleapis.com/flutter_infra_release/releases',
    current_release: { stable: HASH },
    releases: [
      {
        hash: HASH,
        channel: 'stable',
        version: '3.47.7',
        dart_sdk_arch: 'x64',
        archive,
        sha256: SHA,
        ...overrides,
      },
    ],
  });
}

const WIN = {
  os: 'win32' as const,
  arch: 'x64' as const,
  home: 'C:\\Users\\me',
  workDir: 'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\tools\\dev-setup',
};
const ROOT = 'C:\\Users\\me\\develop\\flutter';
const STAGING = 'C:\\Users\\me\\develop\\.agentmate-flutter-abc123';
const ARCHIVE = `${WIN.workDir}\\flutter-3.47.7.zip`;
/** Where the download goes until it has finished, so a half-downloaded file never looks whole. */
const PART = `${ARCHIVE}.part`;
const FLUTTER_BAT = `${ROOT}\\bin\\flutter.bat`;

/** The machine, as far as the installer is concerned. Anything left out is the Windows default. */
interface Machine {
  os: DevOs;
  arch: DevArch;
  home: string;
  workDir: string;
}

interface Options {
  env?: Partial<Machine>;
  manifest?: string | Error;
  existing?: string[];
  emptyDirs?: string[];
  hash?: string;
  /**
   * What each check of a file's hash gives, in order (an Error is a file that cannot be read).
   * The last one is used for any further check.
   */
  hashes?: Array<string | Error>;
  downloadError?: Error;
  /** Bytes on disk each time the connection drops during the download, in order. */
  reconnects?: number[];
  /** The download never gets as far as writing a byte (a connection that is down from the start). */
  writesNothing?: boolean;
  extractResult?: { ok: boolean; message?: string };
  extractedEntry?: boolean;
  pathError?: Error;
  bootstrap?: { code: number | null; timedOut?: boolean; notFound?: boolean; cancelled?: boolean };
  cancelDuring?: 'manifest' | 'hash' | 'download' | 'extract';
}

function world(options: Options = {}) {
  const env: Machine = { ...WIN, ...options.env };
  const sep = env.os === 'win32' ? '\\' : '/';
  const disk = new Set<string>(options.existing ?? []);
  const emptyDirs = new Set<string>(options.emptyDirs ?? []);
  const calls: string[] = [];
  const token: CancelToken = { cancelled: false, child: null };
  const progress: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  let abort: (() => void) | null = null;
  let hashChecks = 0;
  const hashed: string[] = [];
  const stageDir = env.os === 'win32' ? STAGING : `${env.home}/develop/.agentmate-flutter-abc123`;
  const root = env.os === 'win32' ? ROOT : `${env.home}/develop/flutter`;
  const flutterBin = env.os === 'win32' ? FLUTTER_BAT : `${root}/bin/flutter`;

  const kit: ManagedKit = {
    ...env,
    fetchText: vi.fn(async (url: string) => {
      calls.push(`fetch:${url}`);
      if (options.cancelDuring === 'manifest') token.cancelled = true;
      if (options.manifest instanceof Error) throw options.manifest;
      return (
        options.manifest ??
        manifestFor(env.os === 'win32' ? 'windows' : env.os === 'darwin' ? 'macos' : 'linux')
      );
    }),
    download: vi.fn(async (request, hooks) => {
      calls.push(`download:${request.url}`);
      let stopped = false;
      hooks.registerAbort(() => {
        calls.push('abort-download');
        stopped = true;
      });
      abort = () => calls.push('abort-download');
      hooks.onProgress(300, 1000);
      // The first bytes are on disk from here on, whether or not the download gets to the end.
      if (!options.writesNothing) disk.add(request.destPath);
      for (const [index, onDisk] of (options.reconnects ?? []).entries()) {
        hooks.onReconnect?.(index + 1, onDisk);
        // Stopping a real download makes it throw, which is what ends the retrying.
        if (stopped) throw new Error('Download paused.');
      }
      hooks.onProgress(1000, 1000);
      if (options.cancelDuring === 'download') token.cancelled = true;
      if (options.downloadError) throw options.downloadError;
    }),
    hashFile: vi.fn(async (path, algorithm) => {
      calls.push(`hash:${algorithm}`);
      hashed.push(path);
      if (!disk.has(path)) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      if (options.cancelDuring === 'hash') token.cancelled = true;
      const turn = hashChecks++;
      if (options.hashes) {
        const result = options.hashes[Math.min(turn, options.hashes.length - 1)] ?? SHA;
        if (result instanceof Error) throw result;
        return result;
      }
      return options.hash ?? SHA;
    }),
    extract: vi.fn(async (archive, destDir) => {
      calls.push(`extract:${archive}->${destDir}`);
      if (options.cancelDuring === 'extract') token.cancelled = true;
      const result = options.extractResult ?? { ok: true };
      if (result.ok && options.extractedEntry !== false) {
        disk.add(
          `${destDir}${sep}flutter${sep}bin${sep}${env.os === 'win32' ? 'flutter.bat' : 'flutter'}`,
        );
      }
      return result;
    }),
    fs: {
      exists: vi.fn(async (path: string) => disk.has(path)),
      mkdir: vi.fn(async (path: string) => {
        calls.push(`mkdir:${path}`);
        disk.add(path);
      }),
      rm: vi.fn(async (path: string) => {
        calls.push(`rm:${path}`);
        for (const entry of [...disk]) {
          if (entry === path || entry.startsWith(`${path}${sep}`)) disk.delete(entry);
        }
      }),
      rename: vi.fn(async (from: string, to: string) => {
        calls.push(`rename:${from}->${to}`);
        for (const entry of [...disk]) {
          if (entry === from || entry.startsWith(`${from}${sep}`)) {
            disk.delete(entry);
            disk.add(`${to}${entry.slice(from.length)}`);
          }
        }
      }),
      isEmptyDir: vi.fn(async (path: string) => emptyDirs.has(path)),
    },
    randomId: () => 'abc123',
  };

  const deps: FlutterInstallerDeps = {
    kit,
    addToUserPath: vi.fn(async (dir: string) => {
      calls.push(`path:${dir}`);
      if (options.pathError) throw options.pathError;
      return { changed: true, where: 'your user PATH' };
    }),
    runCommand: vi.fn(async (command: string, args: readonly string[]) => {
      calls.push(`run:${command} ${args.join(' ')}`);
      return {
        code: 0,
        cancelled: false,
        timedOut: false,
        notFound: false,
        ...options.bootstrap,
      };
    }),
  };

  const hooks: RunHooks = {
    token,
    onCancel: (fn) => {
      abort = fn;
    },
    onProgress: (update) => progress.push(update as Record<string, unknown>),
    onLine: (line) => lines.push(line),
  };

  return {
    deps,
    hooks,
    calls,
    disk,
    hashed,
    progress,
    lines,
    token,
    stageDir,
    root,
    flutterBin,
    run: () => createFlutterInstaller(deps).run(hooks),
    update: (foundAt: string | null = null) => createFlutterInstaller(deps).update(hooks, foundAt),
    abort: () => abort?.(),
  };
}

const OK = { ok: true, code: 0, cancelled: false };

describe('a clean install', () => {
  it('does everything in order: list, download, check, unpack, move, PATH, first run', async () => {
    const w = world();

    const result = await w.run();

    expect(result).toEqual(OK);
    expect(w.calls).toEqual([
      'fetch:https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json',
      'download:https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.47.7-stable.zip',
      `rename:${PART}->${ARCHIVE}`,
      'hash:sha256',
      `mkdir:${STAGING}`,
      `extract:${ARCHIVE}->${STAGING}`,
      `rename:${STAGING}\\flutter->${ROOT}`,
      `rm:${STAGING}`,
      `rm:${ARCHIVE}`,
      `path:${ROOT}\\bin`,
      `run:${FLUTTER_BAT} --version`,
    ]);
  });

  it('unpacks beside where Flutter will live, so the final move stays on one drive', async () => {
    const w = world();

    await w.run();

    expect(w.stageDir.startsWith('C:\\Users\\me\\develop\\')).toBe(true);
    expect(w.disk.has(`${ROOT}\\bin\\flutter.bat`)).toBe(true);
    expect(w.disk.has(STAGING)).toBe(false);
  });

  it('reports each stage, with real progress while downloading', async () => {
    const w = world();

    await w.run();

    expect(w.progress).toEqual([
      { phase: 'preparing', fraction: null },
      { phase: 'downloading', fraction: 0.3, detail: '0.0 of 0.0 MB' },
      { phase: 'downloading', fraction: 1, detail: '0.0 of 0.0 MB' },
      { phase: 'verifying', fraction: null },
      { phase: 'extracting', fraction: null },
      { phase: 'installing', fraction: null },
    ]);
  });

  it('puts the commands folder on the PATH and starts Flutter once so it sets itself up', async () => {
    const w = world();

    await w.run();

    expect(w.deps.addToUserPath).toHaveBeenCalledWith(`${ROOT}\\bin`);
    expect(w.deps.runCommand).toHaveBeenCalledWith(
      FLUTTER_BAT,
      ['--version'],
      expect.objectContaining({ token: w.token }),
    );
  });

  it('names the version it is installing in the log', async () => {
    const w = world();

    await w.run();

    expect(w.lines.join('\n')).toContain('Flutter 3.47.7');
  });

  it('works the same on Linux, with a tarball', async () => {
    const w = world({
      env: {
        os: 'linux',
        arch: 'x64',
        home: '/home/me',
        workDir: '/home/me/.config/AgentMate/tools/dev-setup',
      },
    });

    const result = await w.run();

    expect(result).toEqual(OK);
    expect(w.calls).toContain(
      'download:https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.7-stable.tar.xz',
    );
    expect(w.calls).toContain(
      'rename:/home/me/develop/.agentmate-flutter-abc123/flutter->/home/me/develop/flutter',
    );
    expect(w.calls).toContain('path:/home/me/develop/flutter/bin');
    expect(w.calls).toContain('run:/home/me/develop/flutter/bin/flutter --version');
  });
});

describe('when Flutter is already there', () => {
  it('skips the download and still puts it on the PATH and sets it up', async () => {
    const w = world({ existing: [ROOT, FLUTTER_BAT] });

    const result = await w.run();

    expect(result).toEqual(OK);
    expect(w.deps.kit.fetchText).not.toHaveBeenCalled();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.calls).toEqual([`path:${ROOT}\\bin`, `run:${FLUTTER_BAT} --version`]);
  });
});

describe('an archive kept from an earlier try', () => {
  // Cancelling while it is checked, unpacked or moved keeps the finished archive. Flutter does not
  // publish a size, so asking the server to "resume" it would be answered with "nothing left to
  // send" for ever. A download only gets the archive's real name once it has finished, so a file
  // with that name is a whole one, and the checksum says whether it is still good.
  it('uses a finished one as it is, without downloading it again', async () => {
    const w = world({ existing: [ARCHIVE] });

    expect(await w.run()).toEqual(OK);

    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.calls).toEqual([
      'fetch:https://storage.googleapis.com/flutter_infra_release/releases/releases_windows.json',
      'hash:sha256',
      `mkdir:${STAGING}`,
      `extract:${ARCHIVE}->${STAGING}`,
      `rename:${STAGING}\\flutter->${ROOT}`,
      `rm:${STAGING}`,
      `rm:${ARCHIVE}`,
      `path:${ROOT}\\bin`,
      `run:${FLUTTER_BAT} --version`,
    ]);
  });

  it('shows that it is being checked rather than downloaded', async () => {
    const w = world({ existing: [ARCHIVE] });

    await w.run();

    expect(w.progress).toEqual([
      { phase: 'preparing', fraction: null },
      { phase: 'verifying', fraction: null },
      { phase: 'extracting', fraction: null },
      { phase: 'installing', fraction: null },
    ]);
    expect(w.lines.join('\n')).toContain('earlier try');
  });

  it('deletes one that does not match and downloads a fresh one', async () => {
    const w = world({ existing: [ARCHIVE], hashes: ['f'.repeat(64), SHA] });

    expect(await w.run()).toEqual(OK);

    expect(w.deps.kit.download).toHaveBeenCalledTimes(1);
    expect(w.deps.kit.download).toHaveBeenCalledWith(
      expect.objectContaining({ destPath: PART, expectedSize: null }),
      expect.anything(),
    );
    const calls = w.calls;
    expect(calls.indexOf(`rm:${ARCHIVE}`)).toBeGreaterThan(-1);
    expect(calls.indexOf(`rm:${ARCHIVE}`)).toBeLessThan(
      calls.findIndex((call) => call.startsWith('download:')),
    );
  });

  it('deletes one it cannot read, too', async () => {
    const w = world({ existing: [ARCHIVE], hashes: [new Error('EBUSY'), SHA] });

    expect(await w.run()).toEqual(OK);

    expect(w.calls).toContain(`rm:${ARCHIVE}`);
    expect(w.deps.kit.download).toHaveBeenCalledTimes(1);
  });

  it('does not leave the old one behind when the fresh download then fails', async () => {
    const w = world({
      existing: [ARCHIVE],
      hash: 'f'.repeat(64),
      downloadError: new Error('socket hang up'),
    });

    expect(await w.run()).toMatchObject({ ok: false });

    expect(w.disk.has(ARCHIVE)).toBe(false);
  });

  it('stops while it is being checked if the install is cancelled, and keeps the archive', async () => {
    const w = world({ existing: [ARCHIVE], cancelDuring: 'hash' });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
    expect(w.disk.has(ARCHIVE)).toBe(true);
  });
});

describe('a download left unfinished by an earlier try', () => {
  // The archive is downloaded as <name>.part and only renamed once it has finished, so a failed or
  // cancelled download can be told apart from a finished one by its name, which Flutter's missing
  // size would otherwise make impossible. The unfinished one carries on from where it stopped.
  it('carries on from a leftover .part instead of deleting it', async () => {
    const w = world({ existing: [PART] });

    expect(await w.run()).toEqual(OK);

    expect(w.deps.kit.download).toHaveBeenCalledTimes(1);
    expect(w.deps.kit.download).toHaveBeenCalledWith(
      expect.objectContaining({ destPath: PART, expectedSize: null }),
      expect.anything(),
    );
    expect(w.calls).not.toContain(`rm:${PART}`);
    // It is not checked before the download, since half a file would never match.
    expect(w.hashed).toEqual([ARCHIVE]);
  });

  it('gives the file its real name once the download has finished, before checking it', async () => {
    const w = world();

    await w.run();

    const download = w.calls.findIndex((call) => call.startsWith('download:'));
    const renamed = w.calls.indexOf(`rename:${PART}->${ARCHIVE}`);
    const hashed = w.calls.indexOf('hash:sha256');
    expect(download).toBeGreaterThan(-1);
    expect(renamed).toBeGreaterThan(download);
    expect(hashed).toBeGreaterThan(renamed);
    expect(w.hashed).toEqual([ARCHIVE]);
  });

  it('keeps the .part, and never gives it the real name, when the download fails', async () => {
    const w = world({ downloadError: new Error('socket hang up') });

    await w.run();

    expect(w.disk.has(PART)).toBe(true);
    expect(w.disk.has(ARCHIVE)).toBe(false);
    expect(w.calls).not.toContain(`rename:${PART}->${ARCHIVE}`);
    expect(w.calls).not.toContain(`rm:${PART}`);
  });

  it('keeps the .part, and never gives it the real name, when the download is cancelled', async () => {
    const w = world({ cancelDuring: 'download', downloadError: new Error('aborted') });

    expect(await w.run()).toMatchObject({ ok: false, cancelled: true });

    expect(w.disk.has(PART)).toBe(true);
    expect(w.disk.has(ARCHIVE)).toBe(false);
    expect(w.calls).not.toContain(`rename:${PART}->${ARCHIVE}`);
  });

  it('keeps a download that finished just as it was cancelled, under its real name', async () => {
    const w = world({ cancelDuring: 'download' });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
    expect(w.disk.has(ARCHIVE)).toBe(true);
    expect(w.disk.has(PART)).toBe(false);
    expect(w.deps.kit.hashFile).not.toHaveBeenCalled();
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
  });

  it('checks and deletes a stale archive as before, and still carries on from the .part', async () => {
    const w = world({ existing: [ARCHIVE, PART], hashes: ['f'.repeat(64), SHA] });

    expect(await w.run()).toEqual(OK);

    const download = w.calls.findIndex((call) => call.startsWith('download:'));
    expect(w.calls.indexOf(`rm:${ARCHIVE}`)).toBeGreaterThan(-1);
    expect(w.calls.indexOf(`rm:${ARCHIVE}`)).toBeLessThan(download);
    expect(w.deps.kit.download).toHaveBeenCalledWith(
      expect.objectContaining({ destPath: PART }),
      expect.anything(),
    );
    expect(w.calls).not.toContain(`rm:${PART}`);
  });

  describe('when the server will not resume it because there is nothing left to send', () => {
    // A .part that is already whole (the app was closed between the last byte and the rename, or
    // the rename was refused) is answered with "range not satisfiable" on every resume. That ends
    // the same way as a dead connection, and the checksum then says which of the two it was.
    const refused = Array.from({ length: 30 }, () => 1000);

    it('uses the .part as the finished archive if its checksum matches', async () => {
      const w = world({ existing: [PART], reconnects: refused });

      expect(await w.run()).toEqual(OK);

      expect(w.calls).toContain('abort-download');
      expect(w.calls).toContain(`rename:${PART}->${ARCHIVE}`);
      expect(w.hashed).toEqual([PART, ARCHIVE]);
      expect(w.deps.kit.extract).toHaveBeenCalled();
    });

    it('gives up with the message, and keeps the .part, if it does not match', async () => {
      const w = world({ existing: [PART], reconnects: refused, hash: 'f'.repeat(64) });

      expect(await w.run()).toEqual({
        ok: false,
        code: null,
        cancelled: false,
        message:
          'The Flutter download keeps losing its connection, so it was stopped. Check your internet connection and try again.',
      });

      expect(w.disk.has(PART)).toBe(true);
      expect(w.calls).not.toContain(`rename:${PART}->${ARCHIVE}`);
      expect(w.deps.kit.extract).not.toHaveBeenCalled();
    });

    it('has nothing to check when no bytes ever came down', async () => {
      const w = world({ reconnects: Array.from({ length: 30 }, () => 0), writesNothing: true });

      expect(await w.run()).toMatchObject({
        ok: false,
        message: expect.stringContaining('keeps losing its connection'),
      });
      expect(w.hashed).toEqual([]);
    });
  });
});

describe('a connection that drops during the download', () => {
  it('tells the row it is trying again, and carries on if the connection comes back', async () => {
    const w = world({ reconnects: [300] });

    expect(await w.run()).toEqual(OK);

    expect(w.progress).toContainEqual({
      phase: 'downloading',
      detail: 'Connection lost, retrying',
    });
    expect(w.calls).not.toContain('abort-download');
  });

  it('puts up with a few drops in a row', async () => {
    const w = world({ reconnects: [300, 300, 300] });

    expect(await w.run()).toEqual(OK);
  });

  it('keeps going for as long as each retry gets further than the last', async () => {
    const w = world({
      reconnects: Array.from({ length: 30 }, (_unused, index) => (index + 1) * 10),
    });

    expect(await w.run()).toEqual(OK);
    expect(w.calls).not.toContain('abort-download');
  });

  it('gives up with a message when it keeps dropping without getting any further', async () => {
    const w = world({ reconnects: Array.from({ length: 30 }, () => 300), hash: 'f'.repeat(64) });

    expect(await w.run()).toEqual({
      ok: false,
      code: null,
      cancelled: false,
      message:
        'The Flutter download keeps losing its connection, so it was stopped. Check your internet connection and try again.',
    });
    expect(w.calls).toContain('abort-download');
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
  });
});

describe('when something goes wrong', () => {
  it('says so when the download list cannot be reached', async () => {
    const w = world({ manifest: new Error('getaddrinfo ENOTFOUND') });

    expect(await w.run()).toMatchObject({
      ok: false,
      message:
        'Could not reach the Flutter download list. Check your internet connection and try again.',
    });
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('says so when the download list is not what was expected', async () => {
    const w = world({ manifest: '<html>Service unavailable</html>' });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'The Flutter download list was not in the expected format.',
    });
  });

  it('says so when there is no build for this computer', async () => {
    const w = world({ env: { arch: 'arm64' } });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'Flutter does not publish a build for this computer.',
    });
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('refuses a list that points somewhere else, and downloads nothing', async () => {
    const w = world({ manifest: manifestFor('windows', { archive: '../../evil/flutter.zip' }) });

    expect(await w.run()).toMatchObject({ ok: false });
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('says so when the download fails', async () => {
    const w = world({ downloadError: new Error('socket hang up') });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'The Flutter download failed. Check your internet connection and try again.',
    });
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
  });

  it('keeps a partly downloaded file after a failed download, so the next try can carry on', async () => {
    const w = world({ downloadError: new Error('socket hang up') });

    await w.run();

    expect(w.disk.has(PART)).toBe(true);
    expect(w.calls).not.toContain(`rm:${PART}`);
    expect(w.calls).not.toContain(`rm:${ARCHIVE}`);
  });

  it('deletes a download whose checksum is wrong and does not unpack it', async () => {
    const w = world({ hash: 'f'.repeat(64) });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'The download did not match its checksum, so it was deleted. Try again.',
    });
    expect(w.calls).toContain(`rm:${ARCHIVE}`);
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
  });

  it('compares checksums without minding capital letters', async () => {
    const w = world({ hash: SHA.toUpperCase() });

    expect(await w.run()).toEqual(OK);
  });

  it('cleans up the half-unpacked folder when unpacking fails', async () => {
    const w = world({ extractResult: { ok: false, message: 'Unexpected end of archive' } });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'Could not unpack Flutter. Unexpected end of archive',
    });
    expect(w.calls).toContain(`rm:${STAGING}`);
    expect(w.disk.has(ROOT)).toBe(false);
  });

  it('refuses an archive without Flutter in it, and moves nothing', async () => {
    const w = world({ extractedEntry: false });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'The Flutter archive did not contain what was expected.',
    });
    expect(w.deps.kit.fs.rename).not.toHaveBeenCalledWith(`${STAGING}\\flutter`, ROOT);
    expect(w.calls).toContain(`rm:${STAGING}`);
  });

  it('will not touch a folder it did not make', async () => {
    const w = world({ existing: [ROOT, `${ROOT}\\notes.txt`] });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: `A folder already exists at ${ROOT}. Move or remove it, then try again.`,
    });
    // Noticed before the big download, not after it.
    expect(w.deps.kit.fetchText).not.toHaveBeenCalled();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.deps.kit.fs.rename).not.toHaveBeenCalled();
    // Nothing of the person's was removed.
    expect(w.disk.has(`${ROOT}\\notes.txt`)).toBe(true);
  });

  it('replaces an empty folder that is in the way', async () => {
    const w = world({ existing: [ROOT], emptyDirs: [ROOT] });

    expect(await w.run()).toEqual(OK);
    expect(w.calls).toContain(`rm:${ROOT}`);
  });

  it('carries on if the PATH cannot be changed, since Flutter is found there anyway', async () => {
    const w = world({ pathError: new Error('Access is denied.') });

    expect(await w.run()).toEqual(OK);
    expect(w.lines.join('\n')).toContain(
      'Could not add Flutter to your PATH: Access is denied. You can add this folder yourself:',
    );
  });

  it("says so when Flutter's first run does not finish", async () => {
    const w = world({ bootstrap: { code: 1 } });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'Flutter is in place, but its first run did not finish. Open the log for details.',
    });
  });

  it('says so when its first run stops answering', async () => {
    const w = world({ bootstrap: { code: null, timedOut: true } });

    expect(await w.run()).toMatchObject({
      ok: false,
      message: 'Flutter is in place, but its first run stopped responding.',
    });
  });
});

describe('cancelling', () => {
  it('stops straight away if it was cancelled before it began', async () => {
    const w = world();
    w.token.cancelled = true;

    expect(await w.run()).toMatchObject({ ok: false, cancelled: true });
    expect(w.calls).toEqual([]);
  });

  it('stops once the download list is in, without downloading anything', async () => {
    const w = world({ cancelDuring: 'manifest' });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.deps.kit.fs.mkdir).not.toHaveBeenCalled();
  });

  it('reports a cancel, not a connection problem, if the list failed because of it', async () => {
    const w = world({ cancelDuring: 'manifest', manifest: new Error('aborted') });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
  });

  it('gives the download a way to be stopped', async () => {
    const w = world();

    await w.run();
    w.abort();

    expect(w.calls).toContain('abort-download');
  });

  it('stops after a cancelled download, without checking or unpacking it', async () => {
    const w = world({ cancelDuring: 'download', downloadError: new Error('aborted') });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
    expect(w.deps.kit.hashFile).not.toHaveBeenCalled();
  });

  it('cleans up after a cancel during unpacking', async () => {
    const w = world({ cancelDuring: 'extract' });

    const result = await w.run();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(w.calls).toContain(`rm:${STAGING}`);
    expect(w.deps.kit.fs.rename).not.toHaveBeenCalledWith(`${STAGING}\\flutter`, ROOT);
  });
});

describe('updating the Flutter that is there', () => {
  const THEIRS = 'D:\\Workspace\\Flutter SDK\\flutter';
  const THEIR_BAT = `${THEIRS}\\bin\\flutter.bat`;

  it('runs flutter upgrade from the copy that was found, and downloads nothing', async () => {
    const w = world({ existing: [THEIR_BAT, `${THEIRS}\\.git`] });

    const result = await w.update(THEIR_BAT);

    expect(result).toEqual(OK);
    expect(w.calls).toEqual([`run:${THEIR_BAT} upgrade`]);
    expect(w.deps.kit.fetchText).not.toHaveBeenCalled();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('leaves the PATH alone, since the copy is already where the person put it', async () => {
    const w = world({ existing: [THEIR_BAT, `${THEIRS}\\.git`] });

    await w.update(THEIR_BAT);

    expect(w.deps.addToUserPath).not.toHaveBeenCalled();
  });

  it('uses the copy AgentMate installed when none was named', async () => {
    const w = world({ existing: [FLUTTER_BAT, `${ROOT}\\.git`] });

    expect(await w.update()).toEqual(OK);
    expect(w.calls).toEqual([`run:${FLUTTER_BAT} upgrade`]);
  });

  it('says so, and runs nothing, for a copy with no git history to upgrade from', async () => {
    const w = world({ existing: [THEIR_BAT] });

    const result = await w.update(THEIR_BAT);

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect(result.message).toContain('not installed with git');
    expect(w.calls).toEqual([]);
  });

  it('says so when Flutter is not where it was found any more', async () => {
    const w = world();

    const result = await w.update(THEIR_BAT);

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('was not found');
    expect(w.calls).toEqual([]);
  });

  it('reports the stages and prints what it is doing', async () => {
    const w = world({ existing: [THEIR_BAT, `${THEIRS}\\.git`] });

    await w.update(THEIR_BAT);

    expect(w.progress.map((one) => one.phase)).toEqual(['preparing', 'installing']);
    expect(w.lines).toContain('Running flutter upgrade');
  });

  it('turns a failed upgrade into a sentence and points at the log', async () => {
    const w = world({ existing: [THEIR_BAT, `${THEIRS}\\.git`], bootstrap: { code: 1 } });

    const result = await w.update(THEIR_BAT);

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect(result.message).toContain('Open the log');
  });

  it('stops a flutter upgrade that goes silent', async () => {
    const w = world({
      existing: [THEIR_BAT, `${THEIRS}\\.git`],
      bootstrap: { code: null, timedOut: true },
    });

    const result = await w.update(THEIR_BAT);

    expect(result.message).toContain('stopped responding');
  });

  it('reports a cancel as a cancel, with no message', async () => {
    const w = world({
      existing: [THEIR_BAT, `${THEIRS}\\.git`],
      bootstrap: { code: null, cancelled: true },
    });

    const result = await w.update(THEIR_BAT);

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
  });

  it('does not start when it was cancelled already', async () => {
    const w = world({ existing: [THEIR_BAT, `${THEIRS}\\.git`] });
    w.token.cancelled = true;

    expect(await w.update(THEIR_BAT)).toMatchObject({ ok: false, cancelled: true });
    expect(w.calls).toEqual([]);
  });
});
