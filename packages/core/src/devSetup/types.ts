/**
 * The vocabulary of the Dev Setup checklist. Everything here is plain data: the catalog of tools a
 * developer needs, how each one is detected, and the ways it can be installed on each OS. The
 * machinery that runs probes and installers lives in the desktop app and is handed this data.
 */

import type { InstallIntent } from './recipes.js';

export type DevOs = 'win32' | 'darwin' | 'linux';
export type DevArch = 'x64' | 'arm64' | 'other';

export type DevStackId = 'essentials' | 'dotnet' | 'flutter' | 'docker' | 'studio';
export type DevItemId = string;

export interface DevStack {
  id: DevStackId;
  name: string;
  /** One plain sentence shown under the stack chip and the checklist heading. */
  description: string;
  /** Essentials is always on, the others are chosen by the user. */
  alwaysOn?: boolean;
}

/**
 * Checks that need more than "run this command and read its version", each handled by a small
 * detector in the app. They exist because the answer lives in a file layout or in output that
 * needs special reading, not in a version line.
 */
export type DevResolverId = 'flutter' | 'wsl' | 'android-sdk-piece';

export type AndroidSdkPiece =
  | 'cmdline-tools'
  | 'platform-tools'
  | 'emulator'
  | 'platform'
  | 'system-image'
  | 'licenses';

export type DetectSpec =
  | {
      kind: 'command';
      command: string;
      args: readonly string[];
      /** A JDK general-availability build prints only its major version. */
      majorOnly?: boolean;
      /**
       * Read the version from the first line only. ffmpeg names its version there and the
       * compiler it was built with on the next line, which a nightly build (no release number)
       * would otherwise report as its own version.
       */
      firstLineOnly?: boolean;
      /** Exit code 0 is the whole answer (`xcode-select -p`, `gh auth status`). */
      noVersion?: boolean;
      /**
       * Where to look when the command is not on PATH. Templates, see `expandPathTemplate`. A tool
       * found only here is installed but "not on your PATH".
       */
      fallbackPaths?: readonly string[];
      /** Run the command only once another item is installed on this OS (macOS git and Xcode CLT). */
      guard?: { os: DevOs; item: DevItemId };
      timeoutMs?: number;
    }
  /** Installed when any of these exists (an app bundle, an IDE launcher). Templates as above. */
  | { kind: 'paths'; anyOf: readonly string[] }
  | { kind: 'resolver'; id: DevResolverId; piece?: AndroidSdkPiece };

export type DevManagedInstaller =
  | 'flutter-archive'
  | 'android-cmdline-tools'
  | 'android-package'
  | 'android-licenses'
  | 'docker-launch';

/** One way to install an item on one OS. Static data, never built from user input. */
export type DevRecipe =
  | { kind: 'winget'; id: string }
  | { kind: 'brew'; formula: string }
  | { kind: 'brew-cask'; cask: string; needsAdmin?: boolean }
  | {
      kind: 'pkg';
      apt?: readonly string[];
      dnf?: readonly string[];
      pacman?: readonly string[];
      note?: string;
    }
  | { kind: 'npm-global'; pkg: string }
  | { kind: 'dotnet-tool'; pkg: string }
  /** AgentMate runs its own installer (download, verify, unpack, or drive sdkmanager). */
  | { kind: 'managed'; installer: DevManagedInstaller; sdkPackage?: string }
  /** Arrives with another item, so there is nothing to run. */
  | { kind: 'bundled'; with: DevItemId }
  /** Needs a password, an interactive prompt or a system dialog, so it goes to the terminal. */
  | { kind: 'terminal-only'; command: string; note?: string }
  | { kind: 'link'; url: string };

export interface DevConsent {
  title: string;
  url: string;
}

export interface DevItem {
  id: DevItemId;
  name: string;
  /** For the rare tool that is a different product on another OS (Docker Desktop vs Engine). */
  nameByOs?: Partial<Record<DevOs, string>>;
  /** One plain sentence on why a developer wants it. */
  description: string;
  stack: DevStackId;
  /** Nice to have: shown, but never counted against "ready". */
  optional?: boolean;
  /** Where the item exists at all. Absent means every OS. */
  os?: readonly DevOs[];
  /** Must be installed first. Dependencies that do not apply on the current OS are ignored. */
  dependsOn?: readonly DevItemId[];
  minVersion?: string;
  detect: DetectSpec;
  /** In order of preference. An OS with no entry falls back to `manualUrl`. */
  recipes: Partial<Record<DevOs, readonly DevRecipe[]>>;
  /** https download page, offered when nothing can be installed from here. */
  manualUrl?: string;
  /** Agreements the user accepts by installing this, shown once before an install. */
  consent?: DevConsent;
  /** Whether finishing needs a restart of the machine. */
  restart?: 'never' | 'maybe' | 'always';
}

/** What a probe found. `error` means the probe itself failed, which is not the same as "missing". */
export type DevDetection =
  | { state: 'found'; version: string | null; path: string | null; onPath: boolean }
  | { state: 'absent' }
  | { state: 'error'; message: string };

export type DevInstallPhase =
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'checking';

/**
 * Where an update check gets its answer. It is whatever will perform the update, so the chip on a
 * row and the button that follows it cannot disagree: winget for a winget recipe, and so on. The
 * three Linux managers are named as `PackageManagerId` names them.
 */
export type DevUpdateSource =
  | 'winget'
  | 'brew'
  | 'apt-get'
  | 'dnf'
  | 'pacman'
  | 'npm'
  | 'nuget'
  | 'flutter'
  | 'sdkmanager';

/**
 * What one check found for one installed item. `installed` is the version the source itself has for
 * it, which can sit on another scale than the version the probe read (Docker Desktop 4.96 against
 * the engine's 28.x), so it is only used to decide whether the two numbers can be compared.
 */
export type DevUpdateCheck =
  | { state: 'update'; latest: string | null; installed: string | null }
  | { state: 'current' }
  /** The source could not be asked, which says nothing about whether an update exists. */
  | { state: 'unknown' };

/** An update the source offers for an installed row. */
export interface DevItemUpdate {
  /** The version to name on the row, or null when it cannot be compared with the one installed. */
  latest: string | null;
  /** The update was handed to a terminal and the row is waiting for it to land. */
  waiting?: boolean;
  /** Why the last update attempt did not work. */
  failure?: string;
}

/** What the installer is doing, or last did, for one item. */
export interface DevItemJob {
  status: 'queued' | 'installing' | 'failed' | 'waiting-terminal';
  /** Absent means install. */
  intent?: InstallIntent;
  phase?: DevInstallPhase;
  /** 0 to 1, or null when the installer gives no progress to report. */
  fraction?: number | null;
  /** Short progress text such as "312 of 780 MB". */
  detail?: string;
  /** Why it failed, in a sentence. */
  message?: string;
  exitCode?: number | null;
}

/** The one state a checklist row is in. Everything the row shows is derived from this. */
export type DevItemState =
  | { kind: 'checking' }
  /** Ready. `update` is present when a newer version exists, which never makes the row not ready. */
  | { kind: 'installed'; version: string | null; onPath: boolean; update?: DevItemUpdate }
  | { kind: 'outdated'; version: string | null; minVersion: string }
  | { kind: 'missing' }
  | { kind: 'blocked'; waitingFor: DevItemId[]; via: 'dependency' | 'bundled' }
  | { kind: 'queued'; intent?: InstallIntent }
  | {
      kind: 'installing';
      phase: DevInstallPhase;
      fraction: number | null;
      detail: string | null;
      intent?: InstallIntent;
    }
  | { kind: 'failed'; message: string; exitCode: number | null }
  | { kind: 'waiting-terminal' }
  | { kind: 'unavailable' }
  | { kind: 'unknown'; message: string };
