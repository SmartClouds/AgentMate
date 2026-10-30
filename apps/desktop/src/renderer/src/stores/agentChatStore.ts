import { type ChatReader, type ChatState, chatReaderFor, emptyChatState } from '@runova/core';
import { create } from 'zustand';
import type { WorkspaceTerminalTab } from './workspaceStore';

export type AgentChatStatus = 'loading' | 'waiting' | 'ready';

export interface AgentChat {
  /** Loading until main answers, waiting while the CLI has not written a transcript yet. */
  status: AgentChatStatus;
  state: ChatState;
}

interface AgentChatState {
  /** Conversations shown in a chat view right now, by terminal session id. */
  chats: Record<string, AgentChat>;
  /** What was typed in each tab's chat box and not sent yet; outlives the view. */
  drafts: Record<string, string>;
  setDraft: (sessionId: string, text: string) => void;
}

export const useAgentChatStore = create<AgentChatState>((set) => ({
  chats: {},
  drafts: {},
  setDraft: (sessionId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [sessionId]: text } })),
}));

interface Open {
  views: number;
  reader: ChatReader;
  off: () => void;
}

const open = new Map<string, Open>();

function setChat(sessionId: string, chat: AgentChat): void {
  useAgentChatStore.setState((state) => ({ chats: { ...state.chats, [sessionId]: chat } }));
}

function apply(sessionId: string, lines: string[], reset: boolean): void {
  const entry = open.get(sessionId);
  if (!entry) return;
  const current = useAgentChatStore.getState().chats[sessionId];
  const base = reset || !current ? emptyChatState() : current.state;
  setChat(sessionId, { status: 'ready', state: entry.reader(base, lines) });
}

/**
 * Starts showing a tab's conversation as a chat: main finds the transcript its CLI writes and
 * sends what is added. Returns the release for the view; the last one to let go stops the
 * reading and drops the conversation (the draft stays for when the chat opens again).
 */
export function openAgentChat(tab: WorkspaceTerminalTab): () => void {
  const reader = chatReaderFor(tab.cliId);
  if (!reader || !tab.cliId) return () => undefined;
  const sessionId = tab.id;
  const existing = open.get(sessionId);
  if (existing) existing.views += 1;
  else {
    const off = window.runova.agentChat.onAppend((append) => {
      if (append.sessionId === sessionId) apply(sessionId, append.lines, append.reset);
    });
    const entry: Open = { views: 1, reader, off };
    open.set(sessionId, entry);
    setChat(sessionId, { status: 'loading', state: emptyChatState() });
    void window.runova.agentChat
      .subscribe({
        sessionId,
        cliId: tab.cliId,
        cwd: tab.cwd,
        startedAt: tab.createdAt,
        ...(tab.conversationId ? { conversationId: tab.conversationId } : {}),
      })
      .then((result) => {
        if (open.get(sessionId) !== entry) return;
        if (result?.status === 'ready') apply(sessionId, result.lines, true);
        else {
          const current = useAgentChatStore.getState().chats[sessionId];
          // Lines may already have come in while the answer was on its way.
          if (current?.status === 'loading') setChat(sessionId, { ...current, status: 'waiting' });
        }
      })
      .catch(() => undefined);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const entry = open.get(sessionId);
    if (!entry) return;
    entry.views -= 1;
    if (entry.views > 0) return;
    entry.off();
    open.delete(sessionId);
    void window.runova.agentChat.unsubscribe(sessionId);
    useAgentChatStore.setState((state) => {
      const { [sessionId]: _gone, ...chats } = state.chats;
      return { chats };
    });
  };
}
