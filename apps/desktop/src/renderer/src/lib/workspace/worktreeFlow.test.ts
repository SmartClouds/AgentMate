import type { Project, WorktreeInfo } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceProject } from './scope';
import {
  type CreateStep,
  type CreateWorktreeDeps,
  type CreateWorktreePlan,
  plannedSteps,
  runCreateWorktree,
} from './worktreeFlow';

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

function plan(patch: Partial<CreateWorktreePlan> = {}): CreateWorktreePlan {
  return {
    project,
    input: { projectId: 'p1', branch: 'feat', mode: 'new', base: 'main', path: null },
    copyFiles: ['.env'],
    setupCommand: 'pnpm install',
    agent: { cliId: 'claude-code', name: 'Claude Code', prompt: 'Add a login page' },
    ...patch,
  };
}

function deps(patch: Partial<CreateWorktreeDeps> = {}): CreateWorktreeDeps {
  return {
    create: vi.fn(async () => ({ ok: true as const, worktree })),
    copyFiles: vi.fn(async () => ['.env']),
    open: vi.fn(),
    setup: vi.fn(() => 'setup-tab'),
    launchAgent: vi.fn(() => 'agent-tab'),
    ...patch,
  };
}

/** Every state the step list went through, as `id:status` strings. */
function track(): { onChange: (steps: CreateStep[]) => void; history: string[][] } {
  const history: string[][] = [];
  return { history, onChange: (steps) => history.push(steps.map((s) => `${s.id}:${s.status}`)) };
}

describe('plannedSteps', () => {
  it('lists only what was asked for, in order, with plain labels', () => {
    expect(plannedSteps(plan()).map((s) => s.label)).toEqual([
      'Creating the worktree',
      'Copying 1 local file',
      'Opening its workspace',
      'Running setup',
      'Starting Claude Code',
    ]);
    expect(
      plannedSteps(plan({ copyFiles: [], setupCommand: '', agent: null })).map((s) => s.id),
    ).toEqual(['create', 'open']);
    expect(plannedSteps(plan({ copyFiles: ['.env', '.env.local'] }))[1]?.label).toBe(
      'Copying 2 local files',
    );
  });
});

describe('runCreateWorktree', () => {
  it('runs every step in order and opens the new workspace', async () => {
    const d = deps();
    const { onChange, history } = track();
    const result = await runCreateWorktree(plan(), onChange, d);

    expect(result).toEqual({ ok: true, scopeId: 'p1~wt-1', worktree });
    expect(history.at(-1)).toEqual([
      'create:done',
      'copy:done',
      'open:done',
      'setup:done',
      'agent:done',
    ]);
    // Each step is shown running before it is done.
    expect(history[0]).toEqual([
      'create:running',
      'copy:pending',
      'open:pending',
      'setup:pending',
      'agent:pending',
    ]);
    expect(d.copyFiles).toHaveBeenCalledWith('p1', 'wt-1', ['.env']);
    expect(d.open).toHaveBeenCalledWith('p1~wt-1');
  });

  it('starts setup and the agent inside the worktree, not the main checkout', async () => {
    const d = deps();
    await runCreateWorktree(plan(), () => undefined, d);
    const [setupProject, command] = vi.mocked(d.setup).mock.calls[0] ?? [];
    expect(setupProject).toMatchObject({
      id: 'p1~wt-1',
      folderPath: worktree.path,
      parentId: 'p1',
    });
    expect(command).toBe('pnpm install');
    const [agentProject, cliId, prompt] = vi.mocked(d.launchAgent).mock.calls[0] ?? [];
    expect((agentProject as WorkspaceProject).folderPath).toBe(worktree.path);
    expect(cliId).toBe('claude-code');
    expect(prompt).toBe('Add a login page');
  });

  it('stops at a failed create and says why', async () => {
    const d = deps({ create: vi.fn(async () => ({ ok: false as const, error: 'Branch taken.' })) });
    const { onChange, history } = track();
    const result = await runCreateWorktree(plan(), onChange, d);
    expect(result).toEqual({ ok: false, error: 'Branch taken.' });
    expect(history.at(-1)).toEqual([
      'create:error',
      'copy:pending',
      'open:pending',
      'setup:pending',
      'agent:pending',
    ]);
    expect(d.open).not.toHaveBeenCalled();
  });

  it('carries on when copying files fails, since the worktree itself is fine', async () => {
    const d = deps({ copyFiles: vi.fn(async () => Promise.reject(new Error('locked'))) });
    const steps: CreateStep[][] = [];
    const result = await runCreateWorktree(plan(), (s) => steps.push(s), d);
    expect(result.ok).toBe(true);
    const copy = steps.at(-1)?.find((s) => s.id === 'copy');
    expect(copy).toMatchObject({ status: 'error', detail: 'locked' });
    expect(d.open).toHaveBeenCalled();
  });

  it('reports an agent that could not start without undoing the rest', async () => {
    const d = deps({ launchAgent: vi.fn(() => null) });
    const steps: CreateStep[][] = [];
    const result = await runCreateWorktree(plan(), (s) => steps.push(s), d);
    expect(result.ok).toBe(true);
    expect(steps.at(-1)?.find((s) => s.id === 'agent')?.status).toBe('error');
  });

  it('notes when fewer files were copied than planned, because they were already there', async () => {
    const d = deps({ copyFiles: vi.fn(async () => []) });
    const steps: CreateStep[][] = [];
    await runCreateWorktree(plan(), (s) => steps.push(s), d);
    expect(steps.at(-1)?.find((s) => s.id === 'copy')).toMatchObject({
      status: 'done',
      detail: 'Already there, nothing copied',
    });
  });
});
