import type { AutoFixSession } from '@shared/ciAutoFixTypes';
import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * Sessions live in main and change while the user looks at something else, so the list has to
 * follow main's pushes rather than a poll, and an attempt's tab has to show up in the workspace
 * even when the project is not the one on screen.
 */

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { useAutoFixActions, useAutoFixSessions, useAutoFixTabs } = await import('./useAutoFix');

const session = (patch: Partial<AutoFixSession> = {}) =>
  ({
    id: 'fix-1',
    phase: 'watching',
    workflowName: 'CI',
    branch: 'main',
    ...patch,
  }) as AutoFixSession;

beforeEach(() => {
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

describe('useAutoFixSessions', () => {
  it('loads the sessions and follows what main pushes', async () => {
    const { result, bridge } = renderHookWithProviders(() => useAutoFixSessions(), {
      bridge: { 'ciAutoFix.list': [session()] },
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    act(() => bridge.$emit('ciAutoFix.onChanged', [session(), session({ id: 'fix-2' })]));
    await waitFor(() =>
      expect(result.current.sessions.map((item) => item.id)).toEqual(['fix-1', 'fix-2']),
    );
  });

  it('stops listening when unmounted', () => {
    const { bridge, unmount } = renderHookWithProviders(() => useAutoFixSessions());
    expect(bridge.$listenerCount('ciAutoFix.onChanged')).toBe(1);
    unmount();
    expect(bridge.$listenerCount('ciAutoFix.onChanged')).toBe(0);
  });
});

describe('useAutoFixActions', () => {
  it('says auto-fix is on, and what it will do, when it starts', async () => {
    const { result, bridge } = renderHookWithProviders(() => useAutoFixActions(), {
      bridge: { 'ciAutoFix.start': { ok: true, session: session() } },
    });
    await act(() =>
      result.current.start({
        projectId: 'p',
        repo: 'a/b',
        workflowId: 9,
        workflowName: 'CI',
        branch: 'main',
        runId: 1,
      }),
    );
    expect(bridge.$fn('ciAutoFix.start')).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1 }),
    );
    expect(toast.success).toHaveBeenCalledWith('Auto-fix is on for CI', {
      description: 'If the run fails, an agent fixes it and Runova pushes the fix to main.',
    });
  });

  it('shows why it could not start', async () => {
    const { result } = renderHookWithProviders(() => useAutoFixActions(), {
      bridge: { 'ciAutoFix.start': { ok: false, error: 'Pick an agent CLI first.' } },
    });
    const started = await act(() =>
      result.current.start({
        projectId: 'p',
        repo: 'a/b',
        workflowId: 9,
        workflowName: 'CI',
        branch: 'main',
      }),
    );
    expect(started).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Auto-fix could not start', {
      description: 'Pick an agent CLI first.',
    });
  });

  it('passes the session id on for stop, commit now, retry and clear', async () => {
    const { result, bridge } = renderHookWithProviders(() => useAutoFixActions(), {
      bridge: {
        'ciAutoFix.stop': session({ phase: 'stopped' }),
        'ciAutoFix.commitNow': session(),
        'ciAutoFix.retry': session(),
        'ciAutoFix.dismiss': async () => true,
      },
    });
    await act(() => result.current.stop('fix-1'));
    await act(() => result.current.commitNow('fix-1'));
    await act(() => result.current.retry('fix-1'));
    await act(() => result.current.dismiss('fix-1'));
    for (const name of ['stop', 'commitNow', 'retry', 'dismiss']) {
      expect(bridge.$fn(`ciAutoFix.${name}`)).toHaveBeenCalledWith('fix-1');
    }
    expect(toast).toHaveBeenCalledWith('Auto-fix stopped', {
      description: 'The agent tab stays open. Nothing more is committed or pushed.',
    });
  });
});

describe('useAutoFixTabs', () => {
  const TAB = {
    projectId: 'p2',
    tabId: 'fix-tab-1',
    sessionId: 'fix-1',
    cliId: 'claude-code',
    title: 'Auto-fix #7 · Claude Code CLI',
    runLabel: 'Attempt 1',
    cwd: 'E:/work/p2',
  };

  it('shows the tab main opened, without leaving the project on screen', () => {
    useWorkspaceStore.getState().openProject('p1');
    const { bridge } = renderHookWithProviders(() => useAutoFixTabs());
    bridge.$emit('ciAutoFix.onTab', TAB);
    const state = useWorkspaceStore.getState();
    expect(state.activeProjectId).toBe('p1');
    expect(state.workspaces.p2.tabs['fix-tab-1']).toMatchObject({
      kind: 'terminal',
      cliId: 'claude-code',
      title: 'Auto-fix #7 · Claude Code CLI',
      runLabel: 'Attempt 1',
      cwd: 'E:/work/p2',
      restored: true,
    });
  });

  it('stops listening when unmounted', () => {
    const { bridge, unmount } = renderHookWithProviders(() => useAutoFixTabs());
    unmount();
    expect(bridge.$listenerCount('ciAutoFix.onTab')).toBe(0);
  });
});
