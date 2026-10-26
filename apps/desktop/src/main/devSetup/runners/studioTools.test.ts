import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STUDIO_OMNIVOICE, STUDIO_PIPER } from '@runova/core';
import type { NvidiaGpu, PythonLock } from '@runova/studio';
import { describe, expect, it } from 'vitest';
import type { CancelToken } from '../../process/spawnStreaming';
import type { CommandResult, ManagedKit } from './managed';
import type { RunHooks } from './packageManagerRunner';
import { createStudioToolsInstaller } from './studioTools';

/**
 * Installing Studio's local voices on a made-up disk: what is downloaded, in what order, what is
 * kept for the next try, how pip is told to install, and every way it can go wrong.
 */

const ROOT = 'C:\\Users\\me\\AppData\\Roaming\\Runova\\studio-tools';
const DL = `${ROOT}\\downloads`;
const LOCKS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'studio',
  'assets',
  'tools',
  'locks',
);
const hex = (c: string) => c.repeat(64);

function lock(over: Partial<PythonLock> = {}): PythonLock {
  return {
    lockVersion: 1,
    env: 'piper',
    platform: 'win-x64',
    accelerator: 'cpu',
    module: 'piper',
    requirements: ['piper-tts==1.8.0'],
    python: {
      version: '3.12.15',
      url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-x86_64-pc-windows-msvc-install_only.tar.gz',
      size: 400,
      sha256: hex('a'),
    },
    packages: [
      {
        name: 'onnxruntime',
        version: '1.31.0',
        file: 'onnxruntime-1.31.0-cp312-cp312-win_amd64.whl',
        url: 'https://files.pythonhosted.org/packages/be/onnxruntime-1.31.0-cp312-cp312-win_amd64.whl',
        size: 100,
        sha256: hex('b'),
      },
      {
        name: 'piper-tts',
        version: '1.8.0',
        file: 'piper_tts-1.8.0-cp39-abi3-win_amd64.whl',
        url: 'https://files.pythonhosted.org/packages/12/piper_tts-1.8.0-cp39-abi3-win_amd64.whl',
        size: 500,
        sha256: hex('c'),
      },
    ],
    ...over,
  };
}

interface Options {
  os?: 'win32' | 'darwin' | 'linux';
  arch?: 'x64' | 'arm64';
  locks?: Record<string, unknown>;
  gpu?: NvidiaGpu | null;
  /** Files already on disk, by path, with the hash their content has. */
  disk?: Record<string, string>;
  /** Downloads that fail, by URL: 'drop' gives up on a dead connection, 'error' fails at once. */
  failing?: Record<string, 'drop' | 'error'>;
  /** Downloads that arrive with the wrong content. */
  corrupt?: string[];
  commands?: (command: string, args: readonly string[]) => Partial<CommandResult> | undefined;
  free?: number | null;
  cancelOn?: string;
  extractFails?: boolean;
}

function world(options: Options = {}) {
  const os = options.os ?? 'win32';
  const disk = new Map(Object.entries(options.disk ?? {}));
  const calls: string[] = [];
  const written = new Map<string, string>();
  const progress: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const token: CancelToken = { cancelled: false, child: null };
  const hashes = new Map<string, string>();
  const register = (l: PythonLock) => {
    hashes.set(l.python.url, l.python.sha256);
    for (const p of l.packages) hashes.set(p.url, p.sha256);
  };
  const locks = options.locks ?? { 'piper-win-x64-cpu.json': lock() };
  for (const value of Object.values(locks)) register(value as PythonLock);
  for (const f of [...STUDIO_PIPER.voices.flatMap((v) => v.files), ...STUDIO_OMNIVOICE.files]) {
    hashes.set(f.url, f.sha256);
  }
  const root = os === 'win32' ? ROOT : '/home/me/.config/Runova/studio-tools';

  const kit: ManagedKit = {
    os,
    arch: options.arch ?? 'x64',
    home: os === 'win32' ? 'C:\\Users\\me' : '/home/me',
    workDir: `${root}${os === 'win32' ? '\\' : '/'}work`,
    fetchText: async () => '',
    download: async (request, hooks) => {
      calls.push(`download ${request.url}`);
      if (options.cancelOn === request.url) token.cancelled = true;
      hooks.registerAbort(() => calls.push('abort'));
      hooks.onProgress(request.expectedSize ?? 0, request.expectedSize ?? 0);
      const failure = options.failing?.[request.url];
      if (failure) {
        if (!disk.has(request.destPath)) disk.set(request.destPath, 'half');
        if (failure === 'drop') for (let i = 0; i < 6; i++) hooks.onReconnect?.(i + 1, 10);
        throw new Error('connection lost');
      }
      const sha = hashes.get(request.url) ?? 'unknown';
      disk.set(request.destPath, options.corrupt?.includes(request.url) ? 'wrong' : sha);
    },
    hashFile: async (path) => {
      const value = disk.get(path);
      if (value === undefined) throw new Error('ENOENT');
      return value;
    },
    extract: async (archive, dest) => {
      calls.push(`extract ${archive}`);
      if (options.extractFails) return { ok: false, message: 'tar: bad archive' };
      const sep = os === 'win32' ? '\\' : '/';
      disk.set(`${dest}${sep}python${sep}${os === 'win32' ? 'python.exe' : 'bin/python3'}`, 'exe');
      return { ok: true };
    },
    fs: {
      exists: async (path) =>
        disk.has(path) ||
        [...disk.keys()].some((k) => k.startsWith(`${path}\\`) || k.startsWith(`${path}/`)),
      mkdir: async () => undefined,
      rm: async (path) => {
        for (const key of [...disk.keys()]) {
          if (key === path || key.startsWith(`${path}\\`) || key.startsWith(`${path}/`))
            disk.delete(key);
        }
      },
      rename: async (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        for (const key of [...disk.keys()]) {
          if (key === from || key.startsWith(`${from}\\`) || key.startsWith(`${from}/`)) {
            disk.set(to + key.slice(from.length), disk.get(key) as string);
            disk.delete(key);
          }
        }
      },
      isEmptyDir: async () => true,
    },
    randomId: () => 'x1',
  };

  const installer = createStudioToolsInstaller({
    kit,
    root,
    readLock: async (name) => {
      if (!(name in locks)) throw new Error('ENOENT');
      return locks[name];
    },
    gpu: async () => options.gpu ?? null,
    runCommand: async (command, args, opts) => {
      calls.push(`run ${command} ${args.join(' ')}`);
      expect(opts.env?.PYTHONUTF8).toBe('1');
      const answer = options.commands?.(command, args);
      if (answer?.code !== 0 && answer) opts.onLine('ERROR: something went wrong');
      return { code: 0, cancelled: false, timedOut: false, notFound: false, ...answer };
    },
    writeText: async (path, text) => {
      written.set(path, text);
      disk.set(path, 'text');
    },
    freeBytes: async () => (options.free === undefined ? 1e12 : options.free),
    now: () => 1234,
  });
  const hooks: RunHooks = {
    token,
    onProgress: (u) => progress.push(u as Record<string, unknown>),
    onLine: (l) => lines.push(l),
  };
  return { installer, hooks, calls, disk, written, progress, lines, token, root };
}

describe('installing a Studio Python environment', () => {
  it('downloads Python and every wheel, unpacks Python, and installs offline with checked hashes', async () => {
    const w = world();
    const result = await w.installer.runEnv('piper', w.hooks);
    expect(result).toEqual({ ok: true, code: 0, cancelled: false });
    const runs = w.calls
      .filter((c) => c.startsWith('run '))
      .map((c) => c.split(' ').slice(1, 6).join(' '));
    expect(runs).toEqual([
      `${ROOT}\\python\\3.12.15-win-x64\\python.exe -m venv ${ROOT}\\envs\\piper`,
      `${ROOT}\\envs\\piper\\Scripts\\python.exe -m pip install --no-index`,
      `${ROOT}\\envs\\piper\\Scripts\\python.exe -c import piper`,
    ]);
    const pip = w.calls.find((c) => c.includes(' -m pip install')) as string;
    expect(pip).toContain(
      `--require-hashes --find-links ${DL} --no-warn-script-location -r ${ROOT}\\envs\\piper\\requirements.txt`,
    );
    expect(w.written.get(`${ROOT}\\envs\\piper\\requirements.txt`)).toBe(
      `onnxruntime==1.31.0 --hash=sha256:${hex('b')}\npiper-tts==1.8.0 --hash=sha256:${hex('c')}\n`,
    );
    expect(JSON.parse(w.written.get(`${ROOT}\\piper.installed.json`) as string)).toEqual({
      tool: 'piper',
      version: '1.8.0',
      installedAt: 1234,
      lock: 'piper-win-x64-cpu.json',
    });
    // The bar counts all three files together, and the downloads go once the install has worked.
    const fractions = w.progress.filter((p) => p.phase === 'downloading').map((p) => p.fraction);
    expect(fractions).toEqual([0.4, 0.5, 1]);
    expect([...w.disk.keys()].some((k) => k.startsWith(DL))).toBe(false);
    expect(w.calls).toContain(
      `rename ${ROOT}\\python\\3.12.15-win-x64.staging-x1\\python -> ${ROOT}\\python\\3.12.15-win-x64`,
    );
  });

  it('keeps what arrived when the connection gives out, and the next try fetches only the rest (AC1)', async () => {
    const l = lock();
    const piper = l.packages[1]?.url as string;
    const first = world({ failing: { [piper]: 'drop' } });
    const failed = await first.installer.runEnv('piper', first.hooks);
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe(
      'The download of piper-tts 1.8.0 keeps losing its connection, so it was stopped. What arrived is kept; try again to carry on.',
    );
    expect(first.disk.get(`${DL}\\piper_tts-1.8.0-cp39-abi3-win_amd64.whl.part`)).toBe('half');

    // The app restarts: the same disk, a working connection.
    const disk = Object.fromEntries(first.disk);
    const second = world({ disk });
    expect((await second.installer.runEnv('piper', second.hooks)).ok).toBe(true);
    expect(second.calls.filter((c) => c.startsWith('download '))).toEqual([`download ${piper}`]);
  });

  it('throws away a file that does not match its checksum, and a whole part left by a close', async () => {
    const l = lock();
    const corrupt = world({ corrupt: [l.packages[0]?.url as string] });
    expect((await corrupt.installer.runEnv('piper', corrupt.hooks)).message).toBe(
      'onnxruntime 1.31.0 did not match its checksum, so it was deleted. Try again.',
    );
    expect(corrupt.disk.has(`${DL}\\onnxruntime-1.31.0-cp312-cp312-win_amd64.whl`)).toBe(false);

    // A .part with every byte, which the server refuses to add to: the checksum says it is whole.
    const part = `${DL}\\piper_tts-1.8.0-cp39-abi3-win_amd64.whl.part`;
    const whole = world({
      failing: { [l.packages[1]?.url as string]: 'error' },
      disk: { [part]: hex('c') },
    });
    expect((await whole.installer.runEnv('piper', whole.hooks)).ok).toBe(true);
    // A part that is not whole after a failure is a real failure, kept for the next try.
    const half = world({ failing: { [l.packages[1]?.url as string]: 'error' } });
    expect((await half.installer.runEnv('piper', half.hooks)).message).toMatch(
      /^The download of piper-tts 1\.8\.0 failed\. Check your internet connection/,
    );
  });

  it('picks the CUDA build for a new enough NVIDIA card and the processor build otherwise', async () => {
    const cuda = lock({ env: 'omnivoice', module: 'omnivoice', accelerator: 'cu128' });
    const cpu = lock({ env: 'omnivoice', module: 'omnivoice', accelerator: 'cpu' });
    const locks = { 'omnivoice-win-x64-cu128.json': cuda, 'omnivoice-win-x64-cpu.json': cpu };
    const card = { name: 'RTX 3050', driver: '610.88', memoryMiB: 4096 };
    const withCard = world({ locks, gpu: card });
    await withCard.installer.runEnv('omnivoice', withCard.hooks);
    expect(withCard.lines[0]).toMatch(/^Installing OmniVoice for win-x64 \(cu128\)/);
    const without = world({ locks });
    await without.installer.runEnv('omnivoice', without.hooks);
    expect(without.lines[0]).toMatch(/^Installing OmniVoice for win-x64: /);
    const mac = world({ locks, os: 'darwin', arch: 'x64' });
    expect((await mac.installer.runEnv('omnivoice', mac.hooks)).message).toBe(
      'OmniVoice has no build for this computer.',
    );
  });

  it('says what stops it: a missing list, no room, unpacking, pip, the import, a cancel', async () => {
    const none = world({ locks: {} });
    expect((await none.installer.runEnv('piper', none.hooks)).message).toBe(
      'The install list piper-win-x64-cpu.json is missing or damaged. Reinstall Runova.',
    );
    const full = world({ free: 1000 });
    expect((await full.installer.runEnv('piper', full.hooks)).message).toMatch(
      /^This needs about 0\.0 GB free on the drive with Runova's data/,
    );
    const tar = world({ extractFails: true });
    expect((await tar.installer.runEnv('piper', tar.hooks)).message).toBe(
      'Could not unpack Python. tar: bad archive',
    );
    const pip = world({ commands: (_c, args) => (args.includes('pip') ? { code: 1 } : undefined) });
    expect((await pip.installer.runEnv('piper', pip.hooks)).message).toBe(
      'Installing the packages failed. ERROR: something went wrong',
    );
    const stuck = world({
      commands: (_c, args) => (args[0] === '-c' ? { code: null, timedOut: true } : undefined),
    });
    expect((await stuck.installer.runEnv('piper', stuck.hooks)).message).toBe(
      'Starting piper stopped responding.',
    );
    const gone = world({
      commands: (_c, args) => (args[1] === 'venv' ? { code: null, notFound: true } : undefined),
    });
    expect((await gone.installer.runEnv('piper', gone.hooks)).message).toBe(
      'Making the environment: Python was not found where it was unpacked.',
    );
    const cancel = world({ cancelOn: lock().packages[0]?.url });
    expect((await cancel.installer.runEnv('piper', cancel.hooks)).cancelled).toBe(true);
    const early = world();
    early.token.cancelled = true;
    expect((await early.installer.runEnv('piper', early.hooks)).cancelled).toBe(true);
  });

  it('reads the real Piper lock for Windows and installs from it', async () => {
    const real = JSON.parse(
      readFileSync(join(LOCKS, 'piper-win-x64-cpu.json'), 'utf8'),
    ) as PythonLock;
    const w = world({ locks: { 'piper-win-x64-cpu.json': real } });
    expect((await w.installer.runEnv('piper', w.hooks)).ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith('download '))).toHaveLength(real.packages.length + 1);
  });
});

describe('installing model files', () => {
  it('downloads every Piper voice into its folder and lists them in the marker', async () => {
    const w = world();
    expect((await w.installer.runModels('piper-voices', w.hooks)).ok).toBe(true);
    const files = STUDIO_PIPER.voices.flatMap((v) => v.files);
    expect(w.calls.filter((c) => c.startsWith('download '))).toHaveLength(files.length);
    expect(w.disk.get(`${ROOT}\\models\\piper-voices\\fa_IR-amir-medium.onnx`)).toBe(
      files[0]?.sha256,
    );
    const marker = JSON.parse(w.written.get(`${ROOT}\\piper-voices.installed.json`) as string);
    expect(marker.files).toHaveLength(files.length);
  });

  it('puts OmniVoice files in their subfolders, and skips the ones already there', async () => {
    const tokenizer = `${ROOT}\\models\\omnivoice-weights\\audio_tokenizer\\model.safetensors`;
    const sha = STUDIO_OMNIVOICE.files.find((f) => f.path === 'audio_tokenizer/model.safetensors')
      ?.sha256 as string;
    const w = world({ disk: { [tokenizer]: sha } });
    expect((await w.installer.runModels('omnivoice-weights', w.hooks)).ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith('download '))).toHaveLength(
      STUDIO_OMNIVOICE.files.length - 1,
    );
    const linux = world({ os: 'linux' });
    await linux.installer.runModels('omnivoice-weights', linux.hooks);
    expect(
      linux.disk.has(`${linux.root}/models/omnivoice-weights/audio_tokenizer/config.json`),
    ).toBe(true);
  });
});
