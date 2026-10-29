import { type AgentStatus, getCliDefinition } from '@runova/core';
import type {
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
  PipelineRunStatus,
} from '../../../shared/apiTypes';
import {
  AUTO_FIX_FINISHED,
  AUTO_FIX_MAX_ATTEMPTS,
  type AutoFixPhase,
  type AutoFixRunWait,
  type AutoFixSession,
  type AutoFixStartInput,
  type AutoFixStartResult,
  type AutoFixTabEvent,
} from '../../../shared/ciAutoFixTypes';
import { buildFixRunPrompt } from '../../../shared/pipelineFixPrompt';
import { type AutoFixPreflight, autoFixCommitMessage } from './git';
import type { AutoFixLaunchRequest, AutoFixLaunchResult } from './launch';
import {
  type AutoFixCommitResult,
  type AutoFixEffect,
  type AutoFixEvent,
  createAutoFixSession,
  reduceAutoFix,
} from './machine';

/** How often active sessions read their run from GitHub. Nothing polls while none is active. */
export const AUTO_FIX_TICK_MS = 15_000;
/** Finished sessions stay on screen this long, so the user can see how a fix went. */
const KEEP_FINISHED_MS = 3 * 24 * 3600_000;
const MAX_SESSIONS = 30;
/** Phases where the attempt's tab is still part of the session. */
const TAB_PHASES = new Set<AutoFixPhase>(['fixing', 'attention', 'committing']);

/** What auto-fix needs to know about a run. */
export interface AutoFixRunView {
  status: PipelineRunStatus;
  conclusion: string | null;
  headSha: string | null;
  runNumber: number;
  displayTitle: string;
}

export interface AutoFixProject {
  id: string;
  name: string;
  folderPath: string;
  cliId: string | null;
  /** The CLI of the project's agent type, the last resort when nothing else names one. */
  fallbackCliId: string | null;
}

/** What auto-fix uses when switched on without saying: the choices from Settings. */
export interface AutoFixDefaults {
  cliId: string | null;
  runArgs: string[];
  runLabel: string | null;
  maxAttempts: number;
}

export interface AutoFixDeps {
  now: () => number;
  newId: () => string;
  load: () => Promise<AutoFixSession[]>;
  save: (sessions: AutoFixSession[]) => Promise<void>;
  project: (projectId: string) => Promise<AutoFixProject | null>;
  defaults: (project: AutoFixProject) => Promise<AutoFixDefaults>;
  getRun: (repo: string, runId: number) => Promise<AutoFixRunView>;
  /** The run a session waits for: the one for a pushed commit, or one dispatched since a time. */
  findRun: (
    repo: string,
    workflowId: number,
    branch: string,
    wait: AutoFixRunWait,
  ) => Promise<{ id: number; runNumber: number | null } | null>;
  failureText: (input: GithubActionsRunErrorInput) => Promise<GithubActionsRunErrorResult>;
  preflight: (cwd: string, branch: string, runSha: string) => Promise<AutoFixPreflight>;
  commit: (
    cwd: string,
    input: { branch: string; baseSha: string | null; message: string },
  ) => Promise<AutoFixCommitResult>;
  launch: (request: AutoFixLaunchRequest) => Promise<AutoFixLaunchResult>;
  agentStatus: {
    subscribe: (listener: (id: string, status: AgentStatus) => void) => () => void;
    status: (id: string) => AgentStatus | null;
    unpin: (id: string) => void;
  };
  emitTab: (event: AutoFixTabEvent) => void;
  emitChanged: (sessions: AutoFixSession[]) => void;
  notify: (session: AutoFixSession, kind: 'fixed' | 'attention' | 'gave-up') => void;
  /** A fix was pushed, so the pipeline watcher should look for its run now. */
  pushed: (projectId: string) => void;
}

export interface AutoFixService {
  start: () => Promise<void>;
  dispose: () => void;
  /** Every session, newest first. */
  list: () => AutoFixSession[];
  enable: (input: AutoFixStartInput) => Promise<AutoFixStartResult>;
  stop: (id: string) => Promise<AutoFixSession | null>;
  commitNow: (id: string) => Promise<AutoFixSession | null>;
  retry: (id: string) => Promise<AutoFixSession | null>;
  /** Clears a finished session from the list. False for one still in progress. */
  dismiss: (id: string) => Promise<boolean>;
  /** True when an auto-fix session took on this run, so its failure is already being handled. */
  claims: (projectId: string, runId: number) => boolean;
  tick: () => Promise<void>;
  /** Resolves once the work in flight (launches, commits) has finished. */
  idle: () => Promise<void>;
}

function isFinished(session: AutoFixSession): boolean {
  return AUTO_FIX_FINISHED.includes(session.phase);
}

function currentTab(session: AutoFixSession): string | null {
  return session.attempts[session.attempts.length - 1]?.tabId ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAutoFixService(deps: AutoFixDeps): AutoFixService {
  const sessions = new Map<string, AutoFixSession>();
  const inFlight = new Set<Promise<unknown>>();
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let ticking = false;
  let saving: Promise<void> = Promise.resolve();

  function list(): AutoFixSession[] {
    return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  function track(work: Promise<unknown>): void {
    const settled = work.catch(() => undefined);
    inFlight.add(settled);
    void settled.finally(() => inFlight.delete(settled));
  }

  function changed(): void {
    const snapshot = list();
    // Chained so two changes close together cannot land on disk in the wrong order.
    saving = saving.then(() => deps.save(snapshot)).catch(() => undefined);
    deps.emitChanged(snapshot);
  }

  function syncTimer(): void {
    const active = [...sessions.values()].some((session) => !isFinished(session));
    if (active && !timer) {
      timer = setInterval(() => track(tick()), AUTO_FIX_TICK_MS);
    } else if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function dispatch(id: string, event: AutoFixEvent): AutoFixSession | null {
    const session = sessions.get(id);
    if (!session) return null;
    const { session: next, effects } = reduceAutoFix(session, event, deps.now());
    if (next !== session) {
      sessions.set(id, next);
      // Once the session moves past its agent, the tab goes back to being an ordinary tab.
      const tab = currentTab(session);
      if (tab && TAB_PHASES.has(session.phase) && !TAB_PHASES.has(next.phase)) {
        deps.agentStatus.unpin(tab);
      }
      changed();
    }
    for (const effect of effects) track(perform(next, effect));
    syncTimer();
    return next;
  }

  async function perform(session: AutoFixSession, effect: AutoFixEffect): Promise<void> {
    switch (effect.type) {
      case 'launch':
        return launch(session.id, effect.attempt, effect.runId);
      case 'commit':
        return commit(session.id, effect.attempt);
      case 'notify':
        deps.notify(session, effect.kind);
        return;
    }
  }

  function blockLaunch(id: string, blocker: 'read-failed' | 'launch-failed', message: string) {
    dispatch(id, { type: 'launch-blocked', blocker, message });
  }

  async function launch(id: string, attempt: number, runId: number): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    const project = await deps.project(session.projectId).catch(() => null);
    if (!project) return blockLaunch(id, 'launch-failed', 'That project no longer exists.');

    let run: AutoFixRunView;
    try {
      run = await deps.getRun(session.repo, runId);
    } catch (error) {
      return blockLaunch(
        id,
        'read-failed',
        `Could not read the run from GitHub: ${errorText(error)}`,
      );
    }
    if (!run.headSha) {
      return blockLaunch(id, 'read-failed', 'GitHub did not say which commit the run tested.');
    }

    const ready = await deps.preflight(project.folderPath, session.branch, run.headSha).catch(
      (error: unknown): AutoFixPreflight => ({
        ok: false,
        blocker: 'launch-failed',
        message: errorText(error),
      }),
    );
    if (!ready.ok) {
      dispatch(id, { type: 'launch-blocked', blocker: ready.blocker, message: ready.message });
      return;
    }

    const runInput: GithubActionsRunErrorInput = {
      repo: session.repo,
      runId,
      workflowName: session.workflowName,
      displayTitle: run.displayTitle,
      runNumber: run.runNumber,
      headBranch: session.branch,
    };
    const failure = await deps.failureText(runInput).catch(
      (error: unknown): GithubActionsRunErrorResult => ({
        ok: false,
        error: errorText(error),
      }),
    );
    if (!failure.ok) {
      return blockLaunch(
        id,
        'read-failed',
        `Could not read the failure from GitHub: ${failure.error}`,
      );
    }

    let launched: AutoFixLaunchResult;
    try {
      launched = await deps.launch({
        sessionId: id,
        projectId: session.projectId,
        cwd: project.folderPath,
        cliId: session.cliId,
        runArgs: session.runArgs,
        runLabel: session.runLabel,
        runNumber: run.runNumber,
        attempt,
        prompt: buildFixRunPrompt(runInput, failure.text, {
          attempt,
          maxAttempts: session.maxAttempts,
        }),
      });
    } catch (error) {
      return blockLaunch(id, 'launch-failed', errorText(error));
    }
    // The tab shows even when the user stopped meanwhile: an agent is running in it either way.
    deps.emitTab(launched.tab);
    const next = dispatch(id, {
      type: 'launched',
      tabId: launched.tabId,
      baseSha: ready.baseSha,
      hooks: launched.hooks,
    });
    if (next?.phase !== 'fixing') deps.agentStatus.unpin(launched.tabId);
  }

  async function commit(id: string, attemptNo: number): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    const attempt = session.attempts.find((item) => item.n === attemptNo);
    const project = await deps.project(session.projectId).catch(() => null);
    const result: AutoFixCommitResult = !project
      ? { kind: 'blocked', blocker: 'commit-failed', message: 'That project no longer exists.' }
      : await deps
          .commit(project.folderPath, {
            branch: session.branch,
            baseSha: attempt?.baseSha ?? null,
            message: autoFixCommitMessage({
              workflowName: session.workflowName,
              runNumber: attempt?.runNumber ?? null,
              attempt: attemptNo,
              maxAttempts: session.maxAttempts,
            }),
          })
          .catch(
            (error: unknown): AutoFixCommitResult => ({
              kind: 'blocked',
              blocker: 'commit-failed',
              message: errorText(error),
            }),
          );
    dispatch(id, { type: 'committed', result });
    if (result.kind === 'pushed') deps.pushed(session.projectId);
  }

  async function check(id: string): Promise<void> {
    const session = sessions.get(id);
    if (!session) return;
    try {
      if (session.phase === 'watching' && session.runId !== null) {
        const run = await deps.getRun(session.repo, session.runId);
        if (run.status === 'completed') {
          dispatch(id, { type: 'run-finished', conclusion: run.conclusion });
        }
      } else if (session.phase === 'waiting-run' && session.waitFor) {
        const found = await deps.findRun(
          session.repo,
          session.workflowId,
          session.branch,
          session.waitFor,
        );
        if (found) dispatch(id, { type: 'run-found', runId: found.id, runNumber: found.runNumber });
      } else if (session.phase === 'fixing') {
        const tab = currentTab(session);
        if (tab) {
          // The subscription carries every change; reading the status here as well catches up
          // after a restart, and keeps the settle window moving for a CLI without hooks.
          const status = deps.agentStatus.status(tab);
          dispatch(id, status === null ? { type: 'agent-lost' } : { type: 'agent', status });
        }
      }
    } catch {
      // Offline or rate limited. The next tick tries again.
    }
    dispatch(id, { type: 'tick' });
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const session of list()) {
        if (!isFinished(session)) await check(session.id);
      }
    } finally {
      ticking = false;
    }
  }

  async function act(id: string, event: AutoFixEvent): Promise<AutoFixSession | null> {
    return dispatch(id, event);
  }

  return {
    async start() {
      const now = deps.now();
      const loaded = await deps.load().catch(() => []);
      const kept = loaded
        .filter((session) => !isFinished(session) || now - session.updatedAt < KEEP_FINISHED_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_SESSIONS);
      for (const session of kept) sessions.set(session.id, session);
      unsubscribe = deps.agentStatus.subscribe((tabId, status) => {
        for (const session of sessions.values()) {
          if (currentTab(session) === tabId) dispatch(session.id, { type: 'agent', status });
        }
      });
      for (const id of [...sessions.keys()]) dispatch(id, { type: 'resumed' });
      if (kept.length !== loaded.length) changed();
      syncTimer();
    },

    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },

    list,

    async enable(input) {
      const project = await deps.project(input.projectId).catch(() => null);
      if (!project) return { ok: false, error: 'That project no longer exists.' };
      const existing = list().find(
        (session) =>
          !isFinished(session) &&
          session.projectId === input.projectId &&
          session.repo === input.repo &&
          session.workflowId === input.workflowId &&
          session.branch === input.branch,
      );
      if (existing) return { ok: true, session: existing };

      const defaults = await deps.defaults(project);
      const cliId = input.cliId || defaults.cliId;
      if (!cliId || !getCliDefinition(cliId)) {
        return { ok: false, error: 'Pick an agent CLI for auto-fix in Settings first.' };
      }
      // Model flags belong to one CLI, so the saved ones only come along with the saved CLI.
      const fromDefaults = cliId === defaults.cliId;
      const maxAttempts = Math.round(input.maxAttempts ?? defaults.maxAttempts);
      const session = createAutoFixSession(
        {
          projectId: project.id,
          projectName: project.name,
          repo: input.repo,
          workflowId: input.workflowId,
          workflowName: input.workflowName,
          branch: input.branch,
          runId: input.runId ?? null,
          runNumber: input.runNumber ?? null,
          cliId,
          runArgs: input.runArgs ?? (fromDefaults ? defaults.runArgs : []),
          runLabel: input.runLabel ?? (fromDefaults ? defaults.runLabel : null),
          maxAttempts: Math.min(AUTO_FIX_MAX_ATTEMPTS, Math.max(1, maxAttempts || 1)),
        },
        deps.newId(),
        deps.now(),
      );
      sessions.set(session.id, session);
      changed();
      syncTimer();
      return { ok: true, session };
    },

    stop: (id) => act(id, { type: 'stop' }),
    commitNow: (id) => act(id, { type: 'commit-now' }),
    retry: (id) => act(id, { type: 'retry' }),

    async dismiss(id) {
      const session = sessions.get(id);
      if (!session || !isFinished(session)) return false;
      sessions.delete(id);
      changed();
      return true;
    },

    claims(projectId, runId) {
      for (const session of sessions.values()) {
        if (session.projectId !== projectId) continue;
        if (session.runId === runId) return true;
        if (session.attempts.some((item) => item.runId === runId || item.nextRunId === runId)) {
          return true;
        }
      }
      return false;
    },

    tick,

    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}
