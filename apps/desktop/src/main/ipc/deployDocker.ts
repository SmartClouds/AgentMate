import type { IpcMainInvokeEvent } from 'electron';
import type { DockerPruneTarget } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployConsoleOpenInput,
  DeployContainerAction,
  DeployContainerActionInput,
  DeployContainerLogsWatchInput,
  DeployContainerRemoveInput,
  DeployDockerInstallInput,
  DeployDockerPruneInput,
  DeployImagePullInput,
  DeployImageRemoveInput,
  DeployLogTailInput,
  DeployRevealEnvInput,
  DeployVolumeRemoveInput,
} from '../../shared/deployDockerTypes';
import { EXEC_USER, IMAGE_ID, isImageReference, OBJECT_NAME } from '../../shared/dockerNames';
import { IPC } from '../../shared/ipcChannels';
import type { DeployDocker } from '../deploy/docker';
import type { DockerSubscriptions } from '../deploy/live/dockerSubscriptions';
import type { SubscriptionOwner } from '../deploy/live/subscriptions';
import { type DeployIpcRegistry, object, serverId, stepUpInput } from './deploy';

/**
 * The Containers screen's channels (E06), `deployDocker`. Like every Deploy group they answer
 * only the main window, and every argument is checked here against the same rules the core uses
 * (container, volume and network names, image references, users, signals and sizes), so nothing
 * malformed travels to a server. Live subscriptions belong to the window that opened them.
 */

export interface DeployDockerHandlerDeps {
  ipc: DeployIpcRegistry;
  docker: DeployDocker;
  subscriptions: Pick<
    DockerSubscriptions,
    | 'watchStats'
    | 'watchEvents'
    | 'watchLogs'
    | 'openConsole'
    | 'consoleInput'
    | 'consoleResize'
    | 'unwatch'
  >;
  /** True only for the main window's own frame. */
  guard: (event: IpcMainInvokeEvent) => boolean;
  /** The window behind a call, as the owner of what it subscribes to. */
  owner: (event: IpcMainInvokeEvent) => SubscriptionOwner;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNALS: ReadonlySet<string> = new Set([
  'SIGKILL',
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
]);
const ACTIONS: ReadonlySet<string> = new Set<DeployContainerAction>([
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'kill',
]);
const PRUNE_TARGETS: ReadonlySet<string> = new Set<DockerPruneTarget>([
  'containers',
  'images',
  'volumes',
  'networks',
  'system',
]);
const TAIL = { min: 0, max: 5_000 };
const SIZE = { min: 1, max: 1_000 };
const TIMEOUT = { min: 0, max: 600 };
const NON_NEGATIVE = { min: 0, max: Number.MAX_SAFE_INTEGER };
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT = 4_096;
/** One message of keystrokes (a paste, at most); the console sends what is typed as it comes. */
const MAX_INPUT = 64 * 1024;

function guid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !GUID.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

function whole(value: unknown, range: { min: number; max: number }, what: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < range.min ||
    (value as number) > range.max
  ) {
    throw new Error(`The ${what} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return value as number;
}

function optionalWhole(
  value: unknown,
  range: { min: number; max: number },
  what: string,
): number | undefined {
  return value === undefined || value === null ? undefined : whole(value, range, what);
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Say yes or no for ${what}.`);
  return value;
}

function optionalFlag(value: unknown, what: string): boolean | undefined {
  return value === undefined || value === null ? undefined : flag(value, what);
}

function named(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 128 || !OBJECT_NAME.test(value)) {
    throw new Error(`That is not a ${what} id or name.`);
  }
  return value;
}

function image(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !(IMAGE_ID.test(value) || isImageReference(value))
  ) {
    throw new Error('That is not an image id or reference.');
  }
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || !isImageReference(value)) {
    throw new Error('That is not an image reference (such as nginx:1.29 or ghcr.io/org/app:1.0).');
  }
  return value;
}

function containerAction(value: unknown): DeployContainerActionInput {
  const input = object(value, 'a container action');
  if (typeof input.action !== 'string' || !ACTIONS.has(input.action)) {
    throw new Error('Start, stop, restart, pause, unpause or kill a container.');
  }
  const action = input.action as DeployContainerAction;
  const result: DeployContainerActionInput = {
    serverId: serverId(input.serverId),
    containerId: named(input.containerId, 'container'),
    action,
  };
  if (action === 'stop' || action === 'restart') {
    const timeout = optionalWhole(input.timeoutSeconds, TIMEOUT, 'stop timeout in seconds');
    if (timeout !== undefined) result.timeoutSeconds = timeout;
  }
  if (action === 'kill' && input.signal !== undefined && input.signal !== null) {
    if (typeof input.signal !== 'string' || !SIGNALS.has(input.signal)) {
      throw new Error('Send SIGKILL, SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1 or SIGUSR2.');
    }
    result.signal = input.signal;
  }
  return result;
}

function removeInput(value: unknown): DeployContainerRemoveInput {
  const input = object(value, 'a container to remove');
  return {
    serverId: serverId(input.serverId),
    containerId: named(input.containerId, 'container'),
    removeVolumes: flag(input.removeVolumes, 'removing its volumes'),
    force: optionalFlag(input.force, 'removing it while it runs') ?? false,
  };
}

function revealInput(value: unknown): DeployRevealEnvInput {
  const input = object(value, 'a container');
  return { ...stepUpInput(value), containerId: named(input.containerId, 'container') };
}

function installInput(value: unknown): DeployDockerInstallInput {
  const input = object(value, 'install options');
  return {
    serverId: serverId(input.serverId),
    removeConflictingPackages: flag(
      input.removeConflictingPackages,
      'removing the packages in the way',
    ),
  };
}

function logTail(value: unknown): DeployLogTailInput {
  const input = object(value, 'a log to read');
  const tail = optionalWhole(input.tail, { min: 1, max: TAIL.max }, 'number of lines');
  return {
    serverId: serverId(input.serverId),
    containerId: named(input.containerId, 'container'),
    ...(tail === undefined ? {} : { tail }),
  };
}

function logsWatch(value: unknown): DeployContainerLogsWatchInput {
  const input = object(value, 'a log subscription');
  const tail = optionalWhole(input.tail, TAIL, 'number of lines');
  const sinceUnixMs = optionalWhole(input.sinceUnixMs, NON_NEGATIVE, 'start time');
  return {
    serverId: serverId(input.serverId),
    containerId: named(input.containerId, 'container'),
    follow: flag(input.follow, 'following the log'),
    ...(tail === undefined ? {} : { tail }),
    ...(sinceUnixMs === undefined ? {} : { sinceUnixMs }),
  };
}

function command(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ARGUMENTS ||
    typeof value[0] !== 'string' ||
    value[0].length === 0 ||
    !value.every(
      (argument) =>
        typeof argument === 'string' && argument.length <= MAX_ARGUMENT && !argument.includes('\0'),
    )
  ) {
    throw new Error('A console command is a program and at most 31 arguments.');
  }
  return value as string[];
}

function consoleOpen(value: unknown): DeployConsoleOpenInput {
  const input = object(value, 'a console');
  const program = command(input.command);
  let user: string | undefined;
  if (input.user !== undefined && input.user !== null && input.user !== '') {
    if (typeof input.user !== 'string' || input.user.length > 64 || !EXEC_USER.test(input.user)) {
      throw new Error('That is not a user name or id (such as root, node or 1000:1000).');
    }
    user = input.user;
  }
  return {
    serverId: serverId(input.serverId),
    containerId: named(input.containerId, 'container'),
    columns: whole(input.columns, SIZE, 'number of columns'),
    rows: whole(input.rows, SIZE, 'number of rows'),
    ...(program ? { command: program } : {}),
    ...(user ? { user } : {}),
  };
}

function keystrokes(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_INPUT) {
    throw new Error('Console input must be text.');
  }
  return value;
}

function imageRemove(value: unknown): DeployImageRemoveInput {
  const input = object(value, 'an image to remove');
  return {
    serverId: serverId(input.serverId),
    image: image(input.image),
    force: optionalFlag(input.force, 'removing it while it is used') ?? false,
  };
}

function imagePull(value: unknown): DeployImagePullInput {
  const input = object(value, 'an image to pull');
  return { serverId: serverId(input.serverId), reference: reference(input.reference) };
}

function volumeRemove(value: unknown): DeployVolumeRemoveInput {
  const input = object(value, 'a volume to remove');
  return {
    serverId: serverId(input.serverId),
    volume: named(input.volume, 'volume'),
    force: optionalFlag(input.force, 'removing it while it is used') ?? false,
  };
}

function pruneInput(value: unknown): DeployDockerPruneInput {
  const input = object(value, 'what to prune');
  if (typeof input.target !== 'string' || !PRUNE_TARGETS.has(input.target)) {
    throw new Error('Prune containers, images, volumes, networks or the whole system.');
  }
  return {
    serverId: serverId(input.serverId),
    target: input.target as DockerPruneTarget,
    allImages: optionalFlag(input.allImages, 'every unused image') ?? false,
    includeVolumes: optionalFlag(input.includeVolumes, 'unused volumes') ?? false,
  };
}

export function registerDeployDockerHandlers(deps: DeployDockerHandlerDeps): void {
  const { ipc, docker, subscriptions } = deps;
  const handle = (
    channel: string,
    run: (owner: () => SubscriptionOwner, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(() => deps.owner(event), ...args);
    });
  };

  handle(IPC.deployDocker.status, (_owner, id) => docker.status(serverId(id)));
  handle(IPC.deployDocker.install, (_owner, value) => docker.install(installInput(value)));
  handle(IPC.deployDocker.listContainers, (_owner, id) => docker.listContainers(serverId(id)));
  handle(IPC.deployDocker.inspect, (_owner, id, container) =>
    docker.inspect(serverId(id), named(container, 'container')),
  );
  handle(IPC.deployDocker.revealEnv, (_owner, value) => docker.revealEnv(revealInput(value)));
  handle(IPC.deployDocker.act, (_owner, value) => docker.act(containerAction(value)));
  handle(IPC.deployDocker.remove, (_owner, value) => docker.remove(removeInput(value)));
  handle(IPC.deployDocker.logTail, (_owner, value) => docker.logTail(logTail(value)));
  handle(IPC.deployDocker.listImages, (_owner, id) => docker.listImages(serverId(id)));
  handle(IPC.deployDocker.pullImage, (_owner, value) => docker.pullImage(imagePull(value)));
  handle(IPC.deployDocker.removeImage, (_owner, value) => docker.removeImage(imageRemove(value)));
  handle(IPC.deployDocker.listVolumes, (_owner, id) => docker.listVolumes(serverId(id)));
  handle(IPC.deployDocker.removeVolume, (_owner, value) =>
    docker.removeVolume(volumeRemove(value)),
  );
  handle(IPC.deployDocker.listNetworks, (_owner, id) => docker.listNetworks(serverId(id)));
  handle(IPC.deployDocker.removeNetwork, (_owner, id, network) =>
    docker.removeNetwork(serverId(id), named(network, 'network')),
  );
  handle(IPC.deployDocker.diskUsage, (_owner, id) => docker.diskUsage(serverId(id)));
  handle(IPC.deployDocker.prune, (_owner, value) => docker.prune(pruneInput(value)));

  handle(IPC.deployDocker.watchStats, (owner, id) =>
    subscriptions.watchStats(owner(), serverId(id)),
  );
  handle(IPC.deployDocker.unwatchStats, (owner, id) =>
    subscriptions.unwatch(owner(), 'stats', guid(id, 'subscription')),
  );
  handle(IPC.deployDocker.watchLogs, (owner, value) =>
    subscriptions.watchLogs(owner(), logsWatch(value)),
  );
  handle(IPC.deployDocker.unwatchLogs, (owner, id) =>
    subscriptions.unwatch(owner(), 'logs', guid(id, 'subscription')),
  );
  handle(IPC.deployDocker.watchEvents, (owner, id) =>
    subscriptions.watchEvents(owner(), serverId(id)),
  );
  handle(IPC.deployDocker.unwatchEvents, (owner, id) =>
    subscriptions.unwatch(owner(), 'events', guid(id, 'subscription')),
  );
  handle(IPC.deployDocker.openConsole, (owner, value) =>
    subscriptions.openConsole(owner(), consoleOpen(value)),
  );
  handle(IPC.deployDocker.consoleInput, (owner, id, data) =>
    subscriptions.consoleInput(owner(), guid(id, 'console'), keystrokes(data)),
  );
  handle(IPC.deployDocker.consoleResize, (owner, id, columns, rows) =>
    subscriptions.consoleResize(
      owner(),
      guid(id, 'console'),
      whole(columns, SIZE, 'number of columns'),
      whole(rows, SIZE, 'number of rows'),
    ),
  );
  handle(IPC.deployDocker.closeConsole, (owner, id) =>
    subscriptions.unwatch(owner(), 'console', guid(id, 'console')),
  );
}
