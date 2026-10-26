import { describe, expect, it, vi } from 'vitest';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployDocker } from './docker';

/** An image pull on the Containers screen takes this computer's sign-in for its registry (E08). */

function setup(auth: { registry: string; username: string; secret: string } | null) {
  const hub = { pullImage: vi.fn(async () => ({ id: 'job' })) };
  const registryAuth = vi.fn(async () => auth);
  const docker = new DeployDocker({
    links: { call: (_id, work) => work(hub as unknown as ICoreHub) },
    roles: () => ['operator'],
    registryAuth,
  });
  return { docker, hub, registryAuth };
}

describe('DeployDocker image pulls with a sign-in', () => {
  it('sends the sign-in for the image registry with the pull', async () => {
    const auth = { registry: 'ghcr.io', username: 'octocat', secret: 'ghp_pull0123' };
    const { docker, hub, registryAuth } = setup(auth);

    await docker.pullImage({ serverId: 'srv', reference: 'ghcr.io/acme/web:1' });

    expect(registryAuth).toHaveBeenCalledWith('ghcr.io/acme/web:1');
    expect(hub.pullImage).toHaveBeenCalledWith({ reference: 'ghcr.io/acme/web:1', auth });
  });

  it('pulls without one when this computer has none', async () => {
    const { docker, hub } = setup(null);

    await docker.pullImage({ serverId: 'srv', reference: 'redis:8' });

    expect(hub.pullImage).toHaveBeenCalledWith({ reference: 'redis:8' });
  });
});
