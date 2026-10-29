import { registryOfImage } from '../../../shared/deploy/registries';
import type { DeployRegistryPlan } from '../../../shared/deployRegistryTypes';
import type { PlanRequest } from '../../ipc/deployRegistry';
import type { DeployStacks } from '../stacks/service';
import type { DeployServerRegistries } from './serverCredentials';
import type { DeployRegistries } from './service';

/** The registries an app pulls from (its images, or a revision's compose file) and who signs in. */
export async function planFor(
  request: PlanRequest,
  registries: DeployRegistries,
  servers: DeployServerRegistries,
  stacks: Pick<DeployStacks, 'registriesOf'>,
): Promise<DeployRegistryPlan> {
  const pulled =
    request.images !== null
      ? { registries: [...new Set(request.images.map(registryOfImage))], unresolved: false }
      : await stacks.registriesOf(request.serverId, request.stackId ?? '', request.revision ?? 1);
  // A Viewer may not list them; the plan then just does not know.
  const stored = await servers
    .list(request.serverId)
    .then((list) => list.map((credential) => credential.registry))
    .catch(() => [] as string[]);
  return registries.plan(
    request.serverId,
    request.stackId,
    pulled.registries,
    stored,
    pulled.unresolved,
  );
}
