import {
  STUDIO_OMNIVOICE,
  STUDIO_PIPER,
  type StudioModelFile,
  type StudioToolId,
} from '@runova/core';
import {
  acceleratorFor,
  lockBytes,
  lockFileName,
  type NvidiaGpu,
  type PythonLock,
  pythonLockSchema,
  requirementsText,
  type StudioEnvId,
  studioPlatform,
  studioToolPaths,
} from '@runova/studio';
import type { CancelToken } from '../../process/spawnStreaming';
import { type CommandResult, createDownloadHooks, type ManagedKit } from './managed';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * Installs Studio's local voices (E37) into the app's own folder: a Python environment per engine
 * from its lock file, and the model files the engines speak with. Built for a slow connection that
 * drops: every file downloads to a `.part` that the next try carries on from, survives the app
 * closing, and is checked against its SHA-256 before use. pip then installs offline, from those
 * files only, with `--require-hashes`, so nothing runs that was not locked.
 *
 * Everything that touches the machine is injected, so each step and each way out is tested with a
 * made-up disk.
 */

export interface StudioToolsDeps {
  kit: ManagedKit;
  /** `<userData>/studio-tools`. */
  root: string;
  /** A lock file's contents by name, from Studio's assets. */
  readLock: (name: string) => Promise<unknown>;
  gpu: () => Promise<NvidiaGpu | null>;
  runCommand: (
    command: string,
    args: readonly string[],
    options: {
      token: CancelToken;
      onLine: (line: string) => void;
      idleMs: number;
      env?: Record<string, string>;
    },
  ) => Promise<CommandResult>;
  writeText: (path: string, text: string) => Promise<void>;
  /** Free bytes on the drive holding `path`, or null when that cannot be told. */
  freeBytes: (path: string) => Promise<number | null>;
  now: () => number;
  /** Where to fetch an artifact from instead (the e2e fake server). */
  mapUrl?: (url: string) => string;
}

const CANCELLED: RunResult = { ok: false, code: null, cancelled: true };
const fail = (message: string): RunResult => ({ ok: false, code: null, cancelled: false, message });
/** Installing PyTorch unpacks gigabytes and can print nothing for a long time. */
const PIP_IDLE_MS = 30 * 60_000;
const CHECK_IDLE_MS = 5 * 60_000;
/** Downloads, the unpacked environment and room to spare. */
const DISK_FACTOR = 3;

/** Python that speaks UTF-8 whatever the system's code page, and never asks anything. */
const PYTHON_ENV = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONNOUSERSITE: '1',
  PIP_NO_INPUT: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};

interface Artifact {
  url: string;
  size: number;
  sha256: string;
  /** Where it goes. */
  dest: string;
  label: string;
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

export function createStudioToolsInstaller(deps: StudioToolsDeps): {
  runEnv: (env: StudioEnvId, hooks: RunHooks) => Promise<RunResult>;
  runModels: (target: 'piper-voices' | 'omnivoice-weights', hooks: RunHooks) => Promise<RunResult>;
} {
  const { kit } = deps;
  const sep = kit.os === 'win32' ? '\\' : '/';
  const paths = studioToolPaths(deps.root, kit.os);

  async function isWhole(path: string, sha256: string): Promise<boolean> {
    try {
      return (await kit.hashFile(path, 'sha256')).toLowerCase() === sha256;
    } catch {
      return false;
    }
  }

  /**
   * Gets every artifact onto the disk, checked. One already there and whole is kept, so a second
   * try (or a try after the app restarted) fetches only what is missing. Null means all are there.
   */
  async function fetchAll(items: Artifact[], hooks: RunHooks): Promise<RunResult | null> {
    const total = items.reduce((sum, item) => sum + item.size, 0);
    let before = 0;
    for (const item of items) {
      if (hooks.token.cancelled) return CANCELLED;
      if ((await kit.fs.exists(item.dest)) && (await isWhole(item.dest, item.sha256))) {
        before += item.size;
        continue;
      }
      await kit.fs.rm(item.dest);
      const part = `${item.dest}.part`;
      const download = createDownloadHooks(hooks, { before, total });
      try {
        await kit.download(
          { url: deps.mapUrl?.(item.url) ?? item.url, destPath: part, expectedSize: item.size },
          download.hooks,
        );
      } catch {
        if (hooks.token.cancelled) return CANCELLED;
        // A part file that is already whole (the app closed after the last byte) is answered with
        // "nothing left to send" until the download gives up; the checksum tells the two apart.
        const whole = (await kit.fs.exists(part)) && (await isWhole(part, item.sha256));
        if (!whole) {
          return fail(
            download.gaveUp()
              ? `The download of ${item.label} keeps losing its connection, so it was stopped. What arrived is kept; try again to carry on.`
              : `The download of ${item.label} failed. Check your internet connection and try again; what arrived is kept.`,
          );
        }
      }
      await kit.fs.rename(part, item.dest);
      hooks.onProgress({ phase: 'verifying', fraction: null });
      if (!(await isWhole(item.dest, item.sha256))) {
        await kit.fs.rm(item.dest);
        return fail(`${item.label} did not match its checksum, so it was deleted. Try again.`);
      }
      before += item.size;
    }
    return null;
  }

  async function roomFor(bytes: number): Promise<RunResult | null> {
    const free = await deps.freeBytes(deps.root);
    if (free !== null && free < bytes * DISK_FACTOR) {
      return fail(
        `This needs about ${gigabytes(bytes * DISK_FACTOR)} free on the drive with Runova's data, and there is ${gigabytes(free)}.`,
      );
    }
    return null;
  }

  async function run(
    command: string,
    args: string[],
    hooks: RunHooks,
    idleMs: number,
    what: string,
  ): Promise<RunResult | null> {
    let last = '';
    const result = await deps.runCommand(command, args, {
      token: hooks.token,
      idleMs,
      env: PYTHON_ENV,
      onLine: (line) => {
        last = line.trim() || last;
        hooks.onLine(line);
      },
    });
    if (result.cancelled || hooks.token.cancelled) return CANCELLED;
    if (result.notFound) return fail(`${what}: Python was not found where it was unpacked.`);
    if (result.timedOut) return fail(`${what} stopped responding.`);
    if (result.code !== 0) return fail(`${what} failed. ${last}`.trim());
    return null;
  }

  async function pickLock(env: StudioEnvId): Promise<PythonLock | RunResult> {
    const platform = studioPlatform(kit.os, kit.arch);
    const accel = platform ? acceleratorFor(env, platform, await deps.gpu()) : null;
    if (!platform || !accel) {
      return fail(`${env === 'piper' ? 'Piper' : 'OmniVoice'} has no build for this computer.`);
    }
    const name = lockFileName(env, platform, accel);
    try {
      return pythonLockSchema.parse(await deps.readLock(name));
    } catch {
      return fail(`The install list ${name} is missing or damaged. Reinstall Runova.`);
    }
  }

  async function runEnv(env: StudioEnvId, hooks: RunHooks): Promise<RunResult> {
    if (hooks.token.cancelled) return CANCELLED;
    hooks.onProgress({ phase: 'preparing', fraction: null });
    const picked = await pickLock(env);
    if (!('packages' in picked)) return picked;
    const lock = picked;
    const name = lockFileName(lock.env, lock.platform, lock.accelerator);
    hooks.onLine(
      `Installing ${env === 'piper' ? 'Piper' : 'OmniVoice'} for ${lock.platform}${lock.accelerator === 'cpu' ? '' : ` (${lock.accelerator})`}: ${gigabytes(lockBytes(lock))} to download.`,
    );
    const noRoom = await roomFor(lockBytes(lock));
    if (noRoom) return noRoom;

    await kit.fs.mkdir(paths.downloads);
    const pythonFile = decodeURIComponent(lock.python.url.split('/').pop() ?? 'python.tar.gz');
    const artifacts: Artifact[] = [
      {
        ...lock.python,
        dest: `${paths.downloads}${sep}${pythonFile}`,
        label: `Python ${lock.python.version}`,
      },
      ...lock.packages.map((p) => ({
        url: p.url,
        size: p.size,
        sha256: p.sha256,
        dest: `${paths.downloads}${sep}${p.file}`,
        label: `${p.name} ${p.version}`,
      })),
    ];
    const missing = await fetchAll(artifacts, hooks);
    if (missing) return missing;

    // The Python build, unpacked once per version beside the environments that use it.
    const pythonDir = paths.pythonDir(lock.python.version, lock.platform);
    const basePython = paths.basePython(pythonDir);
    if (!(await kit.fs.exists(basePython))) {
      hooks.onProgress({ phase: 'extracting', fraction: null });
      const staging = `${pythonDir}.staging-${kit.randomId()}`;
      await kit.fs.mkdir(staging);
      try {
        const unpacked = await kit.extract(artifacts[0]?.dest as string, staging, {
          token: hooks.token,
          onLine: hooks.onLine,
        });
        if (hooks.token.cancelled) return CANCELLED;
        if (!unpacked.ok) return fail(`Could not unpack Python. ${unpacked.message ?? ''}`.trim());
        await kit.fs.rm(pythonDir);
        await kit.fs.rename(`${staging}${sep}python`, pythonDir);
      } finally {
        await kit.fs.rm(staging);
      }
    }

    hooks.onProgress({ phase: 'installing', fraction: null });
    const envDir = paths.envDir(env);
    await kit.fs.rm(paths.marker(env));
    await kit.fs.rm(envDir);
    const venv = await run(
      basePython,
      ['-m', 'venv', envDir],
      hooks,
      CHECK_IDLE_MS,
      'Making the environment',
    );
    if (venv) return venv;
    const requirements = `${envDir}${sep}requirements.txt`;
    await deps.writeText(requirements, requirementsText(lock));
    const envPython = paths.envPython(env);
    const pip = await run(
      envPython,
      [
        '-m',
        'pip',
        'install',
        '--no-index',
        '--no-deps',
        '--require-hashes',
        '--find-links',
        paths.downloads,
        '--no-warn-script-location',
        '-r',
        requirements,
      ],
      hooks,
      PIP_IDLE_MS,
      'Installing the packages',
    );
    if (pip) return pip;

    hooks.onProgress({ phase: 'checking', fraction: null });
    const check = await run(
      envPython,
      ['-c', `import ${lock.module}`],
      hooks,
      CHECK_IDLE_MS,
      `Starting ${lock.module}`,
    );
    if (check) return check;

    const engine = lock.packages.find(
      (p) => p.name === (env === 'piper' ? 'piper-tts' : 'omnivoice'),
    );
    await deps.writeText(
      paths.marker(env),
      JSON.stringify({
        tool: env,
        version: engine?.version ?? null,
        installedAt: deps.now(),
        lock: name,
      }),
    );
    // The environment has what it needs; the downloads are only kept for a try that fails.
    for (const item of artifacts) await kit.fs.rm(item.dest);
    return { ok: true, code: 0, cancelled: false };
  }

  async function runModels(
    target: 'piper-voices' | 'omnivoice-weights',
    hooks: RunHooks,
  ): Promise<RunResult> {
    if (hooks.token.cancelled) return CANCELLED;
    hooks.onProgress({ phase: 'preparing', fraction: null });
    const files: readonly StudioModelFile[] =
      target === 'piper-voices'
        ? STUDIO_PIPER.voices.flatMap((v) => v.files)
        : STUDIO_OMNIVOICE.files;
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    const noRoom = await roomFor(bytes / 2);
    if (noRoom) return noRoom;
    const dir = paths.modelsDir(target);
    await kit.fs.rm(paths.marker(target));
    const artifacts = files.map((f) => ({
      url: f.url,
      size: f.size,
      sha256: f.sha256,
      dest: `${dir}${sep}${f.path.split('/').join(sep)}`,
      label: f.path,
    }));
    for (const folder of new Set(artifacts.map((a) => a.dest.slice(0, a.dest.lastIndexOf(sep))))) {
      await kit.fs.mkdir(folder);
    }
    const missing = await fetchAll(artifacts, hooks);
    if (missing) return missing;
    await deps.writeText(
      paths.marker(target),
      JSON.stringify({
        tool: target satisfies StudioToolId,
        version: null,
        installedAt: deps.now(),
        files: files.map((f) => ({ path: f.path, size: f.size })),
      }),
    );
    return { ok: true, code: 0, cancelled: false };
  }

  return { runEnv, runModels };
}
