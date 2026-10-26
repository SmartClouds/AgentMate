import { describe, expect, it, vi } from 'vitest';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployStacks } from './service';

const SERVER = 'srv';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PRIVATE = `services:
  web:
    image: ghcr.io/acme/web:\${TAG:-1.0}
  db:
    image: postgres:17
  worker:
    build: ./worker
    image: ghcr.io/acme/worker
`;
const AUTH = { registry: 'ghcr.io', username: 'octocat', secret: 'ghp_deploySecret0123' };

function setup(compose: string, auths = [AUTH]) {
  const hub = {
    getStackRevisionFiles: vi.fn(async () => ({ number: 2, compose, envKeys: [] })),
    deployStack: vi.fn(async () => ({ id: 'plain' })),
    rollbackStack: vi.fn(async () => ({ id: 'plain-rollback' })),
    deployStackWithRegistries: vi.fn(async () => ({ id: 'signed' })),
    rollbackStackWithRegistries: vi.fn(async () => ({ id: 'signed-rollback' })),
  };
  const registryAuths = vi.fn(async () => auths);
  const stacks = new DeployStacks({
    links: { call: (_serverId, work) => work(hub as unknown as ICoreHub) },
    roles: () => ['operator'],
    http: () => Promise.reject(new Error('no REST here')),
    source: {} as never,
    pack: vi.fn(),
    registryAuths,
  });
  return { stacks, hub, registryAuths };
}

describe('DeployStacks with registry sign-ins (E08)', () => {
  it('sends the sign-ins for the registries the revision pulls from', async () => {
    const { stacks, hub, registryAuths } = setup(PRIVATE);

    const job = await stacks.deploy(SERVER, STACK, 2);

    expect(job).toEqual({ id: 'signed' });
    expect(hub.getStackRevisionFiles).toHaveBeenCalledWith({ stackId: STACK, revision: 2 });
    // The built worker is skipped, as docker compose pull skips it.
    expect(registryAuths).toHaveBeenCalledWith(SERVER, STACK, ['docker.io', 'ghcr.io']);
    expect(hub.deployStackWithRegistries).toHaveBeenCalledWith({
      stackId: STACK,
      revision: 2,
      registries: [AUTH],
    });
    expect(hub.deployStack).not.toHaveBeenCalled();
  });

  it('a rollback takes them along too', async () => {
    const { stacks, hub } = setup(PRIVATE);

    expect(await stacks.rollback(SERVER, STACK, 1)).toEqual({ id: 'signed-rollback' });
    expect(hub.rollbackStackWithRegistries).toHaveBeenCalledWith({
      stackId: STACK,
      revision: 1,
      registries: [AUTH],
    });
  });

  it('without a sign-in to send it uses the plain call, which older cores know', async () => {
    const { stacks, hub } = setup(PRIVATE, []);

    expect(await stacks.deploy(SERVER, STACK, 2)).toEqual({ id: 'plain' });
    expect(await stacks.rollback(SERVER, STACK, 1)).toEqual({ id: 'plain-rollback' });
    expect(hub.deployStackWithRegistries).not.toHaveBeenCalled();
  });

  it('an app that only builds asks for nothing', async () => {
    const { stacks, registryAuths } = setup('services:\n  app:\n    build: .\n');

    await stacks.deploy(SERVER, STACK, 2);
    expect(registryAuths).not.toHaveBeenCalled();
  });

  it('a locked passkey stops the deploy before the server is asked', async () => {
    const { stacks, hub, registryAuths } = setup(PRIVATE);
    registryAuths.mockRejectedValueOnce(new Error('Unlock the Servers passkey'));

    await expect(stacks.deploy(SERVER, STACK, 2)).rejects.toThrow(/passkey/);
    expect(hub.deployStackWithRegistries).not.toHaveBeenCalled();
    expect(hub.deployStack).not.toHaveBeenCalled();
  });
});
