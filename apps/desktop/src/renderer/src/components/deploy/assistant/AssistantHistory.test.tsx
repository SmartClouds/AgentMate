import type { DeployAssistantChatSummary } from '@shared/deployAssistantTypes';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AssistantHistory } from './AssistantHistory';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const NOW = new Date(2026, 9, 30, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

function chat(
  runId: string,
  title: string,
  updatedAt: number,
  extra: Partial<DeployAssistantChatSummary> = {},
): DeployAssistantChatSummary {
  return {
    runId,
    title,
    startedAt: updatedAt - HOUR,
    updatedAt,
    status: 'finished',
    turns: 1,
    aiLabel: 'Claude Code',
    ...extra,
  };
}

const CHATS = [
  chat('r3', 'Why is shop slow?', NOW - HOUR, {
    turns: 3,
    app: { stackId: 'stack-shop', name: 'shop' },
  }),
  chat('r2', 'Check the disk', NOW - 26 * HOUR, { status: 'stopped' }),
  chat('r1', 'Rotate the nginx logs', NOW - 10 * 24 * HOUR),
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

function renderHistory(
  props: Partial<Parameters<typeof AssistantHistory>[0]> = {},
  chats: unknown = CHATS,
) {
  const onOpen = vi.fn();
  const onBack = vi.fn();
  const onDeleted = vi.fn();
  const view = renderWithProviders(
    <AssistantHistory
      serverId="srv-1"
      onOpen={onOpen}
      onBack={onBack}
      onDeleted={onDeleted}
      {...props}
    />,
    { bridge: { 'deployAssistant.chats': chats } },
  );
  return { ...view, onOpen, onBack, onDeleted };
}

describe('AssistantHistory', () => {
  it('lists past chats by day, each with when, how long and what it was about', async () => {
    renderHistory();
    const today = await screen.findByRole('group', { name: 'Today' });
    const row = within(today).getByRole('button', { name: /^Why is shop slow\?/ });
    expect(row).toHaveTextContent('3 questions');
    expect(row).toHaveTextContent('shop');
    expect(within(today).getByText('2:00 PM')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'Yesterday' })).getByRole('button', {
        name: /^Check the disk/,
      }),
    ).toHaveTextContent('Stopped');
    expect(
      within(screen.getByRole('group', { name: 'This month' })).getByRole('button', {
        name: /^Rotate the nginx logs/,
      }),
    ).toHaveTextContent('1 question');
    expect(window.runova.deployAssistant.chats).toHaveBeenCalledWith('srv-1');
  });

  it('finds a chat by what was asked', async () => {
    const { user } = renderHistory();
    await screen.findByRole('group', { name: 'Today' });
    await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'disk');
    expect(screen.getByRole('button', { name: /^Check the disk/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Why is shop slow/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search chats' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'nothing like it');
    expect(screen.getByText('No chat matches that.')).toBeInTheDocument();
  });

  it('opens the chat the user picks, and marks the one on screen', async () => {
    const { user, onOpen } = renderHistory({ currentRunId: 'r2' });
    const current = await screen.findByRole('button', { name: /^Check the disk/ });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current).toHaveTextContent('Open now');
    await user.click(screen.getByRole('button', { name: /^Why is shop slow\?/ }));
    expect(onOpen).toHaveBeenCalledWith(CHATS[0]);
  });

  it('deletes a chat once the user confirms', async () => {
    const { user, bridge, onDeleted } = renderHistory();
    await screen.findByRole('group', { name: 'Today' });
    await user.click(screen.getByRole('button', { name: 'Delete chat: Check the disk' }));
    const confirm = screen.getByRole('group', { name: 'Delete this chat?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Delete this chat?' })).not.toBeInTheDocument();

    bridge.$set('deployAssistant.chats', [CHATS[0], CHATS[2]]);
    await user.click(screen.getByRole('button', { name: 'Delete chat: Check the disk' }));
    await user.click(
      within(screen.getByRole('group', { name: 'Delete this chat?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(bridge.$fn('deployAssistant.deleteChat')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      runId: 'r2',
    });
    expect(onDeleted).toHaveBeenCalledWith('r2');
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Check the disk/ })).not.toBeInTheDocument(),
    );
  });

  it('says why a delete did not happen', async () => {
    const { user, bridge } = renderHistory();
    await screen.findByRole('group', { name: 'Today' });
    bridge.$set('deployAssistant.deleteChat', async () => {
      throw new Error('Stop the AI before deleting this chat.');
    });
    await user.click(screen.getByRole('button', { name: 'Delete chat: Check the disk' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Stop the AI before deleting this chat.'),
    );
  });

  it('has an empty state, and a way back to the chat', async () => {
    const { user, onBack } = renderHistory({}, []);
    expect(await screen.findByText(/No chats on this server yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the chat' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows a placeholder while the chats load', () => {
    renderHistory({}, () => new Promise(() => undefined));
    expect(screen.getByLabelText('Loading chats')).toBeInTheDocument();
  });
});
