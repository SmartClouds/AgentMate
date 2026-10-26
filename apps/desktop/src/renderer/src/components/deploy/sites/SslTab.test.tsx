import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { blankDraft, draftFromSite, type SiteDraft } from '@/lib/deploy/sites/draft';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { certificate, DAY, job, NOW, SERVER, SHOP, site, sitesBridge } from './testing/fixtures';

/**
 * The SSL tab: a certificate's state and countdown, the last attempt and its log, issuing with
 * the CA's terms, renewing, uploading, removing with a step-up, and the HTTPS switches that wait
 * for a certificate.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { SslTab } = await import('./SslTab');

const STEP_UP = new Error(
  "Error invoking remote method 'deployCerts:remove': Error: [core:stepUpRequired] Confirm your password (or a code from your authenticator app) to do this.",
);

function Harness({
  value,
  admin,
  onChanged,
}: {
  value: SiteInfo | undefined;
  admin: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<SiteDraft>(() =>
    value ? draftFromSite(value) : blankDraft(),
  );
  return (
    <SslTab
      draft={draft}
      set={(patch) => setDraft((current) => ({ ...current, ...patch }))}
      error={() => undefined}
      readOnly={!admin}
      server={SERVER}
      site={value}
      admin={admin}
      onChanged={onChanged}
    />
  );
}

function renderTab(
  value: SiteInfo | undefined,
  bridge: Record<string, unknown> = {},
  admin = true,
) {
  const onChanged = vi.fn();
  const view = renderWithProviders(<Harness value={value} admin={admin} onChanged={onChanged} />, {
    bridge: { ...sitesBridge(), ...bridge },
  });
  return { ...view, onChanged };
}

describe('SslTab status', () => {
  it('asks for the site to be saved first', () => {
    renderTab(undefined);
    expect(screen.getByText(/Save the site first, then issue a certificate/)).toBeInTheDocument();
  });

  it('keeps Force HTTPS and HSTS off until there is a certificate', () => {
    renderTab(SHOP);
    expect(screen.getByText('No SSL')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Force HTTPS' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'HSTS' })).toBeDisabled();
    expect(screen.getAllByText('Needs a certificate first.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Issue a certificate/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Renew now/ })).toBeNull();
  });

  it('shows the countdown, renewal, the last attempt and its log', async () => {
    const { user, bridge } = renderTab(site(), {
      'deployJobs.get': job('certificateIssue', 'Issue a certificate for blog.example.com'),
    });
    expect(screen.getByText('SSL, 60 days')).toBeInTheDocument();
    expect(screen.getByText(/^Renews automatically around /)).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show its log/ }));
    expect(bridge.$fn('deployJobs.get')).toHaveBeenCalledWith(
      SERVER.id,
      '00000000-0000-4000-8000-000000000009',
    );
    expect(
      await screen.findByRole('dialog', { name: /Issue a certificate for blog/ }),
    ).toBeInTheDocument();
  });

  it('says when renewals failed and when the next try is', () => {
    renderTab(
      site({
        certificate: certificate({
          state: 'expiringSoon',
          notAfterUnixMs: NOW + 5 * DAY + 60_000,
          failedAttempts: 3,
          nextAttemptAtUnixMs: NOW + 2 * 3_600_000,
          lastError: 'Port 80 is blocked.',
        }),
      }),
    );
    expect(screen.getByText('SSL, 5 days')).toBeInTheDocument();
    expect(
      screen.getByText('The last 3 renewal attempts failed. Next try in 2 hours.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Port 80 is blocked.')).toBeInTheDocument();
  });

  it('lets a Viewer look without buttons', () => {
    renderTab(site(), {}, false);
    expect(screen.queryByRole('button', { name: /Issue/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'HTTP/2' })).toBeDisabled();
  });
});

describe('SslTab actions', () => {
  it('issues only once the terms are accepted, then follows the job', async () => {
    const { user, bridge } = renderTab(SHOP, {
      'deployCerts.issue': job('certificateIssue', 'Issue a certificate for shop.example.com'),
    });
    await user.click(screen.getByRole('button', { name: /Issue a certificate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue a certificate' });
    const go = within(dialog).getByRole('button', { name: 'Issue the certificate' });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByRole('switch', { name: 'Use the staging CA' }));
    await user.type(within(dialog).getByLabelText('Contact email (optional)'), 'ops@example.com');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(go);
    expect(bridge.$fn('deployCerts.issue')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      siteId: 'shop',
      acceptTermsOfService: true,
      staging: true,
      contactEmail: 'ops@example.com',
    });
    expect(
      await screen.findByRole('dialog', { name: /Issue a certificate for shop/ }),
    ).toBeInTheDocument();
  });

  it('says why an order was refused', async () => {
    const { user } = renderTab(SHOP, {
      'deployCerts.issue': () =>
        Promise.reject(new Error('shop.example.com does not point at this server.')),
    });
    await user.click(screen.getByRole('button', { name: /Issue a certificate/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Issue the certificate' }));
    expect(await within(dialog).findByText(/does not point at this server/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renews now, and says when that could not start', async () => {
    const { user, bridge } = renderTab(site(), {
      'deployCerts.renew': job('certificateRenew', 'Renew the certificate for blog.example.com'),
    });
    await user.click(screen.getByRole('button', { name: /Renew now/ }));
    expect(bridge.$fn('deployCerts.renew')).toHaveBeenCalledWith(SERVER.id, 'blog');
    expect(
      await screen.findByRole('dialog', { name: /Renew the certificate/ }),
    ).toBeInTheDocument();
    bridge.$set('deployCerts.renew', () => Promise.reject(new Error('Busy.')));
    await user.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0],
    );
    await user.click(screen.getByRole('button', { name: /Renew now/ }));
    expect(await screen.findByText('Busy.')).toBeInTheDocument();
  });

  it('uploads a certificate, listing what the core found wrong first', async () => {
    let attempt = 0;
    const { user, onChanged } = renderTab(SHOP, {
      'deployCerts.upload': async () => {
        attempt += 1;
        if (attempt === 1) return { problems: ['The key does not match the certificate.'] };
        if (attempt === 2) {
          return {
            problems: [],
            certificate: certificate({ source: 'uploaded' }),
            apply: {
              applied: false,
              problems: [{ field: 'nginx', message: 'reload failed' }],
              warnings: [],
            },
          };
        }
        return {
          problems: [],
          certificate: certificate({ source: 'uploaded' }),
          apply: { applied: true, problems: [], warnings: [] },
        };
      },
    });
    await user.click(screen.getByRole('button', { name: /Upload a certificate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Upload a certificate' });
    const go = within(dialog).getByRole('button', { name: 'Upload and apply' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Certificate and chain'), 'CERT');
    await user.type(within(dialog).getByLabelText('Private key'), 'KEY');
    await user.click(go);
    expect(
      await within(dialog).findByText('The key does not match the certificate.'),
    ).toBeInTheDocument();
    await user.click(go);
    expect(await within(dialog).findByText('reload failed')).toBeInTheDocument();
    await user.click(go);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Certificate uploaded and live.');
  });

  it('removes a certificate after asking, with the password when the core wants it', async () => {
    let calls = 0;
    const { user, bridge, onChanged } = renderTab(site(), {
      'deployCerts.remove': async () => {
        calls += 1;
        if (calls === 1) throw STEP_UP;
        return { applied: true, problems: [], warnings: [] };
      },
    });
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));
    const confirm = await screen.findByRole('dialog', {
      name: /Remove the certificate from blog.example.com/,
    });
    await user.click(within(confirm).getByRole('checkbox'));
    await user.click(within(confirm).getByRole('button', { name: /Remove the certificate/ }));
    const proof = await screen.findByRole('dialog', { name: /Confirm it is you/ });
    await user.type(within(proof).getByLabelText('Password'), 'pw');
    await user.click(within(proof).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(bridge.$fn('deployCerts.remove')).toHaveBeenLastCalledWith({
      serverId: SERVER.id,
      siteId: 'blog',
      revoke: true,
      reason: 'keyCompromise',
      password: 'pw',
    });
    expect(toast.success).toHaveBeenCalledWith('Certificate removed.');
    expect(screen.getByRole('switch', { name: 'Force HTTPS' })).not.toBeChecked();
  });

  it('keeps the certificate when the removal is called off, and reports a refusal', async () => {
    const { user } = renderTab(site({ certificate: certificate({ source: 'uploaded' }) }), {
      'deployCerts.remove': () => Promise.reject(new Error('Forbidden.')),
    });
    expect(screen.getByText(/Uploaded by hand/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));
    let confirm = await screen.findByRole('dialog');
    expect(within(confirm).queryByRole('checkbox')).toBeNull();
    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));
    confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: /Remove the certificate/ }));
    expect(await screen.findByText('Forbidden.')).toBeInTheDocument();
  });

  it('turns HSTS on with its options once there is a certificate', async () => {
    const { user } = renderTab(site());
    await user.click(screen.getByRole('switch', { name: 'HSTS' }));
    expect(screen.getByLabelText('Max-age')).toHaveValue('31536000');
    await user.click(screen.getByRole('switch', { name: 'Include subdomains' }));
    await user.click(screen.getByRole('switch', { name: /Preload/ }));
    await user.clear(screen.getByLabelText('Max-age'));
    await user.click(screen.getByRole('switch', { name: 'Force HTTPS' }));
    expect(screen.getByRole('switch', { name: 'Force HTTPS' })).not.toBeChecked();
  });
});
