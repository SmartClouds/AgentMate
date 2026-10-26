import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type {
  AlertInfo,
  AlertQuery,
  JobInfo,
  JobPage,
  JobQuery,
  ManagedService,
  MetricsHistory,
  MetricsHistoryRequest,
  ServiceInfo,
  SystemInfo,
  UpdatesInfo,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { DeployStepUpInput } from '../../shared/deployTypes';
import { hubMessage } from './connection/hubErrors';
import type { CoreLinks } from './live/coreLinks';

/**
 * The Overview's calls (E05), on each server's lasting connection: reading the server, and the
 * jobs behind its buttons. Upgrading every package and rebooting need a step-up, which these
 * calls make on the way when they are handed the password or a code. The core turns down a
 * missing step-up and a missing role with the same words, so a refusal is told apart here by
 * the signed-in user's roles: the renderer learns whether to ask for the password or not.
 */

/** What SignalR says when an authorization policy refused a hub method. */
const UNAUTHORIZED = /because user is unauthorized/;
const CAN_STEP_UP = new Set(['owner', 'admin', 'operator']);

export interface DeploySystemDeps {
  links: Pick<CoreLinks, 'call'>;
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
}

export class DeploySystem {
  constructor(private readonly deps: DeploySystemDeps) {}

  info(serverId: string): Promise<SystemInfo> {
    return this.run(serverId, (hub) => hub.getSystemInfo());
  }

  services(serverId: string): Promise<ServiceInfo[]> {
    return this.run(serverId, (hub) => hub.listServices());
  }

  metricsHistory(serverId: string, request: MetricsHistoryRequest): Promise<MetricsHistory> {
    return this.run(serverId, (hub) => hub.getMetricsHistory(request));
  }

  updates(serverId: string): Promise<UpdatesInfo> {
    return this.run(serverId, (hub) => hub.getUpdates());
  }

  checkUpdates(serverId: string): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.checkForUpdates());
  }

  upgradeSecurity(serverId: string): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.upgradeSecurityPackages());
  }

  upgradeAll(input: DeployStepUpInput): Promise<JobInfo> {
    return this.withStepUp(input, (hub) => hub.upgradeAllPackages());
  }

  reboot(input: DeployStepUpInput): Promise<JobInfo> {
    return this.withStepUp(input, (hub) => hub.rebootServer());
  }

  setAutomaticUpdates(serverId: string, enabled: boolean): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.setAutomaticSecurityUpdates(enabled));
  }

  restartService(serverId: string, service: ManagedService): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.restartService(service));
  }

  jobs(serverId: string, query: JobQuery): Promise<JobPage> {
    return this.run(serverId, (hub) => hub.listJobs(query));
  }

  job(serverId: string, jobId: string): Promise<JobInfo> {
    return this.run(serverId, (hub) => hub.getJob(jobId));
  }

  cancelJob(serverId: string, jobId: string): Promise<void> {
    return this.run(serverId, (hub) => hub.cancelJob(jobId));
  }

  alerts(serverId: string, query: AlertQuery): Promise<AlertInfo[]> {
    return this.run(serverId, (hub) => hub.listAlerts(query));
  }

  acknowledgeAlert(serverId: string, alertId: number): Promise<AlertInfo> {
    return this.run(serverId, (hub) => hub.acknowledgeAlert(alertId));
  }

  private withStepUp(
    input: DeployStepUpInput,
    work: (hub: ICoreHub) => Promise<JobInfo>,
  ): Promise<JobInfo> {
    return this.run(
      input.serverId,
      async (hub) => {
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return work(hub);
      },
      { stepUp: true },
    );
  }

  private async run<T>(
    serverId: string,
    work: (hub: ICoreHub) => Promise<T>,
    options: { stepUp?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.deps.links.call(serverId, work);
    } catch (error) {
      throw this.explain(serverId, error, options.stepUp ?? false);
    }
  }

  private explain(serverId: string, error: unknown, needsStepUp: boolean): Error {
    return explainCoreRefusal(error, this.deps.roles(serverId), needsStepUp);
  }
}

/**
 * A hub call's error as the renderer should see it. The connection's own refusals already carry
 * their code; a refused policy becomes `[core:stepUpRequired]` when a step-up could help (the
 * caller's role would pass) and `[core:forbidden]` otherwise. The Apps (stacks.ts) use it too.
 */
export function explainCoreRefusal(
  error: unknown,
  roles: string[] | null,
  needsStepUp: boolean,
): Error {
  if (coreErrorCode(error) && error instanceof Error) return error;
  if (!UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) {
    return new Error(hubMessage(error));
  }
  if (needsStepUp && (!roles || roles.some((role) => CAN_STEP_UP.has(role)))) {
    return new Error(
      encodeCoreError(
        'stepUpRequired',
        'Confirm your password (or a code from your authenticator app) to do this.',
      ),
    );
  }
  const which = roles && roles.length > 0 ? ` (${roles.join(', ')})` : '';
  return new Error(
    encodeCoreError('forbidden', `Your role on this server${which} cannot do that.`),
  );
}
