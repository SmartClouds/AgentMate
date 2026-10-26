// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import type { WorktreeRemovePreflight } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose: vi.fn(), mount: vi.fn(), unmount: vi.fn(), focus: vi.fn() },
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
  missing: false,
  locked: false,
  status: null,
} satisfies WorktreeInfo;
const SCOPE = 'p1~wt-1';

const clean: WorktreeRemovePreflight = {
  branch: 'feat',
  baseBranch: 'main',
  missing: false,
  changes: 0,
  ahead: 0,
  unpushed: null,
  merged: true,
};

const onClose = vi.fn();

function renderDialog(preflight: WorktreeRemovePreflight, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <RemoveWorktreeDialog project={project} worktree={worktree} onClose={onClose} />,
    {
      bridge: {
        'worktrees.removePreflight': preflight,
        'worktrees.remove': { ok: true, message: 'Removed the worktree for feat.' },
        'settings.get': { worktrees: { deleteBranchOnRemove: false } },
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  navigate.mockClear();
  onClose.mockClear();
  toast.success.mockClear();
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

describe('RemoveWorktreeDialog', () => {
  it('says there is nothing to lose for a clean, merged worktree', async () => {
    renderDialog(clean);
    expect(
      await screen.findByText('Nothing is lost: the branch is merged and clean.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Also delete branch feat' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeEnabled();
  });

  it('lists what would be lost, including the terminals running in it', async () => {
    useWorkspaceStore.getState().openProject(SCOPE);
    useWorkspaceStore.getState().addTerminal(SCOPE, { title: 'Claude Code', cwd: worktree.path });
    renderDialog({ ...clean, changes: 4, ahead: 3, merged: false, unpushed: 3 });
    expect(await screen.findByText('4 uncommitted changes will be lost.')).toBeInTheDocument();
    expect(screen.getByText('3 commits are not merged into main or pushed.')).toBeInTheDocument();
    expect(screen.getByText('1 terminal will be stopped.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove anyway' })).toBeInTheDocument();
  });

  it('will not delete a branch whose commits exist nowhere else', async () => {
    renderDialog({ ...clean, ahead: 2, merged: false, unpushed: null });
    const box = await screen.findByRole('checkbox', { name: 'Also delete branch feat' });
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(
      screen.getByText(/Kept, since its 2 commits exist only on this branch/),
    ).toBeInTheDocument();
  });

  it('stops the worktree’s shells, removes it and goes back to the main checkout', async () => {
    useWorkspaceStore.getState().openProject(SCOPE);
    const tabId = useWorkspaceStore
      .getState()
      .addTerminal(SCOPE, { title: 'PowerShell', cwd: worktree.path });
    const { user, bridge } = renderDialog(clean);
    await user.click(await screen.findByRole('button', { name: 'Remove worktree' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tabId);
    expect(bridge.$fn('worktrees.remove')).toHaveBeenCalledWith({
      projectId: 'p1',
      worktreeId: 'wt-1',
      force: false,
      deleteBranch: true,
    });
    expect(useWorkspaceStore.getState().workspaces[SCOPE]).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith('/workspace/p1');
    expect(toast.success).toHaveBeenCalledWith('Removed the worktree for feat.');
  });

  it('forces the removal when the user accepts losing changes', async () => {
    const { user, bridge } = renderDialog({ ...clean, changes: 2 });
    await user.click(await screen.findByRole('button', { name: 'Remove anyway' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bridge.$fn('worktrees.remove')).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it('keeps the dialog open with the reason when git refuses', async () => {
    const { user } = renderDialog(clean, {
      'worktrees.remove': {
        ok: false,
        message: 'Something still has files open in this worktree.',
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove worktree' }));
    expect(
      await screen.findByText('Something still has files open in this worktree.'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
