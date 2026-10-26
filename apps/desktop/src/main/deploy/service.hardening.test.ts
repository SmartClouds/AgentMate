import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChallengeResponse,
  SignedInResponse,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployRestoreProgress } from '../../shared/deployHardeningTypes';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { tempDir } from '../../test/main/fixtures';
import type { CoreRest } from './auth/coreSessions';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './bootstrap/testing/scriptedServer';
import { CoreHttpError } from './connection/coreHttp';
import { DEV_SERVER_ID, DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * The Security center's part of the service (E15): a failed core update leaves the app to
 * reconnect to whichever release runs, a restore enrolls this computer on the restored core and
 * signs in, and the saved login method and the release this build installs are told to the
 * checklist.
 */

const RECORD: DeployCoreRecord = {
  version: '1.52.0',
  release: '/opt/runova-core/releases/1.52.0-cdcdcdcdcdcd',
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
  {
    id: 'srv-2',
    nickname: 'Keys',
    host: 'keys.example',
    port: 22,
    username: 'root',
    authMethod: 'privateKey' as const,
  },
];

function rest(refuseLogin?: string): CoreRest {
  return {
    post: async <T>(path: string): Promise<T> => {
      if (path === '/api/v1/auth/challenge') {
        return {
          challengeId: 'c1',
          nonce: 'n1',
          expiresAtUnixMs: Date.now() + 60_000,
        } satisfies ChallengeResponse as T;
      }
      if (refuseLogin)
        throw new CoreHttpError('refused', 401, {
          code: refuseLogin,
          message: `refused: ${refuseLogin}`,
        });
      return {
        sessionId: 'session-1',
        accessToken: 'token-1',
        accessTokenExpiresAtUnixMs: Date.now() + 15 * 60_000,
        user: { id: 'u1', userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
      } satisfies SignedInResponse as T;
    },
  };
}

function setup(machine: Partial<ScriptedMachine> = {}, deps: Partial<DeployServiceDeps> = {}) {
  const server = new ScriptedConnection(
    scriptedMachine({ coreUsers: [{ userName: 'maria', roles: ['owner'] }], ...machine }),
  );
  let content: unknown = { version: 1, cores: { 'srv-1': RECORD }, devices: {} };
  const state = new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
  const service = new DeployService({
    servers: async () => SAVED,
    pool: {
      acquire: vi.fn(async () => ({ connection: server, release: () => undefined })),
      reset: vi.fn(),
    },
    state,
    releases: {
      release: async (rid) => {
        const localPath = join(tempDir(), 'core.tar.gz');
        writeFileSync(localPath, 'tarball');
        return {
          version: '1.53.0',
          rid,
          file: `runova-core-1.53.0-${rid}.tar.gz`,
          sha256: 'ab'.repeat(32),
          localPath,
        };
      },
    },
    availableVersion: async () => '1.53.0',
    devCorePort: null,
    progress: () => undefined,
    healthOf: async () => ({ status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 1 }),
    seal: async (plaintext) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Laptop',
    rest: () => rest(),
    now: () => 1_000,
    ...deps,
  });
  const reset = vi.spyOn(service.links, 'reset');
  const file = join(tempDir(), 'web.ambackup');
  writeFileSync(file, 'AMBACKUP ciphertext');
  return { service, server, state, reset, file };
}

const RESTORE = {
  serverId: 'srv-1',
  passphrase: 'orange tractor bicycle lamp',
  sudoPassword: 'deployer-pw',
  userName: 'maria',
  password: 'correct horse battery staple',
};

describe('DeployService core updates', () => {
  it('starts the lasting connection over after a failed update, so the app reconnects', async () => {
    const { service, reset } = setup({
      installed: { release: RECORD.release, version: RECORD.version },
      failures: [{ match: 'systemctl restart runova-core', stderr: 'Job failed' }],
    });

    await expect(
      service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' }),
    ).rejects.toThrow(/did not start/);
    expect(reset).toHaveBeenCalledWith('srv-1');
  });

  it('tells the checklist the release it installs and how each server is logged in to', async () => {
    const { service } = setup({}, { devCorePort: 7810 });

    expect(await service.availableCoreVersion()).toBe('1.53.0');
    expect(await service.loginMethod('srv-1')).toBe('password');
    expect(await service.loginMethod('srv-2')).toBe('privateKey');
    expect(await service.loginMethod(DEV_SERVER_ID)).toBeNull();
  });
});

describe('DeployService.restore', () => {
  it('restores, enrolls this computer as the Owner and signs in', async () => {
    const { service, state, reset, file } = setup();
    const progress: DeployRestoreProgress[] = [];

    const result = await service.restore({ ...RESTORE, file }, (event) => progress.push(event));

    expect(result).toMatchObject({ backupHostName: 'old-web', backupCoreVersion: '1.52.0' });
    expect(result.signInError).toBeUndefined();
    expect(await state.device('srv-1')).toMatchObject({ deviceId: 'device-1', userName: 'maria' });
    expect(progress.at(-1)).toMatchObject({ phase: 'sign-in', status: 'done' });
    expect(reset).toHaveBeenCalledWith('srv-1');
  });

  it('keeps the restore when only the sign-in fails, and says why', async () => {
    const { service, file } = setup({}, { rest: () => rest('invalidCredentials') });

    const result = await service.restore({ ...RESTORE, file }, () => undefined);

    expect(result.signInError).toMatch(/invalidCredentials/);
  });

  it('starts the connection over even when the restore fails', async () => {
    const { service, reset, file } = setup({
      failures: [
        {
          match: 'admin restore-stage',
          stderr: 'The passphrase is wrong, or the backup file is damaged.',
        },
      ],
    });

    await expect(service.restore({ ...RESTORE, file }, () => undefined)).rejects.toThrow(
      /passphrase is wrong/,
    );
    expect(reset).toHaveBeenCalledWith('srv-1');
  });

  it('needs a core on the server and is not for the DevHost', async () => {
    const { service, file } = setup({}, { devCorePort: 7810 });

    await expect(
      service.restore({ ...RESTORE, serverId: 'srv-2', file }, () => undefined),
    ).rejects.toThrow(/not installed/);
    await expect(
      service.restore({ ...RESTORE, serverId: DEV_SERVER_ID, file }, () => undefined),
    ).rejects.toThrow(/DevHost/);
  });
});
