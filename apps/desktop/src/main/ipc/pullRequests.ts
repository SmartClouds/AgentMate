import {
  buildLocalReviewPrompt,
  buildPrTextPrompt,
  type MergeMethod,
  type Project,
  parsePrText,
} from '@runova/core';
import { ipcMain } from 'electron';
import type {
  CleanupAfterMergeInput,
  MergePullRequestIpcInput,
  MergePullRequestResult,
  PrActionResult,
  PrCommentInput,
  PrThreadReplyInput,
  PrThreadResolveInput,
  PullRequestStatus,
  SuggestGitTextResult,
  SuggestPullRequestTextResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { ghErrorMessage, isGhCliAvailable } from '../git/githubCli';
import { currentBranch, detectDefaultBranch, gitOrNull, primaryRemote } from '../git/plumbing';
import {
  cleanupAfterMerge,
  commentOnPullRequest,
  markPullRequestReady,
  mergePullRequest,
  readBranchPullRequest,
  readPullRequestDiff,
  replyToReviewThread,
  setReviewThreadResolved,
} from '../git/pullRequests';
import { githubRepoForFolder } from '../pipelines/githubActions';
import { schedulePipelineCheck } from '../pipelines/watcher';
import { findProjectScope } from '../worktrees/resolve';

const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

/** gh's wording when it has no account to use, across the versions in the wild. */
const SIGNED_OUT = /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i;

/** Big diffs are cut so the review prompt stays within what a CLI will take as an argument. */
const REVIEW_DIFF_LIMIT = 120_000;

async function getProject(projectId: string): Promise<Project> {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return project;
}

async function run(action: () => Promise<unknown>): Promise<PrActionResult> {
  try {
    await action();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }
}

/** Where the branch would merge into, as a ref git can count and log against. */
async function baseRef(cwd: string, base: string): Promise<string> {
  const remote = await primaryRemote(cwd);
  return remote ? `${remote}/${base}` : base;
}

async function readStatus(projectId: string): Promise<PullRequestStatus> {
  const cwd = (await getProject(projectId)).folderPath;
  const [cliAvailable, github, branch, remote] = await Promise.all([
    isGhCliAvailable(),
    githubRepoForFolder(cwd),
    currentBranch(cwd).catch(() => ''),
    primaryRemote(cwd),
  ]);
  const defaultBranch = await detectDefaultBranch(cwd, remote);
  const upstream = (await gitOrNull(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}']))?.trim();
  const range = upstream
    ? '@{upstream}..HEAD'
    : `${await baseRef(cwd, defaultBranch ?? 'main')}..HEAD`;
  const ahead = Number.parseInt((await gitOrNull(cwd, ['rev-list', '--count', range])) ?? '', 10);
  const dirty = ((await gitOrNull(cwd, ['status', '--porcelain'])) ?? '').trim().length > 0;

  const status: PullRequestStatus = {
    cliAvailable,
    authenticated: true,
    github,
    branch: branch || null,
    defaultBranch,
    onDefaultBranch: Boolean(branch) && branch === defaultBranch,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    hasUpstream: Boolean(upstream),
    dirty,
    pr: null,
  };
  if (!cliAvailable || !github || !branch || status.onDefaultBranch) return status;

  try {
    status.pr = await readBranchPullRequest(cwd, branch);
  } catch (error) {
    const message = ghErrorMessage(error);
    if (SIGNED_OUT.test(message)) status.authenticated = false;
    else status.error = message;
  }
  return status;
}

export function registerPullRequestHandlers(): void {
  ipcMain.handle(
    IPC.pullRequests.status,
    (_event, projectId: string): Promise<PullRequestStatus> => readStatus(projectId),
  );

  ipcMain.handle(
    IPC.pullRequests.suggestText,
    async (
      _event,
      projectId: string,
      requestId: string,
      base: string,
    ): Promise<SuggestPullRequestTextResult> => {
      const project = await getProject(projectId);
      const cwd = project.folderPath;
      const range = `${await baseRef(cwd, base)}..HEAD`;
      const subjects = ((await gitOrNull(cwd, ['log', '--format=%s', range])) ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const diffStat = (await gitOrNull(cwd, ['diff', '--shortstat', range])) ?? '';
      const result = await runHeadlessCliPrompt(buildPrTextPrompt(base, subjects, diffStat), cwd, {
        requestId,
        preferredCliId: project.cliId,
      });
      if (!result.ok) {
        return {
          ok: false,
          cliName: result.cliName,
          error: result.error,
          cancelled: result.cancelled,
        };
      }
      return { ok: true, ...parsePrText(result.text), cliName: result.cliName };
    },
  );

  ipcMain.handle(
    IPC.pullRequests.localReview,
    async (_event, projectId: string, requestId: string): Promise<SuggestGitTextResult> => {
      const project = await getProject(projectId);
      const cwd = project.folderPath;
      const branch = await currentBranch(cwd);
      const pr = branch ? await readBranchPullRequest(cwd, branch).catch(() => null) : null;
      if (!pr) return { ok: false, error: 'This branch has no pull request to review.' };
      let diff: string;
      try {
        diff = await readPullRequestDiff(cwd, pr.number);
      } catch (error) {
        return { ok: false, error: ghErrorMessage(error) };
      }
      if (diff.length > REVIEW_DIFF_LIMIT) {
        diff = `${diff.slice(0, REVIEW_DIFF_LIMIT)}\n\n(diff cut here, read the rest from the repository)`;
      }
      const result = await runHeadlessCliPrompt(buildLocalReviewPrompt(pr, diff), cwd, {
        requestId,
        preferredCliId: project.cliId,
      });
      return {
        ok: result.ok,
        text: result.text,
        cliName: result.cliName,
        error: result.error,
        cancelled: result.cancelled,
      };
    },
  );

  ipcMain.handle(IPC.pullRequests.cancelAi, (_event, requestId: string): boolean =>
    cancelHeadlessPrompt(requestId),
  );

  ipcMain.handle(
    IPC.pullRequests.comment,
    async (_event, input: PrCommentInput): Promise<PrActionResult> => {
      const cwd = (await getProject(input.projectId)).folderPath;
      return run(() => commentOnPullRequest(cwd, input.number, input.body));
    },
  );

  ipcMain.handle(
    IPC.pullRequests.replyThread,
    async (_event, input: PrThreadReplyInput): Promise<PrActionResult> => {
      await getProject(input.projectId);
      return run(() => replyToReviewThread(input.threadId, input.body));
    },
  );

  ipcMain.handle(
    IPC.pullRequests.resolveThread,
    async (_event, input: PrThreadResolveInput): Promise<PrActionResult> => {
      await getProject(input.projectId);
      return run(() => setReviewThreadResolved(input.threadId, input.resolved));
    },
  );

  ipcMain.handle(
    IPC.pullRequests.markReady,
    async (_event, projectId: string, number: number): Promise<PrActionResult> => {
      const cwd = (await getProject(projectId)).folderPath;
      return run(() => markPullRequestReady(cwd, number));
    },
  );

  ipcMain.handle(
    IPC.pullRequests.merge,
    async (_event, input: MergePullRequestIpcInput): Promise<MergePullRequestResult> => {
      if (!MERGE_METHODS.includes(input.method)) {
        return {
          ok: false,
          merged: false,
          steps: [{ step: 'merge', ok: false, message: `Unknown merge method "${input.method}".` }],
        };
      }
      const cwd = (await getProject(input.projectId)).folderPath;
      const result = await mergePullRequest(cwd, {
        number: input.number,
        base: input.base,
        head: input.head,
        method: input.method,
        cleanup: input.cleanup,
      });
      if (result.merged) schedulePipelineCheck(input.projectId);
      return result;
    },
  );

  ipcMain.handle(
    IPC.pullRequests.cleanup,
    async (_event, input: CleanupAfterMergeInput): Promise<MergePullRequestResult> => {
      const cwd = (await getProject(input.projectId)).folderPath;
      const steps = await cleanupAfterMerge(cwd, { base: input.base, head: input.head });
      return { ok: steps.every((step) => step.ok), merged: true, steps };
    },
  );
}
