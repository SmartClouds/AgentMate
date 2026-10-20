import type { RdpSavedServer } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dragItemDown,
  mockStackedRows,
  reorderIds,
  settleDragClick,
} from '../../../../test/renderer/dragLayout';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RdpServersPanel } from './RdpServersPanel';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: () => Promise.resolve(true) }));

const options = {
  resolution: 'fitWindow' as const,
  fullscreenOnConnect: false,
  maximizeOnConnect: true,
  clipboard: true,
  fileTransfer: true,
  nla: true,
};

const withCertificate: RdpSavedServer = {
  id: 'server-1',
  nickname: 'Build box',
  host: '176.9.22.106',
  port: 3389,
  username: 'Administrator',
  hasSecret: true,
  certFingerprint: 'BB:99:88',
  certDetails: { subject: 'CN=WIN-OLD', issuer: 'CN=Old authority', validTo: 'Jan 1 2026' },
  options,
  createdAt: 0,
  lastConnectedAt: null,
};

const withoutCertificate: RdpSavedServer = {
  ...withCertificate,
  id: 'server-2',
  nickname: 'New box',
  certFingerprint: undefined,
  certDetails: undefined,
};

function renderPanel(extra: Record<string, unknown> = {}) {
  return renderWithProviders(<RdpServersPanel />, {
    bridge: {
      'rdp.listServers': [withCertificate, withoutCertificate],
      'ssh.vaultStatus': { hasPasskey: false, unlocked: false },
      'rdp.forgetCertificate': async () => undefined,
      ...extra,
    },
  });
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe('RdpServersPanel certificates', () => {
  it('has a certificate button on each server', async () => {
    renderPanel();

    expect(
      await screen.findByRole('button', { name: 'Certificate for Build box' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Certificate for New box' })).toBeInTheDocument();
  });

  it('opens the certificate saved for that server', async () => {
    const { user } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Certificate for Build box' }));

    expect(
      await screen.findByRole('dialog', { name: 'Certificate for Build box' }),
    ).toBeInTheDocument();
    expect(screen.getByText('BB:99:88')).toBeInTheDocument();
  });

  it('opens the dialog of a server with nothing saved on its own terms', async () => {
    const { user } = renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Certificate for New box' }));

    expect(
      await screen.findByRole('dialog', { name: 'Certificate for New box' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved yet/)).toBeInTheDocument();
  });

  it('reads the servers again after a certificate is forgotten', async () => {
    const { user, bridge } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Certificate for Build box' }));
    const before = bridge.$fn('rdp.listServers').mock.calls.length;

    await user.click(await screen.findByRole('button', { name: /Forget saved certificate/ }));

    await waitFor(() =>
      expect(bridge.$fn('rdp.forgetCertificate')).toHaveBeenCalledWith('server-1'),
    );
    await waitFor(() =>
      expect(bridge.$fn('rdp.listServers').mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe('RdpServersPanel drag to reorder', () => {
  const servers = [withCertificate, withoutCertificate];

  afterEach(() => {
    settleDragClick();
    vi.restoreAllMocks();
  });

  it('moves a server when its grip is dragged, and saves the order it lands in', async () => {
    mockStackedRows(60);
    const { container, bridge } = renderPanel({
      'rdp.reorderServers': (ids: string[]) => ids.map((id) => servers.find((s) => s.id === id)),
    });
    await screen.findByText('New box');

    dragItemDown(container, 'server-1', 70);

    await waitFor(() =>
      expect(bridge.$fn('rdp.reorderServers')).toHaveBeenCalledWith(['server-2', 'server-1']),
    );
    expect(reorderIds(container)).toEqual(['server-2', 'server-1']);
  });

  it('puts the saved order back and says so when saving fails', async () => {
    mockStackedRows(60);
    const { container, bridge } = renderPanel({
      'rdp.reorderServers': async () => {
        throw new Error("Error invoking remote method 'rdp:reorderServers': Error: Disk full.");
      },
    });
    await screen.findByText('New box');
    const before = bridge.$fn('rdp.listServers').mock.calls.length;

    dragItemDown(container, 'server-1', 70);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Disk full.'));
    // The failed order is read over again, and the list is back to what is saved.
    await waitFor(() =>
      expect(bridge.$fn('rdp.listServers').mock.calls.length).toBeGreaterThan(before),
    );
    await waitFor(() => expect(reorderIds(container)).toEqual(['server-1', 'server-2']));
  });
});

describe('RdpServersPanel connect errors', () => {
  it('shows a failed open without the IPC wrapper text', async () => {
    const { user } = renderPanel({
      'rdp.openSession': async () => {
        throw new Error(
          "Error invoking remote method 'rdp:openSession': Error: This saved server no longer exists.",
        );
      },
    });

    await user.click((await screen.findAllByRole('button', { name: /Connect/ }))[0]);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This saved server no longer exists.'),
    );
  });

  it('falls back to a sentence when the error has no message', async () => {
    const { user } = renderPanel({
      'rdp.openSession': async () => {
        throw new Error('');
      },
    });

    await user.click((await screen.findAllByRole('button', { name: /Connect/ }))[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not open the session.'));
  });
});
