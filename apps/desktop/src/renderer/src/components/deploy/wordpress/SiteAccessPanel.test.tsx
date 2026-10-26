import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SiteAccessPanel } from './SiteAccessPanel';
import { wpAudit, wpSite, wpSiteInfo } from './testing/fixtures';

/**
 * Access: the key's scope in words, the plain-HTTP opt-in with its warning, an HTTP sign-in whose
 * password never comes back, renaming, disconnecting (with or without revoking on the site) and
 * the site's audit log a page at a time.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

function renderPanel(bridge: Record<string, unknown> = {}, site = wpSite()) {
  const onDisconnected = vi.fn();
  const view = renderWithProviders(
    <SiteAccessPanel site={site} onDisconnected={onDisconnected} />,
    {
      bridge: {
        'deployWordPress.siteInfo': async () => wpSiteInfo(),
        'deployWordPress.audit': async () => [wpAudit(1), wpAudit(2)],
        'projects.list': async () => [],
        ...bridge,
      },
    },
  );
  return { ...view, onDisconnected };
}

describe('SiteAccessPanel', () => {
  it('explains a read-only key', () => {
    renderPanel({}, wpSite({ scope: 'read' }));

    expect(screen.getByText(/You can pull files from this site but not deploy to it/)).toBeTruthy();
    expect(screen.getByText('Read-only key')).toBeTruthy();
  });

  it('warns about plain HTTP and lets the user allow it for the site', async () => {
    const { user, bridge } = renderPanel(
      { 'deployWordPress.updateSettings': async () => wpSite({ allowPlainHttp: true }) },
      wpSite({ transport: 'plain-http', siteUrl: 'http://bakery.example' }),
    );

    expect(
      screen.getByText(/anyone on the network between you and the site can read/),
    ).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: 'Allow plain HTTP for this site' }));
    expect(bridge.$fn('deployWordPress.updateSettings')).toHaveBeenCalledWith({
      siteId: wpSite().id,
      allowPlainHttp: true,
    });
  });

  it('shows no plain-HTTP switch for an HTTPS site', () => {
    renderPanel();

    expect(screen.queryByRole('switch', { name: 'Allow plain HTTP for this site' })).toBeNull();
  });

  it('saves an HTTP sign-in, clears the password and only says it is saved', async () => {
    const { user, bridge } = renderPanel({
      'deployWordPress.updateSettings': async () => wpSite({ hasHttpAuth: true }),
    });

    await user.type(screen.getByLabelText('User name'), 'staging');
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Save sign-in' }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.updateSettings')).toHaveBeenCalledWith({
        siteId: wpSite().id,
        httpAuth: { username: 'staging', password: 'hunter2' },
      }),
    );
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('never shows a saved password, and can remove the sign-in', async () => {
    const { user, bridge } = renderPanel(
      { 'deployWordPress.updateSettings': async () => wpSite() },
      wpSite({ hasHttpAuth: true }),
    );

    expect(screen.getByText(/A sign-in is saved/)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(bridge.$fn('deployWordPress.updateSettings')).toHaveBeenCalledWith({
      siteId: wpSite().id,
      httpAuth: null,
    });
  });

  it('renames the site', async () => {
    const { user, bridge } = renderPanel({
      'deployWordPress.updateSettings': async () => wpSite({ label: 'Shop' }),
    });

    const field = screen.getByLabelText('Name in Runova');
    await user.clear(field);
    await user.type(field, 'Shop');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(bridge.$fn('deployWordPress.updateSettings')).toHaveBeenCalledWith({
      siteId: wpSite().id,
      label: 'Shop',
    });
  });

  it('disconnects after a confirmation, revoking on the site by default', async () => {
    const { user, bridge, onDisconnected } = renderPanel({
      'deployWordPress.disconnect': async () => undefined,
    });

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disconnect Bakery?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(onDisconnected).toHaveBeenCalled());
    expect(bridge.$fn('deployWordPress.disconnect')).toHaveBeenCalledWith({
      siteId: wpSite().id,
      revokeOnSite: true,
    });
  });

  it('can disconnect without revoking on the site', async () => {
    const { user, bridge } = renderPanel({ 'deployWordPress.disconnect': async () => undefined });

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.disconnect')).toHaveBeenCalledWith({
        siteId: wpSite().id,
        revokeOnSite: false,
      }),
    );
  });

  it('keeps the site when disconnecting fails, and says why', async () => {
    const { user, onDisconnected } = renderPanel({
      'deployWordPress.disconnect': async () => {
        throw new Error('[wp:unreachable] down');
      },
    });

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    expect(await within(dialog).findByText(/Couldn't reach the site/)).toBeTruthy();
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});

describe('SiteAccessPanel audit log', () => {
  it('shimmers while the log loads', () => {
    const { container } = renderPanel({
      'deployWordPress.audit': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('pages back through older entries by id', async () => {
    const first = Array.from({ length: 50 }, (_, index) => wpAudit(100 - index));
    const { user, bridge } = renderPanel({
      'deployWordPress.audit': async ({ before }: { before?: number }) =>
        before === undefined
          ? first
          : [wpAudit(40, { event: 'authFailed', detail: 'bad <i>sig</i>' })],
    });

    expect(await screen.findByText('entry 100')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Load older entries/ }));

    expect(await screen.findByText('bad <i>sig</i>')).toBeTruthy();
    expect(screen.getByText('Request refused')).toBeTruthy();
    expect(bridge.$fn('deployWordPress.audit')).toHaveBeenLastCalledWith({
      siteId: wpSite().id,
      limit: 50,
      before: 51,
    });
    expect(screen.queryByRole('button', { name: /Load older entries/ })).toBeNull();
  });

  it('offers no older page when the first page is short', async () => {
    renderPanel();

    expect(await screen.findByText('entry 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load older entries/ })).toBeNull();
  });

  it('says why the log did not load', async () => {
    renderPanel({
      'deployWordPress.audit': async () => {
        throw new Error('[wp:revoked] gone');
      },
    });

    expect(await screen.findByText(/access was revoked on the site/)).toBeTruthy();
  });
});
