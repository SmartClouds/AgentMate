import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAgentHistoryRun, SshAgentProgress } from '../../shared/apiTypes';
import {
  clearSshServerTaskHistory,
  ensureSshHistoryRestored,
  getSshServerTaskHistory,
  getSshTaskHistory,
  startSshTask,
  stopSshTask,
} from './sshTaskRunner';

/**
 * Picking an earlier task back up: running it again needs how it was started, and continuing it
 * needs the AI to be told what happened then. The history also outlives the app, on disk.
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
    /** What the history file holds when the runner first reads it. */
    savedHistory: [] as unknown[],
    /** Every write of the history file, oldest first. */
    writes: [] as unknown[][],
  };

  function emit(sessionId: string, text: string): void {
    for (const listener of state.outputListeners.get(sessionId) ?? []) listener(text);
  }

  /** Answers a line typed with the hidden markers, the way bash would. */
  function type(sessionId: string, line: string): void {
    const hidden = line.match(
      /^printf '\\033\]7750;AgentMate:Start:(\w+)\\007'; (.*); printf '\\033\]7750;AgentMate:Done:\1:%s\\007' "\$\?"[\r\n]$/,
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
      emit(sessionId, `\x1b]7750;AgentMate:Start:${hidden[1]}\x07`);
      emit(sessionId, answer.output);
      emit(sessionId, `\x1b]7750;AgentMate:Done:${hidden[1]}:${answer.code}\x07`);
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
  // Tabs named srv-* are on the saved server srv-1; the rest are not on a saved server.
  sshSessionServerId: (id: string) => (id.startsWith('srv') ? 'srv-1' : null),
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
    getSshAgentHistory: vi.fn(async () => fake.state.savedHistory),
    setSshAgentHistory: vi.fn(async (runs: unknown[]) => {
      fake.state.writes.push(runs);
    }),
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
vi.mock('@agentmat/core', () => ({
  getCliDefinition: (id: string) => (id === 'claude' ? { name: 'Claude Code' } : undefined),
  runArgsFor: () => [],
}));

let counter = 0;
const started: string[] = [];

beforeEach(() => {
  fake.state.script = {
    'df -h /': { output: '/dev/sda1  20G  19G  95% /\r\n', code: 0 },
  };
  fake.state.ran.length = 0;
  fake.state.aiReplies.length = 0;
  fake.state.aiPrompts.length = 0;
  fake.state.writes.length = 0;
});

afterEach(() => {
  for (const id of started.splice(0)) stopSshTask(id);
});

function nextSession(prefix = 'srv'): string {
  counter += 1;
  const id = `${prefix}-tab-${counter}`;
  started.push(id);
  return id;
}

async function runToEnd(
  sessionId: string,
  replies: string[],
  extra: { prompt?: string; continueFromRunId?: string; cliId?: string } = {},
): Promise<SshAgentProgress[]> {
  fake.state.aiReplies.push(...replies);
  const progress: SshAgentProgress[] = [];
  startSshTask(
    {
      sessionId,
      prompt: extra.prompt ?? 'free up disk space',
      mode: 'approve-risky',
      target: 'ssh',
      ...extra,
    },
    (p) => progress.push(p),
  );
  await vi.waitFor(
    () => expect(['finished', 'stopped', 'error']).toContain(progress.at(-1)?.phase),
    { timeout: 5000 },
  );
  return progress;
}

describe('how a task was started', () => {
  it('is kept with it, so it can be run again the same way', async () => {
    const sessionId = nextSession();
    await runToEnd(sessionId, ['FINISHED: done']);
    expect(getSshTaskHistory(sessionId)[0]?.settings).toEqual({
      target: 'ssh',
      mode: 'approve-risky',
      cliId: null,
      modelId: null,
      effort: null,
    });
  });
});

describe('continuing an earlier task', () => {
  it('tells the AI what happened in it, and asks for what the user wants next', async () => {
    const first = nextSession();
    await runToEnd(first, ['RUN: df -h /', 'FINISHED: the disk is 95% full']);
    const earlier = getSshTaskHistory(first)[0] as SshAgentHistoryRun;

    // A different tab on the same server, the way it is after the first tab closed.
    const second = nextSession();
    fake.state.aiPrompts.length = 0;
    await runToEnd(second, ['FINISHED: cleared'], {
      prompt: 'now clear the old logs',
      continueFromRunId: earlier.id,
    });

    const prompt = fake.state.aiPrompts[0] ?? '';
    expect(prompt).toContain(`User's task: "now clear the old logs"`);
    expect(prompt).toContain('Earlier task: "free up disk space"');
    expect(prompt).toContain('$ df -h / [exit code 0]');
    expect(prompt).toContain('/dev/sda1  20G  19G  95% /');
    expect(prompt).toContain('[Finished]: the disk is 95% full');

    const next = getSshTaskHistory(second)[0];
    expect(next?.prompt).toBe('now clear the old logs');
    expect(next?.continuedFromRunId).toBe(earlier.id);
  });

  it('carries the whole chain when a continued task is continued again', async () => {
    const a = nextSession();
    await runToEnd(a, ['FINISHED: nginx installed'], { prompt: 'install nginx' });
    const b = nextSession();
    await runToEnd(b, ['FINISHED: https on'], {
      prompt: 'enable https',
      continueFromRunId: getSshTaskHistory(a)[0]?.id,
    });
    const c = nextSession();
    fake.state.aiPrompts.length = 0;
    await runToEnd(c, ['FINISHED: ok'], {
      prompt: 'add a redirect',
      continueFromRunId: getSshTaskHistory(b)[0]?.id,
    });
    const prompt = fake.state.aiPrompts[0] ?? '';
    expect(prompt).toContain('Earlier task: "install nginx"');
    expect(prompt.indexOf('Earlier task: "install nginx"')).toBeLessThan(
      prompt.indexOf('Earlier task: "enable https"'),
    );
  });

  it('refuses an id the history does not have', () => {
    const sessionId = nextSession();
    expect(() =>
      startSshTask(
        {
          sessionId,
          prompt: 'go on',
          mode: 'autonomous',
          target: 'ssh',
          continueFromRunId: 'nope',
        },
        () => undefined,
      ),
    ).toThrow('That earlier task is no longer in the history.');
  });
});

describe('the history on disk', () => {
  it('saves tasks run on a saved server, and leaves local ones out', async () => {
    const onServer = nextSession('srv');
    await runToEnd(onServer, ['FINISHED: done']);
    const local = nextSession('local');
    await runToEnd(local, ['FINISHED: done']);

    await vi.waitFor(() => expect(fake.state.writes.length).toBeGreaterThan(0), {
      timeout: 4000,
    });
    const saved = fake.state.writes.at(-1) as SshAgentHistoryRun[];
    expect(saved.some((r) => r.sessionId === onServer && r.status === 'finished')).toBe(true);
    expect(saved.some((r) => r.sessionId === local)).toBe(false);
  });

  it('lists the saved tasks of a server after a restart, and they can be continued', async () => {
    fake.state.savedHistory = [
      {
        id: 'from-yesterday',
        sessionId: 'tab-gone',
        serverId: 'srv-1',
        prompt: 'rotate the logs',
        aiLabel: 'Gemini',
        startedAt: 5,
        endedAt: 6,
        status: 'finished',
        entries: [{ kind: 'finished', at: 6, text: 'Rotated.' }],
        settings: { target: 'ssh', mode: 'autonomous', cliId: null, modelId: null, effort: null },
      },
    ];
    await ensureSshHistoryRestored();
    expect(getSshServerTaskHistory('srv-1').map((r) => r.id)).toContain('from-yesterday');

    const sessionId = nextSession();
    fake.state.aiPrompts.length = 0;
    await runToEnd(sessionId, ['FINISHED: ok'], {
      prompt: 'check they rotated',
      continueFromRunId: 'from-yesterday',
    });
    expect(fake.state.aiPrompts[0]).toContain('Earlier task: "rotate the logs"');
  });

  it('can be cleared for a server', async () => {
    const sessionId = nextSession();
    await runToEnd(sessionId, ['FINISHED: done']);
    expect(getSshServerTaskHistory('srv-1').length).toBeGreaterThan(0);
    fake.state.writes.length = 0;

    await clearSshServerTaskHistory('srv-1');
    expect(getSshServerTaskHistory('srv-1')).toEqual([]);
    expect(getSshTaskHistory(sessionId)).toEqual([]);
    const saved = fake.state.writes.at(-1) as SshAgentHistoryRun[];
    expect(saved.filter((r) => r.serverId === 'srv-1')).toEqual([]);
  });
});
