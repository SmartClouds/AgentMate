import type { Project, PullRequestInfo } from '@runova/core';
import type { PullRequestStatus, WorkspaceGitState } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { GitPanel } from './GitPanel';

/**
 * The large pull request view as it's reached from the panel: the expand button in the Pull
 * request section header, fed by the same live status the section shows.
 */

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
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
  reviewDecision: 'APPROVED',
  additions: 12,
  deletions: 3,
  checks: [],
  threads: [],
};

function prStatus(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
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

function gitState(overrides: Partial<WorkspaceGitState> = {}): WorkspaceGitState {
  return {
    isRepo: true,
    branch: 'feature',
    detached: false,
    head: 'abc1234',
    upstream: 'origin/feature',
    ahead: 0,
    behind: 0,
    hasRemote: true,
    operation: null,
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    untrackedTruncated: false,
    projectPrefix: '',
    ...overrides,
  } as WorkspaceGitState;
}

function renderPanel(pr: PullRequestStatus, state: WorkspaceGitState = gitState()) {
  return renderWithProviders(<GitPanel project={project} visible />, {
    bridge: {
      'git.workspaceState': state,
      'git.fetch': { ok: true, message: '' },
      'git.status': { branches: [], defaultBranch: 'master' },
      'pullRequests.status': pr,
      'settings.get': { reviewCommands: [] },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.getState().revealPanelSection('pullRequest');
});

describe('GitPanel large pull request view', () => {
  it('opens from the Pull request section and shows the live PR', async () => {
    const { user } = renderPanel(prStatus());
    await user.click(await screen.findByRole('button', { name: 'Open in a larger view' }));

    const dialog = await screen.findByRole('dialog', { name: 'Pull request' });
    expect(within(dialog).getByRole('heading', { name: /Add the tab/ })).toBeInTheDocument();
    expect(within(dialog).getByText('Ready to merge into master')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Squash and merge' })).toBeInTheDocument();
  });

  it('closes on Escape and leaves the panel as it was', async () => {
    const { user } = renderPanel(prStatus());
    await user.click(await screen.findByRole('button', { name: 'Open in a larger view' }));
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.pullRequest).toBe(true);
  });

  it('hands off to the Changes section when asked to review uncommitted work', async () => {
    const { user } = renderPanel(prStatus({ pr: null, dirty: true }));
    useWorkspaceStore.getState().setSourceSectionOpen('changes', false);
    await user.click(await screen.findByRole('button', { name: 'Open in a larger view' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Review changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.changes).toBe(true);
  });

  it('has nothing to expand without a remote', async () => {
    renderPanel(prStatus(), gitState({ hasRemote: false, upstream: null }));
    expect(await screen.findByText('No remote')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in a larger view' })).not.toBeInTheDocument();
  });
});
