import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RdpAgentFrame, RdpAgentProgress, RdpInputOp } from '../../shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '../../shared/sshAgentMessage';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import { dropRdpAgentRequests, requestRdpFrame, requestRdpInput } from '../rdp/agentBridge';
import {
  continueRdpTask,
  getRdpTaskHistory,
  isRdpTaskRunning,
  sendRdpTaskMessage,
  startRdpTask,
  stopRdpTask,
} from './rdpTaskRunner';

/**
 * Messages the user sends a Remote Desktop task that is already running. Set up like
 * rdpTaskRunner.test.ts: the Remote Desktop runner with a scripted AI and a stand-in for the session window: every
 * screenshot it asks for is a fresh 960x540 picture of a 1920x1080 desktop (so screenshot points
 * double), and every input it sends is recorded.
 */

const fake = vi.hoisted(() => ({
  frameCounter: 0,
  /** When set, every screenshot is this same picture. */
  samePng: null as string | null,
  inputs: [] as { sessionId: string; ops: unknown[] }[],
  throttling: [] as { sessionId: string; enabled: boolean }[],
  aiReplies: [] as string[],
  aiPrompts: [] as string[],
  openWindows: new Set<string>(),
  window: {
    show: () => undefined,
    focus: () => undefined,
    restore: () => undefined,
    isMinimized: () => false,
    flashFrame: () => undefined,
  },
  settings: {
    promptBuilderProvider: 'openai',
    openaiModel: 'vision-model',
  } as Record<string, unknown>,
}));

vi.mock('../rdp/agentBridge', () => ({
  requestRdpFrame: vi.fn(),
  requestRdpInput: vi.fn(),
  dropRdpAgentRequests: vi.fn(),
}));

/** Every screenshot is a fresh 960x540 picture of a 1920x1080 desktop, unless `samePng` is set. */
async function nextFrame(): Promise<RdpAgentFrame> {
  fake.frameCounter += 1;
  return {
    png: fake.samePng ?? Buffer.from(`frame-${fake.frameCounter}`).toString('base64'),
    width: 960,
    height: 540,
    desktopWidth: 1920,
    desktopHeight: 1080,
  };
}

async function recordInput(sessionId: string, ops: RdpInputOp[]): Promise<void> {
  fake.inputs.push({ sessionId, ops });
}
vi.mock('../rdp/sessionWindows', () => ({
  getRdpWindow: (sessionId: string) => (fake.openWindows.has(sessionId) ? fake.window : null),
  setRdpWindowBackgroundThrottling: (sessionId: string, enabled: boolean) => {
    fake.throttling.push({ sessionId, enabled });
  },
}));
vi.mock('../store', () => ({
  store: { getSettings: vi.fn(async () => fake.settings) },
}));
vi.mock('../ipc/ai', () => ({
  runAiPrompt: vi.fn(async (_provider: string, _model: string, prompt: string) => {
    fake.aiPrompts.push(prompt);
    return fake.aiReplies.shift() ?? 'FINISHED: out of script';
  }),
}));
vi.mock('../cli/headlessPrompt', () => ({
  cancelHeadlessPrompt: vi.fn(),
  runHeadlessCliPrompt: vi.fn(),
}));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: vi.fn() }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: vi.fn(() => true) }));

let sessionCounter = 0;

beforeEach(() => {
  fake.frameCounter = 0;
  fake.samePng = null;
  fake.inputs.length = 0;
  fake.throttling.length = 0;
  fake.aiReplies.length = 0;
  fake.aiPrompts.length = 0;
  fake.settings = { promptBuilderProvider: 'openai', openaiModel: 'vision-model' };
  vi.mocked(runAiPrompt).mockClear();
  vi.mocked(runHeadlessCliPrompt).mockReset();
  vi.mocked(requestRdpFrame).mockReset().mockImplementation(nextFrame);
  vi.mocked(requestRdpInput).mockReset().mockImplementation(recordInput);
  vi.mocked(dropRdpAgentRequests).mockClear();
  vi.mocked(cancelHeadlessPrompt).mockClear();
});

afterEach(() => {
  for (const sessionId of fake.openWindows) stopRdpTask(sessionId);
  fake.openWindows.clear();
});

function openSession(): string {
  sessionCounter += 1;
  const sessionId = `rdp-${sessionCounter}`;
  fake.openWindows.add(sessionId);
  return sessionId;
}

function startTask(
  sessionId: string,
  replies: string[],
  options: { mode?: 'autonomous' | 'approve-all' | 'approve-risky'; cliId?: string } = {},
  onProgress: (progress: RdpAgentProgress) => void = () => undefined,
): RdpAgentProgress[] {
  fake.aiReplies.push(...replies);
  const progress: RdpAgentProgress[] = [];
  startRdpTask(
    {
      sessionId,
      prompt: 'open Notepad and type hello',
      mode: options.mode ?? 'autonomous',
      cliId: options.cliId,
    },
    (p) => {
      progress.push(p);
      onProgress(p);
    },
  );
  return progress;
}

async function waitForPhase(progress: RdpAgentProgress[], phase: RdpAgentProgress['phase']) {
  await vi.waitFor(() => expect(progress.map((p) => p.phase)).toContain(phase), {
    timeout: 5000,
  });
}

const CLICK_OPS: RdpInputOp[] = [
  { kind: 'move', x: 1024, y: 600 },
  { kind: 'button', button: 0, down: true },
  { kind: 'button', button: 0, down: false },
];

/** Holds the next API reply until the test lets it through, so a message can land mid-thought. */
function holdNextAiReply(reply: string): { release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(runAiPrompt).mockImplementationOnce(async (_provider, _model, prompt) => {
    fake.aiPrompts.push(prompt);
    await held;
    return reply;
  });
  return { release };
}

describe('messaging a running Remote Desktop task', () => {
  it('skips the action waiting for approval and asks the AI again with the message', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');

    expect(sendRdpTaskMessage(sessionId, '  type it in Word instead  ')).toBe(true);
    await waitForPhase(progress, 'finished');

    // The skipped TYPE never reached the desktop.
    expect(fake.inputs).toEqual([]);
    expect(fake.aiPrompts[1]).toContain('skipped by user');
    // The message sits right under the task, outside its quotes.
    expect(fake.aiPrompts[1]).toContain(
      'open Notepad and type hello"\n\nThe user added these while you were working, oldest first.',
    );
    expect(fake.aiPrompts[1]).toContain('- type it in Word instead');
    expect(getRdpTaskHistory(sessionId)[0]?.entries).toEqual([
      expect.objectContaining({ kind: 'message', text: 'type it in Word instead' }),
      expect.objectContaining({ kind: 'skipped', action: 'TYPE "hello"' }),
      expect.objectContaining({ kind: 'finished', text: 'done' }),
    ]);
  });

  it('drops the reply the AI was working out and never acts on it', async () => {
    const sessionId = openSession();
    const held = holdNextAiReply('TYPE "hello"');
    const progress = startTask(sessionId, ['CLICK 512 300', 'FINISHED: done']);
    await vi.waitFor(() => expect(fake.aiPrompts).toHaveLength(1));

    sendRdpTaskMessage(sessionId, 'click the Start button first');
    held.release();
    await waitForPhase(progress, 'finished');

    // The TYPE answered a prompt without the message, so only the CLICK from the retry ran.
    expect(fake.inputs).toEqual([{ sessionId, ops: CLICK_OPS }]);
    expect(fake.aiPrompts[0]).not.toContain('click the Start button first');
    expect(fake.aiPrompts[1]).toContain('- click the Start button first');
    // The retry keeps the step number of the reply it replaced.
    expect(progress.find((p) => p.phase === 'acting')?.step).toBe(1);
    expect(progress.some((p) => p.phase === 'error')).toBe(false);
  });

  it('cancels a CLI working out its step, without treating that as a failure', async () => {
    const sessionId = openSession();
    const requestIds: string[] = [];
    vi.mocked(runHeadlessCliPrompt)
      .mockImplementationOnce(async (prompt, _cwd, options) => {
        fake.aiPrompts.push(prompt);
        requestIds.push(options?.requestId ?? '');
        // What a cancelled CLI resolves with.
        await vi.waitFor(() => expect(cancelHeadlessPrompt).toHaveBeenCalled());
        return { ok: false, text: '', error: 'Cancelled.', cliName: 'Codex' };
      })
      .mockImplementationOnce(async (prompt) => {
        fake.aiPrompts.push(prompt);
        return { ok: true, text: 'FINISHED: done', cliName: 'Codex' };
      });
    const progress = startTask(sessionId, [], { cliId: 'codex-cli' });
    await vi.waitFor(() => expect(requestIds).toHaveLength(1));

    sendRdpTaskMessage(sessionId, 'use the other monitor');
    await waitForPhase(progress, 'finished');

    expect(cancelHeadlessPrompt).toHaveBeenCalledWith(requestIds[0]);
    expect(progress.some((p) => p.phase === 'error')).toBe(false);
    expect(fake.aiPrompts[1]).toContain('- use the other monitor');
  });

  it('reports the message as queued at once, until the AI is asked with it', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');
    const before = progress.length;

    sendRdpTaskMessage(sessionId, 'stop after this');
    // The very next report still says what the run was doing, now with the queue.
    expect(progress[before]).toMatchObject({ phase: 'proposed', queuedMessages: 1 });
    await waitForPhase(progress, 'finished');
    const thinking = progress.slice(before + 1).find((p) => p.phase === 'thinking');
    expect(thinking?.queuedMessages).toBeUndefined();
  });

  it('holds a message for a paused run until Continue', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['not an action', 'FINISHED: done']);
    await waitForPhase(progress, 'error');

    sendRdpTaskMessage(sessionId, 'try the keyboard');
    expect(progress.at(-1)).toMatchObject({ phase: 'error', canContinue: true, queuedMessages: 1 });
    expect(fake.aiPrompts).toHaveLength(1);

    continueRdpTask(sessionId);
    await waitForPhase(progress, 'finished');
    expect(fake.aiPrompts[1]).toContain('- try the keyboard');
  });

  it('keeps every message, oldest first', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');
    sendRdpTaskMessage(sessionId, 'first');
    sendRdpTaskMessage(sessionId, 'second\non two lines');
    await waitForPhase(progress, 'finished');

    expect(fake.aiPrompts.at(-1)).toContain('- first\n- second\n  on two lines');
  });

  it('cuts a long message to the limit', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');
    sendRdpTaskMessage(sessionId, `  ${'y'.repeat(MAX_SSH_AGENT_MESSAGE_CHARS + 50)}  `);
    await waitForPhase(progress, 'finished');

    const [message] = getRdpTaskHistory(sessionId)[0]?.entries ?? [];
    expect(message).toMatchObject({
      kind: 'message',
      text: 'y'.repeat(MAX_SSH_AGENT_MESSAGE_CHARS),
    });
  });

  it('turns down a message with nobody to read it', async () => {
    expect(sendRdpTaskMessage('no-such-session', 'hello')).toBe(false);

    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"'], { mode: 'approve-all' });
    await waitForPhase(progress, 'proposed');
    expect(sendRdpTaskMessage(sessionId, '   ')).toBe(false);
    expect(progress.at(-1)?.queuedMessages).toBeUndefined();

    stopRdpTask(sessionId);
    expect(sendRdpTaskMessage(sessionId, 'too late')).toBe(false);
    expect(isRdpTaskRunning(sessionId)).toBe(false);
  });
});
