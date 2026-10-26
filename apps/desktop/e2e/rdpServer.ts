import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

export { dockerAvailable } from './sshServer';

const IMAGE = 'runova-e2e-rdp-server';

export const RDP_USER = 'rdpuser';
export const RDP_PASSWORD = 'rdp-pass-123';
/** xrdp gives the first session display :10. */
const DISPLAY = ':10';

export interface RdpTestServer {
  host: string;
  port: number;
  /** The container's name, for tests that check results with `docker exec`. */
  name: string;
  stop: () => void;
}

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout, stdio: 'pipe' }).trim();
}

/**
 * Runs a shell command in the server's container as the desktop user, with DISPLAY pointing at the
 * running session. Running as that user is what lets X tools read the session's ~/.Xauthority.
 */
export function rdpExec(server: RdpTestServer, command: string): string {
  return docker([
    'exec',
    '-u',
    RDP_USER,
    '-e',
    `DISPLAY=${DISPLAY}`,
    '-e',
    `HOME=/home/${RDP_USER}`,
    server.name,
    'sh',
    '-c',
    command,
  ]);
}

/**
 * Resolves once xrdp listens inside the container. Docker's port proxy on the host accepts
 * connections before anything listens behind it, so probing the published port proves nothing.
 */
async function waitForXrdp(name: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      docker(['exec', name, 'bash', '-c', 'exec 3<>/dev/tcp/127.0.0.1/3389'], 10_000);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`xrdp in ${name} never became ready: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * Builds the server image. The first build installs a whole desktop and can take many minutes,
 * so a spec calls this once up front with a long timeout; later builds come from the cache.
 */
export function buildRdpServerImage(): void {
  docker(['build', '-q', '-t', IMAGE, join(APP_ROOT, 'e2e', 'rdp-server')], 1_200_000);
}

/**
 * Starts a disposable Ubuntu xrdp server with an XFCE desktop (see rdp-server/Dockerfile) on a
 * free local port.
 */
export async function startRdpServer(): Promise<RdpTestServer> {
  buildRdpServerImage();
  const name = `runova-e2e-rdp-${process.pid}-${Date.now()}`;
  docker(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::3389', IMAGE]);
  const stop = () => {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Already gone.
    }
  };
  try {
    const mapping = docker(['port', name, '3389/tcp']).split(/\r?\n/)[0];
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    await waitForXrdp(name, Date.now() + 30_000);
    return { host: '127.0.0.1', port, name, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
