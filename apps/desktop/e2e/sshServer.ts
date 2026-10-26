import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

const IMAGE = 'runova-e2e-ssh-server';

export const SSH_USER = 'smartvpn';
export const SSH_PASSWORD = 's3cret-pw';

export interface SshTestServer {
  host: string;
  port: number;
  /** The container's name, for tests that set files up with `docker exec`. */
  name: string;
  stop: () => void;
}

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout, stdio: 'pipe' }).trim();
}

/**
 * False when Docker can't start the test server, so the SSH tests skip. The server image is Ubuntu,
 * so a daemon in Windows container mode (what the Windows CI runners ship with) counts as missing.
 */
export function dockerAvailable(): boolean {
  try {
    return docker(['info', '--format', '{{.OSType}}'], 15_000).toLowerCase() === 'linux';
  } catch {
    return false;
  }
}

/**
 * Runs a shell command in the server's container, as the login user unless `user` says otherwise,
 * with `input` on its stdin. Extra `args` arrive as $1, $2 and so on, so paths need no quoting.
 */
export function serverExec(
  server: SshTestServer,
  command: string,
  options: { user?: string; input?: string; args?: string[] } = {},
): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      '-u',
      options.user ?? SSH_USER,
      server.name,
      'sh',
      '-c',
      command,
      'sh',
      ...(options.args ?? []),
    ],
    { encoding: 'utf-8', timeout: 30_000, input: options.input ?? '', stdio: 'pipe' },
  ).trim();
}

/** Resolves once sshd answers with its version banner, which it only sends when it's ready. */
function waitForBanner(host: string, port: number, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host, port });
      socket.setTimeout(2000);
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

/**
 * Starts a disposable Ubuntu SSH server (see ssh-server/Dockerfile) on a free local port. The user
 * logs in with a password and has to type it again for sudo, like a typical VPS account.
 */
export async function startSshServer(): Promise<SshTestServer> {
  docker(['build', '-q', '-t', IMAGE, join(APP_ROOT, 'e2e', 'ssh-server')], 600_000);
  const name = `runova-e2e-ssh-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--hostname',
    'e2e-server',
    '-p',
    '127.0.0.1::22',
    IMAGE,
  ]);
  const stop = () => {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Already gone.
    }
  };
  try {
    const mapping = docker(['port', name, '22/tcp']).split(/\r?\n/)[0];
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    await waitForBanner('127.0.0.1', port, Date.now() + 30_000);
    return { host: '127.0.0.1', port, name, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
