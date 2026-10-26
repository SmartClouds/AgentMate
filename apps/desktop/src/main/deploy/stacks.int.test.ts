import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CATALOG_TEMPLATES,
  generateCatalogSecrets,
  type Project,
  renderCatalogApp,
} from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobInfo } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { tempDir } from '../../test/main/fixtures';
import { CoreHttpClient } from './connection/coreHttp';
import { buildContextTarball } from './stacks/buildContext';
import { DeployStacks } from './stacks/service';
import { installAndConnect, installDocker, runJob } from './testing/coreSession';
import {
  DISTRO_IMAGES,
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  type TestServer,
  testServerImages,
} from './testing/testServers';

/**
 * Compose stacks on a real server (E07): the core is installed and this computer enrolled with
 * DeployService, Docker comes in through the core's own install job, then an app goes up from a
 * project folder with an environment, through the same DeployStacks the app uses (files over
 * REST, the build context streamed, the deploy as a job). It checks what only a real Docker can
 * say: the .env reaches the container exactly (AC2), a service published on every interface ends
 * up on 127.0.0.1 only (AC3), and a rollback brings the previous revision's files and running
 * state back (AC4). Then E13's "make private" moves a public service to 127.0.0.1 as a new
 * revision, and every App Store template (E12 AC1) goes through the server's own docker compose
 * config and risk linter. Needs RUNOVA_SYSTEM_TESTS=1, Docker, network access from the test server
 * (Docker's packages and busybox), and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();

/** Ubuntu on every CI run; the nightly matrix runs it on each distro. */
const IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04']);
const TEST_TIMEOUT_MS = 2_400_000;

/** Quotes, a `$`, a backslash, a `#`, a newline and spaces at both ends: what .env files get wrong. */
const TRICKY = ` it's "quoted" $HOME \\ #not-a-comment\nsecond line `;

const COMPOSE = `services:
  web:
    image: busybox:1.37
    # Loaded from this computer (see loadImage): the test server's way to Docker Hub is slow.
    pull_policy: never
    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]
    restart: unless-stopped
    environment:
      GREETING: \${GREETING}
    ports:
      - "8090:8080"
    volumes:
      - ./www:/www:ro
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
      interval: 2s
      retries: 15
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

function containerOf(server: TestServer): string {
  const lines = execFileSync('docker', ['ps', '--format', '{{.ID}} {{.Ports}}'], {
    encoding: 'utf-8',
  });
  const mapping = `:${server.port}->22/tcp`;
  return (
    lines
      .split('\n')
      .find((entry) => entry.includes(mapping))
      ?.split(' ')[0] ?? ''
  );
}

/** A command on the test server that may take its time (package downloads, image pulls). */
function runSlowly(server: TestServer, command: string): string {
  return execFileSync('docker', ['exec', containerOf(server), 'sh', '-c', command], {
    encoding: 'utf-8',
    timeout: 900_000,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
  }).trim();
}

/** Copies an image from this computer's Docker into the test server's, without a registry. */
function loadImage(server: TestServer, image: string): void {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe' });
  } catch {
    execFileSync('docker', ['pull', image], { stdio: 'pipe', timeout: 600_000 });
  }
  const archive = execFileSync('docker', ['save', image], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('docker', ['exec', '-i', containerOf(server), 'docker', 'load'], {
    input: archive,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

function writeProject(files: Record<string, string>): string {
  const folder = tempDir('runova-stack-system-');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  return folder;
}

describe.skipIf(!enabled)('Compose stacks through the server core on a real server', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `deploys an app from a project, keeps it on 127.0.0.1, and rolls back to the first revision on ${image}`,
      async () => {
        const server = await startTestServer(image);
        servers.push(server);
        const { hub, transport, sessions, stop } = await installAndConnect(
          server,
          'Stacks system test',
        );
        cleanups.push(stop);

        await installDocker(hub);
        loadImage(server, 'busybox:1.37');

        const folder = writeProject({
          'compose.yaml': COMPOSE,
          'www/index.html': 'first revision\n',
          '.dockerignore': 'secret.txt\n',
          'secret.txt': 'never leaves this computer\n',
        });
        const env = { current: [{ key: 'GREETING', value: TRICKY }] };
        const stacks = new DeployStacks({
          links: { call: (_serverId, work) => work(hub) },
          roles: () => ['owner'],
          http: async (_serverId, work) =>
            work(new CoreHttpClient(transport), await sessions.accessToken('srv')),
          source: {
            project: async () => ({ id: 'p1', name: 'Site', folderPath: folder }) as Project,
            index: async (root) => ({ root, files: ['compose.yaml'], truncated: false }),
            environment: async () => ({
              id: 'e1',
              name: 'Production',
              files: [],
              entries: env.current,
            }),
          },
          pack: buildContextTarball,
        });
        const source = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'e1' };

        const preview = await stacks.preview(source);
        expect(preview.blocking).toBeNull();
        expect(preview.buildContext).toBe('web mounts ./www from the project.');

        const first = await stacks.create({
          ...source,
          serverId: 'srv',
          name: 'site',
          proxiedServices: ['web'],
          acknowledgedRisks: preview.requiresAcknowledgment,
        });
        expect(first.revision.state, first.revision.error).toBe('ready');
        expect(first.revision.unacknowledgedRisks).toEqual([]);
        const stackId = first.stack.id;

        const deployed = await runJob(hub, await stacks.deploy('srv', stackId, 1), 900_000);
        expect(deployed.final?.state, deployed.log.slice(-60).join('\n')).toBe('succeeded');
        // The value never shows in the log, whatever compose printed.
        expect(deployed.log.join('\n')).not.toContain('not-a-comment');
        const details = await stacks.get('srv', stackId);
        expect(details.stack.status).toBe('running');
        expect(details.revisions[0].steps.map((step) => [step.kind, step.state])).toEqual([
          ['validate', 'succeeded'],
          ['pull', 'succeeded'],
          ['build', 'skipped'],
          ['up', 'succeeded'],
          ['health', 'succeeded'],
        ]);

        const container = runSlowly(
          server,
          "docker ps --filter label=com.docker.compose.project=site --format '{{.Names}}'",
        );
        expect(container).toBe('site-web-1');

        // AC3: published as "8090:8080" (every interface), bound to 127.0.0.1 only.
        const bindings = JSON.parse(
          runSlowly(server, `docker inspect -f '{{json .HostConfig.PortBindings}}' ${container}`),
        ) as Record<string, Array<{ HostIp: string; HostPort: string }>>;
        expect(bindings['8080/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '8090' }]);

        // AC2: the environment arrives exactly as the Environments tab holds it.
        const envOf = () =>
          (
            JSON.parse(
              runSlowly(server, `docker inspect -f '{{json .Config.Env}}' ${container}`),
            ) as string[]
          )
            .find((entry) => entry.startsWith('GREETING='))
            ?.slice('GREETING='.length);
        expect(envOf()).toBe(TRICKY);
        const page = () =>
          runSlowly(server, `docker exec ${container} wget -qO- http://127.0.0.1:8080/`);
        expect(page()).toBe('first revision');
        // .dockerignore kept the secret out of the upload.
        expect(runSlowly(server, `docker exec ${container} ls /www`)).toBe('index.html');

        // A second revision with other files and another value.
        writeFileSync(join(folder, 'www', 'index.html'), 'second revision\n');
        env.current = [{ key: 'GREETING', value: 'plain' }];
        const second = await stacks.upload({
          ...source,
          serverId: 'srv',
          stackId,
          proxiedServices: ['web'],
          acknowledgedRisks: preview.requiresAcknowledgment,
        });
        expect(second.revision.number).toBe(2);
        const redeployed = await runJob(hub, await stacks.deploy('srv', stackId, 2), 900_000);
        expect(redeployed.final?.state, redeployed.log.slice(-60).join('\n')).toBe('succeeded');
        expect(page()).toBe('second revision');
        expect(envOf()).toBe('plain');

        // AC4: rolling back to 1 brings its files and its environment back, as revision 3.
        const rolledBack = await runJob(hub, await stacks.rollback('srv', stackId, 1), 900_000);
        expect(rolledBack.final?.state, rolledBack.log.slice(-60).join('\n')).toBe('succeeded');
        const after = await stacks.get('srv', stackId);
        expect(after.stack.liveRevision).toBe(3);
        expect(after.revisions[0]).toMatchObject({ number: 3, rollbackOf: 1, state: 'live' });
        expect(after.revisions[0].composeSha256).toBe(first.revision.composeSha256);
        expect(page()).toBe('first revision');
        expect(envOf()).toBe(TRICKY);
        expect(
          JSON.parse(
            runSlowly(server, `docker inspect -f '{{json .HostConfig.PortBindings}}' ${container}`),
          )['8080/tcp'],
        ).toEqual([{ HostIp: '127.0.0.1', HostPort: '8090' }]);

        // E13 make private: a revision left public on purpose, then moved back to 127.0.0.1 by a
        // revision the server copies, with the same .env.
        const publicRevision = await stacks.upload({
          ...source,
          serverId: 'srv',
          stackId,
          proxiedServices: [],
          acknowledgedRisks: (await stacks.preview({ ...source, proxiedServices: [] }))
            .requiresAcknowledgment,
        });
        const madePublic = await runJob(
          hub,
          await stacks.deploy('srv', stackId, publicRevision.revision.number),
          900_000,
        );
        expect(madePublic.final?.state, madePublic.log.slice(-60).join('\n')).toBe('succeeded');
        const hostIps = () =>
          (
            JSON.parse(
              runSlowly(
                server,
                `docker inspect -f '{{json .HostConfig.PortBindings}}' ${container}`,
              ),
            )['8080/tcp'] as Array<{ HostIp: string }>
          ).map((binding) => binding.HostIp);
        expect(hostIps().every((ip) => ip !== '127.0.0.1')).toBe(true);
        const privateAgain = await stacks.makePrivate({
          serverId: 'srv',
          stackId,
          services: ['web'],
        });
        expect(privateAgain.job, privateAgain.revision.error).not.toBeNull();
        const madePrivate = await runJob(hub, privateAgain.job as JobInfo, 900_000);
        expect(madePrivate.final?.state, madePrivate.log.slice(-60).join('\n')).toBe('succeeded');
        expect(hostIps()).toEqual(['127.0.0.1']);
        // The copy kept the .env of the revision it came from (the public one, from the project).
        expect(envOf()).toBe('plain');

        // Taken down and deleted with its volumes: nothing of the app is left.
        const removed = await runJob(hub, await stacks.delete('srv', stackId, true), 300_000);
        expect(removed.final?.state, removed.log.slice(-40).join('\n')).toBe('succeeded');
        expect(
          runSlowly(server, 'docker ps -a --filter label=com.docker.compose.project=site -q'),
        ).toBe('');
        expect(await stacks.list('srv')).toEqual([]);

        // E12 AC1: every App Store template, as an install uploads it, is read by the server's
        // docker compose config and leaves its linter with nothing to acknowledge.
        for (const template of CATALOG_TEMPLATES) {
          const rendered = renderCatalogApp(template, {
            secrets: generateCatalogSecrets(template.secrets),
          });
          if (!rendered.ok) throw new Error(`${template.id}: ${rendered.reason}`);
          const { render } = rendered;
          const created = await stacks.createFromFiles('srv', `store-${template.id}`, 'App Store', {
            compose: render.compose,
            env: render.envFile,
            proxiedServices: [...new Set(render.ports.map((port) => port.service))],
            acknowledgedRisks: [],
            buildContext: false,
          });
          expect(created.revision.state, `${template.id}: ${created.revision.error}`).toBe('ready');
          expect(created.revision.unacknowledgedRisks, template.id).toEqual([]);
          for (const binding of created.revision.bindings) {
            expect(binding.hostIp, `${template.id} ${binding.service}`).toBe('127.0.0.1');
          }
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
