import type { DeployServer } from '@shared/deployTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { fileSite, snapshot } from './files/testing/fixtures';
import { ServerRail } from './ServerRail';
import { wpSite } from './wordpress/testing/fixtures';

/**
 * The rail lists the servers and, under them, the WordPress sites: each site with its address,
 * when it was last reached and the two badges that change what can be done with it.
 */

const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Production',
  host: 'prod.example',
  port: 22,
  username: 'deployer',
  core: null,
  enrolled: false,
};

function renderRail(props: Partial<Parameters<typeof ServerRail>[0]> = {}) {
  const onSelect = vi.fn();
  const onSelectSite = vi.fn();
  const onConnectSite = vi.fn();
  const onOpenCloudflare = vi.fn();
  const view = renderWithProviders(
    <ServerRail
      servers={[SERVER]}
      selectedId="srv-1"
      onSelect={onSelect}
      sites={[]}
      onSelectSite={onSelectSite}
      onConnectSite={onConnectSite}
      onOpenCloudflare={onOpenCloudflare}
      {...props}
    />,
  );
  return { ...view, onSelect, onSelectSite, onConnectSite, onOpenCloudflare };
}

describe('ServerRail Cloudflare', () => {
  it('opens the Cloudflare dialog from its row', async () => {
    const { user, onOpenCloudflare } = renderRail();

    await user.click(screen.getByRole('button', { name: /Cloudflare: domains and DNS/ }));
    expect(onOpenCloudflare).toHaveBeenCalledTimes(1);
  });
});

describe('ServerRail WordPress sites', () => {
  it('lists each site with its host, last contact and badges', () => {
    renderRail({
      sites: [
        wpSite(),
        wpSite({
          id: 'site-2',
          label: 'Staging',
          siteUrl: 'http://staging.bakery.example/blog/',
          scope: 'read',
          transport: 'plain-http',
          lastSeenAt: null,
        }),
      ],
    });

    const list = screen.getByRole('list', { name: 'WordPress sites' });
    const [first, second] = within(list).getAllByRole('button');
    expect(within(first).getByText('Bakery')).toBeTruthy();
    expect(within(first).getByText('bakery.example')).toBeTruthy();
    expect(within(first).getByText('Seen 5m ago')).toBeTruthy();
    expect(within(first).queryByText('Read-only')).toBeNull();
    expect(within(first).queryByText('Plain HTTP')).toBeNull();

    expect(within(second).getByText('staging.bakery.example/blog')).toBeTruthy();
    expect(within(second).getByText('Not reached yet')).toBeTruthy();
    expect(within(second).getByText('Read-only')).toBeTruthy();
    expect(within(second).getByText('Plain HTTP')).toBeTruthy();
  });

  it('selects a site and marks the selected one', async () => {
    const { user, onSelectSite } = renderRail({
      sites: [wpSite()],
      selectedId: null,
      selectedSiteId: wpSite().id,
    });

    const button = within(screen.getByRole('list', { name: 'WordPress sites' })).getByRole(
      'button',
    );
    expect(button.getAttribute('aria-current')).toBe('true');
    await user.click(button);
    expect(onSelectSite).toHaveBeenCalledWith(wpSite().id);
  });

  it('offers to connect a site', async () => {
    const { user, onConnectSite } = renderRail();

    await user.click(screen.getByRole('button', { name: /Connect a WordPress site/ }));
    expect(onConnectSite).toHaveBeenCalled();
  });

  it('shimmers in the sites group while the sites load', () => {
    const { container } = renderRail({ sites: undefined, sitesLoading: true });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
    expect(screen.getByText('Production')).toBeTruthy();
  });

  it('says why the sites did not load and offers to try again', async () => {
    const onRetrySites = vi.fn();
    const { user } = renderRail({ sitesError: 'disk is gone', onRetrySites });

    expect(screen.getByRole('alert').textContent).toContain('disk is gone');
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetrySites).toHaveBeenCalled();
  });

  it('says so when there are only sites', () => {
    renderRail({ servers: [], selectedId: null, sites: [wpSite()] });

    expect(screen.getByText('No servers yet.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'WordPress sites' })).toBeTruthy();
  });

  it('shows no sites group when the page passes none', () => {
    renderWithProviders(
      <ServerRail
        servers={[SERVER]}
        selectedId="srv-1"
        onSelect={vi.fn()}
        onOpenCloudflare={vi.fn()}
      />,
    );

    expect(screen.queryByText('WordPress sites')).toBeNull();
  });
});

describe('ServerRail FTP and SFTP sites', () => {
  function renderFiles(props: Partial<Parameters<typeof ServerRail>[0]> = {}) {
    const onSelectFileSite = vi.fn();
    const onAddFileSite = vi.fn();
    const view = renderRail({
      fileSites: [],
      onSelectFileSite,
      onAddFileSite,
      ...props,
    });
    return { ...view, onSelectFileSite, onAddFileSite };
  }

  it('lists each site with its protocol, address and the chips that matter', () => {
    renderFiles({
      fileSites: [
        fileSite(),
        fileSite({
          id: 'fs-2',
          label: 'Old host',
          protocol: 'ftp',
          connection: {
            ...(fileSite().connection as Extract<
              ReturnType<typeof fileSite>['connection'],
              { kind: 'custom' }
            >),
            host: 'ftp.example',
            port: 21,
          },
          needsReview: { reason: 'conflicts', message: 'x', at: 1 },
        }),
      ],
    });

    const group = screen.getByRole('list', { name: 'FTP and SFTP sites' });
    const [first, second] = within(group).getAllByRole('button');
    expect(within(first).getByText('Bakery static')).toBeTruthy();
    expect(within(first).getByText('deploy@files.example:/var/www/site')).toBeTruthy();
    expect(within(first).getByText('SFTP')).toBeTruthy();
    expect(within(first).getByText('Never deployed')).toBeTruthy();
    expect(within(first).queryByText('Not encrypted')).toBeNull();
    expect(within(first).queryByText('Needs review')).toBeNull();

    expect(within(second).getByText('FTP')).toBeTruthy();
    expect(within(second).getByText('Not encrypted')).toBeTruthy();
    expect(within(second).getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('FTP and SFTP sites')).toBeTruthy();
  });

  it('shows how many changes wait, from the snapshot already in the cache', async () => {
    const { queryClient } = renderFiles({ fileSites: [fileSite()] });
    const row = within(screen.getByRole('list', { name: 'FTP and SFTP sites' })).getByRole(
      'button',
    );
    expect(within(row).queryByText(/to deploy/)).toBeNull();

    queryClient.setQueryData(queryKeys.deployFilesChanges('fs-1'), snapshot());
    expect(await within(row).findByText('3 to deploy')).toBeTruthy();
  });

  it('names a saved server by its nickname', () => {
    renderFiles({
      fileSites: [fileSite({ connection: { kind: 'saved', sshServerId: 'srv-1' } })],
    });
    expect(screen.getByText('Production:/var/www/site')).toBeTruthy();
  });

  it('selects a site, marks it, and offers to add one', async () => {
    const { user, onSelectFileSite, onAddFileSite } = renderFiles({
      fileSites: [fileSite()],
      selectedId: null,
      selectedFileSiteId: 'fs-1',
    });

    const row = within(screen.getByRole('list', { name: 'FTP and SFTP sites' })).getByRole(
      'button',
    );
    expect(row.getAttribute('aria-current')).toBe('true');
    await user.click(row);
    expect(onSelectFileSite).toHaveBeenCalledWith('fs-1');
    await user.click(screen.getByRole('button', { name: /Add an FTP or SFTP site/ }));
    expect(onAddFileSite).toHaveBeenCalled();
  });

  it('shimmers while the sites load and says why they did not', async () => {
    const { container, unmount } = renderFiles({ fileSites: undefined, fileSitesLoading: true });
    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(0);
    unmount();

    const onRetryFileSites = vi.fn();
    const { user } = renderFiles({ fileSitesError: 'disk is gone', onRetryFileSites });
    expect(screen.getByRole('alert').textContent).toContain(
      'The FTP and SFTP sites did not load: disk is gone',
    );
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetryFileSites).toHaveBeenCalled();
  });

  it('shows no FTP and SFTP group when the page passes none', () => {
    renderRail();
    expect(screen.queryByText('FTP and SFTP sites')).toBeNull();
  });
});
