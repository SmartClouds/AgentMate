import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerList,
  ContainerLogLine,
  ContainerLogSource,
  ContainerRemoveRequest,
  ContainerState,
  ContainerStatsBatch,
  ContainerSummary,
  DockerDiskUsage,
  DockerEvent,
  DockerPruneRequest,
  DockerStatus,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from '../protocol/generated/Runova.ServerCore.Contracts';
import type { FakeCoreConnection } from './fakeCoreConnection';
import {
  containerStatsSample,
  logLine,
  type SeedContainer,
  sampleDiskUsage,
  sampleDockerStatus,
  sampleImages,
  sampleNetworks,
  sampleVolumes,
  seedContainers,
} from './fakeDockerData';

/**
 * The Docker Engine behind a `FakeCore` (E06): containers grouped by compose project, their logs,
 * moving stats and engine events, and the resources. Tests move it along by hand (`log`,
 * `stats`, `event`) and every open stream of every connection hears of it, with the cursors the
 * real core honours: log lines after `afterTimestamp`, events after `afterCursor`.
 */

export interface FakeContainer extends SeedContainer {
  logs: ContainerLogLine[];
}

/** One console a connection opened: what was typed and the sizes it was given. */
export interface FakeConsoleSession {
  containerId: string;
  typed: string[];
  sizes: Array<{ columns: number; rows: number }>;
  open: boolean;
}

interface Host {
  now(): number;
  readonly openConnections: FakeCoreConnection[];
}

export class FakeDocker {
  status: DockerStatus = sampleDockerStatus();
  readonly containers: FakeContainer[] = seedContainers().map((seed) => ({ ...seed, logs: [] }));
  images: ImageInfo[] = sampleImages();
  volumes: VolumeInfo[] = sampleVolumes();
  networks: NetworkInfo[] = sampleNetworks();
  diskUsage: DockerDiskUsage = sampleDiskUsage();
  readonly events: DockerEvent[] = [];
  readonly consoles: FakeConsoleSession[] = [];
  readonly removed: ContainerRemoveRequest[] = [];
  readonly pruned: DockerPruneRequest[] = [];
  private cursor = 0;
  private statsCount = 0;

  constructor(private readonly host: Host) {}

  /** By id, a 12-character (or longer) id prefix, or name, as the engine looks them up. */
  find(idOrName: string): FakeContainer | undefined {
    return this.containers.find(
      (container) =>
        container.summary.name === idOrName ||
        container.summary.id === idOrName ||
        (idOrName.length >= 12 && container.summary.id.startsWith(idOrName)),
    );
  }

  list(): ContainerList {
    const groups = new Map<string, ContainerSummary[]>();
    for (const container of this.containers) {
      const key = container.summary.composeProject ?? '';
      groups.set(key, [...(groups.get(key) ?? []), { ...container.summary }]);
    }
    return {
      groups: [...groups.entries()]
        .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
        .map(([project, containers]) =>
          project ? { project, containers, workingDirectory: `/srv/${project}` } : { containers },
        ),
    };
  }

  details(container: FakeContainer): ContainerDetails {
    return {
      ...structuredClone(container.details),
      summary: { ...container.summary },
      envKeys: container.env.map((variable) => variable.name),
    };
  }

  env(container: FakeContainer): ContainerEnvVariable[] {
    return container.env.map((variable) => ({ ...variable }));
  }

  /** A new log line, sent to every stream that follows the container's log. */
  log(idOrName: string, text: string, stream: ContainerLogSource = 'stdout'): ContainerLogLine {
    const container = this.require(idOrName);
    const last = container.logs.at(-1)?.atUnixMs ?? 0;
    const line = logLine(text, Math.max(this.host.now(), last + 1), stream);
    container.logs.push(line);
    for (const connection of this.host.openConnections) {
      connection.deliverContainerLog(container.summary.id, line);
    }
    return line;
  }

  /** The next reading of every running container, sent to every stats stream. */
  stats(): ContainerStatsBatch {
    const at = this.host.now();
    const n = this.statsCount;
    this.statsCount += 1;
    const batch: ContainerStatsBatch = {
      atUnixMs: at,
      samples: this.containers
        .filter((container) => container.summary.state === 'running')
        .map((container) => containerStatsSample(container.summary.id, at, n)),
      stopped: this.containers
        .filter((container) => container.summary.state !== 'running')
        .map((container) => container.summary.id),
    };
    for (const connection of this.host.openConnections) connection.deliverContainerStats(batch);
    return batch;
  }

  /** An engine event about a container, sent to every events stream. */
  event(action: string, idOrName: string, extra: Partial<DockerEvent> = {}): DockerEvent {
    const container = this.find(idOrName);
    this.cursor += 1;
    const event: DockerEvent = {
      type: 'container',
      action,
      actorId: container?.summary.id ?? idOrName,
      atUnixMs: this.host.now(),
      cursor: String(this.cursor),
      ...(container
        ? {
            name: container.summary.name,
            image: container.summary.image,
            ...(container.summary.composeProject
              ? {
                  composeProject: container.summary.composeProject,
                  composeService: container.summary.composeService,
                }
              : {}),
          }
        : {}),
      ...extra,
    };
    this.events.push(event);
    for (const connection of this.host.openConnections) connection.deliverDockerEvent(event);
    return event;
  }

  eventsAfter(afterCursor?: string): DockerEvent[] {
    if (afterCursor === undefined) return [];
    return this.events.filter((event) => Number(event.cursor) > Number(afterCursor));
  }

  /** Moves a container to a state, as a lifecycle call or the engine would, with its event. */
  setState(idOrName: string, state: ContainerState, action: string): ContainerSummary {
    const container = this.require(idOrName);
    container.summary = {
      ...container.summary,
      state,
      status: state === 'running' ? 'Up 1 second' : state === 'paused' ? 'Paused' : 'Exited (0)',
    };
    this.event(action, container.summary.id);
    return { ...container.summary };
  }

  remove(request: ContainerRemoveRequest): void {
    const container = this.require(request.containerId);
    if (container.summary.state === 'running' && !request.force) {
      throw new Error('You cannot remove a running container. Stop it first.');
    }
    this.containers.splice(this.containers.indexOf(container), 1);
    this.removed.push({ ...request });
    this.event('destroy', container.summary.id, {
      name: container.summary.name,
      image: container.summary.image,
    });
  }

  require(idOrName: string): FakeContainer {
    const container = this.find(idOrName);
    if (!container) throw new Error(`No such container: ${idOrName}`);
    return container;
  }
}
