import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type RdpAgentSessionState, useRdpAgentStore } from '@/stores/rdpAgentStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RdpAgentStatusBar } from './RdpAgentStatusBar';

function renderBar(state: Partial<RdpAgentSessionState> | null, onOpenHistory = vi.fn()) {
  if (state) {
    useRdpAgentStore.setState({
      sessions: { s1: { mode: 'approve-all', phase: 'thinking', step: 1, ...state } },
    });
  }
  return {
    ...renderWithProviders(<RdpAgentStatusBar sessionId="s1" onOpenHistory={onOpenHistory} />),
    onOpenHistory,
  };
}

describe('RdpAgentStatusBar', () => {
  it('renders nothing without a task', () => {
    const { container } = renderBar(null);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the step while the AI looks at the screen, with Stop', async () => {
    const { user, bridge } = renderBar({ phase: 'thinking', step: 3 });
    expect(screen.getByText(/Step 3/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.$fn('rdpAgent.stop')).toHaveBeenCalledWith('s1');
  });

  it('offers Approve and Skip on a proposed action', async () => {
    const { user, bridge } = renderBar({
      phase: 'proposed',
      action: 'TYPE "hello"',
      message: 'Types text into the focused window.',
    });
    expect(screen.getByText('TYPE "hello"')).toBeInTheDocument();
    expect(screen.getByText(/Types text into the focused window/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(bridge.$fn('rdpAgent.approveAction')).toHaveBeenCalledWith('s1');
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(bridge.$fn('rdpAgent.skipAction')).toHaveBeenCalledWith('s1');
  });

  it('shows the action being carried out', () => {
    renderBar({ phase: 'acting', action: 'CLICK 100 200' });
    expect(screen.getByText('CLICK 100 200')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('sends an answer to a question', async () => {
    const { user, bridge } = renderBar({ phase: 'needs-input', message: 'Which file?' });
    expect(screen.getByText('Which file?')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'The AI asks' })).toHaveTextContent('Which file?');
    const send = screen.getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Your answer/), 'report.docx{Enter}');
    expect(bridge.$fn('rdpAgent.answerNeedsInput')).toHaveBeenCalledWith('s1', 'report.docx');
  });

  it('offers Continue and Stop on a paused run', async () => {
    const { user, bridge } = renderBar({
      phase: 'error',
      canContinue: true,
      message: 'The screenshot timed out.',
    });
    expect(screen.getByText('The screenshot timed out.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(bridge.$fn('rdpAgent.continueTask')).toHaveBeenCalledWith('s1');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.$fn('rdpAgent.stop')).toHaveBeenCalledWith('s1');
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
  });

  it('lets a finished run be dismissed', async () => {
    const { user } = renderBar({ phase: 'finished', message: 'Notepad is open.' });
    expect(screen.getByText('Notepad is open.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useRdpAgentStore.getState().sessions.s1).toBeUndefined();
  });

  it('opens the history', async () => {
    const { user, onOpenHistory } = renderBar({ phase: 'stopped', message: 'You took over.' });
    await user.click(screen.getByRole('button', { name: /History/ }));
    expect(onOpenHistory).toHaveBeenCalled();
  });
});

/** Moves the run on, the way a progress event from main would. */
function setState(patch: Partial<RdpAgentSessionState>): void {
  act(() => {
    useRdpAgentStore.setState((current) => ({
      sessions: { s1: { ...current.sessions.s1, ...patch } as RdpAgentSessionState },
    }));
  });
}

describe('messaging the AI mid-task', () => {
  it('is offered while the task runs, but not during a question or once it is over', () => {
    const { unmount } = renderBar({ phase: 'thinking' });
    expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument();

    setState({ phase: 'needs-input', message: 'Which file?' });
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();

    setState({ phase: 'finished', message: 'Done.' });
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
    unmount();
  });

  it('sends on Enter and says what happens next', async () => {
    const { user, bridge } = renderBar({ phase: 'thinking' });
    bridge.$set('rdpAgent.sendMessage', async () => true);
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the AI' });
    expect(box).toHaveFocus();

    await user.type(box, 'use the Start menu{Enter}');
    expect(await screen.findByText('Sent. The AI is reading it now.')).toBeInTheDocument();
    expect(bridge.$fn('rdpAgent.sendMessage')).toHaveBeenCalledWith('s1', 'use the Start menu');
    expect(box).toHaveValue('');
  });

  it.each([
    ['thinking', {}, /reads this right away/, /The AI is reading it now/],
    [
      'proposed',
      { action: 'CLICK 10 10' },
      /what to do instead\. This skips the action above/,
      /That action was skipped/,
    ],
    [
      'acting',
      { action: 'WAIT 2000' },
      /once the current action is done/,
      /once the current action is done/,
    ],
    [
      'error',
      { canContinue: true, message: 'Paused: boom' },
      /reads this when you continue/,
      /reads it when you continue/,
    ],
  ] as const)('says when the AI reads it while %s', async (phase, extra, placeholder, sent) => {
    const { user, bridge } = renderBar({ phase, ...extra });
    bridge.$set('rdpAgent.sendMessage', async () => true);
    await user.click(screen.getByRole('button', { name: 'Message' }));
    const box = screen.getByRole('textbox', { name: 'Message to the AI' });
    expect(box).toHaveAttribute('placeholder', expect.stringMatching(placeholder));

    await user.type(box, 'hello{Enter}');
    expect(await screen.findByText(sent)).toBeInTheDocument();
  });

  it('shows how many messages wait for the AI', () => {
    renderBar({ phase: 'acting', action: 'WAIT 2000', queuedMessages: 1 });
    expect(screen.getByText('Message queued')).toBeInTheDocument();

    setState({ queuedMessages: 2 });
    expect(screen.getByText('2 messages queued')).toBeInTheDocument();

    setState({ phase: 'thinking', queuedMessages: undefined });
    expect(screen.queryByText(/queued/)).not.toBeInTheDocument();
  });

  it('closes when the task ends and does not leave a draft for the next one', async () => {
    const { user } = renderBar({ phase: 'thinking' });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message to the AI' }), 'unsent');

    setState({ phase: 'stopped', message: 'Stopped by user.' });
    expect(screen.queryByRole('textbox', { name: 'Message to the AI' })).not.toBeInTheDocument();

    setState({ phase: 'thinking', step: 1, message: undefined });
    await user.click(screen.getByRole('button', { name: 'Message' }));
    expect(screen.getByRole('textbox', { name: 'Message to the AI' })).toHaveValue('');
  });
});
