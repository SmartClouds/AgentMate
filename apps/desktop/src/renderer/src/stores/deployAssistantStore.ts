import type { EffortLevel } from '@runova/core';
import type { SshAgentProgress } from '@shared/apiTypes';
import type { ExecLine } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAssistantContextInput,
  DeployAssistantOutputEvent,
  DeployAssistantProgressEvent,
} from '@shared/deployAssistantTypes';
import { create } from 'zustand';

/**
 * The Deploy AI drawer (E09 T8): whether it is open, what it was opened on, and each server's run
 * as it goes (a timeline of steps with their output). The run itself lives in the main process,
 * so leaving the page and coming back finds it where it was. A follow-up or a Continue after a
 * stop carries the chat on: the run before it stays above the new one, until a new chat.
 */

/** Output kept per step; the full output stays in the run's history. */
const MAX_STEP_LINES = 400;
const MAX_STEPS = 60;
/** Earlier runs kept on screen in one chat. */
const MAX_TURNS = 20;

export interface AssistantStep {
  step: number;
  command: string;
  /** proposed (waiting on the user), running, done, or skipped. */
  status: 'proposed' | 'running' | 'done' | 'skipped';
  /** Why it waits, when the core or the mode asks for an approval. */
  note?: string;
  lines: ExecLine[];
}

/** A run that is over, kept above the one the chat carried on with. */
export interface AssistantTurn {
  prompt?: string;
  progress: SshAgentProgress | null;
  steps: AssistantStep[];
}

export interface AssistantRun extends AssistantTurn {
  /** The runs before this one in the same chat, oldest first. */
  earlier: AssistantTurn[];
}

/** Which AI decides each step: an agent CLI with its model and effort, or the Settings provider. */
export interface AssistantAiChoice {
  /** Null is the OpenAI, Gemini or Ollama provider set in Settings. */
  cliId: string | null;
  /** Null lets the CLI use the model it is set up with. */
  modelId: string | null;
  effort: EffortLevel | null;
}

export const SETTINGS_AI: AssistantAiChoice = { cliId: null, modelId: null, effort: null };

const EMPTY_RUN: AssistantRun = { progress: null, steps: [], earlier: [] };

interface DeployAssistantStoreState {
  openServerId: string | null;
  /** What "Diagnose with AI" handed over, waiting for the user to start. */
  draft: { serverId: string; context: DeployAssistantContextInput; prompt: string } | null;
  runs: Record<string, AssistantRun>;
  /** The last AI picked in the drawer, kept for the next run and the next time it opens. */
  ai: AssistantAiChoice;
  setAi: (ai: AssistantAiChoice) => void;
  open: (
    serverId: string,
    draft?: { context: DeployAssistantContextInput; prompt: string },
  ) => void;
  close: () => void;
  clearDraft: () => void;
  /** A new chat on the server: its timeline starts empty. */
  reset: (serverId: string, prompt?: string) => void;
  /** A run that carries the chat on: the one before it moves up into the chat's history. */
  followUp: (serverId: string, prompt: string) => void;
  /** Puts a run back as it was, when starting the next one was refused. */
  restore: (serverId: string, run: AssistantRun | undefined) => void;
  progress: (event: DeployAssistantProgressEvent) => void;
  output: (event: DeployAssistantOutputEvent) => void;
}

function updateSteps(steps: AssistantStep[], progress: SshAgentProgress): AssistantStep[] {
  const { command, phase } = progress;
  const last = steps.at(-1);
  if (phase === 'proposed' && command) {
    const step: AssistantStep = {
      step: progress.step,
      command,
      status: 'proposed',
      lines: [],
      ...(progress.message ? { note: progress.message } : {}),
    };
    // The core asked for an approval after the step had started: it is the same step.
    if (last && last.step === progress.step && last.command === command) {
      return [...steps.slice(0, -1), { ...last, status: 'proposed', note: progress.message }];
    }
    return [...steps, step].slice(-MAX_STEPS);
  }
  if (phase === 'running' && command) {
    if (last && last.step === progress.step && last.command === command) {
      return [...steps.slice(0, -1), { ...last, status: 'running' }];
    }
    return [
      ...steps,
      { step: progress.step, command, status: 'running' as const, lines: [] },
    ].slice(-MAX_STEPS);
  }
  if (phase === 'thinking' && last) {
    // The next step began: the one before it is over, run or skipped.
    if (last.status === 'running') return [...steps.slice(0, -1), { ...last, status: 'done' }];
    if (last.status === 'proposed') return [...steps.slice(0, -1), { ...last, status: 'skipped' }];
  }
  if ((phase === 'finished' || phase === 'stopped') && last?.status === 'running') {
    return [...steps.slice(0, -1), { ...last, status: 'done' }];
  }
  return steps;
}

export const useDeployAssistantStore = create<DeployAssistantStoreState>((set) => ({
  openServerId: null,
  draft: null,
  runs: {},
  ai: SETTINGS_AI,
  setAi: (ai) => set({ ai }),
  open: (serverId, draft) =>
    set((state) => ({
      openServerId: serverId,
      draft: draft
        ? { serverId, ...draft }
        : state.draft?.serverId === serverId
          ? state.draft
          : null,
    })),
  close: () => set({ openServerId: null }),
  clearDraft: () => set({ draft: null }),
  reset: (serverId, prompt) =>
    set((state) => ({
      runs: { ...state.runs, [serverId]: { ...EMPTY_RUN, ...(prompt ? { prompt } : {}) } },
    })),
  followUp: (serverId, prompt) =>
    set((state) => {
      const run = state.runs[serverId] ?? EMPTY_RUN;
      const { earlier, ...last } = run;
      const kept = last.steps.length > 0 || last.prompt || last.progress;
      return {
        runs: {
          ...state.runs,
          [serverId]: {
            ...EMPTY_RUN,
            prompt,
            earlier: kept ? [...earlier, last].slice(-MAX_TURNS) : earlier,
          },
        },
      };
    }),
  restore: (serverId, run) =>
    set((state) => {
      const { [serverId]: _current, ...others } = state.runs;
      return { runs: run ? { ...others, [serverId]: run } : others };
    }),
  progress: ({ serverId, progress }) =>
    set((state) => {
      const run = state.runs[serverId] ?? EMPTY_RUN;
      return {
        runs: {
          ...state.runs,
          [serverId]: { ...run, progress, steps: updateSteps(run.steps, progress) },
        },
      };
    }),
  output: ({ serverId, command, lines }) =>
    set((state) => {
      const run = state.runs[serverId];
      const last = run?.steps.at(-1);
      if (!run || !last || last.command !== command) return state;
      const updated = { ...last, lines: [...last.lines, ...lines].slice(-MAX_STEP_LINES) };
      return {
        runs: {
          ...state.runs,
          [serverId]: { ...run, steps: [...run.steps.slice(0, -1), updated] },
        },
      };
    }),
}));
