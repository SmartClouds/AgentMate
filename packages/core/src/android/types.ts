/**
 * The shapes that cross the IPC boundary for the Android page. The parsers each own their own
 * narrow types; these are the merged views the renderer actually renders.
 */

import type { AdbDevice } from './adbDevices.js';
import type { AvdSummary } from './avdConfig.js';
import type { EmulatorState } from './boot.js';
import type { SdkResolution } from './sdkPaths.js';

/** Which SDK tools were found. A missing one disables its actions rather than failing at spawn. */
export interface AndroidSdkTools {
  adb: boolean;
  emulator: boolean;
  avdmanager: boolean;
  sdkmanager: boolean;
}

export interface AndroidSdkStatus extends SdkResolution {
  tools: AndroidSdkTools;
  /** The platform-tools version, for the header chip. Null when adb could not be run. */
  adbVersion: string | null;
}

/** CPU and memory for one emulator process tree. */
export interface AndroidUsage {
  cpuPercent: number;
  memoryBytes: number;
  /**
   * False on the first sample on Windows and Linux, where CPU is a delta between two readings.
   * The UI shows "measuring" rather than a misleading 0%.
   */
  cpuReady: boolean;
}

/** A virtual device, whether or not it is currently running. */
export interface AndroidEmulator {
  kind: 'emulator';
  avd: AvdSummary;
  state: EmulatorState;
  /** Present once the emulator has a console port, so from `launching` onwards. */
  serial: string | null;
  /** How far up the boot is, 0 to 100. */
  progress: number;
  /** True when it was already running when Runova looked, so we do not own its process. */
  adopted: boolean;
  usage: AndroidUsage | null;
  /** The last line the emulator printed, shown on the card while it boots. */
  lastLine: string | null;
  error: string | null;
}

/** A phone or tablet attached over USB or Wi-Fi. */
export interface AndroidPhysicalDevice {
  kind: 'physical';
  device: AdbDevice;
  androidVersion: string | null;
  api: number | null;
}

export type AndroidDevice = AndroidEmulator | AndroidPhysicalDevice;

export interface AndroidSnapshot {
  sdk: AndroidSdkStatus;
  emulators: AndroidEmulator[];
  physical: AndroidPhysicalDevice[];
  /** AVDs avdmanager could see but not load, so the page can say why one is missing. */
  broken: { name: string; error: string }[];
}

/** One line of emulator or adb output, for the log drawer. */
export interface AndroidLogLine {
  /** The AVD name or device serial the line came from. */
  source: string;
  stream: 'stdout' | 'stderr';
  text: string;
  at: number;
}

export type AndroidEvent =
  | { kind: 'snapshot'; snapshot: AndroidSnapshot }
  | { kind: 'emulator'; emulator: AndroidEmulator }
  | { kind: 'usage'; bySerial: Record<string, AndroidUsage> }
  | { kind: 'sdk'; sdk: AndroidSdkStatus }
  | { kind: 'task'; id: string; label: string; progress: number | null; done: boolean };

/** Where a screenshot or recording landed, so the toast can offer to reveal it. */
export interface AndroidCapture {
  path: string;
  fileName: string;
}

export interface AndroidActionResult {
  ok: boolean;
  message?: string;
}

export interface CreateAvdSpec {
  name: string;
  systemImageId: string;
  device: string;
  ramMb?: number;
  storageMb?: number;
  sdCardMb?: number;
  gpuMode?: string;
  orientation?: 'portrait' | 'landscape';
}
