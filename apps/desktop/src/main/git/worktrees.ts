import { constants, existsSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import {
  type GitWorktreeEntry,
  matchCopyGlobs,
  parseWorktreeList,
  type WorktreeStatus,
} from '@agentmat/core';
import type { WorktreeMergePreflight, WorktreeMergeResult } from '../../shared/apiTypes';
import {
  currentBranch,
  git,
  gitOrNull,
  parseStatusPorcelain,
  safeBranchName,
  worktreeListPorcelain,
} from './plumbing';

/**
 * `git worktree` for the Workspace: every worktree is a folder of its own on its own branch,
 * sharing one repository, so several agents can work side by side without touching each
 * other's files. Errors are rewritten into sentences the UI can show as they are.
 */

/** A checkout can take a while on a big repository, far longer than a status read. */
const ADD_TIMEOUT_MS = 180000;

/**
 * Windows will not delete a folder while any process has its working directory in it, and a
 * shell that was just killed takes a moment to let go. Waiting this long between tries covers
 * that without making a real failure slow to report.
 */
const REMOVE_RETRY_DELAYS_MS = [300, 800, 1500];

function stderrOf(error: unknown): string {
  const e = error as { stderr?: string; message?: string } | null;
  return (e?.stderr || e?.message || '').trim();
}

/** Paths as the OS spells them, since git prints forward slashes on Windows too. */
function withNativePath(entry: GitWorktreeEntry): GitWorktreeEntry {
  return { ...entry, path: normalize(entry.path) };
}

/**
 * Git lists a worktree by its real folder, which is not always how the app spells it: /var is a
 * link to /private/var on macOS, and Windows can hand out an 8.3 short name like RUNNER~1 for a
 * temp folder. So paths are compared once links are resolved. A folder that is gone keeps its
 * spelling, which still matches git's entry for it.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let full = resolve(p);
    try {
      full = realpathSync.native(full);
    } catch {
      // Gone or unreadable: compare it as written.
    }
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

export async function listWorktrees(cwd: string): Promise<GitWorktreeEntry[]> {
  const output = await worktreeListPorcelain(cwd);
  return parseWorktreeList(output).map(withNativePath);
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (
    (await gitOrNull(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) !== null
  );
}

function folderHasFiles(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export interface AddWorktreeOptions {
  path: string;
  branch: string;
  /** Make `branch` from `base`, or check out a branch that already exists. */
  mode: 'new' | 'existing';
  /** What a new branch starts from. Null starts it from the main checkout's HEAD. */
  base: string | null;
}

export async function addWorktree(
  cwd: string,
  options: AddWorktreeOptions,
): Promise<GitWorktreeEntry> {
  const branch = safeBranchName(options.branch);
  const path = resolve(options.path);
  if (folderHasFiles(path)) {
    throw new Error(
      `The folder ${path} already exists and has files in it. Pick another location.`,
    );
  }

  if (options.mode === 'new') {
    if (await branchExists(cwd, branch)) {
      throw new Error(
        `A branch named '${branch}' already exists. Choose Existing branch to open it in a worktree.`,
      );
    }
  } else {
    const holder = (await listWorktrees(cwd)).find((w) => w.branch === branch);
    if (holder) {
      throw new Error(`'${branch}' is already checked out at ${holder.path}.`);
    }
  }

  const base = options.base ? safeBranchName(options.base) : 'HEAD';
  // `--` keeps git from ever reading the path or the base as an option.
  const args =
    options.mode === 'new'
      ? ['worktree', 'add', '-b', branch, '--', path, base]
      : ['worktree', 'add', '--', path, branch];
  try {
    await git(cwd, args, ADD_TIMEOUT_MS);
  } catch (error) {
    const message = stderrOf(error);
    if (/already checked out|is already used by worktree/i.test(message)) {
      throw new Error(`'${branch}' is already checked out in another worktree.`);
    }
    if (/invalid reference|not a valid object name/i.test(message)) {
      throw new Error(`Could not find '${options.mode === 'new' ? base : branch}' to start from.`);
    }
    throw new Error(message || `Could not create the worktree at ${path}.`);
  }

  const created = (await listWorktrees(cwd)).find((w) => samePath(w.path, path));
  if (!created) throw new Error(`Git reported success, but ${path} is not listed as a worktree.`);
  return created;
}

async function countChanges(cwd: string): Promise<number | null> {
  const output = await gitOrNull(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return output === null ? null : parseStatusPorcelain(output).length;
}

/** Changes, and where the branch stands against its base. Null when the folder is unreadable. */
export async function worktreeStatus(
  path: string,
  base: string | null,
): Promise<WorktreeStatus | null> {
  if (!existsSync(path)) return null;
  const changes = await countChanges(path);
  if (changes === null) return null;

  let ahead = 0;
  let behind = 0;
  let merged = false;
  if (base) {
    const counts = await gitOrNull(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
    const [left, right] = (counts ?? '').trim().split(/\s+/).map(Number);
    behind = Number.isFinite(left) ? (left as number) : 0;
    ahead = Number.isFinite(right) ? (right as number) : 0;
    merged = (await gitOrNull(path, ['merge-base', '--is-ancestor', 'HEAD', base])) !== null;
  }

  const upstream = await gitOrNull(path, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  let unpushed: number | null = null;
  if (upstream?.trim()) {
    const count = await gitOrNull(path, ['rev-list', '--count', '@{u}..HEAD']);
    unpushed = count === null ? null : Number(count.trim()) || 0;
  }
  return { changes, ahead, behind, merged, unpushed };
}

function isBusyError(message: string): boolean {
  return /permission denied|resource busy|being used by another process|directory not empty|unable to (delete|remove)|EBUSY|EPERM/i.test(
    message,
  );
}

/**
 * Removes a worktree and its folder. Without `force` git refuses when there is uncommitted
 * work, which is the point: that refusal is what the Remove dialog's warning is built on.
 */
export async function removeWorktree(
  cwd: string,
  path: string,
  options: { force: boolean },
): Promise<void> {
  const args = ['worktree', 'remove', ...(options.force ? ['--force'] : []), '--', path];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await git(cwd, args);
      return;
    } catch (error) {
      const message = stderrOf(error);
      if (/is not a working tree|not a working tree/i.test(message)) {
        // Already gone from git's side. Tidy up whatever folder is left and the stale entry.
        await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
        await pruneWorktrees(cwd);
        return;
      }
      if (/modified or untracked files|contains modified/i.test(message)) {
        throw new Error('This worktree has uncommitted changes. Commit them or remove it anyway.');
      }
      if (/is locked/i.test(message)) {
        throw new Error('This worktree is locked. Unlock it with git worktree unlock first.');
      }
      const delay = REMOVE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isBusyError(message)) {
        if (isBusyError(message)) {
          throw new Error(
            'Something still has files open in this worktree (a terminal, an editor or a dev server). Close it and try again.',
          );
        }
        throw new Error(message || 'Could not remove the worktree.');
      }
      await new Promise((done) => setTimeout(done, delay));
      // A failed try on Windows can leave git's bookkeeping gone but the folder behind.
      if (!existsSync(path)) {
        await pruneWorktrees(cwd);
        return;
      }
    }
  }
}

/** Forgets worktrees whose folders are gone. */
export async function pruneWorktrees(cwd: string): Promise<void> {
  await git(cwd, ['worktree', 'prune']);
}

/** Checks everything that would make merging a worktree's branch into its base fail or surprise. */
export async function mergePreflight(
  mainCwd: string,
  worktreePath: string,
  branch: string,
  base: string,
): Promise<WorktreeMergePreflight> {
  const ownChanges = (await countChanges(worktreePath)) ?? 0;
  if (ownChanges > 0)
    return { ok: false, blocker: { kind: 'worktree-dirty', changes: ownChanges } };

  const current = (await currentBranch(mainCwd)) || null;
  if (current !== base) return { ok: false, blocker: { kind: 'main-not-on-base', current } };

  const mainChanges = (await countChanges(mainCwd)) ?? 0;
  if (mainChanges > 0) return { ok: false, blocker: { kind: 'main-dirty', changes: mainChanges } };

  const ahead = await gitOrNull(mainCwd, [
    'rev-list',
    '--count',
    `${safeBranchName(base)}..${safeBranchName(branch)}`,
  ]);
  if (Number(ahead?.trim() ?? 0) === 0) return { ok: false, blocker: { kind: 'nothing-to-merge' } };
  return { ok: true };
}

async function conflictedFiles(cwd: string): Promise<string[]> {
  const output = (await gitOrNull(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])) ?? '';
  return output.split('\0').filter(Boolean).sort();
}

/**
 * Merges `branch` into `base` in the main checkout, which must already be on `base` (see
 * `mergePreflight`). A conflict is backed out at once: the main checkout is where other work
 * happens, so it never gets left half-merged. The fix is to merge the base into the worktree
 * instead, where the conflict can be worked through in that worktree's own panel.
 */
export async function mergeIntoBase(
  mainCwd: string,
  branch: string,
  base: string,
): Promise<WorktreeMergeResult> {
  const source = safeBranchName(branch);
  safeBranchName(base);
  try {
    const output = await git(mainCwd, ['merge', '--no-edit', '--', source]);
    return {
      ok: true,
      message: output.trim().split('\n')[0] || `Merged '${source}' into '${base}'.`,
    };
  } catch (error) {
    const conflicts = await conflictedFiles(mainCwd);
    if (conflicts.length > 0) {
      await gitOrNull(mainCwd, ['merge', '--abort']);
      return { ok: false, conflicts };
    }
    throw new Error(stderrOf(error) || `Could not merge '${source}' into '${base}'.`);
  }
}

/** Merges the base into the worktree's branch, leaving any conflict in place to resolve there. */
export async function mergeBaseIntoWorktree(
  worktreePath: string,
  base: string,
): Promise<WorktreeMergeResult> {
  const source = safeBranchName(base);
  try {
    const output = await git(worktreePath, ['merge', '--no-edit', '--', source]);
    return { ok: true, message: output.trim().split('\n')[0] || `Merged '${source}'.` };
  } catch (error) {
    const conflicts = await conflictedFiles(worktreePath);
    if (conflicts.length > 0) return { ok: false, conflicts };
    throw new Error(stderrOf(error) || `Could not merge '${source}'.`);
  }
}

/**
 * Untracked and ignored files in `root` that match the copy patterns, relative to it.
 * `--directory` keeps an ignored folder like node_modules as one entry instead of listing every
 * file in it, which also means nothing inside such a folder is ever copied.
 */
export async function listCopyCandidates(root: string, globs: string[]): Promise<string[]> {
  if (globs.length === 0) return [];
  const [untracked, ignored] = await Promise.all([
    gitOrNull(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    gitOrNull(root, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ]),
  ]);
  const files = [...(untracked ?? '').split('\0'), ...(ignored ?? '').split('\0')].filter(
    (file) => file && !file.endsWith('/'),
  );
  return matchCopyGlobs([...new Set(files)], globs);
}

/** Copies files (relative paths) from one folder to the other. Never overwrites. */
export async function copyFiles(
  fromRoot: string,
  toRoot: string,
  files: string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const file of files) {
    const source = resolve(fromRoot, file);
    const target = resolve(toRoot, file);
    const inside = (root: string, path: string): boolean => {
      const rel = relative(root, path);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!inside(resolve(fromRoot), source) || !inside(resolve(toRoot), target)) {
      throw new Error(`Refusing to copy ${file}: it is outside the repository.`);
    }
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    copied.push(file);
  }
  return copied;
}
