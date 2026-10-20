import type { SshSavedServer } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { Command } from 'cmdk';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SshFilesPaletteGroup } from './SshFilesPaletteGroup';

/**
 * The palette's way into the SFTP file manager: one entry per saved SSH server, found by its
 * nickname or host once something is typed.
 */

function server(over: Partial<SshSavedServer>): SshSavedServer {
  return {
    id: 'srv-1',
    nickname: 'prod',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    hasSecret: true,
    createdAt: 0,
    lastConnectedAt: null,
    ...over,
  };
}

let pathname = '';
function LocationProbe(): null {
  pathname = useLocation().pathname;
  return null;
}

function Harness({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('');
  return (
    <>
      <Command>
        <Command.Input aria-label="Search" value={query} onValueChange={setQuery} />
        <Command.List>
          <SshFilesPaletteGroup enabled query={query} onDone={onDone} />
        </Command.List>
      </Command>
      <LocationProbe />
    </>
  );
}

function renderGroup(servers: SshSavedServer[] | undefined) {
  const onDone = vi.fn();
  const view = renderWithProviders(<Harness onDone={onDone} />, {
    route: '/remote',
    bridge: { 'ssh.listServers': async () => servers },
  });
  return { ...view, onDone };
}

const servers = [
  server({ id: 'srv-1', nickname: 'prod', host: 'prod.example.com' }),
  server({ id: 'srv-2', nickname: 'staging box', host: '10.0.0.7' }),
];

describe('SshFilesPaletteGroup', () => {
  it('shows nothing until something is typed', async () => {
    const { bridge } = renderGroup(servers);
    await vi.waitFor(() => expect(bridge.$fn('ssh.listServers')).toHaveBeenCalled());
    expect(screen.queryByText(/Open SFTP files/)).toBeNull();
  });

  it('finds a server by its nickname', async () => {
    const { user } = renderGroup(servers);
    await user.type(screen.getByLabelText('Search'), 'staging');
    expect(
      await screen.findByRole('option', { name: /Open SFTP files: staging box/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Open SFTP files: prod/ })).toBeNull();
  });

  it('finds a server by its host', async () => {
    const { user } = renderGroup(servers);
    await user.type(screen.getByLabelText('Search'), '10.0.0');
    expect(
      await screen.findByRole('option', { name: /Open SFTP files: staging box/ }),
    ).toBeInTheDocument();
  });

  it('closes the palette and opens the file manager for the chosen server', async () => {
    const { user, onDone } = renderGroup(servers);
    await user.type(screen.getByLabelText('Search'), 'prod');
    await user.click(await screen.findByRole('option', { name: /Open SFTP files: prod/ }));
    expect(onDone).toHaveBeenCalled();
    expect(pathname).toBe('/ssh-files/srv-1');
  });

  it('shows nothing when there are no saved servers', async () => {
    const { user, bridge } = renderGroup(undefined);
    await user.type(screen.getByLabelText('Search'), 'sftp');
    await vi.waitFor(() => expect(bridge.$fn('ssh.listServers')).toHaveBeenCalled());
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByText(/Open SFTP files/)).toBeNull();
  });
});
