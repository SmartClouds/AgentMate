import type { AutoFixBlocker } from '../../../shared/ciAutoFixTypes';
import { currentBranch, git, pushCurrentBranch } from '../../git/plumbing';
import type { AutoFixCommitResult } from './machine';

export type AutoFixPreflight =
  | { ok: true; baseSha: string }
  | { ok: false; blocker: AutoFixBlocker; message: string };

/** The first line git printed, for a sentence the user reads. */
function gitSaid(error: unknown): string {
  const err = error as { stderr?: string; message?: string } | null;
  const text = (err?.stderr || err?.message || 'git failed').trim();
  return (text.split('\n')[0] ?? text).trim().replace(/[.:]$/, '');
}

async function isAncestor(cwd: string, sha: string): Promise<boolean> {
  return git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD']).then(
    () => true,
    () => false,
  );
}

async function head(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Checks the project is ready for an agent to fix `runSha` on `branch`: on that branch, with
 * nothing uncommitted (auto-fix commits with `add -A`, which would sweep the user's own work into
 * the fix), and holding the commit the run tested, fast-forwarding to it when it can. Returns
 * HEAD, so a commit the agent makes itself is still found and pushed afterwards.
 */
export async function preflightAutoFix(
  cwd: string,
  branch: string,
  runSha: string,
): Promise<AutoFixPreflight> {
  const onBranch = await currentBranch(cwd);
  if (onBranch !== branch) {
    return {
      ok: false,
      blocker: 'wrong-branch',
      message: onBranch
        ? `The project is on ${onBranch}, but the run is on ${branch}. Switch to ${branch}, then press Retry.`
        : `The project is not on a branch, but the run is on ${branch}. Switch to ${branch}, then press Retry.`,
    };
  }
  if ((await git(cwd, ['status', '--porcelain'])).trim()) {
    return {
      ok: false,
      blocker: 'dirty-tree',
      message:
        'The project has uncommitted changes. Commit or stash them, then press Retry, so they stay out of the fix.',
    };
  }
  if (!(await isAncestor(cwd, runSha))) {
    const pulled = await git(cwd, ['pull', '--ff-only']).then(
      () => true,
      () => false,
    );
    if (!pulled || !(await isAncestor(cwd, runSha))) {
      return {
        ok: false,
        blocker: 'behind',
        message: `The project does not have the commit the run tested (${runSha.slice(0, 7)}), and it could not be fast-forwarded. Pull ${branch}, then press Retry.`,
      };
    }
  }
  return { ok: true, baseSha: await head(cwd) };
}

/**
 * Commits what the agent changed and pushes the branch. A clean tree with HEAD past `baseSha`
 * means the agent committed on its own, which is pushed as it is. A clean tree at `baseSha`
 * means there is nothing to push.
 */
export async function commitAutoFix(
  cwd: string,
  input: { branch: string; baseSha: string | null; message: string },
): Promise<AutoFixCommitResult> {
  const onBranch = await currentBranch(cwd);
  if (onBranch !== input.branch) {
    return {
      kind: 'blocked',
      blocker: 'commit-failed',
      message: `The project moved to ${onBranch || 'a detached HEAD'} while the agent worked. Switch back to ${input.branch}, then press Retry.`,
    };
  }
  if ((await git(cwd, ['status', '--porcelain'])).trim()) {
    try {
      await git(cwd, ['add', '-A']);
      await git(cwd, ['commit', '-m', input.message]);
    } catch (error) {
      return {
        kind: 'blocked',
        blocker: 'commit-failed',
        message: `The commit failed: ${gitSaid(error)}. Commit it yourself, or fix the cause and press Retry.`,
      };
    }
  } else if ((await head(cwd)) === input.baseSha) {
    return { kind: 'no-change' };
  }
  try {
    await pushCurrentBranch(cwd, input.branch);
  } catch (error) {
    return {
      kind: 'blocked',
      blocker: 'push-failed',
      message: `The push was refused: ${gitSaid(error)}. Pull the branch, then press Retry to push the fix.`,
    };
  }
  return { kind: 'pushed', sha: await head(cwd) };
}

export function autoFixCommitMessage(input: {
  workflowName: string;
  runNumber: number | null;
  attempt: number;
  maxAttempts: number;
}): string {
  const run = input.runNumber ? ` from run #${input.runNumber}` : '';
  return `fix(ci): repair ${input.workflowName} failure${run} (auto-fix ${input.attempt}/${input.maxAttempts})`;
}
