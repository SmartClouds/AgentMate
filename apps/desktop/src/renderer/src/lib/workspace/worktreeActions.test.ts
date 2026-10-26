// @vitest-environment jsdom
import type { Project, WorktreeInfo } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import { type MergeFlowDeps, mergeBaseInFlow, mergeWorktreeFlow } from './worktreeActions';

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
  status: { changes: 0, ahead: 2, behind: 0, merged: false, unpushed: null },
} satisfies WorktreeInfo;

let bridge: FakeBridge;
let deps: MergeFlowDeps;

beforeEach(() => {
  bridge = installRunovaBridge();
  deps = {
    confirm: vi.fn(async () => true),
    notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    openRemove: vi.fn(),
    openWorkspace: vi.fn(),
    revealChanges: vi.fn(),
  };
});

describe('mergeWorktreeFlow', () => {
  it('checks, asks, merges and offers to remove the finished worktree', async () => {
    bridge.$set('worktrees.mergePreflight', { ok: true });
    bridge.$set('worktrees.merge', { ok: true, message: 'Fast-forward' });

    expect(await mergeWorktreeFlow(project, worktree, deps)).toBe('merged');
    expect(deps.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Merge feat into main?', confirmLabel: 'Merge' }),
    );
    expect(bridge.$fn('worktrees.merge')).toHaveBeenCalledWith('p1', 'wt-1');
    const [title, options] = vi.mocked(deps.notify.success).mock.calls[0] ?? [];
    expect(title).toBe('Merged feat into main');
    options?.action?.onClick();
    expect(deps.openRemove).toHaveBeenCalledWith('p1', 'wt-1');
  });

  it('explains what is in the way instead of trying', async () => {
    bridge.$set('worktrees.mergePreflight', {
      ok: false,
      blocker: { kind: 'worktree-dirty', changes: 3 },
    });
    expect(await mergeWorktreeFlow(project, worktree, deps)).toBe('blocked');
    expect(deps.notify.error).toHaveBeenCalledWith('Not ready to merge', {
      description: 'Commit or discard the 3 changes in this worktree first.',
    });
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('does nothing when the user backs out', async () => {
    bridge.$set('worktrees.mergePreflight', { ok: true });
    deps.confirm = vi.fn(async () => false);
    expect(await mergeWorktreeFlow(project, worktree, deps)).toBe('cancelled');
    expect(() => bridge.$fn('worktrees.merge')).toThrow('has not been touched');
  });

  it('turns a conflict into an offer to bring the base in here instead', async () => {
    bridge.$set('worktrees.mergePreflight', { ok: true });
    bridge.$set('worktrees.merge', { ok: false, conflicts: ['README.md', 'src/a.ts'] });
    bridge.$set('worktrees.mergeBaseIn', { ok: true, message: 'Merged' });

    expect(await mergeWorktreeFlow(project, worktree, deps)).toBe('conflict');
    const [title, options] = vi.mocked(deps.notify.warning).mock.calls[0] ?? [];
    expect(title).toBe('feat and main conflict');
    expect(options?.description).toContain('README.md, src/a.ts');
    expect(options?.action?.label).toBe('Merge main in here');
  });

  it('reports a merge that failed outright', async () => {
    bridge.$set('worktrees.mergePreflight', { ok: true });
    bridge.$set('worktrees.merge', () =>
      Promise.reject(new Error("Error invoking remote method 'worktrees:merge': Error: boom")),
    );
    expect(await mergeWorktreeFlow(project, worktree, deps)).toBe('failed');
    expect(deps.notify.error).toHaveBeenCalledWith('Merge failed', { description: 'boom' });
  });
});

describe('mergeBaseInFlow', () => {
  it('brings the base in', async () => {
    bridge.$set('worktrees.mergeBaseIn', { ok: true, message: 'Merged main' });
    expect(await mergeBaseInFlow(project, worktree, deps)).toBe('merged');
    expect(deps.notify.success).toHaveBeenCalledWith('Merged main into feat', expect.anything());
  });

  it('leaves conflicts in the worktree and takes the user to them', async () => {
    bridge.$set('worktrees.mergeBaseIn', { ok: false, conflicts: ['README.md'] });
    expect(await mergeBaseInFlow(project, worktree, deps)).toBe('conflict');
    expect(deps.openWorkspace).toHaveBeenCalledWith('p1~wt-1');
    expect(deps.revealChanges).toHaveBeenCalled();
    expect(deps.notify.info).toHaveBeenCalledWith('Resolve 1 conflict in feat', expect.anything());
  });
});
