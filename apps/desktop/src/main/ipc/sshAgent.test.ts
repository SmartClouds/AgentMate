import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAgentHistoryRun, SshAgentProgress } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { fakeWebContents } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The IPC face of AI tasks in a terminal. The runner itself is replaced: what matters here is that
 * each channel reaches it, and that progress goes back to the window that started the task for as
 * long as the task lasts.
 */

const runner = vi.hoisted(() => ({
  startSshTask: vi.fn(),
  approveSshTaskCommand: vi.fn(),
  skipSshTaskCommand: vi.fn(),
  answerSshTaskInput: vi.fn(),
  answerSshTaskPassword: vi.fn(),
  sendSshTaskMessage: vi.fn(() => true),
  continueSshTask: vi.fn(),
  stopSshTask: vi.fn(),
  getSshTaskHistory: vi.fn(),
  getSshServerTaskHistory: vi.fn((): SshAgentHistoryRun[] => []),
  notifySshTaskWaiting: vi.fn(async () => undefined),
}));

vi.mock('../agents/sshTaskRunner', () => runner);

useTempUserData({ home: false });
expectChannelsCovered(IPC.sshAgent, [
  // Main to renderer push, with no handler of its own.
  IPC.sshAgent.onProgress,
]);

beforeEach(async () => {
  for (const fn of Object.values(runner)) fn.mockClear();
  await loadIpc(
    () => import('./sshAgent'),
    (module) => module.registerSshAgentHandlers(),
  );
});

/** The progress listener the runner was started with. */
function progressListener(): (progress: SshAgentProgress) => void {
  return runner.startSshTask.mock.calls.at(-1)?.[1] as (progress: SshAgentProgress) => void;
}

const input = {
  sessionId: 'ssh-1',
  prompt: 'check disk usage',
  mode: 'autonomous' as const,
  target: 'ssh' as const,
};

describe('starting a task', () => {
  it('sends progress to the window that started the task until it ends', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.sshAgent.start, input);
    const report = progressListener();

    report({ sessionId: 'ssh-1', phase: 'thinking', step: 1 });
    report({ sessionId: 'ssh-1', phase: 'finished', step: 1, message: 'Done.' });
    report({ sessionId: 'ssh-1', phase: 'thinking', step: 2 });

    expect(
      owner.sentOn(IPC.sshAgent.onProgress).map(([p]) => (p as SshAgentProgress).phase),
    ).toEqual(['thinking', 'finished']);
  });

  it('passes the queued message count through to the window', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.sshAgent.start, input);

    progressListener()({ sessionId: 'ssh-1', phase: 'running', step: 1, queuedMessages: 2 });

    expect(owner.sentOn(IPC.sshAgent.onProgress)[0]?.[0]).toMatchObject({ queuedMessages: 2 });
  });
});

describe('controlling a running task', () => {
  it('reaches the runner from every control channel', async () => {
    await invoke(IPC.sshAgent.approveCommand, 'ssh-1');
    await invoke(IPC.sshAgent.skipCommand, 'ssh-1');
    await invoke(IPC.sshAgent.answerNeedsInput, 'ssh-1', '/var/log');
    await invoke(IPC.sshAgent.answerPassword, 'ssh-1', true);
    await invoke(IPC.sshAgent.continue, 'ssh-1');
    await invoke(IPC.sshAgent.stop, 'ssh-1');

    expect(runner.approveSshTaskCommand).toHaveBeenCalledWith('ssh-1');
    expect(runner.skipSshTaskCommand).toHaveBeenCalledWith('ssh-1');
    expect(runner.answerSshTaskInput).toHaveBeenCalledWith('ssh-1', '/var/log');
    expect(runner.answerSshTaskPassword).toHaveBeenCalledWith('ssh-1', true);
    expect(runner.continueSshTask).toHaveBeenCalledWith('ssh-1');
    expect(runner.stopSshTask).toHaveBeenCalledWith('ssh-1');
  });

  it('returns the history and raises notifications', async () => {
    const history: SshAgentHistoryRun[] = [
      {
        id: 'run-1',
        sessionId: 'ssh-1',
        prompt: 'check disk usage',
        aiLabel: 'Codex',
        startedAt: 1,
        endedAt: 2,
        status: 'finished',
        entries: [{ kind: 'message', at: 1, text: 'only /var' }],
      },
    ];
    runner.getSshTaskHistory.mockReturnValueOnce(history);
    expect(await invoke(IPC.sshAgent.history, 'ssh-1')).toEqual(history);

    await invoke(IPC.sshAgent.notifyWaiting, 'ssh-1', 'Build server');
    expect(runner.notifySshTaskWaiting).toHaveBeenCalledWith('ssh-1', 'Build server');
  });

  it("returns a saved server's tasks from every tab, and nothing for a bad id", async () => {
    const history: SshAgentHistoryRun[] = [
      {
        id: 'run-2',
        sessionId: 'ssh-gone',
        serverId: 'srv-1',
        prompt: 'restart nginx',
        aiLabel: 'OpenAI',
        startedAt: 1,
        endedAt: 2,
        status: 'finished',
        entries: [],
      },
    ];
    runner.getSshServerTaskHistory.mockReturnValueOnce(history);
    expect(await invoke(IPC.sshAgent.serverHistory, 'srv-1')).toEqual(history);
    expect(runner.getSshServerTaskHistory).toHaveBeenCalledWith('srv-1');

    runner.getSshServerTaskHistory.mockClear();
    expect(await invoke(IPC.sshAgent.serverHistory, 42)).toEqual([]);
    expect(await invoke(IPC.sshAgent.serverHistory, '')).toEqual([]);
    expect(runner.getSshServerTaskHistory).not.toHaveBeenCalled();
  });
});

describe('messaging a running task', () => {
  it('hands the text to the runner and returns whether it was taken', async () => {
    expect(await invoke(IPC.sshAgent.sendMessage, 'ssh-1', 'also check memory')).toBe(true);
    expect(runner.sendSshTaskMessage).toHaveBeenCalledWith('ssh-1', 'also check memory');
  });

  it('returns false when the task is already over, so the window keeps the text', async () => {
    runner.sendSshTaskMessage.mockReturnValueOnce(false);
    expect(await invoke(IPC.sshAgent.sendMessage, 'ssh-1', 'too late')).toBe(false);
  });
});
