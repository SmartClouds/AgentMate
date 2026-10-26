import type {
  ContainerLogLine,
  ContainerStatsBatch,
  DockerEvent,
  DockerPruneTarget,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Plain data the Containers screen (E06) passes between the main process and the renderer.
 * Environment values only ever travel in the answer to an Admin's reveal, after a step-up.
 */

/** What the lifecycle buttons do to a container. */
export type DeployContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill';

export interface DeployContainerActionInput {
  serverId: string;
  containerId: string;
  action: DeployContainerAction;
  /** For stop and restart: seconds to wait before the engine kills it, 0 to 600. */
  timeoutSeconds?: number;
  /** For kill: SIGKILL unless another well-known signal is named. */
  signal?: string;
}

export interface DeployContainerRemoveInput {
  serverId: string;
  containerId: string;
  /** Its anonymous volumes go too. Admins only, and the app asks for the name typed out. */
  removeVolumes: boolean;
  force: boolean;
}

/** Needs an Admin and a step-up; the password (or a code) can come along in the call. */
export interface DeployRevealEnvInput {
  serverId: string;
  containerId: string;
  password?: string;
  totpCode?: string;
}

export interface DeployDockerInstallInput {
  serverId: string;
  /** Agreement to remove podman, buildah and runc first, when the server has them. */
  removeConflictingPackages: boolean;
}

export interface DeployImagePullInput {
  serverId: string;
  reference: string;
}

export interface DeployImageRemoveInput {
  serverId: string;
  image: string;
  force: boolean;
}

export interface DeployVolumeRemoveInput {
  serverId: string;
  volume: string;
  force: boolean;
}

export interface DeployDockerPruneInput {
  serverId: string;
  target: DockerPruneTarget;
  allImages?: boolean;
  includeVolumes?: boolean;
}

/** The last lines of a container's log, once (for a prompt, say), not followed. */
export interface DeployLogTailInput {
  serverId: string;
  containerId: string;
  /** 1 to 5000; 200 when left out. */
  tail?: number;
}

/**
 * Stats batches for one subscription, oldest first: every running container's figures every two
 * seconds. The first event can carry the last couple of minutes, for a window that joins late.
 */
export interface DeployContainerStatsEvent {
  subscriptionId: string;
  serverId: string;
  batches: ContainerStatsBatch[];
  /** The stream failed (Docker is down, say); it is being tried again. */
  error?: string;
}

/** A container's log: the last `tail` lines (or those after `sinceUnixMs`), then new ones. */
export interface DeployContainerLogsWatchInput {
  serverId: string;
  containerId: string;
  /** 0 to 5000; 200 when left out. */
  tail?: number;
  sinceUnixMs?: number;
  follow: boolean;
}

/**
 * New lines of a container's log (already redacted by the core). The last event carries
 * `ended`: the log is over (the container stopped, or it was not followed), or the core refused.
 */
export interface DeployContainerLogsEvent {
  subscriptionId: string;
  serverId: string;
  containerId: string;
  lines: ContainerLogLine[];
  ended?: { error?: string };
}

/** Engine events as they happen, oldest first. */
export interface DeployDockerEventsEvent {
  subscriptionId: string;
  serverId: string;
  events: DockerEvent[];
}

/** Opens a terminal in a running container (Admins only). */
export interface DeployConsoleOpenInput {
  serverId: string;
  containerId: string;
  columns: number;
  rows: number;
  /** The program to run; the container's bash or sh when left out. */
  command?: string[];
  user?: string;
}

/**
 * What a console prints. `restarted` marks the first output of a new shell, after the
 * connection to the core changed under the old one. The last event carries `ended`.
 */
export interface DeployConsoleEvent {
  subscriptionId: string;
  serverId: string;
  data?: string;
  restarted?: boolean;
  ended?: { exitCode?: number; error?: string };
}
