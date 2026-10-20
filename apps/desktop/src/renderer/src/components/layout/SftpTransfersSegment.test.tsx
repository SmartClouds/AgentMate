import type {
  SftpBatchView,
  SftpConflict,
  SftpQueueSnapshot,
  SftpSessionInfo,
} from '@shared/sftpTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSftpStore, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useNavigate: () => navigate };
});

const dock = vi.hoisted(() => ({ openSftpDock: vi.fn() }));
vi.mock('@/lib/sftp/dock', () => dock);

const { SftpTransfersSegment } = await import('./SftpTransfersSegment');

/**
 * The file transfers item in the status bar (E25). Transfers can run for a long time, so the bar
 * shows how far they are from any page, says when one waits for an answer, and is the way back
 * to the file manager or to the dialog that asks.
 */

const MB = 1024 * 1024;

function batch(over: Partial<SftpBatchView> = {}): SftpBatchView {
  return {
    batchId: 'b1',
    kind: 'upload',
    label: 'site (12 files)',
    source: 'C:/work/site',
    target: '/var/www',
    state: 'running',
    totalItems: 12,
    doneItems: 3,
    failedItems: 0,
    skippedItems: 0,
    totalBytes: 100 * MB,
    transferredBytes: 25 * MB,
    bytesPerSecond: 2 * MB,
    etaSeconds: 38,
    running: [],
    failures: [],
    failuresTruncated: false,
    createdAt: 1,
    finishedAt: null,
    ...over,
  };
}

function conflict(batchId = 'b1'): SftpConflict {
  return {
    conflictId: 'c1',
    batchId,
    itemId: 'i1',
    direction: 'upload',
    name: 'index.html',
    relPath: 'index.html',
    targetDir: '/var/www',
    source: { size: 1, mtimeMs: 1 },
    target: { size: 2, mtimeMs: 2, isDirectory: false },
    renameTo: 'index (1).html',
    remainingInBatch: 0,
  };
}

function session(serverId: string, nickname: string): SftpSessionInfo {
  return {
    sessionId: `sess-${serverId}`,
    serverId,
    nickname,
    host: `${serverId}.example`,
    port: 22,
    username: 'deploy',
    home: '/home/deploy',
  };
}

/** Puts a ready server with these batches in the store, as a queue snapshot would. */
function serverWith(
  serverId: string,
  batches: SftpBatchView[],
  options: { nickname?: string; conflict?: SftpConflict | null; pendingConflicts?: number } = {},
): void {
  const queue: SftpQueueSnapshot = {
    sessionId: `sess-${serverId}`,
    batches,
    conflict: options.conflict ?? null,
    pendingConflicts: options.pendingConflicts ?? 0,
  };
  useSftpStore.setState((state) => ({
    servers: {
      ...state.servers,
      [serverId]: {
        ...serverFiles(state, serverId),
        session: session(serverId, options.nickname ?? serverId),
        status: 'ready',
        queue,
      },
    },
  }));
}

function setup(route = '/') {
  return renderWithProviders(<SftpTransfersSegment />, { route });
}

const item = () => screen.getByRole('button', { name: /^File transfers/ });

async function openPanel(user: ReturnType<typeof setup>['user']): Promise<HTMLElement> {
  await user.click(item());
  return screen.findByRole('dialog');
}

/** The page's own URL with an app route in its hash, the way HashRouter writes history. */
function appUrl(route: string): string {
  return `${window.location.origin}${window.location.pathname}#${route}`;
}

/**
 * Chromium's Navigation API, which is how leaving the page sees the entry before this one. Null
 * takes it away, the way an engine without it (or a first entry) would.
 */
function installNavigation(urls: string[] | null): void {
  const value =
    urls === null
      ? undefined
      : {
          currentEntry: { url: urls.at(-1) ?? null, index: urls.length - 1 },
          entries: () => urls.map((url, index) => ({ url, index })),
        };
  Object.defineProperty(window, 'navigation', { value, configurable: true, writable: true });
}

afterEach(() => installNavigation(null));

beforeEach(() => {
  resetSftpStore();
  navigate.mockClear();
  toast.error.mockClear();
  dock.openSftpDock.mockReset();
});

describe('the file transfers status bar item', () => {
  it('stays out of the bar while nothing runs and nothing waits', () => {
    const { container } = setup();
    expect(container.textContent).toBe('');
    // A queue whose batches are all over is idle too.
    act(() =>
      serverWith('web', [
        batch({ state: 'done', finishedAt: 2 }),
        batch({ batchId: 'b2', state: 'cancelled', finishedAt: 3 }),
      ]),
    );
    expect(screen.queryByRole('button', { name: /^File transfers/ })).toBeNull();
  });

  it('counts the transfers and says how far they are, by bytes', () => {
    serverWith('web', [
      batch(),
      batch({ batchId: 'b2', totalBytes: 100 * MB, transferredBytes: 75 * MB }),
    ]);
    setup();
    expect(item()).toHaveTextContent('2 transfers');
    expect(item()).toHaveTextContent('50%');
    expect(within(item()).getByText('Upload')).toBeInTheDocument();
    expect(within(item()).queryByText('Download')).toBeNull();
    // The speed and the time left are in the label, which is also its tooltip.
    // The name stays put while the numbers move.
    expect(item()).toHaveAccessibleName('File transfers: 2 transfers');
  });

  it('says the speed and the time left in its tooltip and its panel', async () => {
    serverWith('web', [
      batch(),
      batch({ batchId: 'b2', totalBytes: 100 * MB, transferredBytes: 75 * MB }),
    ]);
    const { user } = setup();
    await user.hover(item());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('File transfers: 2 transfers4.0 MB/s, 25 s left');
    await user.unhover(item());

    const panel = await openPanel(user);
    expect(within(panel).getByText('50% done')).toBeInTheDocument();
    expect(within(panel).getByText(', 4.0 MB/s, 25 s left')).toBeInTheDocument();
  });

  it('says no speed while nothing moves', async () => {
    serverWith('web', [batch({ bytesPerSecond: null })]);
    const { user } = setup();
    const panel = await openPanel(user);
    expect(within(panel).getByText('25% done')).toBeInTheDocument();
    expect(within(panel).queryByText(/\/s/)).toBeNull();
  });

  it('shows no percent while the files are still being counted', () => {
    serverWith('web', [
      batch({
        state: 'expanding',
        totalItems: null,
        totalBytes: null,
        transferredBytes: 0,
        bytesPerSecond: null,
        etaSeconds: null,
      }),
    ]);
    setup();
    expect(item()).toHaveTextContent('1 transfer');
    expect(item()).not.toHaveTextContent('%');
    expect(item()).toHaveAccessibleName('File transfers: 1 transfer');
  });

  it('shows both arrows when uploads and downloads run at once', () => {
    serverWith('web', [batch(), batch({ batchId: 'b2', kind: 'download', label: 'logs' })]);
    setup();
    expect(within(item()).getByText('Upload')).toBeInTheDocument();
    expect(within(item()).getByText('Download')).toBeInTheDocument();
  });

  it('says a conflict needs an answer, and Answer opens its dialog and closes the panel', async () => {
    serverWith('web', [batch({ state: 'waiting' })], {
      nickname: 'Production',
      conflict: conflict(),
    });
    const requestAnswer = vi.fn();
    useSftpStore.setState({ requestAnswer });
    const { user } = setup();
    expect(item()).toHaveTextContent('Needs your answer');
    expect(item()).toHaveAccessibleName('File transfers: 1 transfer, needs your answer');
    expect(item().className).toContain('text-warning');

    const panel = await openPanel(user);
    const server = within(panel).getByRole('region', { name: 'Production' });
    expect(within(server).getByText('Needs your answer')).toBeInTheDocument();
    await user.click(
      within(server).getByRole('button', { name: 'Answer the question on Production' }),
    );
    expect(requestAnswer).toHaveBeenCalledWith('web');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a conflict that waits behind a finished queue', () => {
    serverWith('web', [], { pendingConflicts: 2 });
    setup();
    expect(item()).toHaveTextContent('Needs your answer');
    expect(item()).toHaveAccessibleName('File transfers: needs your answer');
  });

  it('lists each active batch per server with its progress', async () => {
    serverWith('web', [batch(), batch({ batchId: 'old', label: 'old', state: 'done' })], {
      nickname: 'Production',
    });
    serverWith('api', [
      batch({
        batchId: 'b9',
        kind: 'delete',
        label: 'tmp',
        totalBytes: 0,
        transferredBytes: 0,
        totalItems: 4,
        doneItems: 1,
        bytesPerSecond: null,
      }),
      batch({
        batchId: 'b10',
        kind: 'download',
        label: 'backup.tar',
        state: 'expanding',
        totalItems: null,
        totalBytes: null,
        transferredBytes: 0,
        bytesPerSecond: null,
      }),
    ]);
    const { user } = setup();
    const panel = await openPanel(user);
    expect(within(panel).getByText('File transfers')).toBeInTheDocument();

    const web = within(panel).getByRole('region', { name: 'Production' });
    expect(within(web).queryByText('old')).toBeNull();
    const bar = within(web).getByRole('progressbar', { name: 'site (12 files) progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(within(web).getByText('25.0 MB of 100.0 MB')).toBeInTheDocument();
    expect(within(web).getByText('2.0 MB/s')).toBeInTheDocument();

    const api = within(panel).getByRole('region', { name: 'api' });
    // A delete moves no bytes, so it counts items.
    expect(within(api).getByText('1 of 4')).toBeInTheDocument();
    expect(within(api).getByRole('progressbar', { name: 'tmp progress' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    expect(within(api).getByText('Counting files…')).toBeInTheDocument();
    expect(
      within(api).getByRole('progressbar', { name: 'backup.tar progress' }),
    ).not.toHaveAttribute('aria-valuenow');
  });

  it('opens on the panel itself, so one Escape closes it', async () => {
    // Focus on the first Cancel button would open its tooltip, and Escape would close only that.
    serverWith('web', [batch()], { nickname: 'Production' });
    const { user } = setup();
    const panel = await openPanel(user);
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancels a batch through the store', async () => {
    serverWith('web', [batch()], { nickname: 'Production' });
    const cancel = vi.fn(async () => undefined);
    useSftpStore.setState({ cancel });
    const { user } = setup();
    const panel = await openPanel(user);
    await user.click(within(panel).getByRole('button', { name: 'Cancel site (12 files)' }));
    expect(cancel).toHaveBeenCalledWith('web', { batchId: 'b1' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('tells the user when the cancel fails, and lets them try again', async () => {
    serverWith('web', [batch()], { nickname: 'Production' });
    const cancel = vi.fn(async () => {
      throw new Error('[files:server] No such batch');
    });
    useSftpStore.setState({ cancel });
    const { user } = setup();
    const panel = await openPanel(user);
    const button = within(panel).getByRole('button', { name: 'Cancel site (12 files)' });
    await user.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not cancel site (12 files)',
        expect.objectContaining({ description: expect.stringContaining('No such batch') }),
      ),
    );
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('takes the user to the file manager of a server', async () => {
    serverWith('web 1', [batch()], { nickname: 'Production' });
    const { user } = setup();
    const panel = await openPanel(user);
    await user.click(
      within(panel).getByRole('button', { name: 'Open the file manager of Production' }),
    );
    expect(navigate).toHaveBeenCalledWith('/ssh-files/web%201');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it("docks a server's file manager in the panel", async () => {
    serverWith('web', [batch()], { nickname: 'Production' });
    const { user } = setup();
    const panel = await openPanel(user);
    await user.click(
      within(panel).getByRole('button', {
        name: 'Show the file manager of Production in the panel',
      }),
    );
    expect(dock.openSftpDock).toHaveBeenCalledWith('web', 'Production');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  /** Docks Production from the panel, with the app on `route` and `history` behind it. */
  async function showInPanelFrom(route: string, history: string[] | null): Promise<void> {
    installNavigation(history?.map(appUrl) ?? null);
    serverWith('web 1', [batch()], { nickname: 'Production' });
    const { user } = setup(route);
    const panel = await openPanel(user);
    await user.click(
      within(panel).getByRole('button', {
        name: 'Show the file manager of Production in the panel',
      }),
    );
    expect(dock.openSftpDock).toHaveBeenCalledWith('web 1', 'Production');
  }

  it('leaves the page of the server it docked for Remote when it was the first entry', async () => {
    await showInPanelFrom('/ssh-files/web%201', null);
    expect(navigate).toHaveBeenCalledWith('/remote');
  });

  it('goes to Remote when going back would land on the same page again', async () => {
    await showInPanelFrom('/ssh-files/web%201', [
      '/docker',
      '/ssh-files/web%201',
      '/ssh-files/web%201',
    ]);
    expect(navigate).toHaveBeenCalledWith('/remote');
    expect(navigate).not.toHaveBeenCalledWith(-1);
  });

  it("goes back to where the user was before the server's page", async () => {
    await showInPanelFrom('/ssh-files/web%201', ['/docker', '/ssh-files/web%201']);
    expect(navigate).toHaveBeenCalledWith(-1);
  });

  it('stays on the page of another server, or any other page', async () => {
    await showInPanelFrom('/ssh-files/other', ['/docker', '/ssh-files/other']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('tells the user when the panel cannot show it', async () => {
    serverWith('web', [batch()], { nickname: 'Production' });
    dock.openSftpDock.mockImplementation(() => {
      throw new Error('[files:server] The drawer is gone');
    });
    const { user } = setup();
    const panel = await openPanel(user);
    await user.click(
      within(panel).getByRole('button', {
        name: 'Show the file manager of Production in the panel',
      }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      'Could not show Production in the panel',
      expect.objectContaining({ description: expect.stringContaining('The drawer is gone') }),
    );
  });

  it('does not re-render for a snapshot that changes nothing it shows', () => {
    serverWith('web', [batch({ running: [] })]);
    let commits = 0;
    renderWithProviders(
      <Profiler id="segment" onRender={() => (commits += 1)}>
        <SftpTransfersSegment />
      </Profiler>,
    );
    const before = commits;
    // A new snapshot: new objects, a new item on its way and a new estimate, same numbers shown.
    act(() =>
      serverWith('web', [
        batch({
          etaSeconds: 38,
          running: [
            {
              itemId: 'i2',
              relPath: 'css/app.css',
              state: 'running',
              size: 10,
              transferred: 2,
              error: null,
              errorCode: null,
            },
          ],
        }),
      ]),
    );
    expect(commits).toBe(before);
    // A new speed alone changes nothing in the bar, nor the button's name.
    act(() => serverWith('web', [batch({ bytesPerSecond: 7 * MB, etaSeconds: 3 })]));
    expect(commits).toBe(before);
    expect(item()).toHaveAccessibleName('File transfers: 1 transfer');
    // Bytes that move do show.
    act(() => serverWith('web', [batch({ transferredBytes: 60 * MB })]));
    expect(commits).toBe(before + 1);
    expect(item()).toHaveTextContent('60%');
  });
});
