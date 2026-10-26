import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { explainInstallFailure, parseAdbInstallResult, parseGetProp } from '@runova/core';
import { app, shell } from 'electron';
import { store } from '../store';
import { runAdb, runAdbBinary } from './exec';
import type { ResolvedAndroidSdk } from './sdk';

/**
 * The things you do to a device once it is up: rotate it, grab a screenshot, record the screen,
 * push an APK onto it.
 */

export interface CaptureResult {
  path: string;
  fileName: string;
}

/** Screenshots and recordings both land here, so one guard covers revealing either. */
async function capturesDir(kind: 'pictures' | 'videos'): Promise<string> {
  const settings = await store.getSettings();
  const base = settings.androidCapturePath ?? join(app.getPath(kind), 'Runova', 'Android');
  await mkdir(base, { recursive: true });
  return base;
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** A device name goes into a filename, so anything the filesystem dislikes becomes an underscore. */
function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';
}

export async function takeScreenshot(
  sdk: ResolvedAndroidSdk,
  serial: string,
  label: string,
): Promise<CaptureResult> {
  // `exec-out` puts the raw PNG on stdout, so this cannot go through the text runner: stripping
  // ANSI and splitting lines would quietly corrupt the file.
  const bytes = await runAdbBinary(sdk, ['-s', serial, 'exec-out', 'screencap', '-p']);
  const fileName = `${safeName(label)}-${stamp()}.png`;
  const path = join(await capturesDir('pictures'), fileName);
  await writeFile(path, bytes);
  return { path, fileName };
}

/** The four values `user_rotation` takes, a quarter turn apart. */
const ROTATIONS = 4;

export async function rotateDevice(sdk: ResolvedAndroidSdk, serial: string): Promise<void> {
  let current = 0;
  try {
    const stdout = await runAdb(sdk, [
      '-s',
      serial,
      'shell',
      'settings',
      'get',
      'system',
      'user_rotation',
    ]);
    const value = Number(parseGetProp(stdout).value);
    if (Number.isFinite(value)) current = value;
  } catch {
    // Never set on a fresh device, which reads as 0.
  }
  // Auto-rotate overrides an explicit rotation the moment it is set, so it goes off first.
  await runAdb(sdk, [
    '-s',
    serial,
    'shell',
    'settings',
    'put',
    'system',
    'accelerometer_rotation',
    '0',
  ]);
  await runAdb(sdk, [
    '-s',
    serial,
    'shell',
    'settings',
    'put',
    'system',
    'user_rotation',
    String((current + 1) % ROTATIONS),
  ]);
}

interface Recording {
  sdk: ResolvedAndroidSdk;
  serial: string;
  label: string;
  devicePath: string;
}

const recordings = new Map<string, Recording>();

/** screenrecord's own hard limit. Surfaced in the UI rather than hidden. */
export const MAX_RECORDING_SECONDS = 180;

export function startRecording(
  sdk: ResolvedAndroidSdk,
  serial: string,
  label: string,
): { id: string; started: Promise<void> } {
  const id = `${serial}-${Date.now()}`;
  const devicePath = `/sdcard/runova-${Date.now()}.mp4`;
  recordings.set(id, { sdk, serial, label, devicePath });

  // Deliberately not awaited: screenrecord runs on the device until it is interrupted there or
  // hits its own time limit, so waiting for it would be waiting for the whole recording.
  void runAdb(
    sdk,
    [
      '-s',
      serial,
      'shell',
      'screenrecord',
      '--time-limit',
      String(MAX_RECORDING_SECONDS),
      devicePath,
    ],
    { timeoutMs: (MAX_RECORDING_SECONDS + 30) * 1000 },
  ).catch(() => undefined);

  // Resolves as soon as the command is away; the caller only needs the id to stop it later.
  return { id, started: Promise.resolve() };
}

export async function stopRecording(id: string): Promise<CaptureResult> {
  const recording = recordings.get(id);
  if (!recording) throw new Error('That recording has already finished.');
  recordings.delete(id);
  const { sdk, serial, label, devicePath } = recording;

  // SIGINT on the device lets screenrecord finalize the mp4. Killing the host adb instead would
  // leave a file with no moov atom, which nothing can play.
  await runAdb(sdk, ['-s', serial, 'shell', 'pkill', '-INT', '-f', 'screenrecord']).catch(
    () => undefined,
  );
  await new Promise((done) => setTimeout(done, 1500));

  const fileName = `${safeName(label)}-${stamp()}.mp4`;
  const path = join(await capturesDir('videos'), fileName);
  await runAdb(sdk, ['-s', serial, 'pull', devicePath, path], { timeoutMs: 120_000 });
  await runAdb(sdk, ['-s', serial, 'shell', 'rm', devicePath]).catch(() => undefined);
  return { path, fileName };
}

export interface InstallResult {
  ok: boolean;
  message?: string;
}

export async function installApk(
  sdk: ResolvedAndroidSdk,
  serial: string,
  paths: string[],
): Promise<InstallResult> {
  // `-r` replaces an existing install and `-g` grants the runtime permissions, which is what a
  // developer installing their own debug build almost always wants.
  const command = paths.length > 1 ? 'install-multiple' : 'install';
  try {
    const stdout = await runAdb(sdk, ['-s', serial, command, '-r', '-g', ...paths], {
      // A large APK over USB genuinely takes minutes.
      timeoutMs: 10 * 60_000,
    });
    const result = parseAdbInstallResult(stdout, '');
    return result.ok ? { ok: true } : { ok: false, message: explainInstallFailure(result.code) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const result = parseAdbInstallResult('', raw);
    return { ok: false, message: result.code ? explainInstallFailure(result.code) : raw };
  }
}

/**
 * Reveals a capture. The path comes from the renderer, so it is resolved and checked against the
 * folders we write to before anything is handed to the shell.
 */
export async function revealCapture(path: string): Promise<void> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Not a capture.');
  const target = resolve(path);
  const roots = await Promise.all([capturesDir('pictures'), capturesDir('videos')]);
  const inside = roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base + sep) || target.startsWith(`${base}/`);
  });
  if (!inside) throw new Error("That file is not one of Runova's captures.");
  shell.showItemInFolder(target);
}

export async function openCapturesFolder(): Promise<void> {
  await shell.openPath(await capturesDir('pictures'));
}
