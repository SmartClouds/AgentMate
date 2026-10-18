import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app, powerSaveBlocker } from 'electron';
import type { UpdateInfo as ElectronUpdateInfo, ProgressInfo } from 'electron-updater';
import { autoUpdater } from 'electron-updater';
import type { UpdateDownloadProgress, UpdateInfo, UpdateStatus } from '../shared/apiTypes';
import { IPC } from '../shared/ipcChannels';
import { broadcastToWindows } from './ipc/send';
import { preserveTerminalsOnQuit } from './ipc/terminal';
import { allowQuit } from './quitGuard';
import { isRunningUnderRosetta } from './system/rosetta';
import { isE2E } from './testMode';
import {
  launchMacInstall,
  type PreparedMacUpdate,
  pickMacZip,
  prepareMacUpdate,
} from './updater/macInstall';
import {
  DownloadAbortedError,
  DownloadFatalError,
  fileSize,
  ResumableDownload,
} from './updater/resumableDownload';

/**
 * electron-builder.yml publishes releases via GitHub (see the `publish` block
 * there), so this reads update metadata straight off the project's GitHub
 * Releases. Downloads never start on their own: `autoDownload` is off, and
 * every state transition is broadcast to the renderer, which is responsible
 * for asking the user to confirm before a download begins and again before
 * restarting to install.
 *
 * The installer itself is fetched with Range-resume. electron-updater deletes
 * its temp file on any timeout, which on a weak connection means starting the
 * whole download again. We keep bytes in userData, retry from there, then
 * hand the complete file to electron-updater's cache so quit-and-install
 * still goes through its usual path. macOS is the exception: Squirrel.Mac
 * won't install into an unsigned app, so there the app swaps its own bundle
 * (see updater/macInstall.ts).
 */
const ONE_HOUR_MS = 60 * 60 * 1000;
const GITHUB_OWNER = 'SmartClouds';
const GITHUB_REPO = 'AgentMate';

let currentStatus: UpdateStatus = { state: 'idle' };
let activeUpdateInfo: UpdateInfo | null = null;
let pendingResolvers: Array<(status: UpdateStatus) => void> = [];
let wired = false;
let activeDownload: ResumableDownload | null = null;
let downloadLock: Promise<void> | null = null;
let powerSaveBlockerId: number | null = null;
let lastProgress: UpdateDownloadProgress | null = null;
let pendingMacInstall: PreparedMacUpdate | null = null;
let macInstallLaunched = false;

interface ResolvedAsset {
  url: string;
  fileName: string;
  sha512: string;
  size: number | null;
}

interface UpdaterDiskConfig {
  updaterCacheDirName?: string;
  owner?: string;
  repo?: string;
}

interface ResolvedFileInfo {
  url: URL;
  info: { sha512?: string; size?: number; url?: string };
}

interface UpdateInfoAndProvider {
  info: ElectronUpdateInfo;
  provider: { resolveFiles: (info: ElectronUpdateInfo) => ResolvedFileInfo[] };
}

interface AutoUpdaterInternals {
  updateInfoAndProvider?: UpdateInfoAndProvider;
  configOnDisk: { value: Promise<UpdaterDiskConfig> };
}

function internals(): AutoUpdaterInternals {
  return autoUpdater as unknown as AutoUpdaterInternals;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return HTML_ENTITIES[lower] ?? match;
  });
}

/**
 * GitHub gives electron-updater the release body as HTML, but the update
 * dialog renders it as plain text, so the tags would show up literally.
 * Turn the markup back into readable lines: list items become bullets, block
 * elements become line breaks, everything else is dropped.
 */
function htmlToText(html: string): string {
  const stripped = html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/\s*<\s*\/\s*li\s*>\s*/gi, '')
    .replace(/<\s*li\b[^>]*>\s*/gi, '\n- ')
    .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6]|tr|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toUpdateInfo(info: ElectronUpdateInfo): UpdateInfo {
  const notes = info.releaseNotes;
  const raw =
    typeof notes === 'string'
      ? notes
      : Array.isArray(notes)
        ? notes
            .map((n) => n.note ?? '')
            .filter(Boolean)
            .join('\n\n')
        : '';
  const releaseNotes = htmlToText(raw) || null;
  const file = info.files?.[0];
  return {
    version: info.version,
    releaseDate: info.releaseDate ?? null,
    releaseNotes,
    sizeBytes: typeof file?.size === 'number' ? file.size : null,
  };
}

function broadcast(status: UpdateStatus): void {
  currentStatus = status;
  broadcastToWindows(IPC.app.onUpdateStatus, status);
}

function settlePending(status: UpdateStatus): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  for (const resolve of resolvers) resolve(status);
}

function downloadsRoot(): string {
  return join(app.getPath('userData'), 'update-downloads');
}

function versionDir(version: string): string {
  return join(downloadsRoot(), version.replace(/[/\\]/g, '_'));
}

function partialPath(asset: ResolvedAsset, version: string): string {
  return join(versionDir(version), `${asset.fileName}.partial`);
}

function completePath(asset: ResolvedAsset, version: string): string {
  return join(versionDir(version), asset.fileName);
}

function userAgent(): string {
  return `AgentMate/${app.getVersion()} (${process.platform})`;
}

function progressFromBytes(
  transferred: number,
  total: number,
  bytesPerSecond: number,
  resumed: boolean,
): UpdateDownloadProgress {
  const safeTotal = total > 0 ? total : transferred;
  const percent = safeTotal > 0 ? Math.min(100, (transferred / safeTotal) * 100) : 0;
  const remaining = Math.max(0, safeTotal - transferred);
  const etaSeconds = bytesPerSecond > 8 * 1024 ? Math.round(remaining / bytesPerSecond) : null;
  return {
    percent,
    transferredBytes: transferred,
    totalBytes: safeTotal,
    bytesPerSecond,
    etaSeconds,
    resumed,
  };
}

function setPowerSave(active: boolean): void {
  if (active && powerSaveBlockerId == null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!active && powerSaveBlockerId != null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
  }
}

function wireEvents(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = null;
  // An unhandled 'error' event on an EventEmitter throws, so always keep a listener.
  autoUpdater.on('error', (error) => {
    if (downloadLock) return;
    const status: UpdateStatus = {
      state: 'error',
      message: error instanceof Error ? error.message : 'Update check failed.',
      info: activeUpdateInfo ?? undefined,
      resumable: false,
    };
    broadcast(status);
    settlePending(status);
  });

  autoUpdater.on('checking-for-update', () => {
    if (downloadLock) return;
    broadcast({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    activeUpdateInfo = toUpdateInfo(info);
    void (async () => {
      const update = activeUpdateInfo;
      if (!update) return;
      try {
        const partialBytes = await localBytesFor(update);
        await pruneOtherVersions(update.version);
        const status: UpdateStatus = { state: 'available', info: update, partialBytes };
        broadcast(status);
        settlePending(status);
      } catch (error) {
        const status: UpdateStatus = {
          state: 'error',
          message: error instanceof Error ? error.message : 'Update check failed.',
          info: update,
        };
        broadcast(status);
        settlePending(status);
      }
    })();
  });

  autoUpdater.on('update-not-available', () => {
    if (downloadLock) return;
    activeUpdateInfo = null;
    lastProgress = null;
    const status: UpdateStatus = { state: 'not-available' };
    broadcast(status);
    settlePending(status);
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    // Only surface electron-updater's own progress when we are not driving
    // the download ourselves (the cache-seed path should skip this).
    if (downloadLock || !activeUpdateInfo) return;
    lastProgress = progressFromBytes(
      progress.transferred,
      progress.total,
      progress.bytesPerSecond,
      false,
    );
    broadcast({
      state: 'downloading',
      info: activeUpdateInfo,
      progress: lastProgress,
      reconnecting: false,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    activeUpdateInfo = toUpdateInfo(info);
    lastProgress = null;
    broadcast({ state: 'downloaded', info: activeUpdateInfo });
  });

  // The dialog promises a downloaded update installs on the next quit. On macOS that is
  // our own swap; elsewhere electron-updater's autoInstallOnAppQuit covers it.
  app.on('will-quit', () => {
    if (!pendingMacInstall || macInstallLaunched) return;
    macInstallLaunched = true;
    launchMacInstall(pendingMacInstall, process.pid, false);
  });
}

/**
 * Updates go by the hardware, not the build that is running: an Intel build under Rosetta on
 * Apple Silicon moves to the arm64 build, because under Rosetta git and every other xcrun tool
 * fails (see system/rosetta.ts). The arm64 zip is ad-hoc signed and CD checks the signature, so
 * it launches after the swap.
 */
function wantsAppleSiliconBuild(): boolean {
  return process.arch === 'arm64' || isRunningUnderRosetta();
}

async function resolveAsset(info: UpdateInfo): Promise<ResolvedAsset> {
  const bundle = internals().updateInfoAndProvider;
  let url: string | null = null;
  let fileName: string | null = null;
  let sha512: string | null = null;
  let size: number | null = info.sizeBytes;

  if (bundle?.provider) {
    const files = bundle.provider.resolveFiles(bundle.info);
    let match: ResolvedFileInfo | undefined;
    if (process.platform === 'darwin') {
      const picked = pickMacZip(
        files.map((file) => file.url.pathname),
        wantsAppleSiliconBuild(),
      );
      match = files.find((file) => file.url.pathname === picked);
      if (!match) {
        throw new DownloadFatalError(
          `This release has no ${wantsAppleSiliconBuild() ? 'Apple Silicon' : 'Intel'} build to update to. Download it from the releases page instead.`,
        );
      }
    } else {
      const preferredExt = process.platform === 'linux' ? '.appimage' : '.exe';
      match =
        files.find((file) => file.url.pathname.toLowerCase().endsWith(preferredExt)) ?? files[0];
    }
    if (match) {
      url = match.url.href;
      fileName = basename(decodeURIComponent(match.url.pathname));
      sha512 = match.info.sha512 ?? null;
      if (typeof match.info.size === 'number') size = match.info.size;
    }
  }

  if (url == null || fileName == null) {
    const electronInfo = bundle?.info;
    const listed = electronInfo?.files?.[0];
    fileName = listed?.url
      ? basename(listed.url)
      : electronInfo?.path
        ? basename(electronInfo.path)
        : null;
    sha512 = listed?.sha512 ?? electronInfo?.sha512 ?? sha512;
    if (typeof listed?.size === 'number') size = listed.size;
    const config = await internals().configOnDisk.value.catch(() => ({}) as UpdaterDiskConfig);
    const owner = config.owner ?? GITHUB_OWNER;
    const repo = config.repo ?? GITHUB_REPO;
    if (fileName) {
      url = `https://github.com/${owner}/${repo}/releases/download/v${info.version}/${fileName}`;
    }
  }

  if (url == null || fileName == null || sha512 == null) {
    throw new DownloadFatalError('Could not resolve the update file URL.');
  }

  return { url, fileName, sha512, size };
}

async function hashFileSha512(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

function updaterCacheRoot(cacheDirName: string): string {
  const home = homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME || join(home, '.cache');
  return join(base, cacheDirName);
}

async function seedElectronUpdaterCache(asset: ResolvedAsset, sourcePath: string): Promise<void> {
  const config = await internals().configOnDisk.value;
  const cacheDirName = config.updaterCacheDirName || `${app.getName()}-updater`;
  const pendingDir = join(updaterCacheRoot(cacheDirName), 'pending');
  await mkdir(pendingDir, { recursive: true });
  const dest = join(pendingDir, asset.fileName);
  if (dest !== sourcePath) await copyFile(sourcePath, dest);
  await writeFile(
    join(pendingDir, 'update-info.json'),
    JSON.stringify({
      fileName: asset.fileName,
      sha512: asset.sha512,
      isAdminRightsRequired: false,
    }),
  );
}

async function pruneOtherVersions(keepVersion: string): Promise<void> {
  const root = downloadsRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  const keep = keepVersion.replace(/[/\\]/g, '_');
  await Promise.all(
    entries
      .filter((name) => name !== keep)
      .map((name) => rm(join(root, name), { recursive: true, force: true })),
  );
}

async function localBytesFor(info: UpdateInfo): Promise<number> {
  try {
    const asset = await resolveAsset(info);
    const complete = await fileSize(completePath(asset, info.version));
    if (complete > 0) return complete;
    return await fileSize(partialPath(asset, info.version));
  } catch {
    return 0;
  }
}

/**
 * Unpackaged runs (electron-vite dev, or a build run without an installer)
 * never have real release metadata to check against, so update checks are a
 * no-op there. This feature only applies to installed, released builds.
 */
export async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    const status: UpdateStatus = {
      state: 'error',
      message: 'Update checks are only available in installed builds, not in development.',
    };
    if (manual) broadcast(status);
    return status;
  }

  if (
    currentStatus.state === 'downloading' ||
    currentStatus.state === 'paused' ||
    currentStatus.state === 'downloaded'
  ) {
    return currentStatus;
  }

  wireEvents();
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      const status: UpdateStatus = {
        state: 'error',
        message: error instanceof Error ? error.message : 'Update check failed.',
      };
      broadcast(status);
      settlePending(status);
    });
  });
}

/**
 * Hands the verified file to whatever installs it. Windows and Linux go through
 * electron-updater (its `update-downloaded` event broadcasts `downloaded`); macOS
 * unpacks it for our own bundle swap.
 */
async function handOffToInstaller(
  asset: ResolvedAsset,
  filePath: string,
  info: UpdateInfo,
): Promise<void> {
  if (process.platform === 'darwin') {
    pendingMacInstall = await prepareMacUpdate({
      zipPath: filePath,
      execPath: process.execPath,
      workDir: versionDir(info.version),
    });
    macInstallLaunched = false;
    activeUpdateInfo = info;
    lastProgress = null;
    broadcast({ state: 'downloaded', info });
    return;
  }
  await seedElectronUpdaterCache(asset, filePath);
  await autoUpdater.downloadUpdate();
}

async function runDownload(): Promise<void> {
  if (!app.isPackaged) return;
  wireEvents();
  if (!activeUpdateInfo) {
    throw new DownloadFatalError('No update is available to download.');
  }
  const info = activeUpdateInfo;
  const asset = await resolveAsset(info);
  await mkdir(versionDir(info.version), { recursive: true });
  await pruneOtherVersions(info.version);

  const done = completePath(asset, info.version);
  const part = partialPath(asset, info.version);
  const existingComplete = await fileSize(done);
  if (existingComplete > 0) {
    const digest = await hashFileSha512(done);
    if (digest === asset.sha512) {
      await handOffToInstaller(asset, done, info);
      return;
    }
    await rm(done, { force: true });
  }

  const startedFrom = await fileSize(part);
  lastProgress = progressFromBytes(startedFrom, asset.size ?? startedFrom, 0, startedFrom > 0);
  broadcast({
    state: 'downloading',
    info,
    progress: lastProgress,
    reconnecting: false,
  });

  const download = new ResumableDownload();
  activeDownload = download;
  setPowerSave(true);
  try {
    await download.run({
      url: asset.url,
      destPath: part,
      expectedSize: asset.size,
      userAgent: userAgent(),
      onProgress: (progress) => {
        lastProgress = progressFromBytes(
          progress.transferred,
          progress.total,
          progress.bytesPerSecond,
          startedFrom > 0,
        );
        broadcast({
          state: 'downloading',
          info,
          progress: lastProgress,
          reconnecting: false,
        });
      },
      onReconnect: (_attempt, transferred) => {
        lastProgress = progressFromBytes(
          transferred,
          asset.size ?? lastProgress?.totalBytes ?? transferred,
          0,
          true,
        );
        broadcast({
          state: 'downloading',
          info,
          progress: lastProgress,
          reconnecting: true,
        });
      },
    });

    const digest = await hashFileSha512(part);
    if (digest !== asset.sha512) {
      await rm(part, { force: true });
      lastProgress = null;
      throw new DownloadFatalError(
        'Downloaded file did not match the published checksum. The partial was discarded so the next try starts clean.',
      );
    }
    await rename(part, done);
    await handOffToInstaller(asset, done, info);
  } catch (error) {
    if (error instanceof DownloadAbortedError) {
      const transferred = await fileSize(part);
      lastProgress = progressFromBytes(
        transferred,
        asset.size ?? lastProgress?.totalBytes ?? transferred,
        0,
        transferred > 0,
      );
      broadcast({
        state: 'paused',
        info,
        progress: lastProgress,
        message: 'Download paused. What you already have stays on disk.',
      });
      return;
    }
    const transferred = Math.max(await fileSize(part), await fileSize(done));
    const resumable = transferred > 0 && !(error instanceof DownloadFatalError);
    lastProgress = progressFromBytes(
      transferred,
      asset.size ?? lastProgress?.totalBytes ?? transferred,
      0,
      transferred > 0,
    );
    broadcast({
      state: 'error',
      message: error instanceof Error ? error.message : 'Failed to download the update.',
      info,
      resumable,
      progress: lastProgress,
    });
  } finally {
    if (activeDownload === download) activeDownload = null;
    setPowerSave(false);
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return;
  if (downloadLock) return downloadLock;
  downloadLock = runDownload().finally(() => {
    downloadLock = null;
  });
  return downloadLock;
}

export function pauseDownload(): void {
  activeDownload?.abort();
}

export function quitAndInstall(): void {
  if (!app.isPackaged) return;
  // The app comes straight back on the new version and reattaches to its terminals, so
  // they keep running through the install even if the user has them end on a normal quit.
  preserveTerminalsOnQuit();
  // The user already chose to restart for the update, so open sessions don't ask again.
  allowQuit();
  try {
    if (process.platform === 'darwin') {
      if (!pendingMacInstall) throw new Error('No downloaded update to install.');
      macInstallLaunched = true;
      launchMacInstall(pendingMacInstall, process.pid, true);
      app.quit();
    } else {
      autoUpdater.quitAndInstall();
    }
  } catch (error) {
    // BaseUpdater.install dispatches its own error event, but a synchronous throw
    // (e.g. "No update filepath") would otherwise leave the `downloaded` dialog
    // open with a dead button. Surface it so the dialog can explain the retry.
    const message = error instanceof Error ? error.message : 'Restart to install failed.';
    const status: UpdateStatus = {
      state: 'error',
      message,
      info: activeUpdateInfo ?? undefined,
      resumable: false,
    };
    broadcast(status);
    throw error instanceof Error ? error : new Error(message);
  }
}

/** Runs an initial check on startup, then re-checks hourly while packaged. */
export function startHourlyUpdateChecks(): void {
  if (!app.isPackaged || isE2E) return;
  wireEvents();
  void checkForUpdates(false);
  setInterval(() => {
    // Don't clobber a check/download/restart-confirmation the user is already in.
    const idleStates: UpdateStatus['state'][] = ['idle', 'not-available'];
    const canRetryError = currentStatus.state === 'error' && currentStatus.resumable !== true;
    if (idleStates.includes(currentStatus.state) || canRetryError) {
      void checkForUpdates(false);
    }
  }, ONE_HOUR_MS);
}
