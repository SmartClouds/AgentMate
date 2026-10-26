// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asWorkspaceProject } from '@/lib/workspace/scope';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { WorktreeMissingNotice, WorktreeWorkspaceGuard } from './WorktreeHostParts';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose: vi.fn() },
  useTerminalSessionStore: Object.assign(
    (select: (state: { ended: Record<string, number> }) => unknown) => select({ ended: {} }),
    { getState: () => ({ ended: {} }) },
  ),
}));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app' } as Project;
const worktree = {
  id: 'wt-1',
  projectId: 'p1',
  path: 'C:\\code\\app.worktrees\\feat',
  branch: 'feat',
  baseBranch: 'main',
  createdAt: '2026-09-25T00:00:00.000Z',
  createdByApp: true,
  missing: true,
  locked: false,
  status: null,
} satisfies WorktreeInfo;

beforeEach(() => {
  navigate.mockClear();
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
  useWorktreeDialogStore.setState({ create: null, remove: null });
});

describe('WorktreeWorkspaceGuard', () => {
  it('closes a worktree workspace once git no longer lists it, and goes to the project', async () => {
    useWorkspaceStore.getState().openProject('p1~wt-gone');
    useWorkspaceStore.getState().openProject('p1~wt-1');
    useWorkspaceStore.getState().openProject('p1~wt-gone');
    renderWithProviders(<WorktreeWorkspaceGuard projectId="p1" />, {
      bridge: { 'worktrees.list': [{ ...worktree, missing: false }] },
    });
    await waitFor(() =>
      expect(useWorkspaceStore.getState().workspaces['p1~wt-gone']).toBeUndefined(),
    );
    expect(useWorkspaceStore.getState().workspaces['p1~wt-1']).toBeDefined();
    expect(navigate).toHaveBeenCalledWith('/workspace/p1', { replace: true });
  });

  it('leaves everything alone while the list is loading or failed', async () => {
    useWorkspaceStore.getState().openProject('p1~wt-1');
    renderWithProviders(<WorktreeWorkspaceGuard projectId="p1" />, {
      bridge: { 'worktrees.list': () => Promise.reject(new Error('git missing')) },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useWorkspaceStore.getState().workspaces['p1~wt-1']).toBeDefined();
  });
});

describe('WorktreeMissingNotice', () => {
  it('explains the folder is gone and offers to clean up or go back', async () => {
    const { user } = renderWithProviders(
      <WorktreeMissingNotice project={asWorkspaceProject(project, worktree)} />,
    );
    expect(screen.getByText('This worktree’s folder is gone')).toBeInTheDocument();
    expect(screen.getByText(worktree.path)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove worktree' }));
    expect(useWorktreeDialogStore.getState().remove).toEqual({
      projectId: 'p1',
      worktreeId: 'wt-1',
    });
    await user.click(screen.getByRole('button', { name: 'Back to App' }));
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
  });
});
