import { z } from 'zod';

/**
 * Studio's local voice engines run in Python environments of their own, installed by Dev Setup
 * from lock files (`assets/tools/locks`, written by scripts/studio-python-locks.mjs): a pinned
 * Python build and every wheel, each with its address, size and SHA-256. This module reads them,
 * picks the one for this computer, and says where everything lives once installed.
 */

export type StudioEnvId = 'piper' | 'omnivoice';
export type StudioPlatform = 'win-x64' | 'linux-x64' | 'linux-arm64' | 'macos-arm64' | 'macos-x64';
export type StudioAccelerator = 'cpu' | 'cu128' | 'mps';

const artifact = {
  url: z.string().url().startsWith('https://'),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
};

export const pythonLockSchema = z.object({
  lockVersion: z.literal(1),
  env: z.enum(['piper', 'omnivoice']),
  platform: z.enum(['win-x64', 'linux-x64', 'linux-arm64', 'macos-arm64', 'macos-x64']),
  accelerator: z.enum(['cpu', 'cu128', 'mps']),
  /** What `python -c "import <module>"` must manage once installed. */
  module: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  requirements: z.array(z.string()),
  python: z.object({ version: z.string().regex(/^3\.\d+\.\d+$/), ...artifact }),
  packages: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9._-]+$/),
        version: z.string().min(1),
        /** The wheel's file name, which pip reads its tags from. */
        file: z.string().regex(/^[A-Za-z0-9._+-]+\.whl$/),
        ...artifact,
      }),
    )
    .min(1),
});
export type PythonLock = z.infer<typeof pythonLockSchema>;

export function lockFileName(env: StudioEnvId, platform: StudioPlatform, accel: StudioAccelerator) {
  return `${env}-${platform}-${accel}.json`;
}

export function studioPlatform(os: string, arch: string): StudioPlatform | null {
  if (os === 'win32' && arch === 'x64') return 'win-x64';
  if (os === 'linux' && arch === 'x64') return 'linux-x64';
  if (os === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (os === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (os === 'darwin' && arch === 'x64') return 'macos-x64';
  return null;
}

/** An NVIDIA card as `nvidia-smi` names it, or null when there is none. */
export interface NvidiaGpu {
  name: string;
  driver: string;
  memoryMiB: number;
}

/** The oldest NVIDIA driver that runs CUDA 12.8 builds of PyTorch. */
export const CUDA_128_MIN_DRIVER = 570;

/**
 * Which build of an engine fits this computer: Piper always runs on the processor; OmniVoice uses
 * an NVIDIA card with a new enough driver, Apple's GPU on a Mac with Apple silicon, and the
 * processor otherwise (slow, but it works). Null when there is no build at all.
 */
export function acceleratorFor(
  env: StudioEnvId,
  platform: StudioPlatform,
  gpu: NvidiaGpu | null,
): StudioAccelerator | null {
  if (env === 'piper') return 'cpu';
  if (platform === 'macos-arm64') return 'mps';
  if (platform !== 'win-x64' && platform !== 'linux-x64') return null;
  const major = Number(gpu?.driver.split('.')[0]);
  return gpu && major >= CUDA_128_MIN_DRIVER ? 'cu128' : 'cpu';
}

/** Reads `nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): NvidiaGpu | null {
  const line = output.split(/\r?\n/).find((l) => l.trim());
  const [name, driver, memory] = (line ?? '').split(',').map((part) => part.trim());
  if (!name || !driver || !/^\d+(\.\d+)*$/.test(driver)) return null;
  return { name, driver, memoryMiB: Number(memory) || 0 };
}

/** The `-r` file pip installs from: every package pinned, with the one hash it may have. */
export function requirementsText(lock: PythonLock): string {
  return `${lock.packages.map((p) => `${p.name}==${p.version} --hash=sha256:${p.sha256}`).join('\n')}\n`;
}

/** Bytes to download for a lock, the Python build included. */
export function lockBytes(lock: PythonLock): number {
  return lock.packages.reduce((sum, p) => sum + p.size, lock.python.size);
}

/**
 * Where Studio's tools live under its folder (`<userData>/studio-tools`). Paths use the given
 * separator so the layout can be checked for every OS from any OS.
 */
export function studioToolPaths(root: string, os: string) {
  const sep = os === 'win32' ? '\\' : '/';
  const join = (...parts: string[]) => [root, ...parts].join(sep);
  const envDir = (env: StudioEnvId) => join('envs', env);
  return {
    root,
    downloads: join('downloads'),
    pythonDir: (version: string, platform: StudioPlatform) =>
      join('python', `${version}-${platform}`),
    /** The interpreter inside an unpacked Python build. */
    basePython: (dir: string) =>
      os === 'win32' ? `${dir}${sep}python.exe` : `${dir}${sep}bin${sep}python3`,
    envDir,
    envPython: (env: StudioEnvId) =>
      os === 'win32'
        ? [envDir(env), 'Scripts', 'python.exe'].join(sep)
        : [envDir(env), 'bin', 'python3'].join(sep),
    modelsDir: (target: 'piper-voices' | 'omnivoice-weights') => join('models', target),
    /** Written last by an install, so a half-finished one never counts as installed. */
    marker: (tool: string) => join(`${tool}.installed.json`),
  };
}

export const installMarkerSchema = z.object({
  tool: z.string(),
  version: z.string().nullable(),
  installedAt: z.number(),
  /** The lock it was installed from, for an environment. */
  lock: z.string().optional(),
  /** Every file, for model files: a missing or resized one means the install is broken. */
  files: z.array(z.object({ path: z.string(), size: z.number() })).optional(),
});
export type InstallMarker = z.infer<typeof installMarkerSchema>;
