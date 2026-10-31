import type { SshAgentHistoryRun } from '@shared/apiTypes';
import type { DeployAssistantChatSummary } from '@shared/deployAssistantTypes';
import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_AI, useDeployAssistantStore } from '@/stores/deployAssistantStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SERVER } from '../overview/testing/fixtures';
import { signedIn } from '../security/testing/fixtures';
import { AssistantLauncher } from './AssistantLauncher';

/**
 * The Deploy AI drawer with the app the user has open (attached to a new chat unless they take it
 * off) and the chat history (read a past chat and carry it on). Long text never makes the drawer
 * scroll sideways.
 */

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const KEY = `deploy:${SERVER.id}`;
const SHOP = { stackId: '5a0f1c2e-0000-4000-8000-00000000a001', name: 'shop' };
const PAST_RUN = 'aaaaaaaa-0000-4000-8000-0000000000d1';

const PAST_CHAT: DeployAssistantChatSummary = {
  runId: PAST_RUN,
  title: 'Why is shop slow?',
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 30_000,
  status: 'finished',
  turns: 1,
  aiLabel: 'Ollama',
  app: SHOP,
};

const PAST_CHAIN: SshAgentHistoryRun[] = [
  {
    id: PAST_RUN,
    sessionId: KEY,
    serverId: SERVER.id,
    scope: 'deploy',
    prompt: 'Why is shop slow?',
    aiLabel: 'Ollama',
    startedAt: PAST_CHAT.startedAt,
    endedAt: PAST_CHAT.updatedAt,
    status: 'finished',
    app: SHOP,
    entries: [
      {
        kind: 'command',
        at: 1,
        command: 'docker stats --no-stream',
        output: 'shop-db-1 98%',
        exitCode: 0,
        timedOut: false,
      },
      { kind: 'finished', at: 2, text: 'The database is out of memory.' },
    ],
  },
];

function bridge(extra: Record<string, unknown> = {}) {
  return {
    'deploy.access': signedIn(['admin']),
    'deployAssistant.getMode': { mode: 'approveEveryCommand', allowlist: ['docker ps'] },
    'deployAssistant.state': { running: false, progress: null, context: null, history: [] },
    'deployAssistant.chats': [PAST_CHAT],
    'deployAssistant.chat': PAST_CHAIN,
    'cli.detectAll': [],
    ...extra,
  };
}

function progress(phase: string, extra: Record<string, unknown> = {}) {
  act(() => {
    useDeployAssistantStore.getState().progress({
      serverId: SERVER.id,
      progress: { sessionId: KEY, phase: phase as never, step: 1, ...extra },
    });
  });
}

async function openDrawer() {
  act(() => useDeployAssistantStore.getState().open(SERVER.id));
  const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
  await within(drawer).findByRole('radio', { name: /Approve every command/ });
  return drawer;
}

beforeEach(() => {
  toast.error.mockClear();
  useDeployAssistantStore.setState({
    openServerId: null,
    pageServerId: null,
    pageApp: null,
    dismissedApps: {},
    continueFrom: {},
    draft: null,
    prompts: {},
    attachments: {},
    maximized: false,
    runs: {},
    ai: SETTINGS_AI,
    projects: {},
  });
});

describe('the app the user has open', () => {
  it('is attached to a new chat by default, and the AI is told which one', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().setPageApp({ serverId: SERVER.id, ...SHOP }));
    const drawer = await openDrawer();

    const attached = within(drawer).getByRole('group', { name: 'Attached' });
    expect(attached).toHaveTextContent('shop');
    expect(attached).toHaveTextContent('reads its containers and logs');
    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Is it ok?');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      prompt: 'Is it ok?',
      cliId: null,
      app: { stackId: SHOP.stackId },
    });
    expect(useDeployAssistantStore.getState().runs[SERVER.id]?.app).toEqual(SHOP);
    // While the run goes its app is fixed: it was read when the run started.
    progress('thinking');
    expect(
      within(drawer).queryByRole('button', { name: 'Remove shop from this chat' }),
    ).not.toBeInTheDocument();
  });

  it('comes off when the user takes it off, and back on when they ask', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().setPageApp({ serverId: SERVER.id, ...SHOP }));
    const drawer = await openDrawer();

    await user.click(within(drawer).getByRole('button', { name: 'Remove shop from this chat' }));
    expect(within(drawer).queryByText('shop', { exact: true })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Attach shop' }));
    expect(within(drawer).getByRole('group', { name: 'Attached' })).toHaveTextContent('shop');

    await user.click(within(drawer).getByRole('button', { name: 'Remove shop from this chat' }));
    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Disk?');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenCalledWith(
      expect.not.objectContaining({ app: expect.anything() }),
    );
  });

  it('stays with its chat after the user leaves the app page', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().setPageApp({ serverId: SERVER.id, ...SHOP }));
    const drawer = await openDrawer();
    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'Is it ok?');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    progress('finished', { message: 'All good.' });
    act(() => useDeployAssistantStore.getState().setPageApp(null));

    expect(within(drawer).getByRole('group', { name: 'Attached' })).toHaveTextContent('shop');
    await user.type(within(drawer).getByLabelText('Ask a follow-up'), 'And the db?');
    await user.click(within(drawer).getByRole('button', { name: 'Ask' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenLastCalledWith(
      expect.objectContaining({ app: { stackId: SHOP.stackId }, continuePrevious: true }),
    );
  });

  it('starts a new chat with the app on the page again', async () => {
    const { user } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    act(() => useDeployAssistantStore.getState().setPageApp({ serverId: SERVER.id, ...SHOP }));
    const drawer = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'Remove shop from this chat' }));
    await user.type(within(drawer).getByLabelText('What should the AI look into?'), 'x');
    await user.click(within(drawer).getByRole('button', { name: 'Start' }));
    progress('finished', { message: 'ok' });

    await user.click(within(drawer).getByRole('button', { name: 'New chat' }));
    expect(within(drawer).getByRole('group', { name: 'Attached' })).toHaveTextContent('shop');
  });
});

describe('chat history', () => {
  it('reads a past chat back and carries it on from where it ended', async () => {
    const { user, bridge: fake } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    const drawer = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'Chat history' }));
    await user.click(await within(drawer).findByRole('button', { name: /^Why is shop slow\?/ }));

    expect(fake.$fn('deployAssistant.chat')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      runId: PAST_RUN,
    });
    const run = within(drawer).getByLabelText('Run');
    expect(within(run).getByLabelText('You asked')).toHaveTextContent('Why is shop slow?');
    expect(within(run).getByRole('article', { name: 'AI answer' })).toHaveTextContent(
      'The database is out of memory.',
    );
    expect(
      within(run).getByRole('listitem', { name: 'Step 1: docker stats --no-stream' }),
    ).toHaveTextContent('shop-db-1 98%');
    expect(within(drawer).getByRole('group', { name: 'Attached' })).toHaveTextContent('shop');

    await user.type(within(drawer).getByLabelText('Ask a follow-up'), 'Fix it');
    await user.click(within(drawer).getByRole('button', { name: 'Ask' }));
    expect(fake.$fn('deployAssistant.start')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      prompt: 'Fix it',
      cliId: null,
      app: { stackId: SHOP.stackId },
      continueFromRunId: PAST_RUN,
    });
    expect(useDeployAssistantStore.getState().continueFrom[SERVER.id]).toBeUndefined();
    expect(useDeployAssistantStore.getState().runs[SERVER.id]?.earlier).toHaveLength(1);
  });

  it('is out of reach while the AI works, and Escape in it goes back to the chat', async () => {
    const { user } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    const drawer = await openDrawer();
    progress('thinking');
    expect(within(drawer).getByRole('button', { name: 'Chat history' })).toBeDisabled();
    progress('stopped', { message: 'Stopped by user.' });

    await user.click(within(drawer).getByRole('button', { name: 'Chat history' }));
    expect(await within(drawer).findByRole('region', { name: 'Chat history' })).toBeVisible();
    expect(within(drawer).queryByLabelText('Ask a follow-up')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(drawer).queryByRole('region', { name: 'Chat history' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Deploy AI' })).toBeInTheDocument();
  });

  it('says so when the chat picked is gone, and stays in the history', async () => {
    const { user } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge({ 'deployAssistant.chat': async () => null }),
    });
    const drawer = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'Chat history' }));
    await user.click(await within(drawer).findByRole('button', { name: /^Why is shop slow\?/ }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That chat is no longer in the history.'),
    );
    expect(within(drawer).getByRole('region', { name: 'Chat history' })).toBeInTheDocument();
  });

  it('clears the chat on screen when it is the one deleted', async () => {
    const { user } = renderWithProviders(<AssistantLauncher server={SERVER} />, {
      bridge: bridge(),
    });
    const drawer = await openDrawer();
    await user.click(within(drawer).getByRole('button', { name: 'Chat history' }));
    await user.click(await within(drawer).findByRole('button', { name: /^Why is shop slow\?/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Chat history' }));
    await user.click(
      await within(drawer).findByRole('button', { name: 'Delete chat: Why is shop slow?' }),
    );
    await user.click(within(drawer).getByRole('button', { name: 'Delete' }));
    await vi.waitFor(() =>
      expect(useDeployAssistantStore.getState().runs[SERVER.id]?.prompt).toBeUndefined(),
    );
    expect(useDeployAssistantStore.getState().continueFrom[SERVER.id]).toBeUndefined();
  });
});

describe('long text', () => {
  it('never makes the drawer scroll sideways', async () => {
    renderWithProviders(<AssistantLauncher server={SERVER} />, { bridge: bridge() });
    const container = `${'f'.repeat(64)}`;
    act(() =>
      useDeployAssistantStore.getState().open(SERVER.id, {
        prompt: 'x',
        context: { title: `Errors in ${'very-long-name-'.repeat(20)}`, containerId: container },
      }),
    );
    const drawer = await screen.findByRole('complementary', { name: 'Deploy AI' });
    expect(within(drawer).getByLabelText('Run')).toHaveClass('overflow-x-hidden');
    const chip = within(drawer).getByTitle(container);
    expect(chip).toHaveTextContent(`container ${container.slice(0, 12)}`);
    expect(within(drawer).getByTitle(/^Errors in very-long-name-/)).toHaveClass('max-w-full');
  });
});
