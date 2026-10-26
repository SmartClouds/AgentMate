import type { Project, PullRequestInfo } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { prStats } from './PrHeader';
import { PullRequestDialog } from './PullRequestDialog';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app', cliId: 'claude' } as Project;

const PR: PullRequestInfo = {
  number: 7,
  title: 'Add the tab',
  url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN',
  isDraft: false,
  base: 'master',
  head: 'feature',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  additions: 12,
  deletions: 3,
  checks: [],
  threads: [],
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

const onOpenChange = vi.fn();
const onRetry = vi.fn();

function renderDialog(value: PullRequestStatus) {
  return renderWithProviders(
    <PullRequestDialog
      project={project}
      open
      onOpenChange={onOpenChange}
      status={value}
      loading={false}
      fetching={false}
      onRetry={onRetry}
      onNewBranch={vi.fn()}
    />,
    {
      bridge: {
        'settings.get': { reviewCommands: ['@claude review'] },
        'git.status': { branches: [], defaultBranch: 'master' },
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PullRequestDialog', () => {
  it('lays the open PR out with its status strip, review, checks and merge', () => {
    renderDialog(status({ pr: { ...PR, reviewDecision: 'REVIEW_REQUIRED' } }));
    const dialog = screen.getByRole('dialog', { name: 'Pull request' });
    expect(within(dialog).getByText('acme/app')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /Add the tab/ })).toBeInTheDocument();
    expect(within(dialog).getByText('No checks')).toBeInTheDocument();
    // Once in the status strip, once again in the merge card.
    expect(within(dialog).getAllByText('It needs an approving review.')).toHaveLength(2);
    expect(within(dialog).getByRole('region', { name: 'Review' })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Checks' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Squash and merge' })).toBeInTheDocument();
  });

  it('gives a branch without a PR the roomy create form', () => {
    renderDialog(status({ pr: null }));
    expect(screen.getByRole('heading', { name: 'Open a pull request' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Pull request description' })).toHaveAttribute(
      'rows',
      '14',
    );
  });

  it('refreshes and opens the PR on GitHub from its toolbar', async () => {
    const { user, bridge } = renderDialog(status());
    await user.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));
    expect(onRetry).toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Open on GitHub' })[0]!,
    );
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(PR.url);
  });

  it('closes itself before jumping to the changes in the panel', async () => {
    const { user } = renderDialog(status({ pr: null, dirty: true }));
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.changes).toBe(true);
  });
});

describe('PullRequestDialog states', () => {
  function renderWith(value: PullRequestStatus | undefined, extra: { loading?: boolean } = {}) {
    const onNewBranch = vi.fn();
    const view = renderWithProviders(
      <PullRequestDialog
        project={project}
        open
        onOpenChange={onOpenChange}
        status={value}
        loading={extra.loading ?? false}
        fetching={false}
        onRetry={onRetry}
        onNewBranch={onNewBranch}
      />,
      { bridge: { 'git.status': { branches: [], defaultBranch: 'master' } } },
    );
    return { ...view, onNewBranch };
  }

  it('shimmers while the first read is in flight', () => {
    renderWith(undefined, { loading: true });
    expect(screen.getByTestId('pr-loading')).toBeInTheDocument();
  });

  it('says what is missing when gh is not installed', () => {
    renderWith(status({ cliAvailable: false, pr: null }));
    expect(screen.getByText('GitHub CLI not found')).toBeInTheDocument();
  });

  it('shows a merged PR without the status strip, with the cleanup it still offers', () => {
    renderWith(status({ pr: { ...PR, state: 'MERGED' } }));
    expect(screen.getByRole('heading', { name: /Add the tab/ })).toBeInTheDocument();
    expect(screen.queryByText('Checks', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByText('Merged into master')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Switch to master and delete feature' }),
    ).toBeInTheDocument();
  });

  it('closes before starting a new branch from the default branch', async () => {
    const { user, onNewBranch } = renderWith(
      status({ branch: 'master', onDefaultBranch: true, pr: null }),
    );
    await user.click(screen.getByRole('button', { name: 'New branch' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNewBranch).toHaveBeenCalled();
  });

  it('focuses the dialog itself on open, so no toolbar tooltip pops up', async () => {
    renderWith(status());
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('leaves out Open on GitHub until there is a PR to open', () => {
    renderWith(status({ pr: null }));
    expect(screen.queryByRole('button', { name: 'Open on GitHub' })).not.toBeInTheDocument();
  });
});

describe('prStats', () => {
  it('reads checks, review and merge readiness', () => {
    const stats = prStats({
      ...PR,
      reviewDecision: 'APPROVED',
      checks: [
        {
          name: 'ci',
          workflow: 'CI',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: null,
          runId: null,
        },
      ],
    });
    expect(stats.checks).toEqual({ value: '1 passed', tone: 'success' });
    expect(stats.review).toEqual({ value: 'Approved', tone: 'success' });
    expect(stats.merge).toEqual({ value: 'Ready to merge into master', tone: 'success' });
  });

  it('puts what blocks the merge first', () => {
    const stats = prStats({ ...PR, reviewDecision: 'CHANGES_REQUESTED' });
    expect(stats.review.tone).toBe('destructive');
    expect(stats.merge).toEqual({ value: 'A reviewer requested changes.', tone: 'warning' });
  });
});
