import type { SshSavedServer } from '@shared/apiTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dragItemDown,
  mockStackedRows,
  reorderIds,
  settleDragClick,
} from '../../../../test/renderer/dragLayout';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useTerminalStore } from '../../stores/terminalStore';
import { SshServersPanel } from './SshServersPanel';

/**
 * Saved servers connect with one click and show the AI conversations stored on them. Both need
 * the server's secret, so both go through the vault passkey first when it is locked.
 */

const server: SshSavedServer = {
  id: 'srv-1',
  nickname: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'dev',
  authMethod: 'password',
  hasSecret: true,
  createdAt: 0,
  lastConnectedAt: null,
};

const emptyHistory = { sessions: [], home: '/home/dev', clis: { claude: true, codex: true } };

let pathname = '';
function LocationProbe(): null {
  pathname = useLocation().pathname;
  return null;
}

function renderPanel(vault: { hasPasskey: boolean; unlocked: boolean }) {
  pathname = '';
  return renderWithProviders(
    <>
      <SshServersPanel />
      <LocationProbe />
    </>,
    {
      bridge: {
        'ssh.listServers': [server],
        'ssh.vaultStatus': vault,
        // A primitive answer reads as a value on the fake bridge; a call needs a function.
        'ssh.unlockVault': async () => true,
        'ssh.conversations': emptyHistory,
        'sshAgent.serverHistory': async () => [],
      },
    },
  );
}

describe('SshServersPanel', () => {
  it('opens the AI history of a server from its row', async () => {
    const { user, bridge } = renderPanel({ hasPasskey: false, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'AI history on this server' }));

    // Under a full parallel run the dialog can take longer than the default second to appear.
    expect(
      await screen.findByRole('dialog', { name: 'prod' }, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('No agent conversations on this server yet.', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(bridge.$fn('ssh.conversations')).toHaveBeenCalledWith(server.id);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('asks for the vault passkey before showing history, then shows it', async () => {
    const { user, bridge } = renderPanel({ hasPasskey: true, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'AI history on this server' }));

    expect(await screen.findByRole('dialog', { name: /Unlock the vault/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'prod' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Passkey'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('dialog', { name: 'prod' })).toBeInTheDocument();
    expect(bridge.$fn('ssh.unlockVault')).toHaveBeenCalledWith('secret');
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('unlocks from the history panel when the vault got locked, then reads again', async () => {
    const conversations = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'ssh:conversations': Error: [ssh:vault-locked] The Servers vault is locked.",
        ),
      )
      .mockResolvedValue(emptyHistory);
    const { user } = renderWithProviders(<SshServersPanel />, {
      bridge: {
        'ssh.listServers': [server],
        'ssh.vaultStatus': { hasPasskey: true, unlocked: true },
        'ssh.unlockVault': async () => true,
        'ssh.conversations': conversations,
        'sshAgent.serverHistory': async () => [],
      },
    });

    await user.click(await screen.findByRole('button', { name: 'AI history on this server' }));
    const panel = await screen.findByRole('dialog', { name: 'prod' });
    await within(panel).findByText('The servers vault is locked');

    await user.click(within(panel).getByRole('button', { name: 'Unlock' }));
    const unlock = await screen.findByRole('dialog', { name: /Unlock the vault/ });
    await user.type(within(unlock).getByLabelText('Passkey'), 'secret');
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));

    expect(
      await screen.findByText('No agent conversations on this server yet.'),
    ).toBeInTheDocument();
    expect(conversations).toHaveBeenCalledTimes(2);
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('still connects after unlocking when Connect asked for the passkey', async () => {
    const { user } = renderPanel({ hasPasskey: true, unlocked: false });

    await user.click(await screen.findByRole('button', { name: /Connect/ }));
    await user.type(await screen.findByLabelText('Passkey'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    const sessions = useTerminalStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ kind: 'ssh', sshServerId: server.id });
    expect(screen.queryByRole('dialog', { name: 'prod' })).not.toBeInTheDocument();
  });

  it('opens the SFTP file manager of a server from its Files button', async () => {
    const { user } = renderPanel({ hasPasskey: false, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'Files' }));

    await vi.waitFor(() => expect(pathname).toBe('/ssh-files/srv-1'));
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('names the Files button by its visible text, with the longer hint in a tooltip', async () => {
    const { user } = renderPanel({ hasPasskey: false, unlocked: false });
    const files = await screen.findByRole('button', { name: 'Files' });
    expect(files).not.toHaveAttribute('aria-label');
    await user.hover(files);
    expect((await screen.findByRole('tooltip')).textContent).toMatch('Browse files over SFTP');
  });

  it('asks for the vault passkey before opening the file manager', async () => {
    const { user, bridge } = renderPanel({ hasPasskey: true, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'Files' }));
    const unlock = await screen.findByRole('dialog', { name: /Unlock the vault/ });
    expect(pathname).toBe('/');

    await user.type(within(unlock).getByLabelText('Passkey'), 'secret');
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));

    await vi.waitFor(() => expect(pathname).toBe('/ssh-files/srv-1'));
    expect(bridge.$fn('ssh.unlockVault')).toHaveBeenCalledWith('secret');
  });

  it('stays put when the passkey prompt is dismissed', async () => {
    const { user } = renderPanel({ hasPasskey: true, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'Files' }));
    await screen.findByRole('dialog', { name: /Unlock the vault/ });
    await user.keyboard('{Escape}');

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(pathname).toBe('/');
  });
});

describe('SshServersPanel drag to reorder', () => {
  const servers = [
    server,
    { ...server, id: 'srv-2', nickname: 'stage' },
    { ...server, id: 'srv-3', nickname: 'dev' },
  ];

  afterEach(() => {
    settleDragClick();
    vi.restoreAllMocks();
  });

  it('moves a server when its grip is dragged, and saves the order it lands in', async () => {
    mockStackedRows(60);
    const { container, bridge } = renderWithProviders(<SshServersPanel />, {
      bridge: {
        'ssh.listServers': servers,
        'ssh.reorderServers': (ids: string[]) => ids.map((id) => servers.find((s) => s.id === id)),
      },
    });
    await screen.findByText('stage');

    // Two rows down puts the first server last.
    dragItemDown(container, 'srv-1', 130);

    await waitFor(() =>
      expect(bridge.$fn('ssh.reorderServers')).toHaveBeenCalledWith(['srv-2', 'srv-3', 'srv-1']),
    );
    expect(reorderIds(container)).toEqual(['srv-2', 'srv-3', 'srv-1']);
  });

  it('does not save anything when a grip is pressed and let go in place', async () => {
    mockStackedRows(60);
    const reorder = vi.fn(async () => servers);
    const { container } = renderWithProviders(<SshServersPanel />, {
      bridge: { 'ssh.listServers': servers, 'ssh.reorderServers': reorder },
    });
    await screen.findByText('stage');

    dragItemDown(container, 'srv-2', 5);

    expect(reorder).not.toHaveBeenCalled();
    expect(reorderIds(container)).toEqual(['srv-1', 'srv-2', 'srv-3']);
  });
});
