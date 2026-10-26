import type { DirectTlsStatus } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployDirectTlsEnableInput,
  DeployDirectTlsInfo,
  DeployDirectTlsPin,
} from '../../../shared/deployDirectTlsTypes';
import type { DeployState } from '../state';
import { explainCoreRefusal } from '../system';

/**
 * Direct TLS (E16) from the app's side: what the core says about it, read over SSH only, and the
 * pin this computer keeps. The pin is taken on the first read and when the user turns the mode on
 * or accepts a new one; a pin that changed on its own is reported, never taken quietly, and the
 * link refuses direct TLS until the user decides. The firewall rule for the port is a change set
 * the renderer applies through the Firewall section's own calls, with its countdown.
 */

export interface DeployDirectTlsDeps {
  service: {
    /** A hub call that never rides direct TLS itself. */
    withSshHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
    directTlsChanged: (serverId: string) => void;
    directTlsHost: (serverId: string) => Promise<string>;
  };
  state: Pick<DeployState, 'directTls' | 'setDirectTls'>;
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
  now?: () => number;
}

export class DeployDirectTls {
  private readonly now: () => number;

  constructor(private readonly deps: DeployDirectTlsDeps) {
    this.now = deps.now ?? Date.now;
  }

  async status(serverId: string): Promise<DeployDirectTlsInfo> {
    const status = await this.call(serverId, false, (hub) => hub.getDirectTls());
    return this.settle(serverId, status, false);
  }

  /** Opens the port on the core and pins its key, then has the link try it. */
  async enable(input: DeployDirectTlsEnableInput): Promise<DeployDirectTlsInfo> {
    const status = await this.call(input.serverId, true, async (hub) => {
      if (input.password || input.totpCode) {
        await hub.stepUp({
          ...(input.password ? { password: input.password } : {}),
          ...(input.totpCode ? { totpCode: input.totpCode } : {}),
        });
      }
      return hub.enableDirectTls({ port: input.port, sources: input.sources });
    });
    return this.settle(input.serverId, status, true);
  }

  /**
   * Closes the port. This computer stops trying it first, so the link is never left waiting on
   * a port that is going away.
   */
  async disable(serverId: string): Promise<DeployDirectTlsInfo> {
    const pinned = await this.deps.state.directTls(serverId);
    if (pinned?.enabled) {
      await this.deps.state.setDirectTls(serverId, { ...pinned, enabled: false });
      this.deps.service.directTlsChanged(serverId);
    }
    const status = await this.call(serverId, false, (hub) => hub.disableDirectTls());
    return this.settle(serverId, status, false);
  }

  /** Takes the key the core presents now, read over SSH, after a pin mismatch the user expected. */
  async acceptPin(serverId: string): Promise<DeployDirectTlsInfo> {
    const status = await this.call(serverId, false, (hub) => hub.getDirectTls());
    return this.settle(serverId, status, true);
  }

  private async settle(
    serverId: string,
    status: DirectTlsStatus,
    accept: boolean,
  ): Promise<DeployDirectTlsInfo> {
    const pinned = await this.deps.state.directTls(serverId);
    const pinChanged = pinned !== null && pinned.pin !== status.pin;
    let kept: DeployDirectTlsPin | null = pinned;
    if (pinned === null || accept || !pinChanged) {
      kept = {
        enabled: status.enabled,
        port: status.port,
        pin: status.pin,
        pinnedAt: pinned && !pinChanged ? pinned.pinnedAt : this.now(),
      };
      const same =
        pinned !== null &&
        pinned.enabled === kept.enabled &&
        pinned.port === kept.port &&
        pinned.pin === kept.pin;
      if (!same) {
        await this.deps.state.setDirectTls(serverId, kept);
        this.deps.service.directTlsChanged(serverId);
      }
    }
    return {
      status,
      pinned: kept,
      pinChanged: pinChanged && !accept,
      host: await this.deps.service.directTlsHost(serverId),
    };
  }

  private async call<T>(
    serverId: string,
    stepUp: boolean,
    work: (hub: ICoreHub) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.deps.service.withSshHub(serverId, work);
    } catch (error) {
      const roles = this.deps.roles(serverId);
      throw explainCoreRefusal(error, roles, stepUp && (!roles || roles.includes('owner')));
    }
  }
}
