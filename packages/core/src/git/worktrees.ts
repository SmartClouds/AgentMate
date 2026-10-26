import { baseName, parentPath } from '../workspace/fileOps.js';

/** App-wide worktree preferences (Settings > Agents). */
export interface WorktreeSettings {
  /** Folder new worktrees go in, grouped per repository. Null puts them next to the repository. */
  baseDir: string | null;
  /** Local files (patterns like .gitignore's) copied into a new worktree, e.g. `.env`. */
  copyGlobs: string[];
  /** Whether removing a worktree also deletes its branch, when that branch is merged. */
  deleteBranchOnRemove: boolean;
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  baseDir: null,
  copyGlobs: ['.env', '.env.*'],
  deleteBranchOnRemove: false,
};

/** How a project gets a fresh worktree ready to work in. */
export interface ProjectWorktreeSetup {
  /** Run in a terminal in every new worktree (`pnpm install`, say). Empty runs nothing. */
  command: string;
  /** Replaces the app-wide copy patterns for this project. Null uses the app-wide ones. */
  copyGlobs: string[] | null;
}

export const DEFAULT_PROJECT_WORKTREE_SETUP: ProjectWorktreeSetup = {
  command: '',
  copyGlobs: null,
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Trimmed, non-empty and unique patterns, or null when the value is not a list at all. */
function normalizeGlobs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const globs = value
    .filter((g): g is string => typeof g === 'string')
    .map((g) => g.trim())
    .filter(Boolean);
  return [...new Set(globs)];
}

export function normalizeWorktreeSettings(value: unknown): WorktreeSettings {
  const rec = record(value);
  const baseDir = typeof rec.baseDir === 'string' ? rec.baseDir.trim() : '';
  return {
    baseDir: baseDir || null,
    copyGlobs: normalizeGlobs(rec.copyGlobs) ?? [...DEFAULT_WORKTREE_SETTINGS.copyGlobs],
    deleteBranchOnRemove: rec.deleteBranchOnRemove === true,
  };
}

export function normalizeProjectWorktreeSetup(value: unknown): ProjectWorktreeSetup {
  const rec = record(value);
  return {
    command: typeof rec.command === 'string' ? rec.command.trim() : '',
    copyGlobs: normalizeGlobs(rec.copyGlobs),
  };
}

/** A worktree Runova knows about, as saved in worktrees.json. */
export interface WorktreeRecord {
  /** Short and stable; together with the project id it keys the worktree's workspace. */
  id: string;
  projectId: string;
  path: string;
  /** Null while detached. */
  branch: string | null;
  /** What it was branched from, and where Merge sends it back to. */
  baseBranch: string | null;
  createdAt: string;
  /** False for worktrees made outside Runova that it picked up from git. */
  createdByApp: boolean;
}

/** A saved record as read back from disk, or null when it is missing what a worktree needs. */
export function normalizeWorktreeRecord(value: unknown): WorktreeRecord | null {
  const rec = record(value);
  const text = (key: string): string | null =>
    typeof rec[key] === 'string' && (rec[key] as string).trim() ? (rec[key] as string) : null;
  const id = text('id');
  const projectId = text('projectId');
  const path = text('path');
  if (!id || !projectId || !path) return null;
  return {
    id,
    projectId,
    path,
    branch: text('branch'),
    baseBranch: text('baseBranch'),
    createdAt: text('createdAt') ?? new Date(0).toISOString(),
    createdByApp: rec.createdByApp !== false,
  };
}

/** Live facts about a worktree, read from git when the list is fetched. */
export interface WorktreeStatus {
  /** Changed, staged, untracked and conflicted files together. */
  changes: number;
  /** Commits on the branch that its base does not have, and the other way round. */
  ahead: number;
  behind: number;
  /** The branch's tip is already part of its base. */
  merged: boolean;
  /** Commits not on any remote branch yet. Null when there is no upstream to compare with. */
  unpushed: number | null;
}

export interface WorktreeInfo extends WorktreeRecord {
  /** The folder is gone (deleted outside git). Git will prune it. */
  missing: boolean;
  locked: boolean;
  lockReason?: string;
  /** Null when the folder is missing or git could not read it. */
  status: WorktreeStatus | null;
}

/** One record of `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
  path: string;
  /** Null for a bare repository, which has no checkout. */
  head: string | null;
  /** Short name (`feat/auth`), or null when detached or bare. */
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  /** Git would prune it: its folder is gone or unreadable. */
  prunable: boolean;
  prunableReason?: string;
}

function emptyEntry(path: string): GitWorktreeEntry {
  return {
    path,
    head: null,
    branch: null,
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
}

/** The word before the first space, and whatever follows it. */
function splitField(field: string): [string, string] {
  const space = field.indexOf(' ');
  return space === -1 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
}

/**
 * Parses `git worktree list --porcelain`, with or without `-z`. Records are separated by an
 * empty field, and the first record is always the main worktree.
 */
export function parseWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;
  for (const field of output.split(output.includes('\0') ? '\0' : '\n')) {
    if (field === '') {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, value] = splitField(field);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = emptyEntry(value);
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value || null;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') {
      current.locked = true;
      if (value) current.lockReason = value;
    } else if (key === 'prunable') {
      current.prunable = true;
      if (value) current.prunableReason = value;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Long enough to tell branches apart, short enough to keep Windows paths under their limit. */
const SLUG_MAX = 60;

/** A branch name as a folder name: `feat/Auth Flow!` becomes `feat-auth-flow`. */
export function branchSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'worktree';
}

/**
 * Why git would refuse `name` as a branch, in a sentence for the form, or null when it is fine.
 * Stricter than git in places (no `@`, no unicode), matching what main's `safeBranchName` takes.
 */
export function branchNameProblem(name: string): string | null {
  if (!name) return 'Give the branch a name.';
  if (/\s/.test(name)) return 'Branch names cannot contain spaces.';
  if (!/^[A-Za-z0-9]/.test(name)) return 'Start with a letter or a digit.';
  if (name.includes('..')) return 'Branch names cannot contain "..".';
  if (name.includes('//')) return 'Branch names cannot contain "//".';
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    return 'Use letters, digits, dots, dashes, underscores or slashes.';
  }
  if (name.endsWith('.lock')) return 'Branch names cannot end with ".lock".';
  if (/[/.]$/.test(name)) return 'Branch names cannot end with "/" or ".".';
  return null;
}

/**
 * An AI's branch name suggestion as something git takes: the first line only, no quotes or
 * backticks, lower case, anything else turned into dashes. Null when nothing usable is left.
 */
export function cleanBranchSuggestion(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const name = line
    .replace(/[`"']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, SLUG_MAX)
    .replace(/[-./]+$/, '');
  return name || null;
}

function separatorOf(path: string): '\\' | '/' {
  return path.includes('\\') ? '\\' : '/';
}

function joinPath(folder: string, ...parts: string[]): string {
  const sep = separatorOf(folder);
  return [folder.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/**
 * Where a new worktree goes when the user does not pick a folder: next to the repository in
 * `<repo>.worktrees`, so nothing inside the repo (watchers, search, build tools) ever sees it.
 * A base folder from Settings groups them per repository instead.
 */
export function defaultWorktreePath(
  repoRoot: string,
  branch: string,
  baseDir?: string | null,
): string {
  const slug = branchSlug(branch);
  const repo = baseName(repoRoot);
  if (baseDir) return joinPath(baseDir, repo || 'repo', slug);
  const parent = parentPath(repoRoot);
  // A repository at a drive root has no folder beside it to sit in.
  if (!parent || !repo) return joinPath(repoRoot, 'worktrees', slug);
  return joinPath(parent, `${repo}.worktrees`, slug);
}

/** `candidate`, or `candidate-2`, `candidate-3` and so on, whichever is not taken yet. */
export function uniquePath(candidate: string, exists: (path: string) => boolean): string {
  if (!exists(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!exists(next)) return next;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * A .gitignore-style pattern as a regular expression over forward-slash paths. A pattern with
 * no slash matches a name at any depth; one with a slash is anchored to the root.
 */
function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.includes('/');
  const body = pattern
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '(?:.*/)?'
        : `${escapeRegExp(segment).replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}/`,
    )
    .join('')
    .replace(/\/$/, '')
    .replace(/\(\?:\.\*\/\)\?$/, '.*');
  return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
}

/**
 * The files among `paths` (relative to the repository) that match any of the copy patterns,
 * each once and in their original order. Used to carry local, uncommitted files such as `.env`
 * into a new worktree.
 */
export function matchCopyGlobs(paths: readonly string[], globs: readonly string[]): string[] {
  const patterns = globs
    .map((g) => g.trim())
    .filter(Boolean)
    .map(globToRegExp);
  if (patterns.length === 0) return [];
  return paths.filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return patterns.some((pattern) => pattern.test(normalized));
  });
}
