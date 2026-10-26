import type { SshAuthMethod } from '../../shared/apiTypes';
import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type {
  SecurityChecklist,
  SshHardeningChangeInfo,
  SshHardeningPreview,
  SshHardeningRequest,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeploySshDecisionInput,
  DeploySshHardeningInput,
  DeploySshOperation,
  DeploySshProgressEvent,
  DeploySshStep,
} from '../../shared/deployHardeningTypes';
import { hubMessage } from './connection/hubErrors';
import type { CoreLinks } from './live/coreLinks';

/**
 * The Security center's checklist and its SSH fixes (E15). The checklist rides the server's
 * lasting connection, with the core release this build installs so the core can say whether it is
 * behind. Turning SSH password login off can never lock the app out, because two guards have to
 * agree and the change undoes itself unless proven:
 *
 * 1. Here: the saved server must sign in with a key. With a saved password the change is refused
 *    before the core is asked, since the next login would fail.
 * 2. On the core: the preview and the apply go over a brand-new SSH connection this computer opens
 *    with its key alone, and the core reads in sshd's log how that very connection signed in. A
 *    password login is refused there too.
 *
 * The core then reloads sshd with a rollback timer armed; keeping the change takes yet another new
 * connection that signs in with the key under the new settings. If that fails or never comes, the
 * timer puts the old settings back by itself.
 */

/** What SignalR says when an authorization policy refused a hub method. */
const UNAUTHORIZED = /because user is unauthorized/;

export interface DeployHardeningDeps {
  links: Pick<CoreLinks, 'call'>;
  service: {
    withFreshHub: <T>(
      serverId: string,
      work: (hub: ICoreHub) => Promise<T>,
      step?: (step: 'signingIn') => void,
    ) => Promise<T>;
    /** The core release this build installs, or null when it has none. */
    availableCoreVersion: () => Promise<string | null>;
    /** How the app signs in to the server over SSH; null where there is no SSH (the DevHost). */
    loginMethod: (serverId: string) => Promise<SshAuthMethod | null>;
  };
  roles: (serverId: string) => string[] | null;
  progress: (event: DeploySshProgressEvent) => void;
  now?: () => number;
}

type Report = (
  step: DeploySshStep,
  state: DeploySshProgressEvent['state'],
  extra?: { changeId?: string; message?: string },
) => void;

export const PASSWORD_LOGIN_REFUSAL =
  'Runova signs in to this server with a password, so turning SSH passwords off would lock it out. Switch the saved server to key login in Remote first, then try again.';

export class DeployHardening {
  private readonly now: () => number;

  constructor(private readonly deps: DeployHardeningDeps) {
    this.now = deps.now ?? Date.now;
  }

  async checklist(serverId: string): Promise<SecurityChecklist> {
    const available = await this.deps.service.availableCoreVersion().catch(() => null);
    try {
      return await this.deps.links.call(serverId, (hub) =>
        hub.getSecurityChecklist(available ? { availableCoreVersion: available } : {}),
      );
    } catch (error) {
      throw this.explain(serverId, error);
    }
  }

  /** Over a new key login, so the core judges the connection the apply will come over. */
  async previewSsh(input: DeploySshHardeningInput): Promise<SshHardeningPreview> {
    try {
      const [method, preview] = await Promise.all([
        this.deps.service.loginMethod(input.serverId),
        this.deps.service.withFreshHub(input.serverId, (hub) =>
          hub.previewSshHardening(request(input)),
        ),
      ]);
      return method === 'password'
        ? { ...preview, allowed: false, notes: [PASSWORD_LOGIN_REFUSAL, ...preview.notes] }
        : preview;
    } catch (error) {
      throw this.explain(input.serverId, error);
    }
  }

  async applySsh(input: DeploySshHardeningInput): Promise<SshHardeningChangeInfo> {
    const report = this.reporter(input.serverId, 'apply');
    let step = 'checkingLogin' as DeploySshStep;
    report(step, 'running');
    try {
      if ((await this.deps.service.loginMethod(input.serverId)) === 'password') {
        throw new Error(PASSWORD_LOGIN_REFUSAL);
      }
      report('checkingLogin', 'done');
      step = 'openingConnection';
      report(step, 'running');
      const change = await this.deps.service.withFreshHub(input.serverId, (hub) => {
        report('openingConnection', 'done');
        step = 'applying';
        report(step, 'running');
        return hub.applySshHardening(request(input));
      });
      report('applying', 'done', { changeId: change.id });
      return change;
    } catch (error) {
      const explained = this.passThrough(error);
      report(step, 'failed', { message: explained.message });
      throw explained;
    }
  }

  /** Keeps the change, over yet another new connection that signs in with the key. */
  async confirmSsh(input: DeploySshDecisionInput): Promise<SshHardeningChangeInfo> {
    const report = this.reporter(input.serverId, 'confirm');
    const changeId = input.changeId;
    let step = 'openingConnection' as DeploySshStep;
    report(step, 'running', { changeId });
    try {
      const change = await this.deps.service.withFreshHub(input.serverId, (hub) => {
        report('openingConnection', 'done', { changeId });
        step = 'confirming';
        report(step, 'running', { changeId });
        return hub.confirmSshHardening(changeId);
      });
      report('confirming', 'done', { changeId });
      return change;
    } catch (error) {
      const explained = this.passThrough(error);
      const message =
        step === 'confirming'
          ? explained.message
          : `A new SSH connection could not sign in with the key (${explained.message}). The change rolls back by itself at its deadline.`;
      report(step, 'failed', { changeId, message });
      throw new Error(message);
    }
  }

  /** Puts the old settings back now, over the lasting connection: no proof is needed to undo. */
  async revertSsh(input: DeploySshDecisionInput): Promise<SshHardeningChangeInfo> {
    const report = this.reporter(input.serverId, 'revert');
    const changeId = input.changeId;
    report('reverting', 'running', { changeId });
    try {
      const change = await this.deps.links.call(input.serverId, (hub) =>
        hub.revertSshHardening(changeId),
      );
      report('reverting', 'done', { changeId });
      return change;
    } catch (error) {
      const explained = this.explain(input.serverId, error);
      report('reverting', 'failed', { changeId, message: explained.message });
      throw explained;
    }
  }

  private reporter(serverId: string, operation: DeploySshOperation): Report {
    return (step, state, extra = {}) =>
      this.deps.progress({ serverId, operation, step, state, ...extra, atUnixMs: this.now() });
  }

  /**
   * The core's words as they are, so the window's step-up can recognise a refused policy and ask
   * for the password (applying needs a fresh step-up).
   */
  private passThrough(error: unknown): Error {
    if (coreErrorCode(error) && error instanceof Error) return error;
    return new Error(hubMessage(error));
  }

  private explain(serverId: string, error: unknown): Error {
    if (coreErrorCode(error) && error instanceof Error) return error;
    const message = hubMessage(error);
    if (!UNAUTHORIZED.test(message)) return new Error(message);
    const roles = this.deps.roles(serverId);
    const which = roles && roles.length > 0 ? ` (${roles.join(', ')})` : '';
    return new Error(
      encodeCoreError(
        'forbidden',
        `Your role on this server${which} cannot do that in the Security section.`,
      ),
    );
  }
}

function request(input: DeploySshHardeningInput): SshHardeningRequest {
  return {
    disablePasswordLogin: input.disablePasswordLogin,
    restrictRootLogin: input.restrictRootLogin,
  };
}
