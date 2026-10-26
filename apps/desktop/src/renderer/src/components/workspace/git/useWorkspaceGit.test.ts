// @vitest-environment jsdom
import type { Project } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { currentBridge, installRunovaBridge } from '../../../../../test/renderer/runovaBridge';
import {
  openChangedFile,
  useAiResolving,
  useAiResolvingPaths,
  useGitActions,
} from './useWorkspaceGit';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * Where a row in the changes panel sends you. A file the app can show opens in a tab; anything
 * else is handed to the operating system, since the renderer only ever reads inside a project.
 */

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;
const openFile = vi.fn();

beforeEach(() => {
  installRunovaBridge();
  openFile.mockClear();
  useWorkspaceStore.setState({ openFile } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openChangedFile', () => {
  it('opens a text file in an editor tab', () => {
    openChangedFile(project, '', 'src/index.ts', false);
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\src\\index.ts', { pin: true });
  });

  it('opens a binary image in the viewer rather than in another app', () => {
    openChangedFile(project, '', 'assets/logo.png', true);
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\assets\\logo.png', { pin: true });
    // $fn throws for a path the code never touched, which is the point: nothing was shelled out.
    expect(() => currentBridge().$fn('shell.openPath')).toThrow('has not been touched');
  });

  it('hands another binary file to its default app', () => {
    openChangedFile(project, '', 'dist/bundle.zip', true);
    expect(openFile).not.toHaveBeenCalled();
    expect(currentBridge().$fn('shell.openPath')).toHaveBeenCalledWith(
      'E:\\work\\app\\dist\\bundle.zip',
    );
  });

  it('hands over an image that sits outside the project folder', () => {
    // The project is a subfolder of the repository, so `docs/` is in the repo but not readable.
    openChangedFile(project, 'app', 'docs/logo.png', true);
    expect(openFile).not.toHaveBeenCalled();
    expect(currentBridge().$fn('shell.openPath')).toHaveBeenCalledWith('E:\\work\\docs\\logo.png');
  });

  it('opens an image inside the project even when the repository sits above it', () => {
    openChangedFile(project, 'app', 'app/assets/logo.png', true);
    expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\assets\\logo.png', { pin: true });
  });
});

describe('commit and push', () => {
  const state = (upstream: string | null) =>
    ({ isRepo: true, branch: 'feature', upstream, hasRemote: true }) as WorkspaceGitState;

  it('treats pushing an unpublished branch as publishing it', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useGitActions('p1'), {
      bridge: { 'git.commitStaged': { ok: true, message: '' }, 'pullRequests.status': null },
    });
    queryClient.setQueryData(queryKeys.gitWorkspaceState('p1'), state(null));
    await act(async () => {
      expect(await result.current.commit('Add it', true)).toBe(true);
    });
    expect(toast.success).toHaveBeenCalledWith('Committed and published', expect.anything());
  });

  it('keeps the plain message for a branch that already tracks a remote', async () => {
    const { result, queryClient } = renderHookWithProviders(() => useGitActions('p1'), {
      bridge: { 'git.commitStaged': { ok: true, message: '' } },
    });
    queryClient.setQueryData(queryKeys.gitWorkspaceState('p1'), state('origin/feature'));
    await act(async () => {
      await result.current.commit('Add it', true);
    });
    expect(toast.success).toHaveBeenCalledWith('Committed and pushed', { description: 'Add it' });
  });
});

describe('resolve with AI', () => {
  type Answer = import('@shared/apiTypes').ResolveConflictWithAiResult;

  /** A run that only finishes when the test says so, like a CLI still editing the file. */
  function pendingRun() {
    let finish: (answer: Answer) => void = () => undefined;
    const run = vi.fn(
      (_projectId: string, _path: string, _requestId: string) =>
        new Promise<Answer>((resolve) => {
          finish = resolve;
        }),
    );
    return { run, finish: (answer: Answer) => finish(answer) };
  }

  function renderAi(bridge: Record<string, unknown>) {
    return renderHookWithProviders(
      () => ({
        actions: useGitActions('p1'),
        resolving: useAiResolving('p1', 'src/app.ts'),
        isResolving: useAiResolvingPaths('p1'),
      }),
      { bridge },
    );
  }

  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('shows the file as being resolved until the run comes back', async () => {
    const { run, finish } = pendingRun();
    const { result } = renderAi({ 'git.resolveConflictWithAi': run });

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.actions.resolveWithAi('src/app.ts');
    });
    expect(result.current.resolving).toBe(true);
    expect(result.current.isResolving('src/app.ts')).toBe(true);
    expect(result.current.isResolving('src/other.ts')).toBe(false);
    expect(run).toHaveBeenCalledWith('p1', 'src/app.ts', expect.any(String));

    await act(async () => {
      finish({ ok: true, message: 'Claude Code resolved src/app.ts.', undoToken: 't1' });
      await done;
    });
    expect(result.current.resolving).toBe(false);
  });

  it('stops the run behind a second click instead of starting another', async () => {
    const { run, finish } = pendingRun();
    const { result, bridge } = renderAi({
      'git.resolveConflictWithAi': run,
      'git.cancelResolveConflictWithAi': async () => true,
    });

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.actions.resolveWithAi('src/app.ts');
    });
    const requestId = run.mock.calls[0]?.[2];
    await act(async () => {
      await result.current.actions.resolveWithAi('src/app.ts');
    });

    expect(run).toHaveBeenCalledOnce();
    expect(bridge.$fn('git.cancelResolveConflictWithAi')).toHaveBeenCalledWith(requestId);
    // Main still has to put the file back, so the row keeps showing the run until it answers.
    expect(result.current.resolving).toBe(true);

    await act(async () => {
      finish({ ok: false, cancelled: true, message: 'Stopped. The file is back as it was.' });
      await done;
    });
    expect(result.current.resolving).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports success with the CLI's summary and an undo", async () => {
    const { result, bridge } = renderAi({
      'git.resolveConflictWithAi': {
        ok: true,
        message: 'Claude Code resolved src/app.ts. Review it, then mark it as resolved.',
        summary: 'Kept both exports.',
        undoToken: 't1',
      },
      'git.undoDiscard': { ok: true, message: 'Restored.' },
    });

    await act(async () => {
      await result.current.actions.resolveWithAi('src/app.ts');
    });

    expect(toast.success).toHaveBeenCalledWith(
      'Claude Code resolved src/app.ts. Review it, then mark it as resolved.',
      expect.objectContaining({ description: 'Kept both exports.' }),
    );
    const options = toast.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    options.action.onClick();
    expect(bridge.$fn('git.undoDiscard')).toHaveBeenCalledWith('p1', 't1');
  });

  it('says why when the CLI could not resolve it', async () => {
    const { result } = renderAi({
      'git.resolveConflictWithAi': {
        ok: false,
        message: 'Claude Code left conflict markers in the file. The file is back as it was.',
      },
    });

    await act(async () => {
      await result.current.actions.resolveWithAi('src/app.ts');
    });

    expect(toast.error).toHaveBeenCalledWith('AI could not resolve the conflict', {
      description: 'Claude Code left conflict markers in the file. The file is back as it was.',
    });
    expect(result.current.resolving).toBe(false);
  });

  it('keeps runs apart per project', async () => {
    const { run, finish } = pendingRun();
    const { result } = renderAi({ 'git.resolveConflictWithAi': run });
    const other = renderHookWithProviders(() => useAiResolving('p2', 'src/app.ts'));

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.actions.resolveWithAi('src/app.ts');
    });
    expect(result.current.resolving).toBe(true);
    expect(other.result.current).toBe(false);

    await act(async () => {
      finish({ ok: false, cancelled: true, message: '' });
      await done;
    });
  });
});
