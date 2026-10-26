import { existsSync } from 'node:fs';
import {
  type AndroidActionResult,
  type AndroidSdkStatus,
  type AndroidSnapshot,
  type AvdAdvanced,
  type AvdEdit,
  type CreateAvdSpec,
  isValidAvdName,
  type SystemImage,
} from '@runova/core';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  createAvd,
  deleteAvd,
  editAvd,
  listDeviceProfiles,
  listSystemImages,
  readAvdConfig,
  wipeAvdData,
} from '../android/avdMutations';
import {
  type CaptureResult,
  installApk,
  openCapturesFolder,
  revealCapture,
  rotateDevice,
  startRecording,
  stopRecording,
  takeScreenshot,
} from '../android/deviceActions';
import { emitAndroidEvent } from '../android/events';
import { connectDevice, disconnectDevice, enableWireless, pairDevice } from '../android/pairing';
import {
  androidSnapshot,
  cancelEmulatorBoot,
  startEmulator,
  stopEmulator,
  watchAndroidUsage,
} from '../android/runtime';
import { getAndroidSdk, refreshAndroidSdk, requireTool } from '../android/sdk';
import {
  type AvailableImages,
  installSystemImage,
  listAvailableSystemImages,
} from '../android/systemImages';
import { store } from '../store';

/**
 * The renderer side of the Android page. Nothing here runs until the page is opened, so a user
 * who never touches Android pays nothing: no adb server is started and no SDK is probed.
 */

/** The `paths` field is main-process detail; the renderer only needs to know what is available. */
async function sdkStatus(): Promise<AndroidSdkStatus> {
  const { paths: _paths, ...status } = await getAndroidSdk();
  return status;
}

async function applySdkPath(path: string | null): Promise<AndroidSdkStatus> {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  await store.updateSettings((settings) => ({
    ...settings,
    androidSdkPath: trimmed === '' ? null : trimmed,
  }));
  refreshAndroidSdk();
  const status = await sdkStatus();
  // Any other open window is showing a stale SDK banner until it hears about this.
  emitAndroidEvent({ kind: 'sdk', sdk: status });
  return status;
}

/**
 * Everything below reaches a command line, so it is checked here rather than escaped later.
 * A serial comes from our own device list and an AVD name has to be one avdmanager would accept.
 */
const SERIAL = /^[A-Za-z0-9._:-]+$/;

function assertSerial(serial: unknown): string {
  if (typeof serial !== 'string' || !SERIAL.test(serial)) throw new Error('Unknown device.');
  return serial;
}

/** A path from a drop or a picker, checked before it is handed to adb. */
function assertApkPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('No APK to install.');
  const checked = paths.map((path) => {
    if (typeof path !== 'string' || !existsSync(path) || !path.toLowerCase().endsWith('.apk')) {
      throw new Error('That is not an APK file.');
    }
    return path;
  });
  return checked;
}

function assertAvdName(name: unknown): string {
  if (typeof name !== 'string' || !isValidAvdName(name)) throw new Error('Unknown virtual device.');
  return name;
}

export function registerAndroidHandlers(): void {
  ipcMain.handle(IPC.android.refresh, (): Promise<AndroidSnapshot> => androidSnapshot());

  ipcMain.handle(
    IPC.android.start,
    (_event, avdName: string, options: { coldBoot?: boolean; wipeData?: boolean } = {}) =>
      startEmulator(assertAvdName(avdName), {
        coldBoot: options.coldBoot === true,
        wipeData: options.wipeData === true,
      }),
  );

  ipcMain.handle(
    IPC.android.stop,
    (_event, serial: string): Promise<AndroidActionResult> => stopEmulator(assertSerial(serial)),
  );

  ipcMain.handle(
    IPC.android.cancelBoot,
    (_event, avdName: string): Promise<AndroidActionResult> =>
      cancelEmulatorBoot(assertAvdName(avdName)),
  );

  ipcMain.handle(IPC.android.watchUsage, (event, enabled: boolean): Promise<void> => {
    // Keyed by window so two open pages each count once and the last one out turns sampling off.
    const parent = BrowserWindow.fromWebContents(event.sender);
    return watchAndroidUsage(parent?.id ?? 0, enabled === true);
  });

  ipcMain.handle(IPC.android.rotate, async (_event, serial: string): Promise<void> => {
    await rotateDevice(await getAndroidSdk(), assertSerial(serial));
  });

  ipcMain.handle(
    IPC.android.screenshot,
    async (_event, serial: string, label: string): Promise<CaptureResult> =>
      takeScreenshot(await getAndroidSdk(), assertSerial(serial), String(label ?? serial)),
  );

  ipcMain.handle(
    IPC.android.startRecording,
    async (_event, serial: string, label: string): Promise<{ id: string }> => {
      const handle = startRecording(
        await getAndroidSdk(),
        assertSerial(serial),
        String(label ?? serial),
      );
      await handle.started;
      return { id: handle.id };
    },
  );

  ipcMain.handle(
    IPC.android.stopRecording,
    (_event, id: string): Promise<CaptureResult> => stopRecording(String(id)),
  );

  ipcMain.handle(
    IPC.android.installApk,
    async (_event, serial: string, paths: string[]): Promise<AndroidActionResult> =>
      installApk(await getAndroidSdk(), assertSerial(serial), assertApkPaths(paths)),
  );

  ipcMain.handle(IPC.android.pickApk, async (event): Promise<string[]> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Choose an APK',
      properties: ['openFile', 'multiSelections'] as const,
      filters: [{ name: 'Android package', extensions: ['apk'] }],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    return result.canceled ? [] : result.filePaths;
  });

  /** The renderer opens a shell in a normal terminal tab, so it needs the resolved adb path. */
  ipcMain.handle(
    IPC.android.adbPath,
    async (): Promise<string> => requireTool(await getAndroidSdk(), 'adb'),
  );

  ipcMain.handle(
    IPC.android.revealCapture,
    (_event, path: string): Promise<void> => revealCapture(String(path)),
  );

  ipcMain.handle(IPC.android.openCapturesFolder, (): Promise<void> => openCapturesFolder());

  ipcMain.handle(
    IPC.android.createAvd,
    async (_event, spec: CreateAvdSpec): Promise<AndroidActionResult> =>
      createAvd(await getAndroidSdk(), {
        ...spec,
        name: String(spec?.name ?? ''),
        systemImageId: String(spec?.systemImageId ?? ''),
        device: String(spec?.device ?? ''),
      }),
  );

  ipcMain.handle(
    IPC.android.deleteAvd,
    async (_event, name: string): Promise<AndroidActionResult> =>
      deleteAvd(await getAndroidSdk(), assertAvdName(name)),
  );

  ipcMain.handle(
    IPC.android.editAvd,
    async (_event, name: string, edit: AvdEdit): Promise<AndroidActionResult> =>
      editAvd(await getAndroidSdk(), assertAvdName(name), edit ?? {}),
  );

  ipcMain.handle(
    IPC.android.avdConfig,
    async (_event, name: string): Promise<AvdAdvanced> =>
      readAvdConfig(await getAndroidSdk(), assertAvdName(name)),
  );

  ipcMain.handle(
    IPC.android.wipeData,
    async (_event, name: string): Promise<AndroidActionResult> =>
      wipeAvdData(await getAndroidSdk(), assertAvdName(name)),
  );

  ipcMain.handle(
    IPC.android.listSystemImages,
    async (): Promise<SystemImage[]> => listSystemImages(await getAndroidSdk()),
  );

  ipcMain.handle(
    IPC.android.availableSystemImages,
    async (_event, force?: boolean): Promise<AvailableImages> =>
      listAvailableSystemImages(await getAndroidSdk(), force === true),
  );

  ipcMain.handle(
    IPC.android.installSystemImage,
    async (_event, packageId: string): Promise<AndroidActionResult> => {
      const id = String(packageId ?? '');
      // One task id for the whole download, so the dialog can follow just this one.
      const taskId = `install:${id}`;
      emitAndroidEvent({ kind: 'task', id: taskId, label: 'Starting', progress: 0, done: false });
      const result = await installSystemImage(await getAndroidSdk(), id, (progress) => {
        emitAndroidEvent({
          kind: 'task',
          id: taskId,
          label: progress.label || 'Installing',
          progress: progress.percent,
          done: false,
        });
      });
      emitAndroidEvent({
        kind: 'task',
        id: taskId,
        label: result.ok ? 'Installed' : (result.message ?? 'Failed'),
        progress: result.ok ? 100 : null,
        done: true,
      });
      return result;
    },
  );

  ipcMain.handle(
    IPC.android.listDeviceProfiles,
    async (): Promise<string[]> => listDeviceProfiles(await getAndroidSdk()),
  );

  ipcMain.handle(
    IPC.android.pair,
    async (_event, hostPort: string, code: string): Promise<AndroidActionResult> =>
      pairDevice(await getAndroidSdk(), String(hostPort ?? ''), String(code ?? '')),
  );

  ipcMain.handle(
    IPC.android.connect,
    async (_event, hostPort: string): Promise<AndroidActionResult> =>
      connectDevice(await getAndroidSdk(), String(hostPort ?? '')),
  );

  ipcMain.handle(
    IPC.android.disconnect,
    async (_event, serial: string): Promise<AndroidActionResult> =>
      disconnectDevice(await getAndroidSdk(), assertSerial(serial)),
  );

  ipcMain.handle(
    IPC.android.enableWireless,
    async (_event, serial: string): Promise<AndroidActionResult & { hostPort?: string }> =>
      enableWireless(await getAndroidSdk(), assertSerial(serial)),
  );

  ipcMain.handle(IPC.android.sdk, (): Promise<AndroidSdkStatus> => sdkStatus());

  ipcMain.handle(
    IPC.android.setSdkPath,
    (_event, path: string | null): Promise<AndroidSdkStatus> => applySdkPath(path),
  );

  ipcMain.handle(IPC.android.pickSdkPath, async (event): Promise<string | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Choose the Android SDK folder',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Choose the Android SDK folder',
          properties: ['openDirectory'],
        });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
