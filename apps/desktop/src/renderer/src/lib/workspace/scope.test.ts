import type { Project, WorktreeInfo } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceProject, worktreeInitials, worktreeLabel } from './scope';

const project = { id: 'p1', name: 'App', folderPath: 'C:\\code\\app' } as Project;
const worktree = {
  id: 'wt-1',
  projectId: 'p1',
  path: 'C:\\code\\app.worktrees\\feat-auth',
  branch: 'feat/auth',
  baseBranch: 'main',
  createdAt: '2026-09-25T00:00:00.000Z',
  createdByApp: true,
  missing: false,
  locked: false,
  status: null,
} satisfies WorktreeInfo;

describe('resolveWorkspaceProject', () => {
  it('returns a project as its own workspace', () => {
    expect(resolveWorkspaceProject([project], {}, 'p1')).toEqual({
      ...project,
      parentId: 'p1',
      worktree: null,
    });
  });

  it('points a worktree workspace at the worktree, keeping the project’s settings', () => {
    expect(resolveWorkspaceProject([project], { p1: [worktree] }, 'p1~wt-1')).toEqual({
      ...project,
      id: 'p1~wt-1',
      folderPath: worktree.path,
      parentId: 'p1',
      worktree,
    });
  });

  it('has nothing to show until the project and its worktree are known', () => {
    expect(resolveWorkspaceProject([project], {}, 'p1~wt-1')).toBeNull();
    expect(resolveWorkspaceProject([project], { p1: [] }, 'p1~wt-1')).toBeNull();
    expect(resolveWorkspaceProject([], { p1: [worktree] }, 'p1~wt-1')).toBeNull();
    expect(resolveWorkspaceProject([project], {}, null)).toBeNull();
  });
});

describe('worktree names', () => {
  it('labels a worktree by its branch, or its folder when detached', () => {
    expect(worktreeLabel(worktree)).toBe('feat/auth');
    expect(worktreeLabel({ ...worktree, branch: null })).toBe('feat-auth');
  });

  it('makes two-letter tiles that tell branches apart', () => {
    expect(worktreeInitials('feat/auth-flow')).toBe('AF');
    expect(worktreeInitials('fix-login')).toBe('FL');
    expect(worktreeInitials('refactor')).toBe('Re');
    expect(worktreeInitials('feat/x')).toBe('X');
    expect(worktreeInitials('')).toBe('?');
  });
});
