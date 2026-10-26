import type { PullRequestInfo } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { BranchPrPill, pullRequestAttention } from './BranchPrPill';

const PR = {
  number: 42,
  state: 'OPEN',
  isDraft: false,
  checks: [
    {
      name: 't',
      workflow: 'CI',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: null,
      runId: 1,
    },
  ],
  threads: [
    { id: 'a', isResolved: false, isOutdated: false, path: 'x', line: 1, comments: [] },
    { id: 'b', isResolved: true, isOutdated: false, path: 'x', line: 2, comments: [] },
  ],
} as unknown as PullRequestInfo;

describe('pullRequestAttention', () => {
  it('counts failed checks and open threads', () => {
    expect(pullRequestAttention(PR)).toEqual({ count: 2, failing: true });
    expect(pullRequestAttention(null)).toEqual({ count: 0, failing: false });
    expect(pullRequestAttention({ ...PR, state: 'MERGED' })).toEqual({ count: 0, failing: false });
  });
});

describe('BranchPrPill', () => {
  it('shows the PR number from the cached status and opens its section', async () => {
    const { user, queryClient } = renderWithProviders(<BranchPrPill projectId="p1" />);
    queryClient.setQueryData(queryKeys.pullRequest('p1'), { pr: PR } as PullRequestStatus);
    const pill = await screen.findByRole('button', { name: /#42/ });
    await user.click(pill);
    expect(useWorkspaceStore.getState().gitPanel.activeSection).toBe('sourceControl');
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.pullRequest).toBe(true);
  });

  it('names the review state in its tooltip label', async () => {
    const { user, queryClient } = renderWithProviders(<BranchPrPill projectId="p1" />);
    queryClient.setQueryData(queryKeys.pullRequest('p1'), {
      pr: { ...PR, checks: [], reviewDecision: 'CHANGES_REQUESTED' },
    } as unknown as PullRequestStatus);
    await user.hover(await screen.findByRole('button', { name: /#42/ }));
    expect(
      (await screen.findAllByText(/Pull request #42, changes requested/)).length,
    ).toBeGreaterThan(0);
  });

  it('offers to open a PR once the branch is published', async () => {
    const { user, queryClient } = renderWithProviders(<BranchPrPill projectId="p1" />);
    queryClient.setQueryData(queryKeys.pullRequest('p1'), {
      github: { owner: 'acme', repo: 'app' },
      authenticated: true,
      branch: 'feature',
      onDefaultBranch: false,
      hasUpstream: true,
      pr: null,
    } as unknown as PullRequestStatus);
    await user.click(await screen.findByRole('button', { name: /Create PR/ }));
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.pullRequest).toBe(true);
  });

  it('does not offer a PR for a branch that is not published', async () => {
    const { container, queryClient } = renderWithProviders(<BranchPrPill projectId="p1" />);
    queryClient.setQueryData(queryKeys.pullRequest('p1'), {
      github: { owner: 'acme', repo: 'app' },
      authenticated: true,
      branch: 'feature',
      onDefaultBranch: false,
      hasUpstream: false,
      pr: null,
    } as unknown as PullRequestStatus);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing without a PR', () => {
    const { container } = renderWithProviders(<BranchPrPill projectId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
