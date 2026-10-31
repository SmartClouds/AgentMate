import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAgentMode, SshAgentProgress } from '../../shared/apiTypes';
import { runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { runAiPrompt } from '../ipc/ai';
import {
  answerSshTaskInput,
  approveSshTaskCommand,
  getSshTaskHistory,
  isSshTaskRunning,
  skipSshTaskCommand,
  startSshTask,
  stopSshTask,
} from './sshTaskRunner';

/**
 * Characterization suite (E09 T3): pins what the SSH and local-terminal AI does today, byte for
 * byte where it matters (the prompt, the transcript, the history), so the refactor that gives
 * the loop a pluggable command executor can be shown to change nothing. The shell on the far end
 * is a scripted one that answers Runova's markers; the AI is scripted too.
 */

const fake = vi.hoisted(() => {
  type Script = Record<string, { output: string; code: number }>;
  const state = {
    connected: true,
    script: {} as Script,
    written: [] as string[],
    ran: [] as string[],
    outputListeners: new Map<string, Set<(data: string) => void>>(),
    exitListeners: new Map<string, Set<() => void>>(),
    aiReplies: [] as string[],
    aiPrompts: [] as string[],
    cliReplies: [] as string[],
  };

  function emit(sessionId: string, text: string): void {
    for (const listener of state.outputListeners.get(sessionId) ?? []) listener(text);
  }

  /** Answers a line typed with either kind of marker, the way bash would. */
  function type(sessionId: string, line: string): void {
    state.written.push(line);
    const hidden = line.match(
      /^printf '\\033\]7750;Runova:Start:(\w+)\\007'; (.*); printf '\\033\]7750;Runova:Done:\1:%s\\007' "\$\?"[\r\n]$/,
    );
    const plain = line.match(/^(.*); printf '\\n(__RUNOVA_DONE_\w+__):%s\\n' "\$\?"[\r\n]$/);
    const body = hidden?.[2] ?? plain?.[1];
    if (body === undefined) return;
    state.ran.push(body);
    const answer = state.script[body] ?? {
      output: `bash: ${body}: command not found\r\n`,
      code: 127,
    };
    queueMicrotask(() => {
      emit(sessionId, `${line.trimEnd()}\r\n`);
      if (hidden) emit(sessionId, `\x1b]7750;Runova:Start:${hidden[1]}\x07`);
      emit(sessionId, answer.output);
      if (hidden) emit(sessionId, `\x1b]7750;Runova:Done:${hidden[1]}:${answer.code}\x07`);
      if (plain) emit(sessionId, `\n${plain[2]}:${answer.code}\n`);
    });
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
  hasSshSession: () => fake.state.connected,
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
  hasAttachedTerminalSession: () => fake.state.connected,
  terminalSessionShell: () => 'bash',
  writeToSession: (id: string, data: string) => fake.type(id, data),
  subscribeTerminalOutput: (id: string, listener: (data: string) => void) =>
    fake.subscribe(fake.state.outputListeners, id, listener),
  subscribeTerminalExit: (id: string, listener: () => void) =>
    fake.subscribe(fake.state.exitListeners, id, listener),
  setTerminalDisplayCaptured: () => undefined,
  writeToTerminalDisplay: () => undefined,
}));
vi.mock('../ipc/ai', () => ({
  runAiPrompt: vi.fn(async (_provider: string, _model: string, prompt: string) => {
    fake.state.aiPrompts.push(prompt);
    return fake.state.aiReplies.shift() ?? 'FINISHED: out of script';
  }),
}));
vi.mock('../cli/headlessPrompt', () => ({
  cancelHeadlessPrompt: vi.fn(),
  runHeadlessCliPrompt: vi.fn(async (prompt: string) => {
    fake.state.aiPrompts.push(prompt);
    return { ok: true, text: fake.state.cliReplies.shift() ?? 'FINISHED: out of script' };
  }),
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
  runArgsFor: (cliId: string | null, modelId: string | null) =>
    cliId && modelId === 'opus' ? ['--model', 'opus'] : [],
}));

let counter = 0;

/** The runner starts listening for an answer a moment after it reports the question. */
function later(answer: () => void): void {
  setTimeout(answer, 20);
}

beforeEach(() => {
  fake.state.connected = true;
  fake.state.written.length = 0;
  fake.state.ran.length = 0;
  fake.state.aiReplies.length = 0;
  fake.state.aiPrompts.length = 0;
  fake.state.cliReplies.length = 0;
  fake.state.script = {
    uptime: { output: ' 10:00:00 up 3 days\r\n', code: 0 },
    'rm -rf /tmp/cache': { output: '', code: 0 },
    'ls /nope': { output: "ls: cannot access '/nope'\r\n", code: 2 },
  };
  vi.mocked(runAiPrompt).mockClear();
  vi.mocked(runHeadlessCliPrompt).mockClear();
});

afterEach(() => {
  for (const id of [...fake.state.outputListeners.keys()]) stopSshTask(id);
});

interface Started {
  sessionId: string;
  progress: SshAgentProgress[];
}

function start(
  options: {
    mode?: SshAgentMode;
    target?: 'ssh' | 'local';
    cliId?: string;
    modelId?: string;
    replies?: string[];
    prompt?: string;
  } = {},
  onProgress: (progress: SshAgentProgress, sessionId: string) => void = () => undefined,
): Started {
  counter += 1;
  const sessionId = `char-${counter}`;
  const replies = options.replies ?? [];
  if (options.cliId) fake.state.cliReplies.push(...replies);
  else fake.state.aiReplies.push(...replies);
  const progress: SshAgentProgress[] = [];
  startSshTask(
    {
      sessionId,
      prompt: options.prompt ?? '  check the server  ',
      mode: options.mode ?? 'autonomous',
      target: options.target ?? 'ssh',
      ...(options.cliId ? { cliId: options.cliId } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
    },
    (p) => {
      progress.push(p);
      onProgress(p, sessionId);
    },
  );
  return { sessionId, progress };
}

async function until(progress: SshAgentProgress[], phase: SshAgentProgress['phase']) {
  await vi.waitFor(() => expect(progress.map((p) => p.phase)).toContain(phase), {
    timeout: 5000,
  });
}

function phases(progress: SshAgentProgress[]): string[] {
  return progress.map((p) => `${p.step}:${p.phase}${p.command ? ` ${p.command}` : ''}`);
}

describe('the prompt, byte for byte', () => {
  it('over SSH with a provider from Settings', async () => {
    const { progress } = start({ replies: ['RUN: uptime', 'RUN: ls /nope', 'FINISHED: ok'] });
    await until(progress, 'finished');
    expect(fake.state.aiPrompts).toMatchSnapshot();
  });

  it('over SSH with an agent CLI', async () => {
    const { progress } = start({ cliId: 'claude', replies: ['RUN: uptime', 'FINISHED: ok'] });
    await until(progress, 'finished');
    expect(fake.state.aiPrompts).toMatchSnapshot();
  });

  it('in a local terminal with a provider and with a CLI', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const api = start({ target: 'local', replies: ['RUN: uptime', 'FINISHED: ok'] });
      await until(api.progress, 'finished');
      const cli = start({ target: 'local', cliId: 'claude', replies: ['FINISHED: ok'] });
      await until(cli.progress, 'finished');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
    expect(fake.state.aiPrompts).toMatchSnapshot();
  });

  it('cuts the transcript to its last 6000 characters', async () => {
    fake.state.script.big = { output: `${'x'.repeat(7000)}\r\n`, code: 0 };
    const { progress } = start({ replies: ['RUN: big', 'FINISHED: ok'] });
    await until(progress, 'finished');
    const last = fake.state.aiPrompts[1] ?? '';
    expect(last).toContain('Transcript so far (most recent last):\n…(earlier output truncated)…');
    expect(last.split('Transcript so far (most recent last):\n')[1]?.length).toBe(
      6000 + '…(earlier output truncated)…'.length,
    );
  });
});

describe('choosing the AI', () => {
  it('uses the provider and model from Settings and labels the run with the provider', async () => {
    const { sessionId, progress } = start({ replies: ['FINISHED: done'] });
    await until(progress, 'finished');
    expect(runAiPrompt).toHaveBeenCalledWith(
      'gemini',
      'gemini-model',
      expect.any(String),
      [],
      expect.any(AbortSignal),
      // No images were attached.
      [],
    );
    expect(runHeadlessCliPrompt).not.toHaveBeenCalled();
    expect(getSshTaskHistory(sessionId)[0]?.aiLabel).toBe('Gemini');
  });

  it('runs the chosen CLI headless in the temp folder with its model flags', async () => {
    const { sessionId, progress } = start({
      cliId: 'claude',
      modelId: 'opus',
      replies: ['FINISHED: done'],
    });
    await until(progress, 'finished');
    expect(runAiPrompt).not.toHaveBeenCalled();
    expect(runHeadlessCliPrompt).toHaveBeenCalledWith(expect.any(String), tmpdir(), {
      requestId: `ssh-agent:${sessionId}:1`,
      preferredCliId: 'claude',
      strictCli: true,
      runArgs: ['--model', 'opus'],
      timeoutMs: 5 * 60 * 1000,
    });
    expect(getSshTaskHistory(sessionId)[0]?.aiLabel).toBe('Claude Code');
  });

  it('labels an unknown CLI generically and passes no flags without a model', async () => {
    const { sessionId, progress } = start({ cliId: 'mystery', replies: ['FINISHED: done'] });
    await until(progress, 'finished');
    expect(vi.mocked(runHeadlessCliPrompt).mock.calls[0]?.[2]).toMatchObject({ runArgs: [] });
    expect(getSshTaskHistory(sessionId)[0]?.aiLabel).toBe('AI CLI');
  });

  it('pauses with the CLI error when the CLI fails', async () => {
    vi.mocked(runHeadlessCliPrompt).mockResolvedValueOnce({
      ok: false,
      error: '',
      cliName: 'Claude Code',
    } as never);
    const { progress } = start({ cliId: 'claude' });
    await until(progress, 'error');
    expect(progress.at(-1)).toMatchObject({
      phase: 'error',
      step: 0,
      message: 'Paused: Claude Code failed.',
      canContinue: true,
    });
  });
});

describe('approval modes', () => {
  it('approve-all proposes every command and runs it once approved', async () => {
    const { progress } = start(
      { mode: 'approve-all', replies: ['RUN: uptime', 'FINISHED: ok'] },
      (p, id) => {
        if (p.phase === 'proposed') later(() => approveSshTaskCommand(id));
      },
    );
    await until(progress, 'finished');
    expect(phases(progress)).toEqual([
      '1:thinking',
      '1:proposed uptime',
      '1:running uptime',
      '2:thinking',
      '2:finished',
    ]);
    expect(progress[1]?.message).toBeUndefined();
    expect(fake.state.ran).toEqual(['uptime']);
  });

  it('approve-risky runs plain commands and proposes destructive ones with a warning', async () => {
    const { progress } = start(
      { mode: 'approve-risky', replies: ['RUN: uptime', 'RUN: rm -rf /tmp/cache', 'FINISHED: ok'] },
      (p, id) => {
        if (p.phase === 'proposed') later(() => approveSshTaskCommand(id));
      },
    );
    await until(progress, 'finished');
    expect(phases(progress)).toEqual([
      '1:thinking',
      '1:running uptime',
      '2:thinking',
      '2:proposed rm -rf /tmp/cache',
      '2:running rm -rf /tmp/cache',
      '3:thinking',
      '3:finished',
    ]);
    expect(progress[3]?.message).toBe('This command looks destructive.');
  });

  it('autonomous runs even a destructive command without asking', async () => {
    const { progress } = start({ replies: ['RUN: rm -rf /tmp/cache', 'FINISHED: ok'] });
    await until(progress, 'finished');
    expect(progress.some((p) => p.phase === 'proposed')).toBe(false);
    expect(fake.state.ran).toEqual(['rm -rf /tmp/cache']);
  });

  it('a skipped command never runs and the AI is told so', async () => {
    const { sessionId, progress } = start(
      { mode: 'approve-all', replies: ['RUN: uptime', 'FINISHED: fine'] },
      (p, id) => {
        if (p.phase === 'proposed') later(() => skipSshTaskCommand(id));
      },
    );
    await until(progress, 'finished');
    expect(fake.state.ran).toEqual([]);
    expect(fake.state.aiPrompts[1]).toContain('\n$ uptime\n[skipped by user, not run]\n');
    const [run] = getSshTaskHistory(sessionId);
    expect(run?.entries.map(({ at: _at, ...entry }) => entry)).toEqual([
      { kind: 'skipped', command: 'uptime' },
      { kind: 'finished', text: 'fine' },
    ]);
  });

  it('strips sudo -n before deciding and running', async () => {
    fake.state.script['sudo apt-get update'] = { output: 'ok\r\n', code: 0 };
    const { progress } = start(
      { mode: 'approve-all', replies: ['RUN: sudo -n apt-get update', 'FINISHED: ok'] },
      (p, id) => {
        if (p.phase === 'proposed') later(() => approveSshTaskCommand(id));
      },
    );
    await until(progress, 'finished');
    expect(progress.find((p) => p.phase === 'proposed')?.command).toBe('sudo apt-get update');
    expect(fake.state.ran).toEqual(['sudo apt-get update']);
  });
});

describe('the RUN / FINISHED / NEEDS_INPUT protocol', () => {
  it('records each command with its output and exit code in the transcript and history', async () => {
    const { sessionId, progress } = start({
      replies: ['RUN: `uptime`', 'RUN: ls /nope', 'FINISHED: Checked.'],
    });
    await until(progress, 'finished');
    expect(fake.state.aiPrompts[2]).toContain(
      "Transcript so far (most recent last):\n\n$ uptime [exit code 0]\n 10:00:00 up 3 days\n\n\n$ ls /nope [exit code 2]\nls: cannot access '/nope'\n\n",
    );
    const [run] = getSshTaskHistory(sessionId);
    expect(run).toMatchObject({
      prompt: 'check the server',
      status: 'finished',
      endedAt: expect.any(Number),
    });
    expect(run?.entries.map(({ at: _at, ...entry }) => entry)).toEqual([
      {
        kind: 'command',
        command: 'uptime',
        output: '10:00:00 up 3 days',
        exitCode: 0,
        timedOut: false,
      },
      {
        kind: 'command',
        command: 'ls /nope',
        output: "ls: cannot access '/nope'",
        exitCode: 2,
        timedOut: false,
      },
      { kind: 'finished', text: 'Checked.' },
    ]);
    expect(progress.at(-1)).toEqual({
      sessionId,
      phase: 'finished',
      step: 3,
      message: 'Checked.',
    });
  });

  it('a bare FINISHED reports "Task complete."', async () => {
    const { progress } = start({ replies: ['FINISHED'] });
    await until(progress, 'finished');
    expect(progress.at(-1)?.message).toBe('Task complete.');
  });

  it('asks the user on NEEDS_INPUT and hands the answer to the AI', async () => {
    const { sessionId, progress } = start(
      { replies: ['NEEDS_INPUT: Which folder?', 'FINISHED: ok'] },
      (p, id) => {
        if (p.phase === 'needs-input') later(() => answerSshTaskInput(id, '/var/log'));
      },
    );
    await until(progress, 'finished');
    expect(progress[1]).toEqual({
      sessionId,
      phase: 'needs-input',
      step: 1,
      message: 'Which folder?',
    });
    expect(fake.state.aiPrompts[1]).toContain('\n[You answered]: /var/log\n');
    expect(getSshTaskHistory(sessionId)[0]?.entries.map(({ at: _at, ...entry }) => entry)).toEqual([
      { kind: 'question', text: 'Which folder?' },
      { kind: 'answer', text: '/var/log' },
      { kind: 'finished', text: 'ok' },
    ]);
  });

  it('pauses after 40 steps without finishing', async () => {
    const { progress } = start({ replies: Array.from({ length: 41 }, () => 'RUN: uptime') });
    await until(progress, 'error');
    expect(progress.at(-1)).toMatchObject({
      phase: 'error',
      step: 40,
      message: 'Paused after 40 steps without finishing.',
      canContinue: true,
    });
    expect(fake.state.ran).toHaveLength(40);
  });

  it('pauses on an unreadable reply without using up a step', async () => {
    const { progress } = start({ replies: ['I think we should look around.'] });
    await until(progress, 'error');
    expect(progress.at(-1)).toMatchObject({
      phase: 'error',
      step: 0,
      message: 'Paused: The AI reply did not follow the expected format.',
      canContinue: true,
    });
  });
});

describe('starting and stopping', () => {
  it('refuses a second task, an empty task and a closed session', () => {
    const { sessionId } = start({ replies: ['NEEDS_INPUT: wait'] });
    expect(() =>
      startSshTask({ sessionId, prompt: 'x', mode: 'autonomous' }, () => undefined),
    ).toThrow('An AI task is already running in this session.');
    expect(() =>
      startSshTask({ sessionId: 'blank', prompt: '   ', mode: 'autonomous' }, () => undefined),
    ).toThrow('Describe what you want the AI to do first.');
    fake.state.connected = false;
    expect(() =>
      startSshTask({ sessionId: 'gone', prompt: 'x', mode: 'autonomous' }, () => undefined),
    ).toThrow('This SSH session is not connected.');
    expect(() =>
      startSshTask(
        { sessionId: 'gone', prompt: 'x', mode: 'autonomous', target: 'local' },
        () => undefined,
      ),
    ).toThrow('This terminal is not running anymore.');
  });

  it('a stop while a command waits for approval ends the run as stopped', async () => {
    const { sessionId, progress } = start({ mode: 'approve-all', replies: ['RUN: uptime'] });
    await until(progress, 'proposed');
    stopSshTask(sessionId);
    expect(progress.at(-1)).toEqual({
      sessionId,
      phase: 'stopped',
      step: 1,
      message: 'Stopped by user.',
    });
    expect(isSshTaskRunning(sessionId)).toBe(false);
    expect(fake.state.ran).toEqual([]);
    expect(getSshTaskHistory(sessionId)[0]?.status).toBe('stopped');
  });

  it('says the session ended when the SSH channel closes, and the terminal closed locally', async () => {
    const ssh = start({ replies: ['NEEDS_INPUT: wait'] });
    await until(ssh.progress, 'needs-input');
    for (const listener of fake.state.exitListeners.get(ssh.sessionId) ?? []) listener();
    expect(ssh.progress.at(-1)?.message).toBe('The SSH session ended.');

    const local = start({ target: 'local', replies: ['NEEDS_INPUT: wait'] });
    await until(local.progress, 'needs-input');
    for (const listener of fake.state.exitListeners.get(local.sessionId) ?? []) listener();
    expect(local.progress.at(-1)?.message).toBe('The terminal closed.');
  });
});
