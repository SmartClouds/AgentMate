import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestServer } from './testServers';

/**
 * Let's Encrypt's Pebble and pebble-challtestsrv inside a test server's network namespace, the
 * desktop twin of the server core's PebbleFixture (same images, flags and configuration). The
 * core reaches Pebble on https://127.0.0.1:14000/dir, which Pebble's certificate names; every DNS
 * name answers 127.0.0.1, so Pebble validates HTTP-01 against the server's own nginx on port 80.
 * Pebble's test CA (minica, for its API only) goes into the server's trust store, since the
 * core's ACME client uses the system's. Only the two containers made here are removed.
 */

export const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.10.1';
export const CHALLTESTSRV_IMAGE = 'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1';

/** Where the core finds Pebble from inside the server. */
export const PEBBLE_DIRECTORY = 'https://127.0.0.1:14000/dir';

const MINICA_PATH = '/usr/local/share/ca-certificates/runova-pebble-minica.crt';

// Pebble's own test configuration with Retry-After cut to a second and one ninety-day profile,
// validating HTTP-01 on port 80, where nginx answers.
const CONFIGURATION = {
  pebble: {
    listenAddress: '0.0.0.0:14000',
    managementListenAddress: '0.0.0.0:15000',
    certificate: 'test/certs/localhost/cert.pem',
    privateKey: 'test/certs/localhost/key.pem',
    httpPort: 80,
    tlsPort: 5001,
    ocspResponderURL: '',
    externalAccountBindingRequired: false,
    domainBlocklist: ['blocked-domain.example'],
    retryAfter: { authz: 1, order: 1 },
    keyAlgorithm: 'ecdsa',
    profiles: { default: { description: 'Ninety days', validityPeriod: 7776000 } },
  },
};

export interface PebbleOnServer {
  /** Pebble's current root (chain 0), as PEM: what a browser would have to trust. */
  rootPem: () => string;
  stop: () => void;
}

function docker(args: string[], timeout = 120_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
  }).trim();
}

function ensureImage(image: string): void {
  try {
    docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    return;
  } catch {
    // Not here yet.
  }
  // Registry pulls fail now and then on a slow network; three tries before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      docker(['pull', '--quiet', image], 600_000);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

async function waitFor(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`${what} did not come up within a minute.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The core's settings file pointing both of its ACME directories at Pebble; write it before the install. */
export function pointCoreAtPebble(server: TestServer): void {
  const settings = JSON.stringify({
    Core: { Acme: { ProductionDirectory: PEBBLE_DIRECTORY, StagingDirectory: PEBBLE_DIRECTORY } },
  });
  server.run(
    `mkdir -p /etc/runova-core && echo ${Buffer.from(settings).toString('base64')} | base64 -d > /etc/runova-core/core.json && chmod 0600 /etc/runova-core/core.json`,
  );
}

export async function startPebbleOn(server: TestServer): Promise<PebbleOnServer> {
  ensureImage(PEBBLE_IMAGE);
  ensureImage(CHALLTESTSRV_IMAGE);
  const suffix = `${process.pid}-${Date.now()}`;
  const pebble = `runova-pebble-${suffix}`;
  const challenges = `runova-challtestsrv-${suffix}`;
  const made: string[] = [];
  const work = mkdtempSync(join(tmpdir(), 'runova-pebble-'));
  const stop = () => {
    for (const name of made.splice(0)) {
      try {
        docker(['rm', '--force', name]);
      } catch {
        // Already gone.
      }
    }
    rmSync(work, { recursive: true, force: true });
  };
  const network = `container:${server.name}`;
  const look = (url: string) =>
    server.run(`curl -sS --max-time 5 --cacert ${MINICA_PATH} ${url} || true`);
  try {
    // challtestsrv: DNS on 8053 answering 127.0.0.1 for every name and no AAAA, nothing else.
    made.push(challenges);
    docker([
      'run',
      '--detach',
      '--name',
      challenges,
      '--network',
      network,
      CHALLTESTSRV_IMAGE,
      '-defaultIPv4',
      '127.0.0.1',
      '-defaultIPv6',
      '',
      '-http01',
      '',
      '-https01',
      '',
      '-tlsalpn01',
      '',
      '-doh',
      '',
    ]);

    // Pebble: strict mode, no artificial validation delays, DNS from challtestsrv. Created first
    // so its configuration can be copied in and its test CA out before it starts.
    made.push(pebble);
    docker([
      'create',
      '--name',
      pebble,
      '--network',
      network,
      '--env',
      'PEBBLE_VA_NOSLEEP=1',
      PEBBLE_IMAGE,
      '-config',
      '/test/config/runova.json',
      '-strict',
      '-dnsserver',
      '127.0.0.1:8053',
    ]);
    const configuration = join(work, 'runova.json');
    writeFileSync(configuration, JSON.stringify(CONFIGURATION, null, 2));
    docker(['cp', configuration, `${pebble}:/test/config/runova.json`]);
    const minica = join(work, 'pebble.minica.pem');
    docker(['cp', `${pebble}:/test/certs/pebble.minica.pem`, minica]);
    const trusted = Buffer.from(readFileSync(minica)).toString('base64');
    server.run(
      `echo ${trusted} | base64 -d > ${MINICA_PATH} && update-ca-certificates > /dev/null 2>&1`,
    );
    docker(['start', pebble]);
    await waitFor(() => look(PEBBLE_DIRECTORY).includes('newOrder'), 'Pebble');
  } catch (error) {
    const logs = (() => {
      try {
        return execFileSync('docker', ['logs', '--tail', '30', pebble], { encoding: 'utf-8' });
      } catch {
        return '';
      }
    })();
    stop();
    throw new Error(`Pebble did not start: ${String(error)}\n${logs}`);
  }
  return {
    rootPem: () => {
      const pem = look('https://127.0.0.1:15000/roots/0');
      if (!pem.includes('BEGIN CERTIFICATE')) throw new Error(`Pebble gave no root: ${pem}`);
      return pem;
    },
    stop,
  };
}
