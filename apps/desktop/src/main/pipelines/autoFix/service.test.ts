import type { AgentStatus } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoFixSession, AutoFixStartInput } from '../../../shared/ciAutoFixTypes';
import { AGENT_SETTLE_MS } from './machine';
import {
  AUTO_FIX_TICK_MS,
  type AutoFixDeps,
  type AutoFixRunView,
  type AutoFixService,
  createAutoFixService,
} from './service';

/**
 * The service is the machine wired to GitHub, git and a terminal. These follow a session the
 * whole way round (fail, fix, push, green) and check the edges that would otherwise go unseen:
 * nothing polls when nothing is on, a restart picks sessions back up, and a failure anywhere
 * ends with the user being told rather than a session stuck in silence.
 */

const T0 = 1_700_000_000_000;

interface Harness {
  deps: AutoFixDeps;
  service: AutoFixService;
  runs: Map<number, AutoFixRunView>;
  saved: AutoFixSession[][];
  agent: {
    listener: ((id: string, status: AgentStatus) => void) | null;
    status: AgentStatus | null;
  };
  calls: Record<string, unknown[][]>;
}

function run(patch: Partial<AutoFixRunView> = {}): AutoFixRunView {
  return {
    status: 'in_progress',
    conclusion: null,
    headSha: 'sha-run',
    runNumber: 7,
    displayTitle: 'Add cart totals',
    ...patch,
  };
}

function harness(overrides: Partial<AutoFixDeps> = {}, stored: AutoFixSession[] = []): Harness {
  const runs = new Map<number, AutoFixRunView>([[100, run()]]);
  const saved: AutoFixSession[][] = [];
  const agent: Harness['agent'] = { listener: null, status: 'working' };
  const calls: Record<string, unknown[][]> = {};
  const record =
    <T>(name: string, result: (...args: never[]) => T) =>
    (...args: unknown[]): T => {
      calls[name] ??= [];
      calls[name].push(args);
      return (result as (...a: unknown[]) => T)(...args);
    };
  let ids = 0;
  const deps: AutoFixDeps = {
    now: () => Date.now(),
    newId: () => `fix-${++ids}`,
    load: async () => stored,
    save: async (sessions) => {
      saved.push(sessions);
    },
    project: async (projectId) =>
      projectId === 'proj-1'
        ? { id: 'proj-1', name: 'Shop', folderPath: '/work/shop', cliId: null, fallbackCliId: null }
        : null,
    defaults: async (project) => ({
      cliId: project.cliId ?? 'claude-code',
      runArgs: ['--model', 'opus'],
      runLabel: 'Opus',
      maxAttempts: 3,
    }),
    getRun: record('getRun', async (_repo: string, runId: number) => {
      const found = runs.get(runId);
      if (!found) throw new Error('Not Found');
      return found;
    }),
    findRun: record('findRun', async () => null),
    failureText: record('failureText', async () => ({
      ok: true as const,
      text: 'npm test exited with 1',
    })),
    preflight: record('preflight', async () => ({ ok: true as const, baseSha: 'sha-base' })),
    commit: record('commit', async () => ({ kind: 'pushed' as const, sha: 'sha-fix' })),
    launch: record('launch', async (request: { sessionId: string; projectId: string }) => ({
      tabId: 'tab-1',
      hooks: true,
      tab: {
        projectId: request.projectId,
        tabId: 'tab-1',
        sessionId: request.sessionId,
        cliId: 'claude-code',
        title: 'Auto-fix #7 · Claude Code',
        cwd: '/work/shop',
      },
    })),
    agentStatus: {
      subscribe: (listener) => {
        agent.listener = listener;
        return () => {
          agent.listener = null;
        };
      },
      status: () => agent.status,
      unpin: record('unpin', () => undefined),
    },
    emitTab: record('emitTab', () => undefined),
    emitChanged: record('emitChanged', () => undefined),
    notify: record('notify', () => undefined),
    pushed: record('pushed', () => undefined),
    ...overrides,
  };
  return { deps, service: createAutoFixService(deps), runs, saved, agent, calls };
}

const input = (patch: Partial<AutoFixStartInput> = {}): AutoFixStartInput => ({
  projectId: 'proj-1',
  repo: 'acme/shop',
  workflowId: 9,
  workflowName: 'CI',
  branch: 'main',
  runId: 100,
  runNumber: 7,
  ...patch,
});

async function advance(h: Harness, ms = AUTO_FIX_TICK_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await h.service.idle();
}

const count = (h: Harness, name: string) => h.calls[name]?.length ?? 0;
const only = (h: Harness) => h.service.list()[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('switching auto-fix on', () => {
  it('follows the run, saves the session and tells the windows', async () => {
    const h = harness();
    await h.service.start();
    const result = await h.service.enable(input({ maxAttempts: 2 }));
    expect(result).toMatchObject({
      ok: true,
      session: {
        phase: 'watching',
        runId: 100,
        cliId: 'claude-code',
        maxAttempts: 2,
        projectName: 'Shop',
      },
    });
    expect(h.saved.at(-1)).toHaveLength(1);
    expect(count(h, 'emitChanged')).toBeGreaterThan(0);
  });

  it('keeps the attempt limit between 1 and 5', async () => {
    const h = harness();
    await h.service.start();
    const high = await h.service.enable(input({ maxAttempts: 40 }));
    expect(high.ok && high.session.maxAttempts).toBe(5);
    const low = await h.service.enable(input({ workflowId: 10, maxAttempts: 0 }));
    expect(low.ok && low.session.maxAttempts).toBe(1);
  });

  it('uses the CLI asked for over the default', async () => {
    const h = harness();
    await h.service.start();
    const result = await h.service.enable(input({ cliId: 'codex-cli', runArgs: ['-m', 'gpt-6'] }));
    expect(result).toMatchObject({
      ok: true,
      session: { cliId: 'codex-cli', runArgs: ['-m', 'gpt-6'] },
    });
  });

  it('takes the model from Settings only along with the CLI from Settings', async () => {
    const h = harness();
    await h.service.start();
    const asDefault = await h.service.enable(input());
    expect(asDefault).toMatchObject({
      ok: true,
      session: { runArgs: ['--model', 'opus'], runLabel: 'Opus' },
    });
    const other = await h.service.enable(input({ workflowId: 10, cliId: 'codex-cli' }));
    expect(other).toMatchObject({ ok: true, session: { runArgs: [], runLabel: null } });
  });

  it('gives back the session already on for that workflow and branch', async () => {
    const h = harness();
    await h.service.start();
    const first = await h.service.enable(input());
    const second = await h.service.enable(input());
    expect(second.ok && first.ok && second.session.id).toBe(first.ok && first.session.id);
    expect(h.service.list()).toHaveLength(1);
  });

  it('refuses a project that is gone, and a CLI Runova does not know', async () => {
    const h = harness({
      defaults: async () => ({ cliId: 'nope', runArgs: [], runLabel: null, maxAttempts: 3 }),
    });
    await h.service.start();
    await expect(h.service.enable(input({ projectId: 'gone' }))).resolves.toEqual({
      ok: false,
      error: 'That project no longer exists.',
    });
    await expect(h.service.enable(input())).resolves.toEqual({
      ok: false,
      error: 'Pick an agent CLI for auto-fix in Settings first.',
    });
  });

  it('waits for the run of a dispatch, then follows it', async () => {
    const h = harness();
    h.deps.findRun = vi.fn(async () => ({ id: 100, runNumber: 7 }));
    await h.service.start();
    await h.service.enable(input({ runId: undefined, runNumber: undefined }));
    expect(only(h).phase).toBe('waiting-run');
    await advance(h);
    expect(h.deps.findRun).toHaveBeenCalledWith('acme/shop', 9, 'main', {
      kind: 'dispatch',
      since: T0,
    });
    expect(only(h)).toMatchObject({ phase: 'watching', runId: 100 });
  });
});

describe('the whole loop', () => {
  it('fixes a failed run, pushes, follows the new run and reports it fixed', async () => {
    const h = harness();
    await h.service.start();
    await h.service.enable(input());

    h.runs.set(100, run({ status: 'completed', conclusion: 'failure' }));
    await advance(h);
    expect(h.calls.preflight[0]).toEqual(['/work/shop', 'main', 'sha-run']);
    expect(h.calls.failureText[0][0]).toMatchObject({ repo: 'acme/shop', runId: 100 });
    const launch = h.calls.launch[0][0] as { prompt: string; attempt: number; cwd: string };
    expect(launch).toMatchObject({ attempt: 1, cwd: '/work/shop', cliId: 'claude-code' });
    expect(launch.prompt).toContain('npm test exited with 1');
    expect(launch.prompt).toContain('do not commit, push or switch branches yourself');
    expect(h.calls.emitTab[0][0]).toMatchObject({ tabId: 'tab-1', sessionId: 'fix-1' });
    expect(only(h)).toMatchObject({ phase: 'fixing', agent: { hooks: true } });

    h.agent.listener?.('tab-1', 'working');
    h.agent.listener?.('tab-1', 'done');
    await h.service.idle();
    expect(h.calls.commit[0]).toEqual([
      '/work/shop',
      {
        branch: 'main',
        baseSha: 'sha-base',
        message: 'fix(ci): repair CI failure from run #7 (auto-fix 1/3)',
      },
    ]);
    expect(h.calls.pushed[0]).toEqual(['proj-1']);
    expect(h.calls.unpin[0]).toEqual(['tab-1']);
    expect(only(h)).toMatchObject({
      phase: 'waiting-run',
      waitFor: { kind: 'commit', sha: 'sha-fix' },
    });

    h.deps.findRun = vi.fn(async () => ({ id: 101, runNumber: 8 }));
    h.runs.set(101, run({ runNumber: 8 }));
    await advance(h);
    expect(h.deps.findRun).toHaveBeenCalledWith(
      'acme/shop',
      9,
      'main',
      expect.objectContaining({ kind: 'commit', sha: 'sha-fix' }),
    );
    expect(only(h)).toMatchObject({ phase: 'watching', runId: 101 });

    h.runs.set(101, run({ runNumber: 8, status: 'completed', conclusion: 'success' }));
    await advance(h);
    expect(only(h).phase).toBe('succeeded');
    expect(h.calls.notify).toEqual([[expect.objectContaining({ id: 'fix-1' }), 'fixed']]);

    const reads = count(h, 'getRun');
    await advance(h, AUTO_FIX_TICK_MS * 4);
    expect(count(h, 'getRun')).toBe(reads);
  });

  it('commits for a CLI without hooks once it has been quiet long enough', async () => {
    const h = harness();
    h.deps.launch = vi.fn(async (request) => ({
      tabId: 'tab-1',
      hooks: false,
      tab: { ...request, tabId: 'tab-1', title: 'x', cwd: request.cwd },
    }));
    await h.service.start();
    await h.service.enable(input());
    h.runs.set(100, run({ status: 'completed', conclusion: 'failure' }));
    await advance(h);
    h.agent.listener?.('tab-1', 'working');
    h.agent.status = 'done';
    h.agent.listener?.('tab-1', 'done');
    await h.service.idle();
    expect(count(h, 'commit')).toBe(0);
    await advance(h, AGENT_SETTLE_MS + AUTO_FIX_TICK_MS);
    expect(count(h, 'commit')).toBe(1);
  });

  it('ignores status from tabs that are not an attempt', async () => {
    const h = harness();
    await h.service.start();
    await h.service.enable(input());
    h.runs.set(100, run({ status: 'completed', conclusion: 'failure' }));
    await advance(h);
    h.agent.listener?.('someone-else', 'done');
    await h.service.idle();
    expect(only(h).phase).toBe('fixing');
  });
});

describe('when something goes wrong', () => {
  async function failedRun(overrides: Partial<AutoFixDeps>) {
    const h = harness(overrides);
    await h.service.start();
    await h.service.enable(input());
    h.runs.set(100, run({ status: 'completed', conclusion: 'failure' }));
    await advance(h);
    return h;
  }

  it('asks the user when the checkout is not ready', async () => {
    const h = await failedRun({
      preflight: async () => ({ ok: false, blocker: 'dirty-tree', message: 'Uncommitted.' }),
    });
    expect(only(h)).toMatchObject({
      phase: 'attention',
      blocker: 'dirty-tree',
      message: 'Uncommitted.',
    });
    expect(h.calls.notify).toEqual([[expect.anything(), 'attention']]);
    expect(count(h, 'launch')).toBe(0);
  });

  it('asks the user when the failure cannot be read', async () => {
    const h = await failedRun({ failureText: async () => ({ ok: false, error: 'rate limited' }) });
    expect(only(h)).toMatchObject({
      phase: 'attention',
      blocker: 'read-failed',
      message: 'Could not read the failure from GitHub: rate limited',
    });
  });

  it('asks the user when the agent cannot start, with the reason', async () => {
    const h = await failedRun({
      launch: async () => {
        throw new Error('The terminal could not start.');
      },
    });
    expect(only(h)).toMatchObject({
      phase: 'attention',
      blocker: 'launch-failed',
      message: 'The terminal could not start.',
    });
  });

  it('notices when the agent tab is no longer tracked', async () => {
    const h = await failedRun({});
    h.agent.status = null;
    await advance(h);
    expect(only(h)).toMatchObject({ phase: 'attention', blocker: 'agent-lost' });
  });

  it('keeps going when GitHub cannot be reached for a tick', async () => {
    const h = harness();
    await h.service.start();
    await h.service.enable(input());
    h.runs.delete(100);
    await advance(h);
    expect(only(h).phase).toBe('watching');
    h.runs.set(100, run({ status: 'completed', conclusion: 'success' }));
    await advance(h);
    expect(only(h).phase).toBe('succeeded');
  });
});

describe('the user', () => {
  async function fixing() {
    const h = harness();
    await h.service.start();
    const result = await h.service.enable(input());
    h.runs.set(100, run({ status: 'completed', conclusion: 'failure' }));
    await advance(h);
    return { h, id: result.ok ? result.session.id : '' };
  }

  it('can stop a session, which stops the polling', async () => {
    const { h, id } = await fixing();
    await expect(h.service.stop(id)).resolves.toMatchObject({ phase: 'stopped' });
    expect(h.calls.unpin).toEqual([['tab-1']]);
    const reads = count(h, 'getRun');
    await advance(h, AUTO_FIX_TICK_MS * 3);
    expect(count(h, 'getRun')).toBe(reads);
  });

  it('can commit now and retry by id', async () => {
    const { h, id } = await fixing();
    h.deps.commit = vi.fn(async () => ({
      kind: 'blocked' as const,
      blocker: 'push-failed' as const,
      message: 'Rejected.',
    }));
    await h.service.commitNow(id);
    await h.service.idle();
    expect(only(h).blocker).toBe('push-failed');
    h.deps.commit = vi.fn(async () => ({ kind: 'pushed' as const, sha: 'sha-fix' }));
    await h.service.retry(id);
    await h.service.idle();
    expect(only(h).phase).toBe('waiting-run');
  });

  it('can clear a finished session but not one in progress', async () => {
    const { h, id } = await fixing();
    await expect(h.service.dismiss(id)).resolves.toBe(false);
    await h.service.stop(id);
    await expect(h.service.dismiss(id)).resolves.toBe(true);
    expect(h.service.list()).toEqual([]);
  });

  it('gets null for a session id that does not exist', async () => {
    const h = harness();
    await h.service.start();
    await expect(h.service.stop('nope')).resolves.toBeNull();
  });
});

describe('claims', () => {
  it('says which runs an auto-fix session took on, so the watcher does not raise a second alarm', async () => {
    const h = harness();
    await h.service.start();
    await h.service.enable(input());
    expect(h.service.claims('proj-1', 100)).toBe(true);
    expect(h.service.claims('proj-1', 55)).toBe(false);
    expect(h.service.claims('proj-2', 100)).toBe(false);
  });
});

describe('after a restart', () => {
  const stored = (patch: Partial<AutoFixSession>): AutoFixSession => ({
    id: 'fix-old',
    projectId: 'proj-1',
    projectName: 'Shop',
    repo: 'acme/shop',
    workflowId: 9,
    workflowName: 'CI',
    branch: 'main',
    cliId: 'claude-code',
    runArgs: [],
    runLabel: null,
    maxAttempts: 3,
    runId: 100,
    runNumber: 7,
    waitFor: null,
    phase: 'watching',
    blocker: null,
    message: null,
    attempts: [],
    agent: null,
    createdAt: T0 - 1000,
    updatedAt: T0 - 1000,
    ...patch,
  });

  it('picks up a session that was following a run', async () => {
    const h = harness({}, [stored({})]);
    await h.service.start();
    h.runs.set(100, run({ status: 'completed', conclusion: 'success' }));
    await advance(h);
    expect(only(h).phase).toBe('succeeded');
  });

  it('asks the user about a commit the app closed in the middle of', async () => {
    const h = harness({}, [
      stored({
        phase: 'committing',
        attempts: [
          {
            n: 1,
            runId: 100,
            runNumber: 7,
            startedAt: T0,
            tabId: 'tab-1',
            baseSha: 'sha-base',
            commitSha: null,
            nextRunId: null,
            nextRunNumber: null,
            outcome: 'fixing',
          },
        ],
      }),
    ]);
    await h.service.start();
    expect(only(h)).toMatchObject({ phase: 'attention', blocker: 'commit-failed' });
  });

  it('drops finished sessions older than a few days', async () => {
    const old = stored({ id: 'old', phase: 'succeeded', updatedAt: T0 - 8 * 24 * 3600_000 });
    const recent = stored({ id: 'recent', phase: 'gave-up', updatedAt: T0 - 3600_000 });
    const h = harness({}, [old, recent]);
    await h.service.start();
    expect(h.service.list().map((s) => s.id)).toEqual(['recent']);
  });

  it('does not poll at all when nothing is on', async () => {
    const h = harness();
    await h.service.start();
    await advance(h, AUTO_FIX_TICK_MS * 5);
    expect(count(h, 'getRun')).toBe(0);
    h.service.dispose();
  });
});
