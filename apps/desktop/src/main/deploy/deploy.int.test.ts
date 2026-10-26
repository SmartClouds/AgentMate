import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeploySetupProgressEvent } from '../../shared/deployTypes';
import { tempDir } from '../../test/main/fixtures';
import { SshConnectionPool } from '../ssh/pool';
import { localArtifactSource, type ReleaseSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { bridgeTransport, streamLocalTransport } from './connection/transport';
import { DeployService } from './service';
import { DeployState } from './state';
import { DeploySystem } from './system';
import {
  DISTRO_IMAGES,
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  type TestServerImage,
  testServerImages,
} from './testing/testServers';

/**
 * The whole install on real machines: systemd test servers in Docker, the published linux-x64
 * release, real sshd, real sudo that asks for the password, and the app's own pool, service and
 * REST client. Needs RUNOVA_SYSTEM_TESTS=1, Docker, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
const onUbuntu = testServerImages(['ubuntu-24.04'], ['ubuntu-24.04']).length > 0;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const UNIT = join(REPO, 'apps', 'server-core', 'packaging', 'runova-core.service');
const INSTALL_TIMEOUT_MS = 600_000;

type Login = keyof typeof TEST_LOGINS;

/** Asks again every half second until `done` holds, or fails saying what it waited for. */
async function until(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const servers: TestServer[] = [];

/**
 * Every step the running test's services reported, with the seconds since the test began. Printed
 * with each server's journal when a test fails, since the CI log is all there is to go on.
 */
const reported: string[] = [];
let testStarted = Date.now();

beforeEach(() => {
  testStarted = Date.now();
});

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(
      [
        `Steps of "${context.task.name}":`,
        ...reported,
        ...servers.map((server) => server.diagnose()),
      ].join('\n'),
    );
  }
  reported.length = 0;
  for (const server of servers.splice(0)) server.stop();
});

function deploy(
  server: TestServer,
  login: Login,
  releases: ReleaseSource = localArtifactSource(ARTIFACTS),
) {
  const { username, password } = TEST_LOGINS[login];
  const pool = new SshConnectionPool({
    endpoint: async () => ({
      host: server.host,
      port: server.port,
      username,
      authMethod: 'password',
      password,
    }),
    trustHostKey: async () => undefined,
  });
  let file: unknown = null;
  const events: DeploySetupProgressEvent[] = [];
  const service = new DeployService({
    servers: async () => [
      {
        id: 'srv',
        nickname: 'Test server',
        host: server.host,
        port: server.port,
        username,
        authMethod: 'password',
        secretEnvelope: 'saved',
      },
    ],
    pool,
    state: new DeployState({
      read: async () => file,
      write: async (value) => {
        file = value;
      },
    }),
    releases,
    // The device key is sealed with a stand-in; the vault itself is tested on its own.
    seal: async (plaintext) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Integration test',
    availableVersion: async () => '0.0.0-dev',
    devCorePort: null,
    progress: (event) => {
      events.push(event);
      const seconds = ((Date.now() - testStarted) / 1000).toFixed(1);
      reported.push(`${seconds}s ${JSON.stringify(event.progress)}`);
    },
  });
  return { service, pool, events };
}

/** A release whose program exits at once, to prove a failed start goes back to the last one. */
function brokenRelease(): ReleaseSource {
  const dir = tempDir();
  const content = join(dir, 'content');
  mkdirSync(content);
  writeFileSync(
    join(content, 'runova-core'),
    '#!/bin/sh\necho "this build is broken" >&2\nexit 1\n',
  );
  copyFileSync(UNIT, join(content, 'runova-core.service'));
  const file = 'runova-core-0.0.1-broken-linux-x64.tar.gz';
  execFileSync('tar', ['-czf', join('..', file), '.'], { cwd: content });
  const localPath = join(dir, file);
  const sha256 = createHash('sha256').update(readFileSync(localPath)).digest('hex');
  return {
    release: async (rid) => ({ version: '0.0.1-broken', rid, file, sha256, localPath }),
  };
}

/** The real release, announced with a checksum it does not have. */
function tamperedRelease(): ReleaseSource {
  const real = localArtifactSource(ARTIFACTS);
  return {
    release: async (rid) => ({ ...(await real.release(rid)), sha256: 'e'.repeat(64) }),
  };
}

async function freshInstall(image: TestServerImage, login: Login, options = {}) {
  const server = await startTestServer(image, options);
  servers.push(server);
  const { service, pool, events } = deploy(server, login);
  const result = await service.install({ serverId: 'srv', sudoPassword: null });
  const health = await service.health('srv');
  return { server, service, pool, events, result, health };
}

/** Ubuntu and Rocky on every CI run; the nightly matrix adds Debian. */
const INSTALL_IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04', 'rocky-9']);

describe.skipIf(!enabled)('installing the server core on real servers', () => {
  skipWhenNoServers(INSTALL_IMAGES);
  for (const image of INSTALL_IMAGES) {
    for (const login of ['root', 'deployer'] as const) {
      it(
        `goes from nothing to a core that answers on ${image} as ${login}`,
        async () => {
          const { server, result, health, pool } = await freshInstall(image, login);

          expect(result).toMatchObject({
            version: '0.0.0-dev',
            transport: 'streamlocal',
            previousVersion: null,
          });
          expect(health.version).toBe('0.0.0-dev');
          expect(server.run('stat -c "%U:%G %a" /run/runova-core/core.sock')).toBe(
            'root:runova 660',
          );
          expect(server.run('stat -c "%a" /var/lib/runova-core')).toBe('700');
          expect(server.run('systemctl is-active runova-core')).toBe('active');
          if (login === 'deployer') {
            expect(server.run('id -nG deployer').split(' ')).toContain('runova');
          }
          pool.closeAll();
        },
        INSTALL_TIMEOUT_MS,
      );
    }
  }
});

// The rest checks the core itself rather than the distro, so it stays on Ubuntu.
describe.skipIf(!enabled || !onUbuntu)('the server core on a real Ubuntu server', () => {
  it(
    'creates the owner, enrolls this computer and signs in through the tunnel and the hub',
    async () => {
      const server = await startTestServer('ubuntu-24.04');
      servers.push(server);
      const { service, pool } = deploy(server, 'deployer');

      const result = await service.install({
        serverId: 'srv',
        sudoPassword: null,
        account: { userName: 'maria', password: 'correct horse battery staple' },
      });
      const access = await service.access('srv');
      const account = await service.account('srv');
      const stepUp = await service.stepUp({
        serverId: 'srv',
        password: 'correct horse battery staple',
      });
      const totp = await service.beginTotp('srv');

      expect(result.enrollmentError).toBeUndefined();
      expect(access).toMatchObject({
        state: 'signed-in',
        user: { userName: 'maria', roles: ['owner'] },
      });
      expect(account.userName).toBe('maria');
      expect(stepUp.stepUpUntilUnixMs).toBeGreaterThan(Date.now());
      expect(totp.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(server.run('/opt/runova-core/current/runova-core admin status')).toContain(
        '"userName":"maria","roles":["owner"],"devices":1',
      );
      await service.signOut('srv');
      expect((await service.access('srv')).state).toBe('needs-sign-in');
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    'streams live metrics through the tunnel on the lasting connection (E05 AC1)',
    async () => {
      const server = await startTestServer('ubuntu-24.04');
      servers.push(server);
      const { service, pool } = deploy(server, 'deployer');
      await service.install({
        serverId: 'srv',
        sudoPassword: null,
        account: { userName: 'maria', password: 'correct horse battery staple' },
      });
      const system = new DeploySystem({ links: service.links, roles: (id) => service.roles(id) });

      const samples: number[] = [];
      const stop = service.links.watchMetrics('srv', 1_000, (sample) => {
        samples.push(sample.atUnixMs);
      });
      const info = await system.info('srv');
      await until(() => samples.length >= 2, 30_000, 'two live samples');
      stop();

      expect(info.os.family).toBe('debian');
      expect(service.connection('srv').state).toBe('online');
      expect(samples[1]).toBeGreaterThan(samples[0]);
      service.links.closeAll();
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    'stops every process of a job it cancels, with the transient unit (E05 AC2)',
    async () => {
      const server = await startTestServer('ubuntu-24.04');
      servers.push(server);
      const { service, pool } = deploy(server, 'deployer');
      const password = 'correct horse battery staple';
      await service.install({
        serverId: 'srv',
        sudoPassword: null,
        account: { userName: 'maria', password },
      });
      const system = new DeploySystem({ links: service.links, roles: (id) => service.roles(id) });

      const job = await system.upgradeAll({ serverId: 'srv', password });
      let final: string | undefined;
      service.links.watchJob('srv', job.id, 0, {
        lines: () => undefined,
        ended: (end) => {
          final = end.job?.state ?? end.error;
        },
      });
      await system.cancelJob('srv', job.id);
      await until(() => final !== undefined, 60_000, 'the job to end');

      expect(final).toBe('cancelled');
      await until(
        () =>
          server.run("systemctl list-units --all --no-legend 'runova-*-*' || true") === '' &&
          server.run("pgrep -fa '[a]pt-get|[d]pkg|[d]nf' || true") === '',
        30_000,
        'the unit and its processes to be gone',
      );
      service.links.closeAll();
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    'refuses a download that does not match its checksum, and the running core carries on',
    async () => {
      const { server, pool } = await freshInstall('ubuntu-24.04', 'deployer');
      const before = server.run('readlink -f /opt/runova-core/current');

      const tampered = deploy(server, 'deployer', tamperedRelease());
      await expect(
        tampered.service.install({ serverId: 'srv', sudoPassword: null }),
      ).rejects.toThrow(/does not match its published checksum/);

      expect(server.run('readlink -f /opt/runova-core/current')).toBe(before);
      expect(server.run('ls /opt/runova-core/releases')).not.toContain('eeeeeeeeeeee');
      expect(server.run('systemctl is-active runova-core')).toBe('active');
      tampered.pool.closeAll();
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    'goes back to the previous release when an upgrade will not start',
    async () => {
      const { server, pool } = await freshInstall('ubuntu-24.04', 'deployer');
      const good = server.run('readlink -f /opt/runova-core/current');

      const broken = deploy(server, 'deployer', brokenRelease());
      await expect(broken.service.install({ serverId: 'srv', sudoPassword: null })).rejects.toThrow(
        /did not start.*went back to 0\.0\.0-dev/s,
      );

      expect(server.run('readlink -f /opt/runova-core/current')).toBe(good);
      expect(server.run('systemctl is-active runova-core')).toBe('active');
      const lease = await broken.pool.acquire('srv');
      try {
        const health = await new CoreHttpClient(streamLocalTransport(lease.connection)).health();
        expect(health.version).toBe('0.0.0-dev');
      } finally {
        lease.release();
      }
      broken.pool.closeAll();
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );

  it(
    "reaches the core through its bridge when the server's SSH forbids tunnels",
    async () => {
      const { result, health, pool } = await freshInstall('ubuntu-24.04', 'deployer', {
        streamLocal: false,
      });

      expect(result.transport).toBe('bridge');
      expect(health.version).toBe('0.0.0-dev');
      const lease = await pool.acquire('srv');
      try {
        await expect(
          new CoreHttpClient(streamLocalTransport(lease.connection)).health(),
        ).rejects.toThrow();
        const bridged = await new CoreHttpClient(bridgeTransport(lease.connection)).health();
        expect(bridged.version).toBe('0.0.0-dev');
      } finally {
        lease.release();
      }
      pool.closeAll();
    },
    INSTALL_TIMEOUT_MS,
  );
});
