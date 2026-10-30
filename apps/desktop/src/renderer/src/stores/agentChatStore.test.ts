import { describe, expect, it, vi } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { openAgentChat, useAgentChatStore } from './agentChatStore';
import type { WorkspaceTerminalTab } from './workspaceStore';

/**
 * The chat view's copy of each open agent conversation, kept up to date from the transcript lines
 * main reads while the CLI runs.
 */

const tab: WorkspaceTerminalTab = {
  kind: 'terminal',
  id: 'tab-1',
  title: 'Claude Code',
  cliId: 'claude-code',
  cwd: 'E:\\proj',
  createdAt: 1_000,
};

const userLine = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', uuid, message: { content: text } });

const chat = () => useAgentChatStore.getState().chats['tab-1'];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('agentChatStore', () => {
  it('subscribes for the tab and reads what is there', async () => {
    const bridge = installRunovaBridge({
      'agentChat.subscribe': { status: 'ready', lines: [userLine('u1', 'hello')] },
    });
    const release = openAgentChat(tab);
    expect(chat()?.status).toBe('loading');
    await settle();

    expect(bridge.$fn('agentChat.subscribe')).toHaveBeenCalledWith({
      sessionId: 'tab-1',
      cliId: 'claude-code',
      cwd: 'E:\\proj',
      startedAt: 1_000,
    });
    expect(chat()?.status).toBe('ready');
    expect(chat()?.state.items).toEqual([expect.objectContaining({ kind: 'user', text: 'hello' })]);
    release();
  });

  it('adds the lines main sends for the tab, and starts over on a reset', async () => {
    const bridge = installRunovaBridge({ 'agentChat.subscribe': { status: 'waiting' } });
    const release = openAgentChat({ ...tab, conversationId: 'conv-1' });
    await settle();
    expect(bridge.$fn('agentChat.subscribe')).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(chat()?.status).toBe('waiting');

    bridge.$emit('agentChat.onAppend', {
      sessionId: 'tab-1',
      lines: [userLine('u1', 'one')],
      reset: true,
    });
    bridge.$emit('agentChat.onAppend', {
      sessionId: 'tab-1',
      lines: [userLine('u2', 'two')],
      reset: false,
    });
    bridge.$emit('agentChat.onAppend', {
      sessionId: 'other-tab',
      lines: [userLine('u3', 'not mine')],
      reset: false,
    });
    expect(chat()?.status).toBe('ready');
    expect(chat()?.state.items.map((item) => item.kind === 'user' && item.text)).toEqual([
      'one',
      'two',
    ]);

    bridge.$emit('agentChat.onAppend', {
      sessionId: 'tab-1',
      lines: [userLine('u9', 'fresh')],
      reset: true,
    });
    expect(chat()?.state.items.map((item) => item.kind === 'user' && item.text)).toEqual(['fresh']);
    release();
  });

  it('stops reading and drops the chat once the last view closes, keeping the draft', async () => {
    const unsubscribe = vi.fn(async () => undefined);
    const bridge = installRunovaBridge({
      'agentChat.subscribe': { status: 'waiting' },
      'agentChat.unsubscribe': unsubscribe,
    });
    const first = openAgentChat(tab);
    const second = openAgentChat(tab);
    await settle();
    expect(bridge.$fn('agentChat.subscribe')).toHaveBeenCalledTimes(1);
    useAgentChatStore.getState().setDraft('tab-1', 'half written');

    first();
    expect(unsubscribe).not.toHaveBeenCalled();
    second();
    expect(unsubscribe).toHaveBeenCalledWith('tab-1');
    expect(chat()).toBeUndefined();
    expect(bridge.$listenerCount('agentChat.onAppend')).toBe(0);
    expect(useAgentChatStore.getState().drafts['tab-1']).toBe('half written');
  });

  it('ignores an answer that comes after the view already closed', async () => {
    installRunovaBridge({
      'agentChat.subscribe': { status: 'ready', lines: [userLine('u', 'x')] },
    });
    openAgentChat(tab)();
    await settle();
    expect(chat()).toBeUndefined();
  });

  it('opens nothing for a CLI without a chat view', () => {
    const subscribe = vi.fn(async () => ({ status: 'waiting' }));
    installRunovaBridge({ 'agentChat.subscribe': subscribe });
    openAgentChat({ ...tab, cliId: 'aider' })();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
