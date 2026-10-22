import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { APP_ROOT } from './paths';

/**
 * The Docker FTP, FTPS and SFTP servers for the FTP and SFTP site tests (E23), built from
 * ftp-server/Dockerfile. Tests skip it without Docker; see `dockerAvailable` in sshServer.ts.
 */

const IMAGE = 'agentmate-e2e-ftp-server';

export const FTP_USER = 'ftpuser';
export const FTP_PASSWORD = 'ftp-s3cret';
export const FTP_HOME = `/home/${FTP_USER}`;

export interface FtpTestServer {
  host: string;
  /** ProFTPD: FTP with MLSD, and FTPS (explicit TLS) on the same port. */
  ftpPort: number;
  ftpsPort: number;
  /** ProFTPD's mod_sftp, an SFTP server that is not OpenSSH. */
  sftpPort: number;
  /** vsftpd: LIST only, no MLSD. */
  listOnlyPort: number;
  user: string;
  password: string;
  /** SHA-256 of the self-signed FTPS certificate, lowercase hex without colons. */
  certFingerprint256: string;
  /** The container's name. */
  name: string;
  /**
   * Runs a shell command in the container as the FTP user, with `input` on its stdin. Extra
   * `args` arrive as $1, $2 and so on, so paths need no quoting.
   */
  exec: (command: string, options?: { input?: string; args?: string[]; user?: string }) => string;
  stop: () => void;
}

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout, stdio: 'pipe' }).trim();
}

/** Resolves once the server on `port` greets with a line starting with `greeting`. */
function waitForGreeting(port: number, greeting: string, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.setTimeout(2000);
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline)
          reject(new Error(`127.0.0.1:${port} never answered ${greeting}`));
        else setTimeout(attempt, 300);
      };
      socket.once('data', (chunk) => {
        socket.destroy();
        if (chunk.toString().startsWith(greeting)) resolve();
        else retry();
      });
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

/**
 * Ten passive ports for this process, published 1:1: FTP announces the port to connect to, so
 * the port inside the container has to be the one on this computer. The process id keeps two
 * test runs on one machine apart, and `attempt` moves on to another block when one is taken.
 *
 * The blocks stay under 32768, where Linux starts handing out ephemeral ports. Docker takes the
 * host port of every `127.0.0.1::22` mapping from there, the other test servers' included, so a
 * block above it could already belong to a container started a moment earlier.
 */
export function passivePortRange(pid = process.pid, attempt = 0): { min: number; max: number } {
  const min = 20_000 + ((pid + attempt * 101) % 1000) * 10;
  return { min, max: min + 9 };
}

/** Starts the container on the first passive port block nothing else on this computer holds. */
function runContainer(): string {
  for (let attempt = 0; ; attempt++) {
    const name = `agentmate-e2e-ftp-${process.pid}-${Date.now()}`;
    const { min, max } = passivePortRange(process.pid, attempt);
    try {
      docker([
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-e',
        `PASV_MIN=${min}`,
        '-e',
        `PASV_MAX=${max}`,
        '-e',
        'PASV_ADDRESS=127.0.0.1',
        '-p',
        '127.0.0.1::21',
        '-p',
        '127.0.0.1::2121',
        '-p',
        '127.0.0.1::2222',
        '-p',
        `127.0.0.1:${min}-${max}:${min}-${max}`,
        IMAGE,
      ]);
      return name;
    } catch (error) {
      // A container that could not bind its ports is left created but not running.
      try {
        docker(['rm', '-f', name]);
      } catch {
        // Never created.
      }
      // Another container, a process on Linux, or Docker Desktop's "ports are not available".
      const taken =
        /port is already allocated|address already in use|ports are not available/i.test(
          String((error as { stderr?: unknown }).stderr ?? error),
        );
      if (!taken || attempt >= 4) throw error;
    }
  }
}

export async function startFtpServer(): Promise<FtpTestServer> {
  docker(['build', '-q', '-t', IMAGE, join(APP_ROOT, 'e2e', 'ftp-server')], 900_000);
  const name = runContainer();
  const stop = () => {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Already gone.
    }
  };
  const portOf = (inside: number): number => {
    const mapping = docker(['port', name, `${inside}/tcp`]).split(/\r?\n/)[0];
    return Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  };
  const exec: FtpTestServer['exec'] = (command, options = {}) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        '-u',
        options.user ?? FTP_USER,
        name,
        'sh',
        '-c',
        command,
        'sh',
        ...(options.args ?? []),
      ],
      {
        encoding: 'utf-8',
        timeout: 30_000,
        input: options.input ?? '',
        stdio: 'pipe',
        // Tests read files back as base64, a few MB for the big-file checks.
        maxBuffer: 64 * 1024 * 1024,
      },
    ).trim();
  try {
    const ftpPort = portOf(21);
    const listOnlyPort = portOf(2121);
    const sftpPort = portOf(2222);
    const deadline = Date.now() + 30_000;
    await waitForGreeting(ftpPort, '220', deadline);
    await waitForGreeting(listOnlyPort, '220', deadline);
    await waitForGreeting(sftpPort, 'SSH-', deadline);
    const fingerprint = exec(
      'openssl x509 -noout -fingerprint -sha256 -in /etc/proftpd/tls/cert.pem',
      { user: 'root' },
    );
    return {
      host: '127.0.0.1',
      ftpPort,
      ftpsPort: ftpPort,
      sftpPort,
      listOnlyPort,
      user: FTP_USER,
      password: FTP_PASSWORD,
      certFingerprint256: fingerprint
        .slice(fingerprint.indexOf('=') + 1)
        .replace(/:/g, '')
        .toLowerCase(),
      name,
      exec,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
