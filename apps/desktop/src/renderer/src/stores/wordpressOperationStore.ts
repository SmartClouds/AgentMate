import type {
  DeployWordPressCreateProjectInput,
  DeployWordPressDeployResult,
  DeployWordPressItemsInput,
  DeployWordPressLinkProjectInput,
  DeployWordPressLinkProjectResult,
  DeployWordPressOperationKind,
  DeployWordPressPhase,
  DeployWordPressProgressEvent,
  DeployWordPressPullResult,
  DeployWordPressRunInput,
  Project,
} from '@shared/deployWordPressTypes';
import {
  type WordPressErrorCode,
  wordPressErrorCode,
  wordPressErrorMessage,
} from '@shared/wordpressErrors';
import { create } from 'zustand';

/**
 * Pulls, deploys and new WordPress projects (E21), keyed by the operation id the renderer picks.
 * They keep running in the main process when a dialog closes or the page changes, so their
 * progress lives here and a dialog opened again picks up where the run got to.
 */

export type WordPressOperationResult =
  | { kind: 'deploy'; value: DeployWordPressDeployResult }
  | { kind: 'pull'; value: DeployWordPressPullResult }
  | { kind: 'project'; value: Project }
  | { kind: 'link'; value: DeployWordPressLinkProjectResult };

export interface WordPressPhaseProgress {
  done: number;
  total: number;
  bytes?: number;
}

export interface WordPressOperationRun {
  operationId: string;
  kind: DeployWordPressOperationKind;
  siteId: string;
  projectId: string | null;
  /** Every phase reported so far, in the order they first showed up. */
  phases: DeployWordPressPhase[];
  /** The last count each phase reported. */
  progress: Partial<Record<DeployWordPressPhase, WordPressPhaseProgress>>;
  latest: DeployWordPressProgressEvent | null;
  status: 'running' | 'done' | 'failed';
  /** Stop was asked for and the run has not ended yet. */
  cancelling: boolean;
  error: string | null;
  errorCode: WordPressErrorCode | null;
  result: WordPressOperationResult | null;
  /** Started from this window. A run first seen through its progress events is not. */
  owned: boolean;
  startedAt: number;
  finishedAt: number | null;
}

interface RunContext {
  operationId: string;
  kind: DeployWordPressOperationKind;
  siteId: string;
  projectId: string | null;
}

interface WordPressOperationState {
  runs: Record<string, WordPressOperationRun>;
  createProject: (input: DeployWordPressCreateProjectInput) => Promise<Project | null>;
  /** Changes a project's items; newly added ones are pulled. */
  setProjectItems: (input: DeployWordPressItemsInput, siteId: string) => Promise<Project | null>;
  /** Makes an existing project a WordPress project, pulling the items into empty folders. */
  linkProject: (
    input: DeployWordPressLinkProjectInput,
  ) => Promise<DeployWordPressLinkProjectResult | null>;
  deploy: (
    input: DeployWordPressRunInput,
    context: { siteId: string; projectId: string },
  ) => Promise<DeployWordPressDeployResult | null>;
  pull: (
    input: DeployWordPressRunInput,
    context: { siteId: string; projectId: string },
  ) => Promise<DeployWordPressPullResult | null>;
  /** Asks the main process to stop the run at its next safe point. */
  cancel: (operationId: string) => Promise<void>;
  /** Forgets a finished run, once its result has been seen. */
  clear: (operationId: string) => void;
}

/** The newest run that matches, finished or not, until it is cleared. */
export function findWordPressRun(
  runs: Record<string, WordPressOperationRun>,
  match: { kind: DeployWordPressOperationKind; projectId?: string | null; siteId?: string },
): WordPressOperationRun | null {
  let found: WordPressOperationRun | null = null;
  for (const run of Object.values(runs)) {
    if (run.kind !== match.kind) continue;
    if (match.projectId !== undefined && run.projectId !== match.projectId) continue;
    if (match.siteId !== undefined && run.siteId !== match.siteId) continue;
    if (!found || run.startedAt >= found.startedAt) found = run;
  }
  return found;
}

function freshRun(context: RunContext, owned: boolean): WordPressOperationRun {
  return {
    ...context,
    phases: [],
    progress: {},
    latest: null,
    status: 'running',
    cancelling: false,
    error: null,
    errorCode: null,
    result: null,
    owned,
    startedAt: Date.now(),
    finishedAt: null,
  };
}

export const useWordPressOperationStore = create<WordPressOperationState>((set, get) => {
  const update = (
    operationId: string,
    change: (run: WordPressOperationRun) => Partial<WordPressOperationRun>,
  ): void =>
    set((state) => {
      const run = state.runs[operationId];
      return run ? { runs: { ...state.runs, [operationId]: { ...run, ...change(run) } } } : state;
    });

  async function start<T>(
    context: RunContext,
    call: () => Promise<T>,
    toResult: (value: T) => WordPressOperationResult,
  ): Promise<T | null> {
    if (get().runs[context.operationId]?.status === 'running') return null;
    listenForWordPressProgress();
    set((state) => ({
      runs: { ...state.runs, [context.operationId]: freshRun(context, true) },
    }));
    try {
      const value = await call();
      // One update, so whoever sees 'done' also sees the result.
      update(context.operationId, () => ({
        status: 'done',
        result: toResult(value),
        cancelling: false,
        finishedAt: Date.now(),
      }));
      return value;
    } catch (error) {
      update(context.operationId, () => ({
        status: 'failed',
        error: wordPressErrorMessage(error),
        errorCode: wordPressErrorCode(error),
        cancelling: false,
        finishedAt: Date.now(),
      }));
      return null;
    }
  }

  return {
    runs: {},
    createProject: (input) =>
      start(
        {
          operationId: input.operationId,
          kind: 'createProject',
          siteId: input.siteId,
          projectId: null,
        },
        () => window.runova.deployWordPress.createProject(input),
        (value) => ({ kind: 'project', value }),
      ),
    setProjectItems: (input, siteId) =>
      start(
        { operationId: input.operationId, kind: 'items', siteId, projectId: input.projectId },
        () => window.runova.deployWordPress.setProjectItems(input),
        (value) => ({ kind: 'project', value }),
      ),
    linkProject: (input) =>
      start(
        {
          operationId: input.operationId,
          kind: 'items',
          siteId: input.siteId,
          projectId: input.projectId,
        },
        () => window.runova.deployWordPress.linkProject(input),
        (value) => ({ kind: 'link', value }),
      ),
    deploy: (input, context) =>
      start(
        { operationId: input.operationId, kind: 'deploy', ...context },
        () => window.runova.deployWordPress.deploy(input),
        (value) => ({ kind: 'deploy', value }),
      ),
    pull: (input, context) =>
      start(
        { operationId: input.operationId, kind: 'pull', ...context },
        () => window.runova.deployWordPress.pull(input),
        (value) => ({ kind: 'pull', value }),
      ),
    cancel: async (operationId) => {
      const run = get().runs[operationId];
      if (!run || run.status !== 'running') return;
      update(operationId, () => ({ cancelling: true }));
      try {
        await window.runova.deployWordPress.cancel(operationId);
      } catch {
        // The run ends on its own either way, and its call says how.
        update(operationId, () => ({ cancelling: false }));
      }
    },
    clear: (operationId) =>
      set((state) => {
        if (!state.runs[operationId]) return state;
        const { [operationId]: _cleared, ...rest } = state.runs;
        return { runs: rest };
      }),
  };
});

function applyProgress(event: DeployWordPressProgressEvent): void {
  useWordPressOperationStore.setState((state) => {
    const run =
      state.runs[event.operationId] ??
      // A run this window did not start (or started before a reload): show it anyway, and let
      // its own done or failed event end it.
      freshRun(
        {
          operationId: event.operationId,
          kind: event.kind,
          siteId: event.siteId,
          projectId: event.projectId,
        },
        false,
      );
    const next: WordPressOperationRun = { ...run, latest: event };
    if (event.phase !== 'done' && event.phase !== 'failed') {
      if (!run.phases.includes(event.phase)) next.phases = [...run.phases, event.phase];
      next.progress = {
        ...run.progress,
        [event.phase]: { done: event.done, total: event.total, bytes: event.bytes },
      };
    } else if (!run.owned && run.status === 'running') {
      // A run started here ends with its call instead, which also carries the result.
      next.status = event.phase === 'done' ? 'done' : 'failed';
      next.finishedAt = Date.now();
      if (event.phase === 'failed') {
        next.error = wordPressErrorMessage(event.error ?? event.message ?? 'The run failed.');
        next.errorCode = wordPressErrorCode(event.error ?? '');
      }
    }
    return { runs: { ...state.runs, [event.operationId]: next } };
  });
}

/** The bridge the listener is attached to. Tests put a new bridge on the window each time. */
let listeningTo: unknown = null;

/**
 * Attaches the one progress listener this window needs, the first time anything asks. Runs
 * started from here call it themselves; a screen that only shows runs can call it on mount.
 */
export function listenForWordPressProgress(): void {
  const bridge = window.runova;
  if (listeningTo === bridge) return;
  listeningTo = bridge;
  bridge.deployWordPress.onProgress(applyProgress);
}
