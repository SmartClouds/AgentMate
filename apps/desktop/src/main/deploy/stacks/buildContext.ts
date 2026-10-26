import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type DockerignoreMatcher, dockerCleanPath, parseDockerignore } from '@runova/core';
import { create } from 'tar';

/**
 * Packs a stack's build context into the .tar.gz the server core unpacks before `docker compose
 * build`. It holds what Docker would send to its builder and nothing that .dockerignore leaves
 * out, so secrets, .git and node_modules never leave this computer. The Dockerfile and the ignore
 * file always go in, as Docker always sends them; the server's builder reads the ignore file
 * again on its side.
 *
 * The caps are the server core's own (TarExtractionLimits.Default in
 * apps/server-core/src/Runova.ServerCore/Uploads), so a context packed here is never refused
 * there for its size. A context over them is refused before anything is written, with the
 * folders that make it big. Links that lead out of the context are refused too, since the core
 * would refuse them; sockets, pipes and devices are left out, as Docker leaves out sockets.
 */

export const MAX_BUILD_CONTEXT_BYTES = 256 * 1024 * 1024;
export const MAX_BUILD_CONTEXT_ENTRIES = 50_000;

export type BuildContextErrorCode =
  | 'too-large'
  | 'too-many-entries'
  | 'link-outside'
  | 'ignore-file'
  | 'output-inside'
  | 'not-a-folder';

export class BuildContextError extends Error {
  constructor(
    message: string,
    readonly code: BuildContextErrorCode,
    /** For `too-large`: the biggest top-level files and folders, largest first. */
    readonly largest: { path: string; bytes: number }[] = [],
  ) {
    super(message);
    this.name = 'BuildContextError';
  }
}

export interface BuildContextOptions {
  /** The folder the build runs in: the service's build context. */
  root: string;
  /** Where the .tar.gz goes. It may not be inside `root`. */
  output: string;
  /** The ignore file, relative to `root`. Defaults to `.dockerignore`. */
  ignoreFile?: string;
  /**
   * Files that go in even when the ignore file leaves them out, relative to `root`: a Dockerfile
   * with another name or in another folder. The Dockerfile and the ignore file always do.
   */
  alwaysInclude?: readonly string[];
  maxBytes?: number;
  maxEntries?: number;
  /**
   * Give every file and folder mode 0755, as the Docker CLI does when it builds from Windows,
   * where files carry no execute bit. Defaults to whether this computer runs Windows.
   */
  windowsModes?: boolean;
}

export interface BuildContextResult {
  /** The archive written. */
  path: string;
  /** Files, folders and links packed. */
  entries: number;
  /** Bytes of file contents packed, before compression. */
  contentBytes: number;
  /** Size of the archive itself. */
  archiveBytes: number;
  /** SHA-256 of the archive, so the upload can be checked on arrival. */
  sha256: string;
  /** Sockets, pipes and devices that were left out. */
  skipped: string[];
}

function describeBytes(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 3, 'GB'],
    [1024 ** 2, 'MB'],
    [1024, 'KB'],
  ];
  for (const [size, unit] of units) {
    if (bytes >= size) return `${Number((bytes / size).toFixed(1))} ${unit}`;
  }
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

async function readMatcher(root: string, ignoreFile: string): Promise<DockerignoreMatcher | null> {
  let text: string;
  try {
    text = await readFile(join(root, ignoreFile), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseDockerignore(text);
  if (!parsed.ok) {
    throw new BuildContextError(
      `${ignoreFile}, line ${parsed.line}: ${parsed.reason}`,
      'ignore-file',
    );
  }
  return parsed.matcher;
}

/** What the walk found to pack. */
interface Walked {
  paths: string[];
  bytes: number;
  skipped: string[];
  sizeByTop: Map<string, number>;
}

async function walk(
  root: string,
  matcher: DockerignoreMatcher | null,
  forced: ReadonlySet<string>,
  maxEntries: number,
): Promise<Walked> {
  const walked: Walked = { paths: [], bytes: 0, skipped: [], sizeByTop: new Map() };
  const forcedInside = (folder: string) =>
    [...forced].some((path) => path.startsWith(`${folder}/`));
  const add = (path: string) => {
    walked.paths.push(path);
    if (walked.paths.length > maxEntries) {
      throw new BuildContextError(
        `The build context has more than ${maxEntries} files and folders, more than the server accepts. Add folders the build does not need, such as node_modules or .git, to .dockerignore.`,
        'too-many-entries',
      );
    }
  };

  const visit = async (folder: string, prefix: string): Promise<void> => {
    const children = await readdir(folder, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = join(folder, child.name);
      const excluded = !forced.has(path) && (matcher?.excludes(path) ?? false);
      if (child.isDirectory()) {
        if (excluded && matcher?.canSkipFolder(path) && !forcedInside(path)) continue;
        if (!excluded) add(path);
        await visit(absolute, path);
        continue;
      }
      if (excluded) continue;
      if (child.isFile()) {
        const { size } = await lstat(absolute);
        walked.bytes += size;
        const top = path.split('/')[0];
        walked.sizeByTop.set(top, (walked.sizeByTop.get(top) ?? 0) + size);
        add(path);
      } else if (child.isSymbolicLink()) {
        checkLink(path, await readlink(absolute));
        add(path);
      } else {
        walked.skipped.push(path);
      }
    }
  };

  await visit(root, '');
  return walked;
}

/**
 * Docker sends a link as a link, and the server core refuses one that leads out of the folder
 * it unpacks into, so such a link is refused here, before the upload.
 */
function checkLink(path: string, rawTarget: string): void {
  const target = rawTarget.replaceAll('\\', '/');
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const lands = dockerCleanPath(parent ? `${parent}/${target}` : target);
  const absolute = target.startsWith('/') || /^[A-Za-z]:/.test(target);
  if (absolute || lands === '..' || lands.startsWith('../')) {
    throw new BuildContextError(
      `${path} is a link to ${rawTarget}, which is outside the build context. Docker would send the link, not what it points to, and the server refuses links that leave the folder. Copy the file into the project or leave the link out with .dockerignore.`,
      'link-outside',
    );
  }
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function buildContextTarball(
  options: BuildContextOptions,
): Promise<BuildContextResult> {
  const root = resolve(options.root);
  const output = resolve(options.output);
  const maxBytes = options.maxBytes ?? MAX_BUILD_CONTEXT_BYTES;
  const maxEntries = options.maxEntries ?? MAX_BUILD_CONTEXT_ENTRIES;
  const ignoreFile = options.ignoreFile ?? '.dockerignore';
  const windowsModes = options.windowsModes ?? process.platform === 'win32';

  const folder = await stat(root).catch(() => null);
  if (!folder?.isDirectory()) {
    throw new BuildContextError(
      `${options.root} is not a folder, so it cannot be a build context.`,
      'not-a-folder',
    );
  }
  const inside = relative(root, output);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new BuildContextError(
      'The archive would be written inside the folder it packs. Write it somewhere else, such as the temp folder.',
      'output-inside',
    );
  }

  const matcher = await readMatcher(root, ignoreFile);
  const forced = new Set(
    ['Dockerfile', ignoreFile, ...(options.alwaysInclude ?? [])].map((path) =>
      dockerCleanPath(path.replaceAll('\\', '/')),
    ),
  );
  const walked = await walk(root, matcher, forced, maxEntries);

  if (walked.bytes > maxBytes) {
    const largest = [...walked.sizeByTop.entries()]
      .map(([path, bytes]) => ({ path, bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3);
    const parts = listNames(largest.map((part) => `${part.path} (${describeBytes(part.bytes)})`));
    throw new BuildContextError(
      `The build context is ${describeBytes(walked.bytes)}, more than the ${describeBytes(maxBytes)} the server accepts. The largest parts are ${parts}. Add the ones the build does not need to .dockerignore.`,
      'too-large',
      largest,
    );
  }

  await create(
    {
      file: output,
      cwd: root,
      gzip: true,
      portable: true,
      noDirRecurse: true,
      follow: false,
      onWriteEntry: (entry) => {
        if (windowsModes && entry.stat && entry.type !== 'SymbolicLink') {
          entry.stat.mode = (entry.stat.mode & ~0o777) | 0o755;
        }
      },
    },
    walked.paths,
  );

  return {
    path: output,
    entries: walked.paths.length,
    contentBytes: walked.bytes,
    archiveBytes: (await stat(output)).size,
    sha256: await sha256Of(output),
    skipped: walked.skipped,
  };
}
