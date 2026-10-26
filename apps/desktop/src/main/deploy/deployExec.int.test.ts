import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IStreamResult } from '@microsoft/signalr';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  ExecApproval,
  ExecOutput,
  JournalBatch,
} from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { SshConnectionPool } from '../ssh/pool';
import { approvalSigner } from './assistant/approvals';
import { APPROVAL_INVALID, NEEDS_APPROVAL } from './assistant/coreExecutor';
import { CoreSessions } from './auth/coreSessions';
import { localArtifactSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { coreHub, createCoreHubConnection } from './connection/coreHub';
import { streamLocalTransport } from './connection/transport';
import { DeployService } from './service';
import { DeployState } from './state';
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
 * StreamExec and StreamJournal (E09) on a real machine: the published core installed on the
 * Ubuntu 24.04 systemd test server and driven through the hub the way the app does. An allowlisted
 * check runs in a real transient unit, an unapproved command is refused by the core and leaves no
 * trace, a signed approval runs once and its replay is refused, stopping a command takes every
 * process of its unit with it, and the journal comes from journalctl. Needs
 * RUNOVA_SYSTEM_TESTS=1, Docker, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();

/** Ubuntu on every CI run; the nightly matrix runs it on each distro. */
const IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04']);
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const SETUP_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 180_000;
const PASSWORD = 'correct horse battery staple';

let server: TestServer | null = null;
let pool: SshConnectionPool | null = null;
let hub: ICoreHub;
let stopHub: () => Promise<void> = async () => undefined;
let approve: (command: string) => Promise<ExecApproval>;

afterEach((context) => {
  if (context.task.result?.state === 'fail' && server) {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(server.diagnose());
  }
});

afterAll(async () => {
  await stopHub();
  pool?.closeAll();
  server?.stop();
});

/** Every item of a stream that ends by itself; a refusal rejects. */
function collect<T>(stream: IStreamResult<T>, timeoutMs = 60_000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const items: T[] = [];
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error('The stream did not end in time.'));
    }, timeoutMs);
    const subscription = stream.subscribe({
      next: (item) => items.push(item),
      complete: () => {
        clearTimeout(timer);
        resolve(items);
      },
      error: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

const text = (items: ExecOutput[]) =>
  items.flatMap((item) => item.lines.map((line) => line.text)).join('\n');

async function waitFor(what: string, check: () => boolean, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Gave up waiting: ${what}`);
}

/** Units the core started for StreamExec that systemd still knows about. */
const execUnits = () =>
  server?.run("systemctl list-units --all --no-legend --plain 'runova-exec-*' || true") ?? '';

describe.skipIf(!enabled)('StreamExec and the journal on a real server', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    describe(image, () => {
      beforeAll(async () => {
        await stopHub();
        pool?.closeAll();
        server?.stop();
        server = await startTestServer(image);
        const target = server;
        const { username, password } = TEST_LOGINS.root;
        pool = new SshConnectionPool({
          endpoint: async () => ({
            host: target.host,
            port: target.port,
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
        const unseal = async (envelope: { ciphertext: string }) =>
          Buffer.from(envelope.ciphertext, 'base64').toString();
        const service = new DeployService({
          servers: async () => [
            {
              id: 'srv',
              nickname: 'Test server',
              host: target.host,
              port: target.port,
              username: 'root',
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
          unseal,
          deviceName: () => 'Integration test',
          availableVersion: async () => '0.0.0-dev',
          devCorePort: null,
          progress: () => undefined,
        });
        const result = await service.install({
          serverId: 'srv',
          sudoPassword: null,
          account: { userName: 'maria', password: PASSWORD },
        });
        expect(result.enrollmentError).toBeUndefined();
        const owned = pool;
        const sessions = new CoreSessions({
          state,
          unseal,
          withCore: async (serverId, work) => {
            const lease = await owned.acquire(serverId);
            try {
              return await work(new CoreHttpClient(streamLocalTransport(lease.connection)));
            } finally {
              lease.release();
            }
          },
        });
        const lease = await pool.acquire('srv');
        const connection = createCoreHubConnection(streamLocalTransport(lease.connection), () =>
          sessions.accessToken('srv'),
        );
        await connection.start();
        hub = coreHub(connection);
        stopHub = async () => {
          await connection.stop().catch(() => undefined);
          lease.release();
        };
        const sign = approvalSigner({ state, unseal });
        approve = (command) => sign('srv', hub, command);
      }, SETUP_TIMEOUT_MS);

      it(
        'runs an allowlisted check in a real transient unit and streams its output and exit code',
        async () => {
          const items = await collect(hub.streamExec({ command: 'df -h /', fromAssistant: false }));
          expect(text(items)).toMatch(/Filesystem\s+Size\s+Used/);
          expect(items.at(-1)).toMatchObject({ ended: true, exitCode: 0, timedOut: false });
          // systemd started the command as a unit of its own and collected it afterwards.
          expect(
            server?.run("journalctl --no-pager -q -o cat | grep -c 'runova-exec-' || true"),
          ).not.toBe('0');
          expect(execUnits()).toBe('');

          const failing = await collect(
            hub.streamExec({ command: 'df -h /no-such-folder', fromAssistant: false }),
          );
          expect(failing.at(-1)?.exitCode).toBe(1);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'refuses a command without an approval, and nothing runs',
        async () => {
          server?.run('rm -f /tmp/e09-unapproved');
          for (const fromAssistant of [false, true]) {
            await expect(
              collect(hub.streamExec({ command: 'touch /tmp/e09-unapproved', fromAssistant })),
            ).rejects.toThrow(NEEDS_APPROVAL);
          }
          expect(server?.run('test -e /tmp/e09-unapproved && echo there || echo absent')).toBe(
            'absent',
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'runs a signed command once and refuses the same nonce again',
        async () => {
          server?.run('rm -f /tmp/e09-count');
          const command = 'echo run >> /tmp/e09-count && echo signed';
          const approval = await approve(command);
          const items = await collect(hub.streamExec({ command, fromAssistant: true, approval }));
          expect(text(items)).toContain('signed');
          expect(items.at(-1)?.exitCode).toBe(0);

          await expect(
            collect(hub.streamExec({ command, fromAssistant: true, approval })),
          ).rejects.toThrow(APPROVAL_INVALID);
          const other = await approve('true');
          await expect(
            collect(hub.streamExec({ command, fromAssistant: true, approval: other })),
          ).rejects.toThrow(APPROVAL_INVALID);
          expect(server?.run('wc -l < /tmp/e09-count')).toBe('1');
        },
        TEST_TIMEOUT_MS,
      );

      it(
        'stopping a command ends its whole unit, children included',
        async () => {
          const command = 'sleep 301 & sleep 302';
          const approval = await approve(command);
          const subscription = hub
            .streamExec({ command, fromAssistant: true, approval, timeoutSeconds: 600 })
            .subscribe({
              next: () => undefined,
              complete: () => undefined,
              error: () => undefined,
            });
          await waitFor('both sleeps to run', () =>
            /sleep 301[\s\S]*sleep 302|sleep 302[\s\S]*sleep 301/.test(
              server?.run("pgrep -a -f 'sleep 30[12]' || true") ?? '',
            ),
          );
          expect(execUnits()).toContain('runova-exec-');

          subscription.dispose();
          await waitFor(
            'the unit and every process in it to go',
            () =>
              (server?.run("pgrep -f 'sleep 30[12]' || true") ?? 'x') === '' && execUnits() === '',
          );
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "reads a unit's journal from journalctl",
        async () => {
          const batches = await collect<JournalBatch>(
            hub.streamJournal({ unit: 'runova-core.service', lines: 50, follow: false }),
          );
          const lines = batches.flatMap((batch) => batch.lines);
          expect(lines.length).toBeGreaterThan(0);
          expect(lines.every((line) => line.atUnixMs > 1_600_000_000_000)).toBe(true);
          expect(lines.some((line) => line.text.length > 0)).toBe(true);

          await expect(collect(hub.streamJournal({ unit: '-f', follow: false }))).rejects.toThrow(
            /systemd unit/,
          );
        },
        TEST_TIMEOUT_MS,
      );
    });
  }
});
