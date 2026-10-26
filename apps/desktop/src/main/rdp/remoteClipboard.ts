import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Files copied on the server, brought over so Ctrl+V in Explorer pastes them. The Remote Desktop
 * client only lists them (the "Save files" button), and the OS clipboard can't be told to ask for
 * the bytes at paste time, so they are downloaded into a folder here and that folder's entries
 * are put on the clipboard as a file list.
 */

/** Past this the download would hold the window up for no good reason; "Save files" still works. */
export const MAX_STAGED_BYTES = 256 * 1024 * 1024;

const ROOT_NAME = 'runova-rdp-clipboard';

/** Only Windows has a way in place to put a file list on the clipboard. */
export function stagingSupported(): boolean {
  return process.platform === 'win32';
}

function defaultRoot(): string {
  return join(tmpdir(), ROOT_NAME);
}

/**
 * An empty folder for the files of one session's latest server copy. It sits under this
 * process's id so a second running Runova never sweeps it away.
 */
export async function prepareStagingFolder(
  sessionId: string,
  root: string = defaultRoot(),
): Promise<string> {
  const folder = join(root, String(process.pid), sessionId);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  return folder;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive but not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes what earlier runs left behind. The staged files stay on disk after a window closes so
 * a paste still works then, which is why they are only cleaned up when the next run starts.
 */
export async function sweepStaleStaging(
  root: string = defaultRoot(),
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid || isAlive(pid)) return;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

/**
 * Makes `paths` (files or folders) what is copied on this computer. Another program can hold
 * the Windows clipboard open for a moment, so a few quick retries happen inside the script.
 * Paths are handed over in the environment, joined with `|` (which a Windows path can't
 * contain), so no file name can end up parsed as script.
 */
export async function putFilesOnClipboard(paths: string[]): Promise<void> {
  if (!stagingSupported())
    throw new Error('Copying files to the clipboard is only supported on Windows.');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$paths = $env:RUNOVA_CLIPBOARD_PATHS -split '\\|'",
    'for ($i = 0; $i -lt 5; $i++) {',
    '  try { Set-Clipboard -LiteralPath $paths; exit 0 } catch { Start-Sleep -Milliseconds 150 }',
    '}',
    'exit 1',
  ].join('\n');
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, RUNOVA_CLIPBOARD_PATHS: paths.join('|') },
    });
  } catch (cause) {
    throw new Error('Windows would not take the files onto the clipboard. Try again.', { cause });
  }
}
