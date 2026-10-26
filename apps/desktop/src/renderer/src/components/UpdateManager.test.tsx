import type { UpdateDownloadProgress, UpdateInfo } from '@shared/apiTypes';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { initUpdateStatusListener, useUpdateStore } from '@/stores/updateStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The update flow as the user meets it: main pushes a status, the dialog shows that state and
 * nothing is downloaded or installed without a click. Statuses are pushed through the real
 * listener (bridge.$emit on app.onUpdateStatus) rather than by poking the store, so the wiring
 * from IPC to dialog is covered too.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { UpdateManager, UpdateStatusChip } = await import('./UpdateManager');

const info: UpdateInfo = {
  version: '2.5.0',
  releaseDate: '2026-09-01T00:00:00.000Z',
  releaseNotes: 'Faster terminals and a calmer sidebar.',
  sizeBytes: 94_371_840,
};

function progress(overrides: Partial<UpdateDownloadProgress> = {}): UpdateDownloadProgress {
  return {
    percent: 42,
    transferredBytes: 39_636_172,
    totalBytes: 94_371_840,
    bytesPerSecond: 2_097_152,
    etaSeconds: 30,
    resumed: false,
    ...overrides,
  };
}

/** Mounts the manager with the same status listener App.tsx installs. */
function renderManager() {
  const view = renderWithProviders(<UpdateManager />);
  const stop = initUpdateStatusListener();
  return { ...view, stop };
}

describe('UpdateManager states', () => {
  it('shows nothing while the updater is idle', () => {
    renderManager();

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays quiet during a check, which runs in the background', () => {
    const { bridge } = renderManager();

    act(() => bridge.$emit('app.onUpdateStatus', { state: 'checking' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the new version, its size and its release notes when one is available', async () => {
    const { bridge } = renderManager();

    act(() => bridge.$emit('app.onUpdateStatus', { state: 'available', info, partialBytes: 0 }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Update available');
    expect(dialog.textContent).toContain('Runova v2.5.0');
    expect(dialog.textContent).toContain('90.0 MB');
    expect(dialog.textContent).toContain('Faster terminals and a calmer sidebar.');
    expect(screen.getByRole('button', { name: /Download/ })).toBeTruthy();
  });

  it('offers to finish a half-downloaded version instead of starting over', async () => {
    const { bridge } = renderManager();

    act(() =>
      bridge.$emit('app.onUpdateStatus', { state: 'available', info, partialBytes: 47_185_920 }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Finish downloading update');
    expect(dialog.textContent).toContain('45.0 MB is already on disk');
    expect(screen.getByRole('button', { name: /Resume download/ })).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('reports progress while downloading and offers to pause', async () => {
    const { bridge } = renderManager();

    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'downloading',
        info,
        progress: progress(),
        reconnecting: false,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Downloading update');
    expect(dialog.textContent).toContain('42%');
    expect(dialog.textContent).toContain('37.8 MB of 90.0 MB');
    expect(dialog.textContent).toContain('about 30s left');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  });

  it('says it is reconnecting rather than looking stalled when the connection drops', async () => {
    const { bridge } = renderManager();

    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'downloading',
        info,
        progress: progress(),
        reconnecting: true,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Reconnecting');
    expect(dialog.textContent).toContain('Keeping 37.8 MB and retrying');
  });

  it('shows a paused download with the reason and a way to resume', async () => {
    const { bridge } = renderManager();
    // A pause only ever follows a download, which is what opened the dialog in the first place.
    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'downloading',
        info,
        progress: progress(),
        reconnecting: false,
      }),
    );
    await screen.findByRole('dialog');

    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'paused',
        info,
        progress: progress(),
        message: 'Paused by you.',
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Download paused');
    expect(dialog.textContent).toContain('Paused by you.');
    expect(screen.getByRole('button', { name: /Resume download/ })).toBeTruthy();
  });

  it('asks to restart once the update is on disk', async () => {
    const { bridge } = renderManager();

    act(() => bridge.$emit('app.onUpdateStatus', { state: 'downloaded', info }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Update ready to install');
    expect(dialog.textContent).toContain('Runova v2.5.0 is downloaded');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('explains a failure and offers to resume when the bytes are still on disk', async () => {
    const { bridge } = renderManager();

    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'error',
        message: 'The connection timed out.',
        info,
        resumable: true,
        progress: progress(),
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Download interrupted');
    expect(dialog.textContent).toContain('The connection timed out.');
    expect(dialog.textContent).toContain('37.8 MB saved on disk');
    expect(screen.getByRole('button', { name: /Resume download/ })).toBeTruthy();
  });

  it('offers another attempt when the failure left nothing to resume', async () => {
    const { bridge } = renderManager();

    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'error',
        message: 'Update server unreachable.',
        info,
      }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Update failed');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('UpdateManager actions', () => {
  it('only starts the download once the user asks for it', async () => {
    const { bridge, user } = renderManager();
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'available', info, partialBytes: 0 }));
    await screen.findByRole('dialog');
    // Nothing has been fetched just by announcing the version.
    expect(() => bridge.$fn('app.downloadUpdate')).toThrow();

    await user.click(screen.getByRole('button', { name: /Download/ }));

    await waitFor(() => expect(bridge.$fn('app.downloadUpdate')).toHaveBeenCalled());
  });

  it('keeps the dialog closed after Later, without downloading anything', async () => {
    const { bridge, user } = renderManager();
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'available', info, partialBytes: 0 }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Later' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(() => bridge.$fn('app.downloadUpdate')).toThrow();
  });

  it('pauses the download on request', async () => {
    const { bridge, user } = renderManager();
    act(() =>
      bridge.$emit('app.onUpdateStatus', {
        state: 'downloading',
        info,
        progress: progress(),
        reconnecting: false,
      }),
    );
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /Pause/ }));

    await waitFor(() => expect(bridge.$fn('app.pauseDownload')).toHaveBeenCalled());
  });

  it('restarts into the installer only when the user says so', async () => {
    const { bridge, user } = renderManager();
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'downloaded', info }));
    await screen.findByRole('dialog');
    expect(() => bridge.$fn('app.quitAndInstall')).toThrow();

    await user.click(screen.getByRole('button', { name: 'Restart now' }));

    await waitFor(() => expect(bridge.$fn('app.quitAndInstall')).toHaveBeenCalled());
  });

  it('surfaces a failed re-check as a toast rather than a silent no-op', async () => {
    const { bridge, user } = renderManager();
    bridge.$set('app.checkForUpdates', async () => ({
      state: 'error',
      message: 'Still offline.',
    }));
    act(() =>
      bridge.$emit('app.onUpdateStatus', { state: 'error', message: 'Update failed.', info }),
    );
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: /Try again/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Still offline.'));
  });
});

describe('UpdateStatusChip', () => {
  it('shows nothing while there is no download to come back to', () => {
    renderWithProviders(<UpdateStatusChip />);

    expect(screen.queryByRole('button', { name: 'Show update download' })).toBeNull();
  });

  it('keeps a hidden download reachable from the top bar', async () => {
    const { user } = renderWithProviders(<UpdateStatusChip />);
    act(() =>
      useUpdateStore.setState({
        status: { state: 'downloading', info, progress: progress(), reconnecting: false },
        dialogOpen: false,
      }),
    );

    const chip = screen.getByRole('button', { name: 'Show update download' });
    expect(chip.textContent).toContain('v2.5.0');
    expect(chip.textContent).toContain('42%');

    await user.click(chip);
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });

  it('steps aside while the dialog itself is open', () => {
    renderWithProviders(<UpdateStatusChip />);
    act(() =>
      useUpdateStore.setState({
        status: { state: 'downloaded', info },
        dialogOpen: true,
      }),
    );

    expect(screen.queryByRole('button', { name: 'Show update download' })).toBeNull();
  });
});

describe('UpdateManager restart', () => {
  it('shows progress and locks the dialog while the installer takes over', async () => {
    const { bridge, user } = renderManager();
    // The macOS installer handoff can take a moment; the promise stays pending.
    bridge.$set('app.quitAndInstall', () => new Promise<void>(() => undefined));
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'downloaded', info }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Restart now' }));

    const restarting = await screen.findByRole('button', { name: 'Restarting…' });
    expect(restarting.getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Later' }).getAttribute('disabled')).not.toBeNull();
  });

  it('sends a single restart even when clicked twice', async () => {
    const { bridge, user } = renderManager();
    bridge.$set('app.quitAndInstall', () => new Promise<void>(() => undefined));
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'downloaded', info }));
    await screen.findByRole('dialog');

    const button = screen.getByRole('button', { name: 'Restart now' });
    await user.click(button);
    await screen.findByRole('button', { name: 'Restarting…' });
    // Disabled by now, so this is a no-op rather than a second install attempt.
    await user.click(screen.getByRole('button', { name: 'Restarting…' }));

    await waitFor(() => expect(bridge.$fn('app.quitAndInstall')).toHaveBeenCalledTimes(1));
  });

  it('explains a restart failure instead of sitting on a dead dialog', async () => {
    const { bridge, user } = renderManager();
    toast.error.mockClear();
    bridge.$set('app.quitAndInstall', async () => {
      throw new Error('No update filepath provided');
    });
    act(() => bridge.$emit('app.onUpdateStatus', { state: 'downloaded', info }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Restart now' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Restart to install failed. Quit the app and it installs on the way out.',
      ),
    );
    // Back to an enabled Restart so the user can retry or quit manually.
    const retry = await screen.findByRole('button', { name: 'Restart now' });
    expect(retry.getAttribute('disabled')).toBeNull();
  });
});
