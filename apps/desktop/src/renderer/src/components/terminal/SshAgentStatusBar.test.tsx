import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { act, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SshAgentSessionState, useSshAgentStore } from '@/stores/sshAgentStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { FakeBridge } from '../../../../test/renderer/runovaBridge';
import { SshAgentStatusBar } from './SshAgentStatusBar';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function renderBar(
  state: Partial<SshAgentSessionState> | null,
  { delivered = true }: { delivered?: boolean } = {},
) {
  if (state) {
    useSshAgentStore.setState({
      sessions: { s1: { mode: 'approve-all', phase: 'thinking', step: 1, ...state } },
    });
  } else {
    useSshAgentStore.setState({ sessions: {} });
  }
  const view = renderWithProviders(<SshAgentStatusBar sessionId="s1" onOpenHistory={vi.fn()} />);
  view.bridge.$set('sshAgent.sendMessage', async () => delivered);
  return view;
}

/** Moves the run on, the way a progress event from main would. */
function setState(patch: Partial<SshAgentSessionState>): void {
  act(() => {
    useSshAgentStore.setState((current) => ({
      sessions: { s1: { ...current.sessions.s1, ...patch } as SshAgentSessionState },
    }));
  });
}

/** The bridge hands out a call's mock on first use, so a send that never happened has none. */
function expectNothingSent(bridge: FakeBridge): void {
  expect(() => bridge.$fn('sshAgent.sendMessage')).toThrow('has not been touched');
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(toast.error).mockClear();
});

describe('the Message button', () => {
  it.each([
    ['thinking', {}],
    ['proposed', { command: 'rm -rf /tmp/cache' }],
    ['running', { command: 'apt-get update' }],
    ['needs-password', { command: 'sudo ls' }],
    ['error', { canContinue: true, message: 'Paused: boom' }],
  ] as const)('is offered while the task is %s', (phase, extra) => {
    renderBar({ phase, ...extra });
    expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument();
  });

  it('is not offered once the task is over', () => {
    for (const phase of ['finished', 'stopped'] as const) {
      const { unmount } = renderBar({ phase, message: 'Done.' });
      expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
      unmount();
    }
    renderBar({ phase: 'error', message: 'Failed for good.' });
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('is left out while the AI is asking a question, which has its own answer field', () => {
    renderBar({ phase: 'needs-input', message: 'Which directory?' });
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Your answer/)).toBeInTheDocument();
  });

  it('opens the message box, focused, and closes it again', async () => {
    const { user } = renderBar({ phase: 'running', command: 'sleep 60' });
    const toggle = screen.getByRole('button', { name: 'Message' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toHaveFocus();

    await user.click(toggle);
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the button', async () => {
    const { user } = renderBar({ phase: 'running', command: 'sleep 60' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message' })).toHaveFocus();
  });

  it('closes from the close button', async () => {
    const { user } = renderBar({ phase: 'thinking' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.click(screen.getByRole('button', { name: 'Close message box' }));
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();
  });
});

describe('sending a message', () => {
  async function openBox(state: Partial<SshAgentSessionState>) {
    const view = renderBar(state);
    await view.user.click(screen.getByRole('button', { name: 'Message' }));
    return { ...view, box: screen.getByRole('textbox', { name: 'Message to the AI' }) };
  }

  it('sends on Enter, clears the box, and says what happens next', async () => {
    const { user, bridge, box } = await openBox({ phase: 'running', command: 'apt-get update' });
    await user.type(box, 'skip the upgrade{Enter}');

    expect(
      await screen.findByText('Sent. The AI reads it when the command finishes.'),
    ).toBeInTheDocument();
    expect(bridge.$fn('sshAgent.sendMessage')).toHaveBeenCalledWith('s1', 'skip the upgrade');
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
  });

  it('sends from the Send button', async () => {
    const { user, bridge, box } = await openBox({ phase: 'thinking' });
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toBeDisabled();

    await user.type(box, '  use the staging host  ');
    expect(send).toBeEnabled();
    await user.click(send);

    await screen.findByText(/^Sent\./);
    expect(bridge.$fn('sshAgent.sendMessage')).toHaveBeenCalledWith('s1', 'use the staging host');
  });

  it('keeps Shift+Enter for a new line instead of sending', async () => {
    const { user, bridge, box } = await openBox({ phase: 'thinking' });
    await user.type(box, 'first{Shift>}{Enter}{/Shift}second');

    expect(box).toHaveValue('first\nsecond');
    expectNothingSent(bridge);
  });

  it('does not send while an input method is still composing', async () => {
    const { bridge, box, user } = await openBox({ phase: 'thinking' });
    await user.type(box, 'سلام');

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      box.dispatchEvent(enter);
    });

    expect(enter.defaultPrevented).toBe(false);
    expectNothingSent(bridge);
    expect(box).toHaveValue('سلام');
  });

  it('sends nothing for an empty or blank message', async () => {
    const { user, bridge, box } = await openBox({ phase: 'thinking' });
    await user.type(box, '   {Enter}');
    expectNothingSent(bridge);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('stops typing at the length the main process accepts', async () => {
    const { box } = await openBox({ phase: 'thinking' });
    expect(box).toHaveAttribute('maxLength', String(MAX_SSH_AGENT_MESSAGE_CHARS));
  });

  it('keeps the text and says so when the task ended in the meantime', async () => {
    const view = renderBar({ phase: 'running', command: 'sleep 5' }, { delivered: false });
    await view.user.click(screen.getByRole('button', { name: 'Message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the AI' });
    await view.user.type(box, 'one more thing{Enter}');

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The AI task has already ended, so nothing was sent.',
      ),
    );
    expect(box).toHaveValue('one more thing');
    expect(screen.queryByText(/^Sent\./)).not.toBeInTheDocument();
  });

  it('keeps the text and says so when the message could not be delivered', async () => {
    const view = renderBar({ phase: 'running', command: 'sleep 5' });
    view.bridge.$set('sshAgent.sendMessage', async () => {
      throw new Error('ipc down');
    });
    await view.user.click(screen.getByRole('button', { name: 'Message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the AI' });
    await view.user.type(box, 'hello{Enter}');

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't send the message. Try again."),
    );
    expect(box).toHaveValue('hello');
  });

  it('clears the confirmation as soon as the user types again', async () => {
    const { user, box } = await openBox({ phase: 'thinking' });
    await user.type(box, 'one{Enter}');
    expect(await screen.findByText(/^Sent\./)).toBeInTheDocument();

    await user.type(box, 'two');
    expect(screen.queryByText(/^Sent\./)).not.toBeInTheDocument();
  });

  it('fades the confirmation after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { user, box } = await openBox({ phase: 'thinking' });
    await user.type(box, 'one{Enter}');
    expect(await screen.findByText(/^Sent\./)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(screen.queryByText(/^Sent\./)).not.toBeInTheDocument();
  });
});

describe('what the box says depends on when the AI will read the message', () => {
  it.each([
    ['thinking', {}, /reads this right away/, /The AI is reading it now/],
    [
      'proposed',
      { command: 'rm -rf /tmp/cache' },
      /what to do instead\. This skips the command above/,
      /That command was skipped/,
    ],
    [
      'running',
      { command: 'apt-get update' },
      /reads this when the command finishes/,
      /reads it when the command finishes/,
    ],
    [
      'needs-password',
      { command: 'sudo ls' },
      /reads this when the command finishes/,
      /reads it when the command finishes/,
    ],
    [
      'error',
      { canContinue: true, message: 'Paused: boom' },
      /reads this when you continue/,
      /reads it when you continue/,
    ],
  ] as const)('while %s', async (phase, extra, placeholder, confirmation) => {
    const { user } = renderBar({ phase, ...extra });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the AI' });
    expect(box).toHaveAttribute('placeholder', expect.stringMatching(placeholder));

    await user.type(box, 'hello{Enter}');
    expect(await screen.findByText(confirmation)).toBeInTheDocument();
  });
});

describe('the queued pill', () => {
  it('shows while a message waits for the AI, and goes once it has been read', () => {
    renderBar({ phase: 'running', command: 'apt-get update', queuedMessages: 1 });
    expect(screen.getByText('Message queued')).toBeInTheDocument();

    setState({ phase: 'thinking', queuedMessages: undefined });
    expect(screen.queryByText('Message queued')).not.toBeInTheDocument();
  });

  it('counts more than one', () => {
    renderBar({ phase: 'running', command: 'apt-get update', queuedMessages: 3 });
    expect(screen.getByText('3 messages queued')).toBeInTheDocument();
  });

  it('is absent when nothing was sent', () => {
    renderBar({ phase: 'running', command: 'apt-get update' });
    expect(screen.queryByText(/queued/)).not.toBeInTheDocument();
  });
});

describe('the box as the run moves on', () => {
  it('hides while the AI asks a question and comes back with the draft intact', async () => {
    const { user } = renderBar({ phase: 'running', command: 'sleep 60' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message to the AI' }), 'half a thou');

    setState({ phase: 'needs-input', message: 'Which directory?' });
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();

    setState({ phase: 'thinking', message: undefined });
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toHaveValue('half a thou');
  });

  it('keeps the draft when the box is closed and opened again', async () => {
    const { user } = renderBar({ phase: 'thinking' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message to the AI' }), 'remember me');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Message' }));
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toHaveValue('remember me');
  });

  it('closes when the task ends and does not leave a draft for the next one', async () => {
    const { user } = renderBar({ phase: 'thinking' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message to the AI' }), 'unsent');

    setState({ phase: 'finished', message: 'All done.' });
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();

    // A new task in the same terminal starts with a clean box.
    setState({ phase: 'thinking', step: 1, message: undefined });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toHaveValue('');
  });
});

describe('the rest of the bar', () => {
  it('still renders nothing without a task', () => {
    const { container } = renderBar(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('still offers Run and Skip next to Message on a proposed command', async () => {
    const { user, bridge } = renderBar({
      phase: 'proposed',
      command: 'rm -rf /tmp/cache',
      message: 'This command looks destructive.',
    });
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(bridge.$fn('sshAgent.approveCommand')).toHaveBeenCalledWith('s1');
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(bridge.$fn('sshAgent.skipCommand')).toHaveBeenCalledWith('s1');
    expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument();
  });

  it('still offers Continue and Stop on a paused run', async () => {
    const { user, bridge } = renderBar({
      phase: 'error',
      canContinue: true,
      message: 'Paused: boom',
    });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(bridge.$fn('sshAgent.continueTask')).toHaveBeenCalledWith('s1');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.$fn('sshAgent.stop')).toHaveBeenCalledWith('s1');
  });

  it('still sends an answer to a question', async () => {
    const { user, bridge } = renderBar({ phase: 'needs-input', message: 'Which directory?' });
    await user.type(screen.getByPlaceholderText(/Your answer/), '/var/log{Enter}');
    expect(bridge.$fn('sshAgent.answerNeedsInput')).toHaveBeenCalledWith('s1', '/var/log');
  });
});

describe('a question from the AI', () => {
  const LONG_QUESTION =
    'I found three nginx sites: default, api.example.com and staging.example.com. Only staging changed today. Which one should I reload?';

  it('shows in full under the bar, while the bar line says what it waits for', () => {
    renderBar({ phase: 'needs-input', message: LONG_QUESTION });
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'The AI asks' })).toHaveTextContent(LONG_QUESTION);
  });

  it('is answered from the panel, focused and ready to type', async () => {
    const { user, bridge } = renderBar({ phase: 'needs-input', message: LONG_QUESTION });
    const box = screen.getByRole('textbox', { name: 'Your answer' });
    expect(box).toHaveFocus();
    await user.type(box, 'staging');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(bridge.$fn('sshAgent.answerNeedsInput')).toHaveBeenCalledWith('s1', 'staging');
  });

  it('offers the same tools as Build Prompt for the answer', () => {
    renderBar({ phase: 'needs-input', message: 'Which one?' });
    expect(screen.getByRole('button', { name: /Write it for me/ })).toBeInTheDocument();
  });

  it('starts the next question with an empty answer box', async () => {
    const { user } = renderBar({ phase: 'needs-input', message: 'First?' });
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'unsent');
    setState({ phase: 'thinking', message: undefined });
    setState({ phase: 'needs-input', message: 'Second?' });
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue('');
  });
});

describe('a long line in the bar', () => {
  it('shows all of itself in a tooltip on hover', async () => {
    const summary =
      'Cleaned 4.2 GB of rotated logs from /var/log/nginx and /var/log/journal, then restarted nginx and confirmed all three sites answer.';
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    const clientWidth = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(200);
    try {
      const { user } = renderBar({ phase: 'finished', message: summary });
      await user.hover(screen.getByText(summary));
      expect(await screen.findByRole('tooltip')).toHaveTextContent(summary);
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });
});

describe('the message box tools', () => {
  it('has dictation, translation and Write it for me, as Build Prompt does', async () => {
    const { user } = renderBar({ phase: 'running', command: 'sleep 60' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message to the AI' }), 'صبر کن');
    expect(screen.getByRole('button', { name: /Translate to English/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Write it for me/ })).toBeInTheDocument();
  });
});
