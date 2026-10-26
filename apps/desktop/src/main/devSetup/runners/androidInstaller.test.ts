import type { SdkManagerProgress } from '@runova/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SdkManagerStreamHandlers } from '../../android/exec';
import type { ResolvedAndroidSdk } from '../../android/sdk';
import type { CancelToken } from '../../process/spawnStreaming';
import { type AndroidInstallerDeps, createAndroidInstaller } from './androidInstaller';
import type { ManagedKit } from './managed';
import type { RunHooks } from './packageManagerRunner';

/**
 * Setting up the Android SDK without Android Studio: fetch Google's command-line tools, then let
 * sdkmanager fetch the rest. The machine is faked, so the test can see the order of the steps, the
 * licence handling (a licence is only ever accepted on purpose) and the way each step ends.
 */

const SHA1 = '57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d';
const XML = `<?xml version='1.0'?>
<sdk:sdk-repository>
  <remotePackage path="cmdline-tools;latest">
    <revision><major>23</major><minor>0</minor></revision>
    <archives>
      <archive>
        <complete>
          <size>1000</size>
          <checksum type="sha1">${SHA1}</checksum>
          <url>commandlinetools-win-16111833_latest.zip</url>
        </complete>
        <host-os>windows</host-os>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>`;

const HOME = 'C:\\Users\\me';
const DEFAULT_ROOT = 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk';
const WORK = 'C:\\Users\\me\\AppData\\Roaming\\Runova\\tools\\dev-setup';
const SDKMANAGER = `${DEFAULT_ROOT}\\cmdline-tools\\latest\\bin\\sdkmanager.bat`;
const ZIP = `${WORK}\\commandlinetools-23.0.zip`;
const STAGING = `${DEFAULT_ROOT}\\.runova-cmdline-tools-abc123`;

type SdkLike = Pick<ResolvedAndroidSdk, 'status' | 'root'> & {
  paths: { sdkmanager: string | null };
};

const NO_SDK: SdkLike = { status: 'missing', root: null, paths: { sdkmanager: null } };
const WITH_TOOLS: SdkLike = {
  status: 'found',
  root: DEFAULT_ROOT,
  paths: { sdkmanager: SDKMANAGER },
};

interface Options {
  sdk?: SdkLike;
  manifest?: string | Error;
  existing?: string[];
  hash?: string;
  downloadError?: Error;
  extractResult?: { ok: boolean; message?: string };
  extractedEntry?: boolean;
  /** What sdkmanager prints (each entry is a chunk), then whether it succeeds. */
  sdkmanager?: {
    lines?: string[];
    progress?: SdkManagerProgress[];
    prompts?: string[];
    fail?: string;
  };
  /** Bytes on disk each time the connection drops during the download, in order. */
  reconnects?: number[];
  cancelDuring?: 'manifest' | 'download';
}

function world(options: Options = {}) {
  const disk = new Set<string>(options.existing ?? []);
  const calls: string[] = [];
  const token: CancelToken = { cancelled: false, child: null };
  const progress: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const answers: Array<string | undefined> = [];
  let sdk: SdkLike = options.sdk ?? NO_SDK;
  const child = { kill: vi.fn(), pid: 4242 };
  let abort: (() => void) | null = null;

  const kit: ManagedKit = {
    os: 'win32',
    arch: 'x64',
    home: HOME,
    workDir: WORK,
    fetchText: vi.fn(async (url: string) => {
      calls.push(`fetch:${url}`);
      if (options.cancelDuring === 'manifest') token.cancelled = true;
      if (options.manifest instanceof Error) throw options.manifest;
      return options.manifest ?? XML;
    }),
    download: vi.fn(async (request, hooks) => {
      calls.push(`download:${request.url}|${request.expectedSize}`);
      let stopped = false;
      hooks.registerAbort(() => {
        calls.push('abort-download');
        stopped = true;
      });
      hooks.onProgress(250, 1000);
      for (const [index, onDisk] of (options.reconnects ?? []).entries()) {
        hooks.onReconnect?.(index + 1, onDisk);
        // Stopping a real download makes it throw, which is what ends the retrying.
        if (stopped) throw new Error('Download paused.');
      }
      if (options.cancelDuring === 'download') token.cancelled = true;
      if (options.downloadError) throw options.downloadError;
      disk.add(request.destPath);
    }),
    hashFile: vi.fn(async (_path, algorithm) => {
      calls.push(`hash:${algorithm}`);
      return options.hash ?? SHA1;
    }),
    extract: vi.fn(async (archive, destDir) => {
      calls.push(`extract:${archive}->${destDir}`);
      const result = options.extractResult ?? { ok: true };
      if (result.ok && options.extractedEntry !== false) {
        disk.add(`${destDir}\\cmdline-tools\\bin\\sdkmanager.bat`);
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
          if (entry === path || entry.startsWith(`${path}\\`)) disk.delete(entry);
        }
      }),
      rename: vi.fn(async (from: string, to: string) => {
        calls.push(`rename:${from}->${to}`);
        for (const entry of [...disk]) {
          if (entry === from || entry.startsWith(`${from}\\`)) {
            disk.delete(entry);
            disk.add(`${to}${entry.slice(from.length)}`);
          }
        }
      }),
      isEmptyDir: vi.fn(async () => false),
    },
    randomId: () => 'abc123',
  };

  const deps: AndroidInstallerDeps = {
    kit,
    androidSdk: vi.fn(async () => sdk as unknown as ResolvedAndroidSdk),
    refreshAndroidSdk: vi.fn(() => {
      calls.push('refresh-sdk');
      // Once the tools are on disk, the SDK is seen as having them.
      if (disk.has(SDKMANAGER)) sdk = WITH_TOOLS;
    }),
    defaultSdkRoot: () => DEFAULT_ROOT,
    runSdkManager: vi.fn(
      async (_sdk: ResolvedAndroidSdk, args: string[], handlers: SdkManagerStreamHandlers) => {
        calls.push(`sdkmanager:${args.join(' ')}`);
        handlers.onSpawn?.(child as never);
        for (const line of options.sdkmanager?.lines ?? []) handlers.onLine?.(line);
        for (const one of options.sdkmanager?.progress ?? []) handlers.onProgress?.(one);
        for (const prompt of options.sdkmanager?.prompts ?? []) {
          answers.push(handlers.onPrompt?.(prompt));
        }
        if (options.sdkmanager?.fail) throw new Error(options.sdkmanager.fail);
      },
    ),
    killProcess: vi.fn(() => calls.push('kill-sdkmanager')),
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
    progress,
    lines,
    answers,
    token,
    child,
    installer: createAndroidInstaller(deps),
    abort: () => abort?.(),
  };
}

const OK = { ok: true, code: 0, cancelled: false };

afterEach(() => {
  vi.useRealTimers();
});

describe('the command-line tools', () => {
  it('downloads, checks, unpacks and moves them to cmdline-tools/latest in the SDK folder', async () => {
    const w = world();

    const result = await w.installer.runCmdlineTools(w.hooks);

    expect(result).toEqual(OK);
    expect(w.calls).toEqual([
      'fetch:https://dl.google.com/android/repository/repository2-3.xml',
      'download:https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip|1000',
      'hash:sha1',
      `mkdir:${STAGING}`,
      `extract:${ZIP}->${STAGING}`,
      `mkdir:${DEFAULT_ROOT}\\cmdline-tools`,
      `rename:${STAGING}\\cmdline-tools->${DEFAULT_ROOT}\\cmdline-tools\\latest`,
      `rm:${STAGING}`,
      `rm:${ZIP}`,
      'refresh-sdk',
    ]);
  });

  it('puts them in the SDK that is already there rather than making a second one', async () => {
    const w = world({
      sdk: { status: 'found', root: 'D:\\Android\\Sdk', paths: { sdkmanager: null } },
    });

    await w.installer.runCmdlineTools(w.hooks);

    expect(w.calls).toContain(
      'rename:D:\\Android\\Sdk\\.runova-cmdline-tools-abc123\\cmdline-tools->D:\\Android\\Sdk\\cmdline-tools\\latest',
    );
  });

  it('replaces an older latest folder, since it is incomplete or it would not be missing', async () => {
    const w = world({ existing: [`${DEFAULT_ROOT}\\cmdline-tools\\latest`] });

    await w.installer.runCmdlineTools(w.hooks);

    const replaced = `${DEFAULT_ROOT}\\cmdline-tools\\latest`;
    expect(w.calls.indexOf(`rm:${replaced}`)).toBeGreaterThan(-1);
    expect(w.calls.indexOf(`rm:${replaced}`)).toBeLessThan(
      w.calls.findIndex((call) => call.startsWith('rename:')),
    );
  });

  it('asks for the SDK folder to be fixed when Settings points at something that is not an SDK', async () => {
    const w = world({
      sdk: { status: 'override-invalid', root: 'D:\\nope', paths: { sdkmanager: null } },
    });

    expect(await w.installer.runCmdlineTools(w.hooks)).toMatchObject({
      ok: false,
      message: 'The Android SDK folder set in Settings is not an SDK. Fix or clear it there.',
    });
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('does nothing when they are already there', async () => {
    const w = world({ existing: [SDKMANAGER], sdk: WITH_TOOLS });

    expect(await w.installer.runCmdlineTools(w.hooks)).toEqual(OK);
    expect(w.deps.kit.download).not.toHaveBeenCalled();
  });

  it('reports the stages, with real progress while downloading', async () => {
    const w = world();

    await w.installer.runCmdlineTools(w.hooks);

    expect(w.progress).toEqual([
      { phase: 'preparing', fraction: null },
      { phase: 'downloading', fraction: 0.25, detail: '0.0 of 0.0 MB' },
      { phase: 'verifying', fraction: null },
      { phase: 'extracting', fraction: null },
    ]);
  });

  it("says so when Google's list cannot be reached or read", async () => {
    const offline = world({ manifest: new Error('ENOTFOUND') });
    expect(await offline.installer.runCmdlineTools(offline.hooks)).toMatchObject({
      ok: false,
      message:
        'Could not reach the Android download list. Check your internet connection and try again.',
    });

    const garbled = world({ manifest: '<html>Not found</html>' });
    expect(await garbled.installer.runCmdlineTools(garbled.hooks)).toMatchObject({
      ok: false,
      message: 'The Android download list was not in the expected format.',
    });
    expect(garbled.deps.kit.download).not.toHaveBeenCalled();
  });

  it('says so when the download fails, keeping what it fetched', async () => {
    const w = world({ downloadError: new Error('socket hang up') });

    expect(await w.installer.runCmdlineTools(w.hooks)).toMatchObject({
      ok: false,
      message: 'The Android tools download failed. Check your internet connection and try again.',
    });
    expect(w.calls).not.toContain(`rm:${ZIP}`);
  });

  it('deletes a download whose checksum is wrong', async () => {
    const w = world({ hash: '0'.repeat(40) });

    expect(await w.installer.runCmdlineTools(w.hooks)).toMatchObject({
      ok: false,
      message: 'The download did not match its checksum, so it was deleted. Try again.',
    });
    expect(w.calls).toContain(`rm:${ZIP}`);
    expect(w.deps.kit.extract).not.toHaveBeenCalled();
  });

  it('cleans up when unpacking fails or the archive is not what was expected', async () => {
    const bad = world({ extractResult: { ok: false, message: 'Unexpected end of archive' } });
    expect(await bad.installer.runCmdlineTools(bad.hooks)).toMatchObject({
      ok: false,
      message: 'Could not unpack the Android tools. Unexpected end of archive',
    });
    expect(bad.calls).toContain(`rm:${STAGING}`);

    const wrong = world({ extractedEntry: false });
    expect(await wrong.installer.runCmdlineTools(wrong.hooks)).toMatchObject({
      ok: false,
      message: 'The Android tools archive did not contain what was expected.',
    });
    expect(wrong.deps.kit.fs.rename).not.toHaveBeenCalled();
    expect(wrong.calls).toContain(`rm:${STAGING}`);
  });

  it('can be stopped while downloading', async () => {
    const w = world({ cancelDuring: 'download', downloadError: new Error('aborted') });

    const result = await w.installer.runCmdlineTools(w.hooks);
    w.abort();

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(w.calls).toContain('abort-download');
    expect(w.deps.kit.hashFile).not.toHaveBeenCalled();
  });

  it('does nothing if it was cancelled before it began', async () => {
    const w = world();
    w.token.cancelled = true;

    expect(await w.installer.runCmdlineTools(w.hooks)).toMatchObject({ cancelled: true });
    expect(w.calls).toEqual([]);
  });

  it('stops once the download list is in if it was cancelled meanwhile, without downloading', async () => {
    const w = world({ cancelDuring: 'manifest' });

    const result = await w.installer.runCmdlineTools(w.hooks);

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
    expect(w.deps.kit.download).not.toHaveBeenCalled();
    expect(w.deps.kit.fs.mkdir).not.toHaveBeenCalled();
  });

  it('reports a cancel, not a connection problem, if the list failed because of it', async () => {
    const w = world({ cancelDuring: 'manifest', manifest: new Error('aborted') });

    const result = await w.installer.runCmdlineTools(w.hooks);

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
  });

  it('tells the row it is trying again when the connection drops, and carries on if it returns', async () => {
    const w = world({ reconnects: [250] });

    expect(await w.installer.runCmdlineTools(w.hooks)).toEqual(OK);

    expect(w.progress).toContainEqual({
      phase: 'downloading',
      detail: 'Connection lost, retrying',
    });
    expect(w.calls).not.toContain('abort-download');
  });

  it('gives up with a message when the connection keeps dropping without getting any further', async () => {
    const w = world({ reconnects: Array.from({ length: 30 }, () => 250) });

    expect(await w.installer.runCmdlineTools(w.hooks)).toEqual({
      ok: false,
      code: null,
      cancelled: false,
      message:
        'The Android tools download keeps losing its connection, so it was stopped. Check your internet connection and try again.',
    });
    expect(w.calls).toContain('abort-download');
    expect(w.deps.kit.hashFile).not.toHaveBeenCalled();
  });

  it('keeps going for as long as each retry gets further than the last', async () => {
    const w = world({
      reconnects: Array.from({ length: 30 }, (_unused, index) => (index + 1) * 10),
    });

    expect(await w.installer.runCmdlineTools(w.hooks)).toEqual(OK);
    expect(w.calls).not.toContain('abort-download');
  });
});

describe('the licences', () => {
  it('runs sdkmanager --licenses and says yes to each one, because the person agreed first', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: { prompts: ['Accept? (y/N): ', 'Accept? (y/N): '] },
    });

    const result = await w.installer.runLicenses(w.hooks);

    expect(result).toEqual(OK);
    expect(w.calls).toContain('sdkmanager:--licenses');
    expect(w.answers).toEqual(['y\n', 'y\n']);
    expect(w.calls.at(-1)).toBe('refresh-sdk');
  });

  it('puts the licence text in the log, without the person having to read it in the row', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: { lines: ['Terms and Conditions', 'Accept? (y/N): '] },
    });

    await w.installer.runLicenses(w.hooks);

    expect(w.lines).toEqual(['Terms and Conditions', 'Accept? (y/N):']);
  });

  it('needs the command-line tools first', async () => {
    const w = world({ sdk: NO_SDK });

    expect(await w.installer.runLicenses(w.hooks)).toMatchObject({
      ok: false,
      message: 'The Android command-line tools are not installed yet.',
    });
    expect(w.deps.runSdkManager).not.toHaveBeenCalled();
  });

  it('says what sdkmanager said when it fails', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: {
        lines: ['Warning: x', 'Failed to read licenses'],
        fail: 'sdkmanager exited with 1.',
      },
    });

    expect(await w.installer.runLicenses(w.hooks)).toMatchObject({
      ok: false,
      message: 'Failed to read licenses',
    });
  });

  it('explains a missing Java in plain words', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: {
        lines: ["ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH."],
        fail: 'sdkmanager exited with 1.',
      },
    });

    expect(await w.installer.runLicenses(w.hooks)).toMatchObject({
      ok: false,
      message:
        'The Android tools need Java and could not find it. Open a new terminal or restart Runova, then try again.',
    });
  });

  it('stops the process if the install is cancelled', async () => {
    const w = world({ sdk: WITH_TOOLS });
    // The process is handed over while it runs; cancelling after that kills it.
    await w.installer.runLicenses(w.hooks);
    w.abort();

    expect(w.deps.killProcess).toHaveBeenCalledWith(w.child);
  });

  it('reports a cancel as a cancel', async () => {
    const w = world({ sdk: WITH_TOOLS, sdkmanager: { fail: 'sdkmanager exited with 1.' } });
    w.token.cancelled = true;

    expect(await w.installer.runLicenses(w.hooks)).toMatchObject({ ok: false, cancelled: true });
  });
});

describe('an SDK package', () => {
  const PACKAGE = 'system-images;android-36;google_apis;x86_64';

  it('installs it with sdkmanager, into the SDK it belongs to', async () => {
    const w = world({ sdk: WITH_TOOLS });

    const result = await w.installer.runPackage(PACKAGE, w.hooks);

    expect(result).toEqual(OK);
    expect(w.calls).toContain(`sdkmanager:--sdk_root=${DEFAULT_ROOT} ${PACKAGE}`);
    expect(w.calls.at(-1)).toBe('refresh-sdk');
  });

  it("turns sdkmanager's progress into the row's", async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: {
        progress: [
          { percent: 10, label: 'Downloading emulator' },
          { percent: 55, label: 'Downloading emulator' },
          { percent: 100, label: 'Unzipping emulator' },
        ],
      },
    });

    await w.installer.runPackage('emulator', w.hooks);

    expect(w.progress).toEqual([
      { phase: 'preparing', fraction: null },
      { phase: 'downloading', fraction: 0.1, detail: '10%' },
      { phase: 'downloading', fraction: 0.55, detail: '55%' },
      { phase: 'installing', fraction: 1, detail: '100%' },
    ]);
  });

  it('will not accept a licence the person has not agreed to', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: { prompts: ['Accept? (y/N): '], fail: 'sdkmanager exited with 1.' },
    });

    const result = await w.installer.runPackage(PACKAGE, w.hooks);

    expect(w.answers).toEqual(['n\n']);
    expect(result).toMatchObject({
      ok: false,
      message:
        'Android needs a license that has not been accepted yet. Run the Android SDK licenses step first.',
    });
  });

  it('refuses a package name that could be anything but a package', async () => {
    const w = world({ sdk: WITH_TOOLS });

    for (const bad of ['', 'emulator && calc', '../x', 'a b', '--licenses', 'x"y']) {
      expect(await w.installer.runPackage(bad, w.hooks), bad).toMatchObject({
        ok: false,
        message: 'That is not an Android SDK package.',
      });
    }
    expect(w.deps.runSdkManager).not.toHaveBeenCalled();
  });

  it('needs the command-line tools first', async () => {
    const w = world({ sdk: NO_SDK });

    expect(await w.installer.runPackage('emulator', w.hooks)).toMatchObject({
      ok: false,
      message: 'The Android command-line tools are not installed yet.',
    });
  });

  it('says what sdkmanager said when it fails', async () => {
    const w = world({
      sdk: WITH_TOOLS,
      sdkmanager: {
        lines: ['Warning: x', 'Package emulator not available'],
        fail: 'sdkmanager exited with 1.',
      },
    });

    expect(await w.installer.runPackage('emulator', w.hooks)).toMatchObject({
      ok: false,
      message: 'Package emulator not available',
    });
  });

  it('stops the process when cancelled', async () => {
    const w = world({ sdk: WITH_TOOLS });
    await w.installer.runPackage('emulator', w.hooks);
    w.abort();

    expect(w.deps.killProcess).toHaveBeenCalledWith(w.child);
  });
});

describe('a step that goes quiet', () => {
  it('stops sdkmanager after ten minutes with no output and says so', async () => {
    vi.useFakeTimers();
    const w = world({ sdk: WITH_TOOLS });
    w.deps.runSdkManager = vi.fn(
      (_sdk: ResolvedAndroidSdk, _args: string[], handlers: SdkManagerStreamHandlers) =>
        new Promise<void>((_resolve, reject) => {
          handlers.onSpawn?.(w.child as never);
          // Rejects once it has been killed, as a real process closing would.
          w.deps.killProcess = vi.fn(() => reject(new Error('sdkmanager exited with 1.')));
        }),
    );
    const installer = createAndroidInstaller(w.deps);

    const pending = installer.runPackage('emulator', w.hooks);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);

    expect(await pending).toMatchObject({
      ok: false,
      message: 'The Android tools stopped responding, so they were stopped.',
    });
  });
});
