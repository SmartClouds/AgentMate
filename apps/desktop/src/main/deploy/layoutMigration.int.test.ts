import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SshConnectionPool } from '../ssh/pool';
import { localArtifactSource } from './bootstrap/releaseSource';
import { LEGACY_CORE, RUNOVA_CORE } from './coreLayout';
import { DeployService } from './service';
import { DeployState } from './state';
import {
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  testServerImages,
} from './testing/testServers';

/**
 * Moving a server set up before the rename to the Runova layout, on real machines: the published
 * 1.63.0 core installed the way the 1.63 app installed it, this app signing in to it, upgrading
 * it over SSH in its old layout (1.63 cores cannot update themselves), a move that fails and is
 * put back, and the move done again from the command line over SSH. Needs RUNOVA_SYSTEM_TESTS=1, Docker, GitHub (or the 1.63.0 tarball in
 * RUNOVA_LEGACY_CORE_TARBALL) and `SERVER_CORE_VERSION=1.64.0 pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
const IMAGES = testServerImages(['ubuntu-24.04', 'rocky-9'], ['ubuntu-24.04']);
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const TIMEOUT_MS = 900_000;
const PASSWORD = 'correct horse battery staple';

/** The last release before the rename, pinned by its checksum. */
const LEGACY_VERSION = '1.63.0';
const LEGACY_FILE = `${LEGACY_CORE.tarballPrefix}${LEGACY_VERSION}-linux-x64.tar.gz`;
const LEGACY_URL = `https://github.com/SmartClouds/AgentMate/releases/download/v${LEGACY_VERSION}/${LEGACY_FILE}`; // legacy-name
const LEGACY_SHA256 = '480ebf8ab10acc972e0641260c709c989a490375969531a31cb23a28c8fd5286';

const servers: TestServer[] = [];

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(servers.map((server) => server.diagnose()).join('\n'));
  }
  for (const server of servers.splice(0)) server.stop();
});

const sha256Of = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The 1.63.0 tarball, downloaded once into the temp folder and checked against its pin. */
async function legacyTarball(): Promise<string> {
  const given = process.env.RUNOVA_LEGACY_CORE_TARBALL;
  const path = given ?? join(tmpdir(), 'runova-legacy-core', LEGACY_FILE);
  if (!existsSync(path)) {
    mkdirSync(join(tmpdir(), 'runova-legacy-core'), { recursive: true });
    const response = await fetch(LEGACY_URL);
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${LEGACY_URL}`);
    const partial = `${path}.part`;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(partial, Buffer.from(await response.arrayBuffer()));
    renameSync(partial, path);
  }
  if (sha256Of(path) !== LEGACY_SHA256)
    throw new Error(`${path} is not the published ${LEGACY_FILE}.`);
  return path;
}

/** Installs 1.63.0 with the root commands the 1.63 app ran (its installPlan.ts). */
function installLegacyCore(server: TestServer, tarball: string): string {
  execFileSync('docker', ['cp', tarball, `${server.name}:/root/${LEGACY_FILE}`], {
    timeout: 120_000,
  });
  const release = `${LEGACY_CORE.releases}/${LEGACY_VERSION}-${LEGACY_SHA256.slice(0, 12)}`;
  server.run(
    [
      'set -e',
      `getent group ${LEGACY_CORE.group} >/dev/null || groupadd --system ${LEGACY_CORE.group}`,
      `usermod -aG ${LEGACY_CORE.group} deployer`,
      `install -d -m 0755 ${LEGACY_CORE.releases}`,
      `install -d -m 0755 ${release}`,
      `tar -xzf /root/${LEGACY_FILE} -C ${release} --no-same-owner --no-same-permissions`,
      `chown -R root:root ${release}`,
      `chmod 0755 ${release}/${LEGACY_CORE.binary}`,
      `chmod 0644 ${release}/${LEGACY_CORE.unitFile}`,
      'if command -v selinuxenabled >/dev/null && selinuxenabled; then restorecon -R /opt; fi',
      `install -m 0644 -o root -g root ${release}/${LEGACY_CORE.unitFile} ${LEGACY_CORE.unitPath}`,
      'systemctl daemon-reload',
      `ln -sfn ${release} ${LEGACY_CORE.current}`,
      `systemctl enable ${LEGACY_CORE.unit} >/dev/null 2>&1`,
      `systemctl restart ${LEGACY_CORE.unit}`,
    ].join('\n'),
  );
  return release;
}

/** This app as a 1.63 app left it: a record of the core without a layout, and no device yet. */
async function legacyApp(server: TestServer, release: string) {
  const { username, password } = TEST_LOGINS.deployer;
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
  const state = new DeployState({
    read: async () => file,
    write: async (value) => {
      file = value;
    },
  });
  await state.set('srv', {
    version: LEGACY_VERSION,
    release,
    transport: 'streamlocal',
    installedAt: 1,
    os: 'test',
    architecture: 'x86_64',
  });
  const steps: string[] = [];
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
    state,
    releases: localArtifactSource(ARTIFACTS),
    seal: async (plaintext) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Integration test',
    availableVersion: async () => '1.64.0',
    devCorePort: null,
    progress: (event) => steps.push(`${event.progress.phase}:${event.progress.status}`),
  });
  return { service, pool, state, steps };
}

const gidOf = (server: TestServer, group: string) =>
  server.run(`getent group ${group} | cut -d: -f3`);

describe.skipIf(!enabled)('moving a server from before the rename to the Runova layout', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `upgrades a 1.63 core in place, survives a failed move and then moves on ${image}`,
      async () => {
        const tarball = await legacyTarball();
        const server = await startTestServer(image);
        servers.push(server);
        const release = installLegacyCore(server, tarball);
        const gid = gidOf(server, LEGACY_CORE.group);
        const { service, pool, state } = await legacyApp(server, release);

        // Signing in to the old core: its old socket, Host name and signing prefix.
        await service.enroll({
          serverId: 'srv',
          sudoPassword: null,
          account: { userName: 'maria', password: PASSWORD },
        });
        expect((await service.access('srv')).state).toBe('signed-in');
        expect((await service.health('srv')).version).toBe(LEGACY_VERSION);

        // The new core refuses to start under its new unit, so the move has to be put back.
        server.run(
          `mkdir -p /etc/systemd/system/${RUNOVA_CORE.unitFile}.d && printf '[Service]\\nExecStartPre=/bin/false\\n' > /etc/systemd/system/${RUNOVA_CORE.unitFile}.d/10-fail.conf`,
        );
        // 1.63 cores cannot update themselves, so the upgrade goes over SSH, as the app does it.
        const installed = await service.install({ serverId: 'srv', sudoPassword: null });

        expect(installed).toMatchObject({ version: '1.64.0', layout: 'legacy' });
        expect(installed.migrationError).toMatch(/new name|start/i);
        expect(server.run(`systemctl is-active ${LEGACY_CORE.unit}`)).toBe('active');
        expect(server.run(`readlink -f ${LEGACY_CORE.current}`)).toMatch(
          new RegExp(`^${LEGACY_CORE.releases}/1\\.64\\.0-`),
        );
        expect(
          server.run(
            `test -d ${LEGACY_CORE.dataDirectory} && ! test -L ${LEGACY_CORE.dataDirectory} && echo real`,
          ),
        ).toBe('real');
        expect(server.run(`test -e ${RUNOVA_CORE.root} && echo there || echo gone`)).toBe('gone');
        expect(gidOf(server, LEGACY_CORE.group)).toBe(gid);
        const health = await service.health('srv');
        expect(health).toMatchObject({ version: '1.64.0', layout: 'legacy' });
        expect(health.migrationError).toBeTruthy();
        expect((await service.access('srv')).state).toBe('signed-in');

        // Again from the command line over SSH, as root, once the new unit can start.
        server.run(
          `rm -rf /etc/systemd/system/${RUNOVA_CORE.unitFile}.d && systemctl daemon-reload`,
        );
        server.run(`${LEGACY_CORE.current}/${RUNOVA_CORE.binary} migrate-layout`);

        const moved = await service.health('srv');
        expect(moved).toMatchObject({ version: '1.64.0', layout: 'runova' });
        expect((await state.get('srv'))?.layout).toBe('runova');
        expect(server.run(`systemctl is-active ${RUNOVA_CORE.unit}`)).toBe('active');
        expect(server.run(`systemctl is-enabled ${LEGACY_CORE.unit} 2>&1 || true`)).not.toBe(
          'enabled',
        );
        expect(gidOf(server, RUNOVA_CORE.group)).toBe(gid);
        expect(server.run(`getent group ${LEGACY_CORE.group} || echo none`)).toBe('none');
        expect(server.run(`id -nG deployer`).split(' ')).toContain(RUNOVA_CORE.group);
        // The old paths stay as links, for old apps and for containers that mount them.
        expect(server.run(`readlink ${LEGACY_CORE.dataDirectory}`)).toBe(RUNOVA_CORE.dataDirectory);
        expect(server.run(`readlink ${LEGACY_CORE.current}`)).toBe(RUNOVA_CORE.current);
        expect(server.run(`test -S ${LEGACY_CORE.socketPath} && echo socket`)).toBe('socket');
        // A boot makes the socket link again.
        server.run(
          `rm -f /run/${LEGACY_CORE.unit} && systemd-tmpfiles --create && test -S ${LEGACY_CORE.socketPath}`,
        );
        // Same keys, same database: the session and its secrets carry on.
        expect((await service.access('srv')).state).toBe('signed-in');
        expect((await service.account('srv')).userName).toBe('maria');
        expect(server.run(`${RUNOVA_CORE.binaryPath} admin status`)).toContain(
          '"userName":"maria"',
        );
        pool.closeAll();
      },
      TIMEOUT_MS,
    );
  }
});
