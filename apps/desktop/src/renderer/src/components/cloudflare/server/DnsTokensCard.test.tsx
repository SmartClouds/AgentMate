import { encodeCloudflareError } from '@shared/cloudflareErrors';
import type { DnsCredentialInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ZONE } from '../testing/fixtures';

/**
 * E14 T7 on the Cloudflare dialog: which servers hold a DNS token for the zone, making one (with a
 * guided fix when the account token cannot), pasting one, and removing it after a confirm.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { DnsTokensCard } = await import('./DnsTokensCard');

const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Production',
  host: 'prod.example.net',
  port: 22,
  username: 'deployer',
  core: {
    version: '1.0.0',
    release: '/opt/runova-core/releases/1.0.0',
    transport: 'streamlocal',
    installedAt: 0,
    os: 'Ubuntu 24.04.1 LTS',
    architecture: 'x86_64',
  },
  enrolled: true,
};
const BARE: DeployServer = { ...SERVER, id: 'srv-2', nickname: 'Fresh', core: null };

const HELD: DnsCredentialInfo = {
  zone: 'example.com',
  zoneId: ZONE.id,
  provider: 'cloudflare',
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
  tokenId: 'ed17574386854bf78a67040be0a770b1',
};

function render(bridge: Record<string, unknown>) {
  return renderWithProviders(<DnsTokensCard zone={ZONE} />, {
    bridge: { 'deploy.listServers': async () => [SERVER, BARE], ...bridge },
  });
}

describe('DnsTokensCard', () => {
  it('lists servers with a core and makes a token for one', async () => {
    let held: DnsCredentialInfo[] = [];
    const { user, bridge } = render({
      'cloudflareServer.dnsTokens': async () => held,
      'cloudflareServer.provisionDnsToken': async () => {
        held = [HELD];
        return HELD;
      },
    });

    const list = await screen.findByRole('list', { name: 'Servers' });
    expect(within(list).queryByText('Fresh')).toBeNull();
    expect(await within(list).findByText('No DNS token for example.com')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Make a DNS token' }));

    expect(bridge.$fn('cloudflareServer.provisionDnsToken')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      zoneId: ZONE.id,
      mode: 'mint',
    });
    expect(await within(list).findByText(/Holds a DNS token/)).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Production has a DNS token for example.com.');
  });

  it('names User > API Tokens > Edit and offers pasting a token when making one is refused', async () => {
    const { user, bridge } = render({
      'cloudflareServer.dnsTokens': async () => [],
      'cloudflareServer.provisionDnsToken': async (input: { mode: string }) => {
        if (input.mode === 'mint') {
          throw new Error(
            `Error invoking remote method 'x': Error: ${encodeCloudflareError('missing-permission', 'no', 'apiTokens')}`,
          );
        }
        return HELD;
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Make a DNS token' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('User > API Tokens > Edit');
    expect(alert.textContent).toContain('Or make a token yourself');

    await user.click(screen.getByRole('button', { name: 'Paste a token' }));
    await user.type(
      screen.getByLabelText('DNS token for example.com'),
      'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
    );
    await user.click(screen.getByRole('button', { name: 'Check and send' }));

    expect(bridge.$fn('cloudflareServer.provisionDnsToken')).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      zoneId: ZONE.id,
      mode: 'paste',
      token: 'Zt9pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5Q',
    });
  });

  it('removes a token after a confirm, deleting the one Runova made at Cloudflare', async () => {
    const { user, bridge } = render({
      'cloudflareServer.dnsTokens': async () => [HELD],
      'cloudflareServer.removeDnsToken': async () => undefined,
    });

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(confirm).toHaveBeenCalled();
    expect(bridge.$fn('cloudflareServer.removeDnsToken')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      zone: 'example.com',
      deleteAtCloudflare: true,
    });
  });
});
