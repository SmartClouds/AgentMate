import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiProvider } from '../../../shared/apiTypes';

export interface AskAiMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  provider: AiProvider;
  model: string;
  createdAt: string;
  bookmarked?: boolean;
}

interface AskAiState {
  isModalOpen: boolean;
  provider: AiProvider;
  openaiModel: string;
  ollamaModel: string;
  geminiModel: string;
  messages: AskAiMessage[];
  openModal: () => void;
  closeModal: () => void;
  setProvider: (provider: AiProvider) => void;
  setOpenaiModel: (model: string) => void;
  setOllamaModel: (model: string) => void;
  setGeminiModel: (model: string) => void;
  addMessage: (message: AskAiMessage) => void;
  clearMessages: () => void;
  toggleBookmark: (id: string) => void;
  replaceMessage: (id: string, message: AskAiMessage) => void;
}

export const useAskAiStore = create<AskAiState>()(
  persist(
    (set) => ({
      isModalOpen: false,
      provider: 'openai',
      openaiModel: '',
      ollamaModel: '',
      geminiModel: '',
      messages: [],
      openModal: () => set({ isModalOpen: true }),
      closeModal: () => set({ isModalOpen: false }),
      setProvider: (provider) => set({ provider }),
      setOpenaiModel: (openaiModel) => set({ openaiModel }),
      setOllamaModel: (ollamaModel) => set({ ollamaModel }),
      setGeminiModel: (geminiModel) => set({ geminiModel }),
      addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
      clearMessages: () => set({ messages: [] }),
      toggleBookmark: (id) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, bookmarked: !m.bookmarked } : m)),
        })),
      replaceMessage: (id, message) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === id ? message : m)) })),
    }),
    {
      name: 'runova-ask-ai',
      // The modal's open/closed state shouldn't survive a restart; only the conversation should.
      partialize: (s) => ({
        provider: s.provider,
        openaiModel: s.openaiModel,
        ollamaModel: s.ollamaModel,
        geminiModel: s.geminiModel,
        messages: s.messages,
      }),
    },
  ),
);
