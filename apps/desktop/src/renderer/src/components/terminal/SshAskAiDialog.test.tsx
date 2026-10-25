import type { SshAgentHistoryRun } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SshAskAiDialog, type SshAskAiPrefill } from './SshAskAiDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function run(id: string, extra: Partial<SshAgentHistoryRun> = {}): SshAgentHistoryRun {
  return {
    id,
    sessionId: 'old-tab',
    serverId: 'srv-1',
    prompt: `task ${id}`,
    aiLabel: 'Claude Code',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    status: 'finished',
    entries: [{ kind: 'finished', at: 1_700_000_060_000, text: 'Done.' }],
    settings: {
      target: 'ssh',
      mode: 'autonomous',
      cliId: 'claude-code',
      modelId: null,
      effort: null,
    },
    ...extra,
  };
}

function renderDialog(
  options: {
    history?: SshAgentHistoryRun[];
    installed?: string[];
    prefill?: SshAskAiPrefill | null;
    serverId?: string | null;
  } = {},
) {
  const start = vi.fn(async () => undefined);
  const view = renderWithProviders(
    <SshAskAiDialog
      sessionId="tab-1"
      target="ssh"
      serverId={options.serverId === undefined ? 'srv-1' : options.serverId}
      prefill={options.prefill ?? null}
      open
      onOpenChange={vi.fn()}
    />,
    {
      bridge: {
        'cli.detectAll': (options.installed ?? ['claude-code']).map((id) => ({
          id,
          installed: true,
        })),
        'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'm' },
        'sshAgent.serverHistory': options.history ?? [],
        'sshAgent.history': options.history ?? [],
        'sshAgent.start': start,
      },
    },
  );
  const box = () => screen.getByRole('textbox', { name: 'Task for the AI' });
  return { ...view, start, box };
}

beforeEach(() => {
  installFakeMicrophone();
});

describe('recent tasks', () => {
  it('lists what was asked on this server before, newest first, leaving out a task still going', async () => {
    renderDialog({
      history: [
        run('r3', { prompt: 'still at it', status: 'running', endedAt: null }),
        run('r2', { prompt: 'rotate the logs' }),
        run('r1', { prompt: 'install nginx', status: 'stopped' }),
      ],
    });
    const list = await screen.findByRole('region', { name: 'Recent tasks' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => within(item).getByText(/rotate|install/).textContent)).toEqual([
      'rotate the logs',
      'install nginx',
    ]);
    expect(within(list).queryByText('still at it')).not.toBeInTheDocument();
  });

  it('reads the server history for an SSH tab and the tab history for a local one', async () => {
    const { bridge, unmount } = renderDialog({ history: [run('r1')] });
    await screen.findByRole('region', { name: 'Recent tasks' });
    expect(bridge.$fn('sshAgent.serverHistory')).toHaveBeenCalledWith('srv-1');
    unmount();

    const local = renderDialog({ history: [run('r1')], serverId: null });
    await screen.findByRole('region', { name: 'Recent tasks' });
    expect(local.bridge.$fn('sshAgent.history')).toHaveBeenCalledWith('tab-1');
  });

  it('is left out when there is nothing yet', async () => {
    renderDialog({ history: [] });
    await screen.findByRole('textbox', { name: 'Task for the AI' });
    expect(screen.queryByRole('region', { name: 'Recent tasks' })).not.toBeInTheDocument();
  });
});

describe('Run again', () => {
  it('fills in the prompt and the way it ran, ready to start', async () => {
    const { user, box, start } = renderDialog({
      history: [run('r1', { prompt: 'rotate the logs' })],
    });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Recent tasks' })).findByRole(
        'button',
        { name: 'Run again' },
      ),
    );
    expect(box()).toHaveValue('rotate the logs');
    expect(screen.getByRole('button', { name: /Fully autonomous/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'tab-1',
        prompt: 'rotate the logs',
        mode: 'autonomous',
        cliId: 'claude-code',
        continueFromRunId: null,
      }),
    );
  });

  it('falls back to a CLI that is here when the one it used is not installed any more', async () => {
    const { user, start } = renderDialog({
      history: [
        run('r1', {
          settings: {
            target: 'ssh',
            mode: 'approve-all',
            cliId: 'codex-cli',
            modelId: null,
            effort: null,
          },
        }),
      ],
      installed: ['claude-code'],
    });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Recent tasks' })).findByRole(
        'button',
        { name: 'Run again' },
      ),
    );
    expect(screen.getByText(/is not installed here, so/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ cliId: 'claude-code' }));
  });
});

describe('Continue', () => {
  it('keeps the earlier task as context and asks for what to do next', async () => {
    const { user, box, start } = renderDialog({
      history: [run('r1', { prompt: 'install nginx' })],
    });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Recent tasks' })).findByRole(
        'button',
        { name: 'Continue' },
      ),
    );

    expect(screen.getByRole('status', { name: 'Continuing' })).toHaveTextContent('install nginx');
    expect(box()).toHaveValue('');
    expect(box()).toHaveFocus();
    await user.type(box(), 'now enable https');
    await user.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'now enable https',
        continueFromRunId: 'r1',
        mode: 'autonomous',
      }),
    );
  });

  it('can be dropped, which starts a fresh task instead', async () => {
    const { user, box, start } = renderDialog({ history: [run('r1')] });
    await user.click(
      await within(await screen.findByRole('region', { name: 'Recent tasks' })).findByRole(
        'button',
        { name: 'Continue' },
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Start fresh instead' }));
    expect(screen.queryByRole('status', { name: 'Continuing' })).not.toBeInTheDocument();
    await user.type(box(), 'something else');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ continueFromRunId: null }));
  });

  it('opens already continuing when the history asked for it', async () => {
    renderDialog({
      prefill: { run: run('r9', { prompt: 'rotate the logs' }), intent: 'continue' },
    });
    expect(await screen.findByRole('status', { name: 'Continuing' })).toHaveTextContent(
      'rotate the logs',
    );
  });

  it('opens with the prompt filled in when the history asked to run it again', async () => {
    const { box } = renderDialog({
      prefill: { run: run('r9', { prompt: 'rotate the logs' }), intent: 'rerun' },
    });
    await waitFor(() => expect(box()).toHaveValue('rotate the logs'));
  });
});

describe('the task box', () => {
  it('has the Build Prompt tools and starts on Ctrl+Enter, leaving Enter for new lines', async () => {
    const { user, box, start } = renderDialog();
    await user.type(
      await screen.findByRole('textbox', { name: 'Task for the AI' }),
      'لاگ{Enter}ها',
    );
    expect(box()).toHaveValue('لاگ\nها');
    expect(screen.getByRole('button', { name: /Translate to English/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled());
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'لاگ\nها' }));
  });
});
