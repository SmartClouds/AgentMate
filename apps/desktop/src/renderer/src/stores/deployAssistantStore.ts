import type { EffortLevel } from '@runova/core';
import type { SshAgentProgress } from '@shared/apiTypes';
import type { ExecLine } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAssistantAppRef,
  DeployAssistantContextInput,
  DeployAssistantOutputEvent,
  DeployAssistantProgressEvent,
  DeployAssistantState,
} from '@shared/deployAssistantTypes';
import { create } from 'zustand';

/**
 * The Deploy AI drawer (E09 T8): whether it is open, what it was opened on, and each server's run
 * as it goes (a timeline of steps with their output). The run itself lives in the main process,
 * so leaving the page and coming back finds it where it was. A follow-up or a Continue after a
 * stop carries the chat on: the run before it stays above the new one, until a new chat. What is
 * typed in each server's box and the drawer's size live here too, so they outlast the page. So do
 * the app page that is showing (the AI is about that app unless the user takes it off) and a chat
 * picked from the history, which the next question carries on.
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

/** What the user told a run while it was going. */
export interface AssistantMessage {
  text: string;
  /** How many steps the run had when it was sent, so it shows between the right ones. */
  at: number;
  /** A question the AI asked, in a chat read back from the history; the user's otherwise. */
  from?: 'ai';
}

/** A run that is over, kept above the one the chat carried on with. */
export interface AssistantTurn {
  prompt?: string;
  progress: SshAgentProgress | null;
  steps: AssistantStep[];
  messages: AssistantMessage[];
}

export interface AssistantRun extends AssistantTurn {
  /** The runs before this one in the same chat, oldest first. */
  earlier: AssistantTurn[];
  /** The app the chat is about, sent along with each of its runs. */
  app?: DeployAssistantAppRef;
}

/** An app page that is showing, on a Deploy server. */
export interface PageApp extends DeployAssistantAppRef {
  serverId: string;
}

/** Which AI decides each step: an agent CLI with its model and effort, or the Settings provider. */
export interface AssistantAiChoice {
  /** Null is the OpenAI, Gemini or Ollama provider set in Settings. */
  cliId: string | null;
  /** Null lets the CLI use the model it is set up with. */
  modelId: string | null;
  effort: EffortLevel | null;
}

/** A project a CLI works in on this server's runs, and whether it may change the code. */
export interface AssistantProjectChoice {
  projectId: string;
  allowEdits: boolean;
}

export const SETTINGS_AI: AssistantAiChoice = { cliId: null, modelId: null, effort: null };

/** Phases in which the run is still going (an error it can carry on from counts too). */
export const ACTIVE_PHASES = new Set([
  'thinking',
  'proposed',
  'running',
  'needs-input',
  'needs-password',
]);

export function isRunActive(progress: SshAgentProgress | null | undefined): boolean {
  if (!progress) return false;
  return (
    ACTIVE_PHASES.has(progress.phase) ||
    (progress.phase === 'error' && progress.canContinue === true)
  );
}

/** Said when main has no run any more and no last word on it (it was restarted, say). */
export const GONE_MESSAGE = 'The AI is no longer running.';

const EMPTY_RUN: AssistantRun = { progress: null, steps: [], messages: [], earlier: [] };
/** Messages kept on screen per run. */
const MAX_MESSAGES = 50;

interface DeployAssistantStoreState {
  openServerId: string | null;
  /**
   * The Deploy server whose page is showing, which the top bar's Deploy AI button opens the
   * drawer on. Null on every other page, where the button is not shown.
   */
  pageServerId: string | null;
  setPageServer: (serverId: string | null) => void;
  /** The app whose page is showing, which a new chat is about unless the user took it off. */
  pageApp: PageApp | null;
  setPageApp: (app: PageApp | null) => void;
  /** Puts an app on the server's chat, or takes it off with null. Nothing without a chat. */
  setChatApp: (serverId: string, app: DeployAssistantAppRef | null) => void;
  /** Per server, the app the user took off the next chat; null puts it back. */
  dismissedApps: Record<string, string>;
  dismissApp: (serverId: string, stackId: string | null) => void;
  /** Per server, the run a chat picked from the history carries on from. */
  continueFrom: Record<string, string>;
  /** Shows a past chat in the drawer, so the next question carries it on from `runId`. */
  openChat: (serverId: string, run: AssistantRun, runId: string) => void;
  clearContinueFrom: (serverId: string) => void;
  /** What "Diagnose with AI" pointed the AI at, sent along with each run on that server. */
  draft: { serverId: string; context: DeployAssistantContextInput } | null;
  /** What is in each server's task box, so leaving the page does not lose it or bring it back. */
  prompts: Record<string, string>;
  setPrompt: (serverId: string, text: string) => void;
  /** Per server, the files pasted or dropped into the task box, as paths. */
  attachments: Record<string, string[]>;
  setAttachments: (serverId: string, paths: string[]) => void;
  /** The drawer fills the page area, kept while the user goes to other pages. */
  maximized: boolean;
  setMaximized: (maximized: boolean) => void;
  runs: Record<string, AssistantRun>;
  /** The last AI picked in the drawer, kept for the next run and the next time it opens. */
  ai: AssistantAiChoice;
  setAi: (ai: AssistantAiChoice) => void;
  /** Per server, since each one runs its own app's code. */
  projects: Record<string, AssistantProjectChoice>;
  setProject: (serverId: string, project: AssistantProjectChoice | null) => void;
  open: (
    serverId: string,
    draft?: { context: DeployAssistantContextInput; prompt: string },
  ) => void;
  close: () => void;
  clearDraft: () => void;
  /** A new chat on the server: its timeline starts empty. */
  reset: (serverId: string, prompt?: string, app?: DeployAssistantAppRef) => void;
  /**
   * A run that carries the chat on: the one before it moves up into the chat's history. The chat
   * keeps its app unless another one is given.
   */
  followUp: (serverId: string, prompt: string, app?: DeployAssistantAppRef) => void;
  /** A message the run took while it was going. */
  said: (serverId: string, text: string) => void;
  /** Puts a run back as it was, when starting the next one was refused. */
  restore: (serverId: string, run: AssistantRun | undefined) => void;
  progress: (event: DeployAssistantProgressEvent) => void;
  output: (event: DeployAssistantOutputEvent) => void;
  /**
   * Squares the run with main's state of it. A run main no longer has ends here too, so one that
   * ended while nothing was listening does not look stuck with a Stop that does nothing.
   */
  sync: (serverId: string, state: DeployAssistantState) => void;
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
  prompts: {},
  setPrompt: (serverId, text) =>
    set((state) => ({ prompts: { ...state.prompts, [serverId]: text } })),
  attachments: {},
  setAttachments: (serverId, paths) =>
    set((state) => {
      const { [serverId]: _old, ...others } = state.attachments;
      return { attachments: paths.length > 0 ? { ...others, [serverId]: paths } : others };
    }),
  maximized: false,
  setMaximized: (maximized) => set({ maximized }),
  runs: {},
  ai: SETTINGS_AI,
  setAi: (ai) => set({ ai }),
  projects: {},
  setProject: (serverId, project) =>
    set((state) => {
      const { [serverId]: _old, ...others } = state.projects;
      return { projects: project ? { ...others, [serverId]: project } : others };
    }),
  open: (serverId, draft) =>
    set((state) => ({
      openServerId: serverId,
      draft: draft
        ? { serverId, context: draft.context }
        : state.draft?.serverId === serverId
          ? state.draft
          : null,
      // A new "Diagnose with AI" puts its question in the box, over what was there.
      ...(draft ? { prompts: { ...state.prompts, [serverId]: draft.prompt } } : {}),
    })),
  close: () => set({ openServerId: null }),
  pageServerId: null,
  setPageServer: (serverId) => set({ pageServerId: serverId }),
  pageApp: null,
  setPageApp: (app) => set({ pageApp: app }),
  setChatApp: (serverId, app) =>
    set((state) => {
      const run = state.runs[serverId];
      if (!run) return state;
      const { app: _old, ...rest } = run;
      return { runs: { ...state.runs, [serverId]: app ? { ...rest, app } : rest } };
    }),
  dismissedApps: {},
  dismissApp: (serverId, stackId) =>
    set((state) => {
      const { [serverId]: _old, ...others } = state.dismissedApps;
      return { dismissedApps: stackId ? { ...others, [serverId]: stackId } : others };
    }),
  continueFrom: {},
  openChat: (serverId, run, runId) =>
    set((state) => ({
      runs: { ...state.runs, [serverId]: run },
      continueFrom: { ...state.continueFrom, [serverId]: runId },
    })),
  clearContinueFrom: (serverId) =>
    set((state) => {
      const { [serverId]: _old, ...others } = state.continueFrom;
      return { continueFrom: others };
    }),
  clearDraft: () => set({ draft: null }),
  reset: (serverId, prompt, app) =>
    set((state) => {
      const { [serverId]: _old, ...continueFrom } = state.continueFrom;
      return {
        runs: {
          ...state.runs,
          [serverId]: { ...EMPTY_RUN, ...(prompt ? { prompt } : {}), ...(app ? { app } : {}) },
        },
        continueFrom,
      };
    }),
  followUp: (serverId, prompt, app) =>
    set((state) => {
      const run = state.runs[serverId] ?? EMPTY_RUN;
      const { earlier, app: chatApp, ...last } = run;
      const kept =
        last.steps.length > 0 || last.messages.length > 0 || last.prompt || last.progress;
      const keptApp = app ?? chatApp;
      return {
        runs: {
          ...state.runs,
          [serverId]: {
            ...EMPTY_RUN,
            prompt,
            earlier: kept ? [...earlier, last].slice(-MAX_TURNS) : earlier,
            ...(keptApp ? { app: keptApp } : {}),
          },
        },
      };
    }),
  said: (serverId, text) =>
    set((state) => {
      const run = state.runs[serverId];
      if (!run) return state;
      const message = { text, at: run.steps.length };
      return {
        runs: {
          ...state.runs,
          [serverId]: { ...run, messages: [...run.messages, message].slice(-MAX_MESSAGES) },
        },
      };
    }),
  restore: (serverId, run) =>
    set((state) => {
      const { [serverId]: _current, ...others } = state.runs;
      return { runs: run ? { ...others, [serverId]: run } : others };
    }),
  progress: ({ serverId, progress }) =>
    set((state) => withProgress(state.runs, serverId, state.runs[serverId] ?? EMPTY_RUN, progress)),
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
  sync: (serverId, { running, progress }) =>
    set((state) => {
      const run = state.runs[serverId];
      // While main runs, its events keep the run current; a reply older than them must not win.
      if (running) {
        return run || !progress ? state : withProgress(state.runs, serverId, EMPTY_RUN, progress);
      }
      if (!run) return progress ? withProgress(state.runs, serverId, EMPTY_RUN, progress) : state;
      if (!run.progress || !isRunActive(run.progress)) return state;
      const ended: SshAgentProgress = progress ?? {
        sessionId: run.progress.sessionId,
        phase: 'stopped',
        step: run.progress.step,
        message: GONE_MESSAGE,
      };
      return withProgress(state.runs, serverId, run, ended);
    }),
}));

function withProgress(
  runs: Record<string, AssistantRun>,
  serverId: string,
  run: AssistantRun,
  progress: SshAgentProgress,
): { runs: Record<string, AssistantRun> } {
  return {
    runs: { ...runs, [serverId]: { ...run, progress, steps: updateSteps(run.steps, progress) } },
  };
}
