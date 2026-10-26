import { describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type {
  ChallengeResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { TunnelRefusedError } from '../ssh/connection';
import type { CoreRest } from './auth/coreSessions';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './bootstrap/testing/scriptedServer';
import { CoreHttpError } from './connection/coreHttp';
import type { CoreTransport } from './connection/transport';
import { DEV_SERVER_ID, DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * Joining a core with an Owner's enrollment code: no root shell and no sudo, only the code, the
 * user name and the password. This computer makes its own key, seals the private half like an SSH
 * enrollment does, and signs in. On a server whose core another computer installed, the app first
 * finds out how to reach it, and says plainly when the login is not allowed to.
 */

const PASSWORD = 'another long passphrase';
const CODE = 'ABCDE-FGHIJ-KLMNP-QRSTU';
const INSTALLED = {
  release: '/opt/runova-core/releases/1.53.0-abababababab',
  version: '1.53.0',
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

const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: INSTALLED.release,
  transport: 'streamlocal',
  installedAt: 1,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};

function fakeCore() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const refusals = new Map<string, string>();
  const rest: CoreRest = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      calls.push({ path, body: body as Record<string, unknown> });
      const refusal = refusals.get(path);
      if (refusal) {
        throw new CoreHttpError('refused', 401, { code: refusal, message: `refused: ${refusal}` });
      }
      if (path === '/api/v1/auth/challenge') {
        return {
          challengeId: 'c1',
          nonce: 'n1',
          expiresAtUnixMs: Date.now() + 60_000,
        } satisfies ChallengeResponse as T;
      }
      if (path === '/api/v1/auth/enroll') return { deviceId: 'device-from-code' } as T;
      return {
        sessionId: 'session-1',
        accessToken: 'token-1',
        accessTokenExpiresAtUnixMs: Date.now() + 15 * 60_000,
        user: { id: 'u2', userName: 'sam', roles: ['operator'], twoFactorEnabled: false },
      } satisfies SignedInResponse as T;
    },
  };
  return { rest, calls, refuse: (path: string, code: string) => refusals.set(path, code) };
}

function setup(
  machine: Partial<ScriptedMachine> = {},
  options: { record?: DeployCoreRecord | null; deps?: Partial<DeployServiceDeps> } = {},
) {
  const server = new ScriptedConnection(scriptedMachine({ installed: INSTALLED, ...machine }));
  const pool = {
    acquire: vi.fn(async () => ({ connection: server, release: () => undefined })),
    reset: vi.fn(),
  };
  let content: unknown =
    options.record === null
      ? null
      : { version: 1, cores: { 'srv-1': options.record ?? RECORD }, devices: {} };
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const sealed: string[] = [];
  const core = fakeCore();
  const healthChecks: string[] = [];
  const deps: DeployServiceDeps = {
    servers: async () => SAVED,
    pool,
    state,
    releases: {
      release: async () => {
        throw new Error('nothing to install here');
      },
    },
    availableVersion: async () => null,
    devCorePort: null,
    progress: () => undefined,
    healthOf: async (transport: CoreTransport) => {
      healthChecks.push(transport.kind);
      return { status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 1 };
    },
    seal: async (plaintext) => {
      sealed.push(plaintext);
      return {
        mode: 'safeStorage',
        ciphertext: Buffer.from(plaintext).toString('base64'),
      } satisfies SecretEnvelope;
    },
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Sams-Laptop',
    rest: () => core.rest,
    now: () => 1_000,
    ...options.deps,
  };
  return { service: new DeployService(deps), server, state, sealed, core, pool, healthChecks };
}

const redeem = { serverId: 'srv-1', code: CODE, userName: 'sam', password: PASSWORD };

describe('DeployService redeeming an enrollment code', () => {
  it('enrolls a fresh key with the code and password, seals it, and signs in', async () => {
    const { service, state, sealed, core, server } = setup();

    const access = await service.redeemEnrollmentCode(redeem);

    expect(access).toEqual({
      state: 'signed-in',
      user: { userName: 'sam', roles: ['operator'], twoFactorEnabled: false },
    });
    expect(core.calls.map((call) => call.path)).toEqual([
      '/api/v1/auth/enroll',
      '/api/v1/auth/challenge',
      '/api/v1/auth/login',
    ]);
    expect(core.calls[0].body).toMatchObject({
      code: CODE,
      userName: 'sam',
      password: PASSWORD,
      deviceName: 'Sams-Laptop',
    });
    expect(await state.device('srv-1')).toMatchObject({
      deviceId: 'device-from-code',
      userName: 'sam',
      sessionId: 'session-1',
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(JSON.stringify(await state.device('srv-1'))).not.toContain('BEGIN PRIVATE KEY');
    // Nothing ran as root, and nothing secret went near a command line.
    expect(server.rootCommands).toEqual([]);
    expect(JSON.stringify(server.commands)).not.toContain(PASSWORD);
  });

  it('learns how to reach a core another computer installed, and keeps it once enrolled', async () => {
    const { service, state, healthChecks } = setup({}, { record: null });

    await service.redeemEnrollmentCode(redeem);

    expect(healthChecks).toEqual(['streamlocal']);
    expect(await state.get('srv-1')).toEqual({
      version: '1.53.0',
      release: INSTALLED.release,
      transport: 'streamlocal',
      layout: 'runova',
      installedAt: 1_000,
      os: 'Ubuntu 24.04.1 LTS',
      architecture: 'x86_64',
    });
    expect((await service.listServers())[0]).toMatchObject({ enrolled: true });
  });

  it('goes through the bridge when sshd forbids the tunnel', async () => {
    const { service, state, healthChecks } = setup({ streamLocal: false }, { record: null });

    await service.redeemEnrollmentCode(redeem);

    expect(healthChecks).toEqual(['bridge']);
    expect((await state.get('srv-1'))?.transport).toBe('bridge');
  });

  it('tries the bridge when the tunnel is refused at the socket', async () => {
    const probes: string[] = [];
    const { service, state } = setup(
      {},
      {
        record: null,
        deps: {
          healthOf: async (transport) => {
            probes.push(transport.kind);
            if (transport.kind === 'streamlocal') throw new TunnelRefusedError('no tunnel', 2);
            return { status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 1 };
          },
        },
      },
    );

    await service.redeemEnrollmentCode(redeem);

    expect(probes).toEqual(['streamlocal', 'bridge']);
    expect((await state.get('srv-1'))?.transport).toBe('bridge');
  });

  it('says what to ask for when the login is not in the runova group, and keeps nothing', async () => {
    const { service, state, core } = setup({ groups: ['deployer'] }, { record: null });

    await expect(service.redeemEnrollmentCode(redeem)).rejects.toThrow(
      /not in the runova group.*sudo usermod -aG runova deployer/,
    );
    expect(core.calls).toEqual([]);
    expect(await state.get('srv-1')).toBeNull();
    expect(await state.device('srv-1')).toBeNull();
  });

  it('logs in again when the login was added to the group after it started', async () => {
    const { service, pool } = setup(
      { groups: ['deployer'], configuredGroups: ['deployer', 'runova'] },
      { record: null },
    );

    await service.redeemEnrollmentCode(redeem);

    expect(pool.reset).toHaveBeenCalledWith('srv-1');
  });

  it('needs no group for a root login', async () => {
    const { service } = setup({ uid: 0, groups: ['root'] }, { record: null });

    await expect(service.redeemEnrollmentCode(redeem)).resolves.toMatchObject({
      state: 'signed-in',
    });
  });

  it('says so when no core runs on the server', async () => {
    const { service, core } = setup({ installed: null }, { record: null });

    await expect(service.redeemEnrollmentCode(redeem)).rejects.toThrow(
      'The server core is not installed on this server yet.',
    );
    expect(core.calls).toEqual([]);
  });

  it('keeps nothing when the core refuses the code, and says why with its code', async () => {
    const { service, state, core, sealed } = setup({}, { record: null });
    core.refuse('/api/v1/auth/enroll', 'enrollmentCodeInvalid');

    await expect(service.redeemEnrollmentCode(redeem)).rejects.toThrow(
      '[core:enrollmentCodeInvalid] refused: enrollmentCodeInvalid',
    );
    expect(await state.get('srv-1')).toBeNull();
    expect(await state.device('srv-1')).toBeNull();
    expect(sealed).toEqual([]);
  });

  it('leaves the second factor for the sign-in dialog when two-factor is on', async () => {
    const { service, state, core } = setup();
    core.refuse('/api/v1/auth/login', 'totpRequired');

    const access = await service.redeemEnrollmentCode(redeem);

    expect(access).toEqual({ state: 'needs-sign-in' });
    expect((await state.device('srv-1'))?.deviceId).toBe('device-from-code');
  });

  it('starts the lasting connection over and tells the watcher, as every other sign-in does', async () => {
    const serversChanged = vi.fn();
    const { service } = setup({}, { deps: { serversChanged } });
    const reset = vi.spyOn(service.links, 'reset');

    await service.redeemEnrollmentCode(redeem);

    expect(reset).toHaveBeenCalledWith('srv-1');
    expect(serversChanged).toHaveBeenCalledTimes(1);
  });

  it('starts over too when the code from the authenticator app is still to come', async () => {
    const serversChanged = vi.fn();
    const { service, core } = setup({}, { deps: { serversChanged } });
    core.refuse('/api/v1/auth/login', 'totpRequired');
    const reset = vi.spyOn(service.links, 'reset');

    await service.redeemEnrollmentCode(redeem);

    expect(reset).toHaveBeenCalledWith('srv-1');
    expect(serversChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves the connection alone when the code is refused', async () => {
    const serversChanged = vi.fn();
    const { service, core } = setup({}, { record: null, deps: { serversChanged } });
    core.refuse('/api/v1/auth/enroll', 'enrollmentCodeInvalid');
    const reset = vi.spyOn(service.links, 'reset');

    await expect(service.redeemEnrollmentCode(redeem)).rejects.toThrow();

    expect(reset).not.toHaveBeenCalled();
    expect(serversChanged).not.toHaveBeenCalled();
  });

  it('passes any other refused sign-in on', async () => {
    const { service, core } = setup();
    core.refuse('/api/v1/auth/login', 'lockedOut');

    await expect(service.redeemEnrollmentCode(redeem)).rejects.toThrow('[core:lockedOut]');
  });

  it('redeems on the DevHost over its loopback port, with nothing to find out first', async () => {
    const { service, state, server } = setup({}, { record: null, deps: { devCorePort: 7810 } });

    await service.redeemEnrollmentCode({ ...redeem, serverId: DEV_SERVER_ID });

    expect((await state.device(DEV_SERVER_ID))?.deviceId).toBe('device-from-code');
    expect(server.commands).toEqual([]);
  });
});
