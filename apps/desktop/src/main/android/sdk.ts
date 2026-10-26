import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { promisify } from 'node:util';
import {
  type AndroidSdkStatus,
  resolveSdkRoot,
  type SdkBinaryPaths,
  type SdkPlatform,
  sdkBinaryPaths,
} from '@runova/core';
import { store } from '../store';
import { toolSpawn } from './spawnTool';

/**
 * Where the pure resolution in @runova/core meets the real filesystem. Everything downstream
 * takes absolute binary paths from here, which is what lets the rest of the feature spawn tools
 * directly instead of going through a shell and worrying about Windows quoting.
 */

const execFileAsync = promisify(execFile);

export type AndroidTool = keyof SdkBinaryPaths;

export interface ResolvedAndroidSdk extends AndroidSdkStatus {
  /** Absolute paths, or null for a tool that is not installed. */
  paths: SdkBinaryPaths;
}

/** Detection touches the disk on every call, so a short cache keeps the 3s device poll cheap. */
const CACHE_TTL_MS = 5 * 60_000;
let cached: { at: number; value: ResolvedAndroidSdk } | null = null;
let inFlight: Promise<ResolvedAndroidSdk> | null = null;

/** Called when `androidSdkPath` changes, so the next read looks again. */
export function refreshAndroidSdk(): void {
  cached = null;
  inFlight = null;
}

function currentPlatform(): SdkPlatform {
  const value = platform();
  if (value === 'win32' || value === 'darwin') return value;
  return 'linux';
}

/**
 * `cmdline-tools/latest` is the normal layout, but an SDK installed by `sdkmanager` itself often
 * only has versioned folders. The pure resolver cannot list a directory, so the versioned
 * candidates are filled in here and the highest version wins.
 */
function versionedCmdlineTools(root: string, os: SdkPlatform): SdkBinaryPaths['avdmanager'][] {
  const sep = os === 'win32' ? '\\' : '/';
  const bat = os === 'win32' ? '.bat' : '';
  try {
    return readdirSync(`${root}${sep}cmdline-tools`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'latest')
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => `${root}${sep}cmdline-tools${sep}${version}${sep}bin${sep}`)
      .flatMap((prefix) => [`${prefix}avdmanager${bat}`])
      .filter((candidate) => existsSync(candidate));
  } catch {
    // No cmdline-tools folder at all, which the caller already treats as "not installed".
    return [];
  }
}

function withVersionedFallback(
  root: string,
  os: SdkPlatform,
  paths: SdkBinaryPaths,
): SdkBinaryPaths {
  if (paths.avdmanager && paths.sdkmanager) return paths;
  const found = versionedCmdlineTools(root, os);
  if (found.length === 0) return paths;
  const avdmanager = found[0] ?? null;
  const sdkmanager = avdmanager?.replace(/avdmanager(\.bat)?$/, (m) => m.replace('avd', 'sdk'));
  return {
    ...paths,
    avdmanager: paths.avdmanager ?? avdmanager,
    sdkmanager: paths.sdkmanager ?? (sdkmanager && existsSync(sdkmanager) ? sdkmanager : null),
  };
}

/** `adb version` prints two lines; the second carries the platform-tools version we want. */
async function probeAdbVersion(adbPath: string): Promise<string | null> {
  try {
    // Through the shared spawn helper, so an adb that is a .bat wrapper works here too rather
    // than silently reporting no version while every other call succeeds.
    const { file, argv, verbatim } = toolSpawn(adbPath, ['version']);
    const { stdout } = await execFileAsync(file, argv, {
      timeout: 8000,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
    return /Version\s+(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch {
    // The binary is there but will not run, which is worth showing as "no version" rather than
    // as "not installed": the file on disk is the more reliable signal.
    return null;
  }
}

const NO_PATHS: SdkBinaryPaths = {
  adb: null,
  emulator: null,
  avdmanager: null,
  sdkmanager: null,
};

async function detect(env: NodeJS.ProcessEnv): Promise<ResolvedAndroidSdk> {
  const settings = await store.getSettings();
  const os = currentPlatform();
  const resolution = resolveSdkRoot({
    override: settings.androidSdkPath,
    env: env as Record<string, string | undefined>,
    platform: os,
    homeDir: homedir(),
    exists: existsSync,
  });

  if (resolution.status !== 'found' || !resolution.root) {
    return {
      ...resolution,
      paths: NO_PATHS,
      tools: { adb: false, emulator: false, avdmanager: false, sdkmanager: false },
      adbVersion: null,
    };
  }

  const paths = withVersionedFallback(
    resolution.root,
    os,
    sdkBinaryPaths(resolution.root, os, existsSync),
  );

  return {
    ...resolution,
    paths,
    tools: {
      adb: paths.adb !== null,
      emulator: paths.emulator !== null,
      avdmanager: paths.avdmanager !== null,
      sdkmanager: paths.sdkmanager !== null,
    },
    adbVersion: paths.adb ? await probeAdbVersion(paths.adb) : null,
  };
}

export async function getAndroidSdk(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAndroidSdk> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  // Share one detection between concurrent callers, or the 3s poll and a page open would both
  // probe at once on a cold cache.
  inFlight ??= detect(env).then((value) => {
    cached = { at: Date.now(), value };
    inFlight = null;
    return value;
  });
  return inFlight;
}

/** What the SDK package is called, so a missing tool can say how to install it. */
const INSTALL_HINT: Record<AndroidTool, string> = {
  adb: 'platform-tools',
  emulator: 'emulator',
  avdmanager: 'cmdline-tools;latest',
  sdkmanager: 'cmdline-tools;latest',
};

export class AndroidToolMissingError extends Error {
  constructor(
    readonly tool: AndroidTool,
    readonly sdkPackage: string,
  ) {
    super(`The Android SDK here has no ${tool}. Install the ${sdkPackage} package and try again.`);
    this.name = 'AndroidToolMissingError';
  }
}

export function requireTool(sdk: ResolvedAndroidSdk, tool: AndroidTool): string {
  const path = sdk.paths[tool];
  if (!path) throw new AndroidToolMissingError(tool, INSTALL_HINT[tool]);
  return path;
}
