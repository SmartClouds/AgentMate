import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  startSshServer,
} from '../../../e2e/sshServer';
import { sshErrorCode } from '../../shared/sshErrors';
import { SshConnection } from './connection';
import { detectSudoMode, openRootShell } from './sudo';

/**
 * The same operations as the unit tests, against a real OpenSSH server in Docker: real sudo that
 * asks for the password, real SFTP, real stream-local forwarding. Skipped without Docker.
 */

const docker = dockerAvailable();
let server: SshTestServer | null = null;

beforeAll(async () => {
  if (docker) server = await startSshServer();
}, 900_000);

afterAll(() => server?.stop());

function open(): Promise<SshConnection> {
  if (!server) throw new Error('no server');
  return SshConnection.open({
    host: server.host,
    port: server.port,
    username: SSH_USER,
    authMethod: 'password',
    password: SSH_PASSWORD,
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

describe.skipIf(!docker)('SSH against OpenSSH', () => {
  it('returns real exit codes with stdout and stderr apart', async () => {
    const connection = await open();
    try {
      const result = await connection.exec("sh -c 'echo out; echo err >&2; exit 7'");

      expect(result).toMatchObject({
        stdout: 'out\n',
        stderr: 'err\n',
        exitCode: 7,
        timedOut: false,
      });
    } finally {
      connection.close();
    }
  });

  it('runs as root through a sudo that asks for the password, with the payload intact', async () => {
    const connection = await open();
    try {
      expect(await detectSudoMode(connection)).toBe('password');
      const root = await openRootShell(connection, SSH_PASSWORD);
      const payload = randomBytes(64 * 1024);
      payload.write('\n\n', 100);

      const who = await root.run('id -u');
      const stored = await root.run('cat > /root/payload.bin && sha256sum /root/payload.bin', {
        stdin: payload,
      });

      expect(who.stdout.trim()).toBe('0');
      expect(stored.exitCode).toBe(0);
      expect(stored.stdout.split(' ')[0]).toBe(sha256(payload));
    } finally {
      connection.close();
    }
  });

  it('refuses a wrong sudo password before running anything', async () => {
    const connection = await open();
    try {
      const marker = `/root/never-${Date.now()}`;

      await expect(openRootShell(connection, 'not the password')).rejects.toSatisfy(
        (error) => sshErrorCode(error) === 'sudo-password-rejected',
      );
      const root = await openRootShell(connection, SSH_PASSWORD);
      const check = await root.run(`test -e ${marker} && echo present || echo absent`);
      expect(check.stdout.trim()).toBe('absent');
    } finally {
      connection.close();
    }
  });

  it('uploads atomically into a staging folder the login user owns', async () => {
    const connection = await open();
    try {
      const staging = await connection.createStagingDirectory();
      const content = randomBytes(1024 * 1024);
      const progress: number[] = [];

      await connection.upload(content, `${staging}/runova-core`, {
        mode: 0o600,
        onProgress: (sent) => progress.push(sent),
      });
      const listing = await connection.exec(`ls -A ${staging}`);
      const check = await connection.exec(
        `sha256sum ${staging}/runova-core | cut -d' ' -f1; stat -c %a ${staging}/runova-core`,
      );

      expect(listing.stdout.trim()).toBe('runova-core');
      const [hash, mode] = check.stdout.trim().split('\n');
      expect(hash).toBe(sha256(content));
      expect(mode).toBe('600');
      expect(progress.at(-1)).toBe(content.length);
    } finally {
      connection.close();
    }
  });

  it('never leaves a partial file at the destination when the connection drops', async () => {
    const first = await open();
    const staging = await first.createStagingDirectory();
    const upload = first.upload(randomBytes(16 * 1024 * 1024), `${staging}/runova-core`, {
      onProgress: (sent) => {
        if (sent > 256 * 1024) first.close();
      },
    });
    await expect(upload).rejects.toThrow();

    const second = await open();
    try {
      const check = await second.exec(
        `test -e ${staging}/runova-core && echo present || echo absent`,
      );
      expect(check.stdout.trim()).toBe('absent');
    } finally {
      second.close();
    }
  });

  it('tunnels to a TCP port on the server', async () => {
    const connection = await open();
    try {
      const stream = await connection.openStream({ host: '127.0.0.1', port: 22 });
      const banner = await new Promise<string>((resolve) => {
        stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      });
      stream.destroy();

      expect(banner).toMatch(/^SSH-2\.0-OpenSSH/);
    } finally {
      connection.close();
    }
  });

  it('tunnels to a Unix socket on the server', async () => {
    const connection = await open();
    try {
      const socketPath = `/tmp/runova-uds-${Date.now()}.sock`;
      // ssh-agent is part of every OpenSSH install and listens on a Unix socket of our choosing.
      const agent = await connection.exec(`ssh-agent -a ${socketPath}`);
      expect(agent.exitCode).toBe(0);

      const stream = await connection.openStream({ socketPath });
      const reply = new Promise<Buffer>((resolve) => {
        stream.once('data', (chunk: Buffer) => resolve(chunk));
      });
      // SSH_AGENTC_REQUEST_IDENTITIES; the agent answers SSH_AGENT_IDENTITIES_ANSWER (12).
      stream.write(Buffer.from([0, 0, 0, 1, 11]));

      expect((await reply)[4]).toBe(12);
      stream.destroy();
      await connection.exec(`pkill -f "ssh-agent -a ${socketPath}"; rm -f ${socketPath}`);
    } finally {
      connection.close();
    }
  });
});
