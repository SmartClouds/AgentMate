import type { SftpBatchView, SftpItemView, SftpQueueSnapshot } from '@shared/sftpTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { TransferQueueProps } from './contracts';
import { TransferQueue } from './TransferQueue';

/**
 * The Transfers card: one row per batch with its counts, bytes, speed and time left, the state in
 * words, and the buttons that cancel, retry and clear. It only draws the snapshot it is given and
 * hands every click to the page.
 */

const MB = 1024 * 1024;

function item(over: Partial<SftpItemView> = {}): SftpItemView {
  return {
    itemId: 'i1',
    relPath: 'index.html',
    size: 100,
    transferred: 0,
    state: 'queued',
    error: null,
    errorCode: null,
    ...over,
  };
}

function batch(over: Partial<SftpBatchView> = {}): SftpBatchView {
  return {
    batchId: 'b1',
    kind: 'upload',
    label: 'site (1,204 files)',
    source: 'C:\\work',
    target: '/var/www',
    state: 'running',
    totalItems: 1204,
    doneItems: 412,
    failedItems: 0,
    skippedItems: 0,
    totalBytes: 120 * MB,
    transferredBytes: 38 * MB,
    bytesPerSecond: 2.1 * MB,
    etaSeconds: 40,
    running: [],
    failures: [],
    failuresTruncated: false,
    createdAt: 1,
    finishedAt: null,
    ...over,
  };
}

function snap(batches: SftpBatchView[]): SftpQueueSnapshot {
  return { sessionId: 's1', batches, conflict: null, pendingConflicts: 0 };
}

function renderQueue(snapshot: SftpQueueSnapshot | null, over: Partial<TransferQueueProps> = {}) {
  const props: TransferQueueProps = {
    snapshot,
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onClearFinished: vi.fn(),
    ...over,
  };
  return { ...renderWithProviders(<TransferQueue {...props} />), props };
}

describe('TransferQueue', () => {
  it('draws nothing before the first snapshot or when the queue is empty', () => {
    const { container, rerender } = renderQueue(null);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <TransferQueue
        snapshot={snap([])}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onClearFinished={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Transfers' })).toBeNull();
  });

  it('shows the counts, bytes, speed and time left of a running batch', () => {
    renderQueue(snap([batch()]));

    const card = screen.getByRole('region', { name: 'Transfers' });
    expect(within(card).getByText('site (1,204 files)')).toBeInTheDocument();
    expect(within(card).getByText('412 of 1,204')).toBeInTheDocument();
    expect(within(card).getByText('38.0 MB / 120.0 MB')).toBeInTheDocument();
    expect(within(card).getByText('2.1 MB/s')).toBeInTheDocument();
    expect(within(card).getByText('40 s left')).toBeInTheDocument();
    expect(within(card).getByText('Upload')).toBeInTheDocument();
    // The count next to the heading.
    expect(within(card).getByText('1')).toBeInTheDocument();
  });

  it('gives the bar its percentage from the bytes moved', () => {
    renderQueue(snap([batch()]));
    const bar = screen.getByRole('progressbar', { name: 'site (1,204 files) progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '32');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('counts items for a delete, which moves no bytes', () => {
    renderQueue(
      snap([
        batch({
          kind: 'delete',
          label: 'old (10 items)',
          target: null,
          totalItems: 10,
          doneItems: 5,
          totalBytes: 0,
          transferredBytes: 0,
          bytesPerSecond: null,
          etaSeconds: null,
        }),
      ]),
    );
    expect(screen.getByRole('progressbar', { name: 'old (10 items) progress' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(screen.getByText('5 of 10')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.queryByText(/ left$/)).toBeNull();
  });

  it('says it is still counting while a folder is expanded, with no value on the bar', () => {
    renderQueue(
      snap([batch({ state: 'expanding', totalItems: null, totalBytes: null, doneItems: 0 })]),
    );
    expect(screen.getByText('Counting files…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('says only Skipped for a finished batch that skipped every file', () => {
    renderQueue(
      snap([
        batch({
          batchId: 's',
          label: 'index.html',
          state: 'done',
          totalItems: 1,
          doneItems: 0,
          skippedItems: 1,
          finishedAt: 5,
        }),
      ]),
    );
    expect(screen.getByText('Skipped 1')).toBeInTheDocument();
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('shows the state of each batch in words', () => {
    renderQueue(
      snap([
        batch({ batchId: 'w', label: 'waiting.txt', state: 'waiting' }),
        batch({
          batchId: 'd',
          label: 'done.txt',
          state: 'done',
          doneItems: 1204,
          finishedAt: 5,
          transferredBytes: 120 * MB,
        }),
        batch({ batchId: 'c', label: 'cancelled.txt', state: 'cancelled', finishedAt: 5 }),
      ]),
    );
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    // Finished batches have no bar and no speed.
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('cancels a running batch and retries a cancelled one', async () => {
    const { user, props } = renderQueue(
      snap([
        batch({ batchId: 'run', label: 'run.zip' }),
        batch({ batchId: 'stop', label: 'stop.zip', state: 'cancelled', finishedAt: 2 }),
      ]),
    );

    await user.click(screen.getByRole('button', { name: 'Cancel run.zip' }));
    expect(props.onCancel).toHaveBeenCalledWith({ batchId: 'run' });

    await user.click(screen.getByRole('button', { name: 'Retry stop.zip' }));
    expect(props.onRetry).toHaveBeenCalledWith({ batchId: 'stop' });
    expect(screen.queryByRole('button', { name: 'Cancel stop.zip' })).toBeNull();
  });

  it('expands the failures and retries one of them', async () => {
    const failures = [
      item({
        itemId: 'f1',
        relPath: 'assets/app.css',
        state: 'failed',
        error: 'Permission denied',
        errorCode: 'permissionDenied',
      }),
      item({
        itemId: 'f2',
        relPath: 'logo.png',
        state: 'failed',
        error: 'No space left',
        errorCode: 'diskFull',
      }),
    ];
    const { user, props } = renderQueue(
      snap([batch({ state: 'failed', failedItems: 2, failures, finishedAt: 9 })]),
    );

    const toggle = screen.getByRole('button', { name: /Failed 2/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('assets/app.css')).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Failed files' });
    expect(within(list).getByText('assets/app.css')).toBeInTheDocument();
    expect(within(list).getByText('Permission denied')).toBeInTheDocument();
    expect(
      within(list).getByText('The server is out of space, or over its quota.'),
    ).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'Retry assets/app.css' }));
    expect(props.onRetry).toHaveBeenCalledWith({ batchId: 'b1', itemId: 'f1' });
  });

  it('says when there were more failures than the list holds', async () => {
    const { user } = renderQueue(
      snap([
        batch({
          state: 'failed',
          failedItems: 80,
          failures: [item({ state: 'failed', error: 'x', errorCode: 'server' })],
          failuresTruncated: true,
          finishedAt: 9,
        }),
      ]),
    );
    await user.click(screen.getByRole('button', { name: /Failed 80/ }));
    expect(screen.getByText(/79 more failed/)).toBeInTheDocument();
  });

  it('offers the header actions only when they would do something', async () => {
    const { user, props, rerender } = renderQueue(snap([batch()]));
    expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear finished' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel all' }));
    expect(props.onCancel).toHaveBeenCalledWith({});

    // A rerender replaces the whole tree, providers included.
    rerender(
      <TooltipProvider>
        <TransferQueue
          {...props}
          snapshot={snap([
            batch({ batchId: 'f', state: 'failed', failedItems: 1, finishedAt: 3 }),
            batch({ batchId: 'd', state: 'done', finishedAt: 3 }),
          ])}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry failed' }));
    expect(props.onRetry).toHaveBeenCalledWith({});
    await user.click(screen.getByRole('button', { name: 'Clear finished' }));
    expect(props.onClearFinished).toHaveBeenCalled();
  });

  it('shows itself busy until a slow callback settles', async () => {
    let release: () => void = () => undefined;
    const onClearFinished = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { user } = renderQueue(snap([batch({ state: 'done', finishedAt: 3 })]), {
      onClearFinished,
    });
    const button = screen.getByRole('button', { name: 'Clear finished' });
    await user.click(button);
    expect(button).toBeDisabled();
    release();
    await vi.waitFor(() => expect(button).toBeEnabled());
  });

  it('collapses to its header and opens again', async () => {
    const { user } = renderQueue(snap([batch()]));
    const toggle = screen.getByRole('button', { name: 'Hide transfers' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(screen.queryByText('site (1,204 files)')).toBeNull();
    expect(screen.getByText('1 running')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show transfers' }));
    expect(screen.getByText('site (1,204 files)')).toBeInTheDocument();
  });

  it('can start as its one-line header, as the dock draws it', async () => {
    const { user } = renderQueue(snap([batch()]), { defaultOpen: false });
    expect(screen.getByRole('button', { name: 'Show transfers' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('site (1,204 files)')).toBeNull();
    expect(screen.getByText('1 running')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show transfers' }));
    expect(screen.getByText('site (1,204 files)')).toBeInTheDocument();
  });

  it('lists the files on their way in a multi-file batch', () => {
    renderQueue(
      snap([
        batch({
          running: [
            item({
              itemId: 'r1',
              relPath: 'img/a.png',
              size: 4 * MB,
              transferred: MB,
              state: 'running',
            }),
          ],
        }),
      ]),
    );
    expect(screen.getByText('img/a.png')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});
