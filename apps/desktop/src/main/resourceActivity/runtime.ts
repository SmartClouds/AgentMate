import net from 'node:net';
import os from 'node:os';
import { isEmulatorSerial, normalizeIdleResourceMinutes, parseAdbDevices } from '@runova/core';
import { resolveAvdNames } from '../android/devices';
import { runAdb } from '../android/exec';
import { launchedEmulatorPids, stopEmulator } from '../android/runtime';
import { getAndroidSdk } from '../android/sdk';
import { sampleDockerActivity, stopContainer } from '../docker/dockerCli';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { sampleListeningPorts } from '../system/listeningPorts';
import { sampleProcessTrees } from '../system/processTree';
import { createEmulatorSource } from './emulatorSource';
import { DEFAULT_TICK_MS, ResourceActivityTracker } from './tracker';

/**
 * Binds the idle tracker to the real Docker CLI, adb, the process list and the settings store.
 * Kept apart from the tracker so the tracker can be driven by fakes in its own tests.
 */

const DEFAULT_ADB_PORT = 5037;
const ADB_PROBE_TIMEOUT_MS = 500;
/** Where the tracker keeps its own CPU baseline, so other process samplers cannot shorten it. */
const BASELINE = 'resource-activity';

/**
 * Normally 30 seconds. A developer or a verification build can shorten it with
 * RUNOVA_RESOURCE_TICK_MS (at least a second) instead of waiting out a real idle stretch.
 */
function tickMs(): number {
  const raw = Number(process.env.RUNOVA_RESOURCE_TICK_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_TICK_MS;
}

/**
 * Whether an adb server is already running. Asking adb itself would start one, which the app
 * promises never to do for someone who does not use Android.
 */
function adbServerListening(): Promise<boolean> {
  const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || DEFAULT_ADB_PORT;
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (listening: boolean): void => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(ADB_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function listOnlineEmulators(): Promise<string[] | null> {
  try {
    const sdk = await getAndroidSdk();
    if (!sdk.paths.adb) return null;
    const stdout = await runAdb(sdk, ['devices', '-l'], { timeoutMs: 5000 });
    return parseAdbDevices(stdout)
      .filter((device) => isEmulatorSerial(device.serial) && device.state === 'device')
      .map((device) => device.serial);
  } catch {
    return null;
  }
}

let tracker: ResourceActivityTracker | null = null;

/** Built on first use, so the IPC handlers work even in builds that never start the timer. */
export function getResourceActivityTracker(): ResourceActivityTracker {
  tracker ??= new ResourceActivityTracker({
    sampleDocker: sampleDockerActivity,
    sampleEmulators: createEmulatorSource({
      adbServerListening,
      listOnlineEmulators,
      resolveAvdNames: async (serials) => resolveAvdNames(await getAndroidSdk(), serials),
      launchedPids: launchedEmulatorPids,
      listeningPorts: sampleListeningPorts,
      sampleTrees: (pids) =>
        sampleProcessTrees(pids, { baseline: BASELINE, maxGapMs: Math.round(tickMs() * 2.5) }),
      cpuCount: os.cpus().length || 1,
    }),
    getSettings: async () => {
      const settings = await store.getSettings();
      return {
        idleMinutes: normalizeIdleResourceMinutes(settings.idleResourceMinutes),
        notify: settings.idleResourceNotify !== false,
      };
    },
    // Clicking it brings the app forward on the Dashboard, where the idle list lives.
    notify: ({ title, body }) => {
      showOsNotification({ title, body, route: '/' });
    },
    stopContainer,
    stopEmulator,
    tickMs: tickMs(),
    firstTickMs: Math.min(10_000, tickMs()),
  });
  return tracker;
}

export function startResourceActivityTracker(): void {
  getResourceActivityTracker().start();
}

export function stopResourceActivityTracker(): void {
  tracker?.dispose();
  tracker = null;
}
