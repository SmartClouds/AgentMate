import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { coreErrorCode } from '../../shared/coreErrors';
import type {
  ChallengeResponse,
  HealthResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { FAKE_CORE_TLS_PIN, FakeCore } from '../../shared/deploy/testing/fakeCore';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { createDeviceKey } from './auth/deviceKey';
import { HubStartError, type LiveHubSession } from './connection/liveHub';
import type { CoreTransport, CoreTransportKind } from './connection/transport';
import { DirectTlsUnreachableError, PinMismatchError } from './directTls/transport';
import { DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * The fallback order with direct TLS on: the core's own HTTPS port first, then the SSH tunnel (and
 * the bridge) as before. A port that does not answer, or refuses this device, is left alone for a
 * while; a certificate that is not the pinned one stops everything, with nothing tried over SSH
 * that could hide it.
 */

const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/agentmate-core/releases/1.53.0',
  transport: 'streamlocal',
  installedAt: 1,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};
const SAVED = [
  {
    id: 'srv-1',
    nickname: 'Production',
    host: 'prod.example',
    port: 22,
    username: 'deployer',
    authMethod: 'password' as const,
  },
];
const HEALTH: HealthResponse = {
  status: 'ok',
  version: '1.53.0',
  apiVersion: 1,
  startedAtUnixMs: 1,
};

let service: DeployService | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  service?.links.closeAll();
  service = null;
  vi.useRealTimers();
});

type Outcome = unknown | ((transport: CoreTransport) => unknown);

interface Setup {
  /** Whether this computer has direct TLS on for the server. */
  direct?: boolean;
  /** Fails the next lasting opens, in order. */
  refusals?: Outcome[];
  /** What a health check over each transport kind throws, if anything. */
  health?: Partial<Record<CoreTransportKind, unknown>>;
}

async function setup(options: Setup = {}) {
  const core = new FakeCore(() => Date.now());
  const pool = {
    acquire: vi.fn(async () => ({ connection: {} as never, release: () => undefined })),
    reset: vi.fn(),
  };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const sealed = (text: string): SecretEnvelope => ({
    mode: 'safeStorage',
    ciphertext: Buffer.from(text).toString('base64'),
  });
  await state.set('srv-1', RECORD);
  await state.setDevice('srv-1', {
    deviceId: 'device-1',
    userName: 'maria',
    privateKey: sealed(createDeviceKey().privateKeyPem),
    sessionId: 'session-1',
  });
  if (options.direct !== false) {
    await state.setDirectTls('srv-1', {
      enabled: true,
      port: 7443,
      pin: FAKE_CORE_TLS_PIN,
      pinnedAt: 1,
    });
  }
  let issued = 0;
  const rest = {
    post: async <T>(path: string): Promise<T> => {
      if (path === '/api/v1/auth/challenge') {
        return {
          challengeId: 'c1',
          nonce: 'n1',
          expiresAtUnixMs: 0,
        } satisfies ChallengeResponse as T;
      }
      issued += 1;
      return {
        sessionId: 'session-1',
        accessToken: `token-${issued}`,
        accessTokenExpiresAtUnixMs: Date.now() + 15 * 60_000,
        user: { id: 'u1', userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
      } satisfies SignedInResponse as T;
    },
  };
  const refusals = [...(options.refusals ?? [])];
  const opened: CoreTransportKind[] = [];
  const restOver: CoreTransportKind[] = [];
  const shortOver: CoreTransportKind[] = [];
  const liveHub = async (
    transport: CoreTransport,
    _token: string,
    expiresAt: number | null,
  ): Promise<LiveHubSession> => {
    opened.push(transport.kind);
    const next = refusals.shift();
    const refusal = typeof next === 'function' ? next(transport) : next;
    if (refusal) throw refusal;
    const connection = core.connect();
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    connection.onClose(() => markClosed());
    return { hub: connection, closed, stop: () => connection.stop(), expiresAt };
  };
  const deps: DeployServiceDeps = {
    servers: async () => SAVED,
    pool,
    state,
    releases: { release: async () => Promise.reject(new Error('not in this test')) },
    availableVersion: async () => '1.53.0',
    devCorePort: null,
    progress: () => undefined,
    seal: async (text) => sealed(text),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    healthOf: async (transport) => {
      const failure = options.health?.[transport.kind];
      if (failure) throw failure;
      return HEALTH;
    },
    rest: (transport) => {
      restOver.push(transport.kind);
      return rest;
    },
    hub: async (transport) => {
      shortOver.push(transport.kind);
      const connection = core.connect();
      return { hub: connection, stop: () => connection.stop() };
    },
    liveHub,
  };
  service = new DeployService(deps);
  return { service, core, pool, state, opened, restOver, shortOver };
}

const unreachable = () =>
  new DirectTlsUnreachableError('Could not reach the direct TLS port: ECONNREFUSED');
const mismatch = () => new PinMismatchError(FAKE_CORE_TLS_PIN, 'other', 'prod.example:7443');

describe('DeployService with direct TLS', () => {
  it('opens the link over direct TLS first, without an SSH connection, and says so', async () => {
    const { service, opened, pool } = await setup();

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['direct-tls']);
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(service.connection('srv-1')).toMatchObject({ state: 'online', transport: 'direct-tls' });
  });

  it('falls back to the SSH tunnel when the port does not answer, and leaves it alone a while', async () => {
    const { service, opened, core } = await setup({ refusals: [unreachable()] });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['direct-tls', 'streamlocal']);
    expect(service.connection('srv-1').transport).toBe('streamlocal');

    core.dropAll();
    await vi.advanceTimersByTimeAsync(5_000);
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(opened.slice(2)).toEqual(['streamlocal']);

    core.dropAll();
    await vi.advanceTimersByTimeAsync(61_000);
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(opened.at(-1)).toBe('direct-tls');
  });

  it('falls back when the core turns the handshake down, as for a revoked device', async () => {
    const revoked = new Error(
      '[core:deviceRevoked] This device was revoked. Enroll it again to sign in.',
    );
    const { service, opened } = await setup({
      refusals: [new HubStartError('WebSocket failed to connect.', null), revoked],
    });

    await expect(service.links.call('srv-1', (hub) => hub.ping())).rejects.toThrow(/revoked/);

    expect(opened).toEqual(['direct-tls', 'streamlocal']);
    expect(service.connection('srv-1').state).toBe('needs-re-enroll');
  });

  it('stops on a pin mismatch and tries nothing over SSH', async () => {
    const { service, opened, pool } = await setup({ refusals: [mismatch()] });

    const error = await service.links
      .call('srv-1', (hub) => hub.ping())
      .catch((caught: unknown) => caught);

    expect(coreErrorCode(error)).toBe('tlsPinMismatch');
    expect(opened).toEqual(['direct-tls']);
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(service.connection('srv-1')).toMatchObject({
      state: 'offline',
      problem: 'tls-pin-mismatch',
    });
    expect(service.connection('srv-1').message).toMatch(/pinned over SSH/);
  });

  it('uses only SSH while this computer has direct TLS off', async () => {
    const { service, opened } = await setup({ direct: false });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual(['streamlocal']);
  });

  it('sends short calls over direct TLS once its health answers, and over SSH when it does not', async () => {
    const up = await setup();
    const seen = await up.service.withCoreHttp('srv-1', async (client) => client.transport.kind);
    expect(seen).toBe('direct-tls');
    up.service.links.closeAll();

    const down = await setup({ health: { 'direct-tls': unreachable() } });
    const fallen = await down.service.withCoreHttp(
      'srv-1',
      async (client) => client.transport.kind,
    );
    expect(fallen).toBe('streamlocal');
    expect(down.pool.acquire).toHaveBeenCalled();
  });

  it('refuses a short call outright on a pin mismatch', async () => {
    const { service, pool } = await setup({ health: { 'direct-tls': mismatch() } });

    const error = await service
      .withCoreHttp('srv-1', async () => 'sent')
      .catch((caught: unknown) => caught);

    expect(coreErrorCode(error)).toBe('tlsPinMismatch');
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('checks health over direct TLS without an SSH login, so the pool can close it', async () => {
    const { service, pool } = await setup();

    const health = await service.health('srv-1');

    expect(health).toMatchObject({ version: '1.53.0', transport: 'direct-tls' });
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('checks health over SSH when the port does not answer, and leaves it alone a while', async () => {
    const { service, pool } = await setup({ health: { 'direct-tls': unreachable() } });

    expect((await service.health('srv-1')).transport).toBe('streamlocal');
    expect(pool.acquire).toHaveBeenCalledTimes(1);

    await service.health('srv-1');
    expect(pool.acquire).toHaveBeenCalledTimes(2);
  });

  it('refuses a health check on a pin mismatch, with nothing tried over SSH', async () => {
    const { service, pool } = await setup({ health: { 'direct-tls': mismatch() } });

    const error = await service.health('srv-1').catch((caught: unknown) => caught);

    expect(coreErrorCode(error)).toBe('tlsPinMismatch');
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('reads the pin over SSH even while the link rides direct TLS', async () => {
    const { service, shortOver } = await setup();
    await service.links.call('srv-1', (hub) => hub.ping());

    const status = await service.withSshHub('srv-1', (hub) => hub.getDirectTls());

    expect(status.pin).toBe(FAKE_CORE_TLS_PIN);
    expect(shortOver).toEqual(['streamlocal']);
  });

  it('starts the link over again after a change to the mode', async () => {
    const { service, opened, state } = await setup({ refusals: [unreachable()] });
    await service.links.call('srv-1', (hub) => hub.ping());
    expect(service.connection('srv-1').transport).toBe('streamlocal');

    await state.setDirectTls('srv-1', {
      enabled: true,
      port: 8443,
      pin: FAKE_CORE_TLS_PIN,
      pinnedAt: 2,
    });
    service.directTlsChanged('srv-1');
    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened.at(-1)).toBe('direct-tls');
    expect(await service.directTlsHost('srv-1')).toBe('prod.example');
  });
});
