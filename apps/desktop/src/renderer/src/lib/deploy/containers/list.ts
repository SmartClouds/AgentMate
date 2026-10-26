import type {
  ContainerGroup,
  ContainerHealth,
  ContainerList,
  ContainerPort,
  ContainerState,
  ContainerSummary,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Containers list as rows of one height (E06 T8): a header per compose project (and one for
 * containers outside any project), then its containers, so a long list can be drawn a screenful
 * at a time. A search narrows it by name, image, project, service or port; a folded project shows
 * its header alone.
 */

export const STANDALONE = 'Not in a compose project';

export type ContainerRow =
  | {
      kind: 'group';
      key: string;
      project: string | null;
      total: number;
      running: number;
      shown: number;
      folded: boolean;
    }
  | { kind: 'container'; key: string; container: ContainerSummary; project: string | null };

export function groupKey(group: Pick<ContainerGroup, 'project'>): string {
  return group.project ? `project:${group.project}` : 'standalone';
}

export const STATE_LABEL: Record<ContainerState, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  removing: 'Removing',
  exited: 'Exited',
  dead: 'Dead',
  unknown: 'Unknown',
};

export type StateTone = 'good' | 'busy' | 'idle' | 'bad';

export function stateTone(container: Pick<ContainerSummary, 'state' | 'health'>): StateTone {
  if (container.state === 'running') return container.health === 'unhealthy' ? 'bad' : 'good';
  if (container.state === 'restarting' || container.state === 'removing') return 'busy';
  if (container.state === 'dead') return 'bad';
  return 'idle';
}

export const HEALTH_LABEL: Record<ContainerHealth, string | null> = {
  none: null,
  starting: 'Starting',
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
};

/** "127.0.0.1:8080 -> 80/tcp" for a published port, "3000/tcp" for one only the network sees. */
export function portText(port: ContainerPort): string {
  const inside = `${port.privatePort}/${port.protocol}`;
  if (!port.hostPort) return inside;
  const host = port.hostIp ? (port.hostIp.includes(':') ? `[${port.hostIp}]` : port.hostIp) : '';
  return `${host ? `${host}:` : ''}${port.hostPort} -> ${inside}`;
}

/** Published on every address, so anyone who can reach the server reaches the container. */
export function isPublic(port: ContainerPort): boolean {
  return (
    port.hostPort !== undefined &&
    (port.hostIp === '0.0.0.0' || port.hostIp === '::' || !port.hostIp)
  );
}

/** One line per published mapping; Docker lists IPv4 and IPv6 separately for the same port. */
export function portsText(ports: readonly ContainerPort[]): string[] {
  return [...new Set(ports.map(portText))];
}

export function matches(container: ContainerSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    container.name,
    container.image,
    container.composeProject ?? '',
    container.composeService ?? '',
    STATE_LABEL[container.state],
    ...portsText(container.ports),
  ].some((value) => value.toLowerCase().includes(needle));
}

export function allContainers(list: ContainerList | undefined): ContainerSummary[] {
  return (list?.groups ?? []).flatMap((group) => group.containers);
}

export function containerRows(
  list: ContainerList,
  options: { query?: string; folded?: ReadonlySet<string> } = {},
): ContainerRow[] {
  const rows: ContainerRow[] = [];
  const query = options.query ?? '';
  for (const group of list.groups) {
    const key = groupKey(group);
    const shown = group.containers
      .filter((container) => matches(container, query))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (query && shown.length === 0) continue;
    const folded = !query && (options.folded?.has(key) ?? false);
    rows.push({
      kind: 'group',
      key,
      project: group.project ?? null,
      total: group.containers.length,
      running: group.containers.filter((container) => container.state === 'running').length,
      shown: shown.length,
      folded,
    });
    if (folded) continue;
    for (const container of shown) {
      rows.push({
        kind: 'container',
        key: container.id,
        container,
        project: group.project ?? null,
      });
    }
  }
  return rows;
}

/** Folds or unfolds a project, as a new set. */
export function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
