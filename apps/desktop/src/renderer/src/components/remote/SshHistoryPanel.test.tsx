import type { AgentHistorySession } from '@agentmat/core';
import type { SshAgentHistoryRun, SshConversationsResult, SshSavedServer } from '@shared/apiTypes';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { resolveConfirm, useConfirmStore } from '../../stores/confirmStore';
import { useSshAgentStore } from '../../stores/sshAgentStore';
import { useTerminalStore } from '../../stores/terminalStore';

const openRemoteResume = vi.fn((..._args: unknown[]): string | null => 'tab-new');
vi.mock('@/lib/workspace/launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace/launch')>()),
  openRemoteResume: (...args: unknown[]) => openRemoteResume(...args),
}));

const { SshHistoryPanel } = await import('./SshHistoryPanel');

/**
 * The history panel lists what Claude Code and Codex left on a saved server, by folder, and
 * picks a conversation back up in an SSH tab. It talks to the server only when opened or
 * refreshed, never on a timer. Above those it lists the Ask AI tasks run in the server's SSH
 * tabs, which this app keeps itself.
 */

const server: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'dev',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

const HOUR = 60 * 60 * 1000;

function session(overrides: Partial<AgentHistorySession>): AgentHistorySession {
  return {
    provider: 'claude-code',
    id: 'conv-x',
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    cwd: '/home/dev/code/app',
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    updatedAt: Date.now() - HOUR,
    sizeBytes: 100,
    background: false,
    ...overrides,
  };
}

const appNewest = session({ id: 'conv-app-1', title: 'Fix the login flow', updatedAt: Date.now() });
const appOlder = session({
  id: 'conv-app-2',
  title: 'Add rate limiting',
  updatedAt: Date.now() - 2 * HOUR,
});
const apiOnly = session({
  provider: 'codex',
  id: 'conv-api-1',
  title: 'Migrate the api schema',
  cwd: '/home/dev/code/api',
  updatedAt: Date.now() - 3 * HOUR,
});
const nowhere = session({
  id: 'conv-none-1',
  title: 'Somewhere unknown',
  cwd: null,
  updatedAt: Date.now() - 4 * HOUR,
});

const ALL_CLIS: SshConversationsResult['clis'] = {
  claude: true,
  codex: true,
  gemini: true,
  cursor: true,
  continue: true,
  grok: true,
  cline: true,
  opencode: true,
  qwen: true,
  freebuff: true,
};

function result(overrides: Partial<SshConversationsResult> = {}): SshConversationsResult {
  return {
    sessions: [appNewest, appOlder, apiOnly, nowhere],
    home: '/home/dev',
    clis: { ...ALL_CLIS },
    ...overrides,
  };
}

function askAiRun(overrides: Partial<SshAgentHistoryRun> = {}): SshAgentHistoryRun {
  return {
    id: 'run-1',
    sessionId: 'tab-closed',
    serverId: server.id,
    prompt: 'Free up disk space on the server',
    aiLabel: 'OpenAI',
    startedAt: Date.now() - HOUR,
    endedAt: Date.now() - HOUR + 60_000,
    status: 'finished',
    entries: [
      {
        kind: 'command',
        at: Date.now() - HOUR,
        command: 'df -h /',
        output: '/dev/sda1  40G  38G  2G  95% /',
        exitCode: 0,
        timedOut: false,
      },
      { kind: 'finished', at: Date.now() - HOUR + 60_000, text: 'Cleared 12G of old logs.' },
    ],
    ...overrides,
  };
}

function renderPanel(answer: unknown = result(), runs: SshAgentHistoryRun[] = []) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <SshHistoryPanel server={server} onOpenChange={onOpenChange} onRequestUnlock={vi.fn()} />,
    { bridge: { 'ssh.conversations': answer, 'sshAgent.serverHistory': async () => runs } },
  );
  return { ...view, onOpenChange };
}

function folderButton(path: RegExp): HTMLElement {
  return screen.getByRole('button', { name: path });
}

beforeEach(() => {
  openRemoteResume.mockClear();
  openRemoteResume.mockImplementation(() => 'tab-new');
});

describe('SshHistoryPanel', () => {
  it('names the server and shimmers while it connects, with search focused', () => {
    renderPanel(() => new Promise(() => undefined));

    const dialog = screen.getByRole('dialog', { name: 'prod' });
    expect(dialog).toHaveTextContent('dev@prod.example');
    expect(screen.getByText('Connecting to prod…')).toBeInTheDocument();
    expect(dialog.querySelector('.shimmer')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search conversations' })).toHaveFocus();
  });

  it('shows a readable error and tries again on Retry', async () => {
    const conversations = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'ssh:conversations': Error: Connection refused"),
      )
      .mockResolvedValue(result());
    const { user } = renderPanel(conversations);

    expect(await screen.findByText('Connection refused')).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Fix the login flow')).toBeInTheDocument();
    expect(conversations).toHaveBeenCalledTimes(2);
  });

  it('explains where conversations come from when the server has none', async () => {
    renderPanel(result({ sessions: [] }));

    expect(
      await screen.findByText('No agent conversations on this server yet.'),
    ).toBeInTheDocument();
  });

  it('groups by folder, home shortened to ~, newest folder open and the rest folded', async () => {
    const { user } = renderPanel();

    await screen.findByText('Fix the login flow');
    expect(screen.getByRole('dialog', { name: 'prod' })).toHaveTextContent(
      '4 conversations · 3 folders',
    );

    const app = folderButton(/~\/code\/app/);
    const api = folderButton(/~\/code\/api/);
    const unknown = folderButton(/Unknown folder/);
    expect(app).toHaveAttribute('aria-expanded', 'true');
    expect(app).toHaveAccessibleName(/2 conversations/);
    expect(api).toHaveAttribute('aria-expanded', 'false');
    expect(unknown).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Add rate limiting')).toBeInTheDocument();
    expect(screen.queryByText('Migrate the api schema')).not.toBeInTheDocument();

    await user.click(api);
    expect(api).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Migrate the api schema')).toBeInTheDocument();

    await user.click(app);
    expect(app).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Fix the login flow')).not.toBeInTheDocument();
  });

  it('filters by search and opens every folder that still matches', async () => {
    const { user } = renderPanel();
    await screen.findByText('Fix the login flow');

    await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'schema');

    expect(folderButton(/~\/code\/api/)).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Migrate the api schema')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /~\/code\/app/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Search conversations' }));
    await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'zzz');
    expect(screen.getByText('No conversation matches.')).toBeInTheDocument();
  });

  it('resumes a conversation in a new SSH tab and gets out of the way', async () => {
    const success = vi.spyOn(toast, 'success');
    const { user, onOpenChange } = renderPanel();

    await user.click(await screen.findByText('Fix the login flow'));

    expect(openRemoteResume).toHaveBeenCalledWith(server, appNewest);
    expect(success).toHaveBeenCalledWith('Resuming in a new SSH tab');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    success.mockRestore();
  });

  it('offers no token usage menu, since a server conversation has no log on this machine', async () => {
    const { bridge } = renderPanel();

    fireEvent.contextMenu(await screen.findByText('Fix the login flow'));

    expect(screen.queryByText('Token usage')).not.toBeInTheDocument();
    expect(() => bridge.$fn('agents.sessionUsage')).toThrow();
  });

  it('stays open and quiet when the resume could not start', async () => {
    openRemoteResume.mockImplementation(() => null);
    const success = vi.spyOn(toast, 'success');
    const { user, onOpenChange } = renderPanel();

    await user.click(await screen.findByText('Fix the login flow'));

    expect(success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    success.mockRestore();
  });

  it('warns about a CLI a login shell could not find, but still lets it resume', async () => {
    // The probe runs in a login shell; a PATH set only in .bashrc still works for the resume.
    const { user } = renderPanel(
      result({ sessions: [apiOnly], clis: { ...ALL_CLIS, claude: false, codex: false } }),
    );

    await screen.findByText('Migrate the api schema');
    // The command sits in its own monospace span, so match the chip by its whole text.
    const chipWith = (text: string) => (_: string, el: Element | null) =>
      el?.hasAttribute('tabindex') === true && el.textContent === text;
    const chip = screen.getByText(chipWith('codex not found on PATH'));
    expect(screen.queryByText(chipWith('claude not found on PATH'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume in a new tab' })).toBeEnabled();

    await user.hover(chip);
    expect(
      await screen.findAllByText(/couldn't find the codex command in a login shell/),
    ).not.toHaveLength(0);

    await user.click(screen.getByText('Migrate the api schema'));
    expect(openRemoteResume).toHaveBeenCalledWith(server, apiOnly);
  });

  it('offers to unlock the vault when it got locked, instead of a raw error', async () => {
    const onRequestUnlock = vi.fn();
    const { user } = renderWithProviders(
      <SshHistoryPanel server={server} onOpenChange={vi.fn()} onRequestUnlock={onRequestUnlock} />,
      {
        bridge: {
          'ssh.conversations': async () => {
            throw new Error(
              "Error invoking remote method 'ssh:conversations': Error: [ssh:vault-locked] The Servers vault is locked.",
            );
          },
          'sshAgent.serverHistory': async () => [],
        },
      },
    );

    expect(await screen.findByText('The servers vault is locked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(onRequestUnlock).toHaveBeenCalledTimes(1);
  });

  it('marks a conversation already open in a tab and goes back to it', async () => {
    useTerminalStore.setState({
      sessions: [
        {
          id: 'tab-open',
          title: 'prod',
          kind: 'ssh',
          sshServerId: server.id,
          conversationId: appNewest.id,
        },
      ],
    });
    openRemoteResume.mockImplementation(() => 'tab-open');
    const success = vi.spyOn(toast, 'success');
    const { user, onOpenChange } = renderPanel(
      result({ sessions: [appNewest], clis: { ...ALL_CLIS, claude: false, codex: true } }),
    );

    const row = (await screen.findByText('Fix the login flow')).closest('button');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('Open')).toBeInTheDocument();
    expect(row).not.toHaveAttribute('aria-disabled');

    await user.click(row as HTMLElement);

    expect(openRemoteResume).toHaveBeenCalledWith(server, appNewest);
    expect(success).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    success.mockRestore();
  });

  it('asks the server once, not on a timer', async () => {
    const { bridge } = renderPanel();

    await screen.findByText('Fix the login flow');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.$fn('ssh.conversations')).toHaveBeenCalledTimes(1);
    expect(bridge.$fn('ssh.conversations')).toHaveBeenCalledWith(server.id);
    expect(bridge.$fn('sshAgent.serverHistory')).toHaveBeenCalledTimes(1);
  });

  it('refreshes on demand', async () => {
    const { user, bridge } = renderPanel();
    await screen.findByText('Fix the login flow');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(bridge.$fn('ssh.conversations')).toHaveBeenCalledTimes(2));
  });

  describe('Ask AI tasks', () => {
    it('lists them when the server has no CLI conversations, instead of saying it is empty', async () => {
      const { bridge } = renderPanel(result({ sessions: [] }), [askAiRun()]);

      const tasks = await screen.findByRole('list', { name: 'Ask AI tasks' });
      expect(within(tasks).getByText('Free up disk space on the server')).toBeInTheDocument();
      expect(within(tasks).getByText(/Done · .* · OpenAI · 1 command/)).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'prod' })).toHaveTextContent('1 Ask AI task');
      await waitFor(() => expect(bridge.$fn('ssh.conversations')).toHaveBeenCalled());
      expect(
        screen.queryByText('No agent conversations on this server yet.'),
      ).not.toBeInTheDocument();
      expect(bridge.$fn('sshAgent.serverHistory')).toHaveBeenCalledWith(server.id);
    });

    it('lists them above the CLI conversations, newest first', async () => {
      renderPanel(result(), [
        askAiRun({ id: 'run-new', prompt: 'Restart nginx', startedAt: Date.now() }),
        askAiRun({ id: 'run-old', prompt: 'Check memory', startedAt: Date.now() - 2 * HOUR }),
      ]);

      await screen.findByText('Fix the login flow');
      const tasks = screen.getByRole('list', { name: 'Ask AI tasks' });
      expect(
        within(tasks)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([
        expect.stringContaining('Restart nginx'),
        expect.stringContaining('Check memory'),
      ]);
    });

    it('still lists them when the server cannot be reached', async () => {
      renderPanel(async () => {
        throw new Error('Connection refused');
      }, [askAiRun()]);

      expect(await screen.findByText('Connection refused')).toBeInTheDocument();
      expect(await screen.findByText('Free up disk space on the server')).toBeInTheDocument();
    });

    it('opens the full timeline of the one clicked', async () => {
      const { user } = renderPanel(result({ sessions: [] }), [
        askAiRun({ id: 'run-new', prompt: 'Restart nginx', startedAt: Date.now(), entries: [] }),
        askAiRun(),
      ]);

      await user.click(await screen.findByText('Free up disk space on the server'));

      const timeline = await screen.findByRole('dialog', { name: 'AI task history' });
      expect(within(timeline).getByText('df -h /')).toBeInTheDocument();
      expect(within(timeline).getByText('Cleared 12G of old logs.')).toBeInTheDocument();
      expect(within(timeline).getByRole('button', { current: true })).toHaveTextContent(
        'Free up disk space on the server',
      );
    });

    it('narrows them with the search box', async () => {
      const { user } = renderPanel(result(), [
        askAiRun({ id: 'run-a', prompt: 'Restart nginx' }),
        askAiRun({ id: 'run-b', prompt: 'Check memory' }),
      ]);
      await screen.findByText('Restart nginx');

      await user.type(screen.getByRole('textbox', { name: 'Search conversations' }), 'nginx');

      expect(screen.getByText('Restart nginx')).toBeInTheDocument();
      expect(screen.queryByText('Check memory')).not.toBeInTheDocument();
    });

    it('shows the empty state only when there are no tasks and no conversations', async () => {
      renderPanel(result({ sessions: [] }), []);

      expect(
        await screen.findByText('No agent conversations on this server yet.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Ask AI tasks' })).not.toBeInTheDocument();
    });
  });

  it('closes on Escape', async () => {
    const { user, onOpenChange } = renderPanel();
    await screen.findByText('Fix the login flow');

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('picking an Ask AI task back up from the server history', () => {
  beforeEach(() => {
    installFakeMicrophone();
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useSshAgentStore.setState({ sessions: {}, askAiRequest: null });
  });

  async function openTimeline(runs: SshAgentHistoryRun[]) {
    const view = renderPanel(result({ sessions: [] }), runs);
    await view.user.click(await screen.findByText(runs[0]?.prompt ?? ''));
    return { ...view, timeline: await screen.findByRole('dialog', { name: 'AI task history' }) };
  }

  it('continues in a new tab on the server, with the follow-up waiting in Ask AI', async () => {
    const { user, timeline } = await openTimeline([askAiRun()]);
    await user.type(
      within(timeline).getByRole('textbox', { name: 'What to do next' }),
      'now check the inodes{Enter}',
    );

    const tab = useTerminalStore.getState().sessions.find((s) => s.sshServerId === server.id);
    expect(tab).toMatchObject({ kind: 'ssh' });
    expect(useTerminalStore.getState().activeSessionId).toBe(tab?.id);
    expect(useSshAgentStore.getState().askAiRequest).toMatchObject({
      sessionId: tab?.id,
      prefill: { intent: 'continue', followUp: 'now check the inodes', run: { id: 'run-1' } },
    });
  });

  it('uses a tab already open on the server instead of opening another', async () => {
    useTerminalStore.setState({
      sessions: [{ id: 'tab-open', title: 'prod', kind: 'ssh', sshServerId: server.id }],
      activeSessionId: null,
    });
    const { user, timeline } = await openTimeline([askAiRun()]);
    await user.click(within(timeline).getByRole('button', { name: 'Run again' }));

    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useTerminalStore.getState().activeSessionId).toBe('tab-open');
    expect(useSshAgentStore.getState().askAiRequest).toMatchObject({
      sessionId: 'tab-open',
      prefill: { intent: 'rerun' },
    });
  });

  it('says where it will run', async () => {
    const { timeline } = await openTimeline([askAiRun()]);
    expect(within(timeline).getByText(/Runs in an SSH tab on prod/)).toBeInTheDocument();
  });
});

describe('the Ask AI task list', () => {
  it('marks a task that is waiting for an answer', async () => {
    useSshAgentStore.setState({
      sessions: {
        'tab-live': { mode: 'approve-all', phase: 'needs-input', step: 1, message: 'Which?' },
      },
    });
    renderPanel(result({ sessions: [] }), [
      askAiRun({ id: 'run-live', sessionId: 'tab-live', status: 'running', endedAt: null }),
    ]);
    const tasks = await screen.findByRole('list', { name: 'Ask AI tasks' });
    expect(within(tasks).getByText('Needs your answer')).toBeInTheDocument();
  });

  it('can be cleared, after asking', async () => {
    const { user, bridge } = renderPanel(result({ sessions: [] }), [askAiRun()]);
    bridge.$set('sshAgent.clearServerHistory', async () => undefined);
    await screen.findByRole('list', { name: 'Ask AI tasks' });
    await user.click(screen.getByRole('button', { name: 'Clear AI task history' }));
    await waitFor(() => expect(useConfirmStore.getState().open).toBe(true));
    expect(useConfirmStore.getState().title).toBe('Clear the AI task history of prod?');
    act(() => resolveConfirm(true));
    await waitFor(() =>
      expect(bridge.$fn('sshAgent.clearServerHistory')).toHaveBeenCalledWith(server.id),
    );
  });
});
