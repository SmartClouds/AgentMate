import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { stripRemoteCredentials } from '@agentmat/core';
import { runGh } from './githubCli';
import { git, gitOrNull, isGitRepo } from './plumbing';

/** A first clone of a big repo over a slow line takes a while, so it gets the push budget and then some. */
const CLONE_TIMEOUT_MS = 300000;

/**
 * Thumbnail caches the OS drops into any folder it shows. They don't make a folder "not
 * empty", but git won't clone next to them, so they are removed first (the OS rebuilds them).
 */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db']);

const GITHUB_HELPER_KEY = 'credential.https://github.com.helper';
/** The helper `gh auth setup-git` installs: git asks gh for the signed-in token. */
const GH_HELPER = '!gh auth git-credential';

export type CloneMode = 'cloned' | 'attached' | 'skipped';

export interface CloneOutcome {
  ok: boolean;
  message: string;
  mode?: CloneMode;
  /** The folder has files but no repo, so attaching needs the user's go-ahead first. */
  needsAttachConfirm?: boolean;
}

/** The folder's entries, minus OS clutter. A folder that doesn't exist yet has none. */
async function meaningfulEntries(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((entry) => !OS_JUNK.has(entry));
  } catch {
    return [];
  }
}

/**
 * `-c` options that let git borrow the GitHub CLI's sign-in for github.com, or none when gh
 * isn't installed or isn't signed in. Every git the app runs has prompts turned off, so
 * without this a private repo on a fresh machine fails with nothing the user can answer.
 */
export async function githubCredentialArgs(): Promise<string[]> {
  try {
    const { stdout } = await runGh(['auth', 'token', '--hostname', 'github.com'], {
      timeout: 10000,
      readOnly: true,
    });
    if (!stdout.trim()) return [];
  } catch {
    return [];
  }
  // The empty value clears whatever helper the user's global config has for github.com,
  // so git goes straight to gh instead of a credential manager that can't prompt here.
  return ['-c', `${GITHUB_HELPER_KEY}=`, '-c', `${GITHUB_HELPER_KEY}=${GH_HELPER}`];
}

/** Keeps the gh helper in the repo's own config, so Fetch, Pull and Push work later too. */
async function rememberGithubHelper(folder: string): Promise<void> {
  await git(folder, ['config', '--local', '--replace-all', GITHUB_HELPER_KEY, '']);
  await git(folder, ['config', '--local', '--add', GITHUB_HELPER_KEY, GH_HELPER]);
}

/** Turns what git printed on a failed clone or fetch into something a person can act on. */
export function describeCloneError(error: unknown): string {
  const err = error as { stderr?: string; message?: string } | null;
  const stderr = String(err?.stderr || err?.message || '');
  if (/repository not found|not found|404/i.test(stderr)) {
    return 'Repository not found. Check the address. For a private repo, sign in with "gh auth login" and try again.';
  }
  if (
    /authentication|permission denied|401|403|askpass|could not read username|terminal prompts disabled/i.test(
      stderr,
    )
  ) {
    return 'GitHub asked for sign-in. This looks like a private repo. Run "gh auth login" (or set up SSH), then use Clone from GitHub on the Git tab.';
  }
  if (/already exists and is not an empty directory/i.test(stderr)) {
    return 'Folder is not empty. Choose an empty folder to clone into.';
  }
  if ((error as { killed?: boolean } | null)?.killed) {
    return 'The clone took too long and was stopped. Check your connection and try again.';
  }
  // The first line is usually git's "Cloning into ..." banner; the reason comes last.
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Cloning into/i.test(line));
  return lines[lines.length - 1] || 'Clone failed. Check the address and try again.';
}

/** Puts a folder that was empty before a failed clone back the way it was. */
async function emptyFolder(folder: string): Promise<void> {
  for (const entry of await meaningfulEntries(folder)) {
    await rm(join(folder, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Clones `url` into `folder`. The folder may not exist yet. One that already holds a repo is
 * left alone, and one with files in it is refused, since git would refuse it anyway.
 */
export async function cloneIntoFolder(folder: string, url: string): Promise<CloneOutcome> {
  await mkdir(folder, { recursive: true });
  if (await isGitRepo(folder)) {
    return { ok: true, message: 'Folder is already a git repository.', mode: 'skipped' };
  }
  if ((await meaningfulEntries(folder)).length > 0) {
    return { ok: false, message: 'Folder is not empty. Choose an empty folder to clone into.' };
  }

  for (const junk of OS_JUNK) {
    await rm(join(folder, junk), { force: true }).catch(() => undefined);
  }

  const credentials = await githubCredentialArgs();
  try {
    await git(folder, [...credentials, 'clone', url, '.'], CLONE_TIMEOUT_MS);
  } catch (error) {
    // A clone that was killed or failed halfway leaves a partial checkout, and a retry
    // would then be refused as "not empty". The folder was empty, so empty it again.
    await emptyFolder(folder);
    return { ok: false, message: describeCloneError(error) };
  }
  if (credentials.length > 0) await rememberGithubHelper(folder);
  return { ok: true, message: `Cloned ${stripRemoteCredentials(url)}.`, mode: 'cloned' };
}

/** The remote's default branch, read from its HEAD, with main and master as fallbacks. */
async function remoteDefaultBranch(folder: string, credentials: string[]): Promise<string | null> {
  const symref = await gitOrNull(folder, [
    ...credentials,
    'ls-remote',
    '--symref',
    'origin',
    'HEAD',
  ]);
  const advertised = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(symref ?? '')?.[1];
  // An empty remote can still advertise an unborn HEAD, so only a branch that was fetched counts.
  for (const candidate of [advertised, 'main', 'master']) {
    if (!candidate) continue;
    const ref = `refs/remotes/origin/${candidate}`;
    if ((await gitOrNull(folder, ['rev-parse', '--verify', '--quiet', ref])) !== null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Connects a folder that already has the project's files (but no `.git`) to its repository.
 * The working tree is never touched: HEAD and the index move to the remote branch, so files
 * that match GitHub look clean and anything that differs shows up as a change. If any step
 * fails, the `.git` this created is removed and the folder is exactly as it was.
 */
export async function attachFolderToRemote(folder: string, url: string): Promise<CloneOutcome> {
  if (await isGitRepo(folder)) {
    return { ok: true, message: 'Folder is already a git repository.', mode: 'skipped' };
  }

  const credentials = await githubCredentialArgs();
  try {
    await git(folder, ['init']);
    await git(folder, ['remote', 'add', 'origin', url]);
    await git(folder, [...credentials, 'fetch', 'origin'], CLONE_TIMEOUT_MS);

    const branch = await remoteDefaultBranch(folder, credentials);
    if (credentials.length > 0) await rememberGithubHelper(folder);
    if (!branch) {
      return {
        ok: true,
        message: `Connected origin to ${stripRemoteCredentials(url)}. The repository has no commits yet.`,
        mode: 'attached',
      };
    }

    await git(folder, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    // --mixed moves the branch and the index only. Nothing on disk changes.
    await git(folder, ['reset', '--mixed', '--quiet', `origin/${branch}`]);
    await git(folder, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
    return {
      ok: true,
      message: `Connected to ${stripRemoteCredentials(url)} on ${branch}. Your files were kept, and any differences show as changes.`,
      mode: 'attached',
    };
  } catch (error) {
    await rm(join(folder, '.git'), { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, message: describeCloneError(error) };
  }
}

/**
 * The Git tab's "Clone from GitHub": clones into an empty or missing folder, and for a folder
 * that already has files, asks first (`attach` unset) and then attaches it in place.
 */
export async function cloneOrAttach(
  folder: string,
  url: string,
  attach: boolean,
): Promise<CloneOutcome> {
  if (await isGitRepo(folder)) {
    return { ok: true, message: 'Folder is already a git repository.', mode: 'skipped' };
  }
  if ((await meaningfulEntries(folder)).length === 0) return cloneIntoFolder(folder, url);
  if (!attach) {
    return {
      ok: false,
      needsAttachConfirm: true,
      message: 'This folder already has files. Confirm to connect it to the repository.',
    };
  }
  return attachFolderToRemote(folder, url);
}
