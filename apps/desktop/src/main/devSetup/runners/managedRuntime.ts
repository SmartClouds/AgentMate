import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  androidPackagesFor,
  type DevArch,
  type DevOs,
  defaultSdkInstallRoot,
} from '@agentmat/core';
import { app, net } from 'electron';
import { runSdkManagerStreaming } from '../../android/exec';
import { getAndroidSdk, refreshAndroidSdk } from '../../android/sdk';
import { killProcessTree, spawnStreaming } from '../../process/spawnStreaming';
import { ResumableDownload } from '../../updater/resumableDownload';
import { runProbe } from '../probe';
import { addToUserPath } from '../userPath';
import { createSystemUserPathDeps } from '../userPathSystem';
import { createAndroidInstaller } from './androidInstaller';
import { runCommand } from './commandRunner';
import { createFlutterInstaller } from './flutterInstaller';
import { createDockerLauncher } from './launchDocker';
import type { ManagedRunners } from './managedDispatch';
import { createManagedKit } from './managedSystem';

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
  };
}
