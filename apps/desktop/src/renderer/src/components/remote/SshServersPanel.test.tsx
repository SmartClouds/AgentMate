import type { SshSavedServer } from '@shared/apiTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

function renderPanel(vault: { hasPasskey: boolean; unlocked: boolean }) {
  return renderWithProviders(<SshServersPanel />, {
    bridge: {
      'ssh.listServers': [server],
      'ssh.vaultStatus': vault,
      // A primitive answer reads as a value on the fake bridge; a call needs a function.
      'ssh.unlockVault': async () => true,
      'ssh.conversations': emptyHistory,
      'sshAgent.serverHistory': async () => [],
    },
  });
}

describe('SshServersPanel', () => {
  it('opens the AI history of a server from its row', async () => {
    const { user, bridge } = renderPanel({ hasPasskey: false, unlocked: false });

    await user.click(await screen.findByRole('button', { name: 'AI history on this server' }));

    expect(await screen.findByRole('dialog', { name: 'prod' })).toBeInTheDocument();
    expect(
      await screen.findByText('No agent conversations on this server yet.'),
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
});
