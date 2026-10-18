import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useRunPauseStore } from '@/stores/runPauseStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../test/renderer/renderWithProviders';
import { useAutoPauseRuns } from './useAutoPauseRuns';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));

/**
 * The automatic pause, wired to the real stores: an agent tab working in a run's folder freezes
 * the run, and the run comes back a few seconds after the agent stops. The rules themselves are
 * tested in core; this is about what is fed in and what is done with the answer.
 */

const RESULT = {
  ok: true,
  paused: true,
  reason: 'agent',
  pausedAt: 1,
  processCount: 2,
  failedCount: 0,
  containersOnly: false,
};

function agentTab(cwd: string) {
  return {
    a: {
      root: { type: 'group', id: 'g1', tabIds: ['claude', 'shell'], activeTabId: 'claude' },
      tabs: {
        claude: {
          kind: 'terminal',
          id: 'claude',
          title: 'Claude',
          cliId: 'claude-code',
          cwd,
          createdAt: 1,
        },
        shell: { kind: 'terminal', id: 'shell', title: 'Shell', cwd, createdAt: 1 },
      },
    },
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>['workspaces'];
}

function setup(enabled = true) {
  return renderHookWithProviders(() => useAutoPauseRuns(), {
    bridge: {
      'settings.get': { autoPauseRunsWhileAgentWorks: enabled },
      'terminal.runStatus': { available: true, cpuReady: true, sessions: [] },
      'terminal.pause': async (_id: string, reason: string) => ({ ...RESULT, reason }),
      'terminal.resume': { ...RESULT, paused: false, reason: null, pausedAt: null },
    },
  });
}

beforeEach(() => {
  useTerminalStore.setState({
    sessions: [
      {
        id: 'dev',
        title: 'Shop',
        cwd: 'E:\\shop',
        projectId: 'a',
        run: {
          commandId: 'dev',
          label: 'Dev',
          command: 'pnpm dev',
          kind: 'web',
          startedAt: Date.now(),
        },
      },
    ],
  });
  useWorkspaceStore.setState({ workspaces: agentTab('E:\\shop') });
  useAgentStatusStore.setState({ statuses: {} });
  useRunPauseStore.setState({ paused: {}, pending: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoPauseRuns', () => {
  it('pauses the run while the agent in its folder works, without a toast', async () => {
    const { bridge } = setup();
    act(() => useAgentStatusStore.setState({ statuses: { claude: 'working' } }));

    await waitFor(() => expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'agent'));
    await waitFor(() => expect(useRunPauseStore.getState().paused.dev?.reason).toBe('agent'));
  });

  it('resumes it a few seconds after the agent stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bridge } = setup();
    act(() => useAgentStatusStore.setState({ statuses: { claude: 'working' } }));
    await waitFor(() => expect(useRunPauseStore.getState().paused.dev).toBeDefined());

    act(() => useAgentStatusStore.setState({ statuses: { claude: 'needs-input' } }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(() => bridge.$fn('terminal.resume')).toThrow();

    await act(() => vi.advanceTimersByTimeAsync(4000));
    await waitFor(() => expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev'));
  });

  it('ignores a plain shell tab, which is not an agent', async () => {
    const { bridge } = setup();
    act(() => useAgentStatusStore.setState({ statuses: { shell: 'working' } }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => bridge.$fn('terminal.pause')).toThrow();
  });

  it('does nothing while the setting is off', async () => {
    const { bridge, queryClient } = setup(false);
    act(() => useAgentStatusStore.setState({ statuses: { claude: 'working' } }));

    await waitFor(() => expect(queryClient.getQueryData(['settings'])).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => bridge.$fn('terminal.pause')).toThrow();
  });

  it('resumes what it paused once the setting is turned off', async () => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'agent', pausedAt: 1 } }, pending: {} });
    const { bridge } = setup(false);

    await waitFor(() => expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev'));
  });
});
