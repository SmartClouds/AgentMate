import { describe, expect, it } from 'vitest';
import {
  createRelay,
  DEFAULT_RELAY_OPTIONS,
  type HandoffMeta,
  RELAY_TIMING,
  type RelayEffect,
  type RelayEvent,
  type RelayOptions,
  type RelayState,
  type RelayTaskSnapshot,
  reduceRelay,
} from './runner.js';

const T0 = 1_760_000_000_000;

function snapshot(
  id: string,
  options: Partial<Omit<RelayTaskSnapshot, 'id'>> = {},
): RelayTaskSnapshot {
  return { id, status: 'todo', depends: [], budget: null, ...options };
}

function relay(
  options: {
    tasks?: RelayTaskSnapshot[];
    queue?: string[];
    cliId?: string;
    autoSize?: boolean;
    relayOptions?: Partial<RelayOptions>;
  } = {},
): RelayState {
  const tasks = options.tasks ?? [snapshot('T001'), snapshot('T002', { depends: ['T001'] })];
  return createRelay({
    id: 'r1',
    projectId: 'p1',
    docsFolder: 'docs',
    now: T0,
    tasks,
    queue: options.queue ?? tasks.map((task) => task.id),
    trigger: { kind: 'now' },
    defaults: {
      cliId: options.cliId ?? 'claude-code',
      model: 'opus',
      effort: 'high',
      autoSize: options.autoSize ?? false,
    },
    overrides: {},
    options: { ...DEFAULT_RELAY_OPTIONS, ...options.relayOptions },
  });
}

/** Feeds events in order and collects every effect. */
function feed(state: RelayState, ...events: RelayEvent[]) {
  let current = state;
  const effects: RelayEffect[] = [];
  for (const event of events) {
    const result = reduceRelay(current, event);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

function of<T extends RelayEffect['type']>(effects: RelayEffect[], type: T) {
  return effects.filter(
    (effect): effect is Extract<RelayEffect, { type: T }> => effect.type === type,
  );
}

function handoff(overrides: Partial<HandoffMeta> = {}): HandoffMeta {
  return {
    mtimeMs: T0 + 5_000,
    outcome: 'done',
    tests: 'passed',
    next: 'Nothing left.',
    hash: 'h1',
    ...overrides,
  };
}

/** Starts the relay and launches its first leg in tab-1, handoff written before at T0 - 1. */
function running(state = relay()) {
  const started = feed(state, { type: 'start', now: T0 });
  const launch = of(started.effects, 'launch')[0];
  const launched = feed(started.state, {
    type: 'launched',
    legId: launch.legId,
    tabId: 'tab-1',
    handoffMtimeAtStart: T0 - 1,
    now: T0,
  });
  return {
    state: launched.state,
    effects: [...started.effects, ...launched.effects],
    legId: launch.legId,
  };
}

describe('starting', () => {
  it('waits until started and launches the first task with its run choice', () => {
    const state = relay();
    expect(state.status).toBe('waiting');
    const { state: next, effects } = feed(state, { type: 'start', now: T0 });
    expect(next.status).toBe('running');
    expect(next.current).toMatchObject({ taskId: 'T001', legNo: 1, phase: 'launching' });
    expect(of(effects, 'launch')).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        legNo: 1,
        continuation: false,
        planFirst: false,
        budget: DEFAULT_RELAY_OPTIONS.defaultBudget,
        choice: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
      }),
    ]);
  });

  it('sizes the task first when the run choice is automatic', () => {
    const { state, effects } = feed(relay({ autoSize: true }), { type: 'start', now: T0 });
    expect(state.current?.phase).toBe('sizing');
    const [assess] = of(effects, 'assess');
    expect(assess).toMatchObject({ taskId: 'T001' });
    expect(of(effects, 'launch')).toEqual([]);

    const sized = feed(state, {
      type: 'sized',
      legId: assess.legId,
      choice: { cliId: 'claude-code', model: 'sonnet', effort: 'medium' },
    });
    expect(of(sized.effects, 'launch')[0].choice).toEqual({
      cliId: 'claude-code',
      model: 'sonnet',
      effort: 'medium',
      autoSize: false,
    });
  });

  it('launches with the plain choice when sizing fails', () => {
    const { state, effects } = feed(relay({ autoSize: true }), { type: 'start', now: T0 });
    const legId = of(effects, 'assess')[0].legId;
    const failed = feed(state, { type: 'sizeFailed', legId });
    expect(of(failed.effects, 'launch')[0].choice).toMatchObject({
      model: 'opus',
      autoSize: false,
    });
  });

  it('uses a task override over the defaults', () => {
    const state = relay();
    state.overrides.T001 = { cliId: 'codex-cli', model: 'gpt-6', effort: null };
    const { effects } = feed(state, { type: 'start', now: T0 });
    expect(of(effects, 'launch')[0].choice).toMatchObject({ cliId: 'codex-cli', model: 'gpt-6' });
  });

  it('ignores a stale or repeated launch report', () => {
    const { state, legId } = running();
    const again = feed(state, {
      type: 'launched',
      legId,
      tabId: 'tab-other',
      handoffMtimeAtStart: 0,
      now: T0,
    });
    expect(again.state.current?.tabId).toBe('tab-1');
    const stale = feed(state, {
      type: 'launched',
      legId: 'nope',
      tabId: 'tab-x',
      handoffMtimeAtStart: 0,
      now: T0,
    });
    expect(stale.state).toBe(state);
  });

  it('marks the task in progress once its first leg is up', () => {
    const { state, effects } = running();
    expect(state.current?.phase).toBe('executing');
    expect(of(effects, 'setTaskStatus')).toEqual([
      { type: 'setTaskStatus', taskId: 'T001', status: 'in-progress' },
    ]);
  });

  it('retries a launch that never comes up once, then fails and pauses', () => {
    const started = feed(relay(), { type: 'start', now: T0 });
    const late = T0 + RELAY_TIMING.launchTimeoutMs + 1;
    const retry = feed(started.state, { type: 'tick', now: late });
    const relaunch = of(retry.effects, 'launch');
    expect(relaunch).toHaveLength(1);
    expect(relaunch[0].legId).not.toBe(of(started.effects, 'launch')[0].legId);

    const failed = feed(retry.state, {
      type: 'launchFailed',
      legId: relaunch[0].legId,
      error: 'The CLI is not installed.',
    });
    expect(failed.state.status).toBe('paused');
    expect(failed.state.current?.phase).toBe('failed');
    expect(of(failed.effects, 'notify')[0].body).toContain('The CLI is not installed.');
  });
});

describe('finishing a leg (CLI with hooks)', () => {
  it('completes when the handoff says done and then the agent stops', () => {
    const { state } = running();
    const { state: next, effects } = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(of(effects, 'setTaskStatus')).toContainEqual({
      type: 'setTaskStatus',
      taskId: 'T001',
      status: 'done',
    });
    expect(of(effects, 'closeTab')).toEqual([{ type: 'closeTab', tabId: 'tab-1' }]);
    expect(next.finished).toEqual([expect.objectContaining({ taskId: 'T001', result: 'done' })]);
    expect(next.current).toMatchObject({ taskId: 'T002', legNo: 1, phase: 'launching' });
    expect(of(effects, 'recordLeg')[0].record).toMatchObject({
      taskId: 'T001',
      outcome: 'done',
      tests: 'passed',
      tabId: 'tab-1',
    });
  });

  it('completes when the agent stops first and the handoff lands within the grace', () => {
    const { state } = running();
    const stopped = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(stopped.state.current?.phase).toBe('finishing');
    const done = feed(stopped.state, {
      type: 'handoffChanged',
      taskId: 'T001',
      handoff: handoff(),
      now: T0 + 9_000,
    });
    expect(done.state.current?.taskId).toBe('T002');
  });

  it('waits for the user when the agent stops and no handoff comes', () => {
    const { state } = running();
    const stopped = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
      { type: 'tick', now: T0 + 6_000 + RELAY_TIMING.stopGraceMs + 1 },
    );
    expect(stopped.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'stale-handoff' },
    });
    expect(stopped.state.status).toBe('running');
    expect(of(stopped.effects, 'notify')).toHaveLength(1);

    // The user asks the agent in the tab to write it; the relay carries on by itself.
    const fixed = feed(
      stopped.state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 60_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 61_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 62_000 },
    );
    expect(fixed.state.current?.taskId).toBe('T002');
  });

  it('still completes after the done status was acknowledged into idle', () => {
    const { state } = running();
    const { state: next } = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'idle', now: T0 + 7_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 8_000 },
    );
    expect(next.current?.taskId).toBe('T002');
  });

  it('ignores a handoff written before the leg started', () => {
    const { state } = running();
    const { state: next } = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      {
        type: 'handoffChanged',
        taskId: 'T001',
        handoff: handoff({ mtimeMs: T0 - 1 }),
        now: T0 + 2_000,
      },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 3_000 },
    );
    expect(next.current).toMatchObject({ taskId: 'T001', phase: 'finishing' });
  });

  it('ignores status from another tab and handoffs of another task', () => {
    const { state } = running();
    const { state: next } = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-9', status: 'done', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T002', handoff: handoff(), now: T0 + 2_000 },
    );
    expect(next.current).toMatchObject({ taskId: 'T001', phase: 'executing', handoff: null });
  });

  it('counts an MCP report as the handoff half, never as the stop', () => {
    const { state } = running();
    const reported = feed(state, {
      type: 'legReported',
      tabId: 'tab-1',
      handoff: handoff(),
      now: T0 + 5_000,
    });
    expect(reported.state.current?.taskId).toBe('T001');
    const stopped = feed(reported.state, {
      type: 'agentStatus',
      tabId: 'tab-1',
      status: 'done',
      now: T0 + 6_000,
    });
    expect(stopped.state.current?.taskId).toBe('T002');
  });
});

describe('finishing a leg (CLI without hooks)', () => {
  const codex = () =>
    running(
      relay({
        cliId: 'codex-cli',
        tasks: [snapshot('T001')],
        relayOptions: { closeFinishedTabs: false },
      }),
    );

  it('waits for the output to stay quiet before it trusts a silence', () => {
    const { state } = codex();
    const quiet = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(quiet.state.current?.taskId).toBe('T001');

    const resumed = feed(
      quiet.state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 10_000 },
      { type: 'tick', now: T0 + 6_000 + RELAY_TIMING.quietMs + 1 },
    );
    expect(resumed.state.current?.taskId).toBe('T001');

    const settled = feed(
      resumed.state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 40_000 },
      { type: 'tick', now: T0 + 40_000 + RELAY_TIMING.quietMs + 1 },
    );
    expect(settled.state.current).toBeNull();
    expect(settled.state.status).toBe('done');
    expect(of(settled.effects, 'closeTab')).toEqual([]);
  });

  it('only asks the user about a missing handoff after a long silence', () => {
    const { state } = codex();
    const short = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'idle', now: T0 + 6_000 },
      { type: 'tick', now: T0 + 6_000 + RELAY_TIMING.quietMs + 1 },
    );
    expect(short.state.current?.phase).toBe('executing');
    const long = feed(short.state, {
      type: 'tick',
      now: T0 + 6_000 + RELAY_TIMING.staleIdleMs + 1,
    });
    expect(long.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'stale-handoff' },
    });
  });
});

describe('outcomes', () => {
  function finish(state: RelayState, meta: HandoffMeta, at = T0 + 5_000) {
    return feed(
      state,
      {
        type: 'agentStatus',
        tabId: state.current?.tabId ?? '',
        status: 'working',
        now: at - 1_000,
      },
      { type: 'handoffChanged', taskId: state.current?.taskId ?? '', handoff: meta, now: at },
      { type: 'agentStatus', tabId: state.current?.tabId ?? '', status: 'done', now: at + 500 },
    );
  }

  it('starts a fresh leg of the same task on continue', () => {
    const { state } = running();
    const next = finish(state, handoff({ outcome: 'continue', hash: 'a' }));
    expect(next.state.current).toMatchObject({
      taskId: 'T001',
      legNo: 2,
      phase: 'launching',
      continuation: true,
    });
    expect(of(next.effects, 'launch')[0]).toMatchObject({ legNo: 2, continuation: true });
    expect(of(next.effects, 'closeTab')).toEqual([{ type: 'closeTab', tabId: 'tab-1' }]);
    expect(of(next.effects, 'setTaskStatus')).toEqual([]);
  });

  it('keeps the first leg plan-first and runs continuations straight', () => {
    const { state } = running(relay({ relayOptions: { planFirst: true } }));
    expect(state.current?.phase).toBe('planning');
    const approved = feed(state, { type: 'planApproved', tabId: 'tab-1', mode: 'auto' });
    const next = finish(approved.state, handoff({ outcome: 'continue' }));
    expect(of(next.effects, 'launch')[0]).toMatchObject({ legNo: 2, planFirst: false });
  });

  it('pauses when two continue handoffs in a row say the same thing', () => {
    let { state } = running();
    state = finish(state, handoff({ outcome: 'continue', hash: 'same' })).state;
    const launch = state.current!;
    state = feed(state, {
      type: 'launched',
      legId: launch.legId,
      tabId: 'tab-2',
      handoffMtimeAtStart: T0 + 5_000,
      now: T0 + 10_000,
    }).state;
    const stuck = finish(
      state,
      handoff({ outcome: 'continue', hash: 'same', mtimeMs: T0 + 20_000 }),
      T0 + 20_000,
    );
    expect(stuck.state.status).toBe('paused');
    expect(stuck.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'no-progress' },
    });
    expect(of(stuck.effects, 'launch')).toEqual([]);
  });

  it('stops starting legs for a task at the cap', () => {
    let { state } = running(relay({ relayOptions: { maxLegsPerTask: 2 } }));
    state = finish(state, handoff({ outcome: 'continue', hash: 'a' })).state;
    state = feed(state, {
      type: 'launched',
      legId: state.current!.legId,
      tabId: 'tab-2',
      handoffMtimeAtStart: T0 + 5_000,
      now: T0 + 10_000,
    }).state;
    const capped = finish(
      state,
      handoff({ outcome: 'continue', hash: 'b', mtimeMs: T0 + 20_000 }),
      T0 + 20_000,
    );
    expect(capped.state.status).toBe('paused');
    expect(capped.state.current?.awaiting?.reason).toBe('leg-cap');
  });

  it('marks a blocked task, pauses and quotes its question', () => {
    const { state } = running();
    const next = finish(state, handoff({ outcome: 'blocked', next: 'Postgres or SQLite?' }));
    expect(of(next.effects, 'setTaskStatus')).toContainEqual({
      type: 'setTaskStatus',
      taskId: 'T001',
      status: 'blocked',
    });
    expect(next.state.status).toBe('paused');
    expect(of(next.effects, 'notify')[0].body).toContain('Postgres or SQLite?');
    expect(of(next.effects, 'closeTab')).toEqual([]);
  });

  it('sends a done task with failing tests to testing and pauses', () => {
    const { state } = running();
    const next = finish(state, handoff({ outcome: 'done', tests: 'failed' }));
    expect(of(next.effects, 'setTaskStatus')).toContainEqual({
      type: 'setTaskStatus',
      taskId: 'T001',
      status: 'testing',
    });
    expect(next.state.status).toBe('paused');
  });

  it('carries on past a stuck task when told to, skipping what depends on it', () => {
    const tasks = [snapshot('T001'), snapshot('T002', { depends: ['T001'] }), snapshot('T003')];
    const { state } = running(relay({ tasks, relayOptions: { whenStuck: 'continue' } }));
    const next = finish(state, handoff({ outcome: 'blocked' }));
    expect(next.state.status).toBe('running');
    expect(next.state.current?.taskId).toBe('T003');
    expect(next.state.finished).toContainEqual(
      expect.objectContaining({ taskId: 'T002', result: 'skipped' }),
    );
  });

  it('finishes the relay after the last task', () => {
    const { state } = running(relay({ tasks: [snapshot('T001')] }));
    const next = finish(state, handoff());
    expect(next.state.status).toBe('done');
    expect(next.state.current).toBeNull();
    expect(of(next.effects, 'notify').at(-1)?.title).toMatch(/finished/i);
  });
});

describe('plan first', () => {
  const planFirst = () => running(relay({ relayOptions: { planFirst: true } }));

  it('moves on to executing when the gate approves the plan', () => {
    const { state } = planFirst();
    const next = feed(state, { type: 'planApproved', tabId: 'tab-1', mode: 'auto' });
    expect(next.state.current?.phase).toBe('executing');
  });

  it('moves on when the user approves the plan by hand', () => {
    const { state } = planFirst();
    const next = feed(state, { type: 'modeObserved', tabId: 'tab-1', mode: 'acceptEdits' });
    expect(next.state.current?.phase).toBe('executing');
  });

  it('picks the menu option itself when the hook could not approve', () => {
    const { state } = planFirst();
    const next = feed(
      state,
      { type: 'planPresented', tabId: 'tab-1', approvable: true },
      { type: 'agentStatus', tabId: 'tab-1', status: 'needs-input', now: T0 + 5_000 },
    );
    expect(of(next.effects, 'approvePlanMenu')).toEqual([
      { type: 'approvePlanMenu', tabId: 'tab-1', mode: 'auto' },
    ]);
    expect(of(next.effects, 'notify')).toEqual([]);
  });

  it('leaves a plan that asked questions to the user', () => {
    const { state } = planFirst();
    const next = feed(
      state,
      { type: 'hookQuestion', tabId: 'tab-1' },
      { type: 'planPresented', tabId: 'tab-1', approvable: false },
      { type: 'agentStatus', tabId: 'tab-1', status: 'needs-input', now: T0 + 5_000 },
    );
    expect(of(next.effects, 'approvePlanMenu')).toEqual([]);
    expect(next.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'plan-review' },
    });
    const approved = feed(next.state, { type: 'modeObserved', tabId: 'tab-1', mode: 'auto' });
    expect(approved.state.current?.phase).toBe('executing');
  });

  it('warns once when the session lands in another mode than chosen', () => {
    const { state } = planFirst();
    const next = feed(
      state,
      { type: 'planApproved', tabId: 'tab-1', mode: 'auto' },
      { type: 'modeObserved', tabId: 'tab-1', mode: 'default' },
      { type: 'modeObserved', tabId: 'tab-1', mode: 'default' },
    );
    expect(of(next.effects, 'notify')).toHaveLength(1);
  });

  it('asks for review when a CLI without hooks finishes planning', () => {
    const { state } = running(relay({ cliId: 'gemini-cli', relayOptions: { planFirst: true } }));
    expect(state.current?.phase).toBe('planning');
    const next = feed(
      state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 9_000 },
      { type: 'tick', now: T0 + 9_000 + RELAY_TIMING.quietMs + 1 },
    );
    expect(next.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'plan-review' },
    });
    const working = feed(next.state, {
      type: 'agentStatus',
      tabId: 'tab-1',
      status: 'working',
      now: T0 + 60_000,
    });
    expect(working.state.current?.phase).toBe('executing');
  });

  it('never plans first on a CLI that has no plan mode', () => {
    const { effects } = feed(relay({ cliId: 'codex-cli', relayOptions: { planFirst: true } }), {
      type: 'start',
      now: T0,
    });
    expect(of(effects, 'launch')[0].planFirst).toBe(false);
  });
});

describe('a session that never reports in', () => {
  it('asks the user to look at the tab when hooks stay silent after launch', () => {
    const { state } = running();
    const early = feed(state, { type: 'tick', now: T0 + RELAY_TIMING.startWatchMs - 1 });
    expect(early.state.current?.phase).toBe('executing');

    const late = feed(state, { type: 'tick', now: T0 + RELAY_TIMING.startWatchMs + 1 });
    expect(late.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'not-started' },
    });
    expect(of(late.effects, 'notify')[0].body).toMatch(/trust/i);

    const started = feed(late.state, { type: 'sessionStarted', tabId: 'tab-1' });
    expect(started.state.current).toMatchObject({ phase: 'executing', awaiting: null });
  });

  it('counts the session as started once it reports', () => {
    const { state } = running();
    const next = feed(
      state,
      { type: 'sessionStarted', tabId: 'tab-1' },
      { type: 'tick', now: T0 + RELAY_TIMING.startWatchMs + 1 },
    );
    expect(next.state.current?.phase).toBe('executing');
  });

  it('does not watch a CLI that has no hooks', () => {
    const { state } = running(relay({ cliId: 'codex-cli' }));
    const next = feed(state, { type: 'tick', now: T0 + RELAY_TIMING.startWatchMs + 1 });
    expect(next.state.current?.phase).toBe('executing');
  });
});

describe('the user in the loop', () => {
  it('waits on a question and picks up when the agent works again', () => {
    const { state } = running();
    const asked = feed(state, {
      type: 'agentStatus',
      tabId: 'tab-1',
      status: 'needs-input',
      now: T0 + 1_000,
    });
    expect(asked.state.current).toMatchObject({
      phase: 'awaiting-user',
      awaiting: { reason: 'needs-input' },
    });
    const back = feed(asked.state, {
      type: 'agentStatus',
      tabId: 'tab-1',
      status: 'working',
      now: T0 + 2_000,
    });
    expect(back.state.current?.phase).toBe('executing');
  });

  it('pauses after the current leg and resumes with the next task', () => {
    const { state } = running();
    const paused = feed(
      state,
      { type: 'pause' },
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(paused.state.status).toBe('paused');
    expect(paused.state.current).toBeNull();
    expect(of(paused.effects, 'launch')).toEqual([]);
    const resumed = feed(paused.state, { type: 'resume', now: T0 + 10_000 });
    expect(resumed.state.status).toBe('running');
    expect(of(resumed.effects, 'launch')[0].taskId).toBe('T002');
  });

  it('resumes a leg that stopped without a handoff with a continuation', () => {
    const { state } = running();
    const ended = feed(state, { type: 'ptyExited', tabId: 'tab-1', code: 0, hostLost: false });
    expect(ended.state.status).toBe('paused');
    expect(ended.state.current?.phase).toBe('interrupted');
    const resumed = feed(ended.state, { type: 'resume', now: T0 + 10_000 });
    expect(of(resumed.effects, 'launch')[0]).toMatchObject({
      taskId: 'T001',
      legNo: 2,
      continuation: true,
    });
  });

  it('applies a fresh handoff found on resume instead of starting again', () => {
    const { state } = running();
    let next = feed(state, { type: 'ptyExited', tabId: 'tab-1', code: 1, hostLost: false }).state;
    expect(next.current?.phase).toBe('failed');
    next = feed(next, {
      type: 'handoffChanged',
      taskId: 'T001',
      handoff: handoff(),
      now: T0 + 9_000,
    }).state;
    const resumed = feed(next, { type: 'resume', now: T0 + 10_000 });
    expect(of(resumed.effects, 'setTaskStatus')).toContainEqual(
      expect.objectContaining({ taskId: 'T001', status: 'done' }),
    );
    expect(resumed.state.current?.taskId).toBe('T002');
  });

  it('applies the outcome when the session exits right after a fresh handoff', () => {
    const { state } = running();
    const next = feed(
      state,
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'ptyExited', tabId: 'tab-1', code: 0, hostLost: false },
    );
    expect(next.state.current?.taskId).toBe('T002');
  });

  it('marks a leg interrupted when the terminal host goes away', () => {
    const { state } = running();
    const next = feed(state, { type: 'ptyExited', tabId: 'tab-1', code: 1, hostLost: true });
    expect(next.state.current?.phase).toBe('interrupted');
    expect(next.state.status).toBe('paused');
  });

  it('never launches anything after a restart', () => {
    const { state } = running();
    const alive = feed(state, { type: 'appRestarted', liveTabs: ['tab-1'] });
    expect(alive.effects.filter((effect) => effect.type === 'launch')).toEqual([]);
    expect(alive.state.current).toMatchObject({ phase: 'executing', agent: 'unknown' });

    const dead = feed(state, { type: 'appRestarted', liveTabs: [] });
    expect(dead.effects.filter((effect) => effect.type === 'launch')).toEqual([]);
    expect(dead.state.current?.phase).toBe('interrupted');
    expect(dead.state.status).toBe('paused');

    const sizing = feed(relay({ autoSize: true }), { type: 'start', now: T0 }).state;
    const restarted = feed(sizing, { type: 'appRestarted', liveTabs: [] });
    expect(restarted.state.current?.phase).toBe('interrupted');
  });

  it('cancels without touching tabs or task files, and ignores what follows', () => {
    const { state } = running();
    const cancelled = feed(
      state,
      { type: 'cancel' },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(cancelled.state.status).toBe('cancelled');
    expect(cancelled.effects).toEqual([]);
  });

  it('completes the current task when the user marks it done', () => {
    const { state } = running();
    const next = feed(state, { type: 'userMarkedDone', taskId: 'T001', now: T0 + 1_000 });
    expect(of(next.effects, 'setTaskStatus')).toContainEqual(
      expect.objectContaining({ taskId: 'T001', status: 'done' }),
    );
    expect(of(next.effects, 'closeTab')).toEqual([]);
    expect(next.state.current?.taskId).toBe('T002');
  });
});

describe('the task files change underneath', () => {
  it('drops a queued task that was deleted or moved to done', () => {
    const tasks = [snapshot('T001'), snapshot('T002'), snapshot('T003')];
    const { state } = running(relay({ tasks }));
    const next = feed(state, {
      type: 'taskFilesChanged',
      tasks: [snapshot('T001', { status: 'in-progress' }), snapshot('T003', { status: 'done' })],
    });
    expect(next.state.queue).toEqual([]);
  });

  it('keeps a blocked task the user queued by name', () => {
    const tasks = [snapshot('T001'), snapshot('T002', { status: 'blocked' })];
    const { state } = running(relay({ tasks }));
    const next = feed(state, {
      type: 'taskFilesChanged',
      tasks: [snapshot('T001', { status: 'in-progress' }), snapshot('T002', { status: 'blocked' })],
    });
    expect(next.state.queue).toEqual(['T002']);
  });

  it('writes no status for a running task whose file was deleted', () => {
    const { state } = running(relay({ tasks: [snapshot('T001')] }));
    const next = feed(
      state,
      { type: 'taskFilesChanged', tasks: [] },
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(of(next.effects, 'setTaskStatus')).toEqual([]);
    expect(next.state.status).toBe('done');
  });

  it('skips a task whose dependency is not done', () => {
    const tasks = [
      snapshot('T001', { status: 'testing' }),
      snapshot('T002', { depends: ['T001'] }),
    ];
    const { state, effects } = feed(relay({ tasks, queue: ['T002'] }), { type: 'start', now: T0 });
    expect(of(effects, 'launch')).toEqual([]);
    expect(state.finished).toEqual([
      expect.objectContaining({
        taskId: 'T002',
        result: 'skipped',
        note: expect.stringContaining('T001'),
      }),
    ]);
    expect(state.status).toBe('done');
  });
});

describe('joining a live relay', () => {
  it('queues new tasks after the ones already waiting', () => {
    const { state } = running();
    const next = feed(state, {
      type: 'extend',
      tasks: [snapshot('T001'), snapshot('T002'), snapshot('T003', { depends: ['T002'] })],
      taskIds: ['T003'],
    });
    expect(next.state.queue).toEqual(['T002', 'T003']);
    expect(next.state.tasks.T003).toEqual(snapshot('T003', { depends: ['T002'] }));
    expect(next.effects).toEqual([]);
  });

  it('skips tasks it already runs, has queued or has finished', () => {
    const { state } = running();
    const next = feed(state, {
      type: 'extend',
      tasks: [snapshot('T001'), snapshot('T002'), snapshot('T004')],
      taskIds: ['T001', 'T002', 'T004', 'T004'],
    });
    expect(next.state.queue).toEqual(['T002', 'T004']);
  });

  it('runs a joined task once the earlier ones are done', () => {
    const { state } = running(relay({ tasks: [snapshot('T001')] }));
    const joined = feed(state, {
      type: 'extend',
      tasks: [snapshot('T001'), snapshot('T005')],
      taskIds: ['T005'],
    });
    const next = feed(
      joined.state,
      { type: 'agentStatus', tabId: 'tab-1', status: 'working', now: T0 + 1_000 },
      { type: 'handoffChanged', taskId: 'T001', handoff: handoff(), now: T0 + 5_000 },
      { type: 'agentStatus', tabId: 'tab-1', status: 'done', now: T0 + 6_000 },
    );
    expect(of(next.effects, 'launch').map((effect) => effect.taskId)).toEqual(['T005']);
  });

  it('leaves a relay that is over alone', () => {
    const { state } = feed(running().state, { type: 'cancel' });
    const next = feed(state, {
      type: 'extend',
      tasks: [snapshot('T003')],
      taskIds: ['T003'],
    });
    expect(next.state).toBe(state);
  });
});

describe('the context guard', () => {
  it('arms once the context passes the guard share of the budget', () => {
    const { state } = running();
    const below = feed(state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 100_000,
      window: null,
    });
    expect(of(below.effects, 'armGuard')).toEqual([]);
    expect(below.state.current?.contextTokens).toBe(100_000);

    const above = feed(below.state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 165_000,
      window: null,
    });
    expect(of(above.effects, 'armGuard')).toEqual([
      { type: 'armGuard', tabId: 'tab-1', armed: true },
    ]);
    const again = feed(above.state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 170_000,
      window: null,
    });
    expect(of(again.effects, 'armGuard')).toEqual([]);

    const sent = feed(again.state, { type: 'guardSent', tabId: 'tab-1' });
    expect(of(sent.effects, 'armGuard')).toEqual([
      { type: 'armGuard', tabId: 'tab-1', armed: false },
    ]);
    expect(sent.state.current?.peakContextTokens).toBe(170_000);
  });

  it('turns the guard off for a leg that starts past it, and says the budget is too small', () => {
    // A fresh Claude Code session already holds about 50K (system prompt, tools, user config), so
    // a 30K budget would roll the task over into new sessions that start just as full.
    const tasks = [snapshot('T001', { budget: 30_000 })];
    const { state } = running(relay({ tasks }));
    const first = feed(state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 51_000,
      window: null,
    });
    expect(of(first.effects, 'armGuard')).toEqual([]);
    expect(of(first.effects, 'notify')).toEqual([
      expect.objectContaining({
        title: expect.stringContaining('T001'),
        body: expect.stringMatching(/30K.*51K/),
      }),
    ]);
    const later = feed(first.state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 90_000,
      window: null,
    });
    expect(of(later.effects, 'armGuard')).toEqual([]);
    expect(of(later.effects, 'notify')).toEqual([]);
  });

  it('never arms for a CLI without hooks', () => {
    const { state } = running(relay({ cliId: 'codex-cli' }));
    const next = feed(state, {
      type: 'contextUsage',
      tabId: 'tab-1',
      tokens: 190_000,
      window: null,
    });
    expect(of(next.effects, 'armGuard')).toEqual([]);
  });
});
