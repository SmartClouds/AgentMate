import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployServerRegistries } from './serverCredentials';

const INFO = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  registry: 'ghcr.io',
  username: 'octocat',
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

function setup(roles = ['admin'], hubOverrides: Partial<Record<string, unknown>> = {}) {
  const hub = {
    stepUp: vi.fn(async () => ({ stepUpUntilUnixMs: 1 })),
    listRegistryCredentials: vi.fn(async () => [INFO]),
    saveRegistryCredential: vi.fn(async () => INFO),
    deleteRegistryCredential: vi.fn(async () => undefined),
    ...hubOverrides,
  };
  const local = {
    secretOf: vi.fn(async () => ({
      registry: 'ghcr.io',
      username: 'octocat',
      secret: 'ghp_fromThisComputer0123',
    })),
  };
  const server = new DeployServerRegistries({
    links: { call: (_id, work) => work(hub as unknown as ICoreHub) },
    roles: () => roles,
    local,
  });
  return { server, hub, local };
}

describe('DeployServerRegistries', () => {
  it('lists what the server stores, without secrets', async () => {
    const { server } = setup();
    expect(await server.list('srv')).toEqual([INFO]);
  });

  it('stores a typed credential, stepping up first when handed the password', async () => {
    const { server, hub } = setup();

    await server.save({
      serverId: 'srv',
      registry: 'Docker.io',
      username: 'hubber',
      secret: 'dckr_pat_typed',
      password: 'pw',
    });

    expect(hub.stepUp).toHaveBeenCalledWith({ password: 'pw' });
    expect(hub.saveRegistryCredential).toHaveBeenCalledWith({
      registry: 'docker.io',
      username: 'hubber',
      secret: 'dckr_pat_typed',
    });
  });

  it("copies one of this computer's sign-ins to the server", async () => {
    const { server, hub, local } = setup();

    await server.save({ serverId: 'srv', credentialId: 'c1', totpCode: '123456' });

    expect(local.secretOf).toHaveBeenCalledWith('c1');
    expect(hub.stepUp).toHaveBeenCalledWith({ totpCode: '123456' });
    expect(hub.saveRegistryCredential).toHaveBeenCalledWith({
      registry: 'ghcr.io',
      username: 'octocat',
      secret: 'ghp_fromThisComputer0123',
    });
  });

  it('checks the credential before the server sees it', async () => {
    const { server, hub } = setup();

    await expect(
      server.save({ serverId: 'srv', registry: 'bad host', username: 'u', secret: 'pass' }),
    ).rejects.toThrow(/registry host/);
    await expect(
      server.save({ serverId: 'srv', registry: 'ghcr.io', username: 'u', secret: 'x' }),
    ).rejects.toThrow(/at least 4/);
    expect(hub.saveRegistryCredential).not.toHaveBeenCalled();
  });

  it('asks an Admin for a step-up and tells an Operator the role is not enough', async () => {
    const refuse = vi.fn(async () => {
      throw new Error("Failed to invoke 'SaveRegistryCredential' because user is unauthorized");
    });
    const admin = setup(['admin'], { saveRegistryCredential: refuse });
    const operator = setup(['operator'], { saveRegistryCredential: refuse });
    const input = { serverId: 'srv', registry: 'ghcr.io', username: 'u', secret: 'pass' };

    expect(coreErrorCode(await admin.server.save(input).catch((error) => error))).toBe(
      'stepUpRequired',
    );
    expect(coreErrorCode(await operator.server.save(input).catch((error) => error))).toBe(
      'forbidden',
    );
  });

  it('removes a stored credential', async () => {
    const { server, hub } = setup();

    await server.remove({ serverId: 'srv', credentialId: INFO.id });

    expect(hub.stepUp).not.toHaveBeenCalled();
    expect(hub.deleteRegistryCredential).toHaveBeenCalledWith(INFO.id);
  });
});
