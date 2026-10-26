import type { PullRequestInfo } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MergePullRequestResult,
  PrActionResult,
  PullRequestStatus,
  SuggestGitTextResult,
  SuggestPullRequestTextResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Pull request tab reads one status object and acts through a handful of channels. The gh
 * and git work lives in ../git/pullRequests (tested there), so these tests pin down what the
 * handlers add: which project folder is used, how a missing or signed-out gh is reported, the
 * branch facts the tab decides its state from, and that failures come back as values.
 */

const userData = useTempUserData();
expectChannelsCovered(IPC.pullRequests);

const prs = vi.hoisted(() => ({
  readBranchPullRequest: vi.fn(),
  commentOnPullRequest: vi.fn(),
  replyToReviewThread: vi.fn(),
  setReviewThreadResolved: vi.fn(),
  markPullRequestReady: vi.fn(),
  mergePullRequest: vi.fn(),
  cleanupAfterMerge: vi.fn(),
  readPullRequestDiff: vi.fn(),
}));
vi.mock('../git/pullRequests', () => prs);

const env = vi.hoisted(() => ({
  ghAvailable: true,
  branch: 'feature',
  defaultBranch: 'master' as string | null,
  upstream: 'origin/feature' as string | null,
  ahead: '2',
  porcelain: '',
  github: { owner: 'acme', repo: 'app' } as { owner: string; repo: string } | null,
  gitCalls: [] as string[][],
}));

vi.mock('../git/githubCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git/githubCli')>()),
  isGhCliAvailable: async () => env.ghAvailable,
}));

vi.mock('../git/plumbing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git/plumbing')>();
  const git = async (_cwd: string, args: string[]): Promise<string> => {
    env.gitCalls.push(args);
    if (args[0] === 'status') return env.porcelain;
    if (args[0] === 'rev-list') return `${env.ahead}\n`;
    if (args[0] === 'log') return 'feat: one\nfix: two\n';
    if (args[0] === 'diff') return ' 2 files changed\n';
    return '';
  };
  return {
    ...actual,
    git,
    gitOrNull: async (cwd: string, args: string[]) => {
      if (args.includes('@{upstream}')) return env.upstream ? `${env.upstream}\n` : null;
      return git(cwd, args);
    },
    currentBranch: async () => env.branch,
    primaryRemote: async () => 'origin',
    detectDefaultBranch: async () => env.defaultBranch,
  };
});

vi.mock('../pipelines/githubActions', () => ({
  githubRepoForFolder: async () => env.github,
}));

const watcher = vi.hoisted(() => ({ schedulePipelineCheck: vi.fn() }));
vi.mock('../pipelines/watcher', () => watcher);

const headless = vi.hoisted(() => ({
  runHeadlessCliPrompt: vi.fn(),
  cancelHeadlessPrompt: vi.fn(() => true),
}));
vi.mock('../cli/headlessPrompt', () => headless);

const PROJECT_ID = 'p1';
const FOLDER = 'C:/work/app';

const OPEN_PR = {
  number: 7,
  title: 'Add it',
  url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN',
  isDraft: false,
  base: 'master',
  head: 'feature',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  additions: 1,
  deletions: 0,
  checks: [],
  threads: [],
} satisfies PullRequestInfo;

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(env, {
    ghAvailable: true,
    branch: 'feature',
    defaultBranch: 'master',
    upstream: 'origin/feature',
    ahead: '2',
    porcelain: '',
    github: { owner: 'acme', repo: 'app' },
    gitCalls: [],
  });
  prs.readBranchPullRequest.mockResolvedValue(OPEN_PR);
  userData.writeData('projects.json', [
    {
      id: PROJECT_ID,
      name: 'App',
      folderPath: FOLDER,
      cliId: 'claude',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await loadIpc(
    () => import('./pullRequests'),
    (module) => module.registerPullRequestHandlers(),
  );
});

describe('status', () => {
  const status = () => invoke<PullRequestStatus>(IPC.pullRequests.status, PROJECT_ID);

  it('reports the branch facts and its open PR', async () => {
    await expect(status()).resolves.toEqual({
      cliAvailable: true,
      authenticated: true,
      github: { owner: 'acme', repo: 'app' },
      branch: 'feature',
      defaultBranch: 'master',
      onDefaultBranch: false,
      ahead: 2,
      hasUpstream: true,
      dirty: false,
      pr: OPEN_PR,
    });
    expect(prs.readBranchPullRequest).toHaveBeenCalledWith(FOLDER, 'feature');
  });

  it('counts commits against the default branch before the first push', async () => {
    env.upstream = null;
    env.ahead = '3';
    const result = await status();
    expect(result).toMatchObject({ hasUpstream: false, ahead: 3 });
    expect(env.gitCalls).toContainEqual(['rev-list', '--count', 'origin/master..HEAD']);
  });

  it('flags uncommitted changes', async () => {
    env.porcelain = ' M a.ts\n';
    expect((await status()).dirty).toBe(true);
  });

  it('does not look for a PR on the default branch', async () => {
    env.branch = 'master';
    const result = await status();
    expect(result).toMatchObject({ onDefaultBranch: true, pr: null });
    expect(prs.readBranchPullRequest).not.toHaveBeenCalled();
  });

  it('says when gh is missing, without calling it', async () => {
    env.ghAvailable = false;
    expect(await status()).toMatchObject({ cliAvailable: false, pr: null });
    expect(prs.readBranchPullRequest).not.toHaveBeenCalled();
  });

  it('says when the repository is not on GitHub', async () => {
    env.github = null;
    expect(await status()).toMatchObject({ github: null, pr: null });
    expect(prs.readBranchPullRequest).not.toHaveBeenCalled();
  });

  it('tells a signed-out gh apart from other failures', async () => {
    prs.readBranchPullRequest.mockRejectedValueOnce(
      Object.assign(new Error('x'), {
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
    );
    expect(await status()).toMatchObject({ authenticated: false, pr: null });

    prs.readBranchPullRequest.mockRejectedValueOnce(
      Object.assign(new Error('x'), { stderr: 'HTTP 502: Bad gateway' }),
    );
    expect(await status()).toMatchObject({ authenticated: true, error: 'HTTP 502: Bad gateway' });
  });
});

describe('actions', () => {
  it('posts a comment in the project folder and reports failures as values', async () => {
    await expect(
      invoke<PrActionResult>(IPC.pullRequests.comment, {
        projectId: PROJECT_ID,
        number: 7,
        body: '@claude review',
      }),
    ).resolves.toEqual({ ok: true });
    expect(prs.commentOnPullRequest).toHaveBeenCalledWith(FOLDER, 7, '@claude review');

    prs.commentOnPullRequest.mockRejectedValueOnce(
      Object.assign(new Error('x'), { stderr: 'GraphQL: Resource not accessible' }),
    );
    await expect(
      invoke<PrActionResult>(IPC.pullRequests.comment, {
        projectId: PROJECT_ID,
        number: 7,
        body: 'hi',
      }),
    ).resolves.toEqual({ ok: false, error: 'GraphQL: Resource not accessible' });
  });

  it('replies to and resolves review threads', async () => {
    await invoke(IPC.pullRequests.replyThread, {
      projectId: PROJECT_ID,
      threadId: 'T',
      body: 'ok',
    });
    await invoke(IPC.pullRequests.resolveThread, {
      projectId: PROJECT_ID,
      threadId: 'T',
      resolved: true,
    });
    expect(prs.replyToReviewThread).toHaveBeenCalledWith('T', 'ok');
    expect(prs.setReviewThreadResolved).toHaveBeenCalledWith('T', true);
  });

  it('marks a draft ready', async () => {
    await invoke(IPC.pullRequests.markReady, PROJECT_ID, 7);
    expect(prs.markPullRequestReady).toHaveBeenCalledWith(FOLDER, 7);
  });

  it('merges and refreshes the pipelines afterwards', async () => {
    const result: MergePullRequestResult = {
      ok: true,
      merged: true,
      steps: [{ step: 'merge', ok: true, message: 'Merged' }],
    };
    prs.mergePullRequest.mockResolvedValue(result);
    await expect(
      invoke(IPC.pullRequests.merge, {
        projectId: PROJECT_ID,
        number: 7,
        base: 'master',
        head: 'feature',
        method: 'squash',
        cleanup: true,
      }),
    ).resolves.toEqual(result);
    expect(prs.mergePullRequest).toHaveBeenCalledWith(FOLDER, {
      number: 7,
      base: 'master',
      head: 'feature',
      method: 'squash',
      cleanup: true,
    });
    expect(watcher.schedulePipelineCheck).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('rejects an unknown merge method before it reaches gh', async () => {
    const result = await invoke<MergePullRequestResult>(IPC.pullRequests.merge, {
      projectId: PROJECT_ID,
      number: 7,
      base: 'master',
      head: 'feature',
      method: 'admin --force',
      cleanup: true,
    });
    expect(result.ok).toBe(false);
    expect(prs.mergePullRequest).not.toHaveBeenCalled();
  });

  it('retries the cleanup on its own', async () => {
    prs.cleanupAfterMerge.mockResolvedValue([{ step: 'delete', ok: true, message: 'Deleted' }]);
    const result = await invoke<MergePullRequestResult>(IPC.pullRequests.cleanup, {
      projectId: PROJECT_ID,
      base: 'master',
      head: 'feature',
    });
    expect(result).toEqual({
      ok: true,
      merged: true,
      steps: [{ step: 'delete', ok: true, message: 'Deleted' }],
    });
    expect(prs.cleanupAfterMerge).toHaveBeenCalledWith(FOLDER, { base: 'master', head: 'feature' });
  });
});

describe('AI help', () => {
  it('writes the PR title and description from the branch commits', async () => {
    headless.runHeadlessCliPrompt.mockResolvedValue({
      ok: true,
      text: 'TITLE: Add it\nBODY:\nDoes a thing.',
      cliName: 'Claude Code',
    });
    const result = await invoke<SuggestPullRequestTextResult>(
      IPC.pullRequests.suggestText,
      PROJECT_ID,
      'req-1',
      'master',
    );
    expect(result).toEqual({
      ok: true,
      title: 'Add it',
      body: 'Does a thing.',
      cliName: 'Claude Code',
    });
    const [prompt, cwd, options] = headless.runHeadlessCliPrompt.mock.calls[0] ?? [];
    expect(prompt).toContain('- feat: one');
    expect(prompt).toContain('2 files changed');
    expect(cwd).toBe(FOLDER);
    expect(options).toMatchObject({ requestId: 'req-1', preferredCliId: 'claude' });
    expect(env.gitCalls).toContainEqual(['log', '--format=%s', 'origin/master..HEAD']);
  });

  it('runs a read-only local review over the PR diff', async () => {
    prs.readPullRequestDiff.mockResolvedValue('diff --git a/x b/x');
    headless.runHeadlessCliPrompt.mockResolvedValue({
      ok: true,
      text: 'Looks good.',
      cliName: 'Codex',
    });
    const result = await invoke<SuggestGitTextResult>(
      IPC.pullRequests.localReview,
      PROJECT_ID,
      'req-2',
    );
    expect(result).toMatchObject({ ok: true, text: 'Looks good.', cliName: 'Codex' });
    const [prompt, , options] = headless.runHeadlessCliPrompt.mock.calls[0] ?? [];
    expect(prompt).toContain('diff --git a/x b/x');
    expect(options?.allowWrites).toBeFalsy();
  });

  it('cancels either run by request id', async () => {
    await invoke(IPC.pullRequests.cancelAi, 'req-2');
    expect(headless.cancelHeadlessPrompt).toHaveBeenCalledWith('req-2');
  });
});
