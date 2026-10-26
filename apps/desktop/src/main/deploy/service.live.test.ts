import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { coreErrorCode } from '../../shared/coreErrors';
import type {
  ChallengeResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { FakeCore } from '../../shared/deploy/testing/fakeCore';
import type { DeployConnection, DeployCoreRecord } from '../../shared/deployTypes';
import { TunnelRefusedError } from '../ssh/connection';
import { createDeviceKey } from './auth/deviceKey';
import { HubStartError, type LiveHubSession } from './connection/liveHub';
import type { CoreTransport } from './connection/transport';
import { DEV_SERVER_ID, DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * The service's side of the lasting connections: each one is opened over the transport the
 * install settled on, with a signed-in token, and holds an SSH lease for as long as it is open.
 * Short calls ride it when it is up, and signing in or out starts it over.
 */

const MINUTE = 60_000;
const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/runova-core/releases/1.53.0',
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

/** The core's sign-in answers: each renewal or login hands out the next token. */
function fakeRest() {
  let issued = 0;
  const paths: string[] = [];
  return {
    paths,
    rest: {
      post: async <T>(path: string): Promise<T> => {
        paths.push(path);
        if (path === '/api/v1/auth/challenge') {
          return {
            challengeId: 'c1',
            nonce: 'n1',
            expiresAtUnixMs: 0,
          } satisfies ChallengeResponse as T;
        }
        if (path === '/dev/enroll') return { deviceId: 'dev-device', userName: 'dev' } as T;
        issued += 1;
        return {
          sessionId: 'session-1',
          accessToken: `token-${issued}`,
          accessTokenExpiresAtUnixMs: Date.now() + 15 * MINUTE,
          user: { id: 'u1', userName: 'maria', roles: ['operator'], twoFactorEnabled: false },
        } satisfies SignedInResponse as T;
      },
    },
  };
}

interface Setup {
  installed?: boolean;
  enrolled?: boolean;
  devCorePort?: number | null;
  /** Fails the next lasting opens, in order; a function decides by the transport. */
  refusals?: Array<unknown | ((transport: CoreTransport) => unknown)>;
}

async function setup(options: Setup = {}) {
  const core = new FakeCore(() => Date.now());
  const release = vi.fn();
  const pool = {
    acquire: vi.fn(async () => ({ connection: {} as never, release })),
    reset: vi.fn(),
  };
  let content: unknown = null;
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const key = createDeviceKey();
  const sealed = (text: string): SecretEnvelope => ({
    mode: 'safeStorage',
    ciphertext: Buffer.from(text).toString('base64'),
  });
  if (options.installed !== false) await state.set('srv-1', RECORD);
  if (options.enrolled !== false) {
    await state.setDevice('srv-1', {
      deviceId: 'device-1',
      userName: 'maria',
      privateKey: sealed(key.privateKeyPem),
      sessionId: 'session-1',
    });
  }
  const { rest, paths } = fakeRest();
  const refusals = [...(options.refusals ?? [])];
  const opened: Array<{ kind: string; token: string }> = [];
  const states: DeployConnection[] = [];
  const shortHubs = vi.fn();
  const liveHub = async (
    transport: CoreTransport,
    token: string,
    expiresAt: number | null,
  ): Promise<LiveHubSession> => {
    opened.push({ kind: transport.kind, token });
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
    devCorePort: options.devCorePort ?? null,
    progress: () => undefined,
    seal: async (text) => sealed(text),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    rest: () => rest,
    hub: async () => {
      shortHubs();
      throw new Error('a short-lived connection was opened');
    },
    liveHub,
    connectionChanged: (connection) => states.push(connection),
  };
  service = new DeployService(deps);
  return { service, core, pool, release, state, opened, paths, states, shortHubs };
}

describe('DeployService lasting connections', () => {
  it('opens over the tunnel with a signed-in token and holds an SSH lease until it closes', async () => {
    const { service, core, opened, pool, release } = await setup();

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened).toEqual([{ kind: 'streamlocal', token: 'token-1' }]);
    expect(pool.acquire).toHaveBeenCalled();
    const leases = release.mock.calls.length;
    core.dropAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(release.mock.calls.length).toBe(leases + 1);
  });

  it('gets in through the bridge when the tunnel is refused, without saving that', async () => {
    const refused = new TunnelRefusedError('no forwarding here', 1);
    const { service, opened, state } = await setup({
      refusals: [(transport: CoreTransport) => (transport.kind === 'streamlocal' ? refused : null)],
    });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened.map((one) => one.kind)).toEqual(['streamlocal', 'bridge']);
    expect((await state.get('srv-1'))?.transport).toBe('streamlocal');
  });

  it('makes REST calls for uploads over the transport with a signed-in token', async () => {
    const { service, pool, release } = await setup();

    const seen = await service.withCoreHttp('srv-1', async (client, token) => ({
      kind: client.transport.kind,
      token,
    }));

    expect(seen).toEqual({ kind: 'streamlocal', token: 'token-1' });
    expect(pool.acquire).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('renews the token once when the core turns the one in hand away', async () => {
    const { service, opened } = await setup({
      refusals: [new HubStartError('WebSocket failed to connect.', 401)],
    });

    await service.links.call('srv-1', (hub) => hub.ping());

    expect(opened.map((one) => one.token)).toEqual(['token-1', 'token-2']);
  });

  it('waits, without retrying, for a core that is not installed or a device not enrolled', async () => {
    const missing = await setup({ installed: false });
    await expect(missing.service.links.call('srv-1', (hub) => hub.ping())).rejects.toThrow(
      /not installed/,
    );
    expect(missing.service.connection('srv-1').state).toBe('offline');
    missing.service.links.closeAll();

    const stranger = await setup({ enrolled: false });
    await expect(stranger.service.links.call('srv-1', (hub) => hub.ping())).rejects.toThrow(
      /not enrolled/,
    );
    expect(stranger.opened).toEqual([]);
  });

  it('waits for a saved server that is gone', async () => {
    const { service } = await setup();

    await expect(service.links.call('srv-9', (hub) => hub.ping())).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('reaches the DevHost over loopback once its device is enrolled and signed in', async () => {
    const { service, opened, paths } = await setup({ devCorePort: 7810, enrolled: false });

    await expect(service.links.call(DEV_SERVER_ID, (hub) => hub.ping())).rejects.toThrow(
      /sessionExpired/,
    );
    expect(paths[0]).toBe('/dev/enroll');
    expect(service.connection(DEV_SERVER_ID).state).toBe('needs-sign-in');

    await service.signIn({ serverId: DEV_SERVER_ID, password: 'runova-local-password' });
    await service.links.call(DEV_SERVER_ID, (hub) => hub.ping());

    expect(opened.at(-1)?.kind).toBe('dev-tcp');
  });

  it('carries short calls on the lasting connection while it is up', async () => {
    const { service, shortHubs } = await setup();
    await service.links.call('srv-1', (hub) => hub.ping());

    const account = await service.account('srv-1');

    expect(account.userName).toBe('maria');
    expect(shortHubs).not.toHaveBeenCalled();
  });

  it('starts the connection over on sign-out, and waits for the next sign-in', async () => {
    const { service, states } = await setup();
    service.links.watchMetrics('srv-1', 1_000, () => undefined);
    await vi.advanceTimersByTimeAsync(0);

    await service.signOut('srv-1');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.connection('srv-1').state).toBe('needs-sign-in');

    await service.signIn({ serverId: 'srv-1', password: 'correct horse battery staple' });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.connection('srv-1').state).toBe('online');
    expect(states.map((one) => one.state)).toContain('needs-sign-in');
  });

  it('tries again on request and tells the roles of whoever is signed in', async () => {
    const { service, opened } = await setup({
      refusals: [new Error('connect ECONNREFUSED 10.0.0.5:22')],
    });
    const failed = service.links.call('srv-1', (hub) => hub.ping());
    await vi.advanceTimersByTimeAsync(0);

    const info = service.reconnect('srv-1');
    await failed;

    expect(info.serverId).toBe('srv-1');
    expect(opened.length).toBeGreaterThanOrEqual(2);
    expect(service.roles('srv-1')).toEqual(['operator']);
    expect(coreErrorCode(new Error('plain'))).toBeNull();
  });
});
