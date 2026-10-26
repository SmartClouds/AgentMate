// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asWorkspaceProject } from '@/lib/workspace/scope';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { WorktreeFinishCard } from './WorktreeFinishCard';
import { WorktreesSection } from './WorktreesSection';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app' } as Project;

function worktree(id: string, branch: string, patch: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    id,
    projectId: 'p1',
    path: `C:\\code\\app.worktrees\\${branch}`,
    branch,
    baseBranch: 'main',
    createdAt: '2026-09-25T00:00:00.000Z',
    createdByApp: true,
    missing: false,
    locked: false,
    status: { changes: 0, ahead: 0, behind: 0, merged: true, unpushed: null },
    ...patch,
  };
}

beforeEach(() => {
  navigate.mockClear();
  useWorktreeDialogStore.setState({ create: null, remove: null });
});

describe('WorktreesSection', () => {
  it('shimmers while the list loads', () => {
    renderWithProviders(<WorktreesSection project={project} />, {
      bridge: { 'worktrees.list': () => new Promise(() => undefined) },
    });
    expect(screen.getByLabelText('Loading worktrees')).toBeInTheDocument();
  });

  it('explains what worktrees are for when there are none', async () => {
    const { user } = renderWithProviders(<WorktreesSection project={project} />, {
      bridge: { 'worktrees.list': [] },
    });
    expect(await screen.findByText(/Work on several branches at once/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(useWorktreeDialogStore.getState().create).toEqual({ projectId: 'p1' });
  });

  it('lists worktrees with their state and opens one', async () => {
    const { user } = renderWithProviders(<WorktreesSection project={project} />, {
      bridge: {
        'worktrees.list': [
          worktree('wt-1', 'feat-a', {
            status: { changes: 3, ahead: 2, behind: 1, merged: false, unpushed: null },
          }),
          worktree('wt-2', 'feat-b', { createdByApp: false }),
        ],
      },
    });
    const row = await screen.findByRole('button', { name: /Open feat-a/ });
    expect(within(row).getByText('3 changes')).toBeInTheDocument();
    expect(within(row).getByText('↑2')).toBeInTheDocument();
    expect(within(row).getByText('↓1')).toBeInTheDocument();
    expect(screen.getByText('Added outside Runova')).toBeInTheDocument();
    await user.click(row);
    expect(navigate).toHaveBeenCalledWith('/workspace/p1~wt-1');
  });

  it('inside a worktree, marks it and offers the way back to the main checkout', async () => {
    const tree = worktree('wt-1', 'feat-a');
    const { user } = renderWithProviders(
      <WorktreesSection project={asWorkspaceProject(project, tree)} />,
      { bridge: { 'worktrees.list': [tree], 'projects.list': [project] } },
    );
    expect(await screen.findByText('This workspace')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Open the main checkout/ }));
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });

  it('offers to clean up worktrees whose folders are gone', async () => {
    const { user, bridge } = renderWithProviders(<WorktreesSection project={project} />, {
      bridge: {
        'worktrees.list': [worktree('wt-1', 'gone', { missing: true, status: null })],
        'worktrees.prune': { ok: true, message: 'Cleared.' },
      },
    });
    expect(await screen.findByText('Folder missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clean up' }));
    expect(bridge.$fn('worktrees.prune')).toHaveBeenCalledWith('p1');
  });

  it('has the full menu behind each row’s more button', async () => {
    renderWithProviders(<WorktreesSection project={project} />, {
      bridge: { 'worktrees.list': [worktree('wt-1', 'feat-a')] },
    });
    const more = await screen.findByRole('button', { name: 'More actions for feat-a' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: /Remove worktree/ })).toBeInTheDocument();
  });
});

describe('WorktreeFinishCard', () => {
  it('shows where the branch stands and the ways to finish it', async () => {
    const tree = worktree('wt-1', 'feat-a', {
      status: { changes: 0, ahead: 3, behind: 0, merged: false, unpushed: null },
    });
    renderWithProviders(<WorktreeFinishCard project={project} worktree={tree} />);
    expect(screen.getByText('feat-a')).toBeInTheDocument();
    expect(screen.getByText('3 commits ahead of main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create pull request' })).toBeInTheDocument();
  });

  it('nudges toward cleanup once everything is merged', async () => {
    const tree = worktree('wt-1', 'feat-a');
    const { user } = renderWithProviders(<WorktreeFinishCard project={project} worktree={tree} />);
    expect(screen.getByText('Everything here is in main')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge into main' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }));
    expect(useWorktreeDialogStore.getState().remove).toEqual({
      projectId: 'p1',
      worktreeId: 'wt-1',
    });
  });

  it('points at uncommitted work before anything else', () => {
    const tree = worktree('wt-1', 'feat-a', {
      status: { changes: 2, ahead: 1, behind: 4, merged: false, unpushed: null },
    });
    renderWithProviders(<WorktreeFinishCard project={project} worktree={tree} />);
    expect(
      screen.getByText('2 uncommitted changes · 1 commit ahead, 4 behind main'),
    ).toBeInTheDocument();
  });
});
