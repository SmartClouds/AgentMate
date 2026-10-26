import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  applyLineEdits,
  editsInLineRanges,
  type GitChangeEntry,
  lineEditCount,
  type NumstatEntry,
  parseNumstatZ,
  parseStatusV2,
  withNumstat,
} from '@runova/core';
import { shell } from 'electron';
import type {
  GitApplyLinesInput,
  GitDiffSide,
  GitDiscardResult,
  GitFileDiff,
  GitImageDiff,
  GitLineRanges,
  GitPendingOperation,
  GitStashEntry,
  ImageFileData,
  WorkspaceGitState,
} from '../../shared/apiTypes';
import { imageMimeType } from '../../shared/imageFiles';
import { gitOrNull } from './plumbing';
import { runGit, splitFile } from './versionReview';

/** Past this many untracked files the list is cut; a missing .gitignore should not flood the panel. */
const MAX_UNTRACKED = 2000;
/**
 * Untracked files are in no diff, so git has no line counts for them. The panel's totals read
 * them off disk instead, and these keep that from turning into a scan of the whole tree.
 */
const MAX_COUNTED_UNTRACKED = 1000;
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;
const COUNT_CONCURRENCY = 8;
const MAX_COUNT_CACHE = 20_000;
/** Either side of a diff above this is shown as "too large" instead of loading it into Monaco. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
/** Same idea for the image viewer, which carries the whole picture over as a data URL. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** How long a discard can be undone. */
const UNDO_TTL_MS = 5 * 60_000;
/** A request naming more paths than this is not coming from the panel. */
const MAX_PATHS = 10_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const EMPTY_WORKSPACE_GIT_STATE: WorkspaceGitState = {
  isRepo: false,
  branch: null,
  detached: false,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  hasRemote: false,
  operation: null,
  conflicts: [],
  staged: [],
  unstaged: [],
  untracked: [],
  untrackedTruncated: false,
  projectPrefix: '',
};

interface CountedFile {
  mtimeMs: number;
  size: number;
  additions: number;
  binary: boolean;
}

/**
 * Line counts for untracked files, keyed by repo and path. Agents write constantly and the
 * panel re-reads on every burst, so a file is only opened again once its size or mtime moved.
 */
const untrackedCounts = new Map<string, CountedFile>();

/** Lines in a file, counting a last line that has no newline after it. Empty file is zero. */
function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  let at = -1;
  while ((at = buffer.indexOf(10, at + 1)) !== -1) lines += 1;
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
}

async function countUntracked(root: string, path: string): Promise<NumstatEntry | null> {
  const key = `${root}\\0${path}`;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(join(root, path));
  } catch {
    untrackedCounts.delete(key);
    return null;
  }
  if (!info.isFile()) return null;
  const cached = untrackedCounts.get(key);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return { additions: cached.additions, deletions: 0, binary: cached.binary };
  }
  if (info.size > MAX_COUNTED_BYTES) return null;
  let buffer: Buffer;
  try {
    buffer = await readFile(join(root, path));
  } catch {
    return null;
  }
  // The same sniff git uses: a NUL byte near the start means it is not text.
  const binary = buffer.subarray(0, 8000).includes(0);
  const additions = binary ? 0 : countLines(buffer);
  if (untrackedCounts.size >= MAX_COUNT_CACHE) untrackedCounts.clear();
  untrackedCounts.set(key, { mtimeMs: info.mtimeMs, size: info.size, additions, binary });
  return { additions, deletions: 0, binary };
}

/** Adds line counts to untracked entries, a few files at a time. The rest are left bare. */
async function withUntrackedCounts(
  root: string,
  entries: GitChangeEntry[],
): Promise<GitChangeEntry[]> {
  const counting = entries.slice(0, MAX_COUNTED_UNTRACKED);
  const stats = new Map<string, NumstatEntry>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const entry = counting[next];
      next += 1;
      if (!entry) return;
      const counted = await countUntracked(root, entry.path);
      if (counted) stats.set(entry.path, counted);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(COUNT_CONCURRENCY, counting.length) }, () => worker()),
  );
  return withNumstat(entries, stats);
}

interface RepoLocation {
  root: string;
  gitDir: string;
}

/** The repository a folder belongs to, or null when it is not inside one. */
export async function locateRepo(cwd: string): Promise<RepoLocation | null> {
  const out = await gitOrNull(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  const [root, gitDir] = (out ?? '').split(/\r?\n/).map((line) => line.trim());
  return root && gitDir ? { root: resolve(root), gitDir: resolve(gitDir) } : null;
}

function pendingOperation(gitDir: string): GitPendingOperation | null {
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
    return 'rebase';
  }
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert';
  return null;
}

/**
 * One read of everything the changes panel shows. Four git calls in parallel: status with
 * branch info, line counts for each side, and the remote list. Untracked files have no diff
 * to count, so their lines are read off disk afterwards.
 */
export async function readWorkspaceGitState(cwd: string): Promise<WorkspaceGitState> {
  const repo = await locateRepo(cwd);
  if (!repo) return EMPTY_WORKSPACE_GIT_STATE;
  const { root } = repo;
  const [status, unstagedStat, stagedStat, remotes, realFolder] = await Promise.all([
    // --no-optional-locks keeps the read from rewriting the index, which the watcher would
    // otherwise see as a change and answer with another read.
    gitOrNull(root, [
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
    ]),
    gitOrNull(root, ['--no-optional-locks', 'diff', '--numstat', '-z']),
    gitOrNull(root, ['--no-optional-locks', 'diff', '--cached', '--numstat', '-z']),
    gitOrNull(root, ['remote']),
    realpath(cwd).catch(() => resolve(cwd)),
  ]);
  const prefix = relative(root, realFolder);
  const parsed = parseStatusV2(status ?? '');
  const untracked = await withUntrackedCounts(root, parsed.untracked.slice(0, MAX_UNTRACKED));
  return {
    isRepo: true,
    branch: parsed.branch,
    detached: parsed.detached,
    head: parsed.oid ? parsed.oid.slice(0, 7) : null,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    hasRemote: (remotes ?? '').trim().length > 0,
    operation: pendingOperation(repo.gitDir),
    conflicts: parsed.conflicts,
    staged: withNumstat(parsed.staged, parseNumstatZ(stagedStat ?? '')),
    unstaged: withNumstat(parsed.unstaged, parseNumstatZ(unstagedStat ?? '')),
    untracked,
    untrackedTruncated: parsed.untracked.length > MAX_UNTRACKED,
    projectPrefix:
      prefix.startsWith('..') || isAbsolute(prefix) ? '' : prefix.replaceAll('\\', '/'),
  };
}

/**
 * Checks paths that came from the renderer: repo-relative, no NUL, and inside the repository
 * once resolved. Returns them with forward slashes, the way git prints them.
 */
export function assertRepoPaths(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw new Error('No files were given.');
  }
  return paths.map((path) => {
    if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
      throw new Error('That path is outside the repository.');
    }
    const inside = relative(root, resolve(root, path));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('That path is outside the repository.');
    }
    return inside.replaceAll('\\', '/');
  });
}

/** Runs a git command that takes its paths on stdin, so any number of them fits. */
async function withPathspecs(root: string, args: string[], paths: string[]): Promise<void> {
  await runGit(
    root,
    ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
    `${paths.join('\0')}\0`,
  );
}

async function hasHead(root: string): Promise<boolean> {
  return (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null;
}

export async function stagePaths(root: string, paths: string[]): Promise<void> {
  await withPathspecs(root, ['add', '-A'], paths);
}

export async function unstagePaths(root: string, paths: string[]): Promise<void> {
  if (await hasHead(root)) {
    await withPathspecs(root, ['restore', '--staged'], paths);
    return;
  }
  // Before the first commit there is nothing to restore to; unstaging means untracking.
  await withPathspecs(root, ['rm', '--cached', '-r', '--quiet'], paths);
}

interface DiscardBackup {
  root: string;
  expiresAt: number;
  /** Path to the exact bytes it had, or null when it did not exist (so undo deletes it again). */
  files: { path: string; blobId: string | null }[];
}

const discardBackups = new Map<string, DiscardBackup>();

function pruneBackups(now: number): void {
  for (const [token, backup] of discardBackups) {
    if (backup.expiresAt <= now) discardBackups.delete(token);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** Stores a file's bytes as a loose object, exactly as they are on disk. */
async function backupBlob(root: string, path: string): Promise<string | null> {
  if (!(await isFile(join(root, path)))) return null;
  const id = (await runGit(root, ['hash-object', '-w', '--no-filters', '--', path]))
    .toString('utf8')
    .trim();
  return OBJECT_ID_PATTERN.test(id) ? id : null;
}

/**
 * Throws away working tree changes. Tracked files go back to their staged (or committed)
 * content; untracked files go to the system trash. Either way the bytes are kept as git
 * objects first, so the returned token can put them back.
 */
export async function discardPaths(
  root: string,
  paths: string[],
  side: 'unstaged' | 'untracked',
): Promise<GitDiscardResult> {
  const undoToken = await backupPaths(root, paths);

  if (side === 'untracked') {
    for (const path of paths) {
      const absolute = join(root, path);
      await shell.trashItem(absolute).catch(() => rm(absolute, { force: true }));
    }
  } else {
    await withPathspecs(root, ['restore', '--worktree'], paths);
  }

  const count = paths.length;
  return {
    ok: true,
    message: `Discarded changes in ${count} file${count === 1 ? '' : 's'}.`,
    undoToken,
  };
}

/**
 * Keeps the bytes the files have right now, before something rewrites them, and returns the
 * token undoDiscard() takes to put them back.
 */
export async function backupPaths(root: string, paths: string[]): Promise<string> {
  const now = Date.now();
  pruneBackups(now);
  const files: DiscardBackup['files'] = [];
  for (const path of paths) files.push({ path, blobId: await backupBlob(root, path) });
  const token = randomUUID();
  discardBackups.set(token, { root, files, expiresAt: now + UNDO_TTL_MS });
  return token;
}

export async function undoDiscard(token: string): Promise<void> {
  pruneBackups(Date.now());
  const backup = discardBackups.get(token);
  if (!backup) throw new Error('That change can no longer be undone.');
  discardBackups.delete(token);
  for (const { path, blobId } of backup.files) {
    const absolute = join(backup.root, path);
    if (!blobId) {
      await rm(absolute, { force: true });
      continue;
    }
    const content = await runGit(backup.root, ['cat-file', 'blob', blobId]);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

export async function resolveConflict(
  root: string,
  path: string,
  pick: 'ours' | 'theirs',
): Promise<void> {
  await runGit(root, ['--literal-pathspecs', 'checkout', `--${pick}`, '--', path]);
  await runGit(root, ['--literal-pathspecs', 'add', '--', path]);
}

export async function abortOperation(root: string, gitDir: string): Promise<string> {
  const operation = pendingOperation(gitDir);
  if (!operation) throw new Error('There is nothing to abort.');
  await runGit(root, [operation, '--abort']);
  return `Aborted the ${operation}.`;
}

export async function commitStaged(root: string, message: string): Promise<string> {
  const staged = (await gitOrNull(root, ['diff', '--cached', '--name-only'])) ?? '';
  if (!staged.trim()) throw new Error('Nothing is staged yet.');
  return (await runGit(root, ['commit', '-m', message])).toString('utf8');
}

const STASH_REF_PATTERN = /^stash@\{(\d+)\}$/;

/** `stash@{2}` -> 2, or null when the ref is not a stash the panel listed. */
export function assertStashRef(ref: unknown): { ref: string; index: number } {
  if (typeof ref !== 'string') throw new Error('That is not a stash.');
  const match = STASH_REF_PATTERN.exec(ref.trim());
  if (!match) throw new Error('That is not a stash.');
  return { ref: `stash@{${match[1]}}`, index: Number(match[1]) };
}

/**
 * Stashes the working tree the way VS Code's "Stash All" does. With `includeUntracked` the
 * untracked files go into the stash too (`--include-untracked`); with `keepIndex` the staged
 * changes stay in place and only the rest is stashed (`--keep-index`).
 */
export async function stashPush(
  root: string,
  options: { includeUntracked: boolean; keepIndex: boolean; message?: string },
): Promise<string> {
  const message = options.message?.trim();
  const args = ['stash', 'push'];
  if (message) args.push('-m', message);
  if (options.includeUntracked) args.push('--include-untracked');
  if (options.keepIndex) args.push('--keep-index');
  const out = (await runGit(root, args)).toString('utf8').trim();
  if (/no local changes to save/i.test(out)) {
    throw new Error('There are no changes to stash.');
  }
  return out || 'Stashed the changes.';
}

/** Newest stash first, parsed off `git stash list`. Empty when there is nothing stashed. */
export async function listStashes(root: string): Promise<GitStashEntry[]> {
  const out = (await runGit(root, ['stash', 'list', '--format=%gd%x00%gs'])).toString('utf8');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const nul = line.indexOf('\0');
      if (nul === -1) return [];
      const ref = line.slice(0, nul);
      const message = line.slice(nul + 1).trim();
      const match = STASH_REF_PATTERN.exec(ref);
      if (!match) return [];
      return [{ ref: `stash@{${match[1]}}`, index: Number(match[1]), message }];
    });
}

/**
 * Restores a stash. `pop` drops it after applying; `apply` keeps it. A conflict leaves the
 * working tree the way git left it, with the stash kept, so nothing is lost.
 */
export async function stashRestore(
  root: string,
  ref: string,
  action: 'pop' | 'apply',
): Promise<string> {
  const { ref: safe } = assertStashRef(ref);
  const out = (await runGit(root, ['stash', action, safe])).toString('utf8').trim();
  return out || (action === 'pop' ? `Popped ${safe}.` : `Applied ${safe}.`);
}

export async function stashDrop(root: string, ref: string): Promise<string> {
  const { ref: safe } = assertStashRef(ref);
  const out = (await runGit(root, ['stash', 'drop', safe])).toString('utf8').trim();
  return out || `Dropped ${safe}.`;
}

/** One side of a diff from git's object store, converted the way a checkout would write it. */
async function readBlob(root: string, spec: string): Promise<Buffer | null> {
  try {
    return await runGit(root, ['cat-file', '--filters', spec]);
  } catch {
    try {
      return await runGit(root, ['cat-file', 'blob', spec]);
    } catch {
      return null;
    }
  }
}

async function readWorking(root: string, path: string): Promise<Buffer | null> {
  const absolute = join(root, path);
  if (!(await isFile(absolute))) return null;
  return readFile(absolute);
}

/**
 * Saves an edit made in the diff view. Only an existing regular file is written, the same
 * kind readWorking shows, so a symlink or a deleted file can't be turned into a new write.
 */
export async function writeWorkingFile(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  if (!(await isFile(absolute))) throw new Error(`${path} is no longer a file on disk.`);
  await writeFile(absolute, content, 'utf8');
}

function looksBinary(buffer: Buffer | null): boolean {
  if (!buffer) return false;
  return buffer.subarray(0, 8000).includes(0);
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/i;

export function assertCommitHash(hash: unknown): string {
  if (typeof hash !== 'string' || !COMMIT_HASH_PATTERN.test(hash)) {
    throw new Error('That is not a commit id.');
  }
  return hash;
}

/** The files one commit touched, with line counts. A root commit is compared to nothing. */
export async function readCommitFiles(root: string, hash: string): Promise<GitChangeEntry[]> {
  const [names, stats] = await Promise.all([
    runGit(root, [
      'diff-tree',
      '--root',
      '--no-commit-id',
      '-r',
      '-M',
      '--name-status',
      '-z',
      hash,
    ]),
    runGit(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--numstat', '-z', hash]),
  ]);
  const fields = names.toString('utf8').split('\0');
  const entries: GitChangeEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0] as GitChangeEntry['status'];
    if (letter === 'R' || letter === 'C') {
      const origPath = fields[i + 1] ?? '';
      const path = fields[i + 2] ?? '';
      i += 2;
      if (path) entries.push({ path, origPath, status: letter });
    } else {
      const path = fields[i + 1] ?? '';
      i += 1;
      if (path) entries.push({ path, status: 'MADT'.includes(letter) ? letter : 'M' });
    }
  }
  return withNumstat(entries, parseNumstatZ(stats.toString('utf8')));
}

/** One file as a commit changed it: its parent's version against the commit's. */
export async function readCommitFileDiff(
  root: string,
  hash: string,
  path: string,
  origPath?: string,
): Promise<GitFileDiff> {
  const original = await readBlob(root, `${hash}^:${origPath ?? path}`);
  const modified = await readBlob(root, `${hash}:${path}`);
  const tooLarge =
    (original?.length ?? 0) > MAX_DIFF_BYTES || (modified?.length ?? 0) > MAX_DIFF_BYTES;
  const binary = looksBinary(original) || looksBinary(modified);
  const text = (buffer: Buffer | null): string =>
    tooLarge || binary || !buffer ? '' : buffer.toString('utf8');
  return { path, original: text(original), modified: text(modified), binary, tooLarge };
}

/** The bytes on both sides of a working tree diff: what git has, and what is on disk. */
async function diffSides(
  root: string,
  path: string,
  side: GitDiffSide,
  origPath?: string,
): Promise<{ original: Buffer | null; modified: Buffer | null }> {
  switch (side) {
    case 'staged':
      return {
        original: await readBlob(root, `HEAD:${origPath ?? path}`),
        modified: await readBlob(root, `:0:${path}`),
      };
    case 'unstaged':
      return {
        original: (await readBlob(root, `:0:${path}`)) ?? (await readBlob(root, `HEAD:${path}`)),
        modified: await readWorking(root, path),
      };
    case 'untracked':
      return { original: null, modified: await readWorking(root, path) };
    case 'conflict':
      return {
        original: await readBlob(root, `HEAD:${path}`),
        modified: await readWorking(root, path),
      };
  }
}

export async function readFileDiff(
  root: string,
  path: string,
  side: GitDiffSide,
  origPath?: string,
): Promise<GitFileDiff> {
  const { original, modified } = await diffSides(root, path, side, origPath);
  const tooLarge =
    (original?.length ?? 0) > MAX_DIFF_BYTES || (modified?.length ?? 0) > MAX_DIFF_BYTES;
  const binary = looksBinary(original) || looksBinary(modified);
  const text = (buffer: Buffer | null): string =>
    tooLarge || binary || !buffer ? '' : buffer.toString('utf8');
  const ids = tooLarge || binary ? {} : await diffSideIds(root, path, side, origPath, false);
  return { path, original: text(original), modified: text(modified), binary, tooLarge, ...ids };
}

/** One side of an image diff, wrapped for an `<img src>`. An empty side has nothing to show. */
function imageSide(buffer: Buffer | null, mime: string): ImageFileData | null {
  if (!buffer || buffer.length === 0) return null;
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, bytes: buffer.length };
}

function assertImage(path: string): string {
  const mime = imageMimeType(path);
  if (!mime) throw new Error(`${path} is not an image.`);
  return mime;
}

/** A changed image as the panel shows it: the version git has next to the one on disk. */
export async function readFileImageDiff(
  root: string,
  path: string,
  side: GitDiffSide,
  origPath?: string,
): Promise<GitImageDiff> {
  const mime = assertImage(path);
  const { original, modified } = await diffSides(root, path, side, origPath);
  if (tooLargeToShow(original, modified)) {
    return { path, original: null, modified: null, tooLarge: true };
  }
  return {
    path,
    original: imageSide(original, mime),
    modified: imageSide(modified, mime),
    tooLarge: false,
  };
}

/** The same viewer, for an image as one past commit changed it. */
export async function readCommitFileImageDiff(
  root: string,
  hash: string,
  path: string,
  origPath?: string,
): Promise<GitImageDiff> {
  const mime = assertImage(path);
  const original = await readBlob(root, `${hash}^:${origPath ?? path}`);
  const modified = await readBlob(root, `${hash}:${path}`);
  if (tooLargeToShow(original, modified)) {
    return { path, original: null, modified: null, tooLarge: true };
  }
  return {
    path,
    original: imageSide(original, mime),
    modified: imageSide(modified, mime),
    tooLarge: false,
  };
}

function tooLargeToShow(original: Buffer | null, modified: Buffer | null): boolean {
  return (original?.length ?? 0) > MAX_IMAGE_BYTES || (modified?.length ?? 0) > MAX_IMAGE_BYTES;
}

/** The blob a spec like `HEAD:path` or `:0:path` names, or null when there is none. */
async function resolveBlobId(root: string, spec: string): Promise<string | null> {
  const id = ((await gitOrNull(root, ['rev-parse', '--verify', '--quiet', spec])) ?? '').trim();
  return OBJECT_ID_PATTERN.test(id) ? id : null;
}

/** The id of an empty file, written to the object store so it reads back like any other blob. */
async function emptyBlobId(root: string): Promise<string> {
  return (await runGit(root, ['hash-object', '-w', '--stdin'], '')).toString('utf8').trim();
}

/**
 * The id a working tree file would get if it were staged now (filters applied), or with `raw`
 * the id of its exact bytes. With `write` the blob also goes into the object store.
 */
async function hashWorking(
  root: string,
  path: string,
  options: { write: boolean; raw?: boolean },
): Promise<string | null> {
  if (!(await isFile(join(root, path)))) return null;
  const args = ['hash-object'];
  if (options.write) args.push('-w');
  if (options.raw) args.push('--no-filters');
  const id = (await runGit(root, [...args, '--', path])).toString('utf8').trim();
  return OBJECT_ID_PATTERN.test(id) ? id : null;
}

/** Stored-form blob ids of both sides of a diff, matching what readFileDiff shows. */
async function diffSideIds(
  root: string,
  path: string,
  side: GitDiffSide,
  origPath: string | undefined,
  write: boolean,
): Promise<{ originalId?: string; modifiedId?: string }> {
  let originalId: string | null = null;
  let modifiedId: string | null = null;
  switch (side) {
    case 'staged':
      originalId =
        (await resolveBlobId(root, `HEAD:${origPath ?? path}`)) ?? (await emptyBlobId(root));
      modifiedId = await resolveBlobId(root, `:0:${path}`);
      break;
    case 'unstaged':
      originalId =
        (await resolveBlobId(root, `:0:${path}`)) ?? (await resolveBlobId(root, `HEAD:${path}`));
      modifiedId = await hashWorking(root, path, { write });
      break;
    case 'untracked':
      originalId = await emptyBlobId(root);
      modifiedId = await hashWorking(root, path, { write });
      break;
    case 'conflict':
      return {};
  }
  return originalId && modifiedId ? { originalId, modifiedId } : {};
}

const MAX_LINE_RANGES = 10_000;

/** Checks line ranges that came from the renderer: 1-based pairs, each in order. */
export function assertLineRanges(value: unknown): GitLineRanges {
  const list = (ranges: unknown): [number, number][] => {
    if (!Array.isArray(ranges) || ranges.length > MAX_LINE_RANGES) {
      throw new Error('Those lines could not be read.');
    }
    return ranges.map((range) => {
      const [from, to] = Array.isArray(range) ? range : [];
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw new Error('Those lines could not be read.');
      }
      return [from, to];
    });
  };
  const ranges = (value ?? {}) as Partial<GitLineRanges>;
  return { original: list(ranges.original), modified: list(ranges.modified) };
}

/** The mode of a path's index entry, when it is a plain file that can be split into lines. */
async function indexMode(root: string, path: string): Promise<string | null> {
  const out = await runGit(root, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', path]);
  const mode = /^(\d{6}) /.exec(out.toString('utf8'))?.[1] ?? null;
  return mode === '100644' || mode === '100755' ? mode : null;
}

/** Puts new content in the index for one path, leaving the working file alone. */
async function writeIndexEntry(
  root: string,
  path: string,
  mode: string,
  content: string,
): Promise<void> {
  const stored = await runGit(
    root,
    ['hash-object', '-w', '--no-filters', '--stdin'],
    Buffer.from(content, 'latin1'),
  );
  const id = stored.toString('utf8').trim();
  if (!OBJECT_ID_PATTERN.test(id)) throw new Error(`Could not store the new content of ${path}.`);
  await runGit(root, ['update-index', '--add', '--cacheinfo', mode, id, path]);
}

/** The mode a new file gets when part of it is staged. */
async function untrackedMode(root: string, path: string): Promise<string> {
  if (process.platform === 'win32') return '100644';
  return ((await lstat(join(root, path))).mode & 0o111) !== 0 ? '100755' : '100644';
}

/**
 * Stages, unstages or discards only the picked lines of one file. The ids the diff was read with
 * have to still match, so line numbers from a file that has moved on are never applied to it.
 *
 * Stage and unstage build a new index entry, so they split the stored (filtered) form of both
 * sides. Discard rewrites the working file, so it splits what a checkout would write against the
 * exact bytes on disk, and keeps those bytes for undo the way a whole-file discard does.
 */
export async function applyLineChange(
  root: string,
  request: Omit<GitApplyLinesInput, 'projectId'>,
): Promise<GitDiscardResult> {
  const { path, side, action, origPath } = request;
  const ids = await diffSideIds(root, path, side, origPath, true);
  if (
    !ids.originalId ||
    !ids.modifiedId ||
    ids.originalId !== request.originalId ||
    ids.modifiedId !== request.modifiedId
  ) {
    throw new Error(`${path} changed after the diff was shown. Try again.`);
  }
  const discard = action === 'discard';
  const afterRawId = discard
    ? await hashWorking(root, path, { write: true, raw: true })
    : ids.modifiedId;
  if (!afterRawId) throw new Error(`${path} is no longer a file on disk.`);

  const split = await splitFile(root, path, {
    beforeId: ids.originalId,
    afterId: ids.modifiedId,
    beforeRawId: discard ? null : ids.originalId,
    afterRawId,
  });
  if (!split) {
    throw new Error(`${path} can't be split into separate lines. Use the whole file instead.`);
  }
  const { before, after, hunks } = split;
  const total = hunks.reduce((sum, hunk) => sum + lineEditCount(hunk), 0);
  const picked = editsInLineRanges(hunks, request.ranges);
  if (picked.size === 0) throw new Error('The selected lines have no changes.');
  const every = picked.size === total;
  const lines = `${picked.size} line${picked.size === 1 ? '' : 's'}`;

  if (action === 'stage') {
    if (every) {
      await stagePaths(root, [path]);
      return { ok: true, message: 'Staged.' };
    }
    const mode =
      side === 'untracked' ? await untrackedMode(root, path) : await indexMode(root, path);
    if (!mode) throw new Error(`${path} can't be staged line by line. Stage the whole file.`);
    const leave = new Set(Array.from({ length: total }, (_, index) => index));
    for (const index of picked) leave.delete(index);
    await writeIndexEntry(root, path, mode, applyLineEdits(before, after, hunks, leave));
    return { ok: true, message: `Staged ${lines}.` };
  }

  if (action === 'unstage') {
    // Taking every line out of a new file leaves nothing of it worth keeping in the index.
    if (every && !(await resolveBlobId(root, `HEAD:${origPath ?? path}`))) {
      await unstagePaths(root, [path]);
      return { ok: true, message: 'Unstaged.' };
    }
    const mode = await indexMode(root, path);
    if (!mode) throw new Error(`${path} can't be unstaged line by line. Unstage the whole file.`);
    await writeIndexEntry(root, path, mode, applyLineEdits(before, after, hunks, picked));
    return { ok: true, message: `Unstaged ${lines}.` };
  }

  if (every && side === 'untracked') return discardPaths(root, [path], 'untracked');
  const undoToken = await backupPaths(root, [path]);
  const content = applyLineEdits(before, after, hunks, picked);
  await writeFile(join(root, path), Buffer.from(content, 'latin1'));
  return { ok: true, message: `Discarded ${lines}.`, undoToken };
}
