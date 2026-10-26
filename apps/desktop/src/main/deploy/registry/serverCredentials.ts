import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { normalizeRegistry, registryCredentialProblem } from '../../../shared/deploy/registries';
import type {
  DeployRegistryProof,
  DeployServerCredential,
  DeployServerCredentialInput,
  DeployServerCredentialRemoveInput,
} from '../../../shared/deployRegistryTypes';
import { ADMIN_ROLES, type CoreCallDeps, callCore } from '../coreCalls';
import type { DeployRegistries } from './service';

/**
 * Credentials stored on a server (E08 T4), for pulls nobody is there to sign in for. The core
 * seals them with its Data Protection keys and never sends one back, so this only lists, stores
 * and removes. Storing and removing are for Admins with a step-up: the call makes the step-up on
 * the way when it is handed the password or a code, as revealing a container's values does.
 */

export interface DeployServerRegistriesDeps extends CoreCallDeps {
  local: Pick<DeployRegistries, 'secretOf'>;
}

async function stepUp(hub: ICoreHub, proof: DeployRegistryProof): Promise<void> {
  if (proof.password || proof.totpCode) {
    await hub.stepUp({
      ...(proof.password ? { password: proof.password } : {}),
      ...(proof.totpCode ? { totpCode: proof.totpCode } : {}),
    });
  }
}

export class DeployServerRegistries {
  constructor(private readonly deps: DeployServerRegistriesDeps) {}

  list(serverId: string): Promise<DeployServerCredential[]> {
    return callCore(this.deps, serverId, (hub) => hub.listRegistryCredentials());
  }

  async save(input: DeployServerCredentialInput): Promise<DeployServerCredential> {
    const credential =
      'credentialId' in input
        ? await this.deps.local.secretOf(input.credentialId)
        : { registry: input.registry, username: input.username, secret: input.secret };
    const registry = normalizeRegistry(credential.registry);
    if (!registry) throw new Error('Enter the registry host, such as ghcr.io or docker.io.');
    const problem = registryCredentialProblem(credential.username, credential.secret);
    if (problem) throw new Error(problem);
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        return hub.saveRegistryCredential({
          registry,
          username: credential.username,
          secret: credential.secret,
        });
      },
      { stepUpFor: ADMIN_ROLES },
    );
  }

  remove(input: DeployServerCredentialRemoveInput): Promise<void> {
    return callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        await stepUp(hub, input);
        await hub.deleteRegistryCredential(input.credentialId);
      },
      { stepUpFor: ADMIN_ROLES },
    );
  }
}
