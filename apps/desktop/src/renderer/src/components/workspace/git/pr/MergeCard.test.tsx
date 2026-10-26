import type { Project, PullRequestInfo } from '@runova/core';
import type { MergePullRequestResult, PullRequestStatus } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../../test/renderer/renderWithProviders';
import { MergeCard } from './MergeCard';
import { useRecentMerges } from './usePullRequest';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

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
  additions: 1,
  deletions: 0,
  checks: [],
  threads: [],
};

const STATUS = { dirty: false } as PullRequestStatus;

function renderCard(pr: PullRequestInfo = PR, bridge: Record<string, unknown> = {}, dirty = false) {
  return renderWithProviders(
    <MergeCard project={project} pr={pr} status={{ ...STATUS, dirty }} />,
    {
      bridge: {
        'pullRequests.status': new Promise(() => {
          // Never settles: the refresh after an action stays in flight, so the cache is what is checked.
        }),
        ...bridge,
      },
    },
  );
}

const merged: MergePullRequestResult = {
  ok: true,
  merged: true,
  steps: [
    { step: 'merge', ok: true, message: 'Merged #7 into master.' },
    { step: 'checkout', ok: true, message: 'Switched to master.' },
    { step: 'pull', ok: true, message: 'master is up to date.' },
    { step: 'delete', ok: true, message: "Deleted local branch 'feature'." },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useRecentMerges.setState({ byProject: {} });
  useWorkspaceStore.setState((s) => ({ gitPanel: { ...s.gitPanel, mergeMethods: {} } }));
});

describe('MergeCard', () => {
  it('squashes by default and cleans up afterwards', async () => {
    const { user, bridge } = renderCard(PR, { 'pullRequests.merge': merged });
    expect(
      screen.getByRole('checkbox', { name: /Delete feature here and on GitHub/ }),
    ).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Squash and merge' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Squash the commits of feature into one commit on master/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Delete feature here and on GitHub/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Squash and merge' }));

    await waitFor(() =>
      expect(bridge.$fn('pullRequests.merge')).toHaveBeenCalledWith({
        projectId: 'p1',
        number: 7,
        base: 'master',
        head: 'feature',
        method: 'squash',
        cleanup: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Merged #7 into master');
    expect(useRecentMerges.getState().byProject.p1?.number).toBe(7);
  });

  it('remembers another method for the project', async () => {
    const { user } = renderCard();
    await user.click(screen.getByRole('button', { name: 'Choose merge method' }));
    await user.click(await screen.findByRole('menuitem', { name: /Rebase and merge/ }));
    expect(useWorkspaceStore.getState().gitPanel.mergeMethods.p1).toBe('rebase');
    expect(screen.getByRole('button', { name: 'Rebase and merge' })).toBeInTheDocument();
  });

  it('can merge without touching local branches', async () => {
    const { user, bridge } = renderCard(PR, {
      'pullRequests.merge': { ...merged, steps: merged.steps.slice(0, 1) },
    });
    await user.click(screen.getByRole('checkbox', { name: /Delete feature here and on GitHub/ }));
    await user.click(screen.getByRole('button', { name: 'Squash and merge' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/Delete feature/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() =>
      expect(bridge.$fn('pullRequests.merge').mock.calls[0]?.[0]).toMatchObject({ cleanup: false }),
    );
  });

  it('blocks a draft and offers to mark it ready', async () => {
    const { user, bridge } = renderCard(
      { ...PR, isDraft: true },
      { 'pullRequests.markReady': { ok: true } },
    );
    expect(screen.getByRole('button', { name: 'Squash and merge' })).toBeDisabled();
    expect(screen.getByText('It is still a draft. Mark it ready for review.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    expect(bridge.$fn('pullRequests.markReady')).toHaveBeenCalledWith('p1', 7);
  });

  it('blocks on conflicts', () => {
    renderCard({ ...PR, mergeable: 'CONFLICTING' });
    expect(screen.getByRole('button', { name: 'Squash and merge' })).toBeDisabled();
    expect(screen.getByText('It has conflicts with master.')).toBeInTheDocument();
  });

  it('blocks the cleanup on uncommitted changes, but not a plain merge', async () => {
    const { user } = renderCard(PR, {}, true);
    expect(screen.getByRole('button', { name: 'Squash and merge' })).toBeDisabled();
    expect(screen.getByText(/uncommitted changes/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Delete feature here and on GitHub/ }));
    expect(screen.getByRole('button', { name: 'Squash and merge' })).toBeEnabled();
  });

  it('warns about failing checks but lets GitHub decide', async () => {
    const { user } = renderCard({
      ...PR,
      checks: [
        {
          name: 'test',
          workflow: 'CI',
          status: 'completed',
          conclusion: 'failure',
          detailsUrl: null,
          runId: 1,
        },
      ],
    });
    expect(screen.getByText('1 check failed.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Squash and merge' });
    expect(button).toBeEnabled();
    await user.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Merge anyway' })).toBeInTheDocument();
  });

  it('shows each step and retries a cleanup that failed part way', async () => {
    const partial: MergePullRequestResult = {
      ok: false,
      merged: true,
      steps: [
        merged.steps[0]!,
        merged.steps[1]!,
        { step: 'pull', ok: false, message: 'Not possible to fast-forward.' },
      ],
    };
    const { user, bridge } = renderCard(PR, {
      'pullRequests.merge': partial,
      'pullRequests.cleanup': { ok: true, merged: true, steps: merged.steps.slice(1) },
    });
    await user.click(screen.getByRole('button', { name: 'Squash and merge' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Squash and merge' }),
    );

    expect(await screen.findByText('Not possible to fast-forward.')).toBeInTheDocument();
    expect(screen.getByText('Merged #7 into master.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(bridge.$fn('pullRequests.cleanup')).toHaveBeenCalledWith({
      projectId: 'p1',
      base: 'master',
      head: 'feature',
    });
  });

  it('reports a merge GitHub refused', async () => {
    const { user } = renderCard(PR, {
      'pullRequests.merge': {
        ok: false,
        merged: false,
        steps: [{ step: 'merge', ok: false, message: 'Required status check "test" is failing.' }],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Squash and merge' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Squash and merge' }),
    );
    expect(await screen.findByText('Required status check "test" is failing.')).toBeInTheDocument();
    expect(useRecentMerges.getState().byProject.p1).toBeUndefined();
  });
});
