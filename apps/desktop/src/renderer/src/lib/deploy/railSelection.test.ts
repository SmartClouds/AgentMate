import type { DeployServer } from '@shared/deployTypes';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { describe, expect, it } from 'vitest';
import { fileSite } from '@/components/deploy/files/testing/fixtures';
import { wpSite } from '@/components/deploy/wordpress/testing/fixtures';
import { resolveSelection, waitForRail } from './railSelection';

/**
 * What the Deploy page shows, read from its address: `?files=` for an FTP or SFTP site, `?site=`
 * for a WordPress site, `?server=` for a server. A link to something that is gone falls back to
 * the first server, and with no servers to the first site of either kind.
 */

const SERVER = { id: 'srv-1', nickname: 'Production' } as DeployServer;
const SERVER_2 = { id: 'srv-2', nickname: 'Staging' } as DeployServer;
const WP: DeployWordPressSite = wpSite({ id: 'wp-1' });
const WP_2: DeployWordPressSite = wpSite({ id: 'wp-2' });
const FILES = fileSite({ id: 'fs-1' });
const FILES_2 = fileSite({ id: 'fs-2' });

function params(query = ''): URLSearchParams {
  return new URLSearchParams(query);
}

describe('resolveSelection', () => {
  it('opens the FTP or SFTP site the address names', () => {
    expect(resolveSelection(params('files=fs-2'), [SERVER], [WP], [FILES, FILES_2])).toEqual({
      kind: 'files',
      site: FILES_2,
    });
  });

  it('prefers the FTP or SFTP site over a WordPress site or a server named alongside it', () => {
    expect(
      resolveSelection(params('files=fs-1&site=wp-1&server=srv-1'), [SERVER], [WP], [FILES]),
    ).toEqual({ kind: 'files', site: FILES });
  });

  it('opens the WordPress site the address names', () => {
    expect(resolveSelection(params('site=wp-2'), [SERVER], [WP, WP_2], [FILES])).toEqual({
      kind: 'wordpress',
      site: WP_2,
    });
  });

  it('opens the server the address names', () => {
    expect(resolveSelection(params('server=srv-2'), [SERVER, SERVER_2], [WP], [FILES])).toEqual({
      kind: 'server',
      server: SERVER_2,
    });
  });

  it('falls back to the first server when nothing, or something gone, is named', () => {
    const first = { kind: 'server', server: SERVER };
    expect(resolveSelection(params(), [SERVER, SERVER_2], [WP], [FILES])).toEqual(first);
    expect(resolveSelection(params('files=gone'), [SERVER], [WP], [FILES])).toEqual(first);
    expect(resolveSelection(params('site=gone'), [SERVER], [WP], [FILES])).toEqual(first);
    expect(resolveSelection(params('server=gone'), [SERVER], [], [])).toEqual(first);
  });

  it('falls back to the first WordPress site, then the first FTP or SFTP site, with no servers', () => {
    expect(resolveSelection(params(), [], [WP, WP_2], [FILES])).toEqual({
      kind: 'wordpress',
      site: WP,
    });
    expect(resolveSelection(params('files=gone'), [], [], [FILES, FILES_2])).toEqual({
      kind: 'files',
      site: FILES,
    });
  });

  it('has nothing to show when every list is empty', () => {
    expect(resolveSelection(params('server=srv-1'), [], [], [])).toEqual({ kind: 'none' });
  });
});

describe('waitForRail', () => {
  const settled = { servers: false, wpSites: false, fileSites: false };

  it('waits for the servers first', () => {
    expect(waitForRail(params(), { ...settled, servers: true }, { servers: 0, wpSites: 0 })).toBe(
      true,
    );
  });

  it('waits for the WordPress sites when one is named or there are no servers', () => {
    const pending = { ...settled, wpSites: true };
    expect(waitForRail(params('site=wp-1'), pending, { servers: 2, wpSites: 0 })).toBe(true);
    expect(waitForRail(params(), pending, { servers: 0, wpSites: 0 })).toBe(true);
    expect(waitForRail(params(), pending, { servers: 2, wpSites: 0 })).toBe(false);
  });

  it('waits for the FTP and SFTP sites when one is named or there is nothing else', () => {
    const pending = { ...settled, fileSites: true };
    expect(waitForRail(params('files=fs-1'), pending, { servers: 2, wpSites: 1 })).toBe(true);
    expect(waitForRail(params(), pending, { servers: 0, wpSites: 0 })).toBe(true);
    expect(waitForRail(params(), pending, { servers: 0, wpSites: 1 })).toBe(false);
    expect(waitForRail(params(), pending, { servers: 1, wpSites: 0 })).toBe(false);
  });

  it('shows the page once everything it needs is in', () => {
    expect(waitForRail(params('files=fs-1&site=wp-1'), settled, { servers: 0, wpSites: 0 })).toBe(
      false,
    );
  });
});
