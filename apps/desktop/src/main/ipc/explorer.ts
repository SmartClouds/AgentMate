import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  appendGitignore,
  copyName,
  type GitignorePattern,
  gitignoreLine,
  isSameOrInside,
  topLevelPaths,
  validateEntryName,
} from '@runova/core';
import { ipcMain, shell } from 'electron';
import type {
  ExplorerDeleteResult,
  ExplorerFileIndex,
  ExplorerGitignoreResult,
  ExplorerMove,
  ExplorerTransferResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { osClipboardPaths } from '../clipboardPaths';
import { indexProjectFiles } from '../explorer/fileIndex';
import { projectFolder } from '../explorer/projectFolder';
import { git, gitOrNull } from '../git/plumbing';
import { runGit } from '../git/versionReview';
import { refreshWorkspaceState } from '../git/workingTreeWatcher';
import { locateRepo } from '../git/workspaceGit';
import { assertPathWithinRoots } from '../pathGuard';

/** A request naming more paths than this is not coming from the explorer. */
const MAX_PATHS = 5000;

/** Windows and macOS file systems ignore case, so `a.ts` and `A.ts` are the same entry there. */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function fold(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

function samePath(a: string, b: string): boolean {
  return fold(resolve(a)) === fold(resolve(b));
}

function inside(child: string, parent: string): boolean {
  return isSameOrInside(fold(resolve(child)), fold(resolve(parent)));
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function assertPathString(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.includes('\0')) {
    throw new Error('That path is not valid.');
  }
}

function assertPathList(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw new Error('No files were given.');
  }
  for (const path of paths) assertPathString(path);
}

/** A folder inside the project (the project folder itself included), followed through links. */
async function guardFolder(folder: string, path: unknown): Promise<string> {
  assertPathString(path);
  const safe = await assertPathWithinRoots(path, [folder]);
  if (!(await stat(safe)).isDirectory()) throw new Error('The target is not a folder.');
  return safe;
}

/**
 * An entry to rename, move or delete. Only its parent has to resolve inside the project: the
 * operation acts on the entry itself, so a link inside the project that points elsewhere is
 * renamed or removed as a link rather than refused. The project folder itself is off limits.
 */
async function guardEntry(folder: string, path: unknown): Promise<string> {
  assertPathString(path);
  const resolved = resolve(path);
  if (samePath(resolved, folder) || dirname(resolved) === resolved) {
    throw new Error('The project folder itself cannot be changed from here.');
  }
  await assertPathWithinRoots(dirname(resolved), [folder]);
  if (!inside(resolved, folder)) {
    throw new Error(`Path "${path}" is outside of the project folder.`);
  }
  if (!(await exists(resolved))) throw new Error(`"${basename(resolved)}" no longer exists.`);
  return resolved;
}

/**
 * A source path from outside the project, such as a file copied in Explorer or dragged in from
 * Finder. Only has to exist: unlike `guardEntry`, it is never required to sit inside a project.
 */
async function assertExternalEntry(path: unknown): Promise<string> {
  assertPathString(path);
  const resolved = resolve(path);
  if (!(await exists(resolved))) throw new Error(`"${basename(resolved)}" no longer exists.`);
  return resolved;
}

function assertName(name: unknown, allowNested: boolean): asserts name is string {
  if (typeof name !== 'string') throw new Error('A file or folder name must be provided.');
  const problem = validateEntryName(name, process.platform, { allowNested });
  if (problem) throw new Error(problem);
}

function alreadyExists(name: string): Error {
  return new Error(`A file or folder named "${name}" already exists at this location.`);
}

/** Pushes fresh git state so badges and the changes list move with the file system. */
function refresh(projectId: string, folder: string): void {
  void refreshWorkspaceState(projectId, folder).catch(() => undefined);
}

/** Copies each entry into `target`, renaming on a name clash. Shared by an internal and an external copy. */
async function copyEntries(target: string, entries: string[]): Promise<ExplorerTransferResult> {
  const taken = new Set(await readdir(target));
  const moves: ExplorerMove[] = [];
  for (const source of entries) {
    const isDirectory = (await lstat(source)).isDirectory();
    if (isDirectory && inside(target, source)) {
      throw new Error(`Cannot copy "${basename(source)}" into itself.`);
    }
    const name = copyName(basename(source), taken, isDirectory);
    taken.add(name);
    const destination = join(target, name);
    await cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    moves.push({ from: source, to: destination });
  }
  return { moves, conflicts: [] };
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    // Another drive or volume: rename can't cross it, so copy then remove.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await rm(from, { recursive: true, force: true });
  }
}

/** Real paths of the repository root and an entry, so `relative` compares like with like. */
async function repoRelative(
  folder: string,
  path: string,
): Promise<{ root: string; rel: string } | null> {
  const repo = await locateRepo(folder);
  if (!repo) return null;
  const [root, parent] = await Promise.all([
    realpath(repo.root).catch(() => repo.root),
    realpath(dirname(path)).catch(() => dirname(path)),
  ]);
  const rel = relative(root, join(parent, basename(path)));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('That path is outside the repository.');
  }
  return { root, rel: rel.replaceAll('\\', '/') };
}

export function registerExplorerHandlers(): void {
  ipcMain.handle(
    IPC.explorer.createFile,
    async (_event, projectId: string, parentDir: unknown, name: unknown): Promise<string> => {
      const folder = await projectFolder(projectId);
      const parent = await guardFolder(folder, parentDir);
      assertName(name, true);
      const segments = name.split(/[\\/]/).filter(Boolean);
      const target = resolve(parent, ...segments);
      await assertPathWithinRoots(target, [folder]);
      if (await exists(target)) throw alreadyExists(segments.join('/'));
      await mkdir(dirname(target), { recursive: true });
      // A trailing slash asks for a folder, the way VS Code reads it.
      if (/[\\/]$/.test(name)) {
        await mkdir(target);
      } else {
        await writeFile(target, '', { flag: 'wx' });
      }
      refresh(projectId, folder);
      return target;
    },
  );

  ipcMain.handle(
    IPC.explorer.createFolder,
    async (_event, projectId: string, parentDir: unknown, name: unknown): Promise<string> => {
      const folder = await projectFolder(projectId);
      const parent = await guardFolder(folder, parentDir);
      assertName(name, true);
      const segments = name.split(/[\\/]/).filter(Boolean);
      const target = resolve(parent, ...segments);
      await assertPathWithinRoots(target, [folder]);
      if (await exists(target)) throw alreadyExists(segments.join('/'));
      await mkdir(target, { recursive: true });
      refresh(projectId, folder);
      return target;
    },
  );

  ipcMain.handle(
    IPC.explorer.rename,
    async (_event, projectId: string, path: unknown, newName: unknown): Promise<string> => {
      const folder = await projectFolder(projectId);
      const source = await guardEntry(folder, path);
      assertName(newName, false);
      const target = join(dirname(source), newName);
      if (target === source) return source;
      if (await exists(target)) {
        // A case-only rename (`readme.md` to `README.md`) finds itself on a case-insensitive
        // file system. The same inode means it is that, not a clash with another entry.
        if (fold(target) !== fold(source)) throw alreadyExists(newName);
        const [a, b] = await Promise.all([
          lstat(source, { bigint: true }),
          lstat(target, { bigint: true }),
        ]);
        if (a.ino !== b.ino || a.dev !== b.dev) throw alreadyExists(newName);
      }
      await rename(source, target);
      refresh(projectId, folder);
      return target;
    },
  );

  ipcMain.handle(
    IPC.explorer.delete,
    async (
      _event,
      projectId: string,
      paths: unknown,
      options: { permanent?: boolean } | undefined,
    ): Promise<ExplorerDeleteResult> => {
      const folder = await projectFolder(projectId);
      assertPathList(paths);
      const targets = await Promise.all(
        topLevelPaths(paths).map((path) => guardEntry(folder, path)),
      );
      const failed: string[] = [];
      for (const target of targets) {
        if (options?.permanent) {
          await rm(target, { recursive: true, force: true });
          continue;
        }
        try {
          await shell.trashItem(target);
        } catch {
          failed.push(target);
        }
      }
      refresh(projectId, folder);
      return { failed };
    },
  );

  ipcMain.handle(
    IPC.explorer.copy,
    async (
      _event,
      projectId: string,
      sources: unknown,
      targetDir: unknown,
    ): Promise<ExplorerTransferResult> => {
      const folder = await projectFolder(projectId);
      assertPathList(sources);
      const target = await guardFolder(folder, targetDir);
      const entries = await Promise.all(
        topLevelPaths(sources).map((path) => guardEntry(folder, path)),
      );
      const result = await copyEntries(target, entries);
      refresh(projectId, folder);
      return result;
    },
  );

  ipcMain.handle(
    IPC.explorer.pasteExternal,
    async (
      _event,
      projectId: string,
      sources: unknown,
      targetDir: unknown,
    ): Promise<ExplorerTransferResult> => {
      const folder = await projectFolder(projectId);
      assertPathList(sources);
      const target = await guardFolder(folder, targetDir);
      const entries = await Promise.all(
        topLevelPaths(sources).map((path) => assertExternalEntry(path)),
      );
      const result = await copyEntries(target, entries);
      refresh(projectId, folder);
      return result;
    },
  );

  ipcMain.handle(IPC.explorer.osClipboardPaths, async (): Promise<string[]> => osClipboardPaths());

  ipcMain.handle(
    IPC.explorer.move,
    async (
      _event,
      projectId: string,
      sources: unknown,
      targetDir: unknown,
      options: { overwrite?: boolean } | undefined,
    ): Promise<ExplorerTransferResult> => {
      const folder = await projectFolder(projectId);
      assertPathList(sources);
      const target = await guardFolder(folder, targetDir);
      const entries = await Promise.all(
        topLevelPaths(sources).map((path) => guardEntry(folder, path)),
      );

      const plan: ExplorerMove[] = [];
      const conflicts: string[] = [];
      for (const source of entries) {
        // Already there: dropping a file back into its own folder does nothing.
        if (samePath(dirname(source), target)) continue;
        if (inside(target, source)) {
          throw new Error(`Cannot move "${basename(source)}" into itself.`);
        }
        const destination = join(target, basename(source));
        if (await exists(destination)) conflicts.push(basename(source));
        plan.push({ from: source, to: destination });
      }
      if (conflicts.length > 0 && !options?.overwrite) return { moves: [], conflicts };

      for (const { from, to } of plan) {
        if (await exists(to)) {
          // The replaced entry goes to the trash when it can, so a wrong answer is recoverable.
          await shell.trashItem(to).catch(() => rm(to, { recursive: true, force: true }));
        }
        await moveEntry(from, to);
      }
      if (plan.length > 0) refresh(projectId, folder);
      return { moves: plan, conflicts: [] };
    },
  );

  ipcMain.handle(
    IPC.explorer.revealInOs,
    async (_event, projectId: string, path: unknown): Promise<void> => {
      const folder = await projectFolder(projectId);
      assertPathString(path);
      const safe = await assertPathWithinRoots(path, [folder]);
      shell.showItemInFolder(safe);
    },
  );

  ipcMain.handle(
    IPC.explorer.addToGitignore,
    async (
      _event,
      projectId: string,
      path: unknown,
      pattern: GitignorePattern,
    ): Promise<ExplorerGitignoreResult> => {
      const folder = await projectFolder(projectId);
      const entry = await guardEntry(folder, path);
      const located = await repoRelative(folder, entry);
      if (!located) throw new Error('This project folder is not a git repository.');
      const isDirectory = (await lstat(entry)).isDirectory();
      const line = gitignoreLine(
        located.rel,
        isDirectory,
        pattern === 'extension' ? 'extension' : 'path',
      );
      if (!line) throw new Error('This file has no extension to ignore.');

      const gitignorePath = join(located.root, '.gitignore');
      const content = await readFile(gitignorePath, 'utf-8').catch(() => '');
      const next = appendGitignore(content, line);
      if (next !== null) await writeFile(gitignorePath, next, 'utf-8');

      const listed = await gitOrNull(located.root, [
        '--literal-pathspecs',
        'ls-files',
        '--error-unmatch',
        '--',
        located.rel,
      ]);
      refresh(projectId, folder);
      return { line, added: next !== null, tracked: listed !== null };
    },
  );

  ipcMain.handle(
    IPC.explorer.untrack,
    async (_event, projectId: string, path: unknown): Promise<void> => {
      const folder = await projectFolder(projectId);
      const entry = await guardEntry(folder, path);
      const located = await repoRelative(folder, entry);
      if (!located) throw new Error('This project folder is not a git repository.');
      await git(located.root, [
        '--literal-pathspecs',
        'rm',
        '-r',
        '--cached',
        '--quiet',
        '--',
        located.rel,
      ]);
      refresh(projectId, folder);
    },
  );

  ipcMain.handle(
    IPC.explorer.listFiles,
    async (_event, projectId: string): Promise<ExplorerFileIndex> => {
      return indexProjectFiles(await projectFolder(projectId));
    },
  );

  ipcMain.handle(
    IPC.explorer.ignoredPaths,
    async (_event, projectId: string, paths: unknown): Promise<string[]> => {
      if (!Array.isArray(paths) || paths.length === 0) return [];
      assertPathList(paths);
      const folder = await projectFolder(projectId);
      const repo = await locateRepo(folder);
      if (!repo) return [];
      const [root, realFolder] = await Promise.all([
        realpath(repo.root).catch(() => repo.root),
        realpath(folder).catch(() => folder),
      ]);
      const folderRel = relative(root, realFolder);
      if (folderRel.startsWith('..') || isAbsolute(folderRel)) return [];

      const byRel = new Map<string, string>();
      for (const path of paths) {
        if (!inside(path, folder)) continue;
        const rel = join(folderRel, relative(folder, resolve(path))).replaceAll('\\', '/');
        if (rel && rel !== '.') byRel.set(rel, path);
      }
      if (byRel.size === 0) return [];

      // check-ignore reads plain paths (it rejects pathspec magic) and exits 1 when nothing
      // matched, which runGit reports as a failure.
      const out = await runGit(
        root,
        ['check-ignore', '--stdin', '-z'],
        `${Array.from(byRel.keys()).join('\0')}\0`,
      ).catch(() => Buffer.alloc(0));
      return out
        .toString('utf8')
        .split('\0')
        .map((rel) => byRel.get(rel))
        .filter((path): path is string => path !== undefined);
    },
  );
}
