import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Let's Encrypt's Pebble and pebble-challtestsrv for the full-stack run: the server core's own
 * Pebble harness (PebbleFixture.cs in the system tests) with the same images and configuration,
 * HTTP-01 on port 80 as in PebbleOnPort80Fixture, so Pebble checks a domain against the nginx the
 * core runs. challtestsrv is the test DNS Pebble asks for every name, and `mapDomain` points a
 * name at the test server.
 *
 * Unlike the harness, both run on Docker's default bridge, next to the test server, rather than
 * on a network of their own. A test server joined to a second network lost its published SSH port
 * on GitHub's Linux runners (its default route moves to the network whose name sorts first), so
 * the app could not reach it. The test server reaches Pebble's API
 * as `https://pebble:14000/dir` (Pebble's own certificate names `pebble`) through a hosts entry,
 * once it trusts Pebble's test CA. Both containers get a random suffix and are removed by `stop`.
 */

const PEBBLE_IMAGE = 'ghcr.io/letsencrypt/pebble:2.10.1';
const CHALLTESTSRV_IMAGE = 'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1';
const MANAGEMENT_PORT = 8055;

/** Pebble's test configuration with Retry-After cut to a second and one 90-day profile. */
const CONFIGURATION = JSON.stringify({
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
    profiles: { default: { description: 'Ninety days', validityPeriod: 7_776_000 } },
  },
});

/** The directory URL a test server uses, through a `pebble` entry in its /etc/hosts. */
export const PEBBLE_DIRECTORY = 'https://pebble:14000/dir';

export interface Pebble {
  /** The containers this started, for a cleanup by hand. */
  names: string[];
  /** A container's address on the default bridge, where Pebble reaches it. */
  addressOf: (container: string) => string;
  /** Points `domain` at `address` in the test DNS, as a real A record would. */
  mapDomain: (domain: string, address: string) => Promise<void>;
  /** Pebble's test CA, PEM, for the test server's trust store. */
  rootPem: string;
  /** Pebble's own address on the default bridge, for the test server's /etc/hosts. */
  address: string;
  stop: () => void;
}

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
  }).trim();
}

/** Registry pulls fail now and then on a slow network; three tries before giving up. */
function ensureImage(image: string): void {
  try {
    docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    return;
  } catch {
    // Not here yet.
  }
  for (let attempt = 1; ; attempt++) {
    try {
      docker(['pull', '--quiet', image], 600_000);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

function addressOf(container: string): string {
  return docker([
    'inspect',
    '--format',
    '{{.NetworkSettings.Networks.bridge.IPAddress}}',
    container,
  ]);
}

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request(
      { host: '127.0.0.1', port, path: `/${path}`, method: 'POST' },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    call.once('error', reject);
    call.setTimeout(5_000, () => call.destroy(new Error(`challtestsrv did not answer ${path}`)));
    call.end(JSON.stringify(body));
  });
}

async function postChecked(port: number, path: string, body: unknown): Promise<void> {
  const status = await post(port, path, body);
  if (status !== 200) throw new Error(`challtestsrv answered ${path} with ${status}`);
}

export async function startPebble(): Promise<Pebble> {
  ensureImage(PEBBLE_IMAGE);
  ensureImage(CHALLTESTSRV_IMAGE);
  const suffix = randomBytes(5).toString('hex');
  const pebble = `runova-pebble-${suffix}`;
  const challenges = `runova-challtestsrv-${suffix}`;
  const created: string[] = [];
  const stop = () => {
    for (const container of created.splice(0)) {
      try {
        docker(['rm', '--force', container]);
      } catch {
        // Already gone.
      }
    }
  };

  try {
    // challtestsrv: DNS on 8053 and HTTP-01 on 5002 for every name, no AAAA answers (so Pebble
    // never tries IPv6), and the HTTPS, TLS-ALPN and DoH servers off.
    created.push(challenges);
    docker([
      'run',
      '--detach',
      '--name',
      challenges,
      '--publish',
      `127.0.0.1::${MANAGEMENT_PORT}`,
      CHALLTESTSRV_IMAGE,
      '-defaultIPv6',
      '',
      '-https01',
      '',
      '-tlsalpn01',
      '',
      '-doh',
      '',
    ]);
    const challengeAddress = addressOf(challenges);
    const mapping = docker(['port', challenges, `${MANAGEMENT_PORT}/tcp`]).split('\n')[0] ?? '';
    const managementPort = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await postChecked(managementPort, 'set-default-ipv4', { ip: challengeAddress });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Pebble: strict, no artificial validation delays, DNS from challtestsrv. Created first so
    // the configuration can be copied in before it starts.
    created.push(pebble);
    docker([
      'create',
      '--name',
      pebble,
      '--env',
      'PEBBLE_VA_NOSLEEP=1',
      PEBBLE_IMAGE,
      '-config',
      '/test/config/runova.json',
      '-strict',
      '-dnsserver',
      `${challengeAddress}:8053`,
    ]);
    const folder = mkdtempSync(join(tmpdir(), 'runova-pebble-'));
    let rootPem: string;
    try {
      writeFileSync(join(folder, 'runova.json'), CONFIGURATION);
      docker(['cp', join(folder, 'runova.json'), `${pebble}:/test/config/runova.json`]);
      docker(['cp', `${pebble}:/test/certs/pebble.minica.pem`, join(folder, 'minica.pem')]);
      rootPem = readFileSync(join(folder, 'minica.pem'), 'utf-8');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    docker(['start', pebble]);
    const address = addressOf(pebble);

    return {
      names: [...created],
      addressOf,
      mapDomain: (domain, target) =>
        postChecked(managementPort, 'add-a', { host: `${domain}.`, addresses: [target] }),
      rootPem,
      address,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
