import type { CloudflareStatus } from '@shared/cloudflareTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import {
  A_RECORD,
  ACCOUNT,
  CONNECTED,
  ipcError,
  OTHER_ZONE,
  SETTINGS,
  ZONE,
} from './testing/fixtures';

/**
 * The Cloudflare page in Deploy: account wide, so it starts from the token, then offers the zones
 * it can see in a picker, and for the picked zone its DNS, SSL/TLS, caching and security rules.
 * Every state says what is going on in words, and loading shimmers card by card.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { CloudflareView } = await import('./CloudflareView');

const NOTHING: CloudflareStatus = { configured: false, locked: false, accounts: [] };

/** Shows the address, so a test can check what the page left in it. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="address">{`${location.pathname}${location.search}`}</span>;
}

function renderPage(bridge: Record<string, unknown> = {}, route = '/deploy?cloudflare=1') {
  return renderWithProviders(
    <>
      <CloudflareView />
      <LocationProbe />
    </>,
    {
      route,
      bridge: {
        'cloudflare.status': async () => CONNECTED,
        'cloudflare.listZones': async () => [ZONE, OTHER_ZONE],
        'cloudflare.listRecords': async () => [A_RECORD],
        'cloudflare.zoneSettings': async () => SETTINGS,
        'cloudflare.listCustomRules': async () => [],
        'cloudflare.listAccessRules': async () => [],
        'ssh.vaultStatus': async () => ({ hasPasskey: false, unlocked: false }),
        'deploy.listServers': async () => [],
        ...bridge,
      },
    },
  );
}

function address(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('address').textContent?.split('?')[1]);
}

/** Opens the domain picker and gives back the list inside it, once the first domain is in. */
async function openPicker(user: ReturnType<typeof renderPage>['user']) {
  await user.click(await screen.findByRole('button', { name: /Choose a domain/ }));
  const list = await screen.findByRole('navigation', { name: 'Zones' });
  await within(list).findByText('example.com');
  return list;
}

describe('CloudflareView', () => {
  it('shimmers while it asks whether a token is saved', () => {
    renderPage({ 'cloudflare.status': () => new Promise(() => undefined) });
    expect(document.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Cloudflare' })).toBeInTheDocument();
  });

  it('says what went wrong when the status cannot be read', async () => {
    renderPage({
      'cloudflare.status': async () => {
        throw ipcError('status', 'Cloudflare is only available in the main window.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('only available in the main window');
  });

  it('starts with the token guide when nothing is saved', async () => {
    const { bridge } = renderPage({ 'cloudflare.status': async () => NOTHING });

    expect(await screen.findByText('Connect Cloudflare')).toBeInTheDocument();
    expect(() => bridge.$fn('cloudflare.listZones')).toThrow();
  });

  it('opens the first zone on its DNS records, with the others in the picker', async () => {
    const { user } = renderPage();

    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    expect(await screen.findByText('DNS records')).toBeInTheDocument();
    const list = await openPicker(user);
    expect(within(list).getByText('example.org')).toBeInTheDocument();
    expect(within(list).getByText('Waiting for name servers')).toBeInTheDocument();
  });

  it('is a page, not a dialog', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the zone in the address and switches between its tabs', async () => {
    const { user } = renderPage({}, `/deploy?cloudflare=1&zone=${OTHER_ZONE.id}`);

    expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
    expect(screen.getByText(/bob\.ns\.cloudflare\.com/)).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'DNS',
      'SSL/TLS',
      'Caching',
      'Security',
      'Servers',
    ]);
    await user.click(screen.getByRole('tab', { name: 'SSL/TLS' }));
    expect(await screen.findByRole('radiogroup', { name: 'Encryption mode' })).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum TLS version')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Caching' }));
    expect(await screen.findByRole('radiogroup', { name: 'Caching level' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Purge cache' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    expect(await screen.findByLabelText('Security level')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'WAF custom rules' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'IP access rules' })).toBeInTheDocument();
    expect(address().get('tab')).toBe('security');
  });

  it('opens an old Settings link on the SSL/TLS tab', async () => {
    renderPage({}, `/deploy?cloudflare=1&zone=${ZONE.id}&tab=settings`);
    expect(await screen.findByRole('tab', { name: 'SSL/TLS' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it("puts development mode and I'm Under Attack in the zone header, on every tab", async () => {
    const { user } = renderPage();
    const quick = await screen.findByRole('group', { name: 'Quick switches' });
    expect(within(quick).getByRole('switch', { name: 'Development mode' })).toBeInTheDocument();
    expect(within(quick).getByRole('switch', { name: "I'm Under Attack" })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    expect(screen.getByRole('group', { name: 'Quick switches' })).toBeInTheDocument();
  });

  it('names the open zone on the picker and marks it in the list', async () => {
    const { user } = renderPage();
    expect(
      await screen.findByRole('button', { name: 'Choose a domain, example.com is open' }),
    ).toBeInTheDocument();
    const list = await openPicker(user);
    const first = within(list).getByRole('button', { name: /example\.com/ });
    const second = within(list).getByRole('button', { name: /example\.org/ });
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');
  });

  it('shows the token guide on its own, without a domain picker', async () => {
    renderPage({ 'cloudflare.status': async () => NOTHING });
    expect(await screen.findByText('Connect Cloudflare')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Choose a domain/ })).toBeNull();
  });

  it('picks another zone from the picker, closes it and keeps the rest of the address', async () => {
    const { user } = renderPage({}, '/deploy?cloudflare=1&view=logs');
    const list = await openPicker(user);
    await user.click(within(list).getByRole('button', { name: /example\.org/ }));

    expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull());
    expect(address().get('zone')).toBe(OTHER_ZONE.id);
    expect(address().get('cloudflare')).toBe('1');
    expect(address().get('view')).toBe('logs');
  });

  it('shimmers while the zones load, and explains when there are none', async () => {
    const { unmount } = renderPage({
      'cloudflare.listZones': () => new Promise(() => undefined),
    });
    await screen.findByText('Cloudflare token');
    expect(document.querySelector('nav[aria-busy="true"] .shimmer')).not.toBeNull();
    unmount();

    renderPage({ 'cloudflare.listZones': async () => [] });
    expect(await screen.findByText(/cannot see any domains yet/)).toBeInTheDocument();
  });

  it('says why the zones could not be listed', async () => {
    renderPage({
      'cloudflare.listZones': async () => {
        throw ipcError('listZones', 'Could not reach Cloudflare.');
      },
    });
    expect(await screen.findByText('Could not reach Cloudflare.')).toBeInTheDocument();
  });

  it('asks to unlock the Servers passkey before reading anything with the token', async () => {
    const { user, bridge } = renderPage({
      'cloudflare.status': async () => ({ ...CONNECTED, locked: true }),
      'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }),
    });

    expect(await screen.findByText(/locked with a passkey/)).toBeInTheDocument();
    expect(() => bridge.$fn('cloudflare.listZones')).toThrow();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock the vault' })).toBeInTheDocument();
  });

  it('replaces the token from the token card, or keeps it', async () => {
    const { user } = renderPage();

    await user.click(await screen.findByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText('Replace the token for Cloudflare')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep the current token' }));
    expect(await screen.findByText('Cloudflare token')).toBeInTheDocument();
  });

  it('reads the zones once the passkey is unlocked', async () => {
    let locked = true;
    const { user, bridge } = renderPage({
      'cloudflare.status': async () => ({ ...CONNECTED, locked }),
      'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: !locked }),
      'ssh.unlockVault': async () => {
        locked = false;
        return true;
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Unlock' }));
    await user.type(await screen.findByLabelText('Passkey'), 'secret');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Unlock the vault' })).getByRole('button', {
        name: 'Unlock',
      }),
    );

    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalled();
  });

  it('tries the status and the zones again on request', async () => {
    let failStatus = true;
    let failZones = true;
    const { user } = renderPage({
      'cloudflare.status': async () => {
        if (failStatus) {
          failStatus = false;
          throw ipcError('status', 'Busy.');
        }
        return CONNECTED;
      },
      'cloudflare.listZones': async () => {
        if (failZones) {
          failZones = false;
          throw ipcError('listZones', 'Could not reach Cloudflare.');
        }
        return [ZONE];
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Could not reach Cloudflare.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
  });

  it('keeps the token card to one line while the token is fine, so the zone has the room', async () => {
    const { user } = renderPage();

    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace token' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Replace token' })).toBeInTheDocument();
  });

  describe('searching the domains', () => {
    const SHOP = { ...ZONE, id: '5f0d4f8b3a2c4e6d8f1a2b3c4d5e6f70', name: 'shop.example.net' };
    const three = { 'cloudflare.listZones': async () => [ZONE, OTHER_ZONE, SHOP] };

    it('opens with the search box focused', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);
      await waitFor(() =>
        expect(within(list).getByRole('searchbox', { name: 'Search domains' })).toHaveFocus(),
      );
    });

    it('filters the domains as you type, counts what matches and marks the match', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);
      expect(within(list).getByText('3')).toBeInTheDocument();

      await user.type(within(list).getByRole('searchbox', { name: 'Search domains' }), 'ORG');

      expect(within(list).getAllByRole('button', { name: /example\./ })).toHaveLength(1);
      expect(within(list).getByRole('button', { name: /example\.org/ })).toBeInTheDocument();
      expect(within(list).getByText('1 of 3')).toBeInTheDocument();
      expect(list.querySelector('mark')).toHaveTextContent(/^org$/);
    });

    it('reads a pasted address as the domain in it', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);

      await user.click(within(list).getByRole('searchbox', { name: 'Search domains' }));
      await user.paste('https://www.shop.example.net/cart?id=1');

      expect(within(list).getAllByRole('button', { name: /example\./ })).toHaveLength(1);
      expect(within(list).getByRole('button', { name: /shop\.example\.net/ })).toBeInTheDocument();
    });

    it('says when nothing matches, and clears from the box or with Escape', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);
      const box = within(list).getByRole('searchbox', { name: 'Search domains' });

      await user.type(box, 'nothing here');
      expect(within(list).getByText(/Nothing matches/)).toBeInTheDocument();
      await user.click(within(list).getByRole('button', { name: 'Clear filter' }));
      expect(within(list).getAllByRole('button', { name: /example\./ })).toHaveLength(3);

      await user.type(box, 'org');
      await user.keyboard('{Escape}');
      expect(box).toHaveValue('');
      // Escape in a box with text clears it without closing the list.
      expect(screen.getByRole('navigation', { name: 'Zones' })).toBeInTheDocument();
      // An empty box leaves Escape to the list again.
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Zones' })).toBeNull());
    });

    it('opens the first match with Enter and keeps the rest of the address', async () => {
      const { user } = renderPage(three, '/deploy?cloudflare=1&view=logs');
      const list = await openPicker(user);

      await user.type(
        within(list).getByRole('searchbox', { name: 'Search domains' }),
        'shop{Enter}',
      );

      expect(await screen.findByRole('heading', { name: 'shop.example.net' })).toBeInTheDocument();
      expect(address().get('zone')).toBe(SHOP.id);
      expect(address().get('view')).toBe('logs');
    });

    it('moves from the box into the list and along it with the arrow keys', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);
      const box = within(list).getByRole('searchbox', { name: 'Search domains' });

      await user.type(box, 'example');
      await user.keyboard('{ArrowDown}');
      expect(within(list).getByRole('button', { name: /example\.com/ })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(within(list).getByRole('button', { name: /example\.org/ })).toHaveFocus();
      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(box).toHaveFocus();
    });

    it('opens the picker on its search with Ctrl+F from anywhere on the page', async () => {
      const { user } = renderPage(three);
      await user.click(await screen.findByRole('tab', { name: 'Caching' }));

      await user.keyboard('{Control>}f{/Control}');

      const list = await screen.findByRole('navigation', { name: 'Zones' });
      await waitFor(() =>
        expect(within(list).getByRole('searchbox', { name: 'Search domains' })).toHaveFocus(),
      );
    });

    it('goes back to the search with Ctrl+F while the picker is open', async () => {
      const { user } = renderPage(three);
      const list = await openPicker(user);
      await user.type(within(list).getByRole('searchbox', { name: 'Search domains' }), 'example');
      await user.keyboard('{ArrowDown}');
      expect(within(list).getByRole('button', { name: /example\.com/ })).toHaveFocus();

      await user.keyboard('{Control>}f{/Control}');

      expect(within(list).getByRole('searchbox', { name: 'Search domains' })).toHaveFocus();
    });

    it('leaves the search out while there is only one domain', async () => {
      const { user } = renderPage({ 'cloudflare.listZones': async () => [ZONE] });
      const list = await openPicker(user);
      expect(within(list).queryByRole('searchbox')).toBeNull();
    });
  });

  describe('with several accounts', () => {
    const SECOND_ZONE = { ...OTHER_ZONE, accountId: 'acct-2' };
    const TWO: CloudflareStatus = {
      configured: true,
      locked: false,
      accounts: [ACCOUNT, { ...ACCOUNT, id: 'acct-2', label: 'Client Co' }],
    };
    const several = {
      'cloudflare.status': async () => TWO,
      'cloudflare.listZones': async (accountId: string) =>
        accountId === 'acct-2' ? [SECOND_ZONE] : [ZONE],
    };

    it('groups the domains under the account that holds them', async () => {
      const { user } = renderPage(several);

      const list = await openPicker(user);
      const work = within(list).getByRole('region', { name: 'Cloudflare' });
      const client = within(list).getByRole('region', { name: 'Client Co' });
      expect(within(work).getByText('example.com')).toBeInTheDocument();
      expect(await within(client).findByText('example.org')).toBeInTheDocument();
      expect(within(work).queryByText('example.org')).toBeNull();
    });

    it('leaves out an account with nothing that matches while searching', async () => {
      const { user } = renderPage(several);
      const list = await openPicker(user);
      await within(list).findByText('example.org');

      await user.type(within(list).getByRole('searchbox', { name: 'Search domains' }), '.org');

      expect(within(list).queryByRole('region', { name: 'Cloudflare' })).toBeNull();
      expect(within(list).getByRole('region', { name: 'Client Co' })).toBeInTheDocument();
    });

    it('asks each account for its own zones', async () => {
      const { bridge } = renderPage(several);
      await screen.findByRole('heading', { name: 'example.com' });
      expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalledWith('acct-1');
      expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalledWith('acct-2');
    });

    it('shows the token card of the account that holds the open zone', async () => {
      const { user } = renderPage(several);

      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
      expect(screen.queryByText('Client Co')).toBeNull();
      const list = await openPicker(user);
      await user.click(await within(list).findByRole('button', { name: /example.org/ }));

      expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText('Client Co')).toHaveLength(1));
    });

    it('keeps the other accounts domains when one account fails, and says so on the picker', async () => {
      const { user } = renderPage({
        ...several,
        'cloudflare.listZones': async (accountId: string) => {
          if (accountId === 'acct-2') throw ipcError('listZones', 'Could not reach Cloudflare.');
          return [ZONE];
        },
      });

      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
      expect(await screen.findByText('1 account failed')).toBeInTheDocument();
      const list = await openPicker(user);
      expect(await within(list).findByText('Could not reach Cloudflare.')).toBeInTheDocument();
    });

    it('adds another account from the picker, and goes back without saving', async () => {
      const { user } = renderPage(several);

      await openPicker(user);
      await user.click(screen.getByRole('button', { name: 'Add account' }));
      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
      expect(screen.getByLabelText('Name (optional)')).toBeInTheDocument();
      // The steps are drawn on the page, not in a dialog on top.
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
      expect(screen.queryByText('Connect another Cloudflare account')).toBeNull();
    });

    it('leaves the connect steps when another domain is picked', async () => {
      const { user } = renderPage(several);

      await openPicker(user);
      await user.click(screen.getByRole('button', { name: 'Add account' }));
      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
      const list = await openPicker(user);
      await user.click(await within(list).findByRole('button', { name: /example\.org/ }));

      expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
      expect(screen.queryByText('Connect another Cloudflare account')).toBeNull();
    });

    it("opens an account's token details when its name is picked in the list", async () => {
      const { user } = renderPage(several);
      const list = await openPicker(user);

      await user.click(await within(list).findByRole('button', { name: 'Client Co' }));

      expect(await screen.findByRole('button', { name: 'Replace token' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    it('lets another account be added from the one-column view too', async () => {
      const { user } = renderPage({
        ...several,
        'cloudflare.status': async () => ({ ...TWO, locked: true }),
        'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }),
      });

      expect(await screen.findByText(/locked with a passkey/)).toBeInTheDocument();
      expect(screen.getByText('Client Co')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Add another account' }));
      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
    });
  });
});
