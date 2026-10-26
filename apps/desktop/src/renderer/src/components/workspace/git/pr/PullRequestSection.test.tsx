import type { Project, PullRequestInfo } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { useCreatePrDraft } from './CreatePrForm';
import { PullRequestSection } from './PullRequestSection';
import { useRecentMerges } from './usePullRequest';

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

const onNewBranch = vi.fn();

function renderSection(value: PullRequestStatus | undefined, extra: Record<string, unknown> = {}) {
  return renderWithProviders(
    <PullRequestSection
      project={project}
      status={value}
      loading={false}
      onRetry={vi.fn()}
      onNewBranch={onNewBranch}
    />,
    {
      bridge: {
        'settings.get': { reviewCommands: ['@claude review'] },
        'git.status': { branches: [], defaultBranch: 'master' },
        ...extra,
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useRecentMerges.setState({ byProject: {} });
  useCreatePrDraft.setState({ byProject: {} });
});

describe('PullRequestSection states', () => {
  it('shimmers while the first read is in flight', () => {
    renderWithProviders(
      <PullRequestSection
        project={project}
        status={undefined}
        loading
        onRetry={vi.fn()}
        onNewBranch={onNewBranch}
      />,
    );
    expect(screen.getByTestId('pr-loading')).toBeInTheDocument();
  });

  it('points to Agent Tools when gh is missing', () => {
    renderSection(status({ cliAvailable: false, pr: null }));
    expect(screen.getByText('GitHub CLI not found')).toBeInTheDocument();
  });

  it('offers gh auth login when signed out', () => {
    renderSection(status({ authenticated: false, pr: null }));
    expect(screen.getByRole('button', { name: 'Run gh auth login' })).toBeInTheDocument();
  });

  it('explains a repository that is not on GitHub', () => {
    renderSection(status({ github: null, pr: null }));
    expect(screen.getByText('No GitHub remote')).toBeInTheDocument();
  });

  it('keeps the raw gh error in a tooltip instead of printing it', async () => {
    const raw = 'Command failed: gh pr view feature --json number,title,url';
    const { user } = renderSection(status({ pr: null, error: raw }));
    expect(screen.getByText('Could not read the pull request')).toBeInTheDocument();
    expect(screen.queryByText(raw)).not.toBeInTheDocument();
    await user.hover(screen.getByText(/GitHub did not return this pull request/));
    expect((await screen.findAllByText(raw)).length).toBeGreaterThan(0);
  });

  it('asks for a branch on the default branch', async () => {
    const { user } = renderSection(status({ branch: 'master', onDefaultBranch: true, pr: null }));
    expect(screen.getByText('Pull requests start from a branch')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New branch' }));
    expect(onNewBranch).toHaveBeenCalled();
  });

  it('shows the create form when the branch has no PR', () => {
    renderSection(status({ pr: null, ahead: 3 }));
    expect(screen.getByRole('textbox', { name: 'Pull request title' })).toBeInTheDocument();
    expect(screen.getByText('3 commits will be pushed first.')).toBeInTheDocument();
  });

  it('shows the PR with its checks, review and merge cards', () => {
    renderSection(status());
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('Add the tab')).toBeInTheDocument();
    expect(screen.getByText('Checks')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Squash and merge' })).toBeInTheDocument();
  });

  it('says a merged PR is done and offers the cleanup that did not happen', async () => {
    const { user, bridge } = renderSection(status({ pr: { ...PR, state: 'MERGED' } }), {
      'pullRequests.cleanup': { ok: true, merged: true, steps: [] },
      'pullRequests.status': status({ branch: 'master', onDefaultBranch: true, pr: null }),
    });
    expect(screen.getByText('Merged into master')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to master and delete feature' }));
    expect(bridge.$fn('pullRequests.cleanup')).toHaveBeenCalledWith({
      projectId: 'p1',
      base: 'master',
      head: 'feature',
    });
  });

  it('keeps the merge result on screen after the switch to the default branch', () => {
    useRecentMerges.getState().record('p1', {
      number: 7,
      base: 'master',
      head: 'feature',
      steps: [
        { step: 'merge', ok: true, message: 'Merged #7 into master.' },
        { step: 'delete', ok: true, message: "Deleted local branch 'feature'." },
      ],
    });
    renderSection(status({ branch: 'master', onDefaultBranch: true, pr: null }));
    expect(screen.getByText('Merged #7 into master')).toBeInTheDocument();
    expect(screen.getByText("Deleted local branch 'feature'.")).toBeInTheDocument();
  });
});

describe('CreatePrForm', () => {
  it('fills the title and description with AI', async () => {
    const { user, bridge } = renderSection(status({ pr: null }), {
      'pullRequests.suggestText': { ok: true, title: 'Add the tab', body: 'It adds a tab.' },
    });
    await user.click(
      screen.getByRole('button', { name: 'Write the title and description with AI' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Pull request title' })).toHaveValue(
        'Add the tab',
      ),
    );
    expect(screen.getByRole('textbox', { name: 'Pull request description' })).toHaveValue(
      'It adds a tab.',
    );
    expect(bridge.$fn('pullRequests.suggestText').mock.calls[0]?.[2]).toBe('master');
  });

  it('warns about uncommitted changes', () => {
    renderSection(status({ pr: null, dirty: true }));
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
  });

  it('says a branch with no upstream is published first', () => {
    renderSection(status({ pr: null, hasUpstream: false, ahead: 1 }));
    expect(screen.getByText('The branch will be published to GitHub first.')).toBeInTheDocument();
  });

  it('creates the PR, as a draft when asked', async () => {
    const { user, bridge } = renderSection(status({ pr: null }), {
      'git.createPullRequest': { ok: true, url: 'https://github.com/acme/app/pull/8' },
    });
    const create = screen.getByRole('button', { name: 'Create pull request' });
    expect(create).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Pull request title' }), 'Add it');
    await user.click(screen.getByRole('checkbox', { name: 'Open as a draft' }));
    await user.click(create);

    await waitFor(() =>
      expect(bridge.$fn('git.createPullRequest')).toHaveBeenCalledWith({
        projectId: 'p1',
        title: 'Add it',
        body: '',
        base: 'master',
        draft: true,
      }),
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it('keeps what was typed when GitHub refuses', async () => {
    const { user } = renderSection(status({ pr: null }), {
      'git.createPullRequest': { ok: false, error: 'No commits between master and feature' },
    });
    await user.type(screen.getByRole('textbox', { name: 'Pull request title' }), 'Add it');
    await user.click(screen.getByRole('button', { name: 'Create pull request' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not create the pull request', {
        description: 'No commits between master and feature',
      }),
    );
    expect(screen.getByRole('textbox', { name: 'Pull request title' })).toHaveValue('Add it');
  });

  it('jumps to the changes from the warning', async () => {
    const { user } = renderSection(status({ pr: null, dirty: true }));
    await user.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(useWorkspaceStore.getState().gitPanel.activeSection).toBe('sourceControl');
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.changes).toBe(true);
  });
});
