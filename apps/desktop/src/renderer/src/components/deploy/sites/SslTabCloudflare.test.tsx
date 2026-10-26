import { encodeCloudflareError } from '@shared/cloudflareErrors';
import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { draftFromSite, type SiteDraft } from '@/lib/deploy/sites/draft';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { job, SERVER, SHOP, sitesBridge } from './testing/fixtures';

/**
 * The SSL tab's Cloudflare entry points (E14 T5, T7, T8): an Origin CA certificate for a key the
 * server makes, and DNS-01 validation once the server holds a DNS token for the site's zone.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/stores/confirmStore', () => ({ confirmDialog: confirm }));

const { SslTab } = await import('./SslTab');

const TOKEN = {
  zone: 'example.com',
  zoneId: '023e105f4ecef8ad9ca31a8372d0c353',
  provider: 'cloudflare',
  createdAtUnixMs: 0,
  updatedAtUnixMs: 0,
};

function Harness({ value, onChanged }: { value: SiteInfo; onChanged: () => void }) {
  const [draft, setDraft] = useState<SiteDraft>(() => draftFromSite(value));
  return (
    <SslTab
      draft={draft}
      set={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      error={() => undefined}
      readOnly={false}
      server={SERVER}
      site={value}
      admin
      onChanged={onChanged}
    />
  );
}

function renderTab(value: SiteInfo, bridge: Record<string, unknown>) {
  const onChanged = vi.fn();
  const view = renderWithProviders(<Harness value={value} onChanged={onChanged} />, {
    bridge: { ...sitesBridge(), ...bridge },
  });
  return { ...view, onChanged };
}

describe('SslTab with Cloudflare', () => {
  it('installs an Origin CA certificate after saying who trusts it', async () => {
    const { user, bridge, onChanged } = renderTab(SHOP, {
      'cloudflareServer.originCertificate': async () => ({ problems: [] }),
    });

    await user.click(screen.getByRole('button', { name: /Cloudflare Origin CA/ }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Install a Cloudflare Origin CA certificate?' }),
    );
    expect(bridge.$fn('cloudflareServer.originCertificate')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      siteId: 'shop',
    });
    expect(toast.success).toHaveBeenCalledWith('Origin CA certificate installed and live.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('names SSL and Certificates when the account token cannot make one', async () => {
    const { user } = renderTab(SHOP, {
      'cloudflareServer.originCertificate': async () => {
        throw new Error(
          `Error invoking remote method 'x': Error: ${encodeCloudflareError('missing-permission', 'no', 'sslCertificates')}`,
        );
      },
    });

    await user.click(screen.getByRole('button', { name: /Cloudflare Origin CA/ }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Zone > SSL and Certificates > Edit',
    );
  });

  it('offers DNS-01 only when the server holds a token for the zone, and sends it with the order', async () => {
    const { user, bridge } = renderTab(SHOP, {
      'cloudflareServer.dnsTokens': async () => [TOKEN],
      'deployCerts.issue': job('certificateIssue', 'Issue a certificate for shop.example.com'),
    });

    await user.click(screen.getByRole('button', { name: /Issue a certificate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue a certificate' });
    const dns = await within(dialog).findByRole('switch', {
      name: 'Validate over DNS (Cloudflare DNS-01)',
    });
    await vi.waitFor(() => expect(dns).toBeEnabled());
    await user.click(dns);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Issue the certificate' }));

    expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      siteId: 'shop',
      acceptTermsOfService: true,
      staging: false,
      preferDns01: true,
    });
  });

  it('says what DNS-01 needs when the server has no token', async () => {
    const { user } = renderTab(SHOP, { 'cloudflareServer.dnsTokens': async () => [] });

    await user.click(screen.getByRole('button', { name: /Issue a certificate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue a certificate' });

    expect(
      within(dialog).getByRole('switch', { name: 'Validate over DNS (Cloudflare DNS-01)' }),
    ).toBeDisabled();
    expect(
      await within(dialog).findByText(
        /Needs a Cloudflare DNS token on this server for shop.example.com/,
      ),
    ).toBeInTheDocument();
  });
});
