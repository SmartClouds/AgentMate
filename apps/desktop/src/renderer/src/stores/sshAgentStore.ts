import type { EffortLevel } from '@runova/core';
import type {
  SshAgentHistoryRun,
  SshAgentMode,
  SshAgentPhase,
  SshAgentProgress,
  StartSshAgentTaskInput,
} from '@shared/apiTypes';
import { create } from 'zustand';
import { useTerminalStore } from './terminalStore';

export interface SshAgentSessionState {
  mode: SshAgentMode;
  phase: SshAgentPhase;
  step: number;
  command?: string;
  message?: string;
  hasSavedPassword?: boolean;
  /** Set on an `error` the run is paused on, rather than ended by. */
  canContinue?: boolean;
  /** Messages the user sent mid-run that the AI has not read yet. */
  queuedMessages?: number;
}

/** A past task the Ask AI dialog opens on: to run it again, or to continue it. */
export interface SshAskAiPrefill {
  run: SshAgentHistoryRun;
  intent: 'rerun' | 'continue';
  /** What to do next, when it was already typed elsewhere (the server's history). */
  followUp?: string;
}

/** The AI the user picked last time: a CLI with its model and effort, or null for Settings' provider. */
export interface SshAgentAiChoice {
  cliId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
}

interface SshAgentStoreState {
  sessions: Record<string, SshAgentSessionState>;
  /** The mode the user picked last time, seeded into the dialog's next open. */
  lastMode: SshAgentMode;
  /** Same for the AI choice. Undefined until the dialog has been used once. */
  lastAi: SshAgentAiChoice | undefined;
  /**
   * Set by a history that is not in a terminal (the server's) to have that tab's Ask AI dialog
   * open on a past task. The terminal drawer takes it once the tab is showing.
   */
  askAiRequest: { sessionId: string; prefill: SshAskAiPrefill } | null;
  clear: (sessionId: string) => void;
}

export const useSshAgentStore = create<SshAgentStoreState>((set) => ({
  sessions: {},
  lastMode: 'approve-all',
  lastAi: undefined,
  askAiRequest: null,
  clear: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),
}));

export function useSshAgentSession(sessionId: string | null): SshAgentSessionState | undefined {
  return useSshAgentStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
}

/** True whenever the run can still act (waiting on the AI, or waiting on the user's OK/answer). */
export function isSshAgentActive(state: SshAgentSessionState | undefined): boolean {
  if (!state) return false;
  if (state.phase === 'error') return state.canContinue === true;
  return state.phase !== 'finished' && state.phase !== 'stopped';
}

/** True while the run can't go on until the user does something. */
export function isSshAgentWaitingOnUser(state: SshAgentSessionState | undefined): boolean {
  if (!state) return false;
  return (
    state.phase === 'proposed' ||
    state.phase === 'needs-input' ||
    state.phase === 'needs-password' ||
    (state.phase === 'error' && state.canContinue === true)
  );
}

export async function startSshAgentTask(input: StartSshAgentTaskInput): Promise<void> {
  const { sessionId, mode } = input;
  useSshAgentStore.setState((state) => ({
    lastMode: mode,
    lastAi: {
      cliId: input.cliId ?? null,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
    },
    sessions: { ...state.sessions, [sessionId]: { mode, phase: 'thinking', step: 0 } },
  }));
  try {
    await window.runova.sshAgent.start(input);
  } catch (error) {
    useSshAgentStore.getState().clear(sessionId);
    throw error;
  }
}

/**
 * Starts a task in this terminal that carries on from an earlier one, run the way that one ran.
 * A task saved before its settings were kept runs with the last choices instead.
 */
export function continueSshAgentTaskFrom(
  sessionId: string,
  target: 'ssh' | 'local',
  run: SshAgentHistoryRun,
  followUp: string,
): Promise<void> {
  const { lastMode, lastAi } = useSshAgentStore.getState();
  const settings = run.settings;
  return startSshAgentTask({
    sessionId,
    target,
    prompt: followUp,
    mode: settings?.mode ?? lastMode,
    cliId: settings ? settings.cliId : (lastAi?.cliId ?? null),
    modelId: settings ? settings.modelId : (lastAi?.modelId ?? null),
    effort: settings ? settings.effort : (lastAi?.effort ?? null),
    continueFromRunId: run.id,
  });
}

export function approveSshAgentCommand(sessionId: string): void {
  void window.runova.sshAgent.approveCommand(sessionId);
}

export function skipSshAgentCommand(sessionId: string): void {
  void window.runova.sshAgent.skipCommand(sessionId);
}

export function answerSshAgentInput(sessionId: string, answer: string): void {
  void window.runova.sshAgent.answerNeedsInput(sessionId, answer);
}

/**
 * Tells a running task something new. False means it was over by now and nothing was sent, so the
 * caller keeps the text instead of losing it.
 */
export async function sendSshAgentMessage(sessionId: string, text: string): Promise<boolean> {
  return window.runova.sshAgent.sendMessage(sessionId, text);
}

export function answerSshAgentPassword(sessionId: string, approved: boolean): void {
  void window.runova.sshAgent.answerPassword(sessionId, approved);
}

export function stopSshAgentTask(sessionId: string): void {
  void window.runova.sshAgent.stop(sessionId);
}

export function continueSshAgentTask(sessionId: string): void {
  void window.runova.sshAgent.continueTask(sessionId);
}

/**
 * Whether the user can see this terminal right now: Runova is the focused app, the terminal
 * panel is open, and this is the tab it shows.
 */
function isWatchingSession(sessionId: string): boolean {
  const terminal = useTerminalStore.getState();
  return (
    document.hasFocus() &&
    document.visibilityState === 'visible' &&
    terminal.isOpen &&
    terminal.activeSessionId === sessionId
  );
}

let started = false;

/** Starts following AI-task progress for every SSH session, for the whole app's lifetime. */
export function initSshAgentStatus(): void {
  if (started) return;
  started = true;
  window.runova.sshAgent.onProgress((progress: SshAgentProgress) => {
    useSshAgentStore.setState((state) => {
      const existing = state.sessions[progress.sessionId];
      const next: SshAgentSessionState = {
        mode: existing?.mode ?? state.lastMode,
        phase: progress.phase,
        step: progress.step,
        command: progress.command ?? existing?.command,
        message: progress.message,
        hasSavedPassword: progress.hasSavedPassword,
        canContinue: progress.canContinue,
        queuedMessages: progress.queuedMessages,
      };
      return { sessions: { ...state.sessions, [progress.sessionId]: next } };
    });

    const now = useSshAgentStore.getState().sessions[progress.sessionId];
    if (isSshAgentWaitingOnUser(now) && !isWatchingSession(progress.sessionId)) {
      const title =
        useTerminalStore.getState().sessions.find((s) => s.id === progress.sessionId)?.title ?? '';
      void window.runova.sshAgent.notifyWaiting(progress.sessionId, title);
    }
  });
}
