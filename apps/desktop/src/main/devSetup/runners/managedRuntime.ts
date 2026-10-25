import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import {
  androidPackagesFor,
  type DevArch,
  type DevOs,
  defaultSdkInstallRoot,
} from '@agentmat/core';
import { parseNvidiaSmi } from '@agentmat/studio';
import { app, net } from 'electron';
import { runSdkManagerStreaming } from '../../android/exec';
import { getAndroidSdk, refreshAndroidSdk } from '../../android/sdk';
import { killProcessTree, spawnStreaming } from '../../process/spawnStreaming';
import { studioPackageRoot } from '../../studio/host';
import { isE2E } from '../../testMode';
import { ResumableDownload } from '../../updater/resumableDownload';
import { runProbe } from '../probe';
import { addToUserPath } from '../userPath';
import { createSystemUserPathDeps } from '../userPathSystem';
import { createAndroidInstaller } from './androidInstaller';
import { runCommand } from './commandRunner';
import { createFlutterInstaller } from './flutterInstaller';
import { createDockerLauncher } from './launchDocker';
import type { ManagedRunners } from './managedDispatch';
import { createManagedKit, STUDIO_TOOL_HOSTS } from './managedSystem';
import { createStudioToolsInstaller } from './studioTools';

/**
 * Builds the installers that fetch and unpack things themselves (Flutter, the Android tools,
 * starting Docker) out of the real machine. Kept apart from `runtime.ts` and created only when
 * the first one is needed, so opening the page never touches the app's data folder or the network.
 */

export interface DockerDesktopLauncherDeps {
  os: DevOs;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** Starts a program and leaves it running on its own. */
  startDetached: (file: string, args: string[]) => void;
}

/** Starting Docker Desktop. On Linux the engine is a system service, so that is left to a terminal. */
export function createDockerDesktopLauncher(
  deps: DockerDesktopLauncherDeps,
): () => Promise<{ ok: boolean; message?: string }> {
  return async () => {
    if (deps.os === 'win32') {
      const programFiles = deps.env.ProgramFiles ?? 'C:\\Program Files';
      const exe = win32.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe');
      if (!deps.exists(exe)) {
        return { ok: false, message: 'Docker Desktop was not found. Install it first.' };
      }
      deps.startDetached(exe, []);
      return { ok: true };
    }
    if (deps.os === 'darwin') {
      if (!deps.exists('/Applications/Docker.app')) {
        return { ok: false, message: 'Docker Desktop was not found. Install it first.' };
      }
      deps.startDetached('open', ['-a', 'Docker']);
      return { ok: true };
    }
    return {
      ok: false,
      message: 'On Linux, start Docker with: sudo systemctl enable --now docker',
    };
  };
}

function startDetached(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  // Docker Desktop outlives this call, and an unhandled error here would crash the app.
  child.on('error', () => undefined);
  child.unref();
}

async function netFetchText(url: string): Promise<string> {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function currentOs(): DevOs {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

function currentArch(): DevArch {
  return process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'other';
}

export function createManagedRunners(): ManagedRunners {
  const os = currentOs();
  const arch = currentArch();
  const home = homedir();
  const kit = createManagedKit(
    { os, arch, home, workDir: join(app.getPath('userData'), 'tools', 'dev-setup') },
    {
      netFetchText,
      createDownload: () => new ResumableDownload(),
      spawn: spawnStreaming,
    },
  );

  return {
    flutter: createFlutterInstaller({
      kit,
      addToUserPath: (dir) => addToUserPath(dir, createSystemUserPathDeps(home)),
      runCommand,
    }),
    android: createAndroidInstaller({
      kit,
      androidSdk: () => getAndroidSdk(),
      refreshAndroidSdk,
      defaultSdkRoot: () => defaultSdkInstallRoot(os, process.env, home),
      runSdkManager: runSdkManagerStreaming,
      killProcess: killProcessTree,
    }),
    dockerLaunch: createDockerLauncher({
      launch: createDockerDesktopLauncher({
        os,
        env: process.env,
        exists: existsSync,
        startDetached,
      }),
      ping: async () => (await runProbe('docker', ['info', '--format', '{{.ServerVersion}}'])).ok,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    }),
    androidPackages: androidPackagesFor(arch),
    studioTools: createStudioToolsInstaller({
      kit: createManagedKit(
        { os, arch, home, workDir: join(app.getPath('userData'), 'studio-tools', 'downloads') },
        {
          netFetchText,
          createDownload: () => new ResumableDownload(),
          spawn: spawnStreaming,
          allowedHosts: studioToolHosts(),
        },
      ),
      root: studioToolsRoot(),
      readLock: async (name) =>
        JSON.parse(
          await readFile(join(studioPackageRoot(), 'assets', 'tools', 'locks', name), 'utf8'),
        ),
      gpu: async () => {
        const answer = await runProbe('nvidia-smi', [
          '--query-gpu=name,driver_version,memory.total',
          '--format=csv,noheader,nounits',
        ]);
        return answer.ok ? parseNvidiaSmi(answer.output) : null;
      },
      runCommand,
      writeText: async (path, text) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text, 'utf8');
      },
      freeBytes: async (path) => {
        try {
          await mkdir(path, { recursive: true });
          const stats = await statfs(path);
          return stats.bavail * stats.bsize;
        } catch {
          return null;
        }
      },
      now: Date.now,
      mapUrl: studioToolsUrl(),
    }),
  };
}

/** Where Studio installs its local voices: `<userData>/studio-tools`. */
export function studioToolsRoot(): string {
  return join(app.getPath('userData'), 'studio-tools');
}

/**
 * The e2e suite serves Studio's tools from a fake server on loopback (AGENTMATE_STUDIO_TOOLS_URL),
 * as `<base>/<host>/<path>`. Only in a test run; a real install fetches from the real hosts.
 */
function studioToolsUrl(): ((url: string) => string) | undefined {
  const base = isE2E ? process.env.AGENTMATE_STUDIO_TOOLS_URL : undefined;
  if (!base) return undefined;
  return (url) => {
    const parsed = new URL(url);
    return `${base}/${parsed.hostname}${parsed.pathname}`;
  };
}

function studioToolHosts(): ReadonlySet<string> {
  const base = isE2E ? process.env.AGENTMATE_STUDIO_TOOLS_URL : undefined;
  return base ? new Set([...STUDIO_TOOL_HOSTS, new URL(base).hostname]) : STUDIO_TOOL_HOSTS;
}
