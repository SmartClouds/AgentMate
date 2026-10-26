import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConnection, IStreamResult } from '@microsoft/signalr';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ContainerLogLine,
  ContainerStatsBatch,
  JobInfo,
  JobStreamItem,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { SshConnectionPool } from '../ssh/pool';
import { CoreSessions } from './auth/coreSessions';
import { localArtifactSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { coreHub, createCoreHubConnection } from './connection/coreHub';
import { streamLocalTransport } from './connection/transport';
import { DeployService } from './service';
import { DeployState } from './state';
import {
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  testServerImages,
} from './testing/testServers';

/**
 * Docker on a real server, through the core's hub (E06): on the Rocky 9 test server the install
 * job takes podman out and brings Docker Engine and Compose up (AC4), then a container's stats,
 * redacted logs and lifecycle go through the same hub the app uses. The core is installed and
 * this computer enrolled with DeployService; the hub connection is the app's own, signed in with
 * the session that enrollment left. Needs RUNOVA_SYSTEM_TESTS=1, Docker, network access from
 * the test server, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
/** The podman conflict is a RHEL-family case, so this stays on Rocky. */
const onRocky = testServerImages(['rocky-9'], ['rocky-9']).length > 0;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const PASSWORD = 'correct horse battery staple';
const SECRET = 'hunter2-shop-secret-value';
const TEST_TIMEOUT_MS = 1_800_000;

const servers: TestServer[] = [];
const cleanups: Array<() => void> = [];

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(servers.map((server) => server.diagnose()).join('\n'));
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const server of servers.splice(0)) {
    // The images keep /var/lib/docker in anonymous volumes; they go with the server.
    const volumes = dockerVolumesOf(server);
    server.stop();
    if (volumes.length > 0) {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', ...volumes], { stdio: 'pipe' });
      } catch {
        // Already gone.
      }
    }
  }
});

function containerOf(server: TestServer): string {
  const lines = execFileSync('docker', ['ps', '--format', '{{.ID}} {{.Ports}}'], {
    encoding: 'utf-8',
  });
  const mapping = `:${server.port}->22/tcp`;
  const line = lines.split('\n').find((entry) => entry.includes(mapping));
  return line?.split(' ')[0] ?? '';
}

/** Like server.run, for steps that download packages over a slow network (up to 15 minutes). */
function runSlowly(server: TestServer, command: string): string {
  return execFileSync('docker', ['exec', containerOf(server), 'sh', '-c', command], {
    encoding: 'utf-8',
    timeout: 900_000,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
  }).trim();
}

function dockerVolumesOf(server: TestServer): string[] {
  try {
    const id = containerOf(server);
    if (!id) return [];
    return execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}',
        id,
      ],
      { encoding: 'utf-8' },
    )
      .trim()
      .split(' ')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Installs the core as root, creates the owner and enrolls this computer, then opens the hub. */
async function installAndConnect(server: TestServer): Promise<{ hub: ICoreHub; stop: () => void }> {
  const { username, password } = TEST_LOGINS.root;
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
  const seal = async (plaintext: string) => ({
    mode: 'safeStorage' as const,
    ciphertext: Buffer.from(plaintext).toString('base64'),
  });
  const unseal = async (envelope: { ciphertext: string }) =>
    Buffer.from(envelope.ciphertext, 'base64').toString();
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
    seal,
    unseal,
    deviceName: () => 'Docker system test',
    availableVersion: async () => '0.0.0-dev',
    devCorePort: null,
    progress: () => undefined,
  });
  const installed = await service.install({
    serverId: 'srv',
    sudoPassword: null,
    account: { userName: 'maria', password: PASSWORD },
  });
  expect(installed.enrollmentError).toBeUndefined();

  const lease = await pool.acquire('srv');
  const transport = streamLocalTransport(lease.connection);
  const sessions = new CoreSessions({
    state,
    unseal,
    withCore: (_serverId, work) => work(new CoreHttpClient(transport)),
  });
  await sessions.signIn('srv', { password: PASSWORD });
  const connection: HubConnection = createCoreHubConnection(transport, () =>
    sessions.accessToken('srv'),
  );
  await connection.start();
  return {
    hub: coreHub(connection),
    stop: () => {
      void connection.stop();
      lease.release();
      pool.closeAll();
    },
  };
}

/** Items of a hub stream until one passes the check, or the time runs out. */
function readUntil<T>(
  stream: IStreamResult<T>,
  done: (items: T[]) => boolean,
  timeoutMs: number,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(
        new Error(`The stream did not get there in time: ${JSON.stringify(items).slice(-2_000)}`),
      );
    }, timeoutMs);
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      subscription.dispose();
      if (error) reject(error);
      else resolve(items);
    };
    const subscription = stream.subscribe({
      next: (item) => {
        items.push(item);
        if (done(items)) finish();
      },
      error: (error) => finish(error),
      complete: () => (done(items) ? finish() : finish(new Error('The stream ended early.'))),
    });
  });
}

/** Every log line of a stream that ends by itself. */
function readAll(
  stream: IStreamResult<{ lines: ContainerLogLine[] }>,
): Promise<ContainerLogLine[]> {
  return new Promise((resolve, reject) => {
    const lines: ContainerLogLine[] = [];
    stream.subscribe({
      next: (batch) => lines.push(...batch.lines),
      error: reject,
      complete: () => resolve(lines),
    });
  });
}

/** Follows a job to its end and returns its final state and log. */
async function runJob(hub: ICoreHub, job: JobInfo, timeoutMs: number) {
  const items = await readUntil<JobStreamItem>(
    hub.streamJob(job.id, 0),
    (seen) => seen.some((item) => item.job && item.job.state !== 'running'),
    timeoutMs,
  );
  const final = [...items].reverse().find((item) => item.job)?.job;
  return { final, log: items.flatMap((item) => item.lines.map((line) => line.text)) };
}

describe.skipIf(!enabled)('Docker through the server core on a real server', () => {
  it.skipIf(!onRocky)(
    'replaces podman on Rocky 9 with Docker, then streams a container’s stats and redacted logs',
    async () => {
      const server = await startTestServer('rocky-9');
      servers.push(server);
      runSlowly(
        server,
        'dnf -y -q install podman >/dev/null 2>&1 || dnf -y -q install podman >/dev/null 2>&1; rpm -q podman',
      );
      const { hub, stop } = await installAndConnect(server);
      cleanups.push(stop);

      const before = await hub.getDockerStatus();
      expect(before.installed).toBe(false);
      expect(before.conflictingPackages).toContain('podman');

      // Without agreement the job refuses and leaves podman alone.
      const refused = await runJob(
        hub,
        await hub.installDocker({ removeConflictingPackages: false }),
        120_000,
      );
      expect(refused.final?.state).toBe('failed');
      expect(refused.final?.error).toContain('podman');
      expect(server.run('rpm -q podman')).toMatch(/^podman-/);

      // AC4: with agreement, podman goes and Docker comes up.
      const install = await runJob(
        hub,
        await hub.installDocker({ removeConflictingPackages: true }),
        1_200_000,
      );
      expect(install.final?.state, install.log.slice(-40).join('\n')).toBe('succeeded');
      expect(install.log.join('\n')).toContain('060A61C51B558A7F742B77AAC52FEB6B621E9F35');
      expect(server.run('rpm -q podman || true')).toContain('not installed');
      expect(server.run('systemctl is-active docker')).toBe('active');
      const after = await hub.getDockerStatus();
      expect(after).toMatchObject({ installed: true, running: true, composeSupported: true });
      expect(after.conflictingPackages).toEqual([]);

      const pull = await runJob(hub, await hub.pullImage({ reference: 'busybox:1.37' }), 600_000);
      expect(pull.final?.state, pull.log.join('\n')).toBe('succeeded');
      server.run(
        `docker run -d --name ticker -e API_SECRET=${SECRET} busybox:1.37 sh -c 'i=0; while true; do i=$((i+1)); echo "tick $i with $API_SECRET"; echo "warn $i" >&2; sleep 1; done'`,
      );

      const list = await hub.listContainers();
      const ticker = list.groups
        .flatMap((group) => group.containers)
        .find((c) => c.name === 'ticker');
      expect(ticker?.state).toBe('running');
      const details = await hub.inspectContainer('ticker');
      expect(details.envKeys).toContain('API_SECRET');
      expect(JSON.stringify(details)).not.toContain(SECRET);

      const stats = await readUntil<ContainerStatsBatch>(
        hub.streamContainerStats({ containerIds: [ticker?.id ?? ''], intervalMs: 1_000 }),
        (batches) => batches.some((batch) => batch.samples.some((s) => s.memoryUsedBytes > 0)),
        60_000,
      );
      const sample = stats.flatMap((batch) => batch.samples).find((s) => s.memoryUsedBytes > 0);
      expect(sample?.memoryLimitBytes).toBeGreaterThan(0);
      expect(sample?.pids).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const lines = await readAll(
        hub.streamContainerLogs({ containerId: 'ticker', tail: 4, follow: false }),
      );
      expect(lines).toHaveLength(4);
      expect(lines.some((line) => line.stream === 'stderr' && line.text.startsWith('warn '))).toBe(
        true,
      );
      expect(lines.some((line) => line.text.includes('with [redacted]'))).toBe(true);
      expect(lines.some((line) => line.text.includes(SECRET))).toBe(false);

      const stopped = await hub.stopContainer('ticker', 1);
      expect(stopped.state).toBe('exited');
      expect(server.run("docker inspect -f '{{.State.Status}}' ticker")).toBe('exited');
    },
    TEST_TIMEOUT_MS,
  );
});
