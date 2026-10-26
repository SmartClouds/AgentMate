import type { PrCheck, PullRequestInfo } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import {
  announcePublishedBranch,
  pullRequestProgress,
  pullRequestRefetchInterval,
  usePullRequest,
  usePullRequestActions,
} from './usePullRequest';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

function check(status: string, conclusion: string | null = null): PrCheck {
  return { name: 'ci', workflow: 'CI', status, conclusion, detailsUrl: null, runId: null };
}

const PR: PullRequestInfo = {
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
  checks: [check('completed', 'success')],
  threads: [
    { id: 'T1', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: [] },
  ],
};

function status(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    cliAvailable: true,
    authenticated: true,
    github: { owner: 'acme', repo: 'app' },
    branch: 'feature',
    defaultBranch: 'master',
    onDefaultBranch: false,
    ahead: 0,
    hasUpstream: true,
    dirty: false,
    pr: PR,
    ...overrides,
  };
}

describe('pullRequestRefetchInterval', () => {
  it('polls quickly while checks run and slowly once they settle', () => {
    expect(
      pullRequestRefetchInterval(status({ pr: { ...PR, checks: [check('in_progress')] } })),
    ).toBe(15_000);
    expect(pullRequestRefetchInterval(status())).toBe(60_000);
  });

  it('does not poll when there is nothing GitHub could change', () => {
    expect(pullRequestRefetchInterval(undefined)).toBe(false);
    expect(pullRequestRefetchInterval(status({ cliAvailable: false }))).toBe(false);
    expect(pullRequestRefetchInterval(status({ github: null }))).toBe(false);
    expect(pullRequestRefetchInterval(status({ onDefaultBranch: true, pr: null }))).toBe(false);
    expect(pullRequestRefetchInterval(status({ pr: { ...PR, state: 'MERGED' } }))).toBe(false);
  });

  it('keeps watching a branch with no PR yet, in case one is opened on github.com', () => {
    expect(pullRequestRefetchInterval(status({ pr: null }))).toBe(60_000);
  });
});

describe('usePullRequest', () => {
  it('reads the status and reads it again when the branch moves', async () => {
    const { result, rerender, bridge } = renderHookWithProviders(
      ({ head }: { head: string }) =>
        usePullRequest('p1', { visible: true, branch: 'feature', head, ahead: 0 }),
      {
        initialProps: { head: 'aaa' },
        bridge: { 'pullRequests.status': status() },
      },
    );
    await waitFor(() => expect(result.current.data?.pr?.number).toBe(7));
    expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(1);

    rerender({ head: 'bbb' });
    await waitFor(() => expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(2));
  });

  it('reads the status again once the branch is published', async () => {
    const { rerender, bridge } = renderHookWithProviders(
      ({ upstream }: { upstream: string | null }) =>
        usePullRequest('p1', { visible: true, branch: 'feature', head: 'a', ahead: 0, upstream }),
      {
        initialProps: { upstream: null as string | null },
        bridge: { 'pullRequests.status': status({ pr: null, hasUpstream: false }) },
      },
    );
    await waitFor(() => expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(1));
    rerender({ upstream: 'origin/feature' });
    await waitFor(() => expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(2));
  });

  it('stays idle while the tab is hidden', async () => {
    const { bridge } = renderHookWithProviders(
      () => usePullRequest('p1', { visible: false, branch: 'feature', head: 'a', ahead: 0 }),
      { bridge: { 'pullRequests.status': status() } },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // $fn throws for a path nothing called, which is the point here.
    expect(() => bridge.$fn('pullRequests.status')).toThrow('has not been touched');
  });

  it('reads again on its own when a read reports a branch the git watcher disagrees with', async () => {
    let calls = 0;
    const { result, bridge } = renderHookWithProviders(
      () => usePullRequest('p1', { visible: true, branch: 'feature', head: 'a', ahead: 0 }),
      {
        bridge: {
          'pullRequests.status': () => {
            calls += 1;
            // The first read gets the branch wrong (a stray read a poll on master could
            // produce); the retry it triggers gets it right, like the branch really moving.
            return calls === 1
              ? status({ branch: 'master', onDefaultBranch: true, pr: null })
              : status();
          },
        },
      },
    );
    await waitFor(() => expect(result.current.data?.branch).toBe('feature'));
    expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(2);
  });

  it('does not keep retrying when the mismatch is not a stray read', async () => {
    const { bridge } = renderHookWithProviders(
      () => usePullRequest('p1', { visible: true, branch: 'feature', head: 'a', ahead: 0 }),
      {
        bridge: {
          'pullRequests.status': status({ branch: 'master', onDefaultBranch: true, pr: null }),
        },
      },
    );
    // The one automatic retry still disagrees with the watcher, so it is trusted rather than
    // retried forever.
    await waitFor(() => expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bridge.$fn('pullRequests.status')).toHaveBeenCalledTimes(2);
  });
});

describe('pullRequestProgress', () => {
  const running = status({ pr: { ...PR, checks: [check('in_progress'), check('queued')] } });

  it('says when running checks pass or fail', () => {
    expect(pullRequestProgress(running, status())).toEqual([
      expect.objectContaining({ tone: 'success', title: 'Checks passed on #7' }),
    ]);
    const failed = status({
      pr: { ...PR, checks: [check('completed', 'failure'), check('completed', 'success')] },
    });
    expect(pullRequestProgress(running, failed)).toEqual([
      { tone: 'error', title: 'Checks failed on #7', description: '1 of 2 checks failed.' },
    ]);
  });

  it('says when a review decision or new comments arrive', () => {
    const reviewed = status({
      pr: {
        ...PR,
        reviewDecision: 'CHANGES_REQUESTED',
        threads: [
          ...PR.threads,
          { id: 'T2', isResolved: false, isOutdated: false, path: 'b.ts', line: 2, comments: [] },
        ],
      },
    });
    expect(pullRequestProgress(status(), reviewed).map((note) => note.title)).toEqual([
      'Changes requested on #7',
      '1 new review comment on #7',
    ]);
    const approved = status({ pr: { ...PR, reviewDecision: 'APPROVED' } });
    expect(pullRequestProgress(reviewed, approved).map((note) => note.title)).toEqual([
      '#7 was approved',
    ]);
  });

  it('stays quiet on the first read, a different PR, or nothing new', () => {
    expect(pullRequestProgress(undefined, status())).toEqual([]);
    expect(pullRequestProgress(status(), status())).toEqual([]);
    expect(pullRequestProgress(running, status({ pr: { ...PR, number: 8 } }))).toEqual([]);
    expect(pullRequestProgress(running, status({ pr: { ...PR, state: 'MERGED' } }))).toEqual([]);
  });

  it('toasts news from a poll with a way back to the PR', async () => {
    const { rerender, queryClient } = renderHookWithProviders(
      () => usePullRequest('p1', { visible: true, branch: 'feature', head: 'a', ahead: 0 }),
      { bridge: { 'pullRequests.status': running } },
    );
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.pullRequest('p1'))).toEqual(running),
    );
    toast.success.mockClear();
    act(() => queryClient.setQueryData(queryKeys.pullRequest('p1'), status()));
    rerender({});
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Checks passed on #7',
        expect.objectContaining({ action: expect.objectContaining({ label: 'View' }) }),
      ),
    );
  });
});

describe('announcePublishedBranch', () => {
  it('offers a pull request for a published branch that has none', async () => {
    const { queryClient } = renderHookWithProviders(() => null, {
      bridge: { 'pullRequests.status': status({ pr: null }) },
    });
    queryClient.setQueryData(queryKeys.pullRequest('p1'), status({ pr: null }));
    toast.success.mockClear();
    announcePublishedBranch(queryClient, 'p1', 'feature');

    const [title, options] = toast.success.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void } },
    ];
    expect(title).toBe('Branch published');
    expect(options.action?.label).toBe('Create pull request');
    options.action?.onClick();
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.pullRequest).toBe(true);
  });

  it('just says published when the branch already has a PR or is the default', () => {
    const { queryClient } = renderHookWithProviders(() => null, {
      bridge: { 'pullRequests.status': status() },
    });
    toast.success.mockClear();
    queryClient.setQueryData(queryKeys.pullRequest('p1'), status());
    announcePublishedBranch(queryClient, 'p1', 'feature');
    queryClient.setQueryData(
      queryKeys.pullRequest('p1'),
      status({ pr: null, onDefaultBranch: true }),
    );
    announcePublishedBranch(queryClient, 'p1', 'master');
    for (const [, options] of toast.success.mock.calls as [string, { action?: unknown }][]) {
      expect(options.action).toBeUndefined();
    }
  });
});

describe('usePullRequestActions', () => {
  it('resolves a thread straight away and keeps it resolved when GitHub agrees', async () => {
    const { result, queryClient, bridge } = renderHookWithProviders(
      () => usePullRequestActions('p1'),
      { bridge: { 'pullRequests.resolveThread': { ok: true }, 'pullRequests.status': status() } },
    );
    queryClient.setQueryData(queryKeys.pullRequest('p1'), status());

    let pending: Promise<boolean> | undefined;
    act(() => {
      pending = result.current.resolveThread('T1', true);
    });
    const cached = queryClient.getQueryData<PullRequestStatus>(queryKeys.pullRequest('p1'));
    expect(cached?.pr?.threads[0]?.isResolved).toBe(true);
    await act(async () => {
      expect(await pending).toBe(true);
    });
    expect(bridge.$fn('pullRequests.resolveThread')).toHaveBeenCalledWith({
      projectId: 'p1',
      threadId: 'T1',
      resolved: true,
    });
  });

  it('puts the thread back and says why when resolving fails', async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullRequestActions('p1'), {
      bridge: {
        'pullRequests.resolveThread': { ok: false, error: 'Resource not accessible' },
        'pullRequests.status': new Promise(() => {
          // Never settles: the refresh after an action stays in flight, so the cache is what is checked.
        }),
      },
    });
    queryClient.setQueryData(queryKeys.pullRequest('p1'), status());

    await act(async () => {
      expect(await result.current.resolveThread('T1', true)).toBe(false);
    });
    const cached = queryClient.getQueryData<PullRequestStatus>(queryKeys.pullRequest('p1'));
    expect(cached?.pr?.threads[0]?.isResolved).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Resource not accessible');
  });

  it('posts a comment and refreshes the PR', async () => {
    const { result, bridge } = renderHookWithProviders(() => usePullRequestActions('p1'), {
      bridge: { 'pullRequests.comment': { ok: true }, 'pullRequests.status': status() },
    });
    await act(async () => {
      expect(await result.current.comment(7, '@claude review')).toBe(true);
    });
    expect(bridge.$fn('pullRequests.comment')).toHaveBeenCalledWith({
      projectId: 'p1',
      number: 7,
      body: '@claude review',
    });
  });
});
