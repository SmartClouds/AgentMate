import type { StoredSshServer } from '../../../shared/apiTypes';
import type { PendingServerRestore } from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployMovedRecord } from '../../../shared/deployServerBackupsTypes';
import type { StoredHealthTarget } from '../../health/store';
import type { StoredFileSite } from '../files/types';
import type { StoredWpSite } from '../wordpress/state';

/**
 * A restore onto a new server moves what named the old address (E28). The core moves its own
 * settings (firewall rules, sites, Cloudflare DNS, the direct TLS certificate, stack files); this
 * moves this computer's: saved servers other than the one restored onto, health checks (E22), FTP
 * and SFTP sites (E23) and WordPress sites. A pinned host key or certificate goes with the move,
 * since the new server has keys of its own, and the next connection asks to trust it again.
 */

export interface AddressRecordPorts {
  sshServers: {
    list: () => Promise<StoredSshServer[]>;
    save: (servers: StoredSshServer[]) => Promise<void>;
  };
  healthTargets: {
    mutate: <T>(change: (targets: StoredHealthTarget[]) => T) => Promise<T>;
    changed: (ids: string[]) => void;
  };
  fileSites: { mutate: <T>(change: (sites: StoredFileSite[]) => T) => Promise<T> };
  /** Null while the WordPress store is not up yet. */
  wordpressSites: {
    list: () => Promise<StoredWpSite[]>;
    update: (id: string, change: (site: StoredWpSite) => StoredWpSite) => Promise<unknown>;
  } | null;
}

function bare(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

const v6 = (address: string) => address.includes(':');

/** Old address to new, each paired with a new address of the same family. */
export function addressMap(
  pending: Pick<PendingServerRestore, 'oldAddresses' | 'newAddresses'>,
  fallback: string,
): Map<string, string> {
  const fresh = pending.newAddresses.map(bare).filter(Boolean);
  const map = new Map<string, string>();
  for (const old of pending.oldAddresses.map(bare)) {
    if (!old || fresh.includes(old)) continue;
    const to = fresh.find((address) => v6(address) === v6(old)) ?? fresh[0] ?? fallback;
    if (to && bare(to) !== old) map.set(old, to);
  }
  return map;
}

function moved(host: string, map: Map<string, string>): string | null {
  return map.get(bare(host)) ?? null;
}

/** The URL with its host moved, or null when it named none of the old addresses. */
export function movedUrl(url: string, map: Map<string, string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const to = moved(parsed.hostname, map);
  if (!to) return null;
  parsed.hostname = v6(to) ? `[${to}]` : to;
  const next = parsed.toString();
  // URL adds a slash to a bare origin; keep the record as it was written.
  return !url.endsWith('/') && next.endsWith('/') && parsed.pathname === '/'
    ? next.slice(0, -1)
    : next;
}

export async function moveAddressRecords(
  ports: AddressRecordPorts,
  options: { targetServerId: string; map: Map<string, string> },
): Promise<DeployMovedRecord[]> {
  const { map, targetServerId } = options;
  const changes: DeployMovedRecord[] = [];
  if (map.size === 0) return changes;

  const servers = await ports.sshServers.list();
  let serversChanged = false;
  const nextServers = servers.map((server) => {
    if (server.id === targetServerId) return server;
    const to = moved(server.host, map);
    if (!to) return server;
    serversChanged = true;
    changes.push({
      area: 'server',
      name: server.nickname,
      from: server.host,
      to,
      trustReset: true,
    });
    const { hostKeyFingerprint: _dropped, ...rest } = server;
    return { ...rest, host: to };
  });
  if (serversChanged) await ports.sshServers.save(nextServers);

  const healthIds = await ports.healthTargets.mutate((targets) => {
    const ids: string[] = [];
    for (const target of targets) {
      const to = movedUrl(target.url, map);
      if (!to) continue;
      changes.push({ area: 'healthCheck', name: target.name, from: target.url, to });
      target.url = to;
      ids.push(target.id);
    }
    return ids;
  });
  if (healthIds.length > 0) ports.healthTargets.changed(healthIds);

  await ports.fileSites.mutate((sites) => {
    for (const site of sites) {
      if (site.connection.kind !== 'custom') continue;
      const to = moved(site.connection.host, map);
      if (!to) continue;
      changes.push({
        area: 'fileSite',
        name: site.label,
        from: site.connection.host,
        to,
        trustReset: true,
      });
      site.connection.host = to;
      site.connection.hostKeyFingerprint = null;
      site.connection.tlsPin = null;
    }
  });

  if (ports.wordpressSites) {
    for (const site of await ports.wordpressSites.list()) {
      const siteUrl = movedUrl(site.siteUrl, map);
      const restUrl = movedUrl(site.restUrl, map);
      const ajaxUrl = movedUrl(site.ajaxUrl, map);
      const rescueUrl = site.rescueUrl ? movedUrl(site.rescueUrl, map) : null;
      if (!siteUrl && !restUrl && !ajaxUrl && !rescueUrl) continue;
      changes.push({
        area: 'wordpressSite',
        name: site.label,
        from: site.siteUrl,
        to: siteUrl ?? site.siteUrl,
      });
      await ports.wordpressSites.update(site.id, (current) => ({
        ...current,
        siteUrl: siteUrl ?? current.siteUrl,
        restUrl: restUrl ?? current.restUrl,
        ajaxUrl: ajaxUrl ?? current.ajaxUrl,
        rescueUrl: rescueUrl ?? current.rescueUrl,
      }));
    }
  }
  return changes;
}
