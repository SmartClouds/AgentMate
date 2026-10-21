import { create } from 'zustand';

interface RelayBoardState {
  /** The project whose glass board is open, or null when it is closed. */
  projectId: string | null;
  /** A task whose details open with the board. */
  focusTaskId: string | null;
  open: (projectId: string, focusTaskId?: string) => void;
  close: () => void;
}

/**
 * Which Relay board is on screen. The board is one overlay mounted once in the app, so the
 * workspace panel, the status bar, the project page and Blueprint all open it the same way.
 */
export const useRelayBoardStore = create<RelayBoardState>((set) => ({
  projectId: null,
  focusTaskId: null,
  open: (projectId, focusTaskId) => set({ projectId, focusTaskId: focusTaskId ?? null }),
  close: () => set({ projectId: null, focusTaskId: null }),
}));
