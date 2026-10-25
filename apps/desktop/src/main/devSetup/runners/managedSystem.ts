import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SpawnStreamingOptions, SpawnStreamingResult } from '../../process/spawnStreaming';
import type { ResumableDownloadOptions } from '../../updater/resumableDownload';
import type { ManagedEnvironment, ManagedKit } from './managed';

/**
 * The real-machine side of the installers that fetch and unpack things themselves. Downloads are
 * limited to the two hosts the vendors publish from, hashing and the file operations are plain
 * Node, and unpacking uses a system tool, which keeps the symlinks and permissions that a
 * JavaScript unzipper tends to lose. That is `tar` (bsdtar on Windows and macOS reads both zips and
 * tarballs), except for a zip on Linux, where GNU tar cannot read it and `unzip` is used instead.
 */

/** Where Flutter and the Android command-line tools are published. Nothing else is fetched. */
const ALLOWED_HOSTS = new Set(['storage.googleapis.com', 'dl.google.com']);
const REFUSED = 'Refusing to download from that address.';
/** Unpacking prints nothing while it works; a gigabyte can take a while. */
const EXTRACT_IDLE_MS = 20 * 60_000;
/** What Windows says about a folder a virus scanner or indexer has open for a moment. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_RETRIES = 4;
const RENAME_RETRY_DELAY_MS = 250;

/**
 * Where Studio's local voices come from (E37): Python builds (GitHub releases), wheels (PyPI,
 * PyTorch and NVIDIA's CUDA libraries) and models (Hugging Face).
 */
export const STUDIO_TOOL_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'files.pythonhosted.org',
  'download.pytorch.org',
  'download-r2.pytorch.org',
  'pypi.nvidia.com',
  'huggingface.co',
]);

/** Throws unless the address is https on a host the installers are allowed to fetch from. */
export function assertAllowedUrl(address: string, hosts: ReadonlySet<string> = ALLOWED_HOSTS): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(REFUSED);
  }
  // Plain http only for a loopback fake server that a test run put on the list itself.
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
  if (!secure || !hosts.has(url.hostname) || url.username || url.password) {
    throw new Error(REFUSED);
  }
  return url;
}

export interface ManagedSystemDeps {
  netFetchText: (url: string) => Promise<string>;
  createDownload: () => {
    run: (options: ResumableDownloadOptions) => Promise<void>;
    abort: () => void;
  };
  spawn: (options: SpawnStreamingOptions) => Promise<SpawnStreamingResult>;
  /** The hosts this kit may download from; Flutter and Android's by default. */
  allowedHosts?: ReadonlySet<string>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Moves a file or folder, trying again a few times when it is busy. Node's `rm` has a retry option
 * for this and `rename` does not, and a freshly unpacked folder is exactly what scanners open.
 * The wait grows with each try, like `rm`'s does, and anything but a busy error is thrown at once.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  {
    rename: move = rename,
    wait = sleep,
  }: { rename?: (from: string, to: string) => Promise<void>; wait?: typeof sleep } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt > RENAME_RETRIES || code === undefined || !BUSY_CODES.has(code)) throw error;
      await wait(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

function hashFile(path: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function createManagedKit(env: ManagedEnvironment, deps: ManagedSystemDeps): ManagedKit {
  const tar =
    env.os === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  return {
    ...env,

    // async, so a refused address is a rejected promise like any other failure, not a throw.
    fetchText: async (url) => {
      assertAllowedUrl(url, deps.allowedHosts);
      return deps.netFetchText(url);
    },

    download: async (request, hooks) => {
      assertAllowedUrl(request.url, deps.allowedHosts);
      await mkdir(dirname(request.destPath), { recursive: true });
      const download = deps.createDownload();
      hooks.registerAbort(() => download.abort());
      await download.run({
        url: request.url,
        destPath: request.destPath,
        expectedSize: request.expectedSize,
        userAgent: 'AgentMate Dev Setup',
        onProgress: (progress) => hooks.onProgress(progress.transferred, progress.total),
        onReconnect: (attempt, transferred) => hooks.onReconnect?.(attempt, transferred),
      });
    },

    hashFile,

    extract: async (archive, destDir, { token, onLine }) => {
      // GNU tar, which is what Linux has, cannot read a zip. bsdtar (Windows, macOS) can, so only
      // a zip on Linux goes elsewhere: to unzip, or to bsdtar for a machine that has that instead.
      const zipOnLinux = env.os === 'linux' && /\.zip$/i.test(archive);
      const tools = zipOnLinux
        ? [
            { name: 'unzip', command: 'unzip', args: ['-q', archive, '-d', destDir] },
            { name: 'bsdtar', command: 'bsdtar', args: ['-xf', archive, '-C', destDir] },
          ]
        : [{ name: 'tar', command: tar, args: ['-xf', archive, '-C', destDir] }];

      for (const tool of tools) {
        let lastLine = '';
        const result = await deps.spawn({
          command: tool.command,
          args: tool.args,
          cwd: destDir,
          timeoutMs: EXTRACT_IDLE_MS,
          idle: true,
          token,
          onLine: (line) => {
            if (line.trim()) lastLine = line.trim();
            onLine(line);
          },
        });
        if (result.notFound) continue;
        if (result.cancelled) return { ok: false, message: 'Cancelled.' };
        if (result.timedOut) return { ok: false, message: 'Unpacking stopped responding.' };
        if (result.code === 0) return { ok: true };
        return { ok: false, message: lastLine || `${tool.name} stopped with code ${result.code}.` };
      }
      return {
        ok: false,
        message: zipOnLinux
          ? 'Install unzip (for example sudo apt install unzip) and try again.'
          : 'The tar command was not found.',
      };
    },

    fs: {
      exists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      mkdir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      // A virus scanner or indexer can hold a freshly unpacked folder for a moment on Windows.
      rm: (path) => rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }),
      rename: (from, to) => renameWithRetry(from, to),
      isEmptyDir: async (path) => {
        try {
          return (await readdir(path)).length === 0;
        } catch {
          return false;
        }
      },
    },

    randomId: () => randomBytes(4).toString('hex'),
  };
}
