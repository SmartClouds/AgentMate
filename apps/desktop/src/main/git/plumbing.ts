import { execFile } from 'node:child_process';
import { normalize } from 'node:path';
import { promisify } from 'node:util';
import { parseWorktreeList } from '@agentmat/core';
import type {
  GitBranchHistory,
  GitBranchInfo,
  GitCommitInfo,
  GitDayCount,
  GitFileChange,
  GitOpResult,
  GitStatus,
  GitTagInfo,
} from '../../shared/apiTypes';
import { isRunningUnderRosetta, isXcrunArchMismatch, ROSETTA_GIT_MESSAGE } from '../system/rosetta';
import { ghApi, isGhCliAvailable, parseGithubRemote } from './githubCli';
import { splitTagPrefix, tagHasPrefix } from './versioning';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30000;
/** Pushing a whole project for the first time can take a while on a slow line. */
export const PUSH_TIMEOUT_MS = 180000;
const MAX_DIFF_CHARS = 8000;

const HISTORY_COMMIT_LIMIT = 100;
/** How far back the contribution grid goes, for both the git and the GitHub views. */
export const ACTIVITY_DAYS = 84;

/** What git accepts for a branch, minus anything it would read as an option. */
export const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/**
 * Refuses shell-ish and git-illegal tag names up front; git itself is the final word.
 * `@` is in there for monorepos that tag packages the npm way, as `@acme/web@1.4.0`.
 */
export const TAG_NAME_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9._/+@-]*$/;

const RECENT_TAG_LIMIT = 8;

/**
 * The environment every git the app spawns runs with.
 *
 * Nobody can answer a credential prompt in a hidden process, so a command that would ask for
 * one should fail with a readable error instead of sitting there until the timeout.
 *
 * GIT_OPTIONAL_LOCKS=0 stops reads like `status` from taking `.git/index.lock` just to refresh
 * the index. The app polls status constantly (the repo watcher, every git query refetch), and a
 * read holding that lock is exactly what made a commit fail at random with "index.lock: File
 * exists". Writes still take the lock, since for them it isn't optional.
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

/**
 * How long to wait between tries when another git holds a lock. It adds up to about two
 * seconds, far longer than any status or add from an editor or an agent holds one, and short
 * enough that a lock left behind by a crashed git still fails fast with git's own message.
 */
const LOCK_RETRY_DELAYS_MS = [100, 200, 400, 600, 800];

/** True when git gave up because another process holds a lock (index, ref or config). */
export function isGitLockBusy(error: unknown): boolean {
  const stderr = (error as { stderr?: string } | null)?.stderr ?? '';
  return /\.lock'?: File exists/i.test(stderr);
}

export async function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: GIT_ENV,
      });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string } | null)?.stderr ?? '';
      if (isXcrunArchMismatch(stderr) && isRunningUnderRosetta()) {
        throw new Error(ROSETTA_GIT_MESSAGE);
      }
      // git checks for the lock before it changes anything, so trying again is always safe.
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isGitLockBusy(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * `git()` for commands that are allowed to fail. Null means the command failed,
 * which callers can tell apart from the empty string it printed on success.
 */
export async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null);
}

/**
 * `git worktree list --porcelain`, NUL separated where git can do that. `-z` arrived in git 2.36,
 * and Ubuntu 22.04 still ships 2.34, which refuses the switch. parseWorktreeList reads either form.
 */
export async function worktreeListPorcelain(cwd: string): Promise<string> {
  try {
    return await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown } | null)?.stderr ?? '');
    if (!/unknown switch [`']z'/.test(stderr)) throw error;
    return git(cwd, ['worktree', 'list', '--porcelain']);
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const out = await gitOrNull(cwd, ['rev-parse', '--is-inside-work-tree']);
  return out?.trim() === 'true';
}

export async function currentBranch(cwd: string): Promise<string> {
  return ((await gitOrNull(cwd, ['branch', '--show-current'])) ?? '').trim();
}

/**
 * Trims and collapses whitespace, then refuses anything git would not take as a
 * refname. Leading dashes matter most: git parses a positional `--upload-pack=…`
 * as an option, so an unchecked branch name turns a checkout into a command run.
 */
export function safeBranchName(name: string): string {
  const sanitized = name.trim().replace(/\s+/g, '-');
  if (!sanitized) throw new Error('Branch name cannot be empty.');
  if (!BRANCH_NAME_PATTERN.test(sanitized) || sanitized.includes('..')) {
    throw new Error(
      'Invalid branch name. Use letters, digits, dots, dashes, underscores or slashes (e.g. main).',
    );
  }
  return sanitized;
}

export async function primaryRemote(cwd: string): Promise<string | null> {
  const remotes = ((await gitOrNull(cwd, ['remote'])) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? null;
}

async function listRefNames(cwd: string, pattern: string): Promise<string[]> {
  const output =
    (await gitOrNull(cwd, ['for-each-ref', '--format=%(refname:short)', pattern])) ?? '';
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Branches checked out in some other worktree, with that worktree's folder. The branch the
 * current checkout is on is left out: it is here, not elsewhere.
 */
async function branchesInOtherWorktrees(
  cwd: string,
  current: string,
): Promise<Map<string, string>> {
  const output = await worktreeListPorcelain(cwd).catch(() => '');
  const held = new Map<string, string>();
  for (const entry of parseWorktreeList(output)) {
    if (entry.branch && entry.branch !== current) held.set(entry.branch, normalize(entry.path));
  }
  return held;
}

/** The folder of the other worktree that has `branch` checked out, or null when none does. */
export async function worktreeHolding(cwd: string, branch: string): Promise<string | null> {
  const held = await branchesInOtherWorktrees(cwd, await currentBranch(cwd));
  return held.get(branch) ?? null;
}

/**
 * `remote` and `branch` are optional so a caller that already resolved them (see
 * `readStatus`) doesn't pay for the same two subprocesses twice.
 */
export async function listBranches(
  cwd: string,
  known: { remote?: string | null; branch?: string } = {},
): Promise<GitBranchInfo[]> {
  const remote = known.remote === undefined ? await primaryRemote(cwd) : known.remote;
  const [localRefs, remoteRefs, current] = await Promise.all([
    listRefNames(cwd, 'refs/heads'),
    remote ? listRefNames(cwd, `refs/remotes/${remote}`) : Promise.resolve<string[]>([]),
    known.branch === undefined ? currentBranch(cwd) : Promise.resolve(known.branch),
  ]);

  const localNames = new Set(localRefs);
  if (current) localNames.add(current);
  const elsewhere = await branchesInOtherWorktrees(cwd, current);

  const remoteNames = new Set<string>();
  if (remote) {
    const prefix = `${remote}/`;
    for (const ref of remoteRefs) {
      const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      if (name && name !== 'HEAD') remoteNames.add(name);
    }
  }

  return [...new Set([...localNames, ...remoteNames])]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const worktreePath = elsewhere.get(name);
      return {
        name,
        local: localNames.has(name),
        remote: remoteNames.has(name),
        ...(worktreePath ? { worktreePath } : {}),
      };
    });
}

/** Best-effort guess at the repo's primary branch, e.g. "main" vs "master". */
export async function detectDefaultBranch(
  cwd: string,
  remote?: string | null,
): Promise<string | null> {
  const remoteName = remote === undefined ? await primaryRemote(cwd) : remote;
  if (remoteName) {
    const symbolicRef = (
      (await gitOrNull(cwd, ['symbolic-ref', '--short', `refs/remotes/${remoteName}/HEAD`])) ?? ''
    ).trim();
    if (symbolicRef) {
      const prefix = `${remoteName}/`;
      return symbolicRef.startsWith(prefix) ? symbolicRef.slice(prefix.length) : symbolicRef;
    }
  }

  for (const candidate of ['main', 'master']) {
    const exists = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])
      .then(() => true)
      .catch(() => false);
    if (exists) return candidate;
  }
  return null;
}

/**
 * Parses `status --porcelain -z`. The NUL separator is what makes this reliable:
 * it turns off git's octal quoting of non-ASCII names, and it puts a rename's old
 * path in a field of its own instead of writing `old -> new` on the status line.
 */
export function parseStatusPorcelain(output: string): GitFileChange[] {
  const fields = output.split('\0');
  const changes: GitFileChange[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    changes.push({ x, y, path: entry.slice(3) });
    // A rename or copy is followed by the path it came from; skip that field.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') i += 1;
  }
  return changes;
}

export async function readStatus(cwd: string): Promise<GitStatus> {
  if (!(await isGitRepo(cwd))) {
    return {
      isRepo: false,
      branch: null,
      defaultBranch: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [],
      branches: [],
    };
  }

  const [branchName, remote] = await Promise.all([currentBranch(cwd), primaryRemote(cwd)]);
  // Everything below is independent of everything else, and each one is a
  // process spawn (30-80ms apiece on Windows), so they go out together.
  const [defaultBranch, branches, counts, porcelain] = await Promise.all([
    detectDefaultBranch(cwd, remote),
    listBranches(cwd, { remote, branch: branchName }),
    gitOrNull(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    // --no-optional-locks keeps the read from refreshing (and rewriting) the index, which
    // would otherwise look like a repo change to the watcher and bounce back as another read.
    gitOrNull(cwd, ['--no-optional-locks', 'status', '--porcelain', '-z']),
  ]);

  let ahead = 0;
  let behind = 0;
  if (counts?.trim()) {
    const [a, b] = counts.trim().split(/\s+/);
    ahead = parseInt(a, 10) || 0;
    behind = parseInt(b, 10) || 0;
  }

  return {
    isRepo: true,
    branch: branchName || null,
    defaultBranch,
    ahead,
    behind,
    hasRemote: remote !== null,
    files: parseStatusPorcelain(porcelain ?? ''),
    branches,
  };
}

/** Git checks a branch out in one worktree at a time; this says where to go instead. */
function openElsewhereError(branch: string, worktreePath: string): Error {
  return new Error(
    `'${branch}' is open in the worktree at ${worktreePath}. Open that worktree to work on it.`,
  );
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<string> {
  const sanitized = safeBranchName(branchName);

  const current = await currentBranch(cwd);
  if (current === sanitized) return `Already on '${sanitized}'.`;

  const branches = await listBranches(cwd);
  const info = branches.find((branch) => branch.name === sanitized);
  if (!info) {
    throw new Error(`Branch '${sanitized}' was not found locally or on the remote.`);
  }
  if (info.worktreePath) throw openElsewhereError(sanitized, info.worktreePath);

  if (info.local) {
    return git(cwd, ['checkout', sanitized]);
  }

  const remote = await primaryRemote(cwd);
  if (!remote || !info.remote) {
    throw new Error(`Branch '${sanitized}' is not available locally or on a remote.`);
  }

  // `--` so git reads the name as a refspec even if a future validation change
  // ever lets a leading dash through.
  await gitOrNull(cwd, ['fetch', remote, '--', sanitized]);
  return git(cwd, ['checkout', '--track', `${remote}/${sanitized}`]);
}

interface GithubApiRepoDefaultBranch {
  default_branch: string | null;
}

export async function setDefaultBranch(cwd: string, branchName: string): Promise<string> {
  const sanitized = safeBranchName(branchName);

  const remote = await primaryRemote(cwd);
  if (!remote) {
    throw new Error('Connect a remote before changing the default branch.');
  }

  const branches = await listBranches(cwd, { remote });
  const info = branches.find((branch) => branch.name === sanitized);
  if (!info) throw new Error(`Branch '${sanitized}' was not found.`);
  if (!info.remote) {
    throw new Error(`Push '${sanitized}' before making it the default branch.`);
  }

  const currentDefault = await detectDefaultBranch(cwd, remote);
  if (currentDefault === sanitized) {
    return `'${sanitized}' is already the default branch.`;
  }

  const remoteUrl = ((await gitOrNull(cwd, ['remote', 'get-url', remote])) ?? '').trim();
  const parsed = parseGithubRemote(remoteUrl);
  if (parsed && (await isGhCliAvailable())) {
    await ghApi<GithubApiRepoDefaultBranch>(`repos/${parsed.owner}/${parsed.repo}`, [
      '-X',
      'PATCH',
      '-f',
      `default_branch=${sanitized}`,
    ]);
    await git(cwd, ['remote', 'set-head', remote, sanitized]);
    return `Default branch is now '${sanitized}' on GitHub.`;
  }

  await git(cwd, ['remote', 'set-head', remote, sanitized]);
  if (parsed) {
    return `Local remote HEAD now points at '${sanitized}'. Install and sign in to the GitHub CLI to change it on GitHub too.`;
  }
  return `Remote HEAD now points at '${sanitized}'.`;
}

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The trailing `days`-long calendar window both contribution grids are drawn on,
 * filled from `byDate` where it has a count. Pass an empty map for an empty grid.
 */
export function recentDays(byDate: Map<string, number>, days: number): GitDayCount[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const result: GitDayCount[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const date = localIsoDate(day);
    result.push({ date, count: byDate.get(date) ?? 0 });
  }
  return result;
}

async function resolveBranchRef(cwd: string, branchName: string): Promise<string> {
  const sanitized = safeBranchName(branchName);
  const branches = await listBranches(cwd);
  const info = branches.find((branch) => branch.name === sanitized);
  if (!info) throw new Error(`Branch '${sanitized}' was not found.`);
  if (info.local) return sanitized;
  const remote = await primaryRemote(cwd);
  if (remote && info.remote) return `${remote}/${sanitized}`;
  throw new Error(`Branch '${sanitized}' is not available locally or on a remote.`);
}

function parseLogTags(decorations: string): string[] {
  if (!decorations) return [];
  const tags: string[] = [];
  for (const part of decorations.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('tag: ')) tags.push(trimmed.slice(5));
  }
  return tags;
}

function parseCommitLog(output: string): GitCommitInfo[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, date, parents, decorations, subject] = record.split('\x1f');
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        author: author ?? '',
        date: date ?? '',
        subject: subject ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        tags: parseLogTags(decorations ?? ''),
      };
    })
    .filter((commit) => commit.hash.length > 0);
}

export async function readBranchHistory(
  cwd: string,
  branchName: string,
): Promise<GitBranchHistory> {
  const sanitized = safeBranchName(branchName);
  const ref = await resolveBranchRef(cwd, sanitized);
  const pretty = '%H%x1f%h%x1f%an%x1f%aI%x1f%P%x1f%D%x1f%s%x1e';
  const since = new Date();
  since.setDate(since.getDate() - ACTIVITY_DAYS);

  const [log, activityLog] = await Promise.all([
    gitOrNull(cwd, [
      'log',
      ref,
      `--max-count=${HISTORY_COMMIT_LIMIT}`,
      `--pretty=format:${pretty}`,
    ]),
    gitOrNull(cwd, ['log', ref, `--since=${since.toISOString()}`, '--pretty=format:%aI']),
  ]);

  const byDate = new Map<string, number>();
  for (const line of (activityLog ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) continue;
    const key = localIsoDate(parsed);
    byDate.set(key, (byDate.get(key) ?? 0) + 1);
  }

  return {
    branch: sanitized,
    commits: parseCommitLog(log ?? ''),
    activity: recentDays(byDate, ACTIVITY_DAYS),
  };
}

export async function createBranch(cwd: string, branchName: string): Promise<string> {
  return git(cwd, ['checkout', '-b', safeBranchName(branchName)]);
}

export async function renameBranch(
  cwd: string,
  from: string,
  to: string,
  updateRemote: boolean,
): Promise<string> {
  const currentName = safeBranchName(from);
  const nextName = safeBranchName(to);
  if (currentName === nextName) throw new Error('The new name is the same as the current one.');

  const branches = await listBranches(cwd);
  const info = branches.find((branch) => branch.name === currentName);
  if (!info) throw new Error(`Branch '${currentName}' was not found.`);
  if (!info.local) {
    throw new Error(`Switch to '${currentName}' before renaming it.`);
  }
  if (branches.some((branch) => branch.name === nextName)) {
    throw new Error(`A branch named '${nextName}' already exists.`);
  }

  await git(cwd, ['branch', '-m', currentName, nextName]);
  const notes = [`Renamed '${currentName}' to '${nextName}'.`];

  if (updateRemote) {
    const remote = await primaryRemote(cwd);
    if (!remote) throw new Error('Connect a remote before renaming a branch there.');
    try {
      await git(cwd, ['push', '-u', remote, nextName], PUSH_TIMEOUT_MS);
      notes.push(`Pushed '${nextName}' to ${remote}.`);
      const defaultBranch = await detectDefaultBranch(cwd, remote);
      if (info.remote && (defaultBranch === currentName || defaultBranch === nextName)) {
        notes.push(await setDefaultBranch(cwd, nextName));
      }
      if (info.remote) {
        await git(cwd, ['push', remote, '--delete', currentName], PUSH_TIMEOUT_MS);
        notes.push(`Deleted '${currentName}' on ${remote}.`);
      }
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error(
        `Renamed locally to '${nextName}', but the remote update failed: ${(err.stderr || err.message || 'unknown error').trim()}`,
      );
    }
  }

  return notes.join(' ');
}

export async function deleteBranch(
  cwd: string,
  branchName: string,
  options: { deleteRemote: boolean; force: boolean },
): Promise<string> {
  const sanitized = safeBranchName(branchName);

  const current = await currentBranch(cwd);
  if (current === sanitized) {
    throw new Error('Switch to another branch before deleting this one.');
  }

  const remote = await primaryRemote(cwd);
  const defaultBranch = await detectDefaultBranch(cwd, remote);
  if (defaultBranch === sanitized) {
    throw new Error('Change the default branch before deleting this one.');
  }
  if (sanitized === 'master') {
    throw new Error('The master branch cannot be deleted.');
  }

  const branches = await listBranches(cwd, { remote, branch: current });
  const info = branches.find((branch) => branch.name === sanitized);
  if (!info) throw new Error(`Branch '${sanitized}' was not found.`);
  if (info.worktreePath) throw openElsewhereError(sanitized, info.worktreePath);

  const notes: string[] = [];
  if (info.local) {
    await git(cwd, ['branch', options.force ? '-D' : '-d', sanitized]);
    notes.push(`Deleted local branch '${sanitized}'.`);
  }

  const shouldDeleteRemote = info.remote && (options.deleteRemote || !info.local);
  if (shouldDeleteRemote) {
    if (!remote) throw new Error('Connect a remote before deleting a remote branch.');
    await git(cwd, ['push', remote, '--delete', sanitized], PUSH_TIMEOUT_MS);
    notes.push(`Deleted '${sanitized}' on ${remote}.`);
  }

  if (notes.length === 0) {
    throw new Error(`Nothing to delete for '${sanitized}'.`);
  }
  return notes.join(' ');
}

/**
 * Plain-text summary of the working tree, meant to be dropped into an AI prompt.
 *
 * The diff is bounded by git rather than sliced afterwards: `--unified=1` keeps
 * the whole thing from being buffered into the main process just to throw all but
 * the first few KB away, and the shortstat gives the model the size it lost.
 */
export async function readChangeSummary(
  cwd: string,
  options: { stagedOnly?: boolean } = {},
): Promise<string> {
  const status = (await gitOrNull(cwd, ['status', '--porcelain'])) ?? '';

  // `diff HEAD` covers staged and unstaged at once, but a repo whose first commit
  // hasn't been made yet has no HEAD to diff against. A commit of only what is
  // staged describes just the index.
  const hasHead = (await gitOrNull(cwd, ['rev-parse', '--verify', 'HEAD'])) !== null;
  const bases = options.stagedOnly ? [['--cached']] : hasHead ? [['HEAD']] : [['--cached'], []];

  const stats: string[] = [];
  const bodies: string[] = [];
  let failed = false;
  for (const base of bases) {
    const [stat, body] = await Promise.all([
      gitOrNull(cwd, ['diff', ...base, '--shortstat']),
      gitOrNull(cwd, ['diff', ...base, '--unified=1']),
    ]);
    if (stat === null || body === null) failed = true;
    if (stat?.trim()) stats.push(stat.trim());
    if (body?.trim()) bodies.push(body.trim());
  }

  const diff = bodies.join('\n');
  const truncated =
    diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : diff;
  // A diff that blew past maxBuffer is not the same as no changes, and the model
  // should be told which one it is looking at.
  const diffText = truncated || (failed ? '(the diff was too large to read)' : '(no changes)');

  return [
    `Changed files:\n${status.trim() || '(none)'}`,
    stats.length > 0 ? `Diff size: ${stats.join('; ')}` : '',
    `Diff:\n${diffText}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Tag state for the repo, or for one part of it. With a scope, only tags carrying that
 * prefix count as tags and only commits touching that folder count as commits since,
 * which is what lets a monorepo release its web app without the app's tags getting in the way.
 */
/**
 * Tag state for the repo. With a `prefix`, only tags in that series count, so `web-v1.2.0`
 * and `v3.0.0` don't answer for each other.
 */
export async function readTagInfo(cwd: string, prefix?: string): Promise<GitTagInfo> {
  if (!(await isGitRepo(cwd))) {
    return {
      latestTag: null,
      recentTags: [],
      commitsSinceLatestTag: 0,
      hasRemote: false,
      prefixes: [],
    };
  }

  // `<prefix>[0-9]*` keeps `v1.2.3` from answering for `web-v`, and the other way round.
  const describeArgs = ['describe', '--tags', '--abbrev=0'];
  if (prefix !== undefined) describeArgs.push('--match', `${prefix}[0-9]*`);

  const [remotes, latest, tagList] = await Promise.all([
    gitOrNull(cwd, ['remote']),
    gitOrNull(cwd, describeArgs),
    gitOrNull(cwd, ['tag', '--sort=-creatordate']),
  ]);

  const latestTag = (latest ?? '').trim() || null;
  const allTags = (tagList ?? '')
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const recentTags = allTags
    .filter((tag) => prefix === undefined || tagHasPrefix(tag, prefix))
    .slice(0, RECENT_TAG_LIMIT);
  const prefixes = new Set<string>();
  for (const tag of allTags) {
    const split = splitTagPrefix(tag);
    if (split) prefixes.add(split.prefix);
  }

  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const count = (await gitOrNull(cwd, ['rev-list', '--count', range])) ?? '';

  return {
    latestTag,
    recentTags,
    commitsSinceLatestTag: parseInt(count.trim(), 10) || 0,
    hasRemote: (remotes ?? '').trim().length > 0,
    prefixes: [...prefixes],
  };
}

/** Commit subjects since `latestTag`, or the whole history when there is no tag yet. */
export async function readCommitSubjects(cwd: string, latestTag: string | null): Promise<string[]> {
  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const args = ['log', range, '--no-merges', '--pretty=format:%s'];
  const log = (await gitOrNull(cwd, args)) ?? '';
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Every file git knows about: tracked plus untracked ones that are not ignored. Used by the
 * diffray wizard to offer a whole-codebase review. `-z` keeps paths with spaces or non-ASCII
 * characters intact, which `ls-files` would otherwise escape and quote.
 */
export async function listRepoFiles(cwd: string): Promise<string[]> {
  if (!(await isGitRepo(cwd))) return [];
  const output =
    (await gitOrNull(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])) ?? '';
  const paths = new Set<string>();
  for (const entry of output.split('\0')) {
    const path = entry.trim();
    if (path) paths.add(path);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export async function runGitOp(fn: () => Promise<string>): Promise<GitOpResult> {
  try {
    const output = await fn();
    return { ok: true, message: output.trim() || 'Done.' };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, message: (err.stderr || err.message || 'Git command failed.').trim() };
  }
}

export async function pushCurrentBranch(cwd: string, branch: string): Promise<string> {
  try {
    return await git(cwd, ['push'], PUSH_TIMEOUT_MS);
  } catch (error) {
    const err = error as { stderr?: string };
    if (/has no upstream branch|set the upstream/i.test(err.stderr ?? '')) {
      const remote = (await primaryRemote(cwd)) ?? 'origin';
      return git(cwd, ['push', '-u', remote, branch], PUSH_TIMEOUT_MS);
    }
    throw error;
  }
}

/**
 * Push the current branch first (so the tagged commit lands on origin), then the tag.
 * Pushing only `refs/tags/...` leaves the branch ahead, which is why "Create & push"
 * used to still need the git-section Push button afterwards.
 */
export async function pushBranchAndTag(cwd: string, tag: string): Promise<void> {
  const remote = (await primaryRemote(cwd)) ?? 'origin';
  const branch = await currentBranch(cwd);
  if (branch) {
    await pushCurrentBranch(cwd, branch);
  }
  await git(cwd, ['push', remote, `refs/tags/${tag}`], PUSH_TIMEOUT_MS);
}
