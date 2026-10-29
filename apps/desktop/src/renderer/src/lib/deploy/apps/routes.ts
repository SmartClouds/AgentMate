import type {
  SiteInfo,
  StackPortBinding,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { bindingAddress } from './format';

/**
 * The route map's view of Websites: which domains already lead to a published port, and whether
 * nginx can put one on a domain. nginx reaches a port on 127.0.0.1, so only TCP ports that listen
 * there (or on every address) can sit behind a site.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The port on the server, or null when it is not one fixed number (unset or a range). */
export function publishedPort(binding: Pick<StackPortBinding, 'published'>): number | null {
  const published = binding.published?.trim() ?? '';
  if (!/^\d{1,5}$/.test(published)) return null;
  const port = Number(published);
  return port >= 1 && port <= 65_535 ? port : null;
}

function forwardsTo(site: SiteInfo, port: number): boolean {
  const upstream = site.settings.upstream;
  if (upstream.kind === 'servicePort') return upstream.port === port;
  if (upstream.kind !== 'url' || !upstream.address) return false;
  try {
    const url = new URL(upstream.address);
    const urlPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return LOOPBACK_HOSTS.has(url.hostname) && urlPort === port;
  } catch {
    return false;
  }
}

/** Every domain of the sites that forward to this port, in the order Websites lists them. */
export function domainsForPort(sites: readonly SiteInfo[], port: number): string[] {
  return sites.filter((site) => forwardsTo(site, port)).flatMap((site) => site.settings.domains);
}

/** Why this port cannot be put on a domain, or null when it can. */
export function proxyBlockReason(binding: StackPortBinding): string | null {
  if (binding.protocol.toLowerCase() === 'udp') {
    return 'Websites forward HTTP, which runs over TCP. A UDP port needs a TCP or UDP proxy in Websites.';
  }
  if (publishedPort(binding) === null) {
    return 'This port has no fixed port on the server for nginx to forward to.';
  }
  const address = bindingAddress(binding);
  if (address !== 'This server only' && address !== 'Every address') {
    return `It listens on ${address} only, and nginx forwards to 127.0.0.1.`;
  }
  return null;
}
