import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type {
  ExposureInventory,
  FirewallChangePreview,
  FirewallChangeSetInfo,
  FirewallPreset,
  FirewallStatus,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployFirewallApplyInput,
  DeployFirewallChangesInput,
  DeployFirewallDecisionInput,
  DeployFirewallHistoryInput,
  DeployFirewallOperation,
  DeployFirewallProgressEvent,
  DeployFirewallStep,
} from '../../shared/deployFirewallTypes';
import { hubMessage } from './connection/hubErrors';
import type { CoreLinks } from './live/coreLinks';

/**
 * The host firewall (E13) with safe apply. Reads ride the server's lasting connection. A change
 * set is applied over that connection too, with `$SSH_CONNECTION` read on the SSH connection
 * under it so the core's lockout guard knows which address and port to keep open. The core then
 * waits for a confirmation, which only counts over a brand-new SSH connection (a new login, not
 * only a new tunnel on the pooled one): that is what shows a new login still gets in. If the
 * confirmation fails or never comes, the core's timer puts the old rules back by itself. Each
 * step is reported to the renderer as it happens.
 */

/** What SignalR says when an authorization policy refused a hub method. */
const UNAUTHORIZED = /because user is unauthorized/;
/** How the core's firewall words a missing step-up (a HubException, not a policy refusal). */
const STEP_UP = /\(a step-up\)/;

export interface DeployFirewallDeps {
  links: Pick<CoreLinks, 'call'>;
  service: {
    onLinkConnection: <T>(
      serverId: string,
      work: (sshConnection: string | undefined) => Promise<T>,
    ) => Promise<T>;
    withFreshHub: <T>(
      serverId: string,
      work: (hub: ICoreHub) => Promise<T>,
      step?: (step: 'signingIn') => void,
    ) => Promise<T>;
  };
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
  progress: (event: DeployFirewallProgressEvent) => void;
  now?: () => number;
}

type Report = (
  step: DeployFirewallStep,
  state: DeployFirewallProgressEvent['state'],
  extra?: { changeSetId?: string; message?: string },
) => void;

export class DeployFirewall {
  private readonly now: () => number;

  constructor(private readonly deps: DeployFirewallDeps) {
    this.now = deps.now ?? Date.now;
  }

  status(serverId: string): Promise<FirewallStatus> {
    return this.read(serverId, (hub) => hub.getFirewallStatus());
  }

  presets(serverId: string): Promise<FirewallPreset[]> {
    return this.read(serverId, (hub) => hub.getFirewallPresets());
  }

  history(input: DeployFirewallHistoryInput): Promise<FirewallChangeSetInfo[]> {
    return this.read(input.serverId, (hub) =>
      hub.listFirewallChangeSets(input.limit === undefined ? {} : { limit: input.limit }),
    );
  }

  exposure(serverId: string): Promise<ExposureInventory> {
    return this.read(serverId, (hub) => hub.getExposure());
  }

  /** The exact commands and the guard's verdict, judged for this connection. Changes nothing. */
  async preview(input: DeployFirewallChangesInput): Promise<FirewallChangePreview> {
    try {
      return await this.deps.service.onLinkConnection(input.serverId, (sshConnection) =>
        this.deps.links.call(input.serverId, (hub) =>
          hub.previewFirewallChanges({
            changes: input.changes,
            ...(sshConnection ? { sshConnection } : {}),
          }),
        ),
      );
    } catch (error) {
      throw this.explain(input.serverId, error);
    }
  }

  /** Applies over the lasting connection; the change then waits for `confirm` or rolls back. */
  async apply(input: DeployFirewallApplyInput): Promise<FirewallChangeSetInfo> {
    const report = this.reporter(input.serverId, 'apply');
    let step = 'readingConnection' as DeployFirewallStep;
    report(step, 'running');
    try {
      return await this.deps.service.onLinkConnection(input.serverId, async (sshConnection) => {
        report('readingConnection', 'done');
        step = 'applying';
        report(step, 'running');
        const change = await this.deps.links.call(input.serverId, async (hub) => {
          if (input.password || input.totpCode) {
            await hub.stepUp({
              ...(input.password ? { password: input.password } : {}),
              ...(input.totpCode ? { totpCode: input.totpCode } : {}),
            });
          }
          return hub.applyFirewallChanges({
            changes: input.changes,
            ...(sshConnection ? { sshConnection } : {}),
            ...(input.overrideConfirmation
              ? { overrideConfirmation: input.overrideConfirmation }
              : {}),
          });
        });
        report('applying', 'done', { changeSetId: change.id });
        return change;
      });
    } catch (error) {
      const explained = this.explain(input.serverId, error);
      report(step, 'failed', { message: explained.message });
      throw explained;
    }
  }

  /**
   * Keeps a change, over a new SSH connection and a new tunnel through it. When that fails the
   * change is left alone: the core's timer rolls it back at its deadline.
   */
  async confirm(input: DeployFirewallDecisionInput): Promise<FirewallChangeSetInfo> {
    const report = this.reporter(input.serverId, 'confirm');
    const changeSetId = input.changeSetId;
    // Moved on inside the callbacks, which TypeScript does not follow.
    let step = 'openingConnection' as DeployFirewallStep;
    report(step, 'running', { changeSetId });
    try {
      const change = await this.deps.service.withFreshHub(
        input.serverId,
        (hub) => {
          report('signingIn', 'done', { changeSetId });
          step = 'confirming';
          report(step, 'running', { changeSetId });
          return hub.confirmFirewallChanges(changeSetId);
        },
        () => {
          report('openingConnection', 'done', { changeSetId });
          step = 'signingIn';
          report(step, 'running', { changeSetId });
        },
      );
      report('confirming', 'done', { changeSetId });
      return change;
    } catch (error) {
      const explained = this.explain(input.serverId, error);
      const message =
        step === 'confirming'
          ? explained.message
          : `A new SSH connection could not get in (${explained.message}). The change rolls back by itself at its deadline.`;
      report(step, 'failed', { changeSetId, message });
      throw coreErrorCode(explained) ? explained : new Error(message);
    }
  }

  /** Puts the saved rules back now, over the lasting connection. */
  async revert(input: DeployFirewallDecisionInput): Promise<FirewallChangeSetInfo> {
    const report = this.reporter(input.serverId, 'revert');
    const changeSetId = input.changeSetId;
    report('reverting', 'running', { changeSetId });
    try {
      const change = await this.deps.links.call(input.serverId, (hub) =>
        hub.revertFirewallChanges(changeSetId),
      );
      report('reverting', 'done', { changeSetId });
      return change;
    } catch (error) {
      const explained = this.explain(input.serverId, error);
      report('reverting', 'failed', { changeSetId, message: explained.message });
      throw explained;
    }
  }

  private reporter(serverId: string, operation: DeployFirewallOperation): Report {
    return (step, state, extra = {}) =>
      this.deps.progress({ serverId, operation, step, state, ...extra, atUnixMs: this.now() });
  }

  private async read<T>(serverId: string, work: (hub: ICoreHub) => Promise<T>): Promise<T> {
    try {
      return await this.deps.links.call(serverId, work);
    } catch (error) {
      throw this.explain(serverId, error);
    }
  }

  private explain(serverId: string, error: unknown): Error {
    // The connection's own refusals (a sign-in, a new enrollment) already carry their code.
    if (coreErrorCode(error) && error instanceof Error) return error;
    const message = hubMessage(error);
    if (STEP_UP.test(message)) return new Error(encodeCoreError('stepUpRequired', message));
    if (!UNAUTHORIZED.test(message)) return new Error(message);
    const roles = this.deps.roles(serverId);
    const which = roles && roles.length > 0 ? ` (${roles.join(', ')})` : '';
    return new Error(
      encodeCoreError(
        'forbidden',
        `Your role on this server${which} cannot do that in the Firewall section.`,
      ),
    );
  }
}
