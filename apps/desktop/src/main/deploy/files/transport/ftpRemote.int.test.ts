import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FtpTestServer, startFtpServer } from '../../../../../e2e/ftpServer';
import { dockerAvailable } from '../../../../../e2e/sshServer';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import type { FilesConnectTarget } from '../types';
import { type ContractHarness, describeRemoteFilesContract } from './contract';
import type { FilesTransportError } from './errors';
import { openFtpRemote, readCertificate } from './ftpRemote';

/**
 * The FTP transport against real servers in Docker (e2e/ftp-server): ProFTPD over FTP and over
 * FTPS with its self-signed certificate pinned, and vsftpd, which only has LIST. Skipped without
 * Docker.
 */

const docker = dockerAvailable();
const TIMEOUT = 60_000;
let server: FtpTestServer | null = null;
let folders = 0;

beforeAll(async () => {
  if (docker) server = await startFtpServer();
}, 900_000);

afterAll(() => {
  server?.stop();
});

function target(
  protocol: 'ftp' | 'ftps',
  port: (s: FtpTestServer) => number,
  tls: { pin?: string | null; servername?: string | null } = {},
): FilesConnectTarget {
  if (!server) throw new Error('no server');
  return {
    protocol,
    remoteRoot: `/home/${server.user}`,
    login: {
      kind: 'custom',
      host: server.host,
      port: port(server),
      username: server.user,
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: null,
      tlsPin: tls.pin ?? null,
      tlsServername: tls.servername ?? null,
      secret: server.password,
    },
  };
}

function harness(
  protocol: 'ftp' | 'ftps',
  port: (s: FtpTestServer) => number,
  pinned = false,
): () => Promise<ContractHarness> {
  return async () => {
    if (!server) throw new Error('no server');
    const live = server;
    folders += 1;
    const root = `/home/${live.user}/contract-${protocol}-${port(live)}-${folders}`;
    live.exec('mkdir -p "$1"', { args: [root] });
    const remote = await openFtpRemote(
      target(protocol, port, { pin: pinned ? live.certFingerprint256 : null }),
    );
    return {
      remote,
      root,
      readFile: async (path) => {
        const out = live.exec('[ -f "$1" ] && base64 -w0 "$1" || echo MISSING', { args: [path] });
        return out === 'MISSING' ? null : Buffer.from(out, 'base64');
      },
      modeOf: async (path) => {
        const out = live.exec('stat -c %a "$1" 2>/dev/null || echo MISSING', { args: [path] });
        return out === 'MISSING' ? null : Number.parseInt(out, 8);
      },
      setMode: async (path, mode) => {
        live.exec('chmod "$1" "$2"', { args: [mode.toString(8), path] });
      },
      dispose: async () => {
        live.exec('rm -rf "$1"', { args: [root] });
      },
    };
  };
}

describe.skipIf(!docker)('FTP transport against real servers', () => {
  describeRemoteFilesContract(
    'ProFTPD FTP',
    harness('ftp', (s) => s.ftpPort),
    {
      timeoutMs: TIMEOUT,
    },
  );
  describeRemoteFilesContract(
    'ProFTPD FTPS, self-signed certificate pinned',
    harness('ftps', (s) => s.ftpsPort, true),
    { timeoutMs: TIMEOUT },
  );
  describeRemoteFilesContract(
    'vsftpd, LIST only',
    harness('ftp', (s) => s.listOnlyPort),
    {
      timeoutMs: TIMEOUT,
    },
  );

  it(
    'reads times exactly from ProFTPD and with MDTM from vsftpd',
    async () => {
      const proftpd = await openFtpRemote(target('ftp', (s) => s.ftpPort));
      const vsftpd = await openFtpRemote(target('ftp', (s) => s.listOnlyPort));
      try {
        expect((await proftpd.capabilities()).mtime).toBe('exact');
        expect((await vsftpd.capabilities()).mtime).toBe('mdtm');
        expect(await vsftpd.list('/home/nobody-here')).toBeNull();
      } finally {
        await proftpd.close();
        await vsftpd.close();
      }
    },
    TIMEOUT,
  );

  it(
    'refuses the self-signed certificate unless it is pinned, and shows what it is',
    async () => {
      const live = server as FtpTestServer;
      const error = (await openFtpRemote(target('ftps', (s) => s.ftpsPort)).catch(
        (failure: unknown) => failure,
      )) as FilesTransportError;

      expect(filesErrorCode(error)).toBe('tlsUntrusted');
      expect(error.certificate).toMatchObject({
        fingerprint256: live.certFingerprint256,
        reason: 'selfSigned',
        names: ['localhost', 'runova-e2e-ftp', '127.0.0.1'],
      });
      expect(await readCertificate(target('ftps', (s) => s.ftpsPort))).toMatchObject({
        fingerprint256: live.certFingerprint256,
      });
      const wrongPin = await openFtpRemote(
        target('ftps', (s) => s.ftpsPort, { pin: 'ab'.repeat(32) }),
      ).catch((failure: unknown) => failure);
      expect(filesErrorCode(wrongPin)).toBe('tlsUntrusted');
    },
    TIMEOUT,
  );

  it(
    'refuses a wrong password and says FTPS is missing where AUTH TLS is refused',
    async () => {
      const wrong = target('ftp', (s) => s.ftpPort);
      if (wrong.login.kind === 'custom') wrong.login.secret = 'nope';
      expect(filesErrorCode(await openFtpRemote(wrong).catch((e: unknown) => e))).toBe('auth');

      const noTls = await openFtpRemote(target('ftps', (s) => s.listOnlyPort)).catch(
        (e: unknown) => e,
      );
      expect(filesErrorCode(noTls)).toBe('tlsUnavailable');
    },
    TIMEOUT,
  );
});
