import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HealthResponse } from '../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployCoreRecord, DeploySetupProgressEvent } from '../../shared/deployTypes';
import { tempDir } from '../../test/main/fixtures';
import { TunnelRefusedError } from '../ssh/connection';
import type { ReleaseSource } from './bootstrap/releaseSource';
import {
  ScriptedConnection,
  type ScriptedMachine,
  scriptedMachine,
} from './bootstrap/testing/scriptedServer';
import type { CoreTransport } from './connection/transport';
import { DEV_SERVER_ID, DeployService, type DeployServiceDeps } from './service';
import { DeployState } from './state';

/**
 * The Deploy section's main-process side: the saved servers with their cores, a preflight, one
 * install or removal at a time per server, and a health check through whichever channel the
 * install found works.
 */

const SHA = 'ab'.repeat(32);

const SAVED = [
  {
    id: 'srv-1',
    nickname: 'Production',
    host: 'prod.example',
    port: 22,
    username: 'deployer',
    authMethod: 'password' as const,
    secretEnvelope: { v: 1, data: 'sealed' },
  },
  {
    id: 'srv-2',
    nickname: 'Staging',
    host: 'staging.example',
    port: 2222,
    username: 'ops',
    authMethod: 'privateKey' as const,
  },
];

const RECORD: DeployCoreRecord = {
  version: '1.52.0',
  release: '/opt/agentmate-core/releases/1.52.0-cdcdcdcdcdcd',
  transport: 'bridge',
  installedAt: 5,
  os: 'Rocky Linux 9.4 (Blue Onyx)',
  architecture: 'aarch64',
};

function memoryState(): DeployState {
  let content: unknown = null;
  return new DeployState({
    read: async () => content,
    write: async (value) => {
      content = value;
    },
  });
}

function releases(): ReleaseSource {
  const localPath = join(tempDir(), 'core.tar.gz');
  writeFileSync(localPath, 'tarball');
  return {
    release: async (rid) => ({
      version: '1.53.0',
      rid,
      file: `agentmate-core-1.53.0-${rid}.tar.gz`,
      sha256: SHA,
      localPath,
    }),
  };
}

/** Like a packaged build's source, whose release servers may download themselves. */
function publicReleases(): ReleaseSource {
  return {
    ...releases(),
    remote: (rid) => ({
      version: '1.53.0',
      rid,
      file: `agentmate-core-1.53.0-${rid}.tar.gz`,
      sha256: SHA,
      url: `https://github.com/SmartClouds/AgentMate/releases/download/v1.53.0/agentmate-core-1.53.0-${rid}.tar.gz`,
    }),
  };
}

function setup(machine: Partial<ScriptedMachine> = {}, overrides: Partial<DeployServiceDeps> = {}) {
  const server = new ScriptedConnection(scriptedMachine(machine));
  const released = vi.fn();
  const pool = {
    acquire: vi.fn(async (_serverId: string) => ({ connection: server, release: released })),
    reset: vi.fn(),
  };
  const events: DeploySetupProgressEvent[] = [];
  const transports: CoreTransport[] = [];
  const healthOf = vi.fn(async (transport: CoreTransport): Promise<HealthResponse> => {
    transports.push(transport);
    return { status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 99 };
  });
  const state = memoryState();
  const deps: DeployServiceDeps = {
    servers: async () => SAVED,
    pool,
    state,
    releases: releases(),
    availableVersion: async () => '1.53.0',
    devCorePort: null,
    progress: (event) => events.push(event),
    healthOf,
    seal: async (plaintext) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    now: () => 1_000,
    ...overrides,
  };
  return {
    server,
    pool,
    released,
    events,
    transports,
    healthOf,
    state,
    service: new DeployService(deps),
  };
}

describe('DeployService.listServers', () => {
  it('lists the saved servers with the core each one runs', async () => {
    const { state, service } = setup();
    await state.set('srv-2', RECORD);

    expect(await service.listServers()).toEqual([
      {
        id: 'srv-1',
        nickname: 'Production',
        host: 'prod.example',
        port: 22,
        username: 'deployer',
        core: null,
        enrolled: false,
      },
      {
        id: 'srv-2',
        nickname: 'Staging',
        host: 'staging.example',
        port: 2222,
        username: 'ops',
        core: RECORD,
        enrolled: false,
      },
    ]);
  });

  it('adds the DevHost only when a development build points at one', async () => {
    const withDevHost = setup({}, { devCorePort: 7810 }).service;

    const servers = await withDevHost.listServers();

    expect(servers[0]).toMatchObject({
      id: DEV_SERVER_ID,
      dev: true,
      core: { transport: 'dev-tcp' },
    });
    expect(servers.map((s) => s.id)).toEqual([DEV_SERVER_ID, 'srv-1', 'srv-2']);
    expect((await setup().service.listServers()).some((s) => s.dev)).toBe(false);
  });
});

describe('DeployService.preflight', () => {
  it('describes the server in terms the wizard shows', async () => {
    const { service, released } = setup({ streamLocal: false });

    const preflight = await service.preflight('srv-1');

    expect(preflight).toEqual({
      os: 'Ubuntu 24.04.1 LTS',
      supported: true,
      architecture: 'x86_64',
      architectureSupported: true,
      systemd: true,
      sudo: 'password',
      loginUser: 'deployer',
      hasSavedPassword: true,
      transport: 'bridge',
      selinux: 'absent',
      freeDiskMb: 19531,
      serverDownload: false,
      installed: null,
      available: '1.53.0',
      problems: [],
    });
    expect(released).toHaveBeenCalled();
  });

  it('says the server fetches the core itself when it reaches the release', async () => {
    const { service } = setup({ serverDownload: 'wget' }, { releases: publicReleases() });

    expect((await service.preflight('srv-1')).serverDownload).toBe(true);
  });

  it('says the app sends the core when the server cannot reach the release', async () => {
    const { service } = setup({ serverDownload: null }, { releases: publicReleases() });

    expect((await service.preflight('srv-1')).serverDownload).toBe(false);
  });

  it('knows a key login has no password to try for sudo', async () => {
    const { service } = setup();

    expect((await service.preflight('srv-2')).hasSavedPassword).toBe(false);
  });

  it('says so when this build has no core to install', async () => {
    const { service } = setup({}, { availableVersion: async () => null });

    const preflight = await service.preflight('srv-1');

    expect(preflight.available).toBeNull();
    expect(preflight.problems).toContain('This build of AgentMate has no server core to install.');
  });

  it('uses the reason the build gives for having no core', async () => {
    const { service } = setup(
      {},
      {
        availableVersion: async () => null,
        unavailableReason: 'Run pnpm server-core:publish first.',
      },
    );

    expect((await service.preflight('srv-1')).problems).toEqual([
      'Run pnpm server-core:publish first.',
    ]);
  });

  it('flags a processor there is no build for', async () => {
    const { service } = setup({ machine: 'riscv64' });

    const preflight = await service.preflight('srv-1');

    expect(preflight.architectureSupported).toBe(false);
    expect(preflight.problems.join(' ')).toMatch(/riscv64/);
  });

  it('refuses the DevHost', async () => {
    const { service } = setup({}, { devCorePort: 7810 });

    await expect(service.preflight(DEV_SERVER_ID)).rejects.toThrow(/DevHost/);
  });
});

describe('DeployService.install', () => {
  it('installs, remembers the core, and passes progress on with the server id', async () => {
    const { service, state, events, pool } = setup();

    const result = await service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });

    expect(result).toMatchObject({ version: '1.53.0', transport: 'streamlocal' });
    expect(await state.get('srv-1')).toEqual({
      version: '1.53.0',
      release: '/opt/agentmate-core/releases/1.53.0-abababababab',
      transport: 'streamlocal',
      installedAt: 1_000,
      os: 'Ubuntu 24.04.1 LTS',
      architecture: 'x86_64',
    });
    expect(events.every((event) => event.serverId === 'srv-1')).toBe(true);
    expect(events.at(-1)?.progress).toMatchObject({ phase: 'health', status: 'done' });
    // The non-root login had to log in again for its new group.
    expect(pool.reset).toHaveBeenCalledWith('srv-1');
  });

  it('runs one install per server at a time', async () => {
    const { service } = setup();

    const first = service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });
    const second = service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' });

    await expect(second).rejects.toThrow(/already/);
    await first;
    await expect(
      service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' }),
    ).resolves.toBeDefined();
  });

  it('keeps no record when the install fails', async () => {
    const { service, state } = setup({ failures: [{ match: 'tar -xzf', stderr: 'broken' }] });

    await expect(
      service.install({ serverId: 'srv-1', sudoPassword: 'deployer-pw' }),
    ).rejects.toThrow();
    expect(await state.get('srv-1')).toBeNull();
  });

  it('refuses the DevHost', async () => {
    const { service } = setup({}, { devCorePort: 7810 });

    await expect(service.install({ serverId: DEV_SERVER_ID, sudoPassword: null })).rejects.toThrow(
      /DevHost/,
    );
  });
});

describe('DeployService.uninstall', () => {
  it('removes the core and forgets it', async () => {
    const { service, state } = setup();
    await state.set('srv-1', RECORD);

    await service.uninstall({ serverId: 'srv-1', sudoPassword: 'deployer-pw', keepData: true });

    expect(await state.get('srv-1')).toBeNull();
  });
});

describe('DeployService.health', () => {
  it('asks the core through the channel the install recorded, then hands the login back', async () => {
    const { service, state, transports, released } = setup();
    await state.set('srv-1', RECORD);

    const health = await service.health('srv-1');

    expect(health).toEqual({
      version: '1.53.0',
      apiVersion: 1,
      startedAtUnixMs: 99,
      checkedAt: 1_000,
    });
    expect(transports.map((transport) => transport.kind)).toEqual(['bridge']);
    expect(released).toHaveBeenCalled();
  });

  it('switches to the bridge for good when sshd stops allowing the tunnel', async () => {
    const { service, state, transports } = setup(
      {},
      {
        healthOf: async (transport) => {
          transports.push(transport);
          if (transport.kind === 'streamlocal') {
            throw new TunnelRefusedError('Could not open a tunnel: open failed', 2);
          }
          return { status: 'ok', version: '1.53.0', apiVersion: 1, startedAtUnixMs: 99 };
        },
      },
    );
    await state.set('srv-1', { ...RECORD, transport: 'streamlocal' });

    expect((await service.health('srv-1')).version).toBe('1.53.0');
    expect(transports.map((transport) => transport.kind)).toEqual(['streamlocal', 'bridge']);
    expect((await state.get('srv-1'))?.transport).toBe('bridge');
  });

  it('says so for a server without a core', async () => {
    const { service } = setup();

    await expect(service.health('srv-1')).rejects.toThrow(/not installed/);
  });

  it('reaches the DevHost over loopback without SSH', async () => {
    const { service, transports, pool } = setup({}, { devCorePort: 7810 });

    await service.health(DEV_SERVER_ID);

    expect(transports.map((transport) => transport.kind)).toEqual(['dev-tcp']);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it('hands the login back when the core does not answer', async () => {
    const { service, state, released } = setup(
      {},
      {
        healthOf: async () => {
          throw new Error('The server core did not answer GET /api/v1/health in time.');
        },
      },
    );
    await state.set('srv-1', RECORD);

    await expect(service.health('srv-1')).rejects.toThrow(/did not answer/);
    expect(released).toHaveBeenCalled();
  });
});
