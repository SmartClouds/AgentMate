import { expect, type Page } from '@playwright/test';
import { onServer } from '../src/main/deploy/testing/privateRegistry';
import {
  startTestServer,
  type TestServer,
  type TestServerImage,
} from '../src/main/deploy/testing/testServerMachines';
import { PEBBLE_DIRECTORY, type Pebble, startPebble } from './pebble';

/**
 * The machine side of the full-stack run (deployFullStack.e2e.ts): a systemd test server, the
 * same as the system tests boot, next to a Pebble of its own. Before the app sees the server,
 * it trusts Pebble's test CA, reaches Pebble as `pebble`, and has the core's ACME directory
 * pointed at it in /etc/runova-core/core.json (which the installer leaves alone), the way a
 * staging setup would. The test DNS maps the site's domain to the server's address, so Pebble's
 * HTTP-01 check lands on the nginx the core runs there.
 */

/** The site's domain, mapped in the test DNS. */
export const SITE_DOMAIN = 'shop.runova.test';

export interface FullStackServer {
  server: TestServer;
  pebble: Pebble;
  /** A shell command on the server as root, outside SSH and the app. */
  sh: (command: string, input?: string) => string;
  stop: () => void;
}

export async function startFullStackServer(image: TestServerImage): Promise<FullStackServer> {
  const pebble = await startPebble();
  let server: TestServer | undefined;
  try {
    server = await startTestServer(image);
    const name = server.name;
    const sh = (command: string, input?: string) => onServer(name, command, input);
    const address = pebble.addressOf(name);
    // biome-ignore lint/suspicious/noConsole: names what this run created, for a cleanup by hand
    console.log(`Test server ${name}, with ${pebble.names.join(' and ')}`);
    sh('cat >> /etc/hosts', `${pebble.address} pebble\n`);
    sh(
      [
        'if command -v update-ca-certificates >/dev/null; then',
        '  cat > /usr/local/share/ca-certificates/pebble-test-ca.crt && update-ca-certificates;',
        'else',
        '  cat > /etc/pki/ca-trust/source/anchors/pebble-test-ca.pem && update-ca-trust;',
        'fi',
      ].join('\n'),
      pebble.rootPem,
    );
    sh(
      'mkdir -p /etc/runova-core && chmod 700 /etc/runova-core && cat > /etc/runova-core/core.json && chmod 600 /etc/runova-core/core.json',
      JSON.stringify({ Core: { Acme: { ProductionDirectory: PEBBLE_DIRECTORY } } }),
    );
    await pebble.mapDomain(SITE_DOMAIN, address);
    // Pebble is up, and the server trusts it, before anything relies on either.
    sh(
      `for i in $(seq 1 60); do curl -sf -o /dev/null ${PEBBLE_DIRECTORY} && exit 0; sleep 1; done; curl -sS ${PEBBLE_DIRECTORY}`,
    );
    const started = server;
    return {
      server: started,
      pebble,
      sh,
      stop: () => {
        started.stop();
        pebble.stop();
      },
    };
  } catch (error) {
    const details = server?.diagnose() ?? '';
    server?.stop();
    pebble.stop();
    throw new Error(`The full-stack server did not come up: ${String(error)}\n${details}`);
  }
}

/** The container compose runs for `service`, by its compose label. */
export function containerOf(machine: FullStackServer, service: string): string {
  const names = machine
    .sh(`docker ps -a --filter label=com.docker.compose.service=${service} --format '{{.Names}}'`)
    .split('\n')
    .filter(Boolean);
  if (names.length !== 1) throw new Error(`Expected one ${service} container, found: ${names}`);
  return names[0] ?? '';
}

/** Waits for the open job dialog's outcome, closes it, and says what it was. */
export async function finishJob(page: Page, timeout: number): Promise<string> {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('log', { name: 'Job log' }) });
  const status = dialog.getByRole('status');
  await expect(status).toHaveText(/Done|Failed|Cancelled/, { timeout });
  const outcome = (await status.textContent()) ?? '';
  if (!/Done/.test(outcome)) {
    const log = await dialog.getByRole('log', { name: 'Job log' }).textContent();
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see why a job failed
    console.log(`Job ended "${outcome}":\n${(log ?? '').slice(-4_000)}`);
  }
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
  return outcome;
}

/** The fixture project's first revision: a web service with the environment's greeting. */
export const COMPOSE_WEB = `services:
  web:
    image: busybox:1.37
    # Loaded from this computer: the test server's way to Docker Hub can be slow.
    pull_policy: never
    command: ["sh", "-c", "mkdir -p /www && echo \\"$$GREETING\\" > /www/index.html && exec httpd -f -p 8080 -h /www"]
    restart: unless-stopped
    environment:
      GREETING: \${GREETING}
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"]
      interval: 2s
      retries: 15
`;

/**
 * The second revision adds a worker from the private registry. It checks the web service every
 * two seconds and exits when it is gone, so stopping web sends the worker into a crash loop.
 */
export const composeWithWorker = (image: string) => `${COMPOSE_WEB}  worker:
    image: ${image}
    command: ["sh", "-c", "while wget -q -O /dev/null http://web:8080/; do sleep 2; done; exit 1"]
    restart: always
    depends_on:
      web:
        condition: service_healthy
`;
