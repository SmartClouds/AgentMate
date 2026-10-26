import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';

/**
 * Disposable Linux servers for system tests and the full-stack e2e run: the images in
 * `apps/server-core/test-servers`, with systemd as PID 1 and sshd, started privileged on a free
 * local port. Each has a root login and a `deployer` whose sudo asks for its password. Only runs
 * with RUNOVA_SYSTEM_TESTS=1, since a test boots whole machines.
 *
 * On an Ubuntu host with AppArmor (24.04 and later), the host's `unix-chkpwd` profile confines the
 * Rocky server's unix_chkpwd too, and every password login there fails. CI unloads that profile
 * first (see the "Let the Rocky test server check passwords" step in test.yml); do the same there
 * before running these tests on such a machine.
 */

export type TestServerImage =
  | 'ubuntu-24.04'
  | 'debian-13'
  | 'rocky-9'
  | 'ubuntu-24.04-ufw'
  | 'rocky-9-firewalld';

/** The plain distro servers, without a firewall: what the nightly matrix runs most tests on. */
export const DISTRO_IMAGES = ['ubuntu-24.04', 'debian-13', 'rocky-9'] as const;

const ALL_IMAGES: readonly TestServerImage[] = [
  'ubuntu-24.04',
  'debian-13',
  'rocky-9',
  'ubuntu-24.04-ufw',
  'rocky-9-firewalld',
];

/**
 * The images named in RUNOVA_TEST_SERVER_IMAGES (comma separated), or null when it is unset.
 * The nightly workflow sets it to run each system test on one server of the full matrix.
 */
export function requestedImages(
  value: string | undefined = process.env.RUNOVA_TEST_SERVER_IMAGES,
): TestServerImage[] | null {
  if (!value?.trim()) return null;
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !ALL_IMAGES.includes(name as TestServerImage));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown test server image ${unknown.join(', ')}; expected one of ${ALL_IMAGES.join(', ')}`,
    );
  }
  return names as TestServerImage[];
}

/**
 * The servers a system test runs on: its defaults (what every CI run runs), or, when
 * images are asked for, those of them the test supports.
 */
export function testServerImages<T extends TestServerImage>(
  supported: readonly T[],
  defaults: readonly T[],
  value: string | undefined = process.env.RUNOVA_TEST_SERVER_IMAGES,
): T[] {
  const requested = requestedImages(value);
  if (!requested) return [...defaults];
  return supported.filter((image) => requested.includes(image));
}

/** Images built on top of another test server's image, which has to exist first. */
const BASE_IMAGES: Partial<Record<TestServerImage, TestServerImage>> = {
  'ubuntu-24.04-ufw': 'ubuntu-24.04',
  'rocky-9-firewalld': 'rocky-9',
};

export const TEST_LOGINS = {
  root: { username: 'root', password: 'root-test-pw' },
  deployer: { username: 'deployer', password: 'deployer-test-pw' },
} as const;

export interface TestServer {
  host: string;
  port: number;
  /** The container's name, for `docker exec`, `docker cp` and `docker network connect`. */
  name: string;
  /** Runs a shell command inside the server as root, outside SSH, to look at or change state. */
  run: (command: string) => string;
  /** What the machine looked like when a test failed: boot state, sshd, and the journal's tail. */
  diagnose: () => string;
  stop: () => void;
}

// __dirname rather than import.meta: Playwright loads this file as CommonJS, and vitest
// provides __dirname too.
const IMAGES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'server-core', 'test-servers');

/**
 * SIGKILL on timeout: execFileSync waits for its child to exit and has no fallback, so a docker
 * CLI that shrugs off SIGTERM would otherwise block the whole test run.
 */
function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout,
    killSignal: 'SIGKILL',
    stdio: 'pipe',
  }).trim();
}

const BOOT_TIMEOUT_MS = 120_000;

/**
 * Waits for systemd to finish booting, asking again every second rather than with `--wait`,
 * whose wait has no end if a unit never settles. A boot that never finishes is reported, not
 * waited on: sshd may well be up anyway.
 */
async function waitForBoot(run: (command: string) => string): Promise<string> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let state = 'unknown';
  while (Date.now() < deadline) {
    try {
      state = run('systemctl is-system-running 2>/dev/null || true') || 'unknown';
    } catch (error) {
      state = `unknown (${String(error)})`;
    }
    if (state === 'running' || state === 'degraded') return state;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return `still ${state} after ${BOOT_TIMEOUT_MS / 1000} seconds`;
}

const DOCKER_PROBES = 3;

/**
 * Whether the system tests run: asked for, and a Docker with Linux containers answers. A Docker
 * that is busy (other test runs, image builds) can take longer than one probe allows, and a single
 * slow answer used to skip every test in a file without a word. So it asks again, and says why
 * when it gives up.
 */
export function systemTestsEnabled(
  flag: string | undefined = process.env.RUNOVA_SYSTEM_TESTS,
  osType: () => string = () => docker(['info', '--format', '{{.OSType}}'], 60_000),
  // biome-ignore lint/suspicious/noConsole: a run that skips what it was asked for has to say why
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  if (flag !== '1') return false;
  let failure = '';
  for (let probe = 0; probe < DOCKER_PROBES; probe++) {
    try {
      return osType().toLowerCase() === 'linux';
    } catch (error) {
      failure = String(error);
    }
  }
  warn(
    `RUNOVA_SYSTEM_TESTS=1, but Docker did not answer after ${DOCKER_PROBES} tries, so the system tests skip: ${failure}`,
  );
  return false;
}

function waitForBanner(host: string, port: number, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host, port });
      socket.setTimeout(2_000);
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`sshd on ${host}:${port} never became ready`));
        else setTimeout(attempt, 300);
      };
      socket.once('data', (chunk) => {
        socket.destroy();
        if (chunk.toString().startsWith('SSH-')) resolve();
        else retry();
      });
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

function ensureImage(image: TestServerImage): void {
  const tag = `runova-test-server:${image}`;
  try {
    docker(['image', 'inspect', tag]);
  } catch {
    const base = BASE_IMAGES[image];
    if (base) ensureImage(base);
    docker(['build', '-q', '-t', tag, join(IMAGES_DIR, image)], 1_800_000);
  }
}

export async function startTestServer(
  image: TestServerImage,
  options: {
    streamLocal?: boolean;
    /** Ports published on the same number on 127.0.0.1, for direct TLS (E16). */
    publish?: number[];
  } = {},
): Promise<TestServer> {
  const tag = `runova-test-server:${image}`;
  ensureImage(image);
  const name = `runova-test-${image}-${process.pid}-${Date.now()}`;
  // A private cgroup namespace, the setup systemd supports on cgroup v2 hosts. The host's own
  // namespace, with its cgroup tree mounted in, lets the container's systemd collide with the
  // host's where the host runs systemd too (GitHub's runners): boots that never finish there, and
  // sshd turning passwords down.
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--privileged',
    '--cgroupns=private',
    '--tmpfs',
    '/run',
    '--tmpfs',
    '/run/lock',
    // Docker inside the server keeps its layers off the container's overlay root, which the
    // kernel refuses to stack another overlay on. The images declare these volumes too, but an
    // image built from an older base lacks them; anonymous volumes go with the container.
    '--volume',
    '/var/lib/docker',
    '--volume',
    '/var/lib/containerd',
    '-p',
    '127.0.0.1::22',
    ...(options.publish ?? []).flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]),
    tag,
  ]);
  const stop = () => {
    try {
      // -v takes the anonymous Docker volumes along, which a forced remove would leave behind.
      docker(['rm', '-f', '-v', name]);
    } catch {
      // Already gone.
    }
  };
  const run = (command: string) => docker(['exec', name, 'sh', '-c', command], 120_000);
  let boot = 'not checked';
  const diagnose = () => {
    const look = (command: string) => {
      try {
        return run(command);
      } catch (error) {
        return `(${String(error)})`;
      }
    };
    return [
      `Boot: ${boot}; now ${look('systemctl is-system-running 2>&1 || true')}`,
      `Failed units: ${look('systemctl --failed --no-legend --plain 2>&1 || true') || 'none'}`,
      `PID 1 cgroup: ${look('cat /proc/1/cgroup')}`,
      `sshd: ${look("pid=$(pgrep -o sshd); grep -E '^(Uid|CapEff|CapBnd)' /proc/$pid/status | tr '\\n' ' '")}`,
      `Shadow: ${look('ls -l /etc/shadow')}`,
      `SELinux: ${look('(getenforce 2>&1 || echo no getenforce); grep -c selinuxfs /proc/mounts || true')}`,
      `Journal:\n${look('journalctl --no-pager -n 150 2>&1 | tail -150')}`,
    ].join('\n');
  };
  try {
    const mapping = docker(['port', name, '22/tcp']).split('\n')[0] ?? '';
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    // "degraded" is fine for a container (some units have nothing to do there).
    boot = await waitForBoot(run);
    if (options.streamLocal === false) {
      run(
        "sed -i '/^AllowStreamLocalForwarding/d' /etc/ssh/sshd_config && echo 'AllowStreamLocalForwarding no' >> /etc/ssh/sshd_config && (systemctl restart ssh 2>/dev/null || systemctl restart sshd)",
      );
    }
    await waitForBanner('127.0.0.1', port, Date.now() + 120_000);
    return { host: '127.0.0.1', port, name, run, diagnose, stop };
  } catch (error) {
    const details = diagnose();
    stop();
    throw new Error(`The ${image} test server did not come up: ${String(error)}\n${details}`);
  }
}
