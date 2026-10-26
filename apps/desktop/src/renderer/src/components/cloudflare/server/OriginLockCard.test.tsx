import { encodeCloudflareError } from '@shared/cloudflareErrors';
import type { CloudflareOriginLockPlan } from '@shared/cloudflareTypes';
import type {
  FirewallChangeSetInfo,
  OriginLockStatus,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * E14 T6 in the Firewall section: the lock's state in words with a mark, what differs from
 * Cloudflare's ranges, and a review that shows each site domain's state in Cloudflare and the
 * exact commands before the change set starts its countdown.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { OriginLockCard } = await import('./OriginLockCard');

const RANGES = {
  ipv4: ['173.245.48.0/20'],
  ipv6: ['2400:cb00::/32'],
  fetchedAtUnixMs: Date.now() - 60_000,
};

const OFF: OriginLockStatus = {
  enabled: false,
  authenticatedOriginPulls: false,
  state: 'off',
  ports: [80, 443],
  missingRules: ['Allow 80/tcp from 173.245.48.0/20'],
  openRules: ['Allow 80/tcp from anywhere'],
  staleRules: [],
  warnings: [],
  ranges: RANGES,
};

const CHANGE: FirewallChangeSetInfo = {
  id: '00000000-0000-4000-9000-000000000001',
  state: 'awaitingConfirmation',
  backend: 'ufw',
  summary: 'add Allow 80/tcp from 173.245.48.0/20',
  commands: ['ufw allow proto tcp from 173.245.48.0/20 to any port 80'],
  createdAtUnixMs: Date.now(),
  guardOverridden: false,
};

const PLAN: CloudflareOriginLockPlan = {
  preview: {
    changes: [
      {
        kind: 'addRule',
        rule: { action: 'allow', protocol: 'tcp', port: 80, source: '173.245.48.0/20' },
      },
    ],
    notes: [],
    ranges: RANGES,
    firewall: {
      summary: CHANGE.summary,
      commands: CHANGE.commands,
      notes: [],
      resultingRules: [],
      resultingActive: true,
      resultingDefaultIncoming: 'deny',
      guard: { blocked: false, reasons: [], checked: [] },
      needsStepUp: false,
      confirmWithinSeconds: 60,
    },
  },
  domains: [
    { domain: 'blog.example.com', zoneId: 'z'.repeat(32), zoneName: 'example.com', proxied: true },
    { domain: 'www.example.com', zoneId: 'z'.repeat(32), zoneName: 'example.com', proxied: false },
  ],
};

function render(bridge: Record<string, unknown>, canAdmin = true) {
  const onApplied = vi.fn();
  const view = renderWithProviders(
    <OriginLockCard
      serverId="srv-1"
      serverName="Production"
      signedIn
      canAdmin={canAdmin}
      busy={false}
      onApplied={onApplied}
    />,
    { bridge },
  );
  return { ...view, onApplied };
}

describe('OriginLockCard', () => {
  it('says the lock is off, and Viewers get no buttons', async () => {
    render({ 'cloudflareServer.originLock': async () => OFF }, false);

    expect(await screen.findByText('Off: every address reaches ports 80 and 443')).toBeTruthy();
    expect(screen.getByText(/1 IPv4 and 1 IPv6 ranges from Cloudflare/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lock to Cloudflare' })).toBeNull();
  });

  it('reviews domains and commands, then applies and hands the change to the countdown', async () => {
    const { user, bridge, onApplied } = render({
      'cloudflareServer.originLock': async () => OFF,
      'cloudflareServer.previewOriginLock': async () => PLAN,
      'cloudflareServer.applyOriginLock': async () => ({
        status: { ...OFF, enabled: true, state: 'pending' },
        nginx: { applied: true, problems: [], warnings: [] },
        changeSet: CHANGE,
      }),
    });

    await user.click(await screen.findByRole('button', { name: 'Lock to Cloudflare' }));
    const dialog = await screen.findByRole('dialog', { name: 'Lock Production to Cloudflare' });
    const domains = await within(dialog).findByRole('region', { name: 'Site domains' });
    expect(within(domains).getByText('Proxied through Cloudflare')).toBeTruthy();
    expect(within(domains).getByText('DNS only: visitors would no longer reach it')).toBeTruthy();
    expect(within(dialog).getByText(CHANGE.commands[0])).toBeTruthy();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Lock to Cloudflare' }));

    expect(bridge.$fn('cloudflareServer.previewOriginLock')).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: true,
    });
    expect(bridge.$fn('cloudflareServer.applyOriginLock')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      enabled: true,
      authenticatedOriginPulls: true,
    });
    expect(onApplied).toHaveBeenCalledWith(CHANGE);
  });

  it('lists what differs when the firewall drifted', async () => {
    render({
      'cloudflareServer.originLock': async () => ({
        ...OFF,
        enabled: true,
        state: 'drifted',
        missingRules: ['Allow 443/tcp from 2400:cb00::/32'],
        openRules: ['Allow 443/tcp from anywhere'],
      }),
    });

    expect(await screen.findByText('On, but the firewall no longer matches')).toBeTruthy();
    expect(screen.getByText('Allow 443/tcp from 2400:cb00::/32')).toBeTruthy();
    expect(screen.getByText('Allow 443/tcp from anywhere')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bring up to date' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('turns a refused Cloudflare step into the permission to add', async () => {
    const { user } = render({
      'cloudflareServer.originLock': async () => OFF,
      'cloudflareServer.previewOriginLock': async () => {
        throw new Error(
          `Error invoking remote method 'x': Error: ${encodeCloudflareError('missing-permission', 'no', 'zoneSettings')}`,
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Lock to Cloudflare' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Zone > Zone Settings > Edit');
    expect(
      within(alert).getByRole('button', { name: "Open Cloudflare's token page" }),
    ).toBeTruthy();
  });
});
