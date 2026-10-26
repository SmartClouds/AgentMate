import { spawn } from 'node:child_process';
import type { AndroidSnapshot } from '@runova/core';
import { listAvds } from './avds';
import { listAttached, resolveAvdNames } from './devices';
import { AndroidEmulatorManager } from './emulatorManager';
import { emitAndroidEvent } from './events';
import { runAdb } from './exec';
import { getAndroidSdk, requireTool } from './sdk';
import { toolSpawn } from './spawnTool';
import { AndroidUsageSampler } from './usage';

/**
 * Binds the emulator manager to the real SDK. Kept apart from the manager itself so the manager
 * stays free of Electron and child processes and can be driven by fakes in its own tests.
 *
 * Nothing in here runs until the page asks for it, so a user who never opens Android never starts
 * an adb server.
 */

let manager: AndroidEmulatorManager | null = null;
let sampler: AndroidUsageSampler | null = null;

/** Windows has no process groups, so the whole tree has to go by pid. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
}

function getManager(): AndroidEmulatorManager {
  manager ??= new AndroidEmulatorManager({
    listAvds: async () => listAvds(await getAndroidSdk()),
    listAttached: async () => listAttached(await getAndroidSdk()),
    resolveAvdNames: async (serials) => resolveAvdNames(await getAndroidSdk(), serials),
    getProp: async (serial, prop) =>
      runAdb(await getAndroidSdk(), ['-s', serial, 'shell', 'getprop', prop], { timeoutMs: 5000 }),
    emuKill: async (serial) => {
      await runAdb(await getAndroidSdk(), ['-s', serial, 'emu', 'kill'], { timeoutMs: 20_000 });
    },
    launch: (args) => {
      // Through the shared helper, so an emulator that is a script wrapper rather than a real
      // executable still starts. Detached, so the emulator window outlives a restart of the app,
      // which is what a user expects from a window they can see and close themselves.
      const { file, argv, verbatim } = toolSpawn(emulatorPath, args);
      const child = spawn(file, argv, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: verbatim,
      });
      child.unref();
      const pid = child.pid ?? 0;
      return { pid, kill: () => killTree(pid) };
    },
    killTree,
    emit: emitAndroidEvent,
  });
  return manager;
}

/**
 * The emulator binary, resolved once before the manager is built. `launch` is synchronous because
 * the manager needs the pid straight away, so the path cannot be awaited inside it.
 */
let emulatorPath = '';

async function ready(): Promise<AndroidEmulatorManager> {
  const sdk = await getAndroidSdk();
  if (sdk.paths.emulator) emulatorPath = sdk.paths.emulator;
  return getManager();
}

export async function androidSnapshot(): Promise<AndroidSnapshot> {
  const [instance, sdk] = await Promise.all([ready(), getAndroidSdk()]);
  const snapshot = await instance.snapshot();
  const { paths: _paths, ...status } = sdk;
  return { ...snapshot, sdk: status };
}

export async function startEmulator(
  avdName: string,
  options: { coldBoot?: boolean; wipeData?: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const sdk = await getAndroidSdk();
  // Checked here so a missing emulator package reads as "install this" rather than as ENOENT
  // from inside the manager, which has no idea what an SDK package is.
  requireTool(sdk, 'emulator');
  const instance = await ready();
  return instance.start(avdName, options);
}

/**
 * The pid behind each running emulator Runova launched. Reads the manager only if it already
 * exists, so asking never builds one (and never starts anything) for a user who has not used
 * Android.
 */
export function launchedEmulatorPids(): Map<string, number> {
  return manager?.pidsBySerial() ?? new Map();
}

export async function stopEmulator(serial: string): Promise<{ ok: boolean; message?: string }> {
  return (await ready()).stop(serial);
}

export async function cancelEmulatorBoot(
  avdName: string,
): Promise<{ ok: boolean; message?: string }> {
  return (await ready()).cancelBoot(avdName);
}

/**
 * Turns the CPU and memory meters on while a window has the page open. Refcounted per window, so
 * closing one of two open windows does not stop the other's meters.
 */
export async function watchAndroidUsage(windowId: number, enabled: boolean): Promise<void> {
  const instance = await ready();
  sampler ??= new AndroidUsageSampler({
    pidsBySerial: () => instance.pidsBySerial(),
    emit: emitAndroidEvent,
  });
  sampler.watch(windowId, enabled);
}

/** Called from the quit hook. A no-op unless the user asked for it in Settings. */
export async function stopEmulatorsOnQuit(enabled: boolean): Promise<void> {
  sampler?.dispose();
  if (!manager) return;
  await manager.stopAllOnQuit(enabled);
}
