import type { IStreamResult } from '@microsoft/signalr';
import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerList,
  ContainerLogBatch,
  ContainerLogLine,
  ContainerSummary,
  DockerDiskUsage,
  DockerPruneResult,
  DockerStatus,
  ImageInfo,
  JobInfo,
  NetworkInfo,
  RegistryAuth,
  VolumeInfo,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployContainerActionInput,
  DeployContainerRemoveInput,
  DeployDockerInstallInput,
  DeployDockerPruneInput,
  DeployImagePullInput,
  DeployImageRemoveInput,
  DeployLogTailInput,
  DeployRevealEnvInput,
  DeployVolumeRemoveInput,
} from '../../shared/deployDockerTypes';
import { ADMIN_ROLES, type CoreCallDeps, callCore } from './coreCalls';

/**
 * The Containers screen's calls (E06), on each server's lasting connection. Arguments arrive
 * checked by the IPC layer; the core checks them again, along with the role each call needs.
 * Revealing a container's environment values needs an Admin and a step-up, which the call makes
 * on the way when it is handed the password or a code.
 */

const DEFAULT_TAIL = 200;
/**
 * A core from before the build cache could be pruned cannot read that target, and SignalR says
 * only this much about it.
 */
const UNREADABLE_ARGUMENTS = /due to an error on the server/i;
/** A log tail that has not finished by then is cut short with what came. */
const TAIL_WAIT_MS = 15_000;

export interface DeployDockerDeps extends CoreCallDeps {
  /**
   * This computer's sign-in for an image's registry (E08), sent with that one pull. The engine
   * gets it in the request's X-Registry-Auth header, so it never lands on the server's disk.
   */
  registryAuth?: (reference: string) => Promise<RegistryAuth | null>;
  /** A container or volume was removed, so the file manager's sessions on it can end (E27). */
  removed?: (serverId: string, kind: 'container' | 'volume', idOrName: string) => void;
}

export class DeployDocker {
  constructor(private readonly deps: DeployDockerDeps) {}

  status(serverId: string): Promise<DockerStatus> {
    return this.run(serverId, (hub) => hub.getDockerStatus());
  }

  install(input: DeployDockerInstallInput): Promise<JobInfo> {
    return this.run(input.serverId, (hub) =>
      hub.installDocker({ removeConflictingPackages: input.removeConflictingPackages }),
    );
  }

  listContainers(serverId: string): Promise<ContainerList> {
    return this.run(serverId, (hub) => hub.listContainers());
  }

  inspect(serverId: string, containerId: string): Promise<ContainerDetails> {
    return this.run(serverId, (hub) => hub.inspectContainer(containerId));
  }

  revealEnv(input: DeployRevealEnvInput): Promise<ContainerEnvVariable[]> {
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return hub.revealContainerEnv(input.containerId);
      },
      // An Operator would pass a step-up and still be refused: only Admins are asked for one.
      { stepUpFor: ADMIN_ROLES },
    );
  }

  act(input: DeployContainerActionInput): Promise<ContainerSummary> {
    const { containerId } = input;
    return this.run(input.serverId, (hub) => {
      switch (input.action) {
        case 'start':
          return hub.startContainer(containerId);
        case 'stop':
          return hub.stopContainer(containerId, input.timeoutSeconds);
        case 'restart':
          return hub.restartContainer(containerId, input.timeoutSeconds);
        case 'pause':
          return hub.pauseContainer(containerId);
        case 'unpause':
          return hub.unpauseContainer(containerId);
        case 'kill':
          return hub.killContainer(containerId, input.signal ?? 'SIGKILL');
      }
    });
  }

  async remove(input: DeployContainerRemoveInput): Promise<void> {
    await this.run(input.serverId, (hub) =>
      hub.removeContainer({
        containerId: input.containerId,
        removeVolumes: input.removeVolumes,
        force: input.force,
      }),
    );
    this.deps.removed?.(input.serverId, 'container', input.containerId);
  }

  /** The last lines of a container's log, collected once rather than followed. */
  logTail(input: DeployLogTailInput): Promise<ContainerLogLine[]> {
    return this.run(input.serverId, (hub) =>
      collect(
        hub.streamContainerLogs({
          containerId: input.containerId,
          tail: input.tail ?? DEFAULT_TAIL,
          follow: false,
        }),
      ),
    );
  }

  listImages(serverId: string): Promise<ImageInfo[]> {
    return this.run(serverId, (hub) => hub.listImages());
  }

  async pullImage(input: DeployImagePullInput): Promise<JobInfo> {
    const auth = (await this.deps.registryAuth?.(input.reference)) ?? null;
    return this.run(input.serverId, (hub) =>
      hub.pullImage(auth ? { reference: input.reference, auth } : { reference: input.reference }),
    );
  }

  removeImage(input: DeployImageRemoveInput): Promise<void> {
    return this.run(input.serverId, (hub) =>
      hub.removeImage({ image: input.image, force: input.force }),
    );
  }

  listVolumes(serverId: string): Promise<VolumeInfo[]> {
    return this.run(serverId, (hub) => hub.listVolumes());
  }

  async removeVolume(input: DeployVolumeRemoveInput): Promise<void> {
    await this.run(input.serverId, (hub) => hub.removeVolume(input.volume, input.force));
    this.deps.removed?.(input.serverId, 'volume', input.volume);
  }

  listNetworks(serverId: string): Promise<NetworkInfo[]> {
    return this.run(serverId, (hub) => hub.listNetworks());
  }

  removeNetwork(serverId: string, network: string): Promise<void> {
    return this.run(serverId, (hub) => hub.removeNetwork(network));
  }

  diskUsage(serverId: string): Promise<DockerDiskUsage> {
    return this.run(serverId, (hub) => hub.getDockerDiskUsage());
  }

  async prune(input: DeployDockerPruneInput): Promise<DockerPruneResult> {
    try {
      return await this.run(input.serverId, (hub) =>
        hub.pruneDocker({
          target: input.target,
          allImages: input.allImages ?? false,
          includeVolumes: input.includeVolumes ?? false,
        }),
      );
    } catch (error) {
      if (
        input.target === 'buildCache' &&
        error instanceof Error &&
        UNREADABLE_ARGUMENTS.test(error.message)
      ) {
        throw new Error(
          'This server runs an older core that cannot clear the build cache. Update the core from the Overview, then try again.',
        );
      }
      throw error;
    }
  }

  private run<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    return callCore(this.deps, serverId, work);
  }
}

/** Every line of a log stream that ends by itself, or what came before the wait ran out. */
function collect(stream: IStreamResult<ContainerLogBatch>): Promise<ContainerLogLine[]> {
  return new Promise((resolve, reject) => {
    const lines: ContainerLogLine[] = [];
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(lines);
    }, TAIL_WAIT_MS);
    const subscription = stream.subscribe({
      next: (batch) => {
        lines.push(...batch.lines);
      },
      complete: () => {
        clearTimeout(timer);
        resolve(lines);
      },
      error: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}
