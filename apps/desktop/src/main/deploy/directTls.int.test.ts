import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { closePortChanges, openPortChanges } from '../../shared/deploy/directTlsValidation';
import { SshConnectionPool } from '../ssh/pool';
import { localArtifactSource } from './bootstrap/releaseSource';
import { CoreHttpClient } from './connection/coreHttp';
import { clientCertificate } from './directTls/clientCertificate';
import { DeployDirectTls } from './directTls/service';
import { directTlsTransport, PinMismatchError } from './directTls/transport';
import { DeployFirewall } from './firewall';
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
 * Direct TLS (E16) on a real machine: the published core on the ufw test server, turned on from
 * the app's own service. The port is closed by ufw until the app's firewall change set opens it
 * (and the link falls back to SSH meanwhile); then the link rides TLS with the device key. A
 * connection without a client certificate, with a key the core does not know, with a revoked
 * device, or to a server whose key is not the pin, is refused. Turning it off closes the port and
 * takes the ufw rule away. Needs RUNOVA_SYSTEM_TESTS=1, Docker, and
 * `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
const onUfw = testServerImages(['ubuntu-24.04-ufw'], ['ubuntu-24.04-ufw']).length > 0;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const ARTIFACTS = join(REPO, 'apps', 'server-core', 'artifacts', 'release');
const TEST_TIMEOUT_MS = 900_000;
const PASSWORD = 'correct horse battery staple';
const CORE = '/opt/runova-core/current/runova-core';

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

/** A raw TLS handshake plus one HTTP request; resolves with the status line or the error. */
function rawRequest(port: number, key?: string, certificate?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'runova-core',
      minVersion: 'TLSv1.3',
      rejectUnauthorized: false,
      ...(key && certificate ? { key, cert: certificate } : {}),
    });
    const done = (text: string) => {
      socket.destroy();
      resolve(text);
    };
    socket.setTimeout(10_000, () => done('timeout'));
    socket.once('secureConnect', () =>
      socket.write('GET /api/v1/health HTTP/1.1\r\nHost: runova-core\r\nConnection: close\r\n\r\n'),
    );
    socket.once('data', (chunk) => done(chunk.toString('utf8').split('\r\n')[0] ?? ''));
    socket.once('error', (error) => done(`error: ${error.message}`));
    socket.once('end', () => done('closed'));
  });
}

describe.skipIf(!enabled)('direct TLS on a real server', () => {
  it.skipIf(!onUfw)(
    'opens the port behind ufw, connects with the device key, refuses strangers and closes again',
    async () => {
      const tlsPort = await freePort();
      const server = await startTestServer('ubuntu-24.04-ufw', { publish: [tlsPort] });
      servers.push(server);
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
        unseal,
        deviceName: () => 'Integration test',
        availableVersion: async () => '0.0.0-dev',
        devCorePort: null,
        progress: () => undefined,
      });
      const install = await service.install({
        serverId: 'srv',
        sudoPassword: null,
        account: { userName: 'maria', password: PASSWORD },
      });
      expect(install.enrollmentError).toBeUndefined();
      const roles = (id: string) => service.roles(id);
      const directTls = new DeployDirectTls({ service, state, roles });
      const firewall = new DeployFirewall({
        links: service.links,
        service,
        roles,
        progress: () => undefined,
      });
      // ufw on, with SSH allowed, before the mode: the port stays closed until the app opens it.
      server.run('ufw allow 22/tcp >/dev/null && ufw --force enable >/dev/null');

      // Off by default: nothing listens on the port.
      const before = await directTls.status('srv');
      expect(before.status.enabled).toBe(false);
      expect(server.run(`ss -Htln 'sport = :${tlsPort}' | wc -l`)).toBe('0');

      const on = await directTls.enable({
        serverId: 'srv',
        port: tlsPort,
        sources: [],
        password: PASSWORD,
      });
      expect(on.status).toMatchObject({ enabled: true, listening: true, port: tlsPort });
      expect(on.pinned).toMatchObject({ enabled: true, pin: on.status.pin });
      expect(server.run(`ss -Htln 'sport = :${tlsPort}' | wc -l`)).toBe('1');
      expect(server.run(`stat -c %a /var/lib/runova-core/tls/server.key`)).toBe('600');

      // ufw drops the port, so the link falls back to the SSH tunnel.
      await service.links.call('srv', (hub) => hub.ping());
      expect(service.connection('srv').transport).toBe('streamlocal');

      // The rule, through a change set kept over a new SSH connection.
      const opened = await firewall.apply({
        serverId: 'srv',
        changes: openPortChanges(await firewall.status('srv'), tlsPort, []),
      });
      await firewall.confirm({ serverId: 'srv', changeSetId: opened.id });
      expect(server.run('ufw status')).toMatch(new RegExp(`${tlsPort}/tcp\\s+ALLOW`));

      service.directTlsChanged('srv');
      await service.links.call('srv', (hub) => hub.ping());
      expect(service.connection('srv').transport).toBe('direct-tls');
      const device = await state.device('srv');
      const key = await unseal(device!.privateKey);
      const health = await new CoreHttpClient(
        directTlsTransport({ host: '127.0.0.1', port: tlsPort, pin: on.status.pin }, async () =>
          clientCertificate(key),
        ),
      ).health();
      expect(health.version).toBe('0.0.0-dev');

      // AC1: no client certificate, or one for a key the core does not know, gets nothing.
      expect(await rawRequest(tlsPort)).not.toMatch(/^HTTP/);
      const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const strangerPem = stranger.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const strangerCert = clientCertificate(strangerPem);
      expect(await rawRequest(tlsPort, strangerPem, strangerCert.certificate)).not.toMatch(/^HTTP/);
      const mine = clientCertificate(key);
      expect(await rawRequest(tlsPort, key, mine.certificate)).toBe('HTTP/1.1 200 OK');

      // AC2: a key that is not the pinned one is refused before anything is sent.
      const wrongPin = directTlsTransport(
        { host: '127.0.0.1', port: tlsPort, pin: Buffer.alloc(32).toString('base64') },
        async () => clientCertificate(key),
      );
      await expect(wrongPin.openStream()).rejects.toBeInstanceOf(PinMismatchError);

      // A revoked device is refused at the handshake. A second device, enrolled as root.
      const second = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const secondPem = second.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      const secondPublic = createPublicKey(secondPem)
        .export({ format: 'der', type: 'spki' })
        .toString('base64');
      const enrolled = JSON.parse(
        server.run(
          `echo '${secondPublic}' | ${CORE} admin enroll-device --user maria --name second`,
        ),
      ) as { deviceId: string };
      const secondCert = clientCertificate(secondPem);
      expect(await rawRequest(tlsPort, secondPem, secondCert.certificate)).toBe('HTTP/1.1 200 OK');
      await service.withSshHub('srv', (hub) => hub.revokeDevice(enrolled.deviceId));
      expect(await rawRequest(tlsPort, secondPem, secondCert.certificate)).not.toMatch(/^HTTP/);

      // AC3: off closes the port, and the change set takes the rule away.
      const off = await directTls.disable('srv');
      expect(off.status).toMatchObject({ enabled: false, listening: false });
      expect(server.run(`ss -Htln 'sport = :${tlsPort}' | wc -l`)).toBe('0');
      const closed = await firewall.apply({
        serverId: 'srv',
        changes: closePortChanges(await firewall.status('srv'), tlsPort, []),
      });
      await firewall.confirm({ serverId: 'srv', changeSetId: closed.id });
      expect(server.run('ufw status')).not.toContain(`${tlsPort}/tcp`);
      await service.links.call('srv', (hub) => hub.ping());
      expect(service.connection('srv').transport).toBe('streamlocal');
      service.links.closeAll();
    },
    TEST_TIMEOUT_MS,
  );
});
