import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignedInResponse } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../shared/deploy/testing/fakeCore';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { TunnelRefusedError } from '../ssh/connection';
import { createDeviceKey } from './auth/deviceKey';
import type { CoreTransport } from './connection/transport';
import { DEV_SERVER_ID, DeployService } from './service';
import { DeployState } from './state';

/**
 * What the firewall's safe apply needs of the service: `$SSH_CONNECTION` read on the pooled
 * connection the link rides on (held while the apply runs), and a hub call over a brand-new SSH
 * connection and tunnel, closed afterwards, to prove a new login still gets in.
 */

const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/runova-core/releases/1.53.0',
  transport: 'streamlocal',
  installedAt: 1,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};

let service: DeployService | null = null;

afterEach(() => {
  service?.links.closeAll();
  service = null;
});

function fakeConnection(name: string, printed = '203.0.113.50 51515 203.0.113.10 22\n') {
  return { name, exec: vi.fn(async () => ({ stdout: printed, stderr: '', code: 0 })) };
}

async function setup(
  options: { transport?: DeployCoreRecord['transport']; dev?: boolean; separate?: boolean } = {},
) {
  const core = new FakeCore();
  const pooled = fakeConnection('pooled');
  const separate = fakeConnection('separate');
  const releasePooled = vi.fn();
  const releaseSeparate = vi.fn();
  const pool = {
    acquire: vi.fn(async () => ({ connection: pooled as never, release: releasePooled })),
    reset: vi.fn(),
    ...(options.separate === false
      ? {}
      : {
          // A method that needs its pool, as SshConnectionPool's does.
          openSeparate: vi.fn(async function (this: { reset: unknown }) {
            if (!this?.reset) throw new Error('openSeparate was called without its pool');
            return { connection: separate as never, release: releaseSeparate };
          }),
        }),
  };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  await state.set('srv-1', { ...RECORD, transport: options.transport ?? 'streamlocal' });
  const key = createDeviceKey();
  await state.setDevice('srv-1', {
    deviceId: 'device-1',
    userName: 'maria',
    privateKey: {
      mode: 'safeStorage',
      ciphertext: Buffer.from(key.privateKeyPem).toString('base64'),
    },
    sessionId: 'session-1',
  });
  const transports: CoreTransport[] = [];
  const stops = vi.fn();
  const refuseTunnel = { once: false };
  service = new DeployService({
    servers: async () => [],
    pool,
    state,
    releases: { release: async () => Promise.reject(new Error('not here')) },
    availableVersion: async () => '1.53.0',
    devCorePort: options.dev ? 5099 : null,
    progress: () => undefined,
    seal: async (text) => ({ mode: 'safeStorage', ciphertext: text }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    rest: () => ({
      post: async <T>(path: string): Promise<T> => {
        if (path === '/api/v1/auth/challenge') return { challengeId: 'c', nonce: 'n' } as T;
        if (path === '/dev/enroll') return { deviceId: 'dev', userName: 'dev' } as T;
        return {
          sessionId: 'session-1',
          accessToken: 'token',
          accessTokenExpiresAtUnixMs: Date.now() + 900_000,
          user: { id: 'u1', userName: 'maria', roles: ['admin'], twoFactorEnabled: false },
        } satisfies SignedInResponse as T;
      },
    }),
    hub: async (transport) => {
      transports.push(transport);
      if (refuseTunnel.once && transport.kind === 'streamlocal') {
        refuseTunnel.once = false;
        throw new TunnelRefusedError('no forwarding', 1);
      }
      return { hub: core.connect(), stop: async () => stops() };
    },
  });
  return {
    service,
    core,
    pool,
    pooled,
    separate,
    releasePooled,
    releaseSeparate,
    transports,
    stops,
    refuseTunnel,
  };
}

describe('DeployService for the firewall', () => {
  it('reads $SSH_CONNECTION on the pooled connection and holds it while the work runs', async () => {
    const { service, pooled, releasePooled } = await setup();

    const seen = await service.onLinkConnection('srv-1', async (ssh) => {
      expect(releasePooled).not.toHaveBeenCalled();
      return ssh;
    });

    expect(seen).toBe('203.0.113.50 51515 203.0.113.10 22');
    expect(pooled.exec).toHaveBeenCalledWith('echo "$SSH_CONNECTION"');
    expect(releasePooled).toHaveBeenCalledTimes(1);
  });

  it('passes undefined when the server prints nothing, and for the DevHost', async () => {
    const empty = await setup();
    empty.pooled.exec.mockResolvedValueOnce({ stdout: '\n', stderr: '', code: 0 });
    expect(await empty.service.onLinkConnection('srv-1', async (ssh) => ssh)).toBeUndefined();

    const dev = await setup({ dev: true });
    expect(await dev.service.onLinkConnection(DEV_SERVER_ID, async (ssh) => ssh)).toBeUndefined();
    expect(dev.pool.acquire).not.toHaveBeenCalled();
  });

  it('confirms over a new SSH connection and a new tunnel, then closes both', async () => {
    const { service, pool, separate, releaseSeparate, transports, stops } = await setup();
    const steps: string[] = [];

    const pinged = await service.withFreshHub(
      'srv-1',
      (hub) => hub.ping(),
      (step) => steps.push(step),
    );

    expect(pinged.serverTimeUnixMs).toBeGreaterThan(0);
    expect(pool.openSeparate).toHaveBeenCalledWith('srv-1');
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(transports.map((transport) => transport.kind)).toEqual(['streamlocal']);
    expect(steps).toEqual(['signingIn']);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(releaseSeparate).toHaveBeenCalledTimes(1);
    expect(separate.exec).not.toHaveBeenCalled();
  });

  it('uses the bridge when the record says so, or when the tunnel is refused', async () => {
    const bridged = await setup({ transport: 'bridge' });
    await bridged.service.withFreshHub('srv-1', (hub) => hub.ping());
    expect(bridged.transports.map((transport) => transport.kind)).toEqual(['bridge']);

    const refused = await setup();
    refused.refuseTunnel.once = true;
    const steps: string[] = [];
    await refused.service.withFreshHub(
      'srv-1',
      (hub) => hub.ping(),
      (step) => steps.push(step),
    );
    expect(steps).toEqual(['signingIn']);
    expect(refused.transports.map((transport) => transport.kind)).toEqual([
      'streamlocal',
      'bridge',
    ]);
    expect(refused.releaseSeparate).toHaveBeenCalledTimes(1);
  });

  it('closes the new connection when the work fails', async () => {
    const { service, releaseSeparate, stops } = await setup();

    await expect(
      service.withFreshHub('srv-1', async () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused');
    expect(stops).toHaveBeenCalledTimes(1);
    expect(releaseSeparate).toHaveBeenCalledTimes(1);
  });

  it('opens a new TCP connection on the DevHost, and says when it cannot open one', async () => {
    const dev = await setup({ dev: true });
    await dev.service.withFreshHub(DEV_SERVER_ID, (hub) => hub.ping());
    expect(dev.transports.map((transport) => transport.kind)).toEqual(['dev-tcp']);

    const none = await setup({ separate: false });
    await expect(none.service.withFreshHub('srv-1', (hub) => hub.ping())).rejects.toThrow(
      /cannot open a second SSH connection/,
    );
  });
});
