import { screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { PipelinesNotice } from './PipelinesNotice';
import type { PipelineNotice } from './usePipelineStatus';

const onRetry = vi.fn();
const onLeave = vi.fn();

function Where(): React.JSX.Element {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderNotice(notice: PipelineNotice, extra: { retrying?: boolean } = {}) {
  return renderWithProviders(
    <>
      <PipelinesNotice
        notice={notice}
        retrying={extra.retrying ?? false}
        onRetry={onRetry}
        onLeave={onLeave}
      />
      <Where />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useTerminalStore.setState({ sessions: [], activeSessionId: null });
});

describe('PipelinesNotice', () => {
  it('sends someone without gh to Agent Tools, leaving the surface first', async () => {
    const { user } = renderNotice({ kind: 'no-cli' });
    expect(screen.getByText('GitHub CLI not found')).toBeInTheDocument();
    expect(screen.getByText('Install gh to see workflow runs here.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open Agent Tools' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/tools');
  });

  it('opens a terminal with gh auth login when signed out, leaving the surface first', async () => {
    const { user } = renderNotice({ kind: 'signed-out' });
    expect(screen.getByText('Sign in to GitHub')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run gh auth login' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().sessions).toMatchObject([
      { title: 'GitHub sign in', initialInput: 'gh auth login' },
    ]);
  });

  it('says the repo is not on GitHub, with nothing to click', () => {
    renderNotice({ kind: 'no-remote' });
    expect(screen.getByText('No GitHub remote')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the repo that has no workflows, with nothing to click', () => {
    renderNotice({ kind: 'no-workflows', repo: 'acme/app' });
    expect(screen.getByText('No workflows yet')).toBeInTheDocument();
    expect(screen.getByText('acme/app has no GitHub Actions.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers Retry on a load error and keeps the raw error behind a tooltip', async () => {
    const { user } = renderNotice({ kind: 'error', error: 'HTTP 403: rate limited' });
    expect(screen.getByText('Could not load pipelines')).toBeInTheDocument();

    await user.hover(screen.getByText('Could not connect to GitHub.'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('HTTP 403: rate limited');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Retrying again is not leaving anything.
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('asks to try again in a moment when there is no error text', () => {
    renderNotice({ kind: 'error', error: null });
    expect(screen.getByText('Try again in a moment.')).toBeInTheDocument();
  });

  it('shows Retrying while a retry is in flight and ignores clicks', async () => {
    const { user } = renderNotice({ kind: 'error', error: 'rate limited' }, { retrying: true });
    const busy = screen.getByRole('button', { name: 'Retrying…' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');

    await user.click(busy);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
