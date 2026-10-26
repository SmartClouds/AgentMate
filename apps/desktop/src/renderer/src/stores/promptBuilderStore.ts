import type { PromptType, TargetAI } from '@runova/core';
import { DEFAULT_TARGET_AI, normalizeTargetAI } from '@runova/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PromptBuilderStatus = 'draft' | 'scheduled';

interface PromptBuilderState {
  rawInput: string;
  promptType: PromptType;
  targetAI: TargetAI;
  generated: string;
  targetLang: string;
  projectId: string | null;
  status: PromptBuilderStatus;
  setRawInput: (v: string) => void;
  setPromptType: (v: PromptType) => void;
  setTargetAI: (v: TargetAI) => void;
  setGenerated: (v: string) => void;
  setTargetLang: (v: string) => void;
  setProjectId: (v: string | null) => void;
  setStatus: (v: PromptBuilderStatus) => void;
}

export const usePromptBuilderStore = create<PromptBuilderState>()(
  persist(
    (set) => ({
      rawInput: '',
      promptType: 'Full Stack',
      targetAI: DEFAULT_TARGET_AI,
      generated: '',
      targetLang: 'en',
      projectId: null,
      status: 'draft',
      setRawInput: (v) => set({ rawInput: v }),
      setPromptType: (v) => set({ promptType: v }),
      setTargetAI: (v) => set({ targetAI: v }),
      setGenerated: (v) => set({ generated: v }),
      setTargetLang: (v) => set({ targetLang: v }),
      setProjectId: (v) => set({ projectId: v }),
      setStatus: (v) => set({ status: v }),
    }),
    {
      name: 'runova-prompt-builder',
      merge: (persisted, current) => {
        const saved = persisted as Partial<PromptBuilderState> | undefined;
        const targetAI = saved?.targetAI ? normalizeTargetAI(saved.targetAI) : DEFAULT_TARGET_AI;
        return { ...current, ...saved, targetAI };
      },
    },
  ),
);
