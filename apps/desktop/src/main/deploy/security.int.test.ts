import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import type { SshAuthMethod } from '../../shared/apiTypes';
import { tempDir } from '../../test/main/fixtures';
import { SshConnectionPool } from '../ssh/pool';
import { localArtifactSource } from './bootstrap/releaseSource';
import { DeployHardening, PASSWORD_LOGIN_REFUSAL } from './hardening';
import { DeployService } from './service';
import { DeployState } from './state';
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
 * The Security center on real machines (E15), with the published core on systemd test servers:
 *
 * - SSH password login goes off only once key login is proven. Over a password login the app
 *   refuses before asking, and the core itself refuses too (sshd's log shows how the connection
 *   signed in), with nothing written. Over a key login it applies, is kept over a new key login,
 *   and afterwards a password login is turned away while the key still gets in. A change nobody
 *   keeps is put back by its systemd timer.
 * - A backup made on one server restores onto another, which then runs as the first did.
 *
 * Needs RUNOVA_SYSTEM_TESTS=1, Docker, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();

/** Ubuntu on every CI run; the nightly matrix runs it on each distro. */
const IMAGES = testServerImages(DISTRO_IMAGES, ['ubuntu-24.04']);
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const TEST_TIMEOUT_MS = 900_000;
const PASSWORD = 'correct horse battery staple';
const PASSPHRASE = 'orange tractor bicycle lamp';

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

interface Installed {
  server: TestServer;
  service: DeployService;
  login: { method: SshAuthMethod; keyPath?: string };
  pool: SshConnectionPool;
}

/** Installs the core as root over a password login, creates the owner and signs in. */
async function install(owner: string, image: TestServerImage): Promise<Installed> {
  const server = await startTestServer(image);
  servers.push(server);
  const login: Installed['login'] = { method: 'password' };
  const pool = new SshConnectionPool({
    endpoint: async () =>
      login.method === 'password'
        ? {
            host: server.host,
            port: server.port,
            username: 'root',
            authMethod: 'password',
            password: TEST_LOGINS.root.password,
          }
        : {
            host: server.host,
            port: server.port,
            username: 'root',
            authMethod: 'privateKey',
            privateKeyPath: login.keyPath,
          },
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
        authMethod: login.method,
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
    deviceName: () => 'Integration test',
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
  return { server, service, login, pool };
}

function hardeningOf(service: DeployService, steps: string[] = []): DeployHardening {
  return new DeployHardening({
    links: service.links,
    service,
    roles: () => ['owner'],
    progress: (event) => steps.push(`${event.operation}:${event.step}:${event.state}`),
  });
}

/** Whether sshd lets root in with this password, over a connection of its own. */
function passwordGetsIn(server: TestServer): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new Client();
    client
      .on('ready', () => {
        client.end();
        resolve(true);
      })
      .on('error', () => resolve(false))
      .connect({
        host: server.host,
        port: server.port,
        username: 'root',
        password: TEST_LOGINS.root.password,
        tryKeyboard: true,
        readyTimeout: 20_000,
      });
  });
}

const sshd = (server: TestServer, key: string) =>
  server.run(`sshd -T | grep -i '^${key} '`).split(' ')[1];

async function waitFor(what: string, check: () => boolean, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Gave up waiting: ${what}`);
}

describe.skipIf(!enabled)('the Security center on real servers', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `turns SSH password login off only once key login is proven, and refuses otherwise, on ${image}`,
      async () => {
        const { server, service, login, pool } = await install('maria', image);
        const steps: string[] = [];
        const hardening = hardeningOf(service, steps);
        const passwordsOff = {
          serverId: 'srv',
          disablePasswordLogin: true,
          restrictRootLogin: false,
        };
        await service.stepUp({ serverId: 'srv', password: PASSWORD });

        // Over a password login: the app refuses, and so does the core when asked anyway.
        const preview = await hardening.previewSsh(passwordsOff);
        expect(preview.allowed).toBe(false);
        expect(preview.proof.keyLoginProven).toBe(false);
        expect(preview.proof.method).toBe('password');
        await expect(hardening.applySsh(passwordsOff)).rejects.toThrow(PASSWORD_LOGIN_REFUSAL);
        await expect(
          service.withFreshHub('srv', (hub) =>
            hub.applySshHardening({ disablePasswordLogin: true, restrictRootLogin: false }),
          ),
        ).rejects.toThrow(/Nothing was changed/);
        expect(sshd(server, 'passwordauthentication')).toBe('yes');
        expect(
          server.run('test -e /etc/ssh/sshd_config.d/00-runova.conf && echo there || echo absent'),
        ).toBe('absent');
        expect(await passwordGetsIn(server)).toBe(true);

        // A key for this computer, and the saved server switched to it.
        const keys = utils.generateKeyPairSync('ed25519');
        const keyPath = join(tempDir(), 'id_ed25519');
        writeFileSync(keyPath, keys.private, { mode: 0o600 });
        server.run(
          `mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '${keys.public}' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
        );
        login.method = 'privateKey';
        login.keyPath = keyPath;

        const proven = await hardening.previewSsh(passwordsOff);
        expect(proven.proof.keyLoginProven).toBe(true);
        expect(proven.allowed).toBe(true);
        const change = await hardening.applySsh(passwordsOff);
        expect(change.state).toBe('awaitingConfirmation');
        expect(server.run('systemctl list-timers --all --no-legend')).toContain('runova-sshrevert');
        const kept = await hardening.confirmSsh({ serverId: 'srv', changeId: change.id });
        expect(kept.state).toBe('confirmed');
        expect(steps).toContain('confirm:confirming:done');
        expect(server.run('systemctl list-timers --all --no-legend')).not.toContain(
          'runova-sshrevert',
        );

        expect(sshd(server, 'passwordauthentication')).toBe('no');
        expect(sshd(server, 'kbdinteractiveauthentication')).toBe('no');
        expect(await passwordGetsIn(server)).toBe(false);
        // The key still gets in, and the app still reaches its core through it.
        service.links.closeAll();
        pool.closeAll();
        expect((await service.health('srv')).version).toBe('0.0.0-dev');
        const checklist = await hardening.checklist('srv');
        expect(checklist.items.find((item) => item.id === 'ssh-passwords')?.status).toBe('pass');

        // A change nobody keeps goes back by its systemd timer.
        const unkept = await hardening.applySsh({
          serverId: 'srv',
          disablePasswordLogin: false,
          restrictRootLogin: true,
        });
        expect(sshd(server, 'permitrootlogin')).toMatch(/^(prohibit-password|without-password)$/);
        await waitFor(
          'the timer to put the old drop-in back',
          () => sshd(server, 'permitrootlogin') === 'yes',
        );
        expect(sshd(server, 'passwordauthentication')).toBe('no');
        const after = await hardening.checklist('srv');
        expect(after.pendingSshChange).toBeUndefined();
        await expect(
          hardening.confirmSsh({ serverId: 'srv', changeId: unkept.id }),
        ).rejects.toThrow(/rolled back|deadline/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      `restores a backup from one server onto another, which then runs as the first did, on ${image}`,
      async () => {
        const first = await install('maria', image);
        await first.service.stepUp({ serverId: 'srv', password: PASSWORD });
        const backup = await first.service.withHub('srv', (hub) =>
          hub.createBackup({ passphrase: PASSPHRASE }),
        );
        const file = join(tempDir(), 'first.ambackup');
        await first.service.withCoreHttp('srv', (client, token) =>
          client.download(`/api/v1/backups/${backup.id}`, createWriteStream(file), {
            token,
            timeoutMs: 120_000,
          }),
        );
        expect(await first.service.withHub('srv', (hub) => hub.deleteBackup(backup.id))).toBe(true);

        const second = await install('sam', image);
        const restore = {
          serverId: 'srv',
          file,
          sudoPassword: null,
          userName: 'maria',
          password: PASSWORD,
        };
        await expect(
          second.service.restore(
            { ...restore, passphrase: 'lemon tractor bicycle lamp' },
            () => undefined,
          ),
        ).rejects.toThrow(/passphrase is wrong/);
        // Nothing changed: the second server still answers as itself.
        expect((await second.service.account('srv')).userName).toBe('sam');

        const result = await second.service.restore(
          { ...restore, passphrase: PASSPHRASE },
          () => undefined,
        );
        expect(result.signInError).toBeUndefined();
        expect(result.backupCoreVersion).toBe('0.0.0-dev');
        expect((await second.service.account('srv')).userName).toBe('maria');
        expect(
          second.server.run('test -d /var/lib/runova-core-restore/previous && echo kept'),
        ).toBe('kept');
        expect(second.server.run('stat -c %a /var/lib/runova-core')).toBe('700');
        expect(second.server.run('stat -c %a /var/lib/runova-core/core.db')).toBe('600');
      },
      TEST_TIMEOUT_MS,
    );
  }
});
