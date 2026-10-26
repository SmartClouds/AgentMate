import { ipcRenderer } from 'electron';
import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerList,
  ContainerLogLine,
  ContainerSummary,
  DockerDiskUsage,
  DockerPruneResult,
  DockerStatus,
  ImageInfo,
  JobInfo,
  NetworkInfo,
  VolumeInfo,
} from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployConsoleEvent,
  DeployConsoleOpenInput,
  DeployContainerActionInput,
  DeployContainerLogsEvent,
  DeployContainerLogsWatchInput,
  DeployContainerRemoveInput,
  DeployContainerStatsEvent,
  DeployDockerEventsEvent,
  DeployDockerInstallInput,
  DeployDockerPruneInput,
  DeployImagePullInput,
  DeployImageRemoveInput,
  DeployLogTailInput,
  DeployRevealEnvInput,
  DeployVolumeRemoveInput,
} from '../shared/deployDockerTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * Docker on a server (E06), for the Containers screen. Lifecycle calls answer with the
 * container as it is afterwards; a missing role comes back as `[core:forbidden]`, a missing
 * step-up (for revealing environment values) as `[core:stepUpRequired]`.
 */
export function createDeployDocker(subscribe: Subscribe) {
  return {
    status: (serverId: string): Promise<DockerStatus> =>
      ipcRenderer.invoke(IPC.deployDocker.status, serverId),
    install: (input: DeployDockerInstallInput): Promise<JobInfo> =>
      ipcRenderer.invoke(IPC.deployDocker.install, input),
    listContainers: (serverId: string): Promise<ContainerList> =>
      ipcRenderer.invoke(IPC.deployDocker.listContainers, serverId),
    /** Environment variable names only; revealEnv has the values. */
    inspect: (serverId: string, containerId: string): Promise<ContainerDetails> =>
      ipcRenderer.invoke(IPC.deployDocker.inspect, serverId, containerId),
    revealEnv: (input: DeployRevealEnvInput): Promise<ContainerEnvVariable[]> =>
      ipcRenderer.invoke(IPC.deployDocker.revealEnv, input),
    act: (input: DeployContainerActionInput): Promise<ContainerSummary> =>
      ipcRenderer.invoke(IPC.deployDocker.act, input),
    remove: (input: DeployContainerRemoveInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployDocker.remove, input),
    logTail: (input: DeployLogTailInput): Promise<ContainerLogLine[]> =>
      ipcRenderer.invoke(IPC.deployDocker.logTail, input),
    listImages: (serverId: string): Promise<ImageInfo[]> =>
      ipcRenderer.invoke(IPC.deployDocker.listImages, serverId),
    /** A job: its log shows the layers as they arrive. */
    pullImage: (input: DeployImagePullInput): Promise<JobInfo> =>
      ipcRenderer.invoke(IPC.deployDocker.pullImage, input),
    removeImage: (input: DeployImageRemoveInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployDocker.removeImage, input),
    listVolumes: (serverId: string): Promise<VolumeInfo[]> =>
      ipcRenderer.invoke(IPC.deployDocker.listVolumes, serverId),
    removeVolume: (input: DeployVolumeRemoveInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployDocker.removeVolume, input),
    listNetworks: (serverId: string): Promise<NetworkInfo[]> =>
      ipcRenderer.invoke(IPC.deployDocker.listNetworks, serverId),
    removeNetwork: (serverId: string, network: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployDocker.removeNetwork, serverId, network),
    diskUsage: (serverId: string): Promise<DockerDiskUsage> =>
      ipcRenderer.invoke(IPC.deployDocker.diskUsage, serverId),
    prune: (input: DeployDockerPruneInput): Promise<DockerPruneResult> =>
      ipcRenderer.invoke(IPC.deployDocker.prune, input),
    /** Every running container's figures, shared by everyone watching the server. */
    watchStats: (serverId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.deployDocker.watchStats, serverId),
    unwatchStats: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.unwatchStats, subscriptionId),
    onStats: (cb: (event: DeployContainerStatsEvent) => void): (() => void) =>
      subscribe(IPC.deployDocker.onStats, cb),
    watchLogs: (input: DeployContainerLogsWatchInput): Promise<string> =>
      ipcRenderer.invoke(IPC.deployDocker.watchLogs, input),
    unwatchLogs: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.unwatchLogs, subscriptionId),
    onLogs: (cb: (event: DeployContainerLogsEvent) => void): (() => void) =>
      subscribe(IPC.deployDocker.onLogs, cb),
    watchEvents: (serverId: string): Promise<string> =>
      ipcRenderer.invoke(IPC.deployDocker.watchEvents, serverId),
    unwatchEvents: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.unwatchEvents, subscriptionId),
    onEvents: (cb: (event: DeployDockerEventsEvent) => void): (() => void) =>
      subscribe(IPC.deployDocker.onEvents, cb),
    openConsole: (input: DeployConsoleOpenInput): Promise<string> =>
      ipcRenderer.invoke(IPC.deployDocker.openConsole, input),
    consoleInput: (subscriptionId: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.consoleInput, subscriptionId, data),
    consoleResize: (subscriptionId: string, columns: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.consoleResize, subscriptionId, columns, rows),
    closeConsole: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployDocker.closeConsole, subscriptionId),
    onConsole: (cb: (event: DeployConsoleEvent) => void): (() => void) =>
      subscribe(IPC.deployDocker.onConsole, cb),
  };
}
