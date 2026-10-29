import type { CloudflareStatus } from '@shared/cloudflareTypes';
import { screen, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { PANEL_WIDTHS, usePanelWidthStore } from '@/stores/panelWidthStore';
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
 * The Cloudflare dialog, opened over the Deploy page: account wide, so it starts from the token,
 * then lists the zones it can see, and for the picked zone its DNS, SSL/TLS, caching and security rules.
 * Every state says what is going on in words, and loading shimmers card by card.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { CloudflareDialog } = await import('./CloudflareDialog');

const NOTHING: CloudflareStatus = { configured: false, locked: false, accounts: [] };

/** Shows the address, so a test can check what the dialog left in it. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="address">{`${location.pathname}${location.search}`}</span>;
}

function renderDialog(bridge: Record<string, unknown> = {}, route = '/deploy?dialog=cloudflare') {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <>
      <CloudflareDialog open onOpenChange={onOpenChange} />
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
  return { ...view, onOpenChange };
}

describe('CloudflareDialog', () => {
  it('shimmers while it asks whether a token is saved', () => {
    renderDialog({ 'cloudflare.status': () => new Promise(() => undefined) });
    expect(document.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says what went wrong when the status cannot be read', async () => {
    renderDialog({
      'cloudflare.status': async () => {
        throw ipcError('status', 'Cloudflare is only available in the main window.');
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('only available in the main window');
  });

  it('starts with the token guide when nothing is saved', async () => {
    const { bridge } = renderDialog({ 'cloudflare.status': async () => NOTHING });

    expect(await screen.findByText('Connect Cloudflare')).toBeInTheDocument();
    expect(() => bridge.$fn('cloudflare.listZones')).toThrow();
  });

  it('lists the zones and opens the first one on its DNS records', async () => {
    renderDialog();

    const rail = await screen.findByRole('navigation', { name: 'Zones' });
    expect(await within(rail).findByText('example.com')).toBeInTheDocument();
    expect(within(rail).getByText('Waiting for name servers')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    expect(await screen.findByText('DNS records')).toBeInTheDocument();
  });

  it('opens the zone in the address and switches between its tabs', async () => {
    const { user } = renderDialog({}, `/deploy?dialog=cloudflare&zone=${OTHER_ZONE.id}`);

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
    const address = new URLSearchParams(screen.getByTestId('address').textContent?.split('?')[1]);
    expect(address.get('tab')).toBe('security');
  });

  it('opens an old Settings link on the SSL/TLS tab', async () => {
    renderDialog({}, `/deploy?dialog=cloudflare&zone=${ZONE.id}&tab=settings`);
    expect(await screen.findByRole('tab', { name: 'SSL/TLS' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it("puts development mode and I'm Under Attack in the zone header, on every tab", async () => {
    const { user } = renderDialog();
    const quick = await screen.findByRole('group', { name: 'Quick switches' });
    expect(within(quick).getByRole('switch', { name: 'Development mode' })).toBeInTheDocument();
    expect(within(quick).getByRole('switch', { name: "I'm Under Attack" })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    expect(screen.getByRole('group', { name: 'Quick switches' })).toBeInTheDocument();
  });

  it('marks the open zone in the rail', async () => {
    const { user } = renderDialog();
    const rail = await screen.findByRole('navigation', { name: 'Zones' });
    const first = await within(rail).findByRole('button', { name: /example\.com/ });
    const second = within(rail).getByRole('button', { name: /example\.org/ });
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');
    await user.click(second);
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(first).not.toHaveAttribute('aria-current');
  });

  it('resizes the domain list from the keyboard and remembers the width', async () => {
    usePanelWidthStore.setState({ widths: {} });
    const { user } = renderDialog();
    await screen.findByRole('navigation', { name: 'Zones' });
    const handle = screen.getByRole('separator', { name: 'Resize domains' });
    const rail = screen.getByRole('complementary', { name: 'Cloudflare domains' });
    expect(rail.style.width).toBe(`${PANEL_WIDTHS.cloudflareRail.default}px`);

    handle.focus();
    await user.keyboard('{ArrowRight}');
    const wider = usePanelWidthStore.getState().widths.cloudflareRail ?? 0;
    expect(wider).toBeGreaterThan(PANEL_WIDTHS.cloudflareRail.default);
    expect(rail.style.width).toBe(`${wider}px`);
  });

  it('shows the token guide on its own, without an empty domain list', async () => {
    renderDialog({ 'cloudflare.status': async () => NOTHING });
    expect(await screen.findByText('Connect Cloudflare')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Cloudflare domains' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize domains' })).toBeNull();
  });

  it('picks another zone from the rail and keeps the rest of the address', async () => {
    const { user } = renderDialog({}, '/deploy?server=srv-1&dialog=cloudflare');
    const rail = await screen.findByRole('navigation', { name: 'Zones' });
    await user.click(await within(rail).findByRole('button', { name: /example\.org/ }));

    expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
    const address = new URLSearchParams(screen.getByTestId('address').textContent?.split('?')[1]);
    expect(address.get('zone')).toBe(OTHER_ZONE.id);
    expect(address.get('server')).toBe('srv-1');
    expect(address.get('dialog')).toBe('cloudflare');
  });

  it('shimmers while the zones load, and explains when there are none', async () => {
    const { unmount } = renderDialog({
      'cloudflare.listZones': () => new Promise(() => undefined),
    });
    await screen.findByText('Cloudflare token');
    expect(document.querySelector('nav[aria-busy="true"] .shimmer')).not.toBeNull();
    unmount();

    renderDialog({ 'cloudflare.listZones': async () => [] });
    expect(await screen.findByText(/cannot see any domains yet/)).toBeInTheDocument();
  });

  it('says why the zones could not be listed', async () => {
    renderDialog({
      'cloudflare.listZones': async () => {
        throw ipcError('listZones', 'Could not reach Cloudflare.');
      },
    });
    expect(await screen.findByText('Could not reach Cloudflare.')).toBeInTheDocument();
  });

  it('asks to unlock the Servers passkey before reading anything with the token', async () => {
    const { user, bridge } = renderDialog({
      'cloudflare.status': async () => ({ ...CONNECTED, locked: true }),
      'ssh.vaultStatus': async () => ({ hasPasskey: true, unlocked: false }),
    });

    expect(await screen.findByText(/locked with a passkey/)).toBeInTheDocument();
    expect(() => bridge.$fn('cloudflare.listZones')).toThrow();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock the vault' })).toBeInTheDocument();
  });

  it('replaces the token from the token card, or keeps it', async () => {
    const { user } = renderDialog();

    await user.click(await screen.findByRole('button', { name: 'Details' }));
    await user.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(await screen.findByText('Replace the token for Cloudflare')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep the current token' }));
    expect(await screen.findByText('Cloudflare token')).toBeInTheDocument();
  });

  it('reads the zones once the passkey is unlocked', async () => {
    let locked = true;
    const { user, bridge } = renderDialog({
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

    expect(await screen.findByRole('navigation', { name: 'Zones' })).toBeInTheDocument();
    expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalled();
  });

  it('tries the status and the zones again on request', async () => {
    let failStatus = true;
    let failZones = true;
    const { user } = renderDialog({
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

  it('closes from its close button, and reports it', async () => {
    const { user, onOpenChange } = renderDialog();

    await screen.findByRole('navigation', { name: 'Zones' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the token card to one line while the token is fine, so the zone has the room', async () => {
    const { user } = renderDialog();

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

    async function railOf() {
      const rail = await screen.findByRole('navigation', { name: 'Zones' });
      await within(rail).findByText('example.com');
      return rail;
    }

    it('filters the domains as you type, counts what matches and marks the match', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();
      expect(within(rail).getByText('3')).toBeInTheDocument();

      await user.type(within(rail).getByRole('searchbox', { name: 'Search domains' }), 'ORG');

      expect(within(rail).getAllByRole('button', { name: /example\./ })).toHaveLength(1);
      expect(within(rail).getByRole('button', { name: /example\.org/ })).toBeInTheDocument();
      expect(within(rail).getByText('1 of 3')).toBeInTheDocument();
      expect(rail.querySelector('mark')).toHaveTextContent(/^org$/);
    });

    it('reads a pasted address as the domain in it', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();

      await user.click(within(rail).getByRole('searchbox', { name: 'Search domains' }));
      await user.paste('https://www.shop.example.net/cart?id=1');

      expect(within(rail).getAllByRole('button', { name: /example\./ })).toHaveLength(1);
      expect(within(rail).getByRole('button', { name: /shop\.example\.net/ })).toBeInTheDocument();
    });

    it('says when nothing matches, and clears from the box or with Escape', async () => {
      const { user, onOpenChange } = renderDialog(three);
      const rail = await railOf();
      const box = within(rail).getByRole('searchbox', { name: 'Search domains' });

      await user.type(box, 'nothing here');
      expect(within(rail).getByText(/Nothing matches/)).toBeInTheDocument();
      await user.click(within(rail).getByRole('button', { name: 'Clear filter' }));
      expect(within(rail).getAllByRole('button', { name: /example\./ })).toHaveLength(3);

      await user.type(box, 'org');
      await user.keyboard('{Escape}');
      expect(box).toHaveValue('');
      // Escape in a box with text clears it without closing the whole dialog.
      expect(onOpenChange).not.toHaveBeenCalled();
      // An empty box leaves Escape to the dialog again.
      await user.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('opens the first match with Enter and keeps the rest of the address', async () => {
      const { user } = renderDialog(three, '/deploy?server=srv-1&dialog=cloudflare');
      const rail = await railOf();

      await user.type(
        within(rail).getByRole('searchbox', { name: 'Search domains' }),
        'shop{Enter}',
      );

      expect(await screen.findByRole('heading', { name: 'shop.example.net' })).toBeInTheDocument();
      const address = new URLSearchParams(screen.getByTestId('address').textContent?.split('?')[1]);
      expect(address.get('zone')).toBe(SHOP.id);
      expect(address.get('server')).toBe('srv-1');
    });

    it('moves from the box into the list and along it with the arrow keys', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();
      const box = within(rail).getByRole('searchbox', { name: 'Search domains' });

      await user.type(box, 'example');
      await user.keyboard('{ArrowDown}');
      expect(within(rail).getByRole('button', { name: /example\.com/ })).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(within(rail).getByRole('button', { name: /example\.org/ })).toHaveFocus();
      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(box).toHaveFocus();
    });

    it('jumps to the box with Ctrl+F', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();
      await user.click(within(rail).getByRole('button', { name: /example\.org/ }));

      await user.keyboard('{Control>}f{/Control}');

      expect(within(rail).getByRole('searchbox', { name: 'Search domains' })).toHaveFocus();
    });

    it('jumps to the box with Ctrl+F while the dialog itself has focus', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();
      // Where focus lands once the button that had it goes away, as after saving a token.
      screen.getByRole('dialog').focus();

      await user.keyboard('{Control>}f{/Control}');

      expect(within(rail).getByRole('searchbox', { name: 'Search domains' })).toHaveFocus();
    });

    it('keeps the open zone open while the search hides it in the rail', async () => {
      const { user } = renderDialog(three);
      const rail = await railOf();

      await user.type(within(rail).getByRole('searchbox', { name: 'Search domains' }), 'shop');

      expect(within(rail).queryByRole('button', { name: /example\.com/ })).toBeNull();
      expect(screen.getByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    });

    it('leaves the search out while there is only one domain', async () => {
      renderDialog({ 'cloudflare.listZones': async () => [ZONE] });
      const rail = await railOf();
      expect(within(rail).queryByRole('searchbox')).toBeNull();
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
      renderDialog(several);

      const rail = await screen.findByRole('navigation', { name: 'Zones' });
      const work = await within(rail).findByRole('region', { name: 'Cloudflare' });
      const client = within(rail).getByRole('region', { name: 'Client Co' });
      expect(await within(work).findByText('example.com')).toBeInTheDocument();
      expect(await within(client).findByText('example.org')).toBeInTheDocument();
      expect(within(work).queryByText('example.org')).toBeNull();
    });

    it('leaves out an account with nothing that matches while searching', async () => {
      const { user } = renderDialog(several);
      const rail = await screen.findByRole('navigation', { name: 'Zones' });
      await within(rail).findByText('example.org');

      await user.type(within(rail).getByRole('searchbox', { name: 'Search domains' }), '.org');

      expect(within(rail).queryByRole('region', { name: 'Cloudflare' })).toBeNull();
      expect(within(rail).getByRole('region', { name: 'Client Co' })).toBeInTheDocument();
    });

    it('asks each account for its own zones', async () => {
      const { bridge } = renderDialog(several);
      await screen.findByRole('heading', { name: 'example.com' });
      expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalledWith('acct-1');
      expect(bridge.$fn('cloudflare.listZones')).toHaveBeenCalledWith('acct-2');
    });

    it('shows the token card of the account that holds the open zone', async () => {
      const { user } = renderDialog(several);
      const rail = await screen.findByRole('navigation', { name: 'Zones' });

      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
      expect(screen.getAllByText('Client Co')).toHaveLength(1);
      await user.click(await within(rail).findByRole('button', { name: /example.org/ }));

      expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
      expect(screen.getAllByText('Client Co')).toHaveLength(2);
    });

    it('keeps the other accounts domains when one account fails', async () => {
      renderDialog({
        ...several,
        'cloudflare.listZones': async (accountId: string) => {
          if (accountId === 'acct-2') throw ipcError('listZones', 'Could not reach Cloudflare.');
          return [ZONE];
        },
      });

      expect(await screen.findByText('Could not reach Cloudflare.')).toBeInTheDocument();
      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
    });

    it('adds another account from the rail, and goes back without saving', async () => {
      const { user } = renderDialog(several);

      await user.click(await screen.findByRole('button', { name: 'Add account' }));
      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
      expect(screen.getByLabelText('Name (optional)')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByRole('navigation', { name: 'Zones' })).toBeInTheDocument();
    });

    it('draws the connect steps beside the domains, not in a second dialog on top', async () => {
      const { user } = renderDialog(several);

      await user.click(await screen.findByRole('button', { name: 'Add account' }));

      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Zones' })).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByRole('heading', { name: 'example.com' })).toBeInTheDocument();
      expect(screen.queryByText('Connect another Cloudflare account')).toBeNull();
    });

    it('leaves the connect steps when another domain is picked', async () => {
      const { user } = renderDialog(several);

      await user.click(await screen.findByRole('button', { name: 'Add account' }));
      expect(await screen.findByText('Connect another Cloudflare account')).toBeInTheDocument();
      const rail = screen.getByRole('navigation', { name: 'Zones' });
      await user.click(await within(rail).findByRole('button', { name: /example\.org/ }));

      expect(await screen.findByRole('heading', { name: 'example.org' })).toBeInTheDocument();
      expect(screen.queryByText('Connect another Cloudflare account')).toBeNull();
    });

    it("opens an account's token details when its name is picked in the rail", async () => {
      const { user } = renderDialog(several);
      const rail = await screen.findByRole('navigation', { name: 'Zones' });

      await user.click(await within(rail).findByRole('button', { name: 'Client Co' }));

      expect(await screen.findByRole('button', { name: 'Replace token' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    it('lets the first account be added from the one-column view too', async () => {
      const { user } = renderDialog({
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
