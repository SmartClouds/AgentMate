import { posix, win32 } from 'node:path';
import type { DevOs } from '@runova/core';

/**
 * A private world for the end-to-end tests of Dev Setup. Detection is only meaningful if it sees
 * what the test put there, so under a test run the PATH, the home folder and the places installers
 * hide things (Program Files, the local app data folder, JAVA_HOME) are all swapped for ones inside
 * a folder the test owns. Otherwise the result would depend on what the developer running the tests
 * happens to have installed.
 *
 * It only turns on when the app is running under the e2e harness AND is given an absolute folder,
 * so a stray variable on a real install does nothing.
 */

export interface DevSetupSandbox {
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface SandboxInput {
  isE2E: boolean;
  /** `RUNOVA_DEVSETUP_SANDBOX`. */
  folder: string | undefined;
  baseEnv: NodeJS.ProcessEnv;
  os: DevOs;
}

/** Variables an installer sets, which would lead a probe to a real tool if they were kept. */
const FORGOTTEN = ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DOTNET_ROOT', 'FLUTTER_ROOT'];

function keyOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
}

function set(env: NodeJS.ProcessEnv, name: string, value: string): void {
  env[keyOf(env, name) ?? name] = value;
}

function forget(env: NodeJS.ProcessEnv, name: string): void {
  const key = keyOf(env, name);
  if (key) delete env[key];
}

export function resolveDevSetupSandbox(input: SandboxInput): DevSetupSandbox | null {
  const folder = input.folder?.trim();
  if (!input.isE2E || !folder) return null;
  const path = input.os === 'win32' ? win32 : posix;
  if (!path.isAbsolute(folder)) return null;

  const env: NodeJS.ProcessEnv = { ...input.baseEnv };
  const home = path.join(folder, 'home');
  const nowhere = path.join(folder, 'none');

  // Off Windows the test's tools are /bin/sh scripts, which name their shell by its full path, so
  // the system folders stay off PATH. They are where apt and Homebrew put real tools (`gh` above
  // all), and the test needs those to be missing.
  let systemDirs: string[] = [];
  if (input.os === 'win32') {
    const root = input.baseEnv[keyOf(input.baseEnv, 'SystemRoot') ?? 'SystemRoot'] ?? 'C:\\Windows';
    systemDirs = [
      path.join(root, 'System32'),
      root,
      path.join(root, 'System32', 'Wbem'),
      path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    ];
  }
  const pathKey = keyOf(env, 'PATH') ?? 'PATH';
  env[pathKey] = [path.join(folder, 'bin'), ...systemDirs].join(path.delimiter);

  set(env, 'HOME', home);
  if (input.os === 'win32') {
    set(env, 'USERPROFILE', home);
    set(env, 'ProgramFiles', path.join(nowhere, 'Program Files'));
    set(env, 'ProgramFiles(x86)', path.join(nowhere, 'Program Files (x86)'));
    set(env, 'ProgramW6432', path.join(nowhere, 'Program Files'));
    set(env, 'LOCALAPPDATA', path.join(nowhere, 'Local'));
    set(env, 'APPDATA', path.join(nowhere, 'Roaming'));
  }
  for (const name of FORGOTTEN) forget(env, name);

  return { env, home };
}
