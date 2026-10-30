import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerState,
  ContainerSummary,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The arithmetic behind a server's Cleanup section: what Docker keeps that nothing uses, how a
 * list of it is narrowed, and the order a removal goes in so that each step frees the next (a
 * stopped container holds its image, and a container holds its network and volumes).
 */

export type CleanupKind = 'image' | 'container' | 'volume' | 'network';

/** The order the groups are shown in. */
export const CLEANUP_KINDS: readonly CleanupKind[] = ['image', 'container', 'volume', 'network'];

const REMOVAL_ORDER: readonly CleanupKind[] = ['container', 'image', 'network', 'volume'];

export interface CleanupItem {
  /** Unique across kinds, for the selection. */
  key: string;
  kind: CleanupKind;
  /** What the remove call takes: an image or container id, a volume or network name. */
  id: string;
  name: string;
  /** A container's status line, an image's other tags. */
  detail?: string;
  sizeBytes?: number;
  createdAtUnixMs?: number;
  project?: string;
  /** An image with no tag left, usually an old build's layer. */
  dangling?: boolean;
}

export interface CleanupSources {
  images?: readonly ImageInfo[];
  containers?: readonly ContainerSummary[];
  volumes?: readonly VolumeInfo[];
  networks?: readonly NetworkInfo[];
}

/** States where a container is doing nothing and can go without stopping anything. */
const IDLE: ReadonlySet<ContainerState> = new Set(['exited', 'dead', 'created']);

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function biggestThenOldest(a: CleanupItem, b: CleanupItem): number {
  return (
    (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
    (a.createdAtUnixMs ?? Number.MAX_SAFE_INTEGER) - (b.createdAtUnixMs ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Everything that nothing uses, grouped by kind in the order the page shows them. */
export function cleanupCandidates(sources: CleanupSources): CleanupItem[] {
  const images: CleanupItem[] = (sources.images ?? [])
    .filter((image) => image.containers === 0)
    .map((image) => ({
      key: `image:${image.id}`,
      kind: 'image',
      id: image.id,
      name: image.tags[0] ?? shortId(image.id),
      detail: image.tags.length > 1 ? image.tags.slice(1).join(', ') : undefined,
      sizeBytes: image.sizeBytes,
      createdAtUnixMs: image.createdAtUnixMs,
      dangling: image.tags.length === 0,
    }));
  const containers: CleanupItem[] = (sources.containers ?? [])
    .filter((container) => IDLE.has(container.state))
    .map((container) => ({
      key: `container:${container.id}`,
      kind: 'container',
      id: container.id,
      name: container.name,
      detail: container.status,
      createdAtUnixMs: container.createdAtUnixMs,
      project: container.composeProject,
    }));
  const volumes: CleanupItem[] = (sources.volumes ?? [])
    .filter((volume) => volume.containers === 0)
    .map((volume) => ({
      key: `volume:${volume.name}`,
      kind: 'volume',
      id: volume.name,
      name: volume.name,
      sizeBytes: volume.sizeBytes,
      createdAtUnixMs: volume.createdAtUnixMs,
      project: volume.composeProject,
    }));
  const networks: CleanupItem[] = (sources.networks ?? [])
    .filter((network) => !network.builtIn && network.containers === 0)
    .map((network) => ({
      key: `network:${network.name}`,
      kind: 'network',
      id: network.name,
      name: network.name,
      detail: network.driver,
      project: network.composeProject,
    }));
  const byKind: Record<CleanupKind, CleanupItem[]> = {
    image: images,
    container: containers,
    volume: volumes,
    network: networks,
  };
  return CLEANUP_KINDS.flatMap((kind) => byKind[kind].sort(biggestThenOldest));
}

export type AgeFilter = 'any' | '7d' | '30d' | '90d';

export const AGE_FILTERS: ReadonlyArray<{ value: AgeFilter; label: string; days: number }> = [
  { value: 'any', label: 'Any age', days: 0 },
  { value: '7d', label: 'Over a week', days: 7 },
  { value: '30d', label: 'Over a month', days: 30 },
  { value: '90d', label: 'Over 3 months', days: 90 },
];

const DAY_MS = 86_400_000;

export interface CleanupFilter {
  kind: CleanupKind | 'all';
  age: AgeFilter;
  query: string;
}

/** What is left after the kind, age and search filters. An item without a date has no age. */
export function filterItems(
  items: readonly CleanupItem[],
  filter: CleanupFilter,
  now: number,
): CleanupItem[] {
  const days = AGE_FILTERS.find((one) => one.value === filter.age)?.days ?? 0;
  const needle = filter.query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.kind === 'all' || item.kind === filter.kind) &&
      (days === 0 ||
        (item.createdAtUnixMs !== undefined && now - item.createdAtUnixMs >= days * DAY_MS)) &&
      (needle === '' ||
        [item.name, item.detail ?? '', item.project ?? ''].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
}

export interface SelectionSummary {
  count: number;
  /** What the selection frees, as far as Docker reports sizes. */
  bytes: number;
  hasVolumes: boolean;
}

export function selectionSummary(
  items: readonly CleanupItem[],
  selected: ReadonlySet<string>,
): SelectionSummary {
  const picked = items.filter((item) => selected.has(item.key));
  return {
    count: picked.length,
    bytes: picked.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    hasVolumes: picked.some((item) => item.kind === 'volume'),
  };
}

/** Same rules as the Containers tabs: volumes hold data, so only Admins remove them. */
export function canRemove(
  kind: CleanupKind,
  roles: { canOperate: boolean; canAdmin: boolean },
): boolean {
  return kind === 'volume' ? roles.canAdmin : roles.canOperate;
}

export interface CleanupApi {
  removeContainer: (id: string) => Promise<unknown>;
  removeImage: (id: string) => Promise<unknown>;
  removeNetwork: (name: string) => Promise<unknown>;
  removeVolume: (name: string) => Promise<unknown>;
}

export interface CleanupStep {
  item: CleanupItem;
  state: 'removing' | 'removed' | 'failed';
  message?: string;
  /** Items finished so far, this one included once it is done. */
  done: number;
  total: number;
}

export interface CleanupOutcome {
  removed: CleanupItem[];
  freedBytes: number;
  failed: Array<{ item: CleanupItem; message: string }>;
}

/** Removes the items one at a time and carries on past a refusal, so one stuck item costs nothing else. */
export async function runCleanup(
  items: readonly CleanupItem[],
  api: CleanupApi,
  onStep?: (step: CleanupStep) => void,
): Promise<CleanupOutcome> {
  const ordered = [...items].sort(
    (a, b) => REMOVAL_ORDER.indexOf(a.kind) - REMOVAL_ORDER.indexOf(b.kind),
  );
  const remove: Record<CleanupKind, (id: string) => Promise<unknown>> = {
    container: api.removeContainer,
    image: api.removeImage,
    network: api.removeNetwork,
    volume: api.removeVolume,
  };
  const outcome: CleanupOutcome = { removed: [], freedBytes: 0, failed: [] };
  const total = ordered.length;
  for (const [index, item] of ordered.entries()) {
    onStep?.({ item, state: 'removing', done: index, total });
    try {
      await remove[item.kind](item.id);
      outcome.removed.push(item);
      outcome.freedBytes += item.sizeBytes ?? 0;
      onStep?.({ item, state: 'removed', done: index + 1, total });
    } catch (error) {
      const message = coreErrorMessage(error);
      outcome.failed.push({ item, message });
      onStep?.({ item, state: 'failed', message, done: index + 1, total });
    }
  }
  return outcome;
}
