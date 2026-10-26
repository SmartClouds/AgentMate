import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  type AvdSummary,
  avdFromConfig,
  avdHomeCandidates,
  parseAvdManagerList,
  parseEmulatorListAvds,
  parseIni,
} from '@runova/core';
import { runAvdManager, runEmulator } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/**
 * The AVDs on this machine.
 *
 * `emulator -list-avds` plus each AVD's own config.ini is the fast path: no Java, no JVM startup,
 * and it works on an SDK that has no command-line tools installed. avdmanager is the fallback,
 * and the only thing that can see AVDs that fail to load at all.
 */

export interface AvdListing {
  avds: AvdSummary[];
  broken: { name: string; error: string }[];
}

function avdHome(): string | null {
  return avdHomeCandidates(process.env, homedir()).find((dir) => existsSync(dir)) ?? null;
}

/** Reads one AVD's config.ini. A missing or unreadable file is normal, not an error. */
function readAvd(home: string | null, name: string): AvdSummary {
  const folder = home ? `${home}/${name}.avd` : null;
  if (folder) {
    try {
      return avdFromConfig(name, parseIni(readFileSync(`${folder}/config.ini`, 'utf-8')), folder);
    } catch {
      // Falls through to the bare summary below.
    }
  }
  // The emulator can still start it, so an AVD we cannot describe is listed rather than hidden.
  return avdFromConfig(name, {}, folder);
}

async function fromEmulator(sdk: ResolvedAndroidSdk): Promise<AvdSummary[] | null> {
  try {
    const names = parseEmulatorListAvds(await runEmulator(sdk, ['-list-avds']));
    if (names.length === 0) return null;
    const home = avdHome();
    return names.map((name) => readAvd(home, name));
  } catch {
    return null;
  }
}

async function fromAvdManager(sdk: ResolvedAndroidSdk): Promise<AvdListing | null> {
  try {
    const { avds, broken } = parseAvdManagerList(await runAvdManager(sdk, ['list', 'avd']));
    return {
      avds: avds.map((entry) => ({
        name: entry.name,
        displayName: entry.name,
        device: entry.device,
        manufacturer: null,
        api: entry.androidVersion ? apiForVersion(entry.androidVersion) : null,
        tag: entry.tag,
        abi: entry.abi,
        playStore: entry.playStore,
        ramMb: null,
        storageMb: null,
        gpuMode: null,
        systemImageDir: null,
        path: entry.path,
      })),
      broken: broken.map((entry) => ({ name: entry.name, error: entry.error })),
    };
  } catch {
    return null;
  }
}

/** avdmanager prints the marketing version, but every card and filter wants the API level. */
const API_BY_VERSION: Record<string, number> = {
  '9': 28,
  '10': 29,
  '11': 30,
  '12': 31,
  '12L': 32,
  '13': 33,
  '14': 34,
  '15': 35,
  '16': 36,
};

function apiForVersion(version: string): number | null {
  return API_BY_VERSION[version.replace(/\.0$/, '')] ?? null;
}

export async function listAvds(sdk: ResolvedAndroidSdk): Promise<AvdListing> {
  const fast = await fromEmulator(sdk);
  // avdmanager is still worth asking even on the fast path, because broken AVDs never appear in
  // `-list-avds` and their absence is otherwise silent.
  const slow = sdk.paths.avdmanager ? await fromAvdManager(sdk) : null;

  if (fast) return { avds: fast, broken: slow?.broken ?? [] };
  if (slow) return slow;
  return { avds: [], broken: [] };
}
