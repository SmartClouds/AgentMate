import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AiProvider, HelpSource } from '../../../shared/apiTypes';

export interface HelpMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** The passages an answer cites, for the links under it. */
  sources?: HelpSource[];
  /** Why an answer fell back to keyword search, shown quietly under it. */
  notice?: string;
  provider: AiProvider;
  model: string;
  createdAt: string;
}

interface HelpState {
  /** Whether the guide panel is open beside the Help page. */
  chatOpen: boolean;
  messages: HelpMessage[];
  setChatOpen: (open: boolean) => void;
  addMessage: (message: HelpMessage) => void;
  clearMessages: () => void;
}

/** The Help page's guide conversation. It is kept apart from Ask AI's, which is about anything. */
export const useHelpStore = create<HelpState>()(
  persist(
    (set) => ({
      chatOpen: false,
      messages: [],
      setChatOpen: (chatOpen) => set({ chatOpen }),
      addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
      clearMessages: () => set({ messages: [] }),
    }),
    {
      name: 'runova-help',
      partialize: (s) => ({ chatOpen: s.chatOpen, messages: s.messages }),
    },
  ),
);
