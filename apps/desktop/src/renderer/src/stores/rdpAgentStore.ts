import type {
  RdpAgentPhase,
  RdpAgentProgress,
  SshAgentMode,
  StartRdpAgentTaskInput,
} from '@shared/apiTypes';
import { create } from 'zustand';
import type { SshAgentAiChoice } from './sshAgentStore';

export interface RdpAgentSessionState {
  mode: SshAgentMode;
  phase: RdpAgentPhase;
  step: number;
  /** The action as the AI wrote it, e.g. `CLICK 512 300`. */
  action?: string;
  /** Where a proposed pointer action lands, as fractions of the desktop. */
  target?: { x: number; y: number };
  message?: string;
  /** Set on an `error` the run is paused on, rather than ended by. */
  canContinue?: boolean;
  /** Messages the user sent mid-run that the AI has not read yet. */
  queuedMessages?: number;
}

/** The AI the user picked last time: a CLI with its model and effort, or null for Settings' provider. */
export type RdpAgentAiChoice = SshAgentAiChoice;

interface RdpAgentStoreState {
  sessions: Record<string, RdpAgentSessionState>;
  /** The mode the user picked last time, seeded into the dialog's next open. */
  lastMode: SshAgentMode;
  /** Same for the AI choice. Undefined until the dialog has been used once. */
  lastAi: RdpAgentAiChoice | undefined;
  clear: (sessionId: string) => void;
}

export const useRdpAgentStore = create<RdpAgentStoreState>((set) => ({
  sessions: {},
  lastMode: 'approve-all',
  lastAi: undefined,
  clear: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) return state;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }),
}));

export function useRdpAgentSession(sessionId: string | null): RdpAgentSessionState | undefined {
  return useRdpAgentStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
}

/** True whenever the run can still act (waiting on the AI, or waiting on the user's OK/answer). */
export function isRdpAgentActive(state: RdpAgentSessionState | undefined): boolean {
  if (!state) return false;
  if (state.phase === 'error') return state.canContinue === true;
  return state.phase !== 'finished' && state.phase !== 'stopped';
}

/** True while the run can't go on until the user does something. */
export function isRdpAgentWaitingOnUser(state: RdpAgentSessionState | undefined): boolean {
  if (!state) return false;
  return (
    state.phase === 'proposed' ||
    state.phase === 'needs-input' ||
    (state.phase === 'error' && state.canContinue === true)
  );
}

export async function startRdpAgentTask(input: StartRdpAgentTaskInput): Promise<void> {
  const { sessionId, mode } = input;
  useRdpAgentStore.setState((state) => ({
    lastMode: mode,
    lastAi: {
      cliId: input.cliId ?? null,
      modelId: input.modelId ?? null,
      effort: input.effort ?? null,
    },
    sessions: { ...state.sessions, [sessionId]: { mode, phase: 'thinking', step: 0 } },
  }));
  try {
    await window.agentmat.rdpAgent.start(input);
  } catch (error) {
    useRdpAgentStore.getState().clear(sessionId);
    throw error;
  }
}

export function approveRdpAgentAction(sessionId: string): void {
  void window.agentmat.rdpAgent.approveAction(sessionId);
}

export function skipRdpAgentAction(sessionId: string): void {
  void window.agentmat.rdpAgent.skipAction(sessionId);
}

export function answerRdpAgentInput(sessionId: string, answer: string): void {
  void window.agentmat.rdpAgent.answerNeedsInput(sessionId, answer);
}

/** Sends the running task a message of the user's own. False when the task has ended by now. */
export async function sendRdpAgentMessage(sessionId: string, text: string): Promise<boolean> {
  return window.agentmat.rdpAgent.sendMessage(sessionId, text);
}

export function stopRdpAgentTask(sessionId: string): void {
  void window.agentmat.rdpAgent.stop(sessionId);
}

export function continueRdpAgentTask(sessionId: string): void {
  void window.agentmat.rdpAgent.continueTask(sessionId);
}

/**
 * Starts following AI-task progress in this Remote Desktop window. `title` names the session in
 * the notification sent when the run waits on the user while nobody is looking at the window.
 * Returns a function that stops following.
 */
export function initRdpAgentStatus(title: () => string): () => void {
  return window.agentmat.rdpAgent.onProgress((progress: RdpAgentProgress) => {
    useRdpAgentStore.setState((state) => {
      const existing = state.sessions[progress.sessionId];
      const next: RdpAgentSessionState = {
        mode: existing?.mode ?? state.lastMode,
        phase: progress.phase,
        step: progress.step,
        action: progress.action ?? existing?.action,
        target: progress.target,
        message: progress.message,
        canContinue: progress.canContinue,
        queuedMessages: progress.queuedMessages,
      };
      return { sessions: { ...state.sessions, [progress.sessionId]: next } };
    });

    const now = useRdpAgentStore.getState().sessions[progress.sessionId];
    const watching = document.hasFocus() && document.visibilityState === 'visible';
    if (isRdpAgentWaitingOnUser(now) && !watching) {
      void window.agentmat.rdpAgent.notifyWaiting(progress.sessionId, title());
    }
  });
}
