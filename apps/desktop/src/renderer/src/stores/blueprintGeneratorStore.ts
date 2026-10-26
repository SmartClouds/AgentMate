import type { EffortLevel } from '@runova/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** What writes a project's Blueprint prompt when the user clicks Generate. */
export interface BlueprintGeneratorChoice {
  /** Agent CLI to write it with, or null for the AI provider set in Settings. */
  cliId: string | null;
  /** Model id from that CLI's run profile, or null for whatever the CLI is set up with. */
  modelId: string | null;
  effort: EffortLevel | null;
}

interface BlueprintGeneratorState {
  /** Per project. A project with no entry yet gets a choice picked from what is installed. */
  choices: Record<string, BlueprintGeneratorChoice>;
  setChoice: (projectId: string, choice: BlueprintGeneratorChoice) => void;
}

const STORE_NAME = 'runova-blueprint-generator';

export const useBlueprintGeneratorStore = create<BlueprintGeneratorState>()(
  persist(
    (set) => ({
      choices: {},
      setChoice: (projectId, choice) =>
        set((state) => ({ choices: { ...state.choices, [projectId]: choice } })),
    }),
    { name: STORE_NAME },
  ),
);

// Another window writing the same localStorage key would otherwise leave this one's copy stale.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORE_NAME) void useBlueprintGeneratorStore.persist.rehydrate();
  });
}
