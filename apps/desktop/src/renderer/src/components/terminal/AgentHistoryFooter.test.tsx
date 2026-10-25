import type { SshAgentHistoryRun } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import {
  AgentHistoryFooter,
  type AgentLiveControls,
  type AgentRunContinuation,
} from './AgentHistoryFooter';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const ended: SshAgentHistoryRun = {
  id: 'r1',
  sessionId: 'tab-1',
  serverId: 'srv-1',
  prompt: 'install nginx',
  aiLabel: 'Claude Code',
  startedAt: 1,
  endedAt: 2,
  status: 'finished',
  entries: [],
  settings: {
    target: 'ssh',
    mode: 'approve-all',
    cliId: 'claude-code',
    modelId: null,
    effort: null,
  },
};
const live: SshAgentHistoryRun = { ...ended, status: 'running', endedAt: null };

function controls(patch: Partial<AgentLiveControls> = {}): AgentLiveControls {
  return {
    phase: 'thinking',
    answer: vi.fn(),
    send: vi.fn(async () => true),
    approve: vi.fn(),
    skip: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    answerPassword: vi.fn(),
    ...patch,
  };
}

function continuation(patch: Partial<AgentRunContinuation> = {}): AgentRunContinuation {
  return {
    where: 'web-01',
    blockedReason: null,
    runAgain: vi.fn(),
    continueWith: vi.fn(async () => true),
    moreOptions: vi.fn(),
    ...patch,
  };
}

function renderFooter(props: {
  run: SshAgentHistoryRun;
  live?: AgentLiveControls | null;
  continuation?: AgentRunContinuation | null;
}) {
  return renderWithProviders(
    <AgentHistoryFooter
      run={props.run}
      target="ssh"
      live={props.live ?? null}
      continuation={props.continuation ?? null}
    />,
    { bridge: { 'settings.get': { promptBuilderProvider: 'openai', openaiModel: 'm' } } },
  );
}

beforeEach(() => {
  installFakeMicrophone();
});

describe('a task that is still going', () => {
  it('answers the AI question right from the history', async () => {
    const c = controls({ phase: 'needs-input', message: 'Which site should I reload?' });
    const { user } = renderFooter({ run: live, live: c });
    expect(screen.getByRole('region', { name: 'The AI asks' })).toHaveTextContent(
      'Which site should I reload?',
    );
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'staging{Enter}');
    expect(c.answer).toHaveBeenCalledWith('staging');
  });

  it('runs or skips a proposed command, and can still be told something', async () => {
    const c = controls({ phase: 'proposed', command: 'systemctl reload nginx' });
    const { user } = renderFooter({ run: live, live: c });
    expect(screen.getByText('systemctl reload nginx')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(c.approve).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(c.skip).toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toBeInTheDocument();
  });

  it('continues or stops a paused task', async () => {
    const c = controls({ phase: 'error', canContinue: true, message: 'Paused: no reply' });
    const { user } = renderFooter({ run: { ...live, status: 'paused' }, live: c });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(c.resume).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(c.stop).toHaveBeenCalled();
  });

  it('takes a message while the AI works, and offers Stop', async () => {
    const c = controls({ phase: 'running', command: 'apt-get upgrade -y' });
    const { user } = renderFooter({ run: live, live: c });
    await user.type(
      screen.getByRole('textbox', { name: 'Message to the AI' }),
      'skip the kernel{Enter}',
    );
    expect(c.send).toHaveBeenCalledWith('skip the kernel');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(c.stop).toHaveBeenCalled();
  });

  it('asks before typing the saved password', async () => {
    const c = controls({
      phase: 'needs-password',
      hasSavedPassword: true,
      message: 'The server is asking for a password.',
    });
    const { user } = renderFooter({ run: live, live: c });
    await user.click(screen.getByRole('button', { name: 'Enter password' }));
    expect(c.answerPassword).toHaveBeenCalledWith(true);
  });
});

describe('a task that has ended', () => {
  it('continues with what the user wants next, saying where and how it will run', async () => {
    const cont = continuation();
    const { user } = renderFooter({ run: ended, continuation: cont });
    expect(screen.getByText(/Runs in web-01/)).toHaveTextContent('Approve each command');
    const box = screen.getByRole('textbox', { name: 'What to do next' });
    await user.type(box, 'now enable https');
    await user.click(screen.getByRole('button', { name: 'Continue task' }));
    expect(cont.continueWith).toHaveBeenCalledWith(ended, 'now enable https');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps the text when the task could not be started', async () => {
    const cont = continuation({ continueWith: vi.fn(async () => false) });
    const { user } = renderFooter({ run: ended, continuation: cont });
    const box = screen.getByRole('textbox', { name: 'What to do next' });
    await user.type(box, 'go on{Enter}');
    expect(cont.continueWith).toHaveBeenCalled();
    expect(box).toHaveValue('go on');
  });

  it('runs it again or opens the full options', async () => {
    const cont = continuation();
    const { user } = renderFooter({ run: ended, continuation: cont });
    await user.click(screen.getByRole('button', { name: 'Run again' }));
    expect(cont.runAgain).toHaveBeenCalledWith(ended);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    expect(cont.moreOptions).toHaveBeenCalledWith(ended);
  });

  it('says why it cannot start right now', () => {
    renderFooter({
      run: ended,
      continuation: continuation({
        blockedReason: 'An AI task is already running in this terminal.',
      }),
    });
    expect(screen.getByText('An AI task is already running in this terminal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeDisabled();
  });

  it('shows nothing to act on when the task cannot be continued from here', () => {
    const { container } = renderFooter({ run: ended });
    expect(container).toBeEmptyDOMElement();
  });
});
