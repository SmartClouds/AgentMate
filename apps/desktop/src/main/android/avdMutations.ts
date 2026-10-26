import { existsSync, readdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AndroidActionResult,
  type AvdAdvanced,
  type AvdEdit,
  applyIniPatch,
  avdAdvancedFromConfig,
  avdConfigPatch,
  avdHomeCandidates,
  type CreateAvdSpec,
  isValidAvdName,
  parseIni,
  parseSdkManagerList,
  type SystemImage,
  sortSystemImages,
} from '@runova/core';
import { runAvdManager, runSdkManager } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/** Creating, deleting and wiping AVDs, plus the lists the create dialog needs to offer. */

function avdHome(): string | null {
  return avdHomeCandidates(process.env, homedir()).find((dir) => existsSync(dir)) ?? null;
}

function failure(error: unknown): AndroidActionResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

export async function createAvd(
  sdk: ResolvedAndroidSdk,
  spec: CreateAvdSpec,
): Promise<AndroidActionResult> {
  // Checked before spawning, since avdmanager's own rejection is a usage dump nobody can read.
  if (!isValidAvdName(spec.name)) {
    return {
      ok: false,
      message: 'Use only letters, digits, dots, dashes and underscores in the name.',
    };
  }

  const args = ['create', 'avd', '-n', spec.name, '-k', spec.systemImageId];
  if (spec.device) args.push('-d', spec.device);

  try {
    // Some SDK versions still ask "Do you wish to create a custom hardware profile?" on stdin
    // even with -d. Without an answer the call never returns.
    await runAvdManager(sdk, args, { input: 'no\n' });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteAvd(
  sdk: ResolvedAndroidSdk,
  name: string,
): Promise<AndroidActionResult> {
  try {
    await runAvdManager(sdk, ['delete', 'avd', '-n', name]);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** The AVD folder for a name, or null when the name is not one we will touch. */
function avdFolder(name: string): string | null {
  // A name is a folder component, so anything that could climb out is refused rather than cleaned.
  if (!isValidAvdName(name) || name.includes('..')) return null;
  const home = avdHome();
  return home ? join(home, `${name}.avd`) : null;
}

/**
 * The advanced settings as the file currently has them, so the dialog opens on what is really
 * there rather than on defaults that a first save would then write over the top of.
 */
export async function readAvdConfig(_sdk: ResolvedAndroidSdk, name: string): Promise<AvdAdvanced> {
  const folder = avdFolder(name);
  if (!folder) throw new Error('That is not a virtual device name.');
  try {
    return avdAdvancedFromConfig(parseIni(await readFile(join(folder, 'config.ini'), 'utf-8')));
  } catch {
    // An AVD we cannot read still gets the emulator's own defaults, which is better than a
    // dialog with every field blank.
    return avdAdvancedFromConfig({});
  }
}

/**
 * Changes an AVD's own settings by rewriting its `config.ini`. There is no avdmanager verb for
 * this, and only what can be changed safely is offered: the system image and device profile need
 * the AVD's folder rebuilt, which is not something to do behind a dialog.
 */
export async function editAvd(
  _sdk: ResolvedAndroidSdk,
  name: string,
  edit: AvdEdit,
): Promise<AndroidActionResult> {
  let patch: Record<string, string>;
  try {
    // Validated before the file is opened, so a bad value can never leave a half-written config.
    patch = avdConfigPatch(edit);
  } catch (error) {
    return failure(error);
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  const folder = avdFolder(name);
  const file = folder ? join(folder, 'config.ini') : null;
  if (!file) return { ok: false, message: `Could not find the folder for ${name}.` };

  try {
    const current = await readFile(file, 'utf-8');
    await writeFile(file, applyIniPatch(current, patch));
    return { ok: true };
  } catch {
    return { ok: false, message: `Could not read the settings for ${name}.` };
  }
}

/**
 * What a wipe removes. avdmanager has no verb for this, so the data images go directly. The
 * definition of the AVD (`config.ini`) and the read-only base image are deliberately left alone.
 */
const WIPED = [/^userdata-qemu\.img(\..+)?$/, /^cache\.img$/, /^snapshots$/, /^sdcard\.img$/];

export async function wipeAvdData(
  _sdk: ResolvedAndroidSdk,
  name: string,
): Promise<AndroidActionResult> {
  // A name is a folder component here, so anything that could climb out of the AVD home is
  // refused rather than sanitized.
  if (!isValidAvdName(name) || name.includes('..')) {
    return { ok: false, message: 'That is not a virtual device name.' };
  }
  const home = avdHome();
  const folder = home ? join(home, `${name}.avd`) : null;
  if (!folder || !existsSync(folder)) {
    return { ok: false, message: `Could not find the folder for ${name}.` };
  }

  try {
    const targets = readdirSync(folder).filter((entry) =>
      WIPED.some((pattern) => pattern.test(entry)),
    );
    await Promise.all(
      targets.map((entry) => rm(join(folder, entry), { recursive: true, force: true })),
    );
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Installed system images, newest API first. The create dialog cannot offer what is not there. */
export async function listSystemImages(sdk: ResolvedAndroidSdk): Promise<SystemImage[]> {
  try {
    // `--list_installed` is much faster than `--list`, which also reaches out to the network.
    const stdout = await runSdkManager(sdk, ['--list_installed'], { maxBuffer: 16 * 1024 * 1024 });
    return sortSystemImages(parseSdkManagerList(stdout).installed);
  } catch {
    return [];
  }
}

/**
 * Device profiles to create an AVD from. The fallback matters: a machine with no command-line
 * tools would otherwise get an empty dropdown and no way to finish the dialog.
 */
const FALLBACK_PROFILES = [
  'pixel_7',
  'pixel_7_pro',
  'pixel_6',
  'pixel_tablet',
  'pixel_fold',
  'Nexus 5X',
  'medium_phone',
  'medium_tablet',
];

export async function listDeviceProfiles(sdk: ResolvedAndroidSdk): Promise<string[]> {
  try {
    const stdout = await runAvdManager(sdk, ['list', 'device', '-c']);
    const ids = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('Available') && !line.includes(':'));
    return ids.length > 0 ? ids : FALLBACK_PROFILES;
  } catch {
    return FALLBACK_PROFILES;
  }
}
