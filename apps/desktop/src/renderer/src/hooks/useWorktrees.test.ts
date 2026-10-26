// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useWorkspaceProject, useWorktrees } from './useWorktrees';

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

describe('useWorktrees', () => {
  it('loads a project’s worktrees', async () => {
    const { result } = renderHookWithProviders(() => useWorktrees('p1'), {
      bridge: { 'worktrees.list': [worktree] },
    });
    await waitFor(() => expect(result.current.data).toEqual([worktree]));
  });

  it('asks for nothing without a project', () => {
    const { result, bridge } = renderHookWithProviders(() => useWorktrees(null));
    expect(result.current.data).toBeUndefined();
    expect(() => bridge.$fn('worktrees.list')).toThrow('has not been touched');
  });

  it('reloads when main says this project’s worktrees changed, not another’s', async () => {
    const { result, bridge } = renderHookWithProviders(() => useWorktrees('p1'), {
      bridge: { 'worktrees.list': [] },
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
    const list = bridge.$fn('worktrees.list');
    const calls = list.mock.calls.length;

    act(() => bridge.$emit('worktrees.onChanged', 'p2'));
    act(() => bridge.$emit('worktrees.onChanged', 'p1'));
    await waitFor(() => expect(list.mock.calls.length).toBe(calls + 1));
  });

  it('reloads when git moves in one of the project’s worktrees', async () => {
    const { result, bridge } = renderHookWithProviders(() => useWorktrees('p1'), {
      bridge: { 'worktrees.list': [] },
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
    const list = bridge.$fn('worktrees.list');
    const calls = list.mock.calls.length;
    act(() => bridge.$emit('git.onRepoChanged', 'p1~wt-1'));
    await waitFor(() => expect(list.mock.calls.length).toBe(calls + 1));
  });
});

describe('useWorktrees and window focus', () => {
  it('reloads when the window comes back into focus, since worktrees are also made in terminals', async () => {
    const { result, bridge } = renderHookWithProviders(() => useWorktrees('p1'), {
      bridge: { 'worktrees.list': [] },
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
    const list = bridge.$fn('worktrees.list');
    const calls = list.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(list.mock.calls.length).toBe(calls + 1));
  });
});

describe('useWorkspaceProject', () => {
  const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app' } as Project;

  it('resolves a worktree scope once both lists are in', async () => {
    const { result } = renderHookWithProviders(() => useWorkspaceProject('p1~wt-1'), {
      bridge: { 'projects.list': [project], 'worktrees.list': [worktree] },
    });
    await waitFor(() =>
      expect(result.current.project).toMatchObject({
        id: 'p1~wt-1',
        folderPath: worktree.path,
        parentId: 'p1',
      }),
    );
  });

  it('resolves a project without loading worktrees', async () => {
    const { result, bridge } = renderHookWithProviders(() => useWorkspaceProject('p1'), {
      bridge: { 'projects.list': [project] },
    });
    await waitFor(() => expect(result.current.project?.id).toBe('p1'));
    expect(() => bridge.$fn('worktrees.list')).toThrow('has not been touched');
  });
});
