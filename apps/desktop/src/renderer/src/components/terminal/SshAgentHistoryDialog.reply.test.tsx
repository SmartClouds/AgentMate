import type { SshAgentHistoryRun } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSshAgentStore } from '@/stores/sshAgentStore';
import { installFakeMicrophone } from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { AgentLiveControls, AgentRunContinuation } from './AgentHistoryFooter';
import { SshAgentHistoryDialog } from './SshAgentHistoryDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/**
 * The history used to be read-only, so a question cut off in the status bar had to be read here
 * and answered back there. It now answers, messages and continues tasks itself.
 */

const now = Date.now();

function run(id: string, extra: Partial<SshAgentHistoryRun> = {}): SshAgentHistoryRun {
  return {
    id,
    sessionId: 'ssh-1',
    serverId: 'srv-1',
    prompt: `task ${id}`,
    aiLabel: 'Claude Code',
    startedAt: now - 60_000,
    endedAt: now,
    status: 'finished',
    entries: [{ kind: 'finished', at: now, text: 'Done.' }],
    settings: {
      target: 'ssh',
      mode: 'approve-all',
      cliId: 'claude-code',
      modelId: null,
      effort: null,
    },
    ...extra,
  };
}

function continuation(): AgentRunContinuation {
  return {
    where: 'web-1',
    blockedReason: null,
    runAgain: vi.fn(),
    continueWith: vi.fn(async () => true),
    moreOptions: vi.fn(),
  };
}

function renderDialog(
  runs: SshAgentHistoryRun[],
  props: { continuation?: AgentRunContinuation | null } = {},
) {
  return renderWithProviders(
    <SshAgentHistoryDialog
      sessionId="ssh-1"
      sessionTitle="web-1"
      open
      onOpenChange={() => undefined}
      continuation={props.continuation ?? null}
    />,
    {
      bridge: {
        'sshAgent.history': runs,
        'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'm' },
      },
    },
  );
}

beforeEach(() => {
  installFakeMicrophone();
});

describe('replying from the history', () => {
  it('answers the question of the task going in this terminal', async () => {
    const question =
      'I found three nginx sites: default, api.example.com and staging.example.com. Only staging changed today. Which one should I reload?';
    useSshAgentStore.setState({
      sessions: {
        'ssh-1': { mode: 'approve-all', phase: 'needs-input', step: 2, message: question },
      },
    });
    const { user, bridge } = renderDialog([
      run('r2', {
        status: 'running',
        endedAt: null,
        entries: [{ kind: 'question', at: now, text: question }],
      }),
    ]);
    const box = await screen.findByRole('textbox', { name: 'Your answer' });
    expect(screen.getByRole('region', { name: 'The AI asks' })).toHaveTextContent(question);
    await user.type(box, 'staging{Enter}');
    expect(bridge.$fn('sshAgent.answerNeedsInput')).toHaveBeenCalledWith('ssh-1', 'staging');
  });

  it('messages a task that is working', async () => {
    useSshAgentStore.setState({
      sessions: {
        'ssh-1': { mode: 'approve-all', phase: 'running', step: 1, command: 'apt-get upgrade -y' },
      },
    });
    const { user, bridge } = renderDialog([run('r2', { status: 'running', endedAt: null })]);
    bridge.$set('sshAgent.sendMessage', async () => true);
    await user.type(
      await screen.findByRole('textbox', { name: 'Message to the AI' }),
      'skip the kernel{Enter}',
    );
    expect(bridge.$fn('sshAgent.sendMessage')).toHaveBeenCalledWith('ssh-1', 'skip the kernel');
  });

  it('does not offer to reply to an older task of the same terminal', async () => {
    useSshAgentStore.setState({
      sessions: { 'ssh-1': { mode: 'approve-all', phase: 'running', step: 1 } },
    });
    const { user } = renderDialog([
      run('r2', { status: 'running', endedAt: null, prompt: 'the new one' }),
      // Left running in the record by a crash, but its session moved on to r2.
      run('r1', { status: 'running', endedAt: null, prompt: 'the old one' }),
    ]);
    await user.click(await screen.findByRole('button', { name: /the old one/ }));
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();
  });
});

describe('picking an ended task back up', () => {
  it('offers to continue it when the caller can start one', async () => {
    const cont = continuation();
    const { user } = renderDialog([run('r1', { prompt: 'install nginx' })], { continuation: cont });
    await user.type(
      await screen.findByRole('textbox', { name: 'What to do next' }),
      'enable https{Enter}',
    );
    expect(cont.continueWith).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      'enable https',
    );
  });

  it('stays read-only where nothing can be started', async () => {
    renderDialog([run('r1')]);
    await screen.findByTestId('agent-timeline');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('links a continued task to the one before it', async () => {
    const { user } = renderDialog([
      run('r2', { prompt: 'enable https', continuedFromRunId: 'r1' }),
      run('r1', { prompt: 'install nginx' }),
    ]);
    const link = await screen.findByRole('button', { name: /Continues: install nginx/ });
    await user.click(link);
    expect(
      within(screen.getByTestId('agent-timeline')).getAllByText('install nginx')[0],
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /install nginx/, current: true }),
    ).toBeInTheDocument();
  });
});

describe('the RDP history', () => {
  it('replies through the controls it is given and offers no continuation', async () => {
    const controls: AgentLiveControls = {
      phase: 'needs-input',
      message: 'Which file?',
      answer: vi.fn(),
      send: vi.fn(async () => true),
      approve: vi.fn(),
      skip: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
    };
    const rdpRun = {
      id: 'd1',
      sessionId: 'rdp-1',
      prompt: 'Open the report',
      aiLabel: 'Claude Code',
      startedAt: now - 1000,
      endedAt: null,
      status: 'running' as const,
      entries: [],
    };
    const { user } = renderWithProviders(
      <SshAgentHistoryDialog
        sessionId="rdp-1"
        sessionTitle="desk"
        open
        onOpenChange={() => undefined}
        source={{
          kind: 'rdp',
          queryKey: ['rdp-agent-history', 'rdp-1'],
          load: async () => [rdpRun],
          live: controls,
          controls,
        }}
      />,
      { bridge: { 'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'm' } } },
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Your answer' }),
      'report.docx{Enter}',
    );
    expect(controls.answer).toHaveBeenCalledWith('report.docx');
  });
});
