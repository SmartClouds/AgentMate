import type { BoardFile } from '@runova/core';
import {
  type AgentStatus,
  createRelay,
  decideRelayGate,
  describeTrigger,
  type GateLegView,
  guardThreshold,
  type HandoffMeta,
  handoffRelPath,
  isHandoffFresh,
  orderTasks,
  RELAY_PERMISSION_MODES,
  type RelayEffect,
  type RelayEvent,
  type RelayGateObservation,
  type RelayHookInput,
  type RelayLeg,
  type RelayLegRecord,
  type RelayNotice,
  type RelayPermissionMode,
  type RelayRunChoice,
  type RelayState,
  type RelayTaskSnapshot,
  type RelayTaskStatus,
  reduceRelay,
  relayCapabilities,
  relayQueue,
  triggerVerdict,
} from '@runova/core';
import type {
  RelayApplyResult,
  RelayChangedEvent,
  RelayCloseTabEvent,
  RelayContextEvent,
  RelayLegTabEvent,
  RelayLegView,
  RelayMcpProposal,
  RelayProjectSettings,
  RelayRunView,
  RelayStartInput,
  RelayStartResult,
} from '../../shared/relayTypes';
import type { RelayRuntime } from './runtime';
import type { HandoffRead } from './taskFiles';

/**
 * The Relay driver (E26). It owns the relays, feeds every event to the pure core reducer, saves
 * what comes back, and carries out its effects: starting sessions, writing task statuses, telling
 * the windows. Everything it touches outside itself comes in through `RelayDriverDeps`, so the
 * whole loop can be driven in a test with fakes and a hand-moved clock.
 */

export interface LaunchedLeg {
  tabId: string;
  handoffMtimeAtStart: number | null;
  hooks: boolean;
  tab: RelayLegTabEvent;
}

export interface RelayDriverDeps {
  now(): number;
  loadRelays(): Promise<RelayState[]>;
  saveRelay(state: RelayState): Promise<void>;
  addLegRecord(projectId: string, record: RelayLegRecord): Promise<void>;
  settings(projectId: string): Promise<RelayProjectSettings>;
  /** The board files of a project, in its relay docs folder. */
  boardFiles(projectId: string, docsFolder: string): Promise<BoardFile[]>;
  setTaskStatus(
    projectId: string,
    docsFolder: string,
    taskId: string,
    status: RelayTaskStatus,
  ): Promise<void>;
  readHandoff(projectId: string, docsFolder: string, taskId: string): Promise<HandoffRead | null>;
  launch(relay: RelayState, effect: Extract<RelayEffect, { type: 'launch' }>): Promise<LaunchedLeg>;
  /** Sizes a task for the leg's CLI; null when sizing failed. */
  assess(relay: RelayState, taskId: string, choice: RelayRunChoice): Promise<RelayRunChoice | null>;
  armGuard(tabId: string, armed: boolean): Promise<void>;
  /** The last few KB of a session's output, ANSI removed, for the plan-menu check. */
  screenText(tabId: string): string;
  typeIntoSession(tabId: string, data: string): void;
  forwardStop(tabId: string): void;
  sessionStatus(tabId: string): AgentStatus | 'gone';
  transcriptPath(tabId: string): string | null;
  sessionModel(tabId: string): string | undefined;
  readContext(path: string): Promise<number | null>;
  contextWindow(model: string | undefined): number | null;
  watchExit(
    tabId: string,
    listener: (info: { exitCode: number; hostLost: boolean }) => void,
  ): () => void;
  liveSessions(): Promise<string[]>;
  /**
   * Re-attaches to a leg's session after a restart, so its status keeps flowing, and returns the
   * tab to show it in.
   */
  adoptSession(leg: RelayLeg, relay: RelayState): Promise<RelayLegTabEvent | null>;
  releaseSession(tabId: string): void;
  notify(relay: RelayState, notice: RelayNotice): void;
  emitRun(view: RelayRunView): void;
  emitChanged(event: RelayChangedEvent): void;
  emitContext(event: RelayContextEvent): void;
  emitLegTab(event: RelayLegTabEvent): void;
  emitCloseTab(event: RelayCloseTabEvent): void;
  emitProposal(proposal: RelayMcpProposal): void;
  applyProposal(
    projectId: string,
    proposal: RelayMcpProposal['proposal'],
  ): Promise<RelayApplyResult>;
}

const LIVE: ReadonlySet<RelayState['status']> = new Set(['waiting', 'running', 'paused']);
const PLAN_MENU = /ready to execute|would you like to proceed/i;
const MAX_PENDING_PROPOSALS = 10;
/** How long a hook from an unknown session waits for a leg launch to be recorded (the gate route gives up at 1.5 s). */
const LAUNCH_WAIT_MS = 1_200;

function isPermissionMode(value: string): value is RelayPermissionMode {
  return (RELAY_PERMISSION_MODES as readonly string[]).includes(value);
}

function snapshots(files: BoardFile[]): RelayTaskSnapshot[] {
  return files.map((file) => ({
    id: file.task.id,
    status: file.task.status,
    depends: file.task.depends,
    budget: file.task.budget,
  }));
}

export interface RelayDriver extends RelayRuntime {
  /** Loads saved relays, picks up legs whose sessions survived, and never launches anything. */
  startup(): Promise<void>;
  tick(): Promise<void>;
  checkTriggers(): Promise<void>;
  onAgentStatus(tabId: string, status: AgentStatus): void;
  onAgentEvent(tabId: string, event: string, permissionMode: string | undefined): Promise<void>;
  onFilesChanged(projectId: string, handoffTaskIds: string[], tasksChanged: boolean): Promise<void>;
  gate(body: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** The leg a session runs, for the MCP tools. */
  legForSession(tabId: string): { relay: RelayState; leg: RelayLeg } | null;
  addProposal(
    projectId: string,
    projectName: string,
    fromTaskId: string | null,
    proposal: RelayMcpProposal['proposal'],
    entries: RelayMcpProposal['entries'],
  ): RelayMcpProposal | string;
  reportLeg(tabId: string, handoff: HandoffMeta): Promise<void>;
  view(relay: RelayState): RelayRunView;
  liveProjects(): string[];
  relay(relayId: string): RelayState | null;
}

export function createRelayDriver(deps: RelayDriverDeps): RelayDriver {
  const relays = new Map<string, RelayState>();
  const exitWatches = new Map<string, () => void>();
  const legTabs = new Map<string, RelayLegTabEvent>();
  const proposals = new Map<string, RelayMcpProposal>();
  /** Leg launches still being recorded, see relayForTab. */
  const launching = new Set<Promise<void>>();
  let chain: Promise<unknown> = Promise.resolve();
  let proposalSeq = 0;

  /** Every change to a relay runs one at a time, so effects that dispatch again stay in order. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  }

  function byTab(tabId: string): RelayState | null {
    for (const relay of relays.values()) {
      if (relay.current?.tabId === tabId && LIVE.has(relay.status)) return relay;
    }
    return null;
  }

  /**
   * byTab, but a session that reports before its leg has learnt its tab id (a fast CLI runs its
   * first hooks while the launch is still being recorded) waits for the launches in flight. Without
   * this its plan, its stop and its start would be dropped as some other session's.
   */
  async function relayForTab(tabId: string): Promise<RelayState | null> {
    const found = byTab(tabId);
    if (found || launching.size === 0) return found;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...launching]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, LAUNCH_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return byTab(tabId);
  }

  function guardAt(relay: RelayState, leg: RelayLeg): number | null {
    if (relayCapabilities(leg.choice.cliId).contextGuard !== 'hook' || !leg.exact) return null;
    return guardThreshold({
      budget: leg.budget,
      share: relay.options.guardShare,
      window: leg.window,
    });
  }

  function legView(relay: RelayState): RelayLegView | null {
    const leg = relay.current;
    if (!leg) return null;
    return {
      legId: leg.legId,
      taskId: leg.taskId,
      legNo: leg.legNo,
      phase: leg.phase,
      tabId: leg.tabId,
      choice: leg.choice,
      planFirst: leg.planFirst,
      startedAt: leg.startedAt,
      contextTokens: leg.contextTokens,
      peakContextTokens: leg.peakContextTokens,
      budget: leg.budget,
      guardAt: guardAt(relay, leg),
      awaiting: leg.awaiting,
    };
  }

  function view(relay: RelayState): RelayRunView {
    return {
      id: relay.id,
      projectId: relay.projectId,
      status: relay.status,
      trigger: relay.trigger,
      triggerText: describeTrigger(relay.trigger),
      queue: relay.queue,
      finished: relay.finished,
      current: legView(relay),
      pauseReason: relay.pauseReason,
      options: relay.options,
      createdAt: relay.createdAt,
    };
  }

  async function commit(previous: RelayState, next: RelayState): Promise<void> {
    relays.set(next.id, next);
    if (next === previous) return;
    await deps.saveRelay(next);
    deps.emitRun(view(next));
    deps.emitChanged({ projectId: next.projectId, reason: 'run' });
  }

  /** Runs one event through the reducer, saves, and carries out the effects in order. */
  function dispatch(relayId: string, event: RelayEvent): Promise<void> {
    return serial(() => step(relayId, event));
  }

  async function step(relayId: string, event: RelayEvent): Promise<void> {
    const before = relays.get(relayId);
    if (!before) return;
    const { state, effects } = reduceRelay(before, event);
    await commit(before, state);
    for (const effect of effects) await perform(relayId, effect);
  }

  function watchLegExit(relayId: string, tabId: string): void {
    exitWatches.get(tabId)?.();
    exitWatches.set(
      tabId,
      deps.watchExit(tabId, (info) => {
        exitWatches.delete(tabId);
        void dispatch(relayId, {
          type: 'ptyExited',
          tabId,
          code: info.exitCode,
          hostLost: info.hostLost,
        });
      }),
    );
  }

  async function perform(relayId: string, effect: RelayEffect): Promise<void> {
    const relay = relays.get(relayId);
    if (!relay) return;
    switch (effect.type) {
      case 'assess': {
        const sized = await deps.assess(relay, effect.taskId, effect.choice).catch(() => null);
        await step(
          relayId,
          sized
            ? {
                type: 'sized',
                legId: effect.legId,
                choice: { cliId: sized.cliId, model: sized.model, effort: sized.effort },
              }
            : { type: 'sizeFailed', legId: effect.legId },
        );
        return;
      }
      case 'launch': {
        let landed = (): void => undefined;
        const landing = new Promise<void>((resolve) => {
          landed = resolve;
        });
        launching.add(landing);
        try {
          let launched: LaunchedLeg;
          try {
            launched = await deps.launch(relay, effect);
          } catch (error) {
            await step(relayId, {
              type: 'launchFailed',
              legId: effect.legId,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          legTabs.set(effect.legId, launched.tab);
          watchLegExit(relayId, launched.tabId);
          deps.emitLegTab(launched.tab);
          await step(relayId, {
            type: 'launched',
            legId: effect.legId,
            tabId: launched.tabId,
            handoffMtimeAtStart: launched.handoffMtimeAtStart,
            now: deps.now(),
            hooks: launched.hooks,
          });
        } finally {
          launching.delete(landing);
          landed();
        }
        return;
      }
      case 'setTaskStatus':
        await deps
          .setTaskStatus(relay.projectId, relay.docsFolder, effect.taskId, effect.status)
          .catch(() => undefined);
        deps.emitChanged({ projectId: relay.projectId, reason: 'files' });
        return;
      case 'closeTab':
        exitWatches.get(effect.tabId)?.();
        exitWatches.delete(effect.tabId);
        deps.releaseSession(effect.tabId);
        deps.emitCloseTab({ projectId: relay.projectId, tabId: effect.tabId });
        return;
      case 'armGuard':
        await deps.armGuard(effect.tabId, effect.armed).catch(() => undefined);
        return;
      case 'approvePlanMenu':
        // Only when the plan menu is really on screen: a stray digit anywhere else is input.
        if (PLAN_MENU.test(deps.screenText(effect.tabId))) deps.typeIntoSession(effect.tabId, '1');
        return;
      case 'recordLeg':
        await deps.addLegRecord(relay.projectId, effect.record).catch(() => undefined);
        // The leg is over; its tab, if it stays open, is the renderer's to track from here.
        if (effect.record.tabId) deps.releaseSession(effect.record.tabId);
        return;
      case 'notify':
        deps.notify(relay, effect);
        return;
    }
  }

  async function refreshContext(relay: RelayState): Promise<void> {
    const leg = relay.current;
    if (!leg?.tabId || !leg.exact) return;
    const path = deps.transcriptPath(leg.tabId);
    if (!path) return;
    const tokens = await deps.readContext(path);
    if (tokens === null || tokens === leg.contextTokens) return;
    const window = deps.contextWindow(deps.sessionModel(leg.tabId));
    await dispatch(relay.id, { type: 'contextUsage', tabId: leg.tabId, tokens, window });
    const after = relays.get(relay.id)?.current;
    if (!after?.tabId) return;
    deps.emitContext({
      projectId: relay.projectId,
      tabId: after.tabId,
      taskId: after.taskId,
      tokens,
      budget: after.budget,
      guardAt: guardAt(relays.get(relay.id) ?? relay, after),
    });
  }

  function gateView(relay: RelayState, leg: RelayLeg): GateLegView {
    return {
      taskId: leg.taskId,
      legNo: leg.legNo,
      phase: leg.phase,
      planFirst: leg.planFirst,
      afterPlanMode: relay.options.afterPlanMode,
      openQuestions: leg.openQuestions,
      guardDue: leg.guardArmed && !leg.guardSent,
      contextPercent:
        leg.contextTokens !== null ? Math.round((leg.contextTokens / leg.budget) * 100) : null,
      stopBlocks: leg.stopBlocks,
      handoffRelPath: handoffRelPath(relay.docsFolder, leg.taskId),
    };
  }

  function observationEvent(tabId: string, observation: RelayGateObservation): RelayEvent | null {
    switch (observation.type) {
      case 'modeObserved':
        return { type: 'modeObserved', tabId, mode: observation.mode };
      case 'hookQuestion':
        return { type: 'hookQuestion', tabId };
      case 'questionAnswered':
        return { type: 'questionAnswered', tabId };
      case 'planPresented':
        return { type: 'planPresented', tabId, approvable: observation.approvable };
      case 'planApproved':
        return { type: 'planApproved', tabId, mode: observation.mode };
      case 'guardSent':
        return { type: 'guardSent', tabId };
      case 'stopBlocked':
        return { type: 'stopBlocked', tabId };
      case 'stopAllowed':
        return null;
    }
  }

  /**
   * Reads the current leg's handoff and passes it on when it is fresh and new to the leg. The
   * watcher is the quick path; this catches what it misses (a handoffs folder made after the watch
   * began, a network drive). Returns whether the handoff is fresh.
   */
  async function pollHandoff(relay: RelayState): Promise<boolean> {
    const leg = relay.current;
    if (!leg) return false;
    const read = await deps
      .readHandoff(relay.projectId, relay.docsFolder, leg.taskId)
      .catch(() => null);
    if (!read || !isHandoffFresh(read.meta, leg.handoffMtimeAtStart)) return false;
    if (leg.handoff?.hash !== read.meta.hash || leg.handoff?.mtimeMs !== read.meta.mtimeMs) {
      await dispatch(relay.id, {
        type: 'handoffChanged',
        taskId: leg.taskId,
        handoff: read.meta,
        now: deps.now(),
      });
    }
    return true;
  }

  async function gate(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const tabId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const event = body.event;
    const relay = await relayForTab(tabId);
    const leg = relay?.current ?? null;
    const permissionMode =
      typeof body.permissionMode === 'string' && isPermissionMode(body.permissionMode)
        ? body.permissionMode
        : undefined;
    let input: RelayHookInput;
    if (event === 'Stop') {
      // The file watcher can miss a write, so the handoff read for the gate also counts as news.
      const fresh = relay ? await pollHandoff(relay) : false;
      input = {
        event: 'Stop',
        stopHookActive: body.stopHookActive === true,
        permissionMode,
        handoffFresh: fresh,
      };
    } else if (event === 'PreToolUse' || event === 'PermissionRequest' || event === 'PostToolUse') {
      input = {
        event,
        tool: typeof body.tool === 'string' ? body.tool.slice(0, 128) : '',
        permissionMode,
        toolInput:
          body.toolInput && typeof body.toolInput === 'object' && !Array.isArray(body.toolInput)
            ? (body.toolInput as Record<string, unknown>)
            : undefined,
        planTruncated: body.planTruncated === true,
      };
    } else {
      return null;
    }
    const decision = decideRelayGate(relay && leg ? gateView(relay, leg) : null, input);
    if (relay) {
      for (const observation of decision.observations) {
        const next = observationEvent(tabId, observation);
        if (next) await dispatch(relay.id, next);
      }
    }
    // The relay hooks replace the status hook on Stop, so a stop that goes through is passed on.
    if (event === 'Stop' && !decision.output) deps.forwardStop(tabId);
    if (relay && event === 'PostToolUse') void refreshContext(relays.get(relay.id) ?? relay);
    return decision.output;
  }

  /**
   * One relay runs per project, so sessions never edit the same tree at once. Tasks asked to run
   * now, or after a task this relay still has to run, join the end of its queue instead, which is
   * after that task. Any other start waits for the user to cancel the live one.
   */
  async function joinLive(
    live: RelayState,
    trigger: RelayStartInput['trigger'],
    queue: string[],
    files: BoardFile[],
  ): Promise<RelayStartResult> {
    const ahead = new Set([...(live.current ? [live.current.taskId] : []), ...live.queue]);
    const joinable =
      trigger.kind === 'now' ||
      (trigger.kind === 'after-task' &&
        trigger.projectId === live.projectId &&
        ahead.has(trigger.taskId));
    if (!joinable) {
      return {
        ok: false,
        error:
          'A relay is already set up on this project. Start these after one of its tasks, or cancel it first.',
      };
    }
    await dispatch(live.id, { type: 'extend', tasks: snapshots(files), taskIds: queue });
    return { ok: true, run: view(relays.get(live.id) ?? live) };
  }

  async function startRelay(input: RelayStartInput): Promise<RelayStartResult> {
    const live = [...relays.values()].find(
      (relay) => relay.projectId === input.projectId && LIVE.has(relay.status),
    );
    let settings: RelayProjectSettings;
    let files: BoardFile[];
    try {
      settings = await deps.settings(input.projectId);
      files = await deps.boardFiles(input.projectId, settings.docsFolder);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const tasks = files.map((file) => file.task);
    const order = orderTasks(tasks);
    const queue = relayQueue(tasks, { from: input.from, only: input.only });
    // A task in a loop never makes it into the order, so the check looks at what was asked for.
    const looped = new Set([...order.cycles.flat(), ...order.stuck]);
    const wanted = input.only
      ? tasks.filter((task) => input.only?.includes(task.id))
      : tasks.filter((task) => task.status !== 'done' && task.status !== 'blocked');
    const blocked = wanted.map((task) => task.id).filter((id) => looped.has(id));
    if (blocked.length > 0) {
      return {
        ok: false,
        error: `${blocked.join(', ')} depend on each other in a loop. Fix their depends first.`,
      };
    }
    if (queue.length === 0) return { ok: false, error: 'There is no task to run.' };
    if (live) return joinLive(live, input.trigger, queue, files);
    const now = deps.now();
    const relay = createRelay({
      id: `relay-${now.toString(36)}-${(proposalSeq++).toString(36)}`,
      projectId: input.projectId,
      docsFolder: settings.docsFolder,
      now,
      tasks: snapshots(files),
      queue,
      trigger: input.trigger,
      defaults: { ...settings.defaults, ...input.defaults },
      overrides: settings.overrides,
      options: { ...settings.options, ...input.options },
    });
    await serial(async () => {
      relays.set(relay.id, relay);
      await deps.saveRelay(relay);
      deps.emitRun(view(relay));
      deps.emitChanged({ projectId: relay.projectId, reason: 'run' });
    });
    if (input.trigger.kind === 'now') await dispatch(relay.id, { type: 'start', now });
    else await checkTriggers();
    return { ok: true, run: view(relays.get(relay.id) ?? relay) };
  }

  async function checkTriggers(): Promise<void> {
    const waiting = [...relays.values()].filter((relay) => relay.status === 'waiting');
    if (waiting.length === 0) return;
    const statusCache = new Map<string, Map<string, RelayTaskStatus>>();
    const statuses = async (projectId: string): Promise<Map<string, RelayTaskStatus>> => {
      let known = statusCache.get(projectId);
      if (!known) {
        const settings = await deps.settings(projectId).catch(() => null);
        const files = settings
          ? await deps.boardFiles(projectId, settings.docsFolder).catch(() => [])
          : [];
        known = new Map(files.map((file) => [file.task.id, file.task.status]));
        statusCache.set(projectId, known);
      }
      return known;
    };
    for (const relay of waiting) {
      if (relay.trigger.kind === 'after-task') await statuses(relay.trigger.projectId);
      const verdict = triggerVerdict(relay.trigger, {
        now: deps.now(),
        taskStatus: (projectId, taskId) => statusCache.get(projectId)?.get(taskId) ?? null,
        sessionState: (sessionId) => deps.sessionStatus(sessionId),
      });
      if (verdict.ready) await dispatch(relay.id, { type: 'start', now: deps.now() });
    }
  }

  async function onFilesChanged(
    projectId: string,
    handoffTaskIds: string[],
    tasksChanged: boolean,
  ): Promise<void> {
    for (const relay of [...relays.values()]) {
      if (relay.projectId !== projectId || !LIVE.has(relay.status)) continue;
      if (tasksChanged) {
        const files = await deps.boardFiles(projectId, relay.docsFolder).catch(() => null);
        if (files) await dispatch(relay.id, { type: 'taskFilesChanged', tasks: snapshots(files) });
      }
      const leg = relays.get(relay.id)?.current;
      if (leg && handoffTaskIds.includes(leg.taskId)) {
        const read = await deps
          .readHandoff(projectId, relay.docsFolder, leg.taskId)
          .catch(() => null);
        if (read) {
          await dispatch(relay.id, {
            type: 'handoffChanged',
            taskId: leg.taskId,
            handoff: read.meta,
            now: deps.now(),
          });
        }
      }
    }
    if (tasksChanged) await checkTriggers();
  }

  function findRelay(relayId: string): RelayState {
    const relay = relays.get(relayId);
    if (!relay) throw new Error('That relay no longer exists.');
    return relay;
  }

  return {
    async startup() {
      const saved = await deps.loadRelays();
      for (const relay of saved) relays.set(relay.id, relay);
      const live = await deps.liveSessions().catch(() => [] as string[]);
      for (const relay of saved) {
        if (!LIVE.has(relay.status) || !relay.current) continue;
        const leg = relay.current;
        if (leg.tabId && live.includes(leg.tabId)) {
          const tab = await deps.adoptSession(leg, relay).catch(() => null);
          if (tab) legTabs.set(leg.legId, tab);
          watchLegExit(relay.id, leg.tabId);
        }
        await dispatch(relay.id, { type: 'appRestarted', liveTabs: live });
      }
    },

    async tick() {
      const now = deps.now();
      for (const relay of [...relays.values()]) {
        if (relay.status !== 'running' || !relay.current) continue;
        if (relay.current.tabId) await pollHandoff(relay);
        await dispatch(relay.id, { type: 'tick', now });
        const after = relays.get(relay.id);
        if (after?.current?.agent === 'working') await refreshContext(after);
      }
    },

    checkTriggers,

    onAgentStatus(tabId, status) {
      if (status === 'done' || status === 'exited' || status === 'idle') void checkTriggers();
      void relayForTab(tabId).then((relay) => {
        if (relay) void dispatch(relay.id, { type: 'agentStatus', tabId, status, now: deps.now() });
      });
    },

    async onAgentEvent(tabId, event, permissionMode) {
      const relay = await relayForTab(tabId);
      if (!relay) return;
      if (event === 'SessionStart') void dispatch(relay.id, { type: 'sessionStarted', tabId });
      if (event === 'UserPromptSubmit') void dispatch(relay.id, { type: 'promptSubmitted', tabId });
      if (permissionMode && isPermissionMode(permissionMode)) {
        void dispatch(relay.id, { type: 'modeObserved', tabId, mode: permissionMode });
      }
      void refreshContext(relay);
    },

    onFilesChanged,
    gate,

    legForSession(tabId) {
      const relay = byTab(tabId);
      return relay?.current ? { relay, leg: relay.current } : null;
    },

    addProposal(projectId, projectName, fromTaskId, proposal, entries) {
      const pending = [...proposals.values()].filter((item) => item.projectId === projectId);
      if (pending.length >= MAX_PENDING_PROPOSALS) {
        return 'Ten proposals already wait for the user on this project. Wait for an answer.';
      }
      proposalSeq += 1;
      const item: RelayMcpProposal = {
        id: `proposal-${deps.now().toString(36)}-${proposalSeq.toString(36)}`,
        projectId,
        projectName,
        fromTaskId,
        proposal,
        entries,
        receivedAt: deps.now(),
      };
      proposals.set(item.id, item);
      deps.emitProposal(item);
      return item;
    },

    async reportLeg(tabId, handoff) {
      const relay = byTab(tabId);
      if (relay) await dispatch(relay.id, { type: 'legReported', tabId, handoff, now: deps.now() });
    },

    view,

    liveProjects() {
      return [
        ...new Set([...relays.values()].filter((r) => LIVE.has(r.status)).map((r) => r.projectId)),
      ];
    },

    relay(relayId) {
      return relays.get(relayId) ?? null;
    },

    start: startRelay,

    async pause(relayId) {
      findRelay(relayId);
      await dispatch(relayId, { type: 'pause' });
    },

    async resume(relayId) {
      findRelay(relayId);
      await dispatch(relayId, { type: 'resume', now: deps.now() });
      if (relays.get(relayId)?.status === 'waiting') await checkTriggers();
    },

    async cancel(relayId) {
      findRelay(relayId);
      await dispatch(relayId, { type: 'cancel' });
      const tabId = relays.get(relayId)?.current?.tabId;
      if (tabId) {
        exitWatches.get(tabId)?.();
        exitWatches.delete(tabId);
      }
    },

    async markDone(relayId, taskId) {
      findRelay(relayId);
      await dispatch(relayId, { type: 'userMarkedDone', taskId, now: deps.now() });
    },

    runs(projectId) {
      return [...relays.values()]
        .filter((relay) => relay.projectId === projectId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(view);
    },

    active(projectId) {
      const relay = [...relays.values()]
        .filter((entry) => entry.projectId === projectId && LIVE.has(entry.status))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return relay ? view(relay) : null;
    },

    async reconcile(tabs) {
      const known = new Set(tabs.map((tab) => tab.tabId));
      for (const relay of relays.values()) {
        const leg = relay.current;
        if (!LIVE.has(relay.status) || !leg?.tabId || known.has(leg.tabId)) continue;
        const tab = legTabs.get(leg.legId);
        if (tab) deps.emitLegTab(tab);
      }
    },

    pendingProposals() {
      return [...proposals.values()];
    },

    async decideProposal(proposalId, accept) {
      const item = proposals.get(proposalId);
      if (!item) return null;
      proposals.delete(proposalId);
      if (!accept) return null;
      const result = await deps.applyProposal(item.projectId, item.proposal);
      deps.emitChanged({ projectId: item.projectId, reason: 'files' });
      return result;
    },
  };
}
