import {
  type AgentStatus,
  type BoardFile,
  DEFAULT_RELAY_OPTIONS,
  type HandoffMeta,
  parseTaskFile,
  type RelayState,
  renderTaskFile,
} from '@agentmat/core';
import { describe, expect, it, vi } from 'vitest';
import type { RelayProjectSettings } from '../../shared/relayTypes';
import { createRelayDriver, type RelayDriverDeps } from './service';
import type { HandoffRead } from './taskFiles';

/** The Relay driver with fakes for everything outside it, and a clock moved by hand. */

function file(id: string, extra: Record<string, unknown> = {}): BoardFile {
  const content = renderTaskFile({ id, title: `Task ${id}`, status: 'todo', ...extra });
  const name = `${id}-task.md`;
  return { file: name, content, task: parseTaskFile(name, content) };
}

function settings(overrides: Partial<RelayProjectSettings['options']> = {}): RelayProjectSettings {
  return {
    docsFolder: 'docs',
    defaults: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
    overrides: {},
    options: { ...DEFAULT_RELAY_OPTIONS, ...overrides },
  };
}

function harness(
  options: {
    files?: BoardFile[];
    settings?: RelayProjectSettings;
    saved?: RelayState[];
    live?: string[];
  } = {},
) {
  let clock = 1_000_000;
  let files = options.files ?? [file('T001'), file('T002', { depends: ['T001'] })];
  const handoffs = new Map<string, HandoffMeta>();
  const sessions = new Map<string, AgentStatus | 'gone'>();
  const exits = new Map<string, (info: { exitCode: number; hostLost: boolean }) => void>();
  let tabSeq = 0;
  const saved: RelayState[] = [];
  const deps = {
    now: () => clock,
    loadRelays: async () => options.saved ?? [],
    saveRelay: vi.fn(async (state: RelayState) => {
      saved.push(state);
    }),
    addLegRecord: vi.fn(async () => undefined),
    settings: async () => options.settings ?? settings(),
    boardFiles: async () => files,
    setTaskStatus: vi.fn(async (_p: string, _d: string, taskId: string, status: string) => {
      files = files.map((entry) =>
        entry.task.id === taskId
          ? { ...entry, task: { ...entry.task, status: status as BoardFile['task']['status'] } }
          : entry,
      );
    }),
    readHandoff: async (_p: string, _d: string, taskId: string): Promise<HandoffRead | null> => {
      const meta = handoffs.get(taskId);
      return meta
        ? ({ meta, text: '', handoff: {} as HandoffRead['handoff'] } satisfies HandoffRead)
        : null;
    },
    launch: vi.fn(async (relay: RelayState, effect: { legId: string; taskId: string }) => {
      tabSeq += 1;
      const tabId = `tab-${tabSeq}`;
      sessions.set(tabId, 'idle');
      return {
        tabId,
        handoffMtimeAtStart: clock - 1,
        hooks: true,
        tab: {
          projectId: relay.projectId,
          tabId,
          legId: effect.legId,
          cliId: 'claude-code',
          title: `${effect.taskId} Claude Code`,
          cwd: 'C:/work',
        },
      };
    }),
    assess: vi.fn(async () => null),
    armGuard: vi.fn(async () => undefined),
    screenText: vi.fn(() => ''),
    typeIntoSession: vi.fn(),
    forwardStop: vi.fn(),
    sessionStatus: (tabId: string) => sessions.get(tabId) ?? 'gone',
    transcriptPath: () => null,
    sessionModel: () => undefined,
    readContext: async () => null,
    contextWindow: () => null,
    watchExit: (
      tabId: string,
      listener: (info: { exitCode: number; hostLost: boolean }) => void,
    ) => {
      exits.set(tabId, listener);
      return () => exits.delete(tabId);
    },
    liveSessions: async () => options.live ?? [],
    adoptSession: vi.fn(async () => null),
    releaseSession: vi.fn(),
    notify: vi.fn(),
    emitRun: vi.fn(),
    emitChanged: vi.fn(),
    emitContext: vi.fn(),
    emitLegTab: vi.fn(),
    emitCloseTab: vi.fn(),
    emitProposal: vi.fn(),
    applyProposal: vi.fn(async () => ({ written: ['T003-x.md'], removed: [], warnings: [] })),
  } satisfies RelayDriverDeps;
  const driver = createRelayDriver(deps);
  return {
    driver,
    deps,
    saved,
    sessions,
    exits,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    writeHandoff: (taskId: string, meta: Partial<HandoffMeta> = {}) => {
      handoffs.set(taskId, {
        mtimeMs: clock,
        outcome: 'done',
        tests: 'passed',
        next: '',
        hash: `h${clock}`,
        ...meta,
      });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('a relay from start to finish', () => {
  it('launches each task in turn and ticks it off', async () => {
    const h = harness();
    const started = await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    expect(started.ok).toBe(true);
    await settle();
    expect(h.deps.launch).toHaveBeenCalledTimes(1);
    expect(h.deps.emitLegTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1' }));
    expect(h.deps.setTaskStatus).toHaveBeenCalledWith('p1', 'docs', 'T001', 'in-progress');
    const run = h.driver.active('p1');
    expect(run?.current).toMatchObject({ taskId: 'T001', tabId: 'tab-1', phase: 'executing' });

    h.driver.onAgentStatus('tab-1', 'working');
    h.advance(5_000);
    h.writeHandoff('T001');
    await h.driver.onFilesChanged('p1', ['T001'], false);
    h.driver.onAgentStatus('tab-1', 'done');
    await settle();

    expect(h.deps.setTaskStatus).toHaveBeenCalledWith('p1', 'docs', 'T001', 'done');
    expect(h.deps.emitCloseTab).toHaveBeenCalledWith({ projectId: 'p1', tabId: 'tab-1' });
    expect(h.deps.addLegRecord).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ taskId: 'T001', outcome: 'done' }),
    );
    expect(h.deps.launch).toHaveBeenCalledTimes(2);
    expect(h.driver.active('p1')?.current).toMatchObject({ taskId: 'T002', tabId: 'tab-2' });
    expect(h.saved.at(-1)?.current?.taskId).toBe('T002');
  });

  it('adds tasks started after one of its tasks to the live relay', async () => {
    const h = harness({ files: [file('T001'), file('T002')] });
    const first = await h.driver.start({
      projectId: 'p1',
      only: ['T001'],
      trigger: { kind: 'now' },
    });
    await settle();
    const joined = await h.driver.start({
      projectId: 'p1',
      only: ['T002'],
      trigger: { kind: 'after-task', projectId: 'p1', taskId: 'T001' },
    });
    expect(joined).toMatchObject({ ok: true, run: { id: first.ok ? first.run.id : '' } });
    expect(h.driver.active('p1')?.queue).toEqual(['T002']);
    expect(h.driver.runs('p1')).toHaveLength(1);

    // A task the live relay will not run cannot be waited on from inside it.
    const outside = await h.driver.start({
      projectId: 'p1',
      only: ['T002'],
      trigger: { kind: 'after-task', projectId: 'p1', taskId: 'T009' },
    });
    expect(outside).toEqual({ ok: false, error: expect.stringMatching(/already/) });
  });

  it('refuses a second relay on the same project, and tasks in a loop', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'at', at: Date.now() * 2 } });
    expect(
      await h.driver.start({ projectId: 'p1', trigger: { kind: 'at', at: Date.now() * 3 } }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/already/),
    });

    const loop = harness({
      files: [file('T001', { depends: ['T002'] }), file('T002', { depends: ['T001'] })],
    });
    expect(await loop.driver.start({ projectId: 'p1', trigger: { kind: 'now' } })).toEqual({
      ok: false,
      error: expect.stringMatching(/loop/),
    });
  });

  it('reports a launch that fails and retries once', async () => {
    const h = harness();
    h.deps.launch.mockRejectedValue(new Error('claude is not installed'));
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    expect(h.deps.launch).toHaveBeenCalledTimes(2);
    expect(h.driver.active('p1')?.status).toBe('paused');
    expect(h.deps.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: 'claude is not installed' }),
    );
  });

  it('turns a session ending without a handoff into an interrupted, paused leg', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    h.exits.get('tab-1')?.({ exitCode: 0, hostLost: false });
    await settle();
    expect(h.driver.active('p1')).toMatchObject({
      status: 'paused',
      current: { phase: 'interrupted' },
    });
  });
});

describe('the gate', () => {
  it('holds a stop without a fresh handoff, and passes one with it on', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    const held = await h.driver.gate({ sessionId: 'tab-1', event: 'Stop', permissionMode: 'auto' });
    expect(held).toEqual({
      decision: 'block',
      reason: expect.stringContaining('handoffs/T001.md'),
    });
    expect(h.deps.forwardStop).not.toHaveBeenCalled();
    expect(h.driver.active('p1')?.current).toBeTruthy();

    h.advance(1_000);
    h.writeHandoff('T001');
    const passed = await h.driver.gate({ sessionId: 'tab-1', event: 'Stop', stopHookActive: true });
    expect(passed).toBeNull();
    expect(h.deps.forwardStop).toHaveBeenCalledWith('tab-1');
  });

  it('finishes a leg whose handoff the file watcher never reported, from the stop', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    h.driver.onAgentStatus('tab-1', 'working');
    await settle();
    h.advance(1_000);
    h.writeHandoff('T001');
    expect(await h.driver.gate({ sessionId: 'tab-1', event: 'Stop' })).toBeNull();
    h.driver.onAgentStatus('tab-1', 'done');
    await settle();
    expect(h.deps.setTaskStatus).toHaveBeenCalledWith('p1', 'docs', 'T001', 'done');
  });

  it('picks up a missed handoff on the next tick', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    h.driver.onAgentStatus('tab-1', 'working');
    h.driver.onAgentStatus('tab-1', 'done');
    await settle();
    expect(h.driver.active('p1')?.current?.phase).toBe('finishing');
    h.advance(1_000);
    h.writeHandoff('T001');
    await h.driver.tick();
    await settle();
    expect(h.deps.setTaskStatus).toHaveBeenCalledWith('p1', 'docs', 'T001', 'done');
  });

  it('waits for a launch being recorded before judging a hook from its session', async () => {
    const h = harness({ settings: settings({ planFirst: true }) });
    // The CLI runs its first hooks while launch() has not returned yet, as a fast one does.
    let finish = (): void => undefined;
    const original = h.deps.launch.getMockImplementation();
    h.deps.launch.mockImplementationOnce(async (relay, effect) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return original?.(relay, effect) as ReturnType<typeof h.deps.launch>;
    });
    const started = h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    const answer = h.driver.gate({
      sessionId: 'tab-1',
      event: 'PermissionRequest',
      tool: 'ExitPlanMode',
      permissionMode: 'plan',
      toolInput: { plan: '# Plan\n1. Go', planFilePath: 'C:/p.md' },
    });
    await settle();
    finish();
    await started;
    expect(await answer).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(h.driver.active('p1')?.current?.phase).toBe('executing');
  });

  it('passes the stop of a tab that is no relay leg straight on', async () => {
    const h = harness();
    expect(await h.driver.gate({ sessionId: 'other', event: 'Stop' })).toBeNull();
    expect(h.deps.forwardStop).toHaveBeenCalledWith('other');
  });

  it('approves the plan of a plan-first leg and moves it on', async () => {
    const h = harness({ settings: settings({ planFirst: true }) });
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    expect(h.driver.active('p1')?.current?.phase).toBe('planning');
    const output = await h.driver.gate({
      sessionId: 'tab-1',
      event: 'PermissionRequest',
      tool: 'ExitPlanMode',
      permissionMode: 'plan',
      toolInput: { plan: '# Plan\n1. Go', planFilePath: 'C:/p.md' },
    });
    expect(output).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'allow' } },
    });
    expect(h.driver.active('p1')?.current?.phase).toBe('executing');
  });

  it('types the plan menu choice only when the menu is on screen', async () => {
    const h = harness({ settings: settings({ planFirst: true }) });
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    await h.driver.gate({
      sessionId: 'tab-1',
      event: 'PreToolUse',
      tool: 'ExitPlanMode',
      toolInput: { plan: '# Plan', planFilePath: 'C:/p.md' },
    });
    h.driver.onAgentStatus('tab-1', 'needs-input');
    await settle();
    expect(h.deps.typeIntoSession).not.toHaveBeenCalled();

    h.deps.screenText.mockReturnValue('Claude has written up a plan and is ready to execute.');
    h.driver.onAgentStatus('tab-1', 'working');
    h.driver.onAgentStatus('tab-1', 'needs-input');
    await settle();
    expect(h.deps.typeIntoSession).toHaveBeenCalledWith('tab-1', '1');
  });
});

describe('restarts, triggers and reconcile', () => {
  async function savedRelay(): Promise<RelayState> {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    return h.saved.at(-1)!;
  }

  it('adopts a leg whose session survived, and launches nothing', async () => {
    const before = await savedRelay();
    const h = harness({ saved: [before], live: ['tab-1'] });
    await h.driver.startup();
    await settle();
    expect(h.deps.adoptSession).toHaveBeenCalledTimes(1);
    expect(h.deps.launch).not.toHaveBeenCalled();
    expect(h.driver.active('p1')?.current?.phase).toBe('executing');
  });

  it('marks a leg whose session died as interrupted, and launches nothing', async () => {
    const before = await savedRelay();
    const h = harness({ saved: [before], live: [] });
    await h.driver.startup();
    await settle();
    expect(h.deps.launch).not.toHaveBeenCalled();
    expect(h.driver.active('p1')).toMatchObject({
      status: 'paused',
      current: { phase: 'interrupted' },
    });
  });

  it('starts a relay when the session it waits for finishes', async () => {
    const h = harness();
    h.sessions.set('busy', 'working');
    const result = await h.driver.start({
      projectId: 'p1',
      trigger: { kind: 'after-session', sessionId: 'busy', label: 'Codex 2' },
    });
    expect(result).toMatchObject({
      ok: true,
      run: { status: 'waiting', triggerText: 'Starts when Codex 2 finishes' },
    });
    await h.driver.checkTriggers();
    expect(h.deps.launch).not.toHaveBeenCalled();
    h.sessions.set('busy', 'done');
    h.driver.onAgentStatus('busy', 'done');
    await settle();
    expect(h.deps.launch).toHaveBeenCalledTimes(1);
  });

  it('shows a leg tab again to a renderer that lost it', async () => {
    const h = harness();
    await h.driver.start({ projectId: 'p1', trigger: { kind: 'now' } });
    await settle();
    h.deps.emitLegTab.mockClear();
    await h.driver.reconcile([{ legId: 'x', tabId: 'tab-1' }]);
    expect(h.deps.emitLegTab).not.toHaveBeenCalled();
    await h.driver.reconcile([]);
    expect(h.deps.emitLegTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-1' }));
  });
});

describe('proposals from agents', () => {
  it('holds a proposal until the user decides, then applies it', async () => {
    const h = harness();
    const added = h.driver.addProposal(
      'p1',
      'Clinic',
      'T001',
      { summary: 's', add: [], change: [], split: [], remove: [] },
      [],
    );
    expect(typeof added).toBe('object');
    expect(h.deps.emitProposal).toHaveBeenCalledWith(added);
    expect(h.driver.pendingProposals()).toHaveLength(1);
    const id = (added as { id: string }).id;
    expect(await h.driver.decideProposal(id, true)).toEqual({
      written: ['T003-x.md'],
      removed: [],
      warnings: [],
    });
    expect(h.driver.pendingProposals()).toEqual([]);
    expect(await h.driver.decideProposal(id, true)).toBeNull();
  });

  it('caps the proposals waiting on one project', async () => {
    const h = harness();
    const empty = { summary: '', add: [], change: [], split: [], remove: [] };
    for (let i = 0; i < 10; i += 1) h.driver.addProposal('p1', 'Clinic', null, empty, []);
    expect(typeof h.driver.addProposal('p1', 'Clinic', null, empty, [])).toBe('string');
  });
});
