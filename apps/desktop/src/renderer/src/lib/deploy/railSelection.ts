import type { FileSite } from '@shared/deployFilesTypes';
import type { DeployServer } from '@shared/deployTypes';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';

/**
 * What the Deploy page shows, read from its address (E23): `?cloudflare=1` the Cloudflare page,
 * `?recaptcha=1` the reCAPTCHA page (E40), `?files=` an FTP or SFTP site, `?site=` a WordPress
 * site and `?server=` a server, in that order.
 * A link to something that is gone falls back to the first server, and with no servers to the
 * first site of either kind.
 */

export type RailSelection =
  | { kind: 'cloudflare' }
  | { kind: 'recaptcha' }
  | { kind: 'files'; site: FileSite }
  | { kind: 'wordpress'; site: DeployWordPressSite }
  | { kind: 'server'; server: DeployServer }
  | { kind: 'none' };

/** The part of `URLSearchParams` this reads, so a test or a caller can pass either. */
export interface ParamReader {
  get(name: string): string | null;
}

/**
 * Whether the address asks for the Cloudflare page. Cloudflare used to open as a dialog over the
 * page, so an older `?dialog=cloudflare` link still lands there.
 */
export function isCloudflare(params: ParamReader): boolean {
  return params.get('cloudflare') !== null || params.get('dialog') === 'cloudflare';
}

export function isRecaptcha(params: ParamReader): boolean {
  return params.get('recaptcha') !== null;
}

/** The pages that belong to an account rather than to one server or site. */
function isAccountPage(params: ParamReader): boolean {
  return isCloudflare(params) || isRecaptcha(params);
}

export function resolveSelection(
  params: ParamReader,
  servers: readonly DeployServer[],
  wpSites: readonly DeployWordPressSite[],
  fileSites: readonly FileSite[],
): RailSelection {
  if (isCloudflare(params)) return { kind: 'cloudflare' };
  if (isRecaptcha(params)) return { kind: 'recaptcha' };
  const fileSite = fileSites.find((site) => site.id === params.get('files'));
  if (fileSite) return { kind: 'files', site: fileSite };
  const wpSite = wpSites.find((site) => site.id === params.get('site'));
  if (wpSite) return { kind: 'wordpress', site: wpSite };
  const server = servers.find((one) => one.id === params.get('server')) ?? servers[0];
  if (server) return { kind: 'server', server };
  if (wpSites[0]) return { kind: 'wordpress', site: wpSites[0] };
  if (fileSites[0]) return { kind: 'files', site: fileSites[0] };
  return { kind: 'none' };
}

/**
 * Whether the page should keep shimmering. It waits for a list the address names, and, with no
 * servers to fall back on, for the sites, rather than flash a server (and start its health
 * checks) or the empty state. The Cloudflare and reCAPTCHA pages need only the servers: the rail
 * draws the sites' loading in their own groups.
 */
export function waitForRail(
  params: ParamReader,
  pending: { servers: boolean; wpSites: boolean; fileSites: boolean },
  counts: { servers: number; wpSites: number },
): boolean {
  if (pending.servers) return true;
  if (isAccountPage(params)) return false;
  if (pending.wpSites && (params.get('site') !== null || counts.servers === 0)) return true;
  return (
    pending.fileSites &&
    (params.get('files') !== null || (counts.servers === 0 && counts.wpSites === 0))
  );
}
