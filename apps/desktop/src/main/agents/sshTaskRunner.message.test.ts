import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAgentMode, SshAgentProgress } from '../../shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '../../shared/sshAgentMessage';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import {
  continueSshTask,
  getSshTaskHistory,
  type PromptInput,
  sendSshTaskMessage,
  startAgentTask,
  startSshTask,
  stopSshTask,
} from './sshTaskRunner';

/**
 * Talking to a task that is already running. The shell on the far end is scripted, and the AI and
 * a command can each be held open, so a message can land at exactly the moment under test.
 */

const fake = vi.hoisted(() => {
  const state = {
    script: {} as Record<string, { output: string; code: number }>,
    /** A command listed here prints nothing until its promise settles. */
    holds: new Map<string, Promise<void>>(),
    ran: [] as string[],
    outputListeners: new Map<string, Set<(data: string) => void>>(),
    exitListeners: new Map<string, Set<() => void>>(),
    aiReplies: [] as string[],
    /** Each AI call takes the next gate and waits for it, so a reply can be held back. */
    aiGates: [] as Promise<void>[],
    aiPrompts: [] as string[],
    cliReplies: [] as string[],
    /** The next CLI call never answers by itself, only when it is cancelled. */
    cliHangs: false,
    cancelers: new Map<string, () => void>(),
  };

  function emit(sessionId: string, text: string): void {
    for (const listener of state.outputListeners.get(sessionId) ?? []) listener(text);
  }

  /** Answers a line typed with the hidden markers, the way bash would. */
  function type(sessionId: string, line: string): void {
    const hidden = line.match(
      /^printf '\\033\]7750;Runova:Start:(\w+)\\007'; (.*); printf '\\033\]7750;Runova:Done:\1:%s\\007' "\$\?"[\r\n]$/,
    );
    const body = hidden?.[2];
    if (!hidden || body === undefined) return;
    state.ran.push(body);
    const answer = state.script[body] ?? {
      output: `bash: ${body}: command not found\r\n`,
      code: 127,
    };
    const respond = (): void => {
      emit(sessionId, `${line.trimEnd()}\r\n`);
      emit(sessionId, `\x1b]7750;Runova:Start:${hidden[1]}\x07`);
      emit(sessionId, answer.output);
      emit(sessionId, `\x1b]7750;Runova:Done:${hidden[1]}:${answer.code}\x07`);
    };
    const hold = state.holds.get(body);
    if (hold) void hold.then(respond);
    else queueMicrotask(respond);
  }

  function subscribe<T>(map: Map<string, Set<T>>, id: string, listener: T): () => void {
    const set = map.get(id) ?? new Set<T>();
    set.add(listener);
    map.set(id, set);
    return () => set.delete(listener);
  }

  return { state, type, subscribe };
});

vi.mock('../ipc/ssh', () => ({
  hasSshSession: () => true,
  sshSessionServerId: () => null,
  writeToSshSession: (id: string, data: string) => fake.type(id, data),
  subscribeSshOutput: (id: string, listener: (data: string) => void) =>
    fake.subscribe(fake.state.outputListeners, id, listener),
  subscribeSshExit: (id: string, listener: () => void) =>
    fake.subscribe(fake.state.exitListeners, id, listener),
  getSshSessionPassword: async () => null,
  setSshDisplayCaptured: () => undefined,
  writeToSshDisplay: () => undefined,
}));
vi.mock('../ipc/terminal', () => ({
  hasAttachedTerminalSession: () => true,
  terminalSessionShell: () => 'bash',
  writeToSession: () => undefined,
  subscribeTerminalOutput: () => () => undefined,
  subscribeTerminalExit: () => () => undefined,
  setTerminalDisplayCaptured: () => undefined,
  writeToTerminalDisplay: () => undefined,
}));
vi.mock('../ipc/ai', () => ({
  runAiPrompt: vi.fn(async (_provider: string, _model: string, prompt: string) => {
    fake.state.aiPrompts.push(prompt);
    const gate = fake.state.aiGates.shift();
    if (gate) await gate;
    return fake.state.aiReplies.shift() ?? 'FINISHED: out of script';
  }),
}));
vi.mock('../cli/headlessPrompt', () => ({
  cancelHeadlessPrompt: vi.fn((requestId: string) => {
    fake.state.cancelers.get(requestId)?.();
    return true;
  }),
  runHeadlessCliPrompt: vi.fn(
    async (prompt: string, _cwd: string, options: { requestId: string }) => {
      fake.state.aiPrompts.push(prompt);
      if (fake.state.cliHangs) {
        fake.state.cliHangs = false;
        return new Promise((resolve) => {
          fake.state.cancelers.set(options.requestId, () =>
            resolve({ ok: false, error: 'Cancelled.' }),
          );
        });
      }
      return { ok: true, text: fake.state.cliReplies.shift() ?? 'FINISHED: out of script' };
    },
  ),
}));
vi.mock('../store', () => ({
  store: {
    getSettings: vi.fn(async () => ({
      promptBuilderProvider: 'gemini',
      openaiModel: 'openai-model',
      geminiModel: 'gemini-model',
      ollamaModel: 'ollama-model',
    })),
  },
}));
vi.mock('../notifications/petNotifier', () => ({ speakOnPet: vi.fn() }));
vi.mock('../notifications/osNotification', () => ({ showOsNotification: vi.fn(() => true) }));
vi.mock('../mainWindow', () => ({ getMainWindow: () => null }));
vi.mock('@runova/core', () => ({
  getCliDefinition: (id: string) => (id === 'claude' ? { name: 'Claude Code' } : undefined),
  runArgsFor: () => [],
}));

/** A promise settled from outside, to hold the AI or a command until the test says so. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const FOLLOW_UP_HEADER =
  'The user added these while you were working, oldest first. They take priority over anything earlier, so change course if one asks for it:';

let counter = 0;
const started: string[] = [];

beforeEach(() => {
  fake.state.script = {
    uptime: { output: ' 10:00:00 up 3 days\r\n', code: 0 },
    slow: { output: 'done\r\n', code: 0 },
    big: { output: `${'x'.repeat(7000)}\r\n`, code: 0 },
  };
  fake.state.holds.clear();
  fake.state.ran.length = 0;
  fake.state.aiReplies.length = 0;
  fake.state.aiGates.length = 0;
  fake.state.aiPrompts.length = 0;
  fake.state.cliReplies.length = 0;
  fake.state.cliHangs = false;
  fake.state.cancelers.clear();
  vi.mocked(runAiPrompt).mockClear();
  vi.mocked(runHeadlessCliPrompt).mockClear();
  vi.mocked(cancelHeadlessPrompt).mockClear();
});

afterEach(() => {
  for (const id of started.splice(0)) stopSshTask(id);
});

function start(options: { mode?: SshAgentMode; cliId?: string; replies?: string[] } = {}): {
  sessionId: string;
  progress: SshAgentProgress[];
} {
  counter += 1;
  const sessionId = `msg-${counter}`;
  started.push(sessionId);
  if (options.cliId) fake.state.cliReplies.push(...(options.replies ?? []));
  else fake.state.aiReplies.push(...(options.replies ?? []));
  const progress: SshAgentProgress[] = [];
  startSshTask(
    {
      sessionId,
      prompt: 'check the server',
      mode: options.mode ?? 'autonomous',
      target: 'ssh',
      ...(options.cliId ? { cliId: options.cliId } : {}),
    },
    (p) => progress.push(p),
  );
  return { sessionId, progress };
}

async function until(progress: SshAgentProgress[], phase: SshAgentProgress['phase']) {
  await vi.waitFor(() => expect(progress.map((p) => p.phase)).toContain(phase), {
    timeout: 5000,
  });
}

/** The AI has been handed its `count`th prompt and is working on it. */
async function untilAsked(count: number) {
  await vi.waitFor(() => expect(fake.state.aiPrompts).toHaveLength(count), { timeout: 5000 });
}

describe('a message while the AI is working out its next step', () => {
  it('drops the reply it was working on and asks again with the message', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const { sessionId, progress } = start({
      replies: ['FINISHED: premature', 'FINISHED: all good'],
    });
    await untilAsked(1);

    expect(sendSshTaskMessage(sessionId, 'do not touch the config')).toBe(true);
    // Until the AI is asked with it, the bar has something to show for it.
    expect(progress.at(-1)).toMatchObject({ phase: 'thinking', queuedMessages: 1 });
    gate.release();
    await until(progress, 'finished');

    expect(fake.state.aiPrompts).toHaveLength(2);
    expect(fake.state.aiPrompts[0]).not.toContain(FOLLOW_UP_HEADER);
    expect(fake.state.aiPrompts[1]).toContain(`${FOLLOW_UP_HEADER}\n- do not touch the config`);
    expect(progress.at(-1)).toMatchObject({ phase: 'finished', message: 'all good' });
    expect(progress.filter((p) => p.phase === 'thinking').at(-1)).not.toHaveProperty(
      'queuedMessages',
    );
    // The dropped reply took nobody's step number.
    expect(progress.every((p) => p.step === 1)).toBe(true);
    expect(getSshTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'message',
      'finished',
    ]);
  });

  it('cancels a CLI that is still thinking, without pausing the run', async () => {
    fake.state.cliHangs = true;
    const { sessionId, progress } = start({ cliId: 'claude', replies: ['FINISHED: all good'] });
    await untilAsked(1);

    expect(sendSshTaskMessage(sessionId, 'only look at /var/log')).toBe(true);
    await until(progress, 'finished');

    expect(cancelHeadlessPrompt).toHaveBeenCalledWith(`ssh-agent:${sessionId}:1`);
    // Killing the CLI is how the message gets through. It is not an error for the user to resolve.
    expect(progress.map((p) => p.phase)).not.toContain('error');
    expect(fake.state.aiPrompts[1]).toContain('- only look at /var/log');
    expect(getSshTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'message',
      'finished',
    ]);
  });
});

describe('a message while a command is running', () => {
  it('lets the command finish, then asks the AI with the message', async () => {
    const hold = deferred();
    fake.state.holds.set('slow', hold.promise);
    const { sessionId, progress } = start({ replies: ['RUN: slow', 'FINISHED: ok'] });
    await until(progress, 'running');

    expect(sendSshTaskMessage(sessionId, 'also check the disk')).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      phase: 'running',
      command: 'slow',
      queuedMessages: 1,
    });
    // Nothing is cancelled, and the AI is not asked again, until the command ends.
    expect(cancelHeadlessPrompt).not.toHaveBeenCalled();
    expect(fake.state.aiPrompts).toHaveLength(1);

    hold.release();
    await until(progress, 'finished');

    expect(fake.state.ran).toEqual(['slow']);
    expect(fake.state.aiPrompts[1]).toContain('- also check the disk');
    expect(progress.filter((p) => p.phase === 'thinking').at(-1)).not.toHaveProperty(
      'queuedMessages',
    );
    expect(getSshTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'message',
      'command',
      'finished',
    ]);
  });

  it('keeps the message in every later prompt, even once the transcript has been cut', async () => {
    const hold = deferred();
    fake.state.holds.set('slow', hold.promise);
    const { sessionId, progress } = start({
      replies: ['RUN: slow', 'RUN: big', 'RUN: uptime', 'FINISHED: ok'],
    });
    await until(progress, 'running');
    sendSshTaskMessage(sessionId, 'keep it read-only');
    hold.release();
    await until(progress, 'finished');

    // The 7000 characters `big` printed push the transcript past what a prompt carries.
    expect(fake.state.aiPrompts[3]).toContain('…(earlier output truncated)…');
    for (const prompt of fake.state.aiPrompts.slice(1)) {
      expect(prompt).toContain('- keep it read-only');
    }
  });
});

describe('a message while a command waits for approval', () => {
  it('skips that command and asks the AI what to do given the message', async () => {
    const { sessionId, progress } = start({
      mode: 'approve-all',
      replies: ['RUN: uptime', 'FINISHED: ok'],
    });
    await until(progress, 'proposed');

    expect(sendSshTaskMessage(sessionId, 'use df instead')).toBe(true);
    await until(progress, 'finished');

    expect(fake.state.ran).toEqual([]);
    expect(fake.state.aiPrompts[1]).toContain('[skipped by user, not run]');
    expect(fake.state.aiPrompts[1]).toContain('- use df instead');
    expect(getSshTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual([
      'message',
      'skipped',
      'finished',
    ]);
  });
});

describe('a message while the run is paused', () => {
  it('waits for Continue, which then asks the AI with it', async () => {
    vi.mocked(runAiPrompt).mockRejectedValueOnce(new Error('boom'));
    const { sessionId, progress } = start({ replies: ['FINISHED: ok'] });
    await until(progress, 'error');

    expect(sendSshTaskMessage(sessionId, 'try again, but slowly')).toBe(true);
    // It does not resume the run on its own: Continue is still the user's call.
    expect(progress.at(-1)).toMatchObject({
      phase: 'error',
      canContinue: true,
      queuedMessages: 1,
    });
    expect(fake.state.aiPrompts).toHaveLength(0);

    continueSshTask(sessionId);
    await until(progress, 'finished');
    expect(fake.state.aiPrompts[0]).toContain('- try again, but slowly');
  });
});

describe('several messages', () => {
  it('lists them oldest first, with multi-line ones kept together', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const { sessionId, progress } = start({ replies: ['RUN: uptime', 'FINISHED: ok'] });
    await untilAsked(1);

    sendSshTaskMessage(sessionId, 'first');
    sendSshTaskMessage(sessionId, 'second line one\nsecond line two');
    expect(progress.at(-1)).toMatchObject({ queuedMessages: 2 });
    gate.release();
    await until(progress, 'finished');

    expect(fake.state.aiPrompts[1]).toContain(
      `${FOLLOW_UP_HEADER}\n- first\n- second line one\n  second line two`,
    );
  });
});

describe('what is not accepted', () => {
  it('refuses a message for a task that does not exist or has ended', async () => {
    expect(sendSshTaskMessage('no-such-task', 'hello')).toBe(false);

    const { sessionId, progress } = start({ replies: ['FINISHED: done'] });
    await until(progress, 'finished');
    expect(sendSshTaskMessage(sessionId, 'too late')).toBe(false);
    expect(getSshTaskHistory(sessionId)[0]?.entries.map((e) => e.kind)).toEqual(['finished']);
  });

  it('refuses a stopped task', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const { sessionId } = start({ replies: ['FINISHED: done'] });
    await untilAsked(1);
    stopSshTask(sessionId);
    expect(sendSshTaskMessage(sessionId, 'wait')).toBe(false);
    gate.release();
  });

  it('ignores blank text and anything that is not text', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const { sessionId, progress } = start({ replies: ['FINISHED: done'] });
    await untilAsked(1);

    expect(sendSshTaskMessage(sessionId, '   \n ')).toBe(false);
    expect(sendSshTaskMessage(sessionId, 42 as unknown as string)).toBe(false);
    gate.release();
    await until(progress, 'finished');

    // Nothing was queued, so the first answer stood and the AI was asked only once.
    expect(fake.state.aiPrompts).toHaveLength(1);
    expect(progress.every((p) => !('queuedMessages' in p))).toBe(true);
  });

  it('trims the text and cuts it at the length limit', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const { sessionId, progress } = start({ replies: ['FINISHED: ok', 'FINISHED: ok'] });
    await untilAsked(1);

    sendSshTaskMessage(sessionId, `  ${'y'.repeat(MAX_SSH_AGENT_MESSAGE_CHARS + 50)}  `);
    gate.release();
    await until(progress, 'finished');

    const entry = getSshTaskHistory(sessionId)[0]?.entries[0];
    expect(entry).toMatchObject({ kind: 'message' });
    expect(entry && 'text' in entry ? entry.text : '').toBe(
      'y'.repeat(MAX_SSH_AGENT_MESSAGE_CHARS),
    );
  });
});

describe('a task with its own prompt', () => {
  it('hands the messages to it as part of the task', async () => {
    const gate = deferred();
    fake.state.aiGates.push(gate.promise);
    const tasks: string[] = [];
    const progress: SshAgentProgress[] = [];
    startAgentTask(
      {
        key: 'core-message',
        prompt: 'fix the deploy',
        target: {
          kind: 'core',
          description: 'a server core',
          label: 'Deploy AI',
          isConnected: () => true,
          subscribeExit: () => () => undefined,
        },
        policy: () => ({ pause: false }),
        executor: async () => ({ output: 'ok', exitCode: 0, timedOut: false }),
        buildPrompt: ({ task }: PromptInput) => {
          tasks.push(task);
          return `custom prompt for: ${task}`;
        },
        cliId: null,
        runArgs: [],
      },
      (p) => progress.push(p),
    );
    started.push('core-message');
    await untilAsked(1);

    sendSshTaskMessage('core-message', 'use the staging database');
    gate.release();
    await until(progress, 'finished');

    expect(tasks).toEqual([
      'fix the deploy',
      `fix the deploy\n\n${FOLLOW_UP_HEADER}\n- use the staging database`,
    ]);
  });
});
