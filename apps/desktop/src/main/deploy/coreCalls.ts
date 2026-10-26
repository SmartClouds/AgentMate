import { coreErrorCode, encodeCoreError } from '../../shared/coreErrors';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { hubMessage } from './connection/hubErrors';
import type { CoreLinks } from './live/coreLinks';

/**
 * A short call on a server's lasting connection, with the core's refusals put in words the
 * renderer can act on. The core turns down a missing step-up and a missing role with the same
 * SignalR sentence, so they are told apart here by the signed-in user's roles: only someone whose
 * role could pass is asked for the password. This is the same rule as `DeploySystem` (E05), in a
 * form later groups can share.
 */

/** What SignalR says when an authorization policy refused a hub method. */
const UNAUTHORIZED = /because user is unauthorized/;
/** Who may step up for the calls that only want a step-up on top of Operator. */
export const OPERATOR_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'operator']);
export const ADMIN_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export interface CoreCallDeps {
  links: Pick<CoreLinks, 'call'>;
  /** The signed-in user's roles on a server, when this run of the app knows them. */
  roles: (serverId: string) => string[] | null;
}

export interface CoreCallOptions {
  /** The call needs a step-up from anyone holding one of these roles. */
  stepUpFor?: ReadonlySet<string>;
}

export async function callCore<T>(
  deps: CoreCallDeps,
  serverId: string,
  work: (hub: ICoreHub) => Promise<T>,
  options: CoreCallOptions = {},
): Promise<T> {
  try {
    return await deps.links.call(serverId, work);
  } catch (error) {
    throw explainRefusal(deps.roles(serverId), error, options.stepUpFor);
  }
}

export function explainRefusal(
  roles: string[] | null,
  error: unknown,
  stepUpFor?: ReadonlySet<string>,
): Error {
  // The connection's own refusals (a sign-in, a new enrollment) already carry their code.
  if (coreErrorCode(error) && error instanceof Error) return error;
  if (!UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) {
    return new Error(hubMessage(error));
  }
  if (stepUpFor && (!roles || roles.some((role) => stepUpFor.has(role)))) {
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
