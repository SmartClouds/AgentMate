import type { TerminalPauseResult } from '@shared/apiTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installAgentmatBridge } from '../../../test/renderer/agentmatBridge';
import {
  initRunPauses,
  pauseRuns,
  resumeRuns,
  syncPausesFromStatus,
  togglePauseActiveRun,
  togglePauseRun,
  useRunPauseStore,
} from './runPauseStore';
import { type TerminalSessionMeta, useTerminalStore } from './terminalStore';
import { useWorkspaceStore } from './workspaceStore';

const toast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/**
 * The renderer's view of which runs are frozen. Main is the source of truth; this mirrors it so
 * every place that shows a run (status bar, tab, banner, header) agrees, and says what happened
 * in a toast that leaves no doubt whether the CPU was actually freed.
 */

let bridge: FakeBridge;

function result(over: Partial<TerminalPauseResult> = {}): TerminalPauseResult {
  return {
    ok: true,
    paused: true,
    reason: 'user',
    pausedAt: 5000,
    processCount: 3,
    failedCount: 0,
    containersOnly: false,
    ...over,
  };
}

function runTab(id: string, label = 'Dev', over: Partial<TerminalSessionMeta> = {}) {
  return {
    id,
    title: 'Shop',
    cwd: 'E:\\shop',
    projectId: 'shop',
    run: { commandId: 'dev', label, command: 'pnpm dev', kind: 'web' as const, startedAt: 1000 },
    ...over,
  };
}

beforeEach(() => {
  bridge = installAgentmatBridge({
    'terminal.pause': async (_id: string, reason: 'user' | 'agent') => result({ reason }),
    'terminal.resume': async () => result({ paused: false, reason: null, pausedAt: null }),
  });
  toast.info.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  useRunPauseStore.setState({ paused: {}, pending: {} });
  useTerminalStore.setState({ sessions: [runTab('dev')], activeSessionId: 'dev', isOpen: true });
});

describe('pauseRuns', () => {
  it('asks main to freeze the run and marks it paused', async () => {
    await pauseRuns(['dev']);

    expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'user');
    expect(useRunPauseStore.getState().paused.dev).toEqual({ reason: 'user', pausedAt: 5000 });
    expect(useRunPauseStore.getState().pending).toEqual({});
  });

  it('shows the run as pausing while main is at it', async () => {
    let finish: (value: TerminalPauseResult) => void = () => undefined;
    bridge.$set('terminal.pause', () => new Promise((resolve) => (finish = resolve)));

    const done = pauseRuns(['dev']);
    expect(useRunPauseStore.getState().pending.dev).toBe('pausing');
    finish(result());
    await done;
    expect(useRunPauseStore.getState().pending.dev).toBeUndefined();
  });

  it('says it paused, with a way straight back', async () => {
    await pauseRuns(['dev']);

    expect(toast.success).toHaveBeenCalledWith('Paused "Dev"', {
      description: 'It uses no CPU until you resume it.',
      action: { label: 'Resume', onClick: expect.any(Function) },
    });
    const { action } = toast.success.mock.calls[0][1] as { action: { onClick: () => void } };
    action.onClick();
    await vi.waitFor(() => expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev'));
  });

  it('does not claim CPU was freed when only a Docker client was frozen', async () => {
    bridge.$set('terminal.pause', async () => result({ containersOnly: true }));

    await pauseRuns(['dev']);

    expect(toast.info).toHaveBeenCalledWith('Paused "Dev"', {
      description: 'Its Docker containers keep running, so they still use CPU.',
      action: { label: 'Resume', onClick: expect.any(Function) },
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('mentions processes it could not freeze', async () => {
    bridge.$set('terminal.pause', async () => result({ processCount: 3, failedCount: 1 }));

    await pauseRuns(['dev']);

    expect(toast.success).toHaveBeenCalledWith(
      'Paused "Dev"',
      expect.objectContaining({ description: '1 of 4 processes could not be paused.' }),
    );
  });

  it('reports a failure and leaves the run running', async () => {
    bridge.$set('terminal.pause', async () =>
      result({ ok: false, paused: false, reason: null, pausedAt: null, error: 'access denied' }),
    );

    await pauseRuns(['dev']);

    expect(toast.error).toHaveBeenCalledWith('Could not pause "Dev"', {
      description: 'access denied',
    });
    expect(useRunPauseStore.getState().paused.dev).toBeUndefined();
  });

  it('reports a bridge error the same way', async () => {
    bridge.$set('terminal.pause', async () => {
      throw new Error('IPC down');
    });

    await pauseRuns(['dev']);

    expect(toast.error).toHaveBeenCalledWith('Could not pause "Dev"', { description: 'IPC down' });
    expect(useRunPauseStore.getState().pending).toEqual({});
  });

  it('sums several runs up in one toast', async () => {
    useTerminalStore.setState({ sessions: [runTab('web', 'Web'), runTab('api', 'Api')] });

    await pauseRuns(['web', 'api']);

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Paused 2 runs', {
      description: 'They use no CPU until you resume them.',
      action: { label: 'Resume', onClick: expect.any(Function) },
    });
  });

  it('stays quiet for the automatic pause', async () => {
    await pauseRuns(['dev'], { reason: 'agent', quiet: true });

    expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'agent');
    expect(useRunPauseStore.getState().paused.dev?.reason).toBe('agent');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('skips runs that are already paused or busy', async () => {
    const pause = vi.fn();
    bridge.$set('terminal.pause', pause);
    useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });

    await pauseRuns(['dev']);

    expect(pause).not.toHaveBeenCalled();
  });

  it('lets the user take over a run the agent paused', async () => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'agent', pausedAt: 1 } }, pending: {} });

    await pauseRuns(['dev']);

    expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'user');
    expect(useRunPauseStore.getState().paused.dev?.reason).toBe('user');
  });
});

describe('resumeRuns', () => {
  beforeEach(() => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });
  });

  it('thaws the run and says so', async () => {
    await resumeRuns(['dev']);

    expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev');
    expect(useRunPauseStore.getState().paused.dev).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith('Resumed "Dev"');
  });

  it('keeps it paused when resuming failed', async () => {
    bridge.$set('terminal.resume', async () => result({ ok: false, error: 'helper crashed' }));

    await resumeRuns(['dev']);

    expect(useRunPauseStore.getState().paused.dev).toBeDefined();
    expect(toast.error).toHaveBeenCalledWith('Could not resume "Dev"', {
      description: 'helper crashed',
    });
  });

  it('leaves alone a run that is not paused', async () => {
    const resume = vi.fn();
    bridge.$set('terminal.resume', resume);
    useRunPauseStore.setState({ paused: {}, pending: {} });

    await resumeRuns(['dev']);

    expect(resume).not.toHaveBeenCalled();
  });
});

describe('togglePauseRun and the shortcut', () => {
  it('pauses a running run and resumes a paused one', async () => {
    await togglePauseRun('dev');
    expect(useRunPauseStore.getState().paused.dev).toBeDefined();

    await togglePauseRun('dev');
    expect(useRunPauseStore.getState().paused.dev).toBeUndefined();
  });

  it('does nothing while a change is on its way', async () => {
    const pause = vi.fn();
    bridge.$set('terminal.pause', pause);
    useRunPauseStore.setState({ paused: {}, pending: { dev: 'pausing' } });

    await togglePauseRun('dev');

    expect(pause).not.toHaveBeenCalled();
  });

  it('works on the run the stop shortcut would pick', async () => {
    useTerminalStore.setState({
      sessions: [{ id: 'shell', title: 'Terminal' }, runTab('dev')],
      activeSessionId: 'shell',
      isOpen: true,
    });
    useWorkspaceStore.setState({ activeProjectId: 'shop' });

    await togglePauseActiveRun();

    expect(bridge.$fn('terminal.pause')).toHaveBeenCalledWith('dev', 'user');
  });

  it('says so when nothing is running', async () => {
    useTerminalStore.setState({ sessions: [{ id: 'shell', title: 'Terminal' }] });

    await togglePauseActiveRun();

    expect(toast.info).toHaveBeenCalledWith('Nothing is running');
  });
});

describe('staying in step with main', () => {
  it('follows changes main announces, from any window', () => {
    const stop = initRunPauses();

    bridge.$emit('terminal.onPauseChange', {
      sessionId: 'dev',
      paused: true,
      reason: 'agent',
      pausedAt: 7,
    });
    expect(useRunPauseStore.getState().paused.dev).toEqual({ reason: 'agent', pausedAt: 7 });

    bridge.$emit('terminal.onPauseChange', {
      sessionId: 'dev',
      paused: false,
      reason: null,
      pausedAt: null,
    });
    expect(useRunPauseStore.getState().paused.dev).toBeUndefined();
    stop();
  });

  it('ignores a poll that was asked for before the latest change', async () => {
    const askedAt = Date.now() - 1;
    await pauseRuns(['dev']);

    syncPausesFromStatus(
      [{ sessionId: 'dev', paused: false, pauseReason: null, pausedAt: null }],
      askedAt,
    );

    expect(useRunPauseStore.getState().paused.dev).toBeDefined();
  });

  it('takes the polled status as the truth, except for runs mid-change', () => {
    useRunPauseStore.setState({
      paused: { stale: { reason: 'user', pausedAt: 1 } },
      pending: { busy: 'pausing' },
    });

    syncPausesFromStatus([
      { sessionId: 'stale', paused: false, pauseReason: null, pausedAt: null },
      { sessionId: 'restored', paused: true, pauseReason: 'agent', pausedAt: 9 },
      { sessionId: 'busy', paused: false, pauseReason: null, pausedAt: null },
    ]);

    expect(useRunPauseStore.getState().paused).toEqual({
      restored: { reason: 'agent', pausedAt: 9 },
    });
  });
});
