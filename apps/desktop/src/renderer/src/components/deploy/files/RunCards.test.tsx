import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { RunProgressCard } from './RunProgressCard';
import { RunSummaryCard } from './RunSummaryCard';
import { progressEvent, runResult } from './testing/fixtures';

/**
 * A deploy as it runs, in place of the Deploy button (never over the page), and how it ended:
 * what was sent, what failed and why, and the way to send the failed files again.
 */

describe('RunProgressCard', () => {
  it('shows the phase, the file on its way, both bars, the speed and the time left', () => {
    const now = Date.now();
    renderWithProviders(
      <RunProgressCard
        progress={progressEvent({
          filesDone: 1,
          filesTotal: 4,
          bytesDone: 2048,
          bytesTotal: 10_240,
        })}
        samples={[
          { at: now - 2000, bytes: 0 },
          { at: now, bytes: 2048 },
        ]}
        onCancel={vi.fn()}
      />,
    );

    const card = screen.getByRole('region', { name: 'Deploy progress' });
    expect(within(card).getByText('Uploading')).toBeTruthy();
    expect(within(card).getByText('css/site.css')).toBeTruthy();
    const files = within(card).getByRole('progressbar', { name: 'Files' });
    expect(files.getAttribute('aria-valuenow')).toBe('1');
    expect(files.getAttribute('aria-valuemax')).toBe('4');
    expect(within(card).getByText('1 of 4 files')).toBeTruthy();
    const bytes = within(card).getByRole('progressbar', { name: 'Data' });
    expect(bytes.getAttribute('aria-valuenow')).toBe('20');
    expect(within(card).getByText('2.00 KB of 10.0 KB')).toBeTruthy();
    expect(within(card).getByText('1.00 KB/s')).toBeTruthy();
    expect(within(card).getByText('8 s left')).toBeTruthy();
  });

  it('says it is connecting before the first progress comes', () => {
    renderWithProviders(<RunProgressCard progress={null} samples={[]} onCancel={vi.fn()} />);
    expect(screen.getByText('Connecting')).toBeTruthy();
    expect(screen.getByText('Working out the speed…')).toBeTruthy();
  });

  it('names a Deploy on save run as such', () => {
    renderWithProviders(
      <RunProgressCard
        progress={progressEvent({
          trigger: 'deployOnSave',
          bytesTotal: 0,
          bytesDone: 0,
          currentPath: null,
        })}
        samples={[]}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/Deploy on save is sending your changes/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Data' }).getAttribute('aria-valuenow')).toBe(
      '0',
    );
  });

  it('cancels, and stays put while the cancel is on its way', async () => {
    const onCancel = vi.fn();
    const { user, rerender } = renderWithProviders(
      <RunProgressCard progress={progressEvent()} samples={[]} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    rerender(
      <RunProgressCard progress={progressEvent()} samples={[]} onCancel={onCancel} cancelling />,
    );
    expect(screen.getByRole('button', { name: /Cancelling/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('RunSummaryCard', () => {
  it('says a run went through, with its counts and how long it took', () => {
    renderWithProviders(
      <RunSummaryCard
        result={runResult({ startedAt: 0, finishedAt: 12_000 })}
        notes={null}
        onRetryFailed={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const card = screen.getByRole('region', { name: 'Last deploy' });
    expect(within(card).getByText('Deployed')).toBeTruthy();
    expect(within(card).getByText(/2 uploaded, 1 deleted/)).toBeTruthy();
    expect(within(card).getByText(/took 12 s/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Retry failed/ })).toBeNull();
  });

  it('lists the failed files with the reason, and retries them', async () => {
    const onRetryFailed = vi.fn();
    const { user } = renderWithProviders(
      <RunSummaryCard
        result={runResult({
          state: 'partial',
          failed: [
            { path: 'big.zip', code: 'diskFull', message: 'x' },
            { path: 'a.html', code: 'server', message: '553 Not allowed' },
          ],
        })}
        notes={null}
        onRetryFailed={onRetryFailed}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Partly deployed')).toBeTruthy();
    expect(screen.getByText(/The rest is still in the list/)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show failed files (2)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    const failed = screen.getByRole('list', { name: 'Failed files' });
    expect(within(failed).getByText('The server is out of space, or over its quota.')).toBeTruthy();
    expect(within(failed).getByText('553 Not allowed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hide failed files' }));
    expect(screen.queryByRole('list', { name: 'Failed files' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Retry failed/ }));
    expect(onRetryFailed).toHaveBeenCalledWith(['big.zip', 'a.html']);
  });

  it('says why a run failed and what stays pending after a cancel', () => {
    const { unmount } = renderWithProviders(
      <RunSummaryCard
        result={runResult({
          state: 'failed',
          uploaded: 0,
          deleted: 0,
          error: { code: 'auth', message: 'no' },
        })}
        notes={null}
        onRetryFailed={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/didn't accept the username/)).toBeTruthy();
    unmount();

    renderWithProviders(
      <RunSummaryCard
        result={runResult({ state: 'cancelled', trigger: 'deployOnSave' })}
        notes={null}
        onRetryFailed={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText(/What was not sent is still in the list/)).toBeTruthy();
    expect(screen.getByText(/Started by Deploy on save/)).toBeTruthy();
  });

  it('notes a run whose replaces were not done in one step, and the notes from the check', () => {
    renderWithProviders(
      <RunSummaryCard
        result={runResult({ atomic: false })}
        notes={{ notices: ['sizeOnly'], drift: ['x.html'] }}
        onRetryFailed={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/judged by size alone/)).toBeTruthy();
    expect(screen.getByText(/1 file changed on the server only was left as it is/)).toBeTruthy();
    expect(screen.getByText(/replaced files in place/)).toBeTruthy();
  });

  it('is put away with its close button', async () => {
    const onDismiss = vi.fn();
    const { user } = renderWithProviders(
      <RunSummaryCard
        result={runResult()}
        notes={null}
        onRetryFailed={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
