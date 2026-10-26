import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RdpAgentFrame, RdpAgentProgress, RdpInputOp } from '../../shared/apiTypes';
import { runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import { showOsNotification } from '../notifications/osNotification';
import { dropRdpAgentRequests, requestRdpFrame, requestRdpInput } from '../rdp/agentBridge';
import {
  answerRdpTaskInput,
  approveRdpTaskAction,
  continueRdpTask,
  getRdpTaskHistory,
  isRdpTaskRunning,
  notifyRdpTaskWaiting,
  skipRdpTaskAction,
  startRdpTask,
  stopRdpTask,
} from './rdpTaskRunner';

/**
 * The Remote Desktop runner with a scripted AI and a stand-in for the session window: every
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
  vi.mocked(showOsNotification).mockClear();
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

describe('AI task on a Remote Desktop session', () => {
  it('clicks where the AI points, then finishes, and keeps a history', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['CLICK 512 300', 'FINISHED: Opened Notepad.']);
    await waitForPhase(progress, 'finished');

    expect(fake.inputs).toEqual([{ sessionId, ops: CLICK_OPS }]);
    const acting = progress.find((p) => p.phase === 'acting');
    expect(acting).toMatchObject({
      step: 1,
      action: 'CLICK 512 300',
      target: { x: 1024 / 1920, y: 600 / 1080 },
    });
    expect(progress.at(-1)).toMatchObject({ phase: 'finished', message: 'Opened Notepad.' });
    expect(fake.aiPrompts[1]).toContain('> CLICK 512 300 -> clicked at (1024, 600)');
    expect(fake.aiPrompts[0]).toContain('960 x 540');

    const [run] = getRdpTaskHistory(sessionId);
    expect(run).toMatchObject({ status: 'finished', aiLabel: 'OpenAI' });
    expect(run?.entries).toEqual([
      expect.objectContaining({
        kind: 'action',
        action: 'CLICK 512 300',
        outcome: 'clicked at (1024, 600)',
        ok: true,
      }),
      expect.objectContaining({ kind: 'finished', text: 'Opened Notepad.' }),
    ]);
    expect(isRdpTaskRunning(sessionId)).toBe(false);
  });

  it('shows the API model each screenshot', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['FINISHED: nothing to do']);
    await waitForPhase(progress, 'finished');

    const call = vi.mocked(runAiPrompt).mock.calls[0];
    expect(call?.[0]).toBe('openai');
    expect(call?.[1]).toBe('vision-model');
    expect(call?.[5]).toEqual([Buffer.from('frame-1').toString('base64')]);
    expect(fake.aiPrompts[0]?.startsWith('You are operating')).toBe(true);
  });

  it('keeps the window painting while the task runs', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['FINISHED: done']);
    await waitForPhase(progress, 'finished');
    await vi.waitFor(() =>
      expect(fake.throttling).toEqual([
        { sessionId, enabled: false },
        { sessionId, enabled: true },
      ]),
    );
  });

  it('hands a CLI the screenshot as frame.png in its own run folder', async () => {
    const sessionId = openSession();
    let cwdSeen = '';
    let fileSeen = '';
    vi.mocked(runHeadlessCliPrompt).mockImplementation(async (prompt, cwd, options) => {
      cwdSeen = cwd;
      fileSeen = existsSync(join(cwd, 'frame.png'))
        ? readFileSync(join(cwd, 'frame.png'), 'utf-8')
        : '';
      fake.aiPrompts.push(prompt);
      expect(options).toMatchObject({
        preferredCliId: 'codex-cli',
        strictCli: true,
        images: ['frame.png'],
      });
      return { ok: true, text: 'FINISHED: done', cliName: 'Codex' };
    });
    const progress = startTask(sessionId, [], { cliId: 'codex-cli' });
    await waitForPhase(progress, 'finished');

    expect(fileSeen).toBe('frame-1');
    expect(cwdSeen).toMatch(/runova-rdp-/);
    expect(fake.aiPrompts[0]?.startsWith('Do not use any tools')).toBe(true);
    expect(getRdpTaskHistory(sessionId)[0]?.aiLabel).toBe('Codex CLI');
    // The run folder goes away with the run.
    await vi.waitFor(() => expect(existsSync(cwdSeen)).toBe(false));
  });

  it('lets Claude Code read only the screenshot', async () => {
    const sessionId = openSession();
    vi.mocked(runHeadlessCliPrompt).mockImplementation(async (prompt) => {
      fake.aiPrompts.push(prompt);
      return { ok: true, text: 'FINISHED: done', cliName: 'Claude Code' };
    });
    const progress = startTask(sessionId, [], { cliId: 'claude-code' });
    await waitForPhase(progress, 'finished');
    expect(fake.aiPrompts[0]?.startsWith('Use the Read tool only to look at ./frame.png.')).toBe(
      true,
    );
  });

  it('refuses a CLI that cannot look at screenshots', () => {
    const sessionId = openSession();
    expect(() => startTask(sessionId, [], { cliId: 'aider' })).toThrow(/screenshot/);
    expect(isRdpTaskRunning(sessionId)).toBe(false);
  });

  it('waits on WAIT without sending any input', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['WAIT 200', 'FINISHED: done']);
    await waitForPhase(progress, 'finished');
    expect(fake.inputs).toEqual([]);
    expect(fake.aiPrompts[1]).toContain('> WAIT 200 -> waited 200 ms');
  });

  it('tells the AI when an action could not be turned into input, and carries on', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['KEY ctrl+banana', 'FINISHED: gave up']);
    await waitForPhase(progress, 'finished');
    expect(fake.inputs).toEqual([]);
    expect(fake.aiPrompts[1]).toContain('KEY ctrl+banana');
    expect(fake.aiPrompts[1]).toContain('Unknown key');
    expect(progress.some((p) => p.phase === 'error')).toBe(false);
  });

  it('notes when the screen did not change after an action', async () => {
    const sessionId = openSession();
    fake.samePng = Buffer.from('still').toString('base64');
    const progress = startTask(sessionId, ['CLICK 1 1', 'FINISHED: done']);
    await waitForPhase(progress, 'finished');
    expect(fake.aiPrompts[0]).not.toContain('[The screen did not change');
    expect(fake.aiPrompts[1]).toContain('[The screen did not change after your last action]');
  });

  it('leaves the note out when the screen changed', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['CLICK 1 1', 'FINISHED: done']);
    await waitForPhase(progress, 'finished');
    expect(fake.aiPrompts[1]).not.toContain('[The screen did not change');
  });
});

describe('approval modes', () => {
  it('asks before every action in approve-all, and runs it once approved', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['CLICK 512 300', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');
    const proposed = progress.find((p) => p.phase === 'proposed');
    expect(proposed).toMatchObject({
      action: 'CLICK 512 300',
      target: { x: 1024 / 1920, y: 600 / 1080 },
    });
    expect(proposed?.message).toBeUndefined();
    expect(fake.inputs).toEqual([]);

    approveRdpTaskAction(sessionId);
    await waitForPhase(progress, 'finished');
    expect(fake.inputs).toEqual([{ sessionId, ops: CLICK_OPS }]);
  });

  it('skips an action the user turns down and tells the AI', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['TYPE "hello"', 'FINISHED: done'], {
      mode: 'approve-all',
    });
    await waitForPhase(progress, 'proposed');
    skipRdpTaskAction(sessionId);
    await waitForPhase(progress, 'finished');

    expect(fake.inputs).toEqual([]);
    expect(fake.aiPrompts[1]).toContain('TYPE "hello"');
    expect(fake.aiPrompts[1]).toContain('skipped by user');
    const [run] = getRdpTaskHistory(sessionId);
    expect(run?.entries[0]).toMatchObject({ kind: 'skipped', action: 'TYPE "hello"' });
  });

  it('pauses on a risky shortcut in approve-risky but lets a click through', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['CLICK 512 300', 'KEY alt+f4', 'FINISHED: done'], {
      mode: 'approve-risky',
    });
    await waitForPhase(progress, 'proposed');

    const proposed = progress.filter((p) => p.phase === 'proposed');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.action).toBe('KEY alt+f4');
    expect(proposed[0]?.message).toContain('alt+f4');
    expect(proposed[0]?.target).toBeUndefined();
    expect(fake.inputs).toHaveLength(1);

    approveRdpTaskAction(sessionId);
    await waitForPhase(progress, 'finished');
    expect(fake.inputs).toHaveLength(2);
  });

  it('never asks in autonomous mode', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['KEY alt+f4', 'FINISHED: done']);
    await waitForPhase(progress, 'finished');
    expect(progress.some((p) => p.phase === 'proposed')).toBe(false);
    expect(fake.inputs).toHaveLength(1);
  });
});

describe('pausing on an error', () => {
  it('pauses on a reply it cannot read, and Continue retries with the same step number', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, [
      'Sure! Let me look at the screen.',
      'CLICK 512 300',
      'FINISHED: done',
    ]);
    await waitForPhase(progress, 'error');
    expect(progress.at(-1)?.canContinue).toBe(true);
    expect(isRdpTaskRunning(sessionId)).toBe(true);

    continueRdpTask(sessionId);
    await waitForPhase(progress, 'finished');
    expect(progress.find((p) => p.phase === 'acting')?.step).toBe(1);
    expect(fake.aiPrompts[1]).toMatch(/not in the expected format/i);
    expect(getRdpTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'error',
      'continued',
      'action',
      'finished',
    ]);
  });

  it('pauses when a screenshot does not arrive', async () => {
    const sessionId = openSession();
    vi.mocked(requestRdpFrame).mockRejectedValueOnce(
      new Error('The Remote Desktop window did not answer within 10000 ms.'),
    );
    const progress = startTask(sessionId, ['CLICK 512 300', 'FINISHED: done']);
    await waitForPhase(progress, 'error');
    expect(progress.at(-1)).toMatchObject({ canContinue: true });
    expect(progress.at(-1)?.message).toContain('did not answer');
    expect(runAiPrompt).not.toHaveBeenCalled();

    continueRdpTask(sessionId);
    await waitForPhase(progress, 'finished');
    expect(progress.find((p) => p.phase === 'acting')?.step).toBe(1);
  });

  it('pauses when the AI call fails', async () => {
    const sessionId = openSession();
    vi.mocked(runAiPrompt).mockRejectedValueOnce(new Error('This model does not accept images.'));
    const progress = startTask(sessionId, ['FINISHED: done']);
    await waitForPhase(progress, 'error');
    expect(progress.at(-1)?.message).toContain('does not accept images');
    continueRdpTask(sessionId);
    await waitForPhase(progress, 'finished');
  });

  it('pauses when the input could not be applied, and records the failed action', async () => {
    const sessionId = openSession();
    vi.mocked(requestRdpInput).mockRejectedValueOnce(new Error('The session is not connected.'));
    const progress = startTask(sessionId, ['CLICK 512 300', 'FINISHED: done']);
    await waitForPhase(progress, 'error');
    expect(progress.at(-1)?.message).toContain('not connected');

    continueRdpTask(sessionId);
    await waitForPhase(progress, 'finished');
    const [run] = getRdpTaskHistory(sessionId);
    expect(run?.entries[0]).toMatchObject({ kind: 'action', action: 'CLICK 512 300', ok: false });
  });
});

describe('questions for the user', () => {
  it('passes the answer on to the AI', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, [
      'NEEDS_INPUT: Which file should I open?',
      'FINISHED: done',
    ]);
    await waitForPhase(progress, 'needs-input');
    expect(progress.at(-1)?.message).toBe('Which file should I open?');

    answerRdpTaskInput(sessionId, 'notes.txt');
    await waitForPhase(progress, 'finished');
    expect(fake.aiPrompts[1]).toContain('[You answered]: notes.txt');
    expect(getRdpTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'question',
      'answer',
      'finished',
    ]);
  });
});

describe('stopping', () => {
  it('lets go of every key and button, and records the stop', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['NEEDS_INPUT: Which file?']);
    await waitForPhase(progress, 'needs-input');

    stopRdpTask(sessionId);
    expect(progress.at(-1)).toMatchObject({ phase: 'stopped', message: 'Stopped by user.' });
    expect(fake.inputs).toEqual([{ sessionId, ops: [{ kind: 'releaseAll' }] }]);
    expect(dropRdpAgentRequests).toHaveBeenCalledWith(sessionId);
    expect(isRdpTaskRunning(sessionId)).toBe(false);
    expect(getRdpTaskHistory(sessionId)[0]?.status).toBe('stopped');
    expect(fake.throttling.at(-1)).toEqual({ sessionId, enabled: true });
  });

  it('says the window closed when that is what ended it', async () => {
    const sessionId = openSession();
    vi.mocked(requestRdpInput).mockRejectedValue(new Error('The Remote Desktop window is closed.'));
    const progress = startTask(sessionId, ['NEEDS_INPUT: Which file?']);
    await waitForPhase(progress, 'needs-input');

    stopRdpTask(sessionId, 'exited');
    expect(progress.at(-1)).toMatchObject({
      phase: 'stopped',
      message: 'The Remote Desktop window closed.',
    });
    expect(getRdpTaskHistory(sessionId)[0]?.entries.at(-1)).toMatchObject({
      kind: 'stopped',
      text: 'The Remote Desktop window closed.',
    });
  });

  it('removes the CLI run folder when stopped mid-step', async () => {
    const sessionId = openSession();
    let cwdSeen = '';
    vi.mocked(runHeadlessCliPrompt).mockImplementation(async (_prompt, cwd) => {
      cwdSeen = cwd;
      return new Promise(() => undefined);
    });
    const progress = startTask(sessionId, [], { cliId: 'codex-cli' });
    await vi.waitFor(() => expect(cwdSeen).not.toBe(''));
    stopRdpTask(sessionId);
    expect(progress.at(-1)?.phase).toBe('stopped');
    await vi.waitFor(() => expect(existsSync(cwdSeen)).toBe(false));
  });
});

describe('starting', () => {
  it('refuses a second task in the same session', async () => {
    const sessionId = openSession();
    startTask(sessionId, ['NEEDS_INPUT: wait']);
    expect(() => startTask(sessionId, [])).toThrow(/already running/);
  });

  it('refuses a session whose window is not open', () => {
    expect(() => startTask('rdp-gone', [])).toThrow('This Remote Desktop session is not open.');
  });

  it('refuses an empty task', () => {
    const sessionId = openSession();
    expect(() =>
      startRdpTask({ sessionId, prompt: '   ', mode: 'autonomous' }, () => undefined),
    ).toThrow();
    expect(isRdpTaskRunning(sessionId)).toBe(false);
  });
});

describe('history', () => {
  it('lists runs newest first and keeps the last 20', async () => {
    const sessionId = openSession();
    for (let i = 1; i <= 21; i += 1) {
      fake.aiReplies.push(`FINISHED: run ${i}`);
      const progress: RdpAgentProgress[] = [];
      startRdpTask({ sessionId, prompt: `task ${i}`, mode: 'autonomous' }, (p) => progress.push(p));
      await waitForPhase(progress, 'finished');
      await vi.waitFor(() => expect(isRdpTaskRunning(sessionId)).toBe(false));
    }
    const history = getRdpTaskHistory(sessionId);
    expect(history).toHaveLength(20);
    expect(history[0]?.prompt).toBe('task 21');
    expect(history.at(-1)?.prompt).toBe('task 2');
  });
});

describe('notifying about a run that waits on the user', () => {
  it('raises a notification for a proposed action that brings the window forward', async () => {
    const sessionId = openSession();
    const show = vi.spyOn(fake.window, 'show');
    const focus = vi.spyOn(fake.window, 'focus');
    const progress = startTask(sessionId, ['KEY alt+f4'], { mode: 'approve-all' });
    await waitForPhase(progress, 'proposed');

    await notifyRdpTaskWaiting(sessionId, 'Build box');
    expect(showOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'AI wants to act on the remote desktop',
        body: 'Build box\nKEY alt+f4',
        onClick: expect.any(Function),
      }),
    );
    const input = vi.mocked(showOsNotification).mock.calls[0]?.[0];
    input?.onClick?.();
    expect(show).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
  });

  it('stays quiet when AI notifications are turned off', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['NEEDS_INPUT: Which file?']);
    await waitForPhase(progress, 'needs-input');
    fake.settings = { ...fake.settings, terminalAiNotifications: false };
    await notifyRdpTaskWaiting(sessionId, 'Build box');
    expect(showOsNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while the AI is working', async () => {
    const sessionId = openSession();
    const progress = startTask(sessionId, ['FINISHED: done']);
    await waitForPhase(progress, 'finished');
    await notifyRdpTaskWaiting(sessionId, 'Build box');
    expect(showOsNotification).not.toHaveBeenCalled();
  });
});
