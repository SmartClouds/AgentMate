import type { AgentStatus } from '../workspace/agentStatus.js';
import { type RelayAfterPlanMode, relayCapabilities } from './capabilities.js';
import { formatTokenCount, handoffRelPath } from './format.js';
import { guardThreshold, isHandoffFresh, type LegPhase, type RelayPermissionMode } from './gate.js';
import { unmetDependencies } from './graph.js';
import type { RelayTrigger } from './schedule.js';
import type { RelayOutcome, RelayTaskStatus, RelayTestResult } from './types.js';

/** The CLI, model and effort a leg runs with. `autoSize` asks for a sizing pass first. */
export interface RelayRunChoice {
  cliId: string;
  model: string | null;
  effort: string | null;
  autoSize: boolean;
}

export interface RelayTaskOverride {
  cliId?: string;
  model?: string | null;
  effort?: string | null;
  autoSize?: boolean;
  planFirst?: boolean;
}

export interface RelayOptions {
  /** Start each task's first session in plan mode. */
  planFirst: boolean;
  afterPlanMode: RelayAfterPlanMode;
  /** Sessions one task may take before the relay stops and asks. */
  maxLegsPerTask: number;
  /** Share of the budget at which a leg is told to hand off. */
  guardShare: number;
  /** After a blocked task or failing tests: stop, or carry on with the tasks that do not need it. */
  whenStuck: 'pause' | 'continue';
  commitPerTask: boolean;
  closeFinishedTabs: boolean;
  defaultBudget: number;
}

export const DEFAULT_RELAY_OPTIONS: RelayOptions = {
  planFirst: false,
  afterPlanMode: 'auto',
  maxLegsPerTask: 6,
  guardShare: 0.8,
  whenStuck: 'pause',
  commitPerTask: true,
  closeFinishedTabs: true,
  defaultBudget: 200_000,
};

export const RELAY_TIMING = {
  /** A leg whose tab has not come up by now is retried once, then failed. */
  launchTimeoutMs: 60_000,
  /** After a CLI with hooks stops, how long its handoff may take to land. */
  stopGraceMs: 30_000,
  /** How long a CLI without hooks must stay quiet before its silence counts as stopped. */
  quietMs: 20_000,
  /** How long such a CLI may sit quiet without a handoff before the user is asked. */
  staleIdleMs: 120_000,
  /**
   * How long a CLI with hooks may run without its first hook before the user is asked. Claude Code
   * asks whether to trust a folder it has never opened before the session starts, and that
   * question defaults to exit.
   */
  startWatchMs: 45_000,
} as const;

/** What the relay needs to know about a task, refreshed whenever the files change. */
export interface RelayTaskSnapshot {
  id: string;
  status: RelayTaskStatus;
  depends: string[];
  budget: number | null;
}

/** A handoff the driver read from disk, reduced to what decides the next step. */
export interface HandoffMeta {
  mtimeMs: number;
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  /** The Next step section, quoted when the task is blocked. */
  next: string;
  /** A hash of the handoff body, to spot a session that made no progress. */
  hash: string;
}

export type AwaitReason =
  | 'needs-input'
  | 'question'
  | 'plan-review'
  | 'stale-handoff'
  | 'bad-handoff'
  | 'no-progress'
  | 'leg-cap'
  | 'not-started';

export interface RelayLeg {
  legId: string;
  taskId: string;
  legNo: number;
  attempt: number;
  tabId: string | null;
  phase: LegPhase;
  startedAt: number;
  choice: RelayRunChoice;
  planFirst: boolean;
  /** The CLI reports when its turn ends (hooks), so a stop is a stop. */
  exact: boolean;
  continuation: boolean;
  budget: number;
  handoffMtimeAtStart: number | null;
  everWorked: boolean;
  agent: AgentStatus | 'unknown';
  stoppedAt: number | null;
  quietSince: number | null;
  handoff: HandoffMeta | null;
  openQuestions: number;
  planShown: boolean;
  planPending: boolean;
  planDone: boolean;
  expectedMode: RelayAfterPlanMode | null;
  contextTokens: number | null;
  peakContextTokens: number | null;
  window: number | null;
  guardArmed: boolean;
  guardSent: boolean;
  stopBlocks: number;
  /** A hook from this session arrived, so the CLI is past its start-up questions. */
  sessionSeen: boolean;
  taskGone: boolean;
  awaiting: { reason: AwaitReason; message: string } | null;
}

export type RelayResult = 'done' | 'testing' | 'blocked' | 'skipped' | 'failed';

export interface RelayFinished {
  taskId: string;
  result: RelayResult;
  note?: string;
  at: number;
}

export interface RelayState {
  id: string;
  projectId: string;
  docsFolder: string;
  status: 'waiting' | 'running' | 'paused' | 'done' | 'cancelled';
  trigger: RelayTrigger;
  options: RelayOptions;
  defaults: RelayRunChoice;
  overrides: Record<string, RelayTaskOverride>;
  tasks: Record<string, RelayTaskSnapshot>;
  /** Tasks still to run, not counting the current one. */
  queue: string[];
  finished: RelayFinished[];
  /** Legs started per task. */
  legsByTask: Record<string, number>;
  lastContinueHash: Record<string, string>;
  current: RelayLeg | null;
  pauseReason: string | null;
  started: boolean;
  createdAt: number;
}

export interface RelayLegRecord {
  legId: string;
  relayId: string;
  taskId: string;
  legNo: number;
  cliId: string;
  model: string | null;
  effort: string | null;
  tabId: string | null;
  startedAt: number;
  endedAt: number;
  outcome: RelayOutcome | null;
  tests: RelayTestResult | null;
  result: 'done' | 'continue' | 'blocked' | 'testing' | 'failed' | 'interrupted' | 'marked-done';
  peakContextTokens: number | null;
}

export type RelayEvent =
  | { type: 'start'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'sized'; legId: string; choice: Omit<RelayRunChoice, 'autoSize'> }
  | { type: 'sizeFailed'; legId: string }
  | {
      type: 'launched';
      legId: string;
      tabId: string;
      handoffMtimeAtStart: number | null;
      now: number;
      /** False when the hooks could not be installed, so the leg falls back to quiet detection. */
      hooks?: boolean;
    }
  | { type: 'launchFailed'; legId: string; error: string }
  | { type: 'agentStatus'; tabId: string; status: AgentStatus; now: number }
  | { type: 'promptSubmitted'; tabId: string }
  /** The CLI's SessionStart hook: it got past any start-up question. */
  | { type: 'sessionStarted'; tabId: string }
  | { type: 'hookQuestion'; tabId: string }
  | { type: 'questionAnswered'; tabId: string }
  | { type: 'planPresented'; tabId: string; approvable: boolean }
  | { type: 'planApproved'; tabId: string; mode: RelayAfterPlanMode }
  | { type: 'modeObserved'; tabId: string; mode: RelayPermissionMode }
  | { type: 'stopBlocked'; tabId: string }
  | { type: 'guardSent'; tabId: string }
  | { type: 'handoffChanged'; taskId: string; handoff: HandoffMeta; now: number }
  /** An MCP `finish_leg` call. Main checked the handoff first, so it stands for a fresh one. */
  | { type: 'legReported'; tabId: string; handoff: HandoffMeta; now: number }
  | { type: 'contextUsage'; tabId: string; tokens: number; window: number | null }
  | { type: 'ptyExited'; tabId: string; code: number; hostLost: boolean }
  | { type: 'appRestarted'; liveTabs: string[] }
  | { type: 'pause' }
  | { type: 'resume'; now: number }
  | { type: 'cancel' }
  | { type: 'userMarkedDone'; taskId: string; now: number }
  | { type: 'taskFilesChanged'; tasks: RelayTaskSnapshot[] }
  /**
   * More tasks join the end of the queue, for a start asked of a project whose relay is live (a
   * split scheduled after one of its tasks). `tasks` is the board as it is now.
   */
  | { type: 'extend'; tasks: RelayTaskSnapshot[]; taskIds: string[] };

export interface RelayNotice {
  level: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  taskId?: string;
}

export type RelayEffect =
  | { type: 'assess'; legId: string; taskId: string; choice: RelayRunChoice }
  | {
      type: 'launch';
      legId: string;
      taskId: string;
      legNo: number;
      continuation: boolean;
      planFirst: boolean;
      budget: number;
      choice: RelayRunChoice;
    }
  | { type: 'setTaskStatus'; taskId: string; status: RelayTaskStatus }
  | { type: 'closeTab'; tabId: string }
  | { type: 'armGuard'; tabId: string; armed: boolean }
  /** Pick the plan menu's option for this mode by keystrokes (when no hook approved the plan). */
  | { type: 'approvePlanMenu'; tabId: string; mode: RelayAfterPlanMode }
  | { type: 'recordLeg'; record: RelayLegRecord }
  | ({ type: 'notify' } & RelayNotice);

export interface CreateRelayInput {
  id: string;
  projectId: string;
  docsFolder: string;
  now: number;
  tasks: RelayTaskSnapshot[];
  queue: string[];
  trigger: RelayTrigger;
  defaults: RelayRunChoice;
  overrides: Record<string, RelayTaskOverride>;
  options: RelayOptions;
}

export function createRelay(input: CreateRelayInput): RelayState {
  return {
    id: input.id,
    projectId: input.projectId,
    docsFolder: input.docsFolder,
    status: 'waiting',
    trigger: input.trigger,
    options: input.options,
    defaults: input.defaults,
    overrides: input.overrides,
    tasks: Object.fromEntries(input.tasks.map((task) => [task.id, task])),
    queue: [...input.queue],
    finished: [],
    legsByTask: {},
    lastContinueHash: {},
    current: null,
    pauseReason: null,
    started: false,
    createdAt: input.now,
  };
}

/** Collects effects while a reduction runs, so the helpers below can stay small. */
interface Step {
  state: RelayState;
  effects: RelayEffect[];
}

function patchLeg(step: Step, patch: Partial<RelayLeg>): void {
  if (step.state.current)
    step.state = { ...step.state, current: { ...step.state.current, ...patch } };
}

function notify(step: Step, notice: RelayNotice): void {
  step.effects.push({ type: 'notify', ...notice });
}

function setStatus(step: Step, taskId: string, status: RelayTaskStatus, gone = false): void {
  const task = step.state.tasks[taskId];
  if (!gone && task) step.effects.push({ type: 'setTaskStatus', taskId, status });
  if (task)
    step.state = { ...step.state, tasks: { ...step.state.tasks, [taskId]: { ...task, status } } };
}

function choiceFor(state: RelayState, taskId: string): RelayRunChoice {
  const { planFirst: _planFirst, ...override } = state.overrides[taskId] ?? {};
  return { ...state.defaults, ...override };
}

function legIdFor(state: RelayState, taskId: string, legNo: number, attempt: number): string {
  return `${state.id}-${taskId}-${legNo}-${attempt}`;
}

function launchEffect(leg: RelayLeg): RelayEffect {
  return {
    type: 'launch',
    legId: leg.legId,
    taskId: leg.taskId,
    legNo: leg.legNo,
    continuation: leg.continuation,
    planFirst: leg.planFirst,
    budget: leg.budget,
    choice: leg.choice,
  };
}

/** Starts a leg of a task: a sizing pass first when the choice asks for one, else the launch. */
function startLeg(step: Step, taskId: string, now: number, continueFrom?: RelayLeg): void {
  const state = step.state;
  const legNo = (state.legsByTask[taskId] ?? 0) + 1;
  const choice = continueFrom
    ? { ...continueFrom.choice, autoSize: false }
    : choiceFor(state, taskId);
  const caps = relayCapabilities(choice.cliId);
  const wantsPlan = state.overrides[taskId]?.planFirst ?? state.options.planFirst;
  const sizing = choice.autoSize && !continueFrom;
  const leg: RelayLeg = {
    legId: legIdFor(state, taskId, legNo, 1),
    taskId,
    legNo,
    attempt: 1,
    tabId: null,
    phase: sizing ? 'sizing' : 'launching',
    startedAt: now,
    choice,
    planFirst: wantsPlan && caps.planMode && legNo === 1,
    exact: caps.completion === 'exact',
    continuation: Boolean(continueFrom),
    budget: state.tasks[taskId]?.budget ?? state.options.defaultBudget,
    handoffMtimeAtStart: null,
    everWorked: false,
    agent: 'unknown',
    stoppedAt: null,
    quietSince: null,
    handoff: null,
    openQuestions: 0,
    planShown: false,
    planPending: false,
    planDone: false,
    expectedMode: null,
    contextTokens: null,
    peakContextTokens: null,
    window: null,
    guardArmed: false,
    guardSent: false,
    stopBlocks: 0,
    sessionSeen: false,
    taskGone: false,
    awaiting: null,
  };
  step.state = {
    ...state,
    current: leg,
    legsByTask: { ...state.legsByTask, [taskId]: legNo },
  };
  step.effects.push(
    sizing ? { type: 'assess', legId: leg.legId, taskId, choice } : launchEffect(leg),
  );
}

function statusMap(state: RelayState): Map<string, RelayTaskStatus> {
  return new Map(Object.values(state.tasks).map((task) => [task.id, task.status]));
}

function summary(state: RelayState): RelayNotice {
  const done = state.finished.filter((item) => item.result === 'done').length;
  const attention = state.finished.length - done;
  return {
    level: attention > 0 ? 'warning' : 'info',
    title: 'Relay finished',
    body:
      attention > 0
        ? `${done} done, ${attention} need${attention === 1 ? 's' : ''} your attention.`
        : `${done} task${done === 1 ? '' : 's'} done.`,
  };
}

/** Takes the next runnable task off the queue, skipping what cannot run, or ends the relay. */
function advance(step: Step, now: number): void {
  step.state = { ...step.state, current: null };
  if (step.state.status !== 'running') return;
  const queue = [...step.state.queue];
  const finished = [...step.state.finished];
  while (queue.length > 0) {
    const taskId = queue.shift()!;
    const task = step.state.tasks[taskId];
    if (!task || task.status === 'done') continue;
    const unmet = unmetDependencies(task, statusMap(step.state));
    if (unmet.length > 0) {
      finished.push({ taskId, result: 'skipped', note: `Waits for ${unmet.join(', ')}.`, at: now });
      continue;
    }
    step.state = { ...step.state, queue, finished };
    startLeg(step, taskId, now);
    return;
  }
  step.state = { ...step.state, queue, finished, status: 'done' };
  notify(step, summary(step.state));
}

function record(step: Step, leg: RelayLeg, result: RelayLegRecord['result'], now: number): void {
  step.effects.push({
    type: 'recordLeg',
    record: {
      legId: leg.legId,
      relayId: step.state.id,
      taskId: leg.taskId,
      legNo: leg.legNo,
      cliId: leg.choice.cliId,
      model: leg.choice.model,
      effort: leg.choice.effort,
      tabId: leg.tabId,
      startedAt: leg.startedAt,
      endedAt: now,
      outcome: leg.handoff?.outcome ?? null,
      tests: leg.handoff?.tests ?? null,
      result,
      peakContextTokens: leg.peakContextTokens,
    },
  });
}

function pause(step: Step, reason: string): void {
  step.state = { ...step.state, status: 'paused', pauseReason: reason };
}

function await_(step: Step, reason: AwaitReason, message: string, notice?: RelayNotice): void {
  patchLeg(step, { phase: 'awaiting-user', awaiting: { reason, message } });
  if (notice) notify(step, notice);
}

function closeIfWanted(step: Step, leg: RelayLeg): void {
  if (step.state.options.closeFinishedTabs && leg.tabId) {
    step.effects.push({ type: 'closeTab', tabId: leg.tabId });
  }
}

/** A task that cannot go on: stop the relay, or carry on without it and what depends on it. */
function stuck(step: Step, now: number, reason: string): void {
  if (step.state.options.whenStuck === 'pause') {
    pause(step, reason);
    step.state = { ...step.state, current: null };
    return;
  }
  advance(step, now);
}

/** Applies a finished leg's handoff: done, a fresh leg, or a stop for the user. */
function completeLeg(step: Step, now: number): void {
  const leg = step.state.current!;
  const handoff = leg.handoff!;
  const { taskId } = leg;

  if (handoff.outcome === 'continue') {
    const legs = step.state.legsByTask[taskId] ?? leg.legNo;
    if (step.state.lastContinueHash[taskId] === handoff.hash) {
      await_(step, 'no-progress', 'Two sessions in a row left the same handoff.', {
        level: 'warning',
        title: `${taskId} is not moving`,
        body: 'Two sessions in a row left the same handoff, so the relay paused. Check the tab.',
        taskId,
      });
      pause(step, `${taskId} made no progress.`);
      return;
    }
    if (legs >= step.state.options.maxLegsPerTask) {
      await_(step, 'leg-cap', `${taskId} used all ${legs} sessions it may take.`, {
        level: 'warning',
        title: `${taskId} needs more sessions`,
        body: `It has taken ${legs} sessions without finishing, so the relay paused. Resume to give it another one.`,
        taskId,
      });
      pause(step, `${taskId} reached its session limit.`);
      return;
    }
    record(step, leg, 'continue', now);
    closeIfWanted(step, leg);
    step.state = {
      ...step.state,
      lastContinueHash: { ...step.state.lastContinueHash, [taskId]: handoff.hash },
    };
    if (step.state.status !== 'running') {
      step.state = { ...step.state, current: null, queue: [taskId, ...step.state.queue] };
      return;
    }
    startLeg(step, taskId, now, leg);
    return;
  }

  if (handoff.outcome === 'blocked') {
    record(step, leg, 'blocked', now);
    setStatus(step, taskId, 'blocked', leg.taskGone);
    step.state = {
      ...step.state,
      finished: [
        ...step.state.finished,
        { taskId, result: 'blocked', note: handoff.next, at: now },
      ],
    };
    notify(step, {
      level: 'warning',
      title: `${taskId} is blocked`,
      body: handoff.next || 'The session needs your answer. Its handoff has the details.',
      taskId,
    });
    stuck(step, now, `${taskId} is blocked.`);
    return;
  }

  if (handoff.tests === 'failed') {
    record(step, leg, 'testing', now);
    setStatus(step, taskId, 'testing', leg.taskGone);
    step.state = {
      ...step.state,
      finished: [
        ...step.state.finished,
        { taskId, result: 'testing', note: 'Tests fail.', at: now },
      ],
    };
    notify(step, {
      level: 'warning',
      title: `${taskId} is done but its tests fail`,
      body: 'It moved to Testing. Its handoff says what fails.',
      taskId,
    });
    stuck(step, now, `${taskId} has failing tests.`);
    return;
  }

  record(step, leg, 'done', now);
  setStatus(step, taskId, 'done', leg.taskGone);
  closeIfWanted(step, leg);
  step.state = {
    ...step.state,
    finished: [...step.state.finished, { taskId, result: 'done', at: now }],
  };
  advance(step, now);
}

function isStopped(leg: RelayLeg, now: number): boolean {
  if (leg.exact) return leg.stoppedAt !== null;
  return leg.quietSince !== null && now - leg.quietSince >= RELAY_TIMING.quietMs;
}

const SETTLED_PHASES: readonly LegPhase[] = ['planning', 'executing', 'finishing', 'awaiting-user'];

/** Finishes the leg once it has a fresh handoff and the agent has stopped, in either order. */
function checkCompletion(step: Step, now: number): void {
  const leg = step.state.current;
  if (!leg || !SETTLED_PHASES.includes(leg.phase) || !leg.handoff) return;
  if (!isStopped(leg, now)) return;
  if (leg.handoff.outcome === null) {
    if (leg.awaiting?.reason !== 'bad-handoff') {
      await_(step, 'bad-handoff', 'The handoff has no outcome.', {
        level: 'warning',
        title: `${leg.taskId} left a handoff the relay cannot read`,
        body: 'Its outcome is missing or unknown. Ask the session to set outcome to done, continue or blocked.',
        taskId: leg.taskId,
      });
    }
    return;
  }
  completeLeg(step, now);
}

function staleNotice(leg: RelayLeg, docsFolder: string): RelayNotice {
  return {
    level: 'warning',
    title: `${leg.taskId} stopped without a handoff`,
    body: `The session did not update ${handoffRelPath(docsFolder, leg.taskId)}. Ask it to, or mark the task done.`,
    taskId: leg.taskId,
  };
}

function planReviewNotice(leg: RelayLeg): RelayNotice {
  return {
    level: 'info',
    title: `The plan for ${leg.taskId} is ready`,
    body: 'Review it in its tab and approve it to let the session start.',
    taskId: leg.taskId,
  };
}

function onTick(step: Step, now: number): void {
  const leg = step.state.current;
  if (!leg || step.state.status === 'cancelled') return;

  if (leg.phase === 'launching' && now - leg.startedAt > RELAY_TIMING.launchTimeoutMs) {
    onLaunchFailed(step, 'The session did not start in time.', now);
    return;
  }
  checkCompletion(step, now);
  const after = step.state.current;
  if (!after || after !== leg) return;

  if (leg.exact) {
    if (
      !leg.sessionSeen &&
      (leg.phase === 'planning' || leg.phase === 'executing') &&
      now - leg.startedAt > RELAY_TIMING.startWatchMs
    ) {
      await_(step, 'not-started', 'The session has not started.', {
        level: 'warning',
        title: `The session for ${leg.taskId} has not started`,
        body: 'Check its tab. The CLI may be asking whether to trust this folder.',
        taskId: leg.taskId,
      });
      return;
    }
    if (
      leg.phase === 'finishing' &&
      leg.stoppedAt !== null &&
      now - leg.stoppedAt > RELAY_TIMING.stopGraceMs
    ) {
      await_(
        step,
        'stale-handoff',
        'The session stopped without a handoff.',
        staleNotice(leg, step.state.docsFolder),
      );
    }
    return;
  }
  if (leg.quietSince === null || leg.handoff) return;
  const quietFor = now - leg.quietSince;
  if (leg.phase === 'planning' && quietFor >= RELAY_TIMING.quietMs) {
    patchLeg(step, { planShown: true });
    await_(step, 'plan-review', 'The plan is ready for review.', planReviewNotice(leg));
  } else if (leg.phase === 'executing' && quietFor > RELAY_TIMING.staleIdleMs) {
    await_(
      step,
      'stale-handoff',
      'The session went quiet without a handoff.',
      staleNotice(leg, step.state.docsFolder),
    );
  }
}

function onLaunchFailed(step: Step, error: string, now: number): void {
  const leg = step.state.current!;
  if (leg.attempt < 2) {
    const retry: RelayLeg = {
      ...leg,
      attempt: leg.attempt + 1,
      legId: legIdFor(step.state, leg.taskId, leg.legNo, leg.attempt + 1),
      phase: 'launching',
      startedAt: now,
      tabId: null,
    };
    step.state = { ...step.state, current: retry };
    step.effects.push(launchEffect(retry));
    return;
  }
  patchLeg(step, { phase: 'failed' });
  pause(step, `${leg.taskId} could not start.`);
  notify(step, {
    level: 'error',
    title: `${leg.taskId} could not start`,
    body: error,
    taskId: leg.taskId,
  });
}

/** Where a leg that waited goes back to once its agent works again. */
function resumedPhase(leg: RelayLeg): LegPhase {
  if (!leg.planFirst || leg.planDone) return 'executing';
  // A CLI without hooks cannot say its plan was approved; working again after the review is the sign.
  return leg.exact ? 'planning' : 'executing';
}

function onAgentStatus(step: Step, status: AgentStatus, now: number): void {
  const leg = step.state.current!;
  if (!SETTLED_PHASES.includes(leg.phase)) return;
  patchLeg(step, { agent: status });

  if (status === 'working') {
    const phase =
      leg.phase === 'awaiting-user' || leg.phase === 'finishing' ? resumedPhase(leg) : leg.phase;
    const planDone = leg.planDone || (!leg.exact && leg.awaiting?.reason === 'plan-review');
    patchLeg(step, {
      everWorked: true,
      sessionSeen: true,
      stoppedAt: null,
      quietSince: null,
      phase,
      planDone,
      awaiting: phase === 'awaiting-user' ? leg.awaiting : null,
    });
    return;
  }

  if (status === 'needs-input') {
    if (leg.planPending && leg.tabId) {
      step.effects.push({
        type: 'approvePlanMenu',
        tabId: leg.tabId,
        mode: step.state.options.afterPlanMode,
      });
      return;
    }
    if (leg.phase === 'planning' && leg.planShown) {
      await_(step, 'plan-review', 'The plan is ready for review.', planReviewNotice(leg));
      return;
    }
    await_(
      step,
      leg.openQuestions > 0 ? 'question' : 'needs-input',
      'The session is waiting for you.',
    );
    return;
  }

  if (status !== 'done' && status !== 'idle') return;
  if (leg.exact) {
    if (status === 'idle' && !leg.everWorked) return;
    const stoppedAt = leg.stoppedAt ?? now;
    patchLeg(step, { stoppedAt });
    if (leg.phase === 'planning' && !leg.handoff) {
      await_(step, 'plan-review', 'The session stopped in plan mode.', planReviewNotice(leg));
      return;
    }
    if (!leg.handoff && leg.phase === 'executing') patchLeg(step, { phase: 'finishing' });
  } else if (leg.quietSince === null) {
    patchLeg(step, { quietSince: now });
  }
  checkCompletion(step, now);
}

function onHandoff(step: Step, handoff: HandoffMeta, now: number, trusted: boolean): void {
  const leg = step.state.current!;
  if (!trusted && !isHandoffFresh(handoff, leg.handoffMtimeAtStart)) return;
  patchLeg(step, { handoff });
  // A leg that failed or was cut off keeps its baton for Resume to apply.
  if (leg.phase === 'failed' || leg.phase === 'interrupted') return;
  checkCompletion(step, now);
}

function onContext(step: Step, tokens: number, window: number | null): void {
  const leg = step.state.current!;
  const peak = Math.max(leg.peakContextTokens ?? 0, tokens);
  patchLeg(step, { contextTokens: tokens, peakContextTokens: peak, window: window ?? leg.window });
  if (!leg.exact || leg.guardSent || leg.guardArmed || !leg.tabId) return;
  if (relayCapabilities(leg.choice.cliId).contextGuard !== 'hook') return;
  const threshold = guardThreshold({
    budget: leg.budget,
    share: step.state.options.guardShare,
    window: window ?? leg.window,
  });
  if (tokens < threshold) return;
  if (leg.contextTokens === null) {
    // Past the guard at its first reading: a fresh session is already bigger than the budget
    // allows (its system prompt, tools and config alone), and every new session would be too. The
    // guard stays off for this leg (marked as sent), so the task finishes instead of rolling over
    // without end.
    patchLeg(step, { guardSent: true });
    notify(step, {
      level: 'warning',
      title: `${leg.taskId}'s context budget is too small`,
      body: `Its budget is ${formatTokenCount(leg.budget)}, but a fresh session already holds ${formatTokenCount(tokens)}. The session carries on without the hand-off. Raise the budget for this task.`,
      taskId: leg.taskId,
    });
    return;
  }
  patchLeg(step, { guardArmed: true });
  step.effects.push({ type: 'armGuard', tabId: leg.tabId, armed: true });
}

function onPtyExited(step: Step, code: number, hostLost: boolean, now: number): void {
  const leg = step.state.current!;
  if (!hostLost && leg.handoff?.outcome) {
    patchLeg(step, {
      stoppedAt: leg.stoppedAt ?? now,
      quietSince: leg.quietSince ?? now - RELAY_TIMING.quietMs,
    });
    completeLeg(step, now);
    return;
  }
  const failed = !hostLost && code !== 0;
  patchLeg(step, { phase: failed ? 'failed' : 'interrupted', agent: 'exited' });
  pause(step, `The session for ${leg.taskId} ended.`);
  notify(step, {
    level: failed ? 'error' : 'warning',
    title: `The session for ${leg.taskId} ended`,
    body: hostLost
      ? 'The terminal host stopped. Resume to continue the task in a new session.'
      : 'It ended before writing its handoff. Resume to continue the task in a new session.',
    taskId: leg.taskId,
  });
}

function onResume(step: Step, now: number): void {
  if (step.state.status !== 'paused') return;
  const leg = step.state.current;
  const status = step.state.started ? 'running' : 'waiting';
  step.state = { ...step.state, status, pauseReason: null };
  if (status === 'waiting') return;
  if (!leg) {
    advance(step, now);
    return;
  }
  const stalled =
    leg.phase === 'failed' ||
    leg.phase === 'interrupted' ||
    (leg.phase === 'awaiting-user' &&
      ['stale-handoff', 'bad-handoff', 'no-progress', 'leg-cap'].includes(
        leg.awaiting?.reason ?? '',
      ));
  if (!stalled) return;
  if (leg.handoff?.outcome && leg.handoff.outcome !== 'continue') {
    completeLeg(step, now);
    return;
  }
  // Start over from the baton. The user chose to, so the session limit gives way once.
  record(step, leg, leg.phase === 'failed' ? 'failed' : 'interrupted', now);
  const legsByTask = { ...step.state.legsByTask };
  if ((legsByTask[leg.taskId] ?? 0) >= step.state.options.maxLegsPerTask) {
    legsByTask[leg.taskId] = step.state.options.maxLegsPerTask - 1;
  }
  step.state = { ...step.state, legsByTask };
  startLeg(step, leg.taskId, now, leg);
}

function onFilesChanged(step: Step, snapshots: RelayTaskSnapshot[]): void {
  const before = step.state.tasks;
  const tasks = Object.fromEntries(snapshots.map((task) => [task.id, task]));
  const dropped = (id: string): boolean => {
    const task = tasks[id];
    if (!task) return true;
    const was = before[id]?.status;
    if (task.status === 'done' && was !== 'done') return true;
    return task.status === 'blocked' && was !== 'blocked';
  };
  step.state = { ...step.state, tasks, queue: step.state.queue.filter((id) => !dropped(id)) };
  const leg = step.state.current;
  if (leg && !tasks[leg.taskId]) patchLeg(step, { taskGone: true });
}

function forCurrentTab(state: RelayState, tabId: string): boolean {
  return Boolean(state.current && state.current.tabId === tabId);
}

/**
 * The relay's whole behaviour as a pure function: an event in, the next state and the effects the
 * driver must carry out. Nothing here reads a clock, a file or a terminal.
 */
export function reduceRelay(
  state: RelayState,
  event: RelayEvent,
): { state: RelayState; effects: RelayEffect[] } {
  if (state.status === 'cancelled' || state.status === 'done') {
    return { state, effects: [] };
  }
  const step: Step = { state, effects: [] };
  const leg = state.current;

  switch (event.type) {
    case 'start':
      if (state.status !== 'waiting') break;
      step.state = { ...state, status: 'running', started: true };
      advance(step, event.now);
      break;

    case 'tick':
      onTick(step, event.now);
      break;

    case 'sized':
    case 'sizeFailed': {
      if (!leg || leg.legId !== event.legId || leg.phase !== 'sizing')
        return { state, effects: [] };
      const choice =
        event.type === 'sized'
          ? { ...event.choice, autoSize: false }
          : { ...leg.choice, autoSize: false };
      patchLeg(step, { choice, phase: 'launching' });
      step.effects.push(launchEffect(step.state.current!));
      break;
    }

    case 'launched': {
      if (!leg || leg.legId !== event.legId || leg.phase !== 'launching')
        return { state, effects: [] };
      const exact = leg.exact && event.hooks !== false;
      patchLeg(step, {
        tabId: event.tabId,
        handoffMtimeAtStart: event.handoffMtimeAtStart,
        startedAt: event.now,
        exact,
        phase: leg.planFirst ? 'planning' : 'executing',
      });
      if (leg.legNo === 1 && state.tasks[leg.taskId]?.status !== 'in-progress') {
        setStatus(step, leg.taskId, 'in-progress');
      }
      break;
    }

    case 'launchFailed':
      if (!leg || leg.legId !== event.legId || leg.phase !== 'launching')
        return { state, effects: [] };
      onLaunchFailed(step, event.error, leg.startedAt);
      break;

    case 'agentStatus':
      if (!forCurrentTab(state, event.tabId)) return { state, effects: [] };
      onAgentStatus(step, event.status, event.now);
      break;

    case 'sessionStarted':
      if (!forCurrentTab(state, event.tabId)) break;
      patchLeg(step, { sessionSeen: true });
      if (leg!.awaiting?.reason === 'not-started') {
        patchLeg(step, { phase: resumedPhase(leg!), awaiting: null });
      }
      break;

    case 'promptSubmitted':
      if (forCurrentTab(state, event.tabId)) patchLeg(step, { openQuestions: 0 });
      break;

    case 'hookQuestion':
      if (forCurrentTab(state, event.tabId))
        patchLeg(step, { openQuestions: leg!.openQuestions + 1 });
      break;

    case 'questionAnswered':
      if (forCurrentTab(state, event.tabId)) {
        patchLeg(step, { openQuestions: Math.max(0, leg!.openQuestions - 1) });
      }
      break;

    case 'planPresented':
      if (forCurrentTab(state, event.tabId)) {
        patchLeg(step, { planShown: true, planPending: event.approvable && leg!.planFirst });
      }
      break;

    case 'planApproved':
      if (!forCurrentTab(state, event.tabId)) break;
      patchLeg(step, {
        planPending: false,
        planDone: true,
        expectedMode: event.mode,
        phase:
          leg!.phase === 'planning' || leg!.phase === 'awaiting-user' ? 'executing' : leg!.phase,
        awaiting: null,
      });
      break;

    case 'modeObserved': {
      if (!forCurrentTab(state, event.tabId) || event.mode === 'plan') break;
      const current = leg!;
      if (
        current.phase === 'planning' ||
        (current.phase === 'awaiting-user' && current.planShown && !current.planDone)
      ) {
        patchLeg(step, { phase: 'executing', planDone: true, planPending: false, awaiting: null });
      }
      if (current.expectedMode && event.mode !== current.expectedMode) {
        notify(step, {
          level: 'warning',
          title: `${current.taskId} is running in ${event.mode} mode`,
          body: `The plan was approved, but the session did not switch to ${current.expectedMode}. It may stop to ask before it changes files.`,
          taskId: current.taskId,
        });
      }
      if (current.expectedMode) patchLeg(step, { expectedMode: null });
      break;
    }

    case 'stopBlocked':
      if (forCurrentTab(state, event.tabId)) patchLeg(step, { stopBlocks: leg!.stopBlocks + 1 });
      break;

    case 'guardSent':
      if (!forCurrentTab(state, event.tabId)) break;
      patchLeg(step, { guardSent: true, guardArmed: false });
      step.effects.push({ type: 'armGuard', tabId: event.tabId, armed: false });
      break;

    case 'handoffChanged':
      if (!leg || leg.taskId !== event.taskId) return { state, effects: [] };
      onHandoff(step, event.handoff, event.now, false);
      break;

    case 'legReported':
      if (!forCurrentTab(state, event.tabId)) return { state, effects: [] };
      onHandoff(step, event.handoff, event.now, true);
      break;

    case 'contextUsage':
      if (forCurrentTab(state, event.tabId)) onContext(step, event.tokens, event.window);
      break;

    case 'ptyExited':
      if (!forCurrentTab(state, event.tabId) || !SETTLED_PHASES.includes(leg!.phase)) break;
      onPtyExited(step, event.code, event.hostLost, leg!.stoppedAt ?? leg!.startedAt);
      break;

    case 'appRestarted': {
      if (!leg) break;
      const alive = leg.tabId !== null && event.liveTabs.includes(leg.tabId);
      if (alive && SETTLED_PHASES.includes(leg.phase)) {
        patchLeg(step, { agent: 'unknown', stoppedAt: null, quietSince: null });
      } else if (leg.phase !== 'failed' && leg.phase !== 'done') {
        patchLeg(step, { phase: 'interrupted' });
        if (step.state.status === 'running') pause(step, 'Runova restarted while a session ran.');
      }
      break;
    }

    case 'pause':
      if (state.status === 'running' || state.status === 'waiting') {
        pause(step, 'You paused the relay.');
      }
      break;

    case 'resume':
      onResume(step, event.now);
      break;

    case 'cancel':
      step.state = { ...state, status: 'cancelled' };
      break;

    case 'userMarkedDone': {
      if (!leg || leg.taskId !== event.taskId) break;
      record(step, leg, 'marked-done', event.now);
      setStatus(step, leg.taskId, 'done', leg.taskGone);
      step.state = {
        ...step.state,
        finished: [
          ...step.state.finished,
          { taskId: leg.taskId, result: 'done', note: 'Marked done by you.', at: event.now },
        ],
      };
      if (step.state.status === 'paused')
        step.state = { ...step.state, status: 'running', pauseReason: null };
      advance(step, event.now);
      break;
    }

    case 'taskFilesChanged':
      onFilesChanged(step, event.tasks);
      break;

    case 'extend': {
      const taken = new Set([
        ...state.queue,
        ...state.finished.map((entry) => entry.taskId),
        ...(leg ? [leg.taskId] : []),
      ]);
      const added = event.taskIds.filter((id) => {
        if (taken.has(id)) return false;
        taken.add(id);
        return true;
      });
      step.state = {
        ...state,
        tasks: Object.fromEntries(event.tasks.map((task) => [task.id, task])),
        queue: [...state.queue, ...added],
      };
      break;
    }
  }
  return step;
}
