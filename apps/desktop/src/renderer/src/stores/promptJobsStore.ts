import type { EffortLevel, RunRecommendation } from '@runova/core';
import { recommendationFromAssessment } from '@runova/core';
import { create } from 'zustand';

/**
 * Prompt work (generate, translate, and sizing the run) that has to outlive the form that
 * started it. A closed dialog or a page change unmounts the component, but a request that's
 * already on its way should still land, so its progress and result live here, keyed by
 * whichever form owns them (e.g. `project:<id>`).
 *
 * Deliberately not persisted: a request can't survive a reload, so neither should a spinner.
 */

export type PromptTaskKind = 'generate' | 'translate';

export interface PromptTask {
  kind: PromptTaskKind;
  /** Lets a finished request tell whether it was cleared or replaced while it ran. */
  id: string;
  /** Lets Clear or Cancel abort the request in the main process. */
  requestId?: string;
}

export type RunAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';

export interface RunAnalysis {
  recommendation: RunRecommendation;
  /** The exact text that was sized, to tell when the generated prompt has moved on. */
  prompt: string;
  cliName: string | null;
}

export interface RunOverride {
  modelId: string;
  effort: EffortLevel | undefined;
}

export interface RunJob {
  status: RunAnalysisStatus;
  analysis: RunAnalysis | null;
  error: string | null;
  override: RunOverride | null;
  requestId: string | null;
}

export const EMPTY_RUN_JOB: RunJob = {
  status: 'idle',
  analysis: null,
  error: null,
  override: null,
  requestId: null,
};

interface PromptJobsState {
  tasks: Record<string, PromptTask | undefined>;
  runs: Record<string, RunJob | undefined>;
  /** Forms currently on screen, so a result that lands behind a closed one can say so. */
  visible: Record<string, boolean | undefined>;
  setTask: (key: string, task: PromptTask | null) => void;
  patchRun: (key: string, patch: Partial<RunJob>) => void;
  setVisible: (key: string, visible: boolean) => void;
}

export function projectPromptJobKey(projectId: string): string {
  return `project:${projectId}`;
}

export const usePromptJobsStore = create<PromptJobsState>()((set) => ({
  tasks: {},
  runs: {},
  visible: {},
  setTask: (key, task) => set((state) => ({ tasks: { ...state.tasks, [key]: task ?? undefined } })),
  setVisible: (key, visible) => set((state) => ({ visible: { ...state.visible, [key]: visible } })),
  patchRun: (key, patch) =>
    set((state) => ({
      runs: { ...state.runs, [key]: { ...EMPTY_RUN_JOB, ...state.runs[key], ...patch } },
    })),
}));

function getRun(key: string): RunJob {
  return usePromptJobsStore.getState().runs[key] ?? EMPTY_RUN_JOB;
}

/** Marks `kind` as running for `key` and returns the task, or null when something already runs. */
export function beginPromptTask(
  key: string,
  kind: PromptTaskKind,
  requestId?: string,
): PromptTask | null {
  const { tasks, setTask } = usePromptJobsStore.getState();
  if (tasks[key]) return null;
  const task: PromptTask = { kind, id: crypto.randomUUID(), requestId };
  setTask(key, task);
  return task;
}

/** True while `task` is still the one registered for `key` (not cleared or replaced). */
export function isCurrentPromptTask(key: string, task: PromptTask): boolean {
  return usePromptJobsStore.getState().tasks[key]?.id === task.id;
}

export function finishPromptTask(key: string, task: PromptTask): void {
  if (isCurrentPromptTask(key, task)) usePromptJobsStore.getState().setTask(key, null);
}

/** Drops whatever runs for `key` so its result is discarded, aborting the request if it can. */
export function cancelPromptTask(key: string): void {
  const task = usePromptJobsStore.getState().tasks[key];
  if (!task) return;
  usePromptJobsStore.getState().setTask(key, null);
  if (!task.requestId) return;
  if (task.kind === 'translate') void window.runova.translate.cancel(task.requestId);
  else void window.runova.ai.cancel(task.requestId);
}

export interface StartRunAssessmentInput {
  prompt: string;
  targetAI: string;
  /** Left out for translations, which aren't shaped by a prompt type. */
  promptType?: string;
}

/** Sizes `prompt` with the default AI CLI, replacing any sizing already running for `key`. */
export function startRunAssessment(key: string, input: StartRunAssessmentInput): void {
  const prompt = input.prompt.trim();
  if (!prompt) return;
  const { patchRun } = usePromptJobsStore.getState();
  const previous = getRun(key).requestId;
  if (previous) void window.runova.ai.cancelAssessRun(previous);
  const requestId = crypto.randomUUID();
  const target = input.targetAI;
  patchRun(key, { status: 'analyzing', error: null, requestId });

  const isCurrent = () => getRun(key).requestId === requestId;
  window.runova.ai
    .assessRun({ prompt, targetAI: target, promptType: input.promptType, requestId })
    .then((result) => {
      if (!isCurrent()) return;
      if (result.ok && result.assessment) {
        patchRun(key, {
          analysis: {
            recommendation: recommendationFromAssessment(target, result.assessment),
            prompt,
            cliName: result.cliName,
          },
          override: null,
          status: 'ready',
          requestId: null,
        });
        return;
      }
      if (result.cancelled) {
        // Any earlier result stays on screen; the panel shows it whenever one exists.
        patchRun(key, { status: 'idle', requestId: null });
        return;
      }
      patchRun(key, {
        error: result.error || 'The AI CLI could not size this prompt.',
        status: 'error',
        requestId: null,
      });
    })
    .catch((err: unknown) => {
      if (!isCurrent()) return;
      patchRun(key, {
        error: err instanceof Error ? err.message : 'The AI CLI could not size this prompt.',
        status: 'error',
        requestId: null,
      });
    });
}

export function cancelRunAssessment(key: string): void {
  const { requestId, status } = getRun(key);
  if (!requestId) return;
  void window.runova.ai.cancelAssessRun(requestId);
  usePromptJobsStore
    .getState()
    .patchRun(key, { requestId: null, status: status === 'analyzing' ? 'idle' : status });
}
