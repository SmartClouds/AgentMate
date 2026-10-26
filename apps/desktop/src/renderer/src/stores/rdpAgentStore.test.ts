import type { RdpAgentProgress } from '@shared/apiTypes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentBridge, type FakeBridge } from '../../../test/renderer/runovaBridge';
import {
  answerRdpAgentInput,
  approveRdpAgentAction,
  continueRdpAgentTask,
  initRdpAgentStatus,
  isRdpAgentActive,
  isRdpAgentWaitingOnUser,
  sendRdpAgentMessage,
  skipRdpAgentAction,
  startRdpAgentTask,
  stopRdpAgentTask,
  useRdpAgentStore,
} from './rdpAgentStore';

let bridge: FakeBridge;
let stopFollowing: () => void = () => undefined;

beforeEach(() => {
  bridge = currentBridge();
});

afterEach(() => {
  stopFollowing();
  vi.restoreAllMocks();
});

function progress(patch: Partial<RdpAgentProgress>): RdpAgentProgress {
  return { sessionId: 's1', phase: 'thinking', step: 1, ...patch };
}

describe('rdpAgentStore', () => {
  it('starts a task, remembering the mode and AI for next time', async () => {
    await startRdpAgentTask({
      sessionId: 's1',
      prompt: 'open Notepad',
      mode: 'approve-risky',
      cliId: 'codex-cli',
      modelId: 'm1',
      effort: 'high',
    });

    expect(bridge.$fn('rdpAgent.start')).toHaveBeenCalledWith({
      sessionId: 's1',
      prompt: 'open Notepad',
      mode: 'approve-risky',
      cliId: 'codex-cli',
      modelId: 'm1',
      effort: 'high',
    });
    const state = useRdpAgentStore.getState();
    expect(state.sessions.s1).toEqual({ mode: 'approve-risky', phase: 'thinking', step: 0 });
    expect(state.lastMode).toBe('approve-risky');
    expect(state.lastAi).toEqual({ cliId: 'codex-cli', modelId: 'm1', effort: 'high' });
  });

  it('forgets the session when starting fails', async () => {
    bridge.$set('rdpAgent.start', async () => {
      throw new Error('already running');
    });
    await expect(
      startRdpAgentTask({ sessionId: 's1', prompt: 'x', mode: 'autonomous' }),
    ).rejects.toThrow('already running');
    expect(useRdpAgentStore.getState().sessions.s1).toBeUndefined();
  });

  it('sends each user decision to main', () => {
    approveRdpAgentAction('s1');
    skipRdpAgentAction('s1');
    answerRdpAgentInput('s1', 'the blue one');
    stopRdpAgentTask('s1');
    continueRdpAgentTask('s1');

    expect(bridge.$fn('rdpAgent.approveAction')).toHaveBeenCalledWith('s1');
    expect(bridge.$fn('rdpAgent.skipAction')).toHaveBeenCalledWith('s1');
    expect(bridge.$fn('rdpAgent.answerNeedsInput')).toHaveBeenCalledWith('s1', 'the blue one');
    expect(bridge.$fn('rdpAgent.stop')).toHaveBeenCalledWith('s1');
    expect(bridge.$fn('rdpAgent.continueTask')).toHaveBeenCalledWith('s1');
  });

  it('follows progress, keeping the last action and the target marker', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stopFollowing = initRdpAgentStatus(() => 'Office PC');
    bridge.$emit(
      'rdpAgent.onProgress',
      progress({ phase: 'proposed', action: 'CLICK 10 20', target: { x: 0.1, y: 0.2 } }),
    );
    expect(useRdpAgentStore.getState().sessions.s1).toMatchObject({
      mode: 'approve-all',
      phase: 'proposed',
      step: 1,
      action: 'CLICK 10 20',
      target: { x: 0.1, y: 0.2 },
    });

    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'acting', step: 1 }));
    const acting = useRdpAgentStore.getState().sessions.s1;
    expect(acting?.action).toBe('CLICK 10 20');
    // The marker belongs to the proposal only.
    expect(acting?.target).toBeUndefined();
  });

  it('sends a message mid-run and says whether it got there', async () => {
    bridge.$set('rdpAgent.sendMessage', async () => false);
    expect(await sendRdpAgentMessage('s1', 'use the keyboard')).toBe(false);
    expect(bridge.$fn('rdpAgent.sendMessage')).toHaveBeenCalledWith('s1', 'use the keyboard');
  });

  it('follows how many messages wait for the AI', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    stopFollowing = initRdpAgentStatus(() => 'Office PC');
    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'acting', queuedMessages: 2 }));
    expect(useRdpAgentStore.getState().sessions.s1?.queuedMessages).toBe(2);

    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'thinking', step: 2 }));
    expect(useRdpAgentStore.getState().sessions.s1?.queuedMessages).toBeUndefined();
  });

  it('stops following when the returned function is called', () => {
    stopFollowing = initRdpAgentStatus(() => '');
    expect(bridge.$listenerCount('rdpAgent.onProgress')).toBe(1);
    stopFollowing();
    expect(bridge.$listenerCount('rdpAgent.onProgress')).toBe(0);
  });

  it('notifies when the run waits on the user and the window is not focused', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    stopFollowing = initRdpAgentStatus(() => 'Office PC');

    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'thinking' }));
    expect(() => bridge.$fn('rdpAgent.notifyWaiting')).toThrow();

    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'needs-input', message: 'Which file?' }));
    expect(bridge.$fn('rdpAgent.notifyWaiting')).toHaveBeenCalledWith('s1', 'Office PC');

    hasFocus.mockReturnValue(true);
    bridge.$emit('rdpAgent.onProgress', progress({ phase: 'proposed', action: 'TYPE "hi"' }));
    expect(bridge.$fn('rdpAgent.notifyWaiting')).toHaveBeenCalledTimes(1);
  });

  it('tells active and waiting runs apart', () => {
    const base = { mode: 'approve-all' as const, step: 1 };
    expect(isRdpAgentActive(undefined)).toBe(false);
    expect(isRdpAgentActive({ ...base, phase: 'thinking' })).toBe(true);
    expect(isRdpAgentActive({ ...base, phase: 'acting' })).toBe(true);
    expect(isRdpAgentActive({ ...base, phase: 'finished' })).toBe(false);
    expect(isRdpAgentActive({ ...base, phase: 'stopped' })).toBe(false);
    expect(isRdpAgentActive({ ...base, phase: 'error' })).toBe(false);
    expect(isRdpAgentActive({ ...base, phase: 'error', canContinue: true })).toBe(true);

    expect(isRdpAgentWaitingOnUser(undefined)).toBe(false);
    expect(isRdpAgentWaitingOnUser({ ...base, phase: 'proposed' })).toBe(true);
    expect(isRdpAgentWaitingOnUser({ ...base, phase: 'needs-input' })).toBe(true);
    expect(isRdpAgentWaitingOnUser({ ...base, phase: 'error', canContinue: true })).toBe(true);
    expect(isRdpAgentWaitingOnUser({ ...base, phase: 'error' })).toBe(false);
    expect(isRdpAgentWaitingOnUser({ ...base, phase: 'acting' })).toBe(false);
  });

  it('clears a finished session', () => {
    useRdpAgentStore.setState({
      sessions: { s1: { mode: 'autonomous', phase: 'finished', step: 3 } },
    });
    useRdpAgentStore.getState().clear('s1');
    expect(useRdpAgentStore.getState().sessions).toEqual({});
  });
});
