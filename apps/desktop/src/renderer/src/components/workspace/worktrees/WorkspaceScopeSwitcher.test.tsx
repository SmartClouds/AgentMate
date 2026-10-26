// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { WorkspaceScopeSwitcher } from './WorkspaceScopeSwitcher';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app' } as Project;
const worktrees: WorktreeInfo[] = [
  {
    id: 'wt-1',
    projectId: 'p1',
    path: 'C:\\code\\app.worktrees\\feat-auth',
    branch: 'feat/auth',
    baseBranch: 'main',
    createdAt: '2026-09-25T00:00:00.000Z',
    createdByApp: true,
    missing: false,
    locked: false,
    status: { changes: 2, ahead: 1, behind: 0, merged: false, unpushed: null },
  },
];

function open(): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Switch workspace/ }), {
    button: 0,
    ctrlKey: false,
  });
}

beforeEach(() => {
  navigate.mockClear();
  useWorktreeDialogStore.setState({ create: null, remove: null });
  useWorkspaceStore.getState().setGitPanel({ collapsed: true, activeSection: 'explorer' });
});

describe('WorkspaceScopeSwitcher', () => {
  it('names the main checkout when that is what is open', async () => {
    renderWithProviders(<WorkspaceScopeSwitcher scopeId="p1" />, {
      bridge: { 'projects.list': [project], 'worktrees.list': worktrees },
    });
    expect(
      await screen.findByRole('button', { name: 'Switch workspace: main checkout' }),
    ).toBeInTheDocument();
  });

  it('names the branch when a worktree is open', async () => {
    renderWithProviders(<WorkspaceScopeSwitcher scopeId="p1~wt-1" />, {
      bridge: { 'projects.list': [project], 'worktrees.list': worktrees },
    });
    expect(
      await screen.findByRole('button', { name: 'Switch workspace: feat/auth' }),
    ).toHaveTextContent('feat/auth');
  });

  it('lists the main checkout and every worktree, and switches between them', async () => {
    renderWithProviders(<WorkspaceScopeSwitcher scopeId="p1" />, {
      bridge: { 'projects.list': [project], 'worktrees.list': worktrees },
    });
    await screen.findByRole('button', { name: /Switch workspace/ });
    open();
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Main checkout/ })).toBeInTheDocument();
    const item = within(menu).getByRole('menuitem', { name: /feat\/auth/ });
    expect(item).toHaveTextContent('2 changes');
    fireEvent.click(item);
    expect(navigate).toHaveBeenCalledWith('/workspace/p1~wt-1');
  });

  it('starts a new worktree and shows them all in the panel', async () => {
    renderWithProviders(<WorkspaceScopeSwitcher scopeId="p1" />, {
      bridge: { 'projects.list': [project], 'worktrees.list': worktrees },
    });
    await screen.findByRole('button', { name: /Switch workspace/ });
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: /New worktree/ }));
    expect(useWorktreeDialogStore.getState().create).toEqual({ projectId: 'p1' });
    open();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Manage worktrees/ }));
    expect(useWorkspaceStore.getState().gitPanel).toMatchObject({
      collapsed: false,
      activeSection: 'sourceControl',
    });
    expect(useWorkspaceStore.getState().gitPanel.openSourceSections.worktrees).toBe(true);
  });
});
