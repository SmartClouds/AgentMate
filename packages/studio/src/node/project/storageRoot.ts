import { randomBytes } from 'node:crypto';
import { realpath, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where a project's videos may live. The user picks the folder per project; it must stay out of
 * the project's source (videos are large and an agent working in the repo must never see or commit
 * them), so the folder is checked on its real path, through any symlink or junction. Problems come
 * back as errors (the folder is refused) or warnings (allowed, with a reason to think twice).
 */

export type RootProblemCode =
  | 'relative'
  | 'inside-project'
  | 'contains-project'
  | 'app-folder'
  | 'system-folder'
  | 'not-writable'
  | 'synced'
  | 'network'
  | 'low-space';

export interface RootProblem {
  code: RootProblemCode;
  level: 'error' | 'warning';
  message: string;
}

export interface RootCheck {
  ok: boolean;
  /** The folder with every link resolved, as far as it exists. */
  resolved: string;
  problems: RootProblem[];
}

export interface RootCheckContext {
  projectFolder?: string | null;
  appDir?: string | null;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Below this much free space the folder gets a warning. */
  minFreeBytes?: number;
  probeWrite?: (existingFolder: string) => Promise<void>;
  freeBytes?: (existingFolder: string) => Promise<number>;
}

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

function pathsFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows, as its file system is. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const p = pathsFor(platform);
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = p.relative(fold(p.resolve(parent)), fold(p.resolve(child)));
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

/** The sync service that keeps a copy of this folder in the cloud, if any. */
export function syncServiceOf(
  folder: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | null {
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key];
    if (root && isWithin(folder, root, platform)) return 'OneDrive';
  }
  const segments = folder.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (segments.some((s) => s === 'onedrive' || s.startsWith('onedrive - '))) return 'OneDrive';
  if (segments.includes('dropbox')) return 'Dropbox';
  if (segments.includes('mobile documents') || segments.includes('icloud drive'))
    return 'iCloud Drive';
  if (
    segments.includes('my drive') ||
    segments.includes('google drive') ||
    segments.includes('googledrive')
  ) {
    return 'Google Drive';
  }
  return null;
}

function systemFolders(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    return [
      env.SystemRoot,
      env.windir,
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      env.ProgramData,
    ].filter((v): v is string => Boolean(v));
  }
  return [
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
    '/var',
    '/opt',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/System',
    '/Library',
    '/private',
  ];
}

/** The real path of the longest part of `target` that exists, with the rest appended. */
async function resolveExisting(
  target: string,
  platform: NodeJS.Platform,
): Promise<{ resolved: string; existing: string | null }> {
  const p = pathsFor(platform);
  // Paths for another OS (in tests) cannot be looked up on this one.
  if (platform !== process.platform) return { resolved: p.resolve(target), existing: null };
  const missing: string[] = [];
  let current = p.resolve(target);
  for (;;) {
    try {
      const real = await realpath(current);
      return { resolved: p.join(real, ...missing.reverse()), existing: real };
    } catch {
      const parent = p.dirname(current);
      if (parent === current) return { resolved: p.resolve(target), existing: null };
      missing.push(p.basename(current));
      current = parent;
    }
  }
}

async function defaultProbe(folder: string): Promise<void> {
  const file = path.join(folder, `.agentmate-probe-${randomBytes(4).toString('hex')}`);
  await writeFile(file, '');
  await unlink(file);
}

async function defaultFreeBytes(folder: string): Promise<number> {
  const stats = await statfs(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}

export async function checkStorageRoot(
  root: string,
  context: RootCheckContext,
): Promise<RootCheck> {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const p = pathsFor(platform);
  const problems: RootProblem[] = [];
  const add = (code: RootProblemCode, level: RootProblem['level'], message: string) =>
    problems.push({ code, level, message });
  const trimmed = root.trim();

  if (!p.isAbsolute(trimmed)) {
    add('relative', 'error', 'Pick a full folder path, such as one in your Videos folder.');
    return { ok: false, resolved: trimmed, problems };
  }

  const { resolved, existing } = await resolveExisting(trimmed, platform);

  if (context.projectFolder) {
    const project = (await resolveExisting(context.projectFolder, platform)).resolved;
    if (isWithin(resolved, project, platform)) {
      add(
        'inside-project',
        'error',
        "Videos can't be stored inside the project's folder. Pick a folder outside it, so they never end up in the repository.",
      );
    } else if (isWithin(project, resolved, platform)) {
      add(
        'contains-project',
        'warning',
        'The project folder is inside this folder. Videos will sit beside it, not in it.',
      );
    }
  }

  if (
    context.appDir &&
    isWithin(resolved, (await resolveExisting(context.appDir, platform)).resolved, platform)
  ) {
    add(
      'app-folder',
      'error',
      "This is inside AgentMate's own folder, which an update replaces. Pick another folder.",
    );
  }

  const isRoot = platform !== 'win32' && resolved === '/';
  if (
    isRoot ||
    systemFolders(platform, env).some((folder) => isWithin(resolved, folder, platform))
  ) {
    add(
      'system-folder',
      'error',
      'This is a system folder. Pick a folder of your own, such as one in your Videos folder.',
    );
  }

  if (platform === 'win32' && trimmed.startsWith('\\\\')) {
    add(
      'network',
      'warning',
      'This is a network folder. Studio works there, but more slowly, and the history file uses a slower safe mode.',
    );
  }

  const sync = syncServiceOf(resolved, platform, env);
  if (sync) {
    add(
      'synced',
      'warning',
      `${sync} syncs this folder. Studio's history file and large videos can conflict with syncing; a folder ${sync} does not sync is safer.`,
    );
  }

  if (existing && !problems.some((x) => x.level === 'error')) {
    try {
      await (context.probeWrite ?? defaultProbe)(existing);
    } catch {
      add(
        'not-writable',
        'error',
        "AgentMate can't write to this folder. Pick one you have permission to change.",
      );
    }
    try {
      const free = await (context.freeBytes ?? defaultFreeBytes)(existing);
      if (free < (context.minFreeBytes ?? MIN_FREE_BYTES)) {
        add(
          'low-space',
          'warning',
          `Only ${(free / 1024 ** 3).toFixed(1)} GB is free on this drive. Rendering needs room for the video and its working files.`,
        );
      }
    } catch {
      // Free space is advice only; a drive that will not say is not a reason to refuse it.
    }
  }

  return { ok: !problems.some((x) => x.level === 'error'), resolved, problems };
}
