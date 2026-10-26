import type { AdbDevice } from '@runova/core';
import {
  type AndroidPhysicalDevice,
  isEmulatorSerial,
  parseAdbDevices,
  parseEmuAvdName,
  parseGetProp,
} from '@runova/core';
import { runAdb } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/**
 * What is attached right now. `adb devices -l` is the whole truth, but it gives an emulator only
 * as `emulator-5554`, so the serials are handed back separately for the emulator manager to match
 * against the AVDs it knows about.
 */

export interface AttachedDevices {
  /** The emulator rows, with their adb state: `offline` while one is still coming up. */
  emulators: AdbDevice[];
  physical: AndroidPhysicalDevice[];
}

/** The properties a card shows. Read in one call, since each adb round trip costs a few ms. */
const PROPS = ['ro.build.version.release', 'ro.build.version.sdk', 'ro.product.model'];

async function enrich(
  sdk: ResolvedAndroidSdk,
  device: AndroidPhysicalDevice,
): Promise<AndroidPhysicalDevice> {
  // Only a device in the `device` state can answer a shell command. An unauthorized or offline
  // one would just time out, which would make the whole sweep slow for no information.
  if (device.device.state !== 'device') return device;
  try {
    const stdout = await runAdb(sdk, ['-s', device.device.serial, 'shell', 'getprop', ...PROPS], {
      timeoutMs: 8000,
    });
    const props = parseGetProp(stdout);
    // getprop answers an unset property with an empty value rather than nothing at all, so `??`
    // would blank out a model `adb devices -l` already told us.
    const prop = (name: string): string | null => props[name]?.trim() || null;
    const api = Number(prop('ro.build.version.sdk'));
    return {
      ...device,
      androidVersion: prop('ro.build.version.release'),
      api: Number.isFinite(api) ? api : null,
      device: { ...device.device, model: prop('ro.product.model') ?? device.device.model },
    };
  } catch {
    // A device that stopped answering between the list and the probe is still plugged in, so it
    // stays in the list with whatever adb already told us about it.
    return device;
  }
}

export async function listAttached(sdk: ResolvedAndroidSdk): Promise<AttachedDevices> {
  const stdout = await runAdb(sdk, ['devices', '-l']);
  const all = parseAdbDevices(stdout);

  const emulators = all.filter((d) => isEmulatorSerial(d.serial));
  const physical = all
    .filter((d) => !isEmulatorSerial(d.serial))
    .map(
      (device): AndroidPhysicalDevice => ({
        kind: 'physical',
        device,
        androidVersion: null,
        api: null,
      }),
    );

  return {
    emulators,
    physical: await Promise.all(physical.map((device) => enrich(sdk, device))),
  };
}

/**
 * Which AVD each emulator serial is running. This is how an emulator someone started in Android
 * Studio gets a name on its card instead of a bare port number.
 */
export async function resolveAvdNames(
  sdk: ResolvedAndroidSdk,
  serials: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    serials.map(async (serial) => {
      try {
        const stdout = await runAdb(sdk, ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 5000 });
        const name = parseEmuAvdName(stdout);
        if (name) names.set(serial, name);
      } catch {
        // An emulator still booting refuses console commands. The next sweep asks again.
      }
    }),
  );
  return names;
}
