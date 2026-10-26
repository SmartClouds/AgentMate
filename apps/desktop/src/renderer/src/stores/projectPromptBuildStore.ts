import type { PromptType, TargetAI } from '@runova/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectPromptBuildEntry {
  rawInput: string;
  promptType: PromptType;
  /** Absent until the user picks one; the form then follows the project's agent. */
  targetAI?: TargetAI;
  generated: string;
  /**
   * What produced `generated`. A translation or a spoken prompt is not shaped by a prompt type,
   * so sizing it has to leave the type out. Absent for entries saved before this was recorded.
   */
  generatedSource?: 'generate' | 'translate' | 'dictate';
}

const EMPTY_ENTRY: ProjectPromptBuildEntry = {
  rawInput: '',
  promptType: 'Full Stack',
  generated: '',
};

interface ProjectPromptBuildState {
  entries: Record<string, ProjectPromptBuildEntry>;
  update: (projectId: string, patch: Partial<ProjectPromptBuildEntry>) => void;
  clear: (projectId: string) => void;
}

const STORE_NAME = 'runova-project-prompt-build';

export const useProjectPromptBuildStore = create<ProjectPromptBuildState>()(
  persist(
    (set) => ({
      entries: {},
      update: (projectId, patch) =>
        set((state) => ({
          entries: {
            ...state.entries,
            [projectId]: { ...EMPTY_ENTRY, ...state.entries[projectId], ...patch },
          },
        })),
      clear: (projectId) =>
        set((state) => ({
          entries: { ...state.entries, [projectId]: { ...EMPTY_ENTRY } },
        })),
    }),
    { name: STORE_NAME },
  ),
);

// The dialog and the pinned desktop widget run in separate Electron
// BrowserWindows, each with its own in-memory copy of this store. Without
// this, edits made in one window (e.g. the widget) never reach the other's
// memory until the app restarts, even though both persist to the same
// localStorage, so reopening the dialog after using the widget shows stale
// data. Re-hydrate from storage whenever another window writes to it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORE_NAME) {
      void useProjectPromptBuildStore.persist.rehydrate();
    }
  });
}

export function getProjectPromptBuildEntry(projectId: string): ProjectPromptBuildEntry {
  return useProjectPromptBuildStore.getState().entries[projectId] ?? EMPTY_ENTRY;
}
