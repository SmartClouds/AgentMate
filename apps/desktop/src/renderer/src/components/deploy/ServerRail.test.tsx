import type { DeployServer } from '@shared/deployTypes';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import {
  dragItemDown,
  mockStackedRows,
  reorderIds,
  settleDragClick,
} from '../../../../test/renderer/dragLayout';
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
  it('opens the Cloudflare page from its row', async () => {
    const { user, onOpenCloudflare } = renderRail();

    const row = screen.getByRole('button', { name: /Cloudflare: domains and DNS/ });
    expect(row.getAttribute('aria-current')).toBeNull();
    await user.click(row);
    expect(onOpenCloudflare).toHaveBeenCalledTimes(1);
  });

  it('marks its row while the Cloudflare page is on screen', () => {
    renderRail({ selectedId: null, cloudflareSelected: true });

    expect(
      screen
        .getByRole('button', { name: /Cloudflare: domains and DNS/ })
        .getAttribute('aria-current'),
    ).toBe('true');
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

    expect(screen.getByText('No servers shown.')).toBeTruthy();
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

  it('names a saved server by its nickname even when the rail does not list it', () => {
    renderFiles({
      servers: [],
      selectedId: null,
      allServers: [SERVER],
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

describe('ServerRail chosen servers', () => {
  const PRODUCTION = SERVER;
  const STAGING: DeployServer = { ...SERVER, id: 'srv-2', nickname: 'Staging' };
  const BACKUPS: DeployServer = { ...SERVER, id: 'srv-3', nickname: 'Backups' };

  beforeEach(() => mockStackedRows(40));
  afterEach(() => {
    vi.restoreAllMocks();
    settleDragClick();
  });

  function renderThree(props: Partial<Parameters<typeof ServerRail>[0]> = {}) {
    const onReorderServers = vi.fn();
    const view = renderRail({
      servers: [PRODUCTION, STAGING, BACKUPS],
      selectedId: null,
      onReorderServers,
      ...props,
    });
    return { ...view, onReorderServers };
  }

  it('lists the servers in the order the page gives them', () => {
    const { container } = renderThree({ servers: [BACKUPS, PRODUCTION, STAGING] });

    expect(reorderIds(container)).toEqual(['srv-3', 'srv-1', 'srv-2']);
  });

  it('offers to choose which servers are shown', async () => {
    const onChooseServers = vi.fn();
    const { user } = renderThree({ onChooseServers });

    await user.click(screen.getByRole('button', { name: /Choose servers to show/ }));
    expect(onChooseServers).toHaveBeenCalledTimes(1);
  });

  it('has no choosing row when the page offers none', () => {
    renderThree();

    expect(screen.queryByRole('button', { name: /Choose servers to show/ })).toBeNull();
  });

  it('saves the new order when a server is dragged down', () => {
    const { container, onReorderServers } = renderThree();

    dragItemDown(container, 'srv-1', 45);

    expect(onReorderServers).toHaveBeenCalledTimes(1);
    expect(onReorderServers).toHaveBeenCalledWith(['srv-2', 'srv-1', 'srv-3']);
  });

  it('does not save an order when a server is dropped where it was', () => {
    const { container, onReorderServers } = renderThree();

    dragItemDown(container, 'srv-2', 5);

    expect(onReorderServers).not.toHaveBeenCalled();
  });

  it('still selects a server on a plain click', async () => {
    const { user, onSelect, onReorderServers } = renderThree();

    await user.click(screen.getByRole('button', { name: /Staging/ }));

    expect(onSelect).toHaveBeenCalledWith('srv-2');
    expect(onReorderServers).not.toHaveBeenCalled();
  });

  it('leaves the order alone when the page cannot save one', () => {
    const { container } = renderThree({ onReorderServers: undefined });

    dragItemDown(container, 'srv-1', 85);

    expect(reorderIds(container)).toEqual(['srv-1', 'srv-2', 'srv-3']);
  });

  it('moves the focused server with Alt and the arrow keys', async () => {
    const { user, onReorderServers } = renderThree();

    screen.getByRole('button', { name: /Production/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onReorderServers).toHaveBeenLastCalledWith(['srv-2', 'srv-1', 'srv-3']);

    screen.getByRole('button', { name: /Backups/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onReorderServers).toHaveBeenLastCalledWith(['srv-1', 'srv-3', 'srv-2']);
  });

  /** Holds the animation frames the rail asks for, so a test decides when they run. */
  function holdFrames(): () => void {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    return () => {
      for (const frame of frames.splice(0)) frame(0);
    };
  }

  it('gives the keyboard back to the moved server when the move dropped it', async () => {
    const runFrames = holdFrames();
    const onReorderServers = vi.fn(() => (document.activeElement as HTMLElement).blur());
    const { user } = renderThree({ onReorderServers });

    const production = screen.getByRole('button', { name: /Production/ });
    production.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(document.activeElement).not.toBe(production);
    runFrames();

    expect(document.activeElement).toBe(production);
  });

  it('does not pull the keyboard back after it has gone to another server', async () => {
    const runFrames = holdFrames();
    const { user } = renderThree();

    screen.getByRole('button', { name: /Production/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    const backups = screen.getByRole('button', { name: /Backups/ });
    backups.focus();
    runFrames();

    expect(document.activeElement).toBe(backups);
  });

  it('does not move the first server up or the last one down', async () => {
    const { user, onReorderServers } = renderThree();

    screen.getByRole('button', { name: /Production/ }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    screen.getByRole('button', { name: /Backups/ }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(onReorderServers).not.toHaveBeenCalled();
  });

  it('leaves the arrow keys alone without Alt', async () => {
    const { user, onReorderServers } = renderThree();

    screen.getByRole('button', { name: /Production/ }).focus();
    await user.keyboard('{ArrowDown}');

    expect(onReorderServers).not.toHaveBeenCalled();
  });
});
