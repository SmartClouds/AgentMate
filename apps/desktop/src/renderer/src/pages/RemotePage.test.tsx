// @vitest-environment jsdom
import type { RemoteSavedServer, RemoteState } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRemoteStore } from '@/stores/remoteStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Remote page: hosting this machine, handing out a pairing code, and the saved servers a
 * controller can forget again. Everything the page shows about the session comes from the remote
 * store (main pushes into it), so the tests seed the store and let the bridge answer the calls.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

const { default: RemotePage } = await import('./RemotePage');

function remoteState(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    deviceName: 'Workbench',
    hosting: false,
    hostIp: null,
    hostPort: 7900,
    inputSupported: true,
    pairing: null,
    peers: [],
    interfaces: [],
    connection: { status: 'idle', remoteDeviceName: null, remoteScreen: null, intent: null },
    ...overrides,
  };
}

const LAN: RemoteState['interfaces'] = [
  { name: 'Ethernet', address: '192.168.1.20' },
  { name: 'Wi-Fi', address: '10.0.0.8' },
];

const studio: RemoteSavedServer = {
  id: 'srv-1',
  nickname: 'Studio Mac',
  ip: '192.168.1.44',
  port: 7900,
  deviceName: 'Studio',
  deviceToken: 'token-1',
  createdAt: Date.now() - 86_400_000,
  lastConnectedAt: Date.now() - 3_600_000,
};

const viewSwitcher = (): HTMLElement => screen.getByRole('navigation', { name: 'Remote views' });

async function openView(user: UserEvent, label: string): Promise<void> {
  await user.click(within(viewSwitcher()).getByRole('button', { name: label }));
}

/** A button in the page body. "Connect" is both a view and an action, hence the filtering. */
function action(name: string | RegExp): HTMLElement {
  const nav = viewSwitcher();
  const found = screen.getAllByRole('button', { name }).filter((one) => !nav.contains(one));
  if (found.length !== 1) {
    throw new Error(`Expected one "${String(name)}" button outside the views, got ${found.length}`);
  }
  return found[0];
}

/**
 * The icon-only buttons in a row carry their meaning in a tooltip, which Radix only mounts while
 * the pointer is genuinely over the trigger, and jsdom has no layout for that. The row has exactly
 * one button with no text, so it is found by that instead. Its accessible name being empty is
 * worth knowing in its own right.
 */
function iconOnlyButton(scope: HTMLElement): HTMLElement {
  const found = within(scope)
    .getAllByRole('button')
    .filter((button) => !button.textContent?.trim());
  if (found.length !== 1) {
    const names = within(scope)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim() || '(icon only)');
    throw new Error(
      `Expected one icon-only button in this row, found ${found.length}: ${names.join(', ')}`,
    );
  }
  return found[0];
}

beforeEach(() => {
  useRemoteStore.setState({ state: null, logs: [], transfers: [] });
});

describe('RemotePage with nothing set up', () => {
  it('opens on the Host view and says there is no activity yet', async () => {
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText('Allow this machine to be controlled')).toBeInTheDocument();
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
    // No interfaces have arrived from main, so there is nothing to bind to and hosting is off.
    expect(screen.getByText('No network interfaces found')).toBeInTheDocument();
    expect(action(/Start hosting/)).toBeDisabled();
  });
});

describe('RemotePage views', () => {
  it('marks the open view and switches to another', async () => {
    const { user } = renderWithProviders(<RemotePage />, { route: '/remote' });

    const host = within(viewSwitcher()).getByRole('button', { name: 'Host' });
    expect(host).toHaveAttribute('aria-current', 'true');

    await openView(user, 'SSH');

    expect(within(viewSwitcher()).getByRole('button', { name: 'SSH' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(host).not.toHaveAttribute('aria-current');
    expect(
      await screen.findByText('Connect over SSH with one click, no terminal typing.'),
    ).toBeInTheDocument();
  });

  it('reopens on the view that was open last time', async () => {
    const first = renderWithProviders(<RemotePage />, { route: '/remote' });
    await openView(first.user, 'SSH');
    first.unmount();

    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(within(viewSwitcher()).getByRole('button', { name: 'SSH' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(
      await screen.findByText('Connect over SSH with one click, no terminal typing.'),
    ).toBeInTheDocument();
  });

  it('falls back to Host when the remembered view is not one it knows', () => {
    localStorage.setItem('agentmate.remote.tab', 'telnet');
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(within(viewSwitcher()).getByRole('button', { name: 'Host' })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('says who this machine is connected to, whichever view is open', async () => {
    useRemoteStore.setState({
      state: remoteState({
        connection: {
          status: 'connected',
          remoteDeviceName: 'Studio',
          remoteScreen: null,
          intent: 'control',
        },
      }),
    });
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText('Connected to Studio')).toBeInTheDocument();
  });
});

describe('RemotePage hosting', () => {
  it('starts hosting on the first address main offered', async () => {
    useRemoteStore.setState({ state: remoteState({ interfaces: LAN }) });
    const { user, bridge } = renderWithProviders(<RemotePage />, { route: '/remote' });

    // The address picker defaults to the LAN-preferred interface, so Start hosting is ready.
    expect(await screen.findByText(/192\.168\.1\.20/)).toBeInTheDocument();
    await user.click(action(/Start hosting/));

    expect(bridge.$fn('remote.startHost')).toHaveBeenCalledWith({
      ip: '192.168.1.20',
      port: 7900,
    });
  });

  it('warns that this platform can be watched but not driven', async () => {
    useRemoteStore.setState({ state: remoteState({ interfaces: LAN, inputSupported: false }) });
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText(/Keyboard\/mouse control isn't available/)).toBeInTheDocument();
  });

  it('asks main for a pairing code once it is listening', async () => {
    useRemoteStore.setState({
      state: remoteState({
        interfaces: LAN,
        hosting: true,
        hostIp: '192.168.1.20',
        hostPort: 7900,
      }),
    });
    const { user, bridge } = renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText(/Listening on 192\.168\.1\.20:7900/)).toBeInTheDocument();
    expect(screen.getByText(/No one is connected yet/)).toBeInTheDocument();

    await user.click(action(/Generate pairing code/));
    expect(bridge.$fn('remote.generatePairingCode')).toHaveBeenCalled();
  });

  it('shows the code and its QR, and copies the code to the clipboard', async () => {
    useRemoteStore.setState({
      state: remoteState({
        interfaces: LAN,
        hosting: true,
        hostIp: '192.168.1.20',
        pairing: {
          code: 'AGENTMATE1:192.168.1.20:7900:abc123',
          qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          expiresAt: Date.now() + 60_000,
        },
      }),
    });
    const { user } = renderWithProviders(<RemotePage />, { route: '/remote' });

    const qr = await screen.findByAltText('Pairing QR code');
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByDisplayValue('AGENTMATE1:192.168.1.20:7900:abc123')).toBeInTheDocument();

    await user.click(action(/Copy code/));
    // user-event installs its own clipboard, so the copied text is read back rather than spied on.
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('AGENTMATE1:192.168.1.20:7900:abc123'),
    );
    expect(toast.success).toHaveBeenCalledWith('Pairing code copied.');
  });

  it('lists a connected controller and can push the clipboard to it', async () => {
    useRemoteStore.setState({
      state: remoteState({
        interfaces: LAN,
        hosting: true,
        hostIp: '192.168.1.20',
        peers: [
          { id: 'peer-1', deviceName: 'Studio', address: '192.168.1.44', connectedAt: Date.now() },
        ],
      }),
    });
    const { user, bridge } = renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText('Connected controllers (1)')).toBeInTheDocument();
    expect(screen.getByText('Studio')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.44')).toBeInTheDocument();

    await user.click(action(/Send clipboard/));
    expect(bridge.$fn('remote.sendClipboard')).toHaveBeenCalled();
  });

  it('tells you why a pairing code could not be generated', async () => {
    useRemoteStore.setState({
      state: remoteState({ interfaces: LAN, hosting: true, hostIp: '192.168.1.20' }),
    });
    const { user } = renderWithProviders(<RemotePage />, {
      route: '/remote',
      bridge: {
        'remote.generatePairingCode': () => Promise.reject(new Error('Host socket went away')),
      },
    });

    await screen.findByText(/Listening on 192\.168\.1\.20/);
    await user.click(action(/Generate pairing code/));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Host socket went away'));
    // The card is still there, so the operator can simply try again.
    expect(action(/Generate pairing code/)).toBeEnabled();
  });
});

describe('RemotePage saved servers', () => {
  it('forgets a paired device after confirming', async () => {
    const { user, bridge } = renderWithProviders(<RemotePage />, {
      route: '/remote',
      bridge: { 'remote.listSavedServers': [studio] },
    });

    await openView(user, 'Connect');

    const row = (await screen.findByText('Studio Mac')).closest('li');
    if (!row) throw new Error('The saved server has no row');
    expect(within(row).getByText(/192\.168\.1\.44:7900/)).toBeInTheDocument();

    await user.click(iconOnlyButton(row));

    await waitFor(() =>
      expect(bridge.$fn('remote.removeSavedServer')).toHaveBeenCalledWith('srv-1'),
    );
    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Forget "Studio Mac"?', variant: 'destructive' }),
    );
  });

  it('keeps the server when the confirmation is dismissed', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, bridge } = renderWithProviders(<RemotePage />, {
      route: '/remote',
      bridge: { 'remote.listSavedServers': [studio] },
    });

    await openView(user, 'Connect');
    const row = (await screen.findByText('Studio Mac')).closest('li');
    if (!row) throw new Error('The saved server has no row');

    await user.click(iconOnlyButton(row));

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(bridge.remote.removeSavedServer).not.toHaveBeenCalled();
    expect(screen.getByText('Studio Mac')).toBeInTheDocument();
  });

  it('reports a refused pairing code instead of opening a session window', async () => {
    const { user, bridge } = renderWithProviders(<RemotePage />, {
      route: '/remote',
      bridge: { 'remote.connect': { ok: false, error: 'That code has expired.' } },
    });

    await openView(user, 'Connect');
    await user.type(
      await screen.findByPlaceholderText('AGENTMATE1:…'),
      'AGENTMATE1:192.168.1.44:7900:stale',
    );
    await user.click(action('Connect'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That code has expired.'));
    expect(bridge.remote.openSessionWindow).not.toHaveBeenCalled();
  });

  it('refuses to connect with an empty pairing code', async () => {
    const { user, bridge } = renderWithProviders(<RemotePage />, { route: '/remote' });

    await openView(user, 'Connect');
    await user.click(action('Connect'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Paste a pairing code first.'));
    expect(bridge.remote.connect).not.toHaveBeenCalled();
  });
});

describe('RemotePage activity', () => {
  it('shows what main has reported', async () => {
    useRemoteStore.setState({
      state: remoteState({ interfaces: LAN }),
      logs: [
        { level: 'error', message: 'Controller dropped', at: Date.now() },
        { level: 'success', message: 'Studio connected', at: Date.now() - 1000 },
      ],
    });
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText('Controller dropped')).toBeInTheDocument();
    expect(screen.getByText('Studio connected')).toBeInTheDocument();
    expect(screen.queryByText('Nothing yet.')).not.toBeInTheDocument();
  });

  it('shows a transfer in flight with how far it has got', async () => {
    useRemoteStore.setState({
      state: remoteState({ interfaces: LAN }),
      transfers: [
        {
          transferId: 't1',
          name: 'build.zip',
          direction: 'outgoing',
          transferred: 512_000,
          total: 1_024_000,
          done: false,
        },
      ],
    });
    renderWithProviders(<RemotePage />, { route: '/remote' });

    expect(await screen.findByText('File transfers')).toBeInTheDocument();
    expect(screen.getByText(/build\.zip/)).toBeInTheDocument();
    expect(screen.getByText('500.0 KB / 1000.0 KB')).toBeInTheDocument();
  });
});
