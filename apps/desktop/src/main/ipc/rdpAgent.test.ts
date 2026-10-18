import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RdpAgentHistoryRun, RdpAgentProgress } from '../../shared/apiTypes';
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
 * The IPC face of AI tasks on a Remote Desktop session. The runner itself is replaced: what
 * matters here is that each channel reaches it, and that progress goes back to the window that
 * started the task for as long as the task lasts.
 */

const runner = vi.hoisted(() => ({
  startRdpTask: vi.fn(),
  approveRdpTaskAction: vi.fn(),
  skipRdpTaskAction: vi.fn(),
  answerRdpTaskInput: vi.fn(),
  continueRdpTask: vi.fn(),
  sendRdpTaskMessage: vi.fn(() => true),
  stopRdpTask: vi.fn(),
  getRdpTaskHistory: vi.fn(),
  notifyRdpTaskWaiting: vi.fn(async () => undefined),
}));

vi.mock('../agents/rdpTaskRunner', () => runner);

useTempUserData({ home: false });
expectChannelsCovered(IPC.rdpAgent, [
  // Main to renderer pushes, with no handler of their own.
  IPC.rdpAgent.onRequest,
  IPC.rdpAgent.onProgress,
]);

beforeEach(async () => {
  for (const fn of Object.values(runner)) fn.mockClear();
  await loadIpc(
    () => import('./rdpAgent'),
    (module) => module.registerRdpAgentHandlers(),
  );
});

/** The progress listener the runner was started with. */
function progressListener(): (progress: RdpAgentProgress) => void {
  return runner.startRdpTask.mock.calls.at(-1)?.[1] as (progress: RdpAgentProgress) => void;
}

const input = { sessionId: 'rdp-1', prompt: 'open Notepad', mode: 'autonomous' as const };

describe('starting a task', () => {
  it('passes the input to the runner', async () => {
    await invoke(IPC.rdpAgent.start, input);
    expect(runner.startRdpTask).toHaveBeenCalledWith(input, expect.any(Function));
  });

  it('sends progress to the window that started the task until it ends', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.rdpAgent.start, input);
    const report = progressListener();

    report({ sessionId: 'rdp-1', phase: 'thinking', step: 1 });
    report({ sessionId: 'rdp-1', phase: 'finished', step: 1, message: 'Done.' });
    report({ sessionId: 'rdp-1', phase: 'thinking', step: 2 });

    expect(
      owner.sentOn(IPC.rdpAgent.onProgress).map(([p]) => (p as RdpAgentProgress).phase),
    ).toEqual(['thinking', 'finished']);
  });

  it('keeps sending to the owner while a run is paused on an error', async () => {
    const owner = fakeWebContents();
    await invokeFrom(owner, IPC.rdpAgent.start, input);
    const report = progressListener();

    report({ sessionId: 'rdp-1', phase: 'error', step: 1, message: 'Paused', canContinue: true });
    report({ sessionId: 'rdp-1', phase: 'thinking', step: 1 });

    expect(owner.sentOn(IPC.rdpAgent.onProgress)).toHaveLength(2);
  });

  it('lets a failed start reach the renderer', async () => {
    runner.startRdpTask.mockImplementationOnce(() => {
      throw new Error('This Remote Desktop session is not open.');
    });
    await expect(invoke(IPC.rdpAgent.start, input)).rejects.toThrow('not open');
  });
});

describe('controlling a running task', () => {
  it('reaches the runner from every control channel', async () => {
    await invoke(IPC.rdpAgent.approveAction, 'rdp-1');
    await invoke(IPC.rdpAgent.skipAction, 'rdp-1');
    await invoke(IPC.rdpAgent.answerNeedsInput, 'rdp-1', 'the second file');
    await invoke(IPC.rdpAgent.continue, 'rdp-1');
    await invoke(IPC.rdpAgent.stop, 'rdp-1');

    expect(runner.approveRdpTaskAction).toHaveBeenCalledWith('rdp-1');
    expect(runner.skipRdpTaskAction).toHaveBeenCalledWith('rdp-1');
    expect(runner.answerRdpTaskInput).toHaveBeenCalledWith('rdp-1', 'the second file');
    expect(runner.continueRdpTask).toHaveBeenCalledWith('rdp-1');
    expect(runner.stopRdpTask).toHaveBeenCalledWith('rdp-1');
  });

  it('passes a mid-run message on and says whether the run took it', async () => {
    expect(await invoke(IPC.rdpAgent.sendMessage, 'rdp-1', 'use the keyboard')).toBe(true);
    expect(runner.sendRdpTaskMessage).toHaveBeenCalledWith('rdp-1', 'use the keyboard');

    runner.sendRdpTaskMessage.mockReturnValueOnce(false);
    expect(await invoke(IPC.rdpAgent.sendMessage, 'rdp-1', 'too late')).toBe(false);
  });

  it('returns the history and raises notifications', async () => {
    const history: RdpAgentHistoryRun[] = [
      {
        id: 'run-1',
        sessionId: 'rdp-1',
        prompt: 'open Notepad',
        aiLabel: 'Codex',
        startedAt: 1,
        endedAt: 2,
        status: 'finished',
        entries: [],
      },
    ];
    runner.getRdpTaskHistory.mockReturnValueOnce(history);
    expect(await invoke(IPC.rdpAgent.history, 'rdp-1')).toEqual(history);

    await invoke(IPC.rdpAgent.notifyWaiting, 'rdp-1', 'Build server');
    expect(runner.notifyRdpTaskWaiting).toHaveBeenCalledWith('rdp-1', 'Build server');
  });
});

describe('answers from the Remote Desktop window', () => {
  it('registers the respond channel, which turns down a request it never sent', async () => {
    expect(await invoke(IPC.rdpAgent.respond, { requestId: 'unknown', ok: true })).toBe(false);
  });
});
