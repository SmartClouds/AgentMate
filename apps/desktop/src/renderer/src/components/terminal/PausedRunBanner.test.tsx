import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunPauseStore } from '@/stores/runPauseStore';
import { type TerminalSessionMeta, useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { PausedRunBanner } from './PausedRunBanner';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  Toaster: () => null,
}));

/**
 * The strip over a frozen run's terminal. Its output has stopped and keystrokes go nowhere
 * visible, so without it a paused terminal just looks hung. It says why and has the way back.
 */

const DEV: TerminalSessionMeta = {
  id: 'dev',
  title: 'Apollo',
  cwd: 'E:\\apollo',
  run: { commandId: 'dev', label: 'Dev', command: 'pnpm dev', kind: 'web', startedAt: 1 },
};

beforeEach(() => {
  useTerminalStore.setState({ sessions: [DEV], activeSessionId: 'dev' });
  useRunPauseStore.setState({ paused: {}, pending: {} });
});

describe('PausedRunBanner', () => {
  it('shows nothing for a run that is running', () => {
    renderWithProviders(<PausedRunBanner sessionId="dev" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says the run is frozen and what happens to typing and file changes', () => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });
    renderWithProviders(<PausedRunBanner sessionId="dev" />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Paused. Its processes are frozen and use no CPU.');
    expect(banner).toHaveTextContent(
      'What you type and any file changes are handled when you resume.',
    );
  });

  it('says when an agent paused it and that it comes back on its own', () => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'agent', pausedAt: 1 } }, pending: {} });
    renderWithProviders(<PausedRunBanner sessionId="dev" />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Paused while an agent works in this folder. It resumes on its own a few seconds after the agent is done.',
    );
  });

  it('resumes from its button', async () => {
    useRunPauseStore.setState({ paused: { dev: { reason: 'user', pausedAt: 1 } }, pending: {} });
    const { user, bridge } = renderWithProviders(<PausedRunBanner sessionId="dev" />, {
      bridge: {
        'terminal.resume': {
          ok: true,
          paused: false,
          reason: null,
          pausedAt: null,
          processCount: 2,
          failedCount: 0,
          containersOnly: false,
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Resume Dev' }));

    expect(bridge.$fn('terminal.resume')).toHaveBeenCalledWith('dev');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the resume on its way', () => {
    useRunPauseStore.setState({
      paused: { dev: { reason: 'user', pausedAt: 1 } },
      pending: { dev: 'resuming' },
    });
    renderWithProviders(<PausedRunBanner sessionId="dev" />);

    const button = screen.getByRole('button', { name: 'Resume Dev' });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Resuming');
  });
});
