import { create } from 'zustand';

/** Split a request into tasks, revise a board against its docs, or plan the rest of a project. */
export type RelayPlanKind = 'split' | 'revise' | 'catch-up';

export interface RelayPlanDialogRequest {
  kind: RelayPlanKind;
  /** The project the plan is for. Null lets the user pick one (split from the Prompt Builder). */
  projectId: string | null;
  /** What the tasks should deliver, for a split. */
  request?: string;
  /** The project the picker starts on, when the user picks one. */
  defaultProjectId?: string | null;
}

interface RelayPlanDialogState {
  /** What the dialog shows. Kept after it closes so the closing animation has something to draw. */
  request: RelayPlanDialogRequest | null;
  open: boolean;
  show: (request: RelayPlanDialogRequest) => void;
  close: () => void;
}

/**
 * Which Relay planning dialog is on screen. Like the board, it is mounted once in the app, so a
 * plan that finished in the background can be reopened from a toast, a notification or the
 * status bar, whatever page started it.
 */
export const useRelayPlanDialogStore = create<RelayPlanDialogState>((set) => ({
  request: null,
  open: false,
  show: (request) => set({ request, open: true }),
  close: () => set({ open: false }),
}));
