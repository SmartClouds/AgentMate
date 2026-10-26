import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BackupRunInfo,
  JobInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { tempDir } from '../../../test/main/fixtures';
import { SshConnectionPool } from '../../ssh/pool';
import { localArtifactSource } from '../bootstrap/releaseSource';
import { DeployService } from '../service';
import { buildContextTarball } from '../stacks/buildContext';
import { DeployStacks } from '../stacks/service';
import { DeployState } from '../state';
import {
  DISTRO_IMAGES,
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  type TestServerImage,
  testServerImages,
} from '../testing/testServers';

/**
 * Server backups on real machines (E28), with the published core on two systemd test servers that
 * each have a public address of their own (on a Docker network in the documentation range):
 *
 * - The first runs a compose stack and a container of its own, each with data in a volume. A plan
 *   keeping 2 runs three times into a folder on the server, which then holds 2 backups.
 * - The newest is fetched back from the folder by the core and downloaded to this computer, and
 *   restored onto the second server with nothing but the secret.
 * - Bringing it up there loads the images, writes the volumes back, starts the stack and the
 *   container, and reports the stack file that still names the old address. The restored plan is
 *   scheduled again on the new server.
 *
 * Needs RUNOVA_SYSTEM_TESTS=1, Docker, network access from the test servers (Docker's packages
 * and the backup helper image) and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();

const IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04']);
const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const TEST_TIMEOUT_MS = 3_000_000;
const PASSWORD = 'correct horse battery staple';
const SECRET = 'violet harbor lantern pebble';
const OLD_ADDRESS = '203.0.113.10';
const NEW_ADDRESS = '203.0.113.20';
const FOLDER = '/var/backups/runova-e28';

const COMPOSE = `services:
  web:
    image: busybox:1.37
    pull_policy: never
    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]
    restart: unless-stopped
    environment:
      PUBLIC_URL: http://${OLD_ADDRESS}:8090/
    ports:
      - "8090:8080"
    volumes:
      - www:/www
volumes:
  www:
`;

const servers: TestServer[] = [];
const cleanups: Array<() => void> = [];

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(servers.map((server) => server.diagnose()).join('\n'));
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const server of servers.splice(0)) server.stop();
  try {
    execFileSync('docker', ['network', 'rm', PUBLIC_NETWORK], { stdio: 'pipe' });
  } catch {
    // Never made, or already gone.
  }
});

/** A network in the documentation range, which the core counts as public. */
const PUBLIC_NETWORK = `runova-e28-public-${process.pid}`;

function joinPublicNetwork(server: TestServer, address: string): void {
  try {
    execFileSync('docker', ['network', 'inspect', PUBLIC_NETWORK], { stdio: 'pipe' });
  } catch {
    execFileSync('docker', ['network', 'create', '--subnet', '203.0.113.0/24', PUBLIC_NETWORK], {
      stdio: 'pipe',
    });
  }
  execFileSync('docker', ['network', 'connect', '--ip', address, PUBLIC_NETWORK, server.name], {
    stdio: 'pipe',
  });
}

interface Installed {
  server: TestServer;
  service: DeployService;
  hub: <T>(work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
}

/** A test server with a public address of its own, the core installed as root, and an owner. */
async function install(owner: string, image: TestServerImage, address: string): Promise<Installed> {
  const server = await startTestServer(image);
  servers.push(server);
  joinPublicNetwork(server, address);
  const pool = new SshConnectionPool({
    endpoint: async () => ({
      host: server.host,
      port: server.port,
      username: 'root',
      authMethod: 'password',
      password: TEST_LOGINS.root.password,
    }),
    trustHostKey: async () => undefined,
  });
  let file: unknown = null;
  const service = new DeployService({
    servers: async () => [
      {
        id: 'srv',
        nickname: 'Test server',
        host: server.host,
        port: server.port,
        username: 'root',
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
    releases: localArtifactSource(ARTIFACTS),
    seal: async (plaintext) => ({
      mode: 'safeStorage',
      ciphertext: Buffer.from(plaintext).toString('base64'),
    }),
    unseal: async (envelope) => Buffer.from(envelope.ciphertext, 'base64').toString(),
    deviceName: () => 'Backups system test',
    availableVersion: async () => '0.0.0-dev',
    devCorePort: null,
    progress: () => undefined,
  });
  cleanups.push(() => {
    service.links.closeAll();
    pool.closeAll();
  });
  const result = await service.install({
    serverId: 'srv',
    sudoPassword: null,
    account: { userName: owner, password: PASSWORD },
  });
  expect(result.enrollmentError).toBeUndefined();
  return { server, service, hub: (work) => service.withHub('srv', work) };
}

/** Copies an image from this computer's Docker into the test server's, without a registry. */
function loadImage(server: TestServer, image: string): void {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
  } catch {
    execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: 600_000 });
  }
  const archive = execFileSync('docker', ['save', image], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('docker', ['exec', '-i', server.name, 'docker', 'load'], {
    input: archive,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 900_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Gave up waiting: ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const finished = (run: BackupRunInfo) => run.state !== 'running';

/**
 * Follows a job by reading it again over a new connection each time: a Docker install can outlive
 * the 15 minutes a hub connection's session lasts.
 */
async function jobDone(
  installed: Installed,
  start: (hub: ICoreHub) => Promise<JobInfo>,
): Promise<JobInfo> {
  const job = await installed.hub(start);
  return until(
    `job ${job.id}`,
    () => installed.hub((hub) => hub.getJob(job.id)),
    (value) => value.state !== 'running',
    1_200_000,
  );
}

/** Docker through the core's own install job; a slow network can time the repository out once. */
async function installDocker(installed: Installed): Promise<void> {
  let job = await jobDone(installed, (hub) =>
    hub.installDocker({ removeConflictingPackages: true }),
  );
  for (let attempt = 1; attempt < 3 && job.state !== 'succeeded'; attempt++) {
    job = await jobDone(installed, (hub) => hub.installDocker({ removeConflictingPackages: true }));
  }
  expect(job.state, JSON.stringify(job)).toBe('succeeded');
}

describe.skipIf(!enabled)('server backups on real servers', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `keeps 2 of 3 scheduled backups and brings the server up again on a new address, on ${image}`,
      async () => {
        const first = await install('maria', image, OLD_ADDRESS);
        await first.service.stepUp({ serverId: 'srv', password: PASSWORD });
        await installDocker(first);
        loadImage(first.server, 'busybox:1.37');

        // A stack with data in a volume, and a container outside any stack with its own.
        const folder = tempDir('runova-backup-system-');
        for (const [path, content] of Object.entries({ 'compose.yaml': COMPOSE })) {
          mkdirSync(dirname(join(folder, path)), { recursive: true });
          writeFileSync(join(folder, path), content);
        }
        const stacks = new DeployStacks({
          links: { call: (_serverId, work) => first.hub(work) },
          roles: () => ['owner'],
          http: (_serverId, work) => first.service.withCoreHttp('srv', work),
          source: {
            project: async () => ({ id: 'p1', name: 'Site', folderPath: folder }) as Project,
            index: async (root) => ({ root, files: ['compose.yaml'], truncated: false }),
            environment: async () => ({ id: 'e1', name: 'Production', files: [], entries: [] }),
          },
          pack: buildContextTarball,
        });
        const source = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' };
        const preview = await stacks.preview(source);
        const created = await stacks.create({
          ...source,
          serverId: 'srv',
          name: 'site',
          proxiedServices: ['web'],
          acknowledgedRisks: preview.requiresAcknowledgment,
        });
        expect(created.revision.state, created.revision.error).toBe('ready');
        const deployed = await jobDone(first, () => stacks.deploy('srv', created.stack.id, 1));
        expect(deployed.state, JSON.stringify(deployed)).toBe('succeeded');
        first.server.run(
          `docker exec site-web-1 sh -c 'echo from the first server > /www/index.html'`,
        );
        first.server.run(
          'docker run -d --name keeper --restart unless-stopped -v notes:/data busybox:1.37 sleep 1d && docker exec keeper sh -c "echo kept > /data/note"',
        );

        // The secret, a folder on the server, and a plan keeping 2.
        await first.service.stepUp({ serverId: 'srv', password: PASSWORD });
        const secret = await first.hub((hub) => hub.setBackupSecret({ newSecret: SECRET }));
        expect(secret.isSet).toBe(true);
        const destination = await first.hub((hub) =>
          hub.saveBackupDestination({
            name: 'On the server',
            kind: 'folder',
            settings: { path: FOLDER },
          }),
        );
        const plan = await first.hub((hub) =>
          hub.saveBackupPlan({
            name: 'Nightly',
            enabled: true,
            cron: '0 3 * * *',
            timeZone: 'UTC',
            keepLast: 2,
            destinationIds: [destination.id],
          }),
        );
        expect(plan.nextRunAtUnixMs).toBeGreaterThan(Date.now());

        const runs: BackupRunInfo[] = [];
        for (let round = 0; round < 3; round++) {
          const started = await first.hub((hub) => hub.runBackupPlan(plan.id));
          const run = await until(
            `backup ${round + 1}`,
            () => first.hub((hub) => hub.getBackupRun(started.id)),
            finished,
          );
          expect(run.state, JSON.stringify(run)).toBe('succeeded');
          expect(run.targets[0]).toMatchObject({ state: 'succeeded', pruned: round === 2 ? 1 : 0 });
          runs.push(run);
        }
        const stored = await first.hub((hub) => hub.listStoredBackups(destination.id));
        expect(stored.map((backup) => backup.backupId).sort()).toEqual(
          runs
            .slice(1)
            .map((run) => run.id)
            .sort(),
        );
        expect(first.server.run(`ls ${FOLDER} | grep -c 'manifest.json$'`)).toBe('2');
        // Encrypted on disk: neither the volume's text nor the stack file shows.
        expect(
          first.server.run(`cat ${FOLDER}/*.ambackup* | grep -c 'from the first server' || true`),
        ).toBe('0');

        // The newest comes back from the folder through the core and down to this computer.
        await first.service.stepUp({ serverId: 'srv', password: PASSWORD });
        const newest = runs[2];
        const fetchStarted = await first.hub((hub) =>
          hub.fetchStoredBackup(destination.id, newest.id),
        );
        const fetched = await until(
          'the fetch',
          () => first.hub((hub) => hub.getBackupFetch(fetchStarted.id)),
          (fetch) => fetch.state !== 'running',
        );
        expect(fetched.state, fetched.error).toBe('succeeded');
        expect(fetched.path).toMatch(/^\/var\/lib\/runova-core\/backups\/[0-9a-f]{32}\.ambackup$/);
        const file = join(tempDir(), 'server.ambackup');
        await first.service.withCoreHttp('srv', (client, token) =>
          client.download(`/api/v1/backups/${fetched.backupId}`, createWriteStream(file), {
            token,
            timeoutMs: 300_000,
          }),
        );

        // A second server with Docker and nothing else, at another address.
        const second = await install('sam', image, NEW_ADDRESS);
        await second.service.stepUp({ serverId: 'srv', password: PASSWORD });
        await installDocker(second);
        const restore = {
          serverId: 'srv',
          file,
          sudoPassword: null,
          userName: 'maria',
          password: PASSWORD,
        };
        await expect(
          second.service.restore(
            { ...restore, passphrase: 'violet harbor lantern stone' },
            () => undefined,
          ),
        ).rejects.toThrow(/secret key is wrong/);
        const restored = await second.service.restore(
          { ...restore, passphrase: SECRET },
          () => undefined,
        );
        expect(restored.signInError).toBeUndefined();
        expect((await second.service.account('srv')).userName).toBe('maria');

        // What waits to come up, with the move from the old address to the new.
        const pending = await second.hub((hub) => hub.getPendingServerRestore());
        expect(pending.oldAddresses).toEqual([OLD_ADDRESS]);
        expect(pending.newAddresses).toEqual([NEW_ADDRESS]);
        expect(pending.projects).toEqual(['site']);
        expect(pending.volumes).toBeGreaterThanOrEqual(2);
        expect(pending.containers).toBe(1);
        expect(pending.liveCopy).toBe(true);
        const stackFile = pending.addressChanges.find((change) => change.area === 'Stack file');
        expect(stackFile).toMatchObject({ from: OLD_ADDRESS, to: NEW_ADDRESS, automatic: false });

        await second.service.stepUp({ serverId: 'srv', password: PASSWORD });
        await second.hub((hub) => hub.runServerRestore({ moveAddresses: true }));
        const status = await until(
          'the server to come up',
          () => second.hub((hub) => hub.getServerRestoreStatus()),
          (value) => value.state !== 'running',
        );
        expect(status.state, JSON.stringify(status.steps)).toBe('succeeded');
        expect(status.applied.some((change) => change.area === 'Stack file')).toBe(true);

        // Running as the first did, with its data.
        const page = await until(
          'the stack to answer',
          async () => {
            try {
              return second.server.run('docker exec site-web-1 wget -qO- http://127.0.0.1:8080/');
            } catch {
              return '';
            }
          },
          (text) => text.length > 0,
          180_000,
        );
        expect(page).toBe('from the first server');
        expect(second.server.run("docker inspect -f '{{.State.Running}}' keeper")).toBe('true');
        expect(second.server.run('docker exec keeper cat /data/note')).toBe('kept');
        // Nothing waits any more, and the plan is on the new server's schedule.
        expect(
          second.server.run('test -d /var/lib/runova-core/server && echo left || echo gone'),
        ).toBe('gone');
        const plans = await second.hub((hub) => hub.listBackupPlans());
        expect(plans.map((p) => [p.name, p.keepLast])).toEqual([['Nightly', 2]]);
        expect(plans[0].nextRunAtUnixMs).toBeGreaterThan(Date.now());
      },
      TEST_TIMEOUT_MS,
    );
  }
});
