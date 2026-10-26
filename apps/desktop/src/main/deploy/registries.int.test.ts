import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConnection, IStreamResult } from '@microsoft/signalr';
import type { Project } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  JobInfo,
  JobStreamItem,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { tempDir } from '../../test/main/fixtures';
import { SshConnectionPool } from '../ssh/pool';
import { CoreSessions } from './auth/coreSessions';
import { localArtifactSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { coreHub, createCoreHubConnection } from './connection/coreHub';
import { streamLocalTransport } from './connection/transport';
import { DeployService } from './service';
import { buildContextTarball } from './stacks/buildContext';
import { DeployStacks } from './stacks/service';
import { DeployState } from './state';
import {
  loadImage,
  onServer as onContainer,
  REGISTRY_PULLER as PULLER,
  REGISTRY_HOST as REGISTRY,
  startPrivateRegistry,
  REGISTRY_TOKEN as TOKEN,
} from './testing/privateRegistry';
import {
  DISTRO_IMAGES,
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  testServerImages,
} from './testing/testServers';

/**
 * Private registries on a real server (E08 AC1): a registry:2 with htpasswd runs on the test
 * server, an image is pushed to it under a separate pushing user, and an app deploys from it
 * through the same DeployStacks the app uses, with the pulling user's token sent per deploy.
 * After a deploy that succeeded and after one that failed, the whole filesystem (and the core's
 * journal) is searched for the token and for the base64 form docker writes: neither is there.
 * Needs RUNOVA_SYSTEM_TESTS=1, Docker, network access from the test server for Docker's
 * packages, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();

/** Ubuntu on every CI run; the nightly matrix runs it on each distro. */
const IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04']);
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const PASSWORD = 'correct horse battery staple';
const TEST_TIMEOUT_MS = 2_400_000;

const IMAGE = `${REGISTRY}/private/web:1`;

const compose = (image: string) => `services:
  web:
    image: ${image}
    command: ["httpd", "-f", "-p", "8080", "-h", "/"]
    restart: unless-stopped
    ports:
      - "8091:8080"
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
});

/** A command on the test server; its input (if any) goes through stdin, never argv. */
function onServer(server: TestServer, command: string, input?: string): string {
  return onContainer(server.name, command, input);
}

function streamUntil<T>(stream: IStreamResult<T>, done: (items: T[]) => boolean, ms: number) {
  return new Promise<T[]>((resolve, reject) => {
    const items: T[] = [];
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`The stream did not finish: ${JSON.stringify(items).slice(-3_000)}`));
    }, ms);
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

async function runJob(hub: ICoreHub, job: JobInfo, timeoutMs: number) {
  const items = await streamUntil<JobStreamItem>(
    hub.streamJob(job.id, 0),
    (seen) => seen.some((item) => item.job && item.job.state !== 'running'),
    timeoutMs,
  );
  const final = [...items].reverse().find((item) => item.job)?.job;
  return { final, log: items.flatMap((item) => item.lines.map((line) => line.text)) };
}

async function installAndConnect(server: TestServer) {
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
    deviceName: () => 'Registries system test',
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
    transport,
    sessions,
    stop: () => {
      void connection.stop();
      lease.release();
      pool.closeAll();
    },
  };
}

/** Every file on the server holding the token or its base64 form, and journal lines with it. */
function tokenTraces(server: TestServer): string {
  const base64 = Buffer.from(`${PULLER}:${TOKEN}`).toString('base64');
  // The patterns come in on stdin, so the search itself never has them on a command line.
  const files = onServer(
    server,
    'grep -rlF -f /dev/stdin / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null || true',
    `${TOKEN}\n${base64}\n`,
  );
  const journal = onServer(
    server,
    'journalctl -u runova-core --no-pager -o cat | grep -cF -f /dev/stdin || true',
    `${TOKEN}\n${base64}\n`,
  );
  return [files, journal === '0' ? '' : `journal lines: ${journal}`].filter(Boolean).join('\n');
}

describe.skipIf(!enabled)('Private registries through the server core on a real server', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `pulls a private image with a per-deploy token and leaves no trace of it, even after a failure on ${image}`,
      async () => {
        const server = await startTestServer(image);
        servers.push(server);
        const { hub, transport, sessions, stop } = await installAndConnect(server);
        cleanups.push(stop);

        let docker = await runJob(
          hub,
          await hub.installDocker({ removeConflictingPackages: true }),
          1_200_000,
        );
        for (let attempt = 1; attempt < 3 && docker.final?.state !== 'succeeded'; attempt++) {
          docker = await runJob(
            hub,
            await hub.installDocker({ removeConflictingPackages: true }),
            1_200_000,
          );
        }
        expect(docker.final?.state, docker.log.slice(-40).join('\n')).toBe('succeeded');
        // The sign-in folder lives in the core's runtime directory, which must be a tmpfs.
        expect(onServer(server, 'findmnt -T /run/runova-core -no FSTYPE')).toBe('tmpfs');

        // A registry:2 with htpasswd, and the image pushed by the other user from a throwaway config.
        loadImage(server.name, 'busybox:1.37');
        startPrivateRegistry(server.name, 'busybox:1.37', IMAGE);
        // Without a sign-in the registry refuses the pull.
        expect(onServer(server, `docker pull ${IMAGE} 2>&1 || true`)).toMatch(
          /unauthorized|no basic auth/,
        );

        // The search finds a planted copy, so an empty answer later means there is none.
        onServer(server, 'cat > /var/tmp/token-canary', TOKEN);
        expect(tokenTraces(server)).toContain('/var/tmp/token-canary');
        onServer(server, 'rm -f /var/tmp/token-canary');
        expect(tokenTraces(server)).toBe('');

        const folder = tempDir('runova-registry-system-');
        const write = (text: string) => {
          mkdirSync(dirname(join(folder, 'compose.yaml')), { recursive: true });
          writeFileSync(join(folder, 'compose.yaml'), text);
        };
        write(compose(IMAGE));
        const sent: string[][] = [];
        const stacks = new DeployStacks({
          links: { call: (_serverId, work) => work(hub) },
          roles: () => ['owner'],
          http: async (_serverId, work) =>
            work(new CoreHttpClient(transport), await sessions.accessToken('srv')),
          source: {
            project: async () => ({ id: 'p1', name: 'Private', folderPath: folder }) as Project,
            index: async (root) => ({ root, files: ['compose.yaml'], truncated: false }),
            environment: async () => ({ id: 'e1', name: 'Production', files: [], entries: [] }),
          },
          pack: buildContextTarball,
          registryAuths: async (_serverId, _stackId, registries) => {
            sent.push(registries);
            return registries.includes(REGISTRY)
              ? [{ registry: REGISTRY, username: PULLER, secret: TOKEN }]
              : [];
          },
        });
        const source = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' };
        const preview = await stacks.preview(source);
        const first = await stacks.create({
          ...source,
          serverId: 'srv',
          name: 'private',
          proxiedServices: ['web'],
          acknowledgedRisks: preview.requiresAcknowledgment,
        });
        expect(first.revision.state, first.revision.error).toBe('ready');

        const deployed = await runJob(hub, await stacks.deploy('srv', first.stack.id, 1), 900_000);
        expect(deployed.final?.state, deployed.log.slice(-60).join('\n')).toBe('succeeded');
        expect(sent).toEqual([[REGISTRY]]);
        expect(deployed.log.join('\n')).toContain(`Signing in to ${REGISTRY} as ${PULLER}`);
        expect(deployed.log.join('\n')).not.toContain(TOKEN);
        expect(onServer(server, `docker image inspect -f '{{.Id}}' ${IMAGE}`)).toMatch(/^sha256:/);
        expect(onServer(server, 'ls -A /run/runova-core/registry-auth 2>/dev/null || true')).toBe(
          '',
        );
        expect(tokenTraces(server)).toBe('');

        // A deploy that fails after signing in (the tag does not exist) leaves nothing either.
        write(compose(`${REGISTRY}/private/web:missing`));
        const second = await stacks.upload({
          ...source,
          serverId: 'srv',
          stackId: first.stack.id,
          proxiedServices: ['web'],
          acknowledgedRisks: preview.requiresAcknowledgment,
        });
        const failed = await runJob(
          hub,
          await stacks.deploy('srv', first.stack.id, second.revision.number),
          900_000,
        );
        expect(failed.final?.state, failed.log.slice(-60).join('\n')).toBe('failed');
        expect(failed.log.join('\n')).toContain(`Signing in to ${REGISTRY}`);
        expect(failed.log.join('\n')).not.toContain(TOKEN);
        expect(onServer(server, 'ls -A /run/runova-core/registry-auth 2>/dev/null || true')).toBe(
          '',
        );
        expect(tokenTraces(server)).toBe('');
      },
      TEST_TIMEOUT_MS,
    );
  }
});
