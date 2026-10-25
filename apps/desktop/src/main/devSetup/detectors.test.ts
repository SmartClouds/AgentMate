import { describe, expect, it, vi } from 'vitest';
import { createDevSetupDetector, type DetectorAndroidSdk, type DetectorDeps } from './detectors';
import type { ProbeResult } from './probe';

/**
 * Detection decides what the whole checklist says, so every kind of check is pinned here against
 * fakes: a scripted probe and an in-memory filesystem. Nothing here touches the real machine,
 * which is what lets the Windows, macOS and Linux layouts all be tested from any OS.
 */

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  const stdout = overrides.stdout ?? '';
  const stderr = overrides.stderr ?? '';
  return {
    ok: true,
    code: 0,
    stdout,
    stderr,
    output: [stdout, stderr].filter(Boolean).join('\n'),
    notFound: false,
    timedOut: false,
    error: null,
    ...overrides,
  };
}

const OK = (text: string): ProbeResult => probeResult({ stdout: text });
const MISSING: ProbeResult = probeResult({ ok: false, code: null, notFound: true });
const FAILED: ProbeResult = probeResult({ ok: false, code: 1 });

type Script = Record<string, ProbeResult | ((args: readonly string[]) => ProbeResult)>;

interface Rig {
  deps: DetectorDeps;
  probe: ReturnType<typeof vi.fn>;
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  clock: { now: number };
  sdk: { value: DetectorAndroidSdk };
  onPath: Map<string, string>;
}

const NO_SDK: DetectorAndroidSdk = {
  status: 'missing',
  root: null,
  paths: { adb: null, emulator: null, sdkmanager: null, avdmanager: null },
};

function rig(
  options: {
    os?: 'win32' | 'darwin' | 'linux';
    script?: Script;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): Rig {
  const os = options.os ?? 'win32';
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  const onPath = new Map<string, string>();
  const clock = { now: 0 };
  const sdk = { value: NO_SDK };
  const script = options.script ?? {};

  const probe = vi.fn(async (command: string, args: readonly string[]) => {
    const key = `${command} ${args.join(' ')}`.trim();
    const entry = script[key] ?? script[command];
    if (!entry) return MISSING;
    return typeof entry === 'function' ? entry(args) : entry;
  });

  const deps: DetectorDeps = {
    os,
    home: options.home ?? (os === 'win32' ? 'C:\\Users\\me' : '/home/me'),
    env: () =>
      options.env ?? {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
    probe,
    exists: async (path) => files.has(path) || dirs.has(path),
    readFile: async (path) => files.get(path) ?? null,
    listDir: async (path) => dirs.get(path) ?? [],
    findExecutable: async (command) => onPath.get(command) ?? null,
    androidSdk: async () => sdk.value,
    studioToolsDir:
      os === 'win32'
        ? 'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\studio-tools'
        : '/home/me/.config/AgentMate/studio-tools',
    now: () => clock.now,
  };
  return { deps, probe, files, dirs, clock, sdk, onPath };
}

const detect = async (r: Rig, id: string) => createDevSetupDetector(r.deps).detect(id);

describe('command detection', () => {
  it('reads the version a tool prints', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0\n') } });

    expect(await detect(r, 'node')).toEqual({
      state: 'found',
      version: '22.12.0',
      path: null,
      onPath: true,
    });
  });

  it('records where on PATH the tool was found, when it can tell', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    r.onPath.set('node', 'C:\\nodejs\\node.exe');

    expect(await detect(r, 'node')).toMatchObject({ state: 'found', path: 'C:\\nodejs\\node.exe' });
  });

  it('reads a version printed on stderr, as javac does', async () => {
    const r = rig({
      script: { 'javac -version': probeResult({ stdout: '', stderr: 'javac 17.0.12' }) },
    });

    expect(await detect(r, 'jdk17')).toMatchObject({ state: 'found', version: '17.0.12' });
  });

  it('accepts a JDK that prints only its major version', async () => {
    const r = rig({ script: { 'javac -version': OK('javac 21') } });

    expect(await detect(r, 'jdk17')).toMatchObject({ state: 'found', version: '21' });
  });

  it('reads ffmpeg from its first line, and leaves a nightly build without a version', async () => {
    const release = rig({
      script: {
        'ffmpeg -version': OK(
          'ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 14.2.0 (Rev2, Built by MSYS2 project)\n',
        ),
      },
    });
    expect(await detect(release, 'ffmpeg')).toMatchObject({ state: 'found', version: '9.0.2' });

    // A git build names no release, and the gcc version on the next line is not ffmpeg's.
    const nightly = rig({
      script: {
        'ffprobe -version': OK(
          'ffprobe version N-118221-g3f0a3b0f9e-20260101 Copyright (c) 2007-2026\nbuilt with gcc 14.2.0\n',
        ),
      },
    });
    expect(await detect(nightly, 'ffprobe')).toMatchObject({ state: 'found', version: null });
  });

  it('is absent when the command cannot be found anywhere', async () => {
    const r = rig();

    expect(await detect(r, 'node')).toEqual({ state: 'absent' });
  });

  it('is absent when the tool runs but reports failure, as dotnet does with no SDK', async () => {
    const r = rig({ script: { 'dotnet --version': FAILED } });

    expect(await detect(r, 'dotnet-sdk')).toEqual({ state: 'absent' });
  });

  it('is an error, not absent, when the probe timed out', async () => {
    const r = rig({
      script: { 'node --version': probeResult({ ok: false, code: null, timedOut: true }) },
    });

    expect(await detect(r, 'node')).toEqual({
      state: 'error',
      message: 'It did not answer in time.',
    });
  });

  it('is an error when the tool could not even start', async () => {
    const r = rig({
      script: { 'node --version': probeResult({ ok: false, code: null, error: 'spawn EACCES' }) },
    });

    expect(await detect(r, 'node')).toEqual({ state: 'error', message: 'spawn EACCES' });
  });

  it('finds a tool that is installed but not on PATH, and says so', async () => {
    const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const r = rig({ script: { [gitPath + ' --version']: OK('git version 2.55.0.windows.5') } });
    r.files.set(gitPath, '');

    expect(await detect(r, 'git')).toEqual({
      state: 'found',
      version: '2.55.0',
      path: gitPath,
      onPath: false,
    });
  });

  it('is absent when a fallback location exists but the tool there will not run', async () => {
    const gitPath = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const r = rig({ script: { [`${gitPath} --version`]: FAILED } });
    r.files.set(gitPath, '');

    expect(await detect(r, 'git')).toEqual({ state: 'absent' });
  });

  it('skips a fallback whose environment variable is not set', async () => {
    const r = rig({ env: {} });

    expect(await detect(r, 'git')).toEqual({ state: 'absent' });
  });

  it('counts an exit code of zero as the whole answer for checks with no version', async () => {
    const signedIn = rig({ script: { 'gh auth status': OK('Logged in to github.com') } });
    expect(await detect(signedIn, 'gh-auth')).toMatchObject({ state: 'found', version: null });

    const signedOut = rig({ script: { 'gh auth status': FAILED } });
    expect(await detect(signedOut, 'gh-auth')).toEqual({ state: 'absent' });
  });

  it('tells a running Docker from one that is installed but stopped', async () => {
    const running = rig({
      script: {
        'docker --version': OK('Docker version 28.4.0, build abc'),
        'docker info --format {{.ServerVersion}}': OK('28.4.0'),
      },
    });
    const detector = createDevSetupDetector(running.deps);
    expect(await detector.detect('docker-desktop')).toMatchObject({
      state: 'found',
      version: '28.4.0',
    });
    expect(await detector.detect('docker-running')).toMatchObject({
      state: 'found',
      version: '28.4.0',
    });

    const stopped = rig({
      script: {
        'docker --version': OK('Docker version 28.4.0, build abc'),
        'docker info --format {{.ServerVersion}}': FAILED,
      },
    });
    const second = createDevSetupDetector(stopped.deps);
    expect(await second.detect('docker-desktop')).toMatchObject({ state: 'found' });
    expect(await second.detect('docker-running')).toEqual({ state: 'absent' });
  });
});

describe('the macOS Git guard', () => {
  it('does not run git until the Command Line Tools are in place, since it would open a system dialog', async () => {
    const r = rig({
      os: 'darwin',
      script: { 'xcode-select -p': FAILED, 'git --version': OK('git version 2.39.5') },
    });

    expect(await detect(r, 'git')).toEqual({ state: 'absent' });
    const asked = r.probe.mock.calls.map((call) => call[0]);
    expect(asked).not.toContain('git');
  });

  it('runs git once the Command Line Tools exist', async () => {
    const r = rig({
      os: 'darwin',
      script: {
        'xcode-select -p': OK('/Library/Developer/CommandLineTools'),
        'git --version': OK('git version 2.39.5 (Apple Git-154)'),
      },
    });

    expect(await detect(r, 'git')).toMatchObject({ state: 'found', version: '2.39.5' });
  });

  it('applies the guard on macOS only', async () => {
    const r = rig({ os: 'linux', script: { 'git --version': OK('git version 2.43.0') } });

    expect(await detect(r, 'git')).toMatchObject({ state: 'found', version: '2.43.0' });
    expect(r.probe.mock.calls.map((call) => call[0])).not.toContain('xcode-select');
  });
});

describe('path detection', () => {
  it('finds Android Studio where Windows installs it', async () => {
    const r = rig();
    r.files.set('C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe', '');

    expect(await detect(r, 'android-studio')).toMatchObject({ state: 'found', onPath: true });
  });

  it('is absent when none of the locations exist', async () => {
    expect(await detect(rig(), 'android-studio')).toEqual({ state: 'absent' });
  });

  it('finds the app bundle on a Mac', async () => {
    const r = rig({ os: 'darwin', env: {} });
    r.dirs.set('/Applications/Android Studio.app', []);

    expect(await detect(r, 'android-studio')).toMatchObject({ state: 'found' });
  });
});

describe('Flutter', () => {
  it('reads the version from the SDK folder without starting Flutter', async () => {
    const r = rig();
    r.onPath.set('flutter', 'C:\\dev\\flutter\\bin\\flutter.bat');
    r.files.set(
      'C:\\dev\\flutter\\bin\\cache\\flutter.version.json',
      JSON.stringify({ frameworkVersion: '3.35.1', channel: 'stable' }),
    );

    expect(await detect(r, 'flutter')).toEqual({
      state: 'found',
      version: '3.35.1',
      path: 'C:\\dev\\flutter\\bin\\flutter.bat',
      onPath: true,
    });
    expect(r.probe).not.toHaveBeenCalled();
  });

  it('finds the copy AgentMate installs even when it is not on PATH yet', async () => {
    const r = rig();
    r.files.set('C:\\Users\\me\\develop\\flutter\\bin\\flutter.bat', '');
    r.files.set(
      'C:\\Users\\me\\develop\\flutter\\bin\\cache\\flutter.version.json',
      JSON.stringify({ frameworkVersion: '3.35.1' }),
    );

    expect(await detect(r, 'flutter')).toMatchObject({
      state: 'found',
      version: '3.35.1',
      onPath: false,
    });
  });

  it('asks Flutter itself when the version file is missing', async () => {
    const r = rig({
      script: {
        'C:\\dev\\flutter\\bin\\flutter.bat --version': OK('Flutter 3.35.1 • channel stable'),
      },
    });
    r.onPath.set('flutter', 'C:\\dev\\flutter\\bin\\flutter.bat');

    expect(await detect(r, 'flutter')).toMatchObject({ state: 'found', version: '3.35.1' });
  });

  it('is absent when there is no Flutter anywhere', async () => {
    expect(await detect(rig(), 'flutter')).toEqual({ state: 'absent' });
  });

  it('uses the unix file name off Windows', async () => {
    const r = rig({ os: 'linux' });
    r.files.set('/home/me/develop/flutter/bin/flutter', '');
    r.files.set(
      '/home/me/develop/flutter/bin/cache/flutter.version.json',
      JSON.stringify({ frameworkVersion: '3.35.1' }),
    );

    expect(await detect(r, 'flutter')).toMatchObject({ state: 'found', version: '3.35.1' });
  });
});

describe('WSL', () => {
  it('reads the version of the store build of WSL', async () => {
    const r = rig({
      script: { 'wsl --version': OK('WSL version: 2.5.9.0\nKernel version: 6.6.87.2-1') },
    });

    expect(await detect(r, 'wsl2')).toMatchObject({ state: 'found', version: '2.5.9' });
  });

  it('treats the older built-in WSL as found with no version, so it reads as out of date', async () => {
    const r = rig({
      script: {
        'wsl --version': OK('Usage: wsl.exe [Argument]'),
        'wsl --status': OK('Default Distribution: Ubuntu'),
      },
    });

    expect(await detect(r, 'wsl2')).toMatchObject({ state: 'found', version: null });
  });

  it('is absent when Windows says WSL is not installed, even if the command exits cleanly', async () => {
    const r = rig({
      script: {
        'wsl --version': OK(
          'The Windows Subsystem for Linux is not installed. You can install by running wsl.exe --install.',
        ),
        'wsl --status': OK('The Windows Subsystem for Linux is not installed.'),
      },
    });

    expect(await detect(r, 'wsl2')).toEqual({ state: 'absent' });
  });

  it('is absent when there is no wsl command', async () => {
    expect(await detect(rig(), 'wsl2')).toEqual({ state: 'absent' });
  });
});

describe('the Android SDK pieces', () => {
  const ROOT = 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk';

  function withSdk(r: Rig, paths: Partial<DetectorAndroidSdk['paths']> = {}): void {
    r.sdk.value = {
      status: 'found',
      root: ROOT,
      paths: { adb: null, emulator: null, sdkmanager: null, avdmanager: null, ...paths },
    };
  }

  it('sees nothing installed when there is no SDK yet', async () => {
    const r = rig();
    for (const id of [
      'android-cmdline-tools',
      'android-licenses',
      'android-platform-tools',
      'android-emulator',
      'android-platform',
      'android-system-image',
    ]) {
      expect(await detect(r, id), id).toEqual({ state: 'absent' });
    }
  });

  it('reports a bad SDK folder in Settings as something to fix, not as missing', async () => {
    const r = rig();
    r.sdk.value = { ...NO_SDK, status: 'override-invalid', root: 'D:\\nope' };

    const result = await detect(r, 'android-emulator');

    expect(result).toMatchObject({ state: 'error' });
    expect(result.state === 'error' && result.message).toMatch(/Settings/);
  });

  it('finds the command-line tools by sdkmanager and reads their revision', async () => {
    const r = rig();
    const sdkmanager = `${ROOT}\\cmdline-tools\\latest\\bin\\sdkmanager.bat`;
    withSdk(r, { sdkmanager });
    r.files.set(`${ROOT}\\cmdline-tools\\latest\\source.properties`, 'Pkg.Revision=19.0\n');

    expect(await detect(r, 'android-cmdline-tools')).toEqual({
      state: 'found',
      version: '19.0',
      path: sdkmanager,
      onPath: true,
    });
  });

  it('finds platform tools and the emulator from their binaries', async () => {
    const r = rig();
    withSdk(r, {
      adb: `${ROOT}\\platform-tools\\adb.exe`,
      emulator: `${ROOT}\\emulator\\emulator.exe`,
    });
    r.files.set(`${ROOT}\\platform-tools\\source.properties`, 'Pkg.Revision=36.0.0');
    r.files.set(`${ROOT}\\emulator\\source.properties`, 'Pkg.Revision=35.4.9');

    expect(await detect(r, 'android-platform-tools')).toMatchObject({
      state: 'found',
      version: '36.0.0',
    });
    expect(await detect(r, 'android-emulator')).toMatchObject({
      state: 'found',
      version: '35.4.9',
    });
  });

  it('finds the API 36 platform by its folder', async () => {
    const r = rig();
    withSdk(r);
    r.files.set(`${ROOT}\\platforms\\android-36\\android.jar`, '');
    r.files.set(`${ROOT}\\platforms\\android-36\\source.properties`, 'Pkg.Revision=2');

    expect(await detect(r, 'android-platform')).toMatchObject({ state: 'found', version: '2' });
  });

  it('is absent for a different API level', async () => {
    const r = rig();
    withSdk(r);
    r.files.set(`${ROOT}\\platforms\\android-34\\android.jar`, '');

    expect(await detect(r, 'android-platform')).toEqual({ state: 'absent' });
  });

  it('finds an emulator image of any API level, since any of them boots', async () => {
    const r = rig();
    withSdk(r);
    r.dirs.set(`${ROOT}\\system-images`, ['android-34']);
    r.dirs.set(`${ROOT}\\system-images\\android-34`, ['google_apis']);
    r.dirs.set(`${ROOT}\\system-images\\android-34\\google_apis`, ['x86_64']);
    r.files.set(
      `${ROOT}\\system-images\\android-34\\google_apis\\x86_64\\source.properties`,
      'Pkg.Revision=14',
    );

    expect(await detect(r, 'android-system-image')).toMatchObject({ state: 'found' });
  });

  it('is absent when the system-images folder is empty', async () => {
    const r = rig();
    withSdk(r);
    r.dirs.set(`${ROOT}\\system-images`, []);

    expect(await detect(r, 'android-system-image')).toEqual({ state: 'absent' });
  });

  it('reads the licenses from the accepted-license file', async () => {
    const accepted = rig();
    withSdk(accepted);
    accepted.files.set(
      `${ROOT}\\licenses\\android-sdk-license`,
      '24333f8a63b6825ea9c5514f83c2829b004d1fee\n',
    );
    expect(await detect(accepted, 'android-licenses')).toMatchObject({ state: 'found' });

    const none = rig();
    withSdk(none);
    expect(await detect(none, 'android-licenses')).toEqual({ state: 'absent' });
  });

  it('uses forward slashes on Linux', async () => {
    const r = rig({ os: 'linux' });
    r.sdk.value = {
      status: 'found',
      root: '/home/me/Android/Sdk',
      paths: { adb: null, emulator: null, sdkmanager: null, avdmanager: null },
    };
    r.files.set('/home/me/Android/Sdk/platforms/android-36/android.jar', '');

    expect(await detect(r, 'android-platform')).toMatchObject({ state: 'found' });
  });
});

describe('the detector as a whole', () => {
  it('answers from memory for ten seconds, then looks again', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);

    await detector.detect('node');
    r.clock.now = 9_000;
    await detector.detect('node');
    expect(r.probe).toHaveBeenCalledTimes(1);

    r.clock.now = 11_000;
    await detector.detect('node');
    expect(r.probe).toHaveBeenCalledTimes(2);
  });

  it('looks again straight away when forced', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);

    await detector.detect('node');
    await detector.detect('node', { force: true });

    expect(r.probe).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between callers that ask for the same item at once', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);

    const [a, b] = await Promise.all([detector.detect('node'), detector.detect('node')]);

    expect(a).toEqual(b);
    expect(r.probe).toHaveBeenCalledTimes(1);
  });

  it('never runs more than four probes at a time', async () => {
    let active = 0;
    let peak = 0;
    const r = rig();
    r.probe.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return MISSING;
    });
    const detector = createDevSetupDetector(r.deps);

    await Promise.all(
      ['git', 'node', 'npm', 'gh', 'pnpm', 'dotnet-sdk', 'jdk17', 'dart', 'docker-desktop'].map(
        (id) => detector.detect(id),
      ),
    );

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('does not deadlock when the only free slot is wanted by items that wait on a guard', async () => {
    const r = rig({
      os: 'darwin',
      script: {
        'xcode-select -p': OK('/Library/Developer/CommandLineTools'),
        'git --version': OK('git version 2.39.5'),
        'xcodebuild -version': OK('Xcode 16.0'),
      },
    });
    const detector = createDevSetupDetector({ ...r.deps, concurrency: 1 });

    const [git, xcode] = await Promise.all([detector.detect('git'), detector.detect('xcode')]);

    expect(git).toMatchObject({ state: 'found', version: '2.39.5' });
    expect(xcode).toMatchObject({ state: 'found', version: '16.0' });
  });

  it('turns an unexpected failure into an error result instead of throwing', async () => {
    const r = rig();
    r.probe.mockRejectedValue(new Error('disk on fire'));

    expect(await detect(r, 'node')).toEqual({ state: 'error', message: 'disk on fire' });
  });

  it('answers absent for an item that does not exist on this OS', async () => {
    const r = rig({ os: 'linux' });

    expect(await detect(r, 'wsl2')).toEqual({ state: 'absent' });
    expect(r.probe).not.toHaveBeenCalled();
  });

  it('refuses an id that is not in the catalog', async () => {
    expect(await detect(rig(), 'rm -rf')).toEqual({ state: 'error', message: 'Unknown item.' });
  });

  it('peek returns what is remembered and never probes', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);

    expect(detector.peek(['node', 'git'])).toEqual({ node: undefined, git: undefined });
    await detector.detect('node');
    r.probe.mockClear();

    const peeked = detector.peek(['node', 'git']);
    expect(peeked.node).toMatchObject({ state: 'found' });
    expect(peeked.git).toBeUndefined();
    expect(r.probe).not.toHaveBeenCalled();
  });

  it('peek keeps answering after the ten seconds, since a stale count beats none', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);
    await detector.detect('node');
    r.clock.now = 10 * 60_000;

    expect(detector.peek(['node']).node).toMatchObject({ state: 'found' });
  });

  it('forgets everything on invalidate', async () => {
    const r = rig({ script: { 'node --version': OK('v22.12.0') } });
    const detector = createDevSetupDetector(r.deps);
    await detector.detect('node');

    detector.invalidate();

    expect(detector.peek(['node']).node).toBeUndefined();
    await detector.detect('node');
    expect(r.probe).toHaveBeenCalledTimes(2);
  });
});

describe("Studio's local voices", () => {
  const TOOLS = 'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\studio-tools';

  it('finds Piper once its install marker and its Python are both there', async () => {
    const r = rig();
    expect(await detect(r, 'studio-piper')).toEqual({ state: 'absent' });
    r.files.set(
      `${TOOLS}\\piper.installed.json`,
      JSON.stringify({
        tool: 'piper',
        version: '1.8.0',
        installedAt: 1,
        lock: 'piper-win-x64-cpu.json',
      }),
    );
    // A marker without its environment (deleted by hand) does not count.
    expect(await detect(r, 'studio-piper')).toEqual({ state: 'absent' });
    r.files.set(`${TOOLS}\\envs\\piper\\Scripts\\python.exe`, '');
    expect(await detect(r, 'studio-piper')).toEqual({
      state: 'found',
      version: '1.8.0',
      path: `${TOOLS}\\envs\\piper\\Scripts\\python.exe`,
      onPath: true,
    });
  });

  it('finds model files only while every file the marker lists is in place, and ignores a broken marker', async () => {
    const r = rig({ os: 'linux' });
    const tools = '/home/me/.config/AgentMate/studio-tools';
    r.files.set(
      `${tools}/omnivoice-weights.installed.json`,
      JSON.stringify({
        tool: 'omnivoice-weights',
        version: null,
        installedAt: 1,
        files: [
          { path: 'model.safetensors', size: 10 },
          { path: 'audio_tokenizer/model.safetensors', size: 5 },
        ],
      }),
    );
    r.files.set(`${tools}/models/omnivoice-weights/model.safetensors`, '');
    expect(await detect(r, 'studio-omnivoice-weights')).toEqual({ state: 'absent' });
    r.files.set(`${tools}/models/omnivoice-weights/audio_tokenizer/model.safetensors`, '');
    expect(await detect(r, 'studio-omnivoice-weights')).toMatchObject({
      state: 'found',
      path: `${tools}/models/omnivoice-weights`,
    });
    r.files.set(`${tools}/piper-voices.installed.json`, '{ broken');
    expect(await detect(r, 'studio-piper-voices')).toEqual({ state: 'absent' });
  });
});
