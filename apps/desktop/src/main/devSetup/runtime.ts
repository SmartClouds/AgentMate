import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DevArch,
  DevDetection,
  DevItemId,
  DevJobState,
  DevOs,
  DevSetupEnvironment,
  DevUpdateCheck,
} from '@agentmat/core';
import { app } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import { runSdkManagerStreaming } from '../android/exec';
import { getAndroidSdk, refreshAndroidSdk } from '../android/sdk';
import { broadcastToWindows } from '../ipc/send';
import { cancelSpawn, killProcessTree, spawnStreaming } from '../process/spawnStreaming';
import { fetchLatestVersion } from '../registryVersions';
import { store } from '../store';
import { isE2E } from '../testMode';
import { refreshExtraToolPathDirs } from '../toolPaths';
import { refreshWindowsEnvVars, refreshWindowsPath } from '../windowsPath';
import { addToolToPath } from './addToPath';
import { createDevSetupDetector } from './detectors';
import { createDevSetupInstaller, type InstallRequest } from './installer';
import { createPackageManagerDetector } from './packageManagers';
import { findExecutable, isExecutableFile, runProbe } from './probe';
import { type ManagedRunners, runManagedRecipe } from './runners/managedDispatch';
import { createManagedRunners } from './runners/managedRuntime';
import { createPackageManagerRunner } from './runners/packageManagerRunner';
import { resolveDevSetupSandbox } from './sandbox';
import { createUpdateChecker } from './updates';
import { addToUserPath, type UserPathResult } from './userPath';
import { createSystemUserPathDeps } from './userPathSystem';

/**
 * Binds the Dev Setup detectors and installer to the real machine: its processes, its disk, its
 * Android SDK and its windows. Everything with logic in it takes these as injected dependencies, so
 * this file stays thin.
 */

export interface DevSetupService {
  environment(options?: { force?: boolean }): Promise<DevSetupEnvironment>;
  detect(id: DevItemId, options?: { force?: boolean }): Promise<DevDetection>;
  /** What is remembered, without probing anything. */
  peek(ids: readonly DevItemId[]): Record<DevItemId, DevDetection | undefined>;
  /**
   * Which of these have a newer version on offer. Answers come from what the install itself would
   * run (winget, brew, the registry), are remembered for half an hour, and `force` asks again.
   */
  updates(
    ids: readonly DevItemId[],
    options?: { force?: boolean },
  ): Promise<Record<DevItemId, DevUpdateCheck>>;
  install(request: InstallRequest): Promise<DevJobState>;
  /** With an id, takes that waiting step out of the queue; without, stops the whole run. */
  cancel(id?: DevItemId): void;
  /**
   * Puts the folder of a tool that is installed but off PATH on the user's PATH. Refuses a tool
   * that is already on it or was not found.
   */
  addToPath(id: DevItemId): Promise<UserPathResult>;
  jobState(): DevJobState;
  /** Stops anything running. For quitting the app. */
  dispose(): void;
}

/** Variables an installer is likely to set, read back into this process after an install. */
const INSTALL_ENV_VARS = [
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'DOTNET_ROOT',
  'FLUTTER_ROOT',
] as const;

/** Registries and release lists answer in a second or two, so a slow one is not worth waiting for. */
const FEED_TIMEOUT_MS = 15_000;
/** `sdkmanager --list` starts a JVM and reads Google's whole package list. */
const SDK_LIST_TIMEOUT_MS = 120_000;

/**
 * What `sdkmanager --list` printed, or null when there is no sdkmanager to run. The newer tool can
 * exit with an error after printing the whole list, so the exit code is not what decides whether
 * there is an answer: the text is, and it is read by the parser.
 */
async function listAndroidSdkPackages(): Promise<string | null> {
  const sdk = await getAndroidSdk();
  if (!sdk.paths.sdkmanager) return null;
  const lines: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await runSdkManagerStreaming(sdk, [...(sdk.root ? [`--sdk_root=${sdk.root}`] : []), '--list'], {
      onSpawn: (child) => {
        timer = setTimeout(() => killProcessTree(child), SDK_LIST_TIMEOUT_MS);
      },
      onLine: (line) => lines.push(line),
    });
  } catch {
    // Judged by what it printed, below.
  } finally {
    clearTimeout(timer);
  }
  return lines.join('\n');
}

function currentOs(): DevOs {
  return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

function currentArch(): DevArch {
  return process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'other';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function createService(): DevSetupService {
  const os = currentOs();
  // Only ever set under the end-to-end harness: a private PATH and home, so a test sees what it
  // put there and not what this machine has installed.
  const sandbox = resolveDevSetupSandbox({
    isE2E,
    folder: process.env.AGENTMATE_DEVSETUP_SANDBOX,
    baseEnv: process.env,
    os,
  });
  // Installs run with this as their working folder, and a process cannot start in one that does
  // not exist (which the spawn helper reports as the command being missing).
  if (sandbox) mkdirSync(sandbox.home, { recursive: true });
  const env = (): NodeJS.ProcessEnv => sandbox?.env ?? process.env;
  /** Reading the registry back into the process would undo the sandbox. */
  const refreshPath = async (force?: boolean): Promise<void> => {
    if (!sandbox) await refreshWindowsPath({ force });
  };

  const packageManagers = createPackageManagerDetector({
    os,
    probe: (command, args) => runProbe(command, args, { env: sandbox?.env }),
    now: Date.now,
  });

  const detector = createDevSetupDetector({
    os,
    home: sandbox?.home ?? homedir(),
    env,
    probe: (command, args, options) => runProbe(command, args, { ...options, env: sandbox?.env }),
    exists: pathExists,
    readFile: async (path) => readFile(path, 'utf-8').catch(() => null),
    listDir: async (path) => readdir(path).catch(() => []),
    findExecutable: (command) =>
      findExecutable(command, { env: env(), os, exists: isExecutableFile }),
    androidSdk: () => getAndroidSdk(),
    studioToolsDir: join(app.getPath('userData'), 'studio-tools'),
    now: Date.now,
  });

  const environment = async (options: { force?: boolean } = {}): Promise<DevSetupEnvironment> => {
    // PATH is read once at launch, so a tool installed since then is invisible until it is read
    // back from the registry.
    await refreshPath(options.force);
    return {
      os,
      arch: currentArch(),
      packageManagers: await packageManagers.detect({ force: options.force }),
    };
  };

  const detect = async (
    id: DevItemId,
    options: { force?: boolean } = {},
  ): Promise<DevDetection> => {
    await refreshPath(options.force);
    return detector.detect(id, options);
  };

  const updateChecker = createUpdateChecker({
    environment: () => environment(),
    detect: (id) => detect(id),
    probe: (command, args, options) => runProbe(command, args, { ...options, env: sandbox?.env }),
    // A test run must not depend on the network, or on the SDK this machine happens to have.
    latestNpm: async (pkg) => (sandbox ? null : fetchLatestVersion({ type: 'npm', package: pkg })),
    fetchJson: async (url) => {
      if (sandbox) throw new Error('Not available in a test run.');
      const response = await fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    sdkmanagerList: async () => (sandbox ? null : listAndroidSdkPackages()),
    now: Date.now,
  });

  const addToPath = async (id: DevItemId): Promise<UserPathResult> => {
    // The user PATH is the registry or the person's shell startup file, which a test run must
    // never reach, so this refuses before looking at anything.
    if (sandbox) throw new Error('Not available in a test run.');
    const result = await addToolToPath(id, {
      os,
      detect,
      addToUserPath: (dir) => addToUserPath(dir, createSystemUserPathDeps(homedir())),
    });
    // The edit is done, so a failure to look again must not turn it into an error. The row and the
    // nav badge catch up on their next check either way.
    await detect(id, { force: true }).catch(() => undefined);
    return result;
  };

  const packageManagerRunner = createPackageManagerRunner({
    spawn: spawnStreaming,
    cwd: sandbox?.home ?? homedir(),
    env: sandbox?.env,
  });
  let managed: ManagedRunners | null = null;

  const installer = createDevSetupInstaller({
    environment: () => environment(),
    stacks: async () => (await store.getSettings()).devSetupStacks,
    detect,
    checkUpdates: (ids, options) => updateChecker.check(ids, options),
    run: async (step, hooks) => {
      const { recipe, intent } = step.mode;
      if (recipe.kind === 'managed') {
        // Built the first time one is needed: opening the page touches neither the data folder
        // nor the network.
        managed ??= createManagedRunners();
        return runManagedRecipe(step.item.id, recipe, hooks, managed, {
          intent,
          path: step.path,
        });
      }
      return packageManagerRunner.run(recipe, intent, hooks);
    },
    afterInstall: async () => {
      // What the installer changed: PATH, the variables it set, and the folders cached from them.
      await refreshPath(true);
      if (!sandbox) await refreshWindowsEnvVars(INSTALL_ENV_VARS);
      refreshExtraToolPathDirs();
      refreshAndroidSdk();
    },
    cancelRun: cancelSpawn,
    emit: (event) => broadcastToWindows(IPC.devSetup.onEvent, event),
    newJobId: randomUUID,
  });

  return {
    environment,
    detect,
    peek: (ids) => detector.peek(ids),
    updates: (ids, options) => updateChecker.check(ids, options),
    install: (request) => installer.install(request),
    cancel: (id) => installer.cancel(id),
    addToPath,
    jobState: () => installer.jobState(),
    dispose: () => installer.dispose(),
  };
}

let service: DevSetupService | null = null;

export function getDevSetupService(): DevSetupService {
  service ??= createService();
  return service;
}

/** Stops a running install on quit. Does nothing when the page was never opened. */
export function disposeDevSetup(): void {
  service?.dispose();
}
