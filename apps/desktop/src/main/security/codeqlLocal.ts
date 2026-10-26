import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CodeqlInstallProgress, CodeqlLocalStatus, SupportedOS } from '@runova/core';
import {
  CODEQL_INSTALL_DIRNAME,
  CODEQL_LATEST_RELEASE_API,
  codeqlAssetName,
  codeqlBinaryName,
  codeqlChecksumUrl,
  codeqlDownloadUrl,
  parseChecksumFile,
} from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import { toolsDir } from '../grammar/localServer';
import { broadcastToWindows } from '../ipc/send';
import { DownloadAbortedError, ResumableDownload } from '../updater/resumableDownload';
import type { ExtractWorkerMessage } from './codeqlExtractWorker';
import { probe } from './exec';

/**
 * A managed local install of the CodeQL CLI.
 *
 * There is no package manager for CodeQL on Windows or Linux (no winget, chocolatey or apt
 * package exists), so GitHub's documented install is "download a zip, extract it, put it on your
 * PATH". Asking that of someone who just wants to scan a project is why the Install button had
 * nothing to offer on this OS. Instead Runova downloads the right release asset, checks it
 * against the SHA-256 GitHub publishes next to it, and unpacks it into its own tools folder, next
 * to where LanguageTool already lives. Nothing goes on the system PATH and nothing needs admin.
 */

const USER_AGENT = 'Runova';

/** Where a managed copy lives: <userData>/tools/codeql, with the zip's own `codeql/` inside it. */
export function codeqlInstallDir(): string {
  return join(toolsDir(), CODEQL_INSTALL_DIRNAME);
}

function platform(): SupportedOS {
  return process.platform as SupportedOS;
}

/** The zip unpacks to a `codeql/` folder, so the binary sits one level in. */
function managedBinaryPath(): string {
  return join(codeqlInstallDir(), 'codeql', codeqlBinaryName(platform()));
}

let currentProgress: CodeqlInstallProgress | null = null;
let activeDownload: ResumableDownload | null = null;
let activeWorker: Worker | null = null;
let cancelled = false;

function emit(progress: CodeqlInstallProgress): void {
  currentProgress = progress;
  // Broadcast rather than reply to one sender: the Tools page and a project's Security tab can
  // both be showing this, and an install outlives whichever one started it.
  broadcastToWindows(IPC.security.onCodeqlProgress, progress);
}

async function readVersion(binary: string): Promise<string | null> {
  const result = await probe(binary, ['version', '--format=terse'], 15_000);
  if (!result.ok) return null;
  const parsed = /\d+\.\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0];
  return parsed ?? (result.stdout.slice(0, 20) || null);
}

/**
 * The command the scanner should actually run. A `codeql` the user installed themselves wins:
 * they chose it, it is probably on a faster disk, and silently preferring our copy would make a
 * version mismatch impossible to explain.
 */
export async function resolveCodeqlCommand(): Promise<string | null> {
  const onPath = await probe('codeql', ['version', '--format=terse'], 10_000);
  if (onPath.ok) return 'codeql';
  const managed = managedBinaryPath();
  return existsSync(managed) ? managed : null;
}

export async function getCodeqlStatus(): Promise<CodeqlLocalStatus> {
  const installDir = codeqlInstallDir();
  const onPath = await probe('codeql', ['version', '--format=terse'], 10_000);
  if (onPath.ok) {
    return {
      installed: true,
      path: 'codeql',
      version: /\d+\.\d+\.\d+[\w.-]*/.exec(onPath.stdout)?.[0] ?? null,
      onPath: true,
      installDir,
      progress: currentProgress,
    };
  }

  const managed = managedBinaryPath();
  if (existsSync(managed)) {
    return {
      installed: true,
      path: managed,
      version: await readVersion(managed),
      onPath: false,
      installDir,
      progress: currentProgress,
    };
  }

  return {
    installed: false,
    path: null,
    version: null,
    onPath: false,
    installDir,
    progress: currentProgress,
  };
}

interface ReleaseAsset {
  name: string;
  size: number;
}

async function fetchLatestRelease(): Promise<{ tag: string; assetSize: number | null }> {
  const response = await fetch(CODEQL_LATEST_RELEASE_API, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Could not read the CodeQL release list (HTTP ${response.status}).`);
  }
  const data = (await response.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
  const tag = data.tag_name;
  if (!tag) throw new Error('The CodeQL release list had no version in it.');

  const wanted = codeqlAssetName(platform());
  const asset = data.assets?.find((a) => a.name === wanted);
  return { tag, assetSize: asset?.size ?? null };
}

async function fetchExpectedChecksum(tag: string): Promise<string | null> {
  try {
    const response = await fetch(codeqlChecksumUrl(tag, platform()), {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return parseChecksumFile(await response.text());
  } catch {
    // A missing checksum file is not worth failing the install over; it is verified when present.
    return null;
  }
}

function sha256File(path: string, onProgress: (read: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    let read = 0;
    stream.on('data', (chunk) => {
      read += chunk.length;
      hash.update(chunk);
      onProgress(read);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function extractInWorker(
  zipPath: string,
  destDir: string,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Packaged builds unpack the worker from the asar archive, same as usageScanWorker.
    const bundled = join(__dirname, 'codeqlExtractWorker.mjs');
    const unpacked = bundled.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
    const script = existsSync(unpacked) ? unpacked : bundled;
    if (!existsSync(script)) {
      reject(new Error('The CodeQL extraction worker is missing from this build.'));
      return;
    }

    const worker = new Worker(script, { workerData: { zipPath, destDir } });
    activeWorker = worker;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      activeWorker = null;
      void worker.terminate();
      fn();
    };

    worker.on('message', (message: ExtractWorkerMessage) => {
      if (message.kind === 'progress') onProgress(message.done, message.total);
      else if (message.kind === 'done') settle(resolve);
      else settle(() => reject(new Error(message.error)));
    });
    worker.on('error', (error) => settle(() => reject(error)));
    worker.on('exit', (code) => {
      if (code !== 0) settle(() => reject(new Error(`Extraction stopped unexpectedly (${code}).`)));
    });
  });
}

export function cancelCodeqlInstall(): void {
  cancelled = true;
  activeDownload?.abort();
  void activeWorker?.terminate();
}

/**
 * Downloads and unpacks CodeQL. Resumable, so a dropped connection partway through a 400 MB
 * download picks up where it left off rather than starting again.
 */
export async function installCodeqlLocally(): Promise<CodeqlLocalStatus> {
  if (currentProgress && currentProgress.phase !== 'done' && currentProgress.phase !== 'failed') {
    throw new Error('A CodeQL install is already running.');
  }
  cancelled = false;

  const installDir = codeqlInstallDir();
  const zipPath = join(installDir, 'codeql-download.zip');

  const report = (
    phase: CodeqlInstallProgress['phase'],
    message: string,
    transferred = 0,
    total = 0,
    bytesPerSecond = 0,
  ): void => {
    emit({
      phase,
      message,
      transferred,
      total,
      bytesPerSecond,
      fraction: total > 0 ? Math.min(1, transferred / total) : null,
    });
  };

  try {
    await mkdir(installDir, { recursive: true });

    report('resolving', 'Looking up the latest CodeQL release');
    const { tag, assetSize } = await fetchLatestRelease();
    if (cancelled) throw new DownloadAbortedError();
    const expected = await fetchExpectedChecksum(tag);

    report('downloading', `Downloading CodeQL ${tag}`, 0, assetSize ?? 0);
    activeDownload = new ResumableDownload();
    await activeDownload.run({
      url: codeqlDownloadUrl(tag, platform()),
      destPath: zipPath,
      expectedSize: assetSize,
      userAgent: USER_AGENT,
      onProgress: ({ transferred, total, bytesPerSecond }) => {
        report(
          'downloading',
          `Downloading CodeQL ${tag}`,
          transferred,
          total || (assetSize ?? 0),
          bytesPerSecond,
        );
      },
      onReconnect: (attempt, transferred) => {
        report(
          'downloading',
          `Connection dropped, resuming (attempt ${attempt})`,
          transferred,
          assetSize ?? 0,
        );
      },
    });
    activeDownload = null;
    if (cancelled) throw new DownloadAbortedError();

    if (expected) {
      const size = (await stat(zipPath)).size;
      report('verifying', 'Checking the download', 0, size);
      const actual = await sha256File(zipPath, (read) =>
        report('verifying', 'Checking the download', read, size),
      );
      if (actual.toLowerCase() !== expected) {
        // A mismatch means a corrupt or tampered download; the partial file goes so a retry
        // cannot resume onto bad bytes.
        await rm(zipPath, { force: true });
        throw new Error(
          'The downloaded CodeQL archive did not match the checksum GitHub published. It was deleted; try again.',
        );
      }
    }
    if (cancelled) throw new DownloadAbortedError();

    // Replace any previous copy rather than unpacking over it, so an upgrade cannot leave a
    // half-old tree behind.
    await rm(join(installDir, 'codeql'), { recursive: true, force: true });

    report('extracting', 'Extracting CodeQL', 0, 100);
    await extractInWorker(zipPath, installDir, (done, total) => {
      report('extracting', 'Extracting CodeQL', done, total);
    });
    await rm(zipPath, { force: true });

    const binary = managedBinaryPath();
    if (!existsSync(binary)) {
      throw new Error('The archive unpacked but no codeql binary was found inside it.');
    }
    // The zip carries POSIX modes, but extraction does not always preserve the execute bit.
    if (process.platform !== 'win32') {
      await chmod(binary, 0o755).catch(() => {
        // Non-fatal: it may already carry the execute bit.
      });
      await makeToolsExecutable(join(installDir, 'codeql', 'tools'));
    }

    const version = await readVersion(binary);
    report('done', version ? `CodeQL ${version} is ready` : 'CodeQL is ready');
    currentProgress = null;
    return getCodeqlStatus();
  } catch (error) {
    activeDownload = null;
    const aborted = cancelled || error instanceof DownloadAbortedError;
    // ResumableDownload is shared with the app updater and phrases its failures as "update file",
    // which would read as nonsense on a CodeQL card, so those are restated here.
    const raw = error instanceof Error ? error.message : '';
    const message = aborted
      ? 'Install cancelled.'
      : /update file returned HTTP/i.test(raw)
        ? 'GitHub would not serve the CodeQL download. The release may have moved; try again later.'
        : raw || 'The CodeQL install failed.';
    report(aborted ? 'cancelled' : 'failed', message);
    currentProgress = null;
    if (aborted) return getCodeqlStatus();
    throw new Error(message);
  }
}

/** CodeQL ships per-language extractor binaries that also need the execute bit on macOS/Linux. */
async function makeToolsExecutable(toolsRoot: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(toolsRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(toolsRoot, entry.name);
    if (entry.isDirectory()) await makeToolsExecutable(full);
    else
      await chmod(full, 0o755).catch(() => {
        // Best effort per file; a single unreadable extractor is not worth failing the install.
      });
  }
}

export async function removeManagedCodeql(): Promise<void> {
  await rm(codeqlInstallDir(), { recursive: true, force: true });
  currentProgress = null;
}
