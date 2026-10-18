import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FtpTestServer, startFtpServer } from '../../../../../e2e/ftpServer';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  startSshServer,
} from '../../../../../e2e/sshServer';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import { openRemoteFiles, readHostKey } from '../connect';
import type { FilesConnectTarget } from '../types';
import { type ContractHarness, describeRemoteFilesContract } from './contract';
import type { FilesTransportError } from './errors';

/**
 * The SFTP transport against real servers in Docker: OpenSSH (e2e/ssh-server) and ProFTPD's
 * mod_sftp (e2e/ftp-server), which has no OpenSSH extensions. Both through a login of the site's
 * own with its host key trusted, the way a custom SFTP site connects. Skipped without Docker.
 */

const docker = dockerAvailable();
const TIMEOUT = 60_000;
let openssh: SshTestServer | null = null;
let proftpd: FtpTestServer | null = null;
let folders = 0;

beforeAll(async () => {
  if (!docker) return;
  [openssh, proftpd] = await Promise.all([startSshServer(), startFtpServer()]);
}, 900_000);

afterAll(() => {
  openssh?.stop();
  proftpd?.stop();
});

interface Server {
  host: string;
  port: number;
  user: string;
  password: string;
  exec: (command: string, args: string[]) => string;
}

function openSshServer(): Server {
  const live = openssh as SshTestServer;
  return {
    host: live.host,
    port: live.port,
    user: SSH_USER,
    password: SSH_PASSWORD,
    // serverExec keeps Node's 1 MB output limit, too small for the big file read back as base64.
    exec: (command, args) =>
      execFileSync(
        'docker',
        ['exec', '-i', '-u', SSH_USER, live.name, 'sh', '-c', command, 'sh', ...args],
        {
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: 'pipe',
          maxBuffer: 64 * 1024 * 1024,
        },
      ).trim(),
  };
}

function modSftpServer(): Server {
  const live = proftpd as FtpTestServer;
  return {
    host: live.host,
    port: live.sftpPort,
    user: live.user,
    password: live.password,
    exec: (command, args) => live.exec(command, { args }),
  };
}

function target(server: Server, hostKeyFingerprint: string | null): FilesConnectTarget {
  return {
    protocol: 'sftp',
    remoteRoot: `/home/${server.user}`,
    login: {
      kind: 'custom',
      host: server.host,
      port: server.port,
      username: server.user,
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint,
      tlsPin: null,
      tlsServername: null,
      secret: server.password,
    },
  };
}

function harness(pick: () => Server): () => Promise<ContractHarness> {
  return async () => {
    const server = pick();
    folders += 1;
    const root = `/home/${server.user}/contract-sftp-${folders}`;
    server.exec('mkdir -p "$1"', [root]);
    const key = await readHostKey(target(server, null));
    const remote = await openRemoteFiles(target(server, key), { purpose: 'run' });
    return {
      remote,
      root,
      readFile: async (path) => {
        const out = server.exec('[ -f "$1" ] && base64 -w0 "$1" || echo MISSING', [path]);
        return out === 'MISSING' ? null : Buffer.from(out, 'base64');
      },
      modeOf: async (path) => {
        const out = server.exec('stat -c %a "$1" 2>/dev/null || echo MISSING', [path]);
        return out === 'MISSING' ? null : Number.parseInt(out, 8);
      },
      setMode: async (path, mode) => {
        server.exec('chmod "$1" "$2"', [mode.toString(8), path]);
      },
      dispose: async () => {
        server.exec('rm -rf "$1"', [root]);
      },
    };
  };
}

describe.skipIf(!docker)('SFTP transport against real servers', () => {
  describeRemoteFilesContract('OpenSSH', harness(openSshServer), { timeoutMs: TIMEOUT });
  describeRemoteFilesContract('ProFTPD mod_sftp', harness(modSftpServer), { timeoutMs: TIMEOUT });

  it(
    'refuses a server whose key was never trusted, with the key it presented',
    async () => {
      const server = openSshServer();
      const presented = await readHostKey(target(server, null));

      const error = (await openRemoteFiles(target(server, null), { purpose: 'run' }).catch(
        (failure: unknown) => failure,
      )) as FilesTransportError;

      expect(presented).toMatch(/^[0-9a-f]{64}$/);
      expect(error.code).toBe('hostKeyUnknown');
      expect(error.hostKey).toEqual({ presented, stored: null });
    },
    TIMEOUT,
  );

  it(
    'refuses a key other than the trusted one',
    async () => {
      const error = (await openRemoteFiles(target(modSftpServer(), 'ab'.repeat(32)), {
        purpose: 'run',
      }).catch((failure: unknown) => failure)) as FilesTransportError;

      expect(filesErrorCode(error)).toBe('hostKeyChanged');
      expect(error.hostKey?.stored).toBe('ab'.repeat(32));
    },
    TIMEOUT,
  );

  it(
    'says whether each server replaces a file in one step, consistently with what a replace did',
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'agentmate-sftp-int-'));
      const local = join(scratch, 'a.txt');
      await writeFile(local, 'replace me');
      const file = { sha256: createHash('sha256').update('replace me').digest('hex'), size: 10 };
      try {
        for (const server of [openSshServer(), modSftpServer()]) {
          const key = await readHostKey(target(server, null));
          const remote = await openRemoteFiles(target(server, key), { purpose: 'run' });
          const path = `/home/${server.user}/replace-check.txt`;
          try {
            expect((await remote.capabilities()).mtime).toBe('exact');
            await remote.putFile(local, path, file);
            const replaced = await remote.putFile(local, path, file);
            expect((await remote.capabilities()).atomicReplace).toBe(replaced.atomic);
            if (server.port === openSshServer().port) expect(replaced.atomic).toBe(true);
          } finally {
            await remote.remove(path);
            await remote.close();
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
