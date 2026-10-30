// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Command } from 'cmdk';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  renderWithVaultProviders,
  summary,
  type VaultApiMock,
} from './testing/mockVaultApi';
import { VaultPaletteGroup } from './VaultPaletteGroup';

installDomShims();

let mock: VaultApiMock;
const onDone = vi.fn();
let location: { pathname: string; state: unknown } = { pathname: '', state: null };

function LocationProbe(): null {
  const current = useLocation();
  location = { pathname: current.pathname, state: current.state };
  return null;
}

function renderGroup() {
  return renderWithVaultProviders(
    <>
      <Command>
        <Command.List>
          <VaultPaletteGroup enabled onDone={onDone} />
        </Command.List>
      </Command>
      <LocationProbe />
    </>,
  );
}

beforeEach(() => {
  mock = createVaultApiMock({ state: 'unlocked' });
  installVaultApi(mock);
  onDone.mockClear();
  mock.api.list.mockResolvedValue([
    summary({
      id: 'gh',
      title: 'GitHub',
      host: 'github.com',
      username: 'octocat',
      urls: ['https://github.com/login'],
    }),
    summary({ id: 'wf', type: 'note', title: 'Wi-Fi', hasPassword: false }),
  ]);
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultPaletteGroup', () => {
  it('lists entries while unlocked and opens the chosen one on the Vault page', async () => {
    renderGroup();
    // The entries query only starts once the status query has said "unlocked", so the entry
    // lands two fetches after the first render. Under a full parallel run that can pass the
    // default one second.
    const option = await screen.findByRole('option', { name: /^GitHub/ }, { timeout: 5_000 });
    fireEvent.click(option);
    expect(onDone).toHaveBeenCalled();
    expect(location).toEqual({ pathname: '/vault', state: { entryId: 'gh' } });
  });

  it('offers to lock while unlocked', async () => {
    renderGroup();
    fireEvent.click(await screen.findByRole('option', { name: 'Lock Vault' }));
    await waitFor(() => expect(mock.api.lock).toHaveBeenCalled());
  });

  it('only offers to unlock while locked, without asking for entries', async () => {
    mock.status.state = 'locked';
    renderGroup();
    fireEvent.click(await screen.findByRole('option', { name: 'Unlock Vault' }));
    expect(location.pathname).toBe('/vault');
    expect(mock.api.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: /GitHub/ })).toBeNull();
  });

  it('shows nothing before a vault exists', async () => {
    mock.status.state = 'uninitialized';
    const { container } = renderGroup();
    await waitFor(() => expect(mock.api.status).toHaveBeenCalled());
    expect(container.querySelector('[cmdk-group]')).toBeNull();
  });

  it('logs in to a login with a website straight from the palette', async () => {
    renderGroup();
    const option = await screen.findByRole(
      'option',
      { name: /^Log in to GitHub/ },
      { timeout: 5_000 },
    );
    expect(screen.queryByRole('option', { name: /^Log in to Wi-Fi/ })).toBeNull();
    fireEvent.click(option);
    expect(onDone).toHaveBeenCalled();
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });
});
