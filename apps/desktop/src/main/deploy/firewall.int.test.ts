import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FirewallChange } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { SshConnectionPool } from '../ssh/pool';
import { CoreSessions } from './auth/coreSessions';
import { localArtifactSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { coreHub, createCoreHubConnection } from './connection/coreHub';
import { bridgeTransport, streamLocalTransport } from './connection/transport';
import { DeployFirewall } from './firewall';
import { DeployService } from './service';
import { DeployState } from './state';
import {
  startTestServer,
  systemTestsEnabled,
  TEST_LOGINS,
  type TestServer,
  type TestServerImage,
  testServerImages,
} from './testing/testServers';

/**
 * The firewall (E13) on real machines: the published core installed on systemd test servers with
 * ufw (Ubuntu 24.04) and firewalld (Rocky 9), driven through the hub the way the app does. Each
 * test checks the live IPv4 and IPv6 rulesets after a change (AC3), that a change cutting SSH off
 * is refused (AC2), that a confirmation only counts over a new SSH connection, and that a change
 * nobody confirms is undone by its systemd timer while the core is killed (AC1). Needs
 * RUNOVA_SYSTEM_TESTS=1, Docker, and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
/** Each test needs its own firewall; the nightly matrix runs one test server per job. */
const onUfw = testServerImages(['ubuntu-24.04-ufw'], ['ubuntu-24.04-ufw']).length > 0;
const onFirewalld = testServerImages(['rocky-9-firewalld'], ['rocky-9-firewalld']).length > 0;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const TEST_TIMEOUT_MS = 900_000;
const PASSWORD = 'correct horse battery staple';

const servers: TestServer[] = [];
const pools: SshConnectionPool[] = [];

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(servers.map((server) => server.diagnose()).join('\n'));
  }
  for (const pool of pools.splice(0)) pool.closeAll();
  for (const server of servers.splice(0)) server.stop();
});

function newPool(server: TestServer): SshConnectionPool {
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
  pools.push(pool);
  return pool;
}

interface Connected {
  hub: ICoreHub;
  /** `$SSH_CONNECTION` as an exec on the same SSH connection prints it. */
  sshConnection: string;
  stop: () => Promise<void>;
}

/** Installs the core, creates the owner, enrolls this computer and signs in. */
async function installCore(image: TestServerImage) {
  const server = await startTestServer(image);
  servers.push(server);
  const pool = newPool(server);
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
        host: server.host,
        port: server.port,
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
  const sessions = new CoreSessions({
    state,
    unseal,
    withCore: async (serverId, work) => {
      const lease = await pool.acquire(serverId);
      try {
        return await work(new CoreHttpClient(streamLocalTransport(lease.connection)));
      } finally {
        lease.release();
      }
    },
  });

  /** A hub connection over an SSH connection of `over` (a new pool means a new SSH connection). */
  const connect = async (
    over: SshConnectionPool,
    kind: 'streamlocal' | 'bridge' = 'streamlocal',
  ): Promise<Connected> => {
    const lease = await over.acquire('srv');
    const ssh = await lease.connection.exec('echo "$SSH_CONNECTION"');
    const transport =
      kind === 'bridge'
        ? bridgeTransport(lease.connection)
        : streamLocalTransport(lease.connection);
    const connection = createCoreHubConnection(transport, () => sessions.accessToken('srv'));
    await connection.start();
    return {
      hub: coreHub(connection),
      sshConnection: ssh.stdout.trim(),
      stop: async () => {
        await connection.stop().catch(() => undefined);
        lease.release();
      },
    };
  };
  return { server, pool, connect, service };
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Gave up waiting: ${what}`);
}

const tcp = (
  port: number,
  source?: string,
  action: 'allow' | 'deny' = 'allow',
): FirewallChange => ({
  kind: 'addRule',
  rule: { action, protocol: 'tcp', port, ...(source ? { source } : {}) },
});

const denyFrom = (source: string): FirewallChange => ({
  kind: 'addRule',
  rule: { action: 'deny', protocol: 'any', source },
});

/**
 * AC1: a change nobody confirms, with the core killed right after it: the systemd timer still
 * puts the old rules back, and the core records the rollback and raises an alert once it is back.
 */
async function unconfirmedChangeRevertsWithTheCoreKilled(
  core: Awaited<ReturnType<typeof installCore>>,
  openIn: () => { v4: boolean; v6: boolean },
) {
  const { server } = core;
  const before = await core.connect(newPool(server));
  const change = await before.hub.applyFirewallChanges({
    changes: [tcp(7070), tcp(7071, '2001:db8:7::/48')],
    sshConnection: before.sshConnection,
  });
  expect(change.state).toBe('awaitingConfirmation');
  expect(openIn()).toEqual({ v4: true, v6: true });
  await before.stop();

  server.run('systemctl kill -s KILL runova-core; systemctl stop runova-core');
  expect(server.run('systemctl is-active runova-core || true')).not.toBe('active');
  expect(server.run('systemctl list-timers --all --no-legend')).toContain('runova-fwrevert');

  // ufw reloads the IPv4 tables before the IPv6 ones, so a check can land between the two.
  await waitFor('the timer to put the old rules back', () => {
    const { v4, v6 } = openIn();
    return !v4 && !v6;
  });
  expect(server.run('systemctl is-active runova-core || true')).not.toBe('active');

  server.run('systemctl start runova-core');
  const after = await core.connect(newPool(server));
  await waitFor('the core to record the rollback', async () => {
    const [latest] = await after.hub.listFirewallChangeSets({ limit: 1 });
    return latest?.id === change.id && latest.state === 'rolledBack';
  });
  const [latest] = await after.hub.listFirewallChangeSets({ limit: 1 });
  expect(latest?.rolledBackBy).toBe('timer');
  const alerts = await after.hub.listAlerts({ includeResolved: false });
  expect(alerts.map((alert) => alert.kind)).toContain('firewallRolledBack');
  expect(server.run('systemctl list-timers --all --no-legend')).not.toContain('runova-fwrevert');
  await after.stop();
}

describe.skipIf(!enabled)('the firewall on real servers', () => {
  it.skipIf(!onUfw)(
    "applies over the app's lasting connection and keeps the change over a brand-new SSH connection",
    async () => {
      const core = await installCore('ubuntu-24.04-ufw');
      const { server, service } = core;
      const steps: string[] = [];
      const firewall = new DeployFirewall({
        links: service.links,
        service,
        roles: () => ['owner'],
        progress: (event) => steps.push(`${event.operation}:${event.step}:${event.state}`),
      });

      // The guard sees this computer's SSH connection, read on the connection the link rides on.
      const preview = await firewall.preview({
        serverId: 'srv',
        changes: [{ kind: 'enable' }],
      });
      expect(preview.guard.blocked).toBe(true);

      const change = await firewall.apply({
        serverId: 'srv',
        changes: [tcp(22), tcp(9090), { kind: 'enable' }],
        password: PASSWORD,
      });
      expect(change.state).toBe('awaitingConfirmation');
      expect(change.appliedFrom).toBeTruthy();

      // Over the link's own SSH connection the core refuses; the app's confirm opens a new one.
      await expect(
        service.links.call('srv', (hub) => hub.confirmFirewallChanges(change.id)),
      ).rejects.toThrow(/same SSH connection/);
      const kept = await firewall.confirm({ serverId: 'srv', changeSetId: change.id });
      expect(kept.state).toBe('confirmed');
      expect(steps).toContain('confirm:openingConnection:done');
      expect(steps.at(-1)).toBe('confirm:confirming:done');
      expect(server.run('iptables-save')).toMatch(/--dport 9090 -j ACCEPT/);
      expect(server.run('systemctl list-timers --all --no-legend')).not.toContain(
        'runova-fwrevert',
      );
      service.links.closeAll();
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!onUfw)(
    'manages ufw for IPv4 and IPv6, refuses to cut SSH off, confirms over a new connection and rolls back with the core killed',
    async () => {
      const core = await installCore('ubuntu-24.04-ufw');
      const { server } = core;
      const first = await core.connect(core.pool);

      const status = await first.hub.getFirewallStatus();
      expect(status).toMatchObject({ backend: 'ufw', installed: true, active: false, ipv6: true });
      expect(status.ssh.ports).toEqual([22]);

      // AC2: turning ufw on with nothing allowing SSH would lock this computer out.
      const enableOnly = {
        changes: [{ kind: 'enable' as const }],
        sshConnection: first.sshConnection,
      };
      const preview = await first.hub.previewFirewallChanges(enableOnly);
      expect(preview.guard.blocked).toBe(true);
      expect(preview.guard.confirmationPhrase).toBe('block ssh on port 22');
      await first.hub.stepUp({ password: PASSWORD });
      await expect(first.hub.applyFirewallChanges(enableOnly)).rejects.toThrow(
        /would cut this computer off from SSH/,
      );
      expect(server.run('ufw status')).toBe('Status: inactive');

      const change = await first.hub.applyFirewallChanges({
        changes: [
          tcp(22),
          tcp(8080),
          tcp(5432, '10.0.0.0/8'),
          tcp(5432, '2001:db8::/32'),
          denyFrom('203.0.113.7'),
          { kind: 'enable' },
        ],
        sshConnection: first.sshConnection,
      });
      expect(change.state).toBe('awaitingConfirmation');
      expect(change.appliedFrom).toBeTruthy();

      // AC3: the rules are live in both families.
      const v4 = server.run('iptables-save');
      const v6 = server.run('ip6tables-save');
      expect(v4).toMatch(/-A ufw-user-input -p tcp -m tcp --dport 8080 -j ACCEPT/);
      expect(v4).toMatch(
        /-A ufw-user-input -s 10\.0\.0\.0\/8 -p tcp -m tcp --dport 5432 -j ACCEPT/,
      );
      expect(v4).toMatch(/-A ufw-user-input -s 203\.0\.113\.7\/32 -j DROP/);
      expect(v4).not.toContain('2001:db8');
      expect(v6).toMatch(/-A ufw6-user-input -p tcp -m tcp --dport 8080 -j ACCEPT/);
      expect(v6).toMatch(
        /-A ufw6-user-input -s 2001:db8::\/32 -p tcp -m tcp --dport 5432 -j ACCEPT/,
      );
      expect(v6).not.toContain('10.0.0.0/8');
      expect(server.run('ufw status verbose')).toMatch(/Status: active[\s\S]*8080\/tcp \(v6\)/);

      // Confirming over the SSH connection that made the change proves nothing; a new one does.
      await expect(first.hub.confirmFirewallChanges(change.id)).rejects.toThrow(
        /same SSH connection/,
      );
      const second = await core.connect(newPool(server), 'bridge');
      const confirmed = await second.hub.confirmFirewallChanges(change.id);
      expect(confirmed.state).toBe('confirmed');
      expect(server.run('systemctl list-timers --all --no-legend')).not.toContain(
        'runova-fwrevert',
      );
      await first.stop();
      await second.stop();

      await unconfirmedChangeRevertsWithTheCoreKilled(core, () => ({
        v4: server.run('iptables-save').includes('--dport 7070 -j ACCEPT'),
        v6: server.run('ip6tables-save').includes('--dport 7071 -j ACCEPT'),
      }));
      // What was confirmed before stays.
      expect(server.run('iptables-save')).toMatch(/--dport 8080 -j ACCEPT/);
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(!onFirewalld)(
    'manages firewalld for IPv4 and IPv6, confirms over a new connection and rolls back with the core killed',
    async () => {
      const core = await installCore('rocky-9-firewalld');
      const { server } = core;
      const first = await core.connect(core.pool);

      const status = await first.hub.getFirewallStatus();
      expect(status).toMatchObject({ backend: 'firewalld', active: true, zone: 'public' });
      const ssh = status.rules.find((rule) => rule.service === 'ssh');
      expect(ssh?.editable).toBe(true);

      // AC2: removing the ssh service from a zone that rejects everything else is refused.
      await expect(
        first.hub.applyFirewallChanges({
          changes: [{ kind: 'removeRule', ruleId: ssh?.id ?? '' }],
          sshConnection: first.sshConnection,
        }),
      ).rejects.toThrow(/would cut this computer off from SSH/);
      expect(server.run('firewall-cmd --list-services')).toContain('ssh');

      const change = await first.hub.applyFirewallChanges({
        changes: [
          tcp(8080),
          tcp(5432, '10.0.0.0/8'),
          tcp(5432, '2001:db8::/32'),
          denyFrom('203.0.113.7'),
        ],
        sshConnection: first.sshConnection,
      });
      expect(change.state).toBe('awaitingConfirmation');

      // AC3: in firewalld's runtime and saved settings, and in the kernel's ruleset for both families.
      const listing = server.run('firewall-cmd --zone=public --list-all');
      expect(listing).toContain('8080/tcp');
      expect(listing).toContain(
        'rule family="ipv6" source address="2001:db8::/32" port port="5432" protocol="tcp" accept',
      );
      expect(server.run('firewall-cmd --permanent --zone=public --list-ports')).toContain(
        '8080/tcp',
      );
      const nft = server.run('nft list ruleset');
      expect(nft).toMatch(/tcp dport 8080 accept/);
      expect(nft).toMatch(/ip saddr 10\.0\.0\.0\/8 tcp dport 5432 accept/);
      expect(nft).toMatch(/ip6 saddr 2001:db8::\/32 tcp dport 5432 accept/);
      expect(nft).toMatch(/ip saddr 203\.0\.113\.7 drop/);

      await expect(first.hub.confirmFirewallChanges(change.id)).rejects.toThrow(
        /same SSH connection/,
      );
      const second = await core.connect(newPool(server));
      expect((await second.hub.confirmFirewallChanges(change.id)).state).toBe('confirmed');
      await first.stop();
      await second.stop();

      await unconfirmedChangeRevertsWithTheCoreKilled(core, () => {
        const nftNow = server.run('nft list ruleset');
        return {
          v4: /tcp dport 7070 accept/.test(nftNow),
          v6: /ip6 saddr 2001:db8:7::\/48 tcp dport 7071 accept/.test(nftNow),
        };
      });
      expect(server.run('firewall-cmd --zone=public --list-ports')).toContain('8080/tcp');
    },
    TEST_TIMEOUT_MS,
  );
});
