import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { FTPError } from 'basic-ftp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../../../shared/deployFilesErrors';
import type { FilesConnectTarget } from '../types';
import { describeRemoteFilesContract } from './contract';
import { FilesTransportError } from './errors';
import {
  certificateInfo,
  guardDataSockets,
  mapFtpError,
  openFtpRemote,
  parseMlstReply,
  pinnedIdentityCheck,
  readCertificate,
} from './ftpRemote';
import {
  createFakeFtpServer,
  type FakeFtpServerOptions,
  FakeTlsSocket,
  fakeCertificate,
} from './testing/fakeFtpClient';

/**
 * The FTP and FTPS transport over a stand-in for basic-ftp's client. The same contract runs
 * against ProFTPD and vsftpd in ftpRemote.int.test.ts.
 */

const FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const PIN = FINGERPRINT.replace(/:/g, '').toLowerCase();

function target(
  protocol: 'ftp' | 'ftps' = 'ftp',
  login: Partial<{ tlsPin: string | null; tlsServername: string | null; secret: string }> = {},
): FilesConnectTarget {
  return {
    protocol,
    remoteRoot: '/srv/site',
    login: {
      kind: 'custom',
      host: 'ftp.example.com',
      port: 21,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: null,
      tlsPin: login.tlsPin ?? null,
      tlsServername: login.tlsServername ?? null,
      secret: login.secret ?? 'pw',
    },
  };
}

function contractFor(
  name: string,
  options: FakeFtpServerOptions,
  protocol: 'ftp' | 'ftps' = 'ftp',
  pin: string | null = null,
) {
  describeRemoteFilesContract(name, async () => {
    const server = createFakeFtpServer(options);
    server.dir('/srv');
    server.dir('/srv/site');
    const remote = await openFtpRemote(target(protocol, { tlsPin: pin }), {
      createClient: server.createClient,
    });
    return {
      remote,
      root: '/srv/site',
      readFile: async (path) => {
        const node = server.nodes.get(path);
        return node && !node.dir ? node.data : null;
      },
      modeOf: async (path) => server.nodes.get(path)?.mode ?? null,
      setMode: async (path, mode) => {
        const node = server.nodes.get(path);
        if (node) node.mode = mode;
      },
    };
  });
}

const selfSigned = {
  chainTrusted: false,
  chainError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  names: ['ftp.example.com'],
  fingerprint256: FINGERPRINT,
};

contractFor('FTP over a stand-in client with MLSD', {});
contractFor('FTP over a stand-in client, LIST only', {
  mlsd: false,
  emptyListForMissing: true,
});
contractFor('FTP over a stand-in client refusing renames over files', {
  renameOverwriteRefused: true,
});
contractFor(
  'FTPS over a stand-in client with a pinned certificate',
  { tls: selfSigned },
  'ftps',
  PIN,
);

describe('openFtpRemote', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'runova-ftp-remote-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });
  async function local(content: string) {
    const path = join(scratch, `f-${Math.random().toString(16).slice(2)}`);
    await writeFile(path, content);
    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
  }
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => error,
    );

  it('is one upload at a time and runs every call in turn on the one client', async () => {
    const server = createFakeFtpServer();
    server.dir('/srv');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect(remote.maxParallel).toBe(1);
    expect(remote.protocol).toBe('ftp');
    await Promise.all([
      remote.list('/srv'),
      remote.stat('/srv'),
      remote.ensureDir('/srv/a'),
      remote.list('/home'),
      remote.realpath('.'),
    ]);
    expect(server.clients).toHaveLength(1);
  });

  it('asks for UTF-8 before logging in', async () => {
    const server = createFakeFtpServer();
    await openFtpRemote(target(), { createClient: server.createClient });

    expect(server.log.indexOf('OPTS UTF8 ON')).toBeGreaterThan(-1);
    expect(server.log.indexOf('OPTS UTF8 ON')).toBeLessThan(server.log.indexOf('USER deploy'));
  });

  it('reads times from MLSD listings when the server has them', async () => {
    const server = createFakeFtpServer();
    server.file('/home/deploy/a.txt', 'abc');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect(await remote.capabilities()).toEqual({ atomicReplace: true, mtime: 'exact' });
    expect(await remote.list('/home/deploy')).toEqual([
      expect.objectContaining({ name: 'a.txt', size: 3, mtimeMs: 1_700_000_000_000, via: 'mlsd' }),
    ]);
    expect(await remote.stat('/home/deploy/a.txt')).toEqual({
      isDirectory: false,
      size: 3,
      mtimeMs: 1_700_000_000_000,
      via: 'mlsd',
    });
  });

  it('asks MDTM for a time when listings have none, and says so', async () => {
    const server = createFakeFtpServer({ mlsd: false });
    server.file('/home/deploy/a.txt', 'abc');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect((await remote.capabilities()).mtime).toBe('mdtm');
    expect(await remote.list('/home/deploy')).toEqual([
      expect.objectContaining({ name: 'a.txt', size: 3, mtimeMs: null, via: null }),
    ]);
    expect(await remote.stat('/home/deploy/a.txt')).toEqual({
      isDirectory: false,
      size: 3,
      mtimeMs: 1_700_000_000_000,
      via: 'mdtm',
    });
    expect(await remote.stat('/home/deploy')).toMatchObject({ isDirectory: true });
  });

  it('judges by size alone on a server with neither MLSD nor MDTM', async () => {
    const server = createFakeFtpServer({ mlsd: false, mdtm: false });
    server.file('/home/deploy/a.txt', 'abc');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect((await remote.capabilities()).mtime).toBe('none');
    expect(await remote.stat('/home/deploy/a.txt')).toEqual({
      isDirectory: false,
      size: 3,
      mtimeMs: null,
      via: null,
    });
  });

  it('answers null for a missing folder even where LIST answers an empty listing', async () => {
    const server = createFakeFtpServer({ mlsd: false, emptyListForMissing: true });
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect(await remote.list('/srv/missing')).toBeNull();
  });

  it('makes folders with one absolute MKD each and never relies on the working folder', async () => {
    const server = createFakeFtpServer();
    server.dir('/srv');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });
    server.log.length = 0;

    expect(await remote.ensureDir('/srv/site/css/img')).toBe(true);
    expect(server.log.filter((line) => line.startsWith('MKD'))).toEqual([
      'MKD /srv/site',
      'MKD /srv/site/css',
      'MKD /srv/site/css/img',
    ]);
    server.log.length = 0;
    expect(await remote.ensureDir('/srv/site/css')).toBe(false);
    expect(server.log).toEqual([]);
    expect(server.nodes.has('/srv/site/css/img')).toBe(true);
  });

  it('takes a folder made by someone else meanwhile, and refuses a file in the way', async () => {
    const server = createFakeFtpServer();
    server.dir('/srv');
    server.file('/srv/file', 'x');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });
    const client = server.clients[0];
    const cd = client.cd.bind(client);
    let raced = false;
    client.cd = async (path: string) => {
      if (path === '/srv/race' && !raced) {
        raced = true;
        server.dir('/srv/race');
        throw Object.assign(new Error('550 No such file'), { code: 550 });
      }
      return cd(path);
    };

    expect(await remote.ensureDir('/srv/race')).toBe(false);
    expect(filesErrorCode(await failure(remote.ensureDir('/srv/file/sub')))).toBe('server');
  });

  /** A client whose n-th rename (1-based) is refused, whatever the server would say. */
  function refusingRenames(server: ReturnType<typeof createFakeFtpServer>, refused: number[]) {
    let renames = 0;
    return () => {
      const client = server.createClient();
      const rename = client.rename.bind(client);
      client.rename = async (from, to) => {
        renames += 1;
        if (refused.includes(renames)) {
          throw new FTPError({ code: 550, message: '550 Rename failed.' });
        }
        return rename(from, to);
      };
      return client;
    };
  }

  const leftIn = (server: ReturnType<typeof createFakeFtpServer>, pattern: RegExp) =>
    [...server.nodes.keys()].filter((path) => pattern.test(path));

  it('moves the old file aside when RNTO onto it is refused, and stops calling that atomic', async () => {
    const server = createFakeFtpServer({ renameOverwriteRefused: true });
    const remote = await openFtpRemote(target(), { createClient: server.createClient });
    const file = await local('v2');
    server.file('/home/deploy/v.txt', 'v1');

    const result = await remote.putFile(file.path, '/home/deploy/v.txt', file);

    expect(result.atomic).toBe(false);
    expect(server.nodes.get('/home/deploy/v.txt')?.data.toString()).toBe('v2');
    expect((await remote.capabilities()).atomicReplace).toBe(false);
    expect(
      server.log.some((line) =>
        /^RNFR \/home\/deploy\/v\.txt RNTO \/home\/deploy\/v\.txt\.runova-[0-9a-f]{8}\.old$/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(server.log).not.toContain('DELE /home/deploy/v.txt');
    expect(leftIn(server, /\.(part|old)$/)).toEqual([]);
  });

  it('puts the old file back when the new one cannot take its name after it was moved aside', async () => {
    const server = createFakeFtpServer({ renameOverwriteRefused: true });
    // 1: part onto the file (refused by the server), 2: the file aside, 3: part into place.
    const remote = await openFtpRemote(target(), { createClient: refusingRenames(server, [3]) });
    const file = await local('v2');
    server.file('/home/deploy/v.txt', 'v1');

    const refused = await failure(remote.putFile(file.path, '/home/deploy/v.txt', file));

    expect(refused).toBeInstanceOf(Error);
    expect(server.nodes.get('/home/deploy/v.txt')?.data.toString()).toBe('v1');
    expect(leftIn(server, /\.(part|old)$/)).toEqual([]);
  });

  it('never deletes the new file when the old one could not be put back either', async () => {
    const server = createFakeFtpServer({ renameOverwriteRefused: true });
    const remote = await openFtpRemote(target(), {
      createClient: refusingRenames(server, [3, 4]),
    });
    const file = await local('v2');
    server.file('/home/deploy/v.txt', 'v1');

    expect(await failure(remote.putFile(file.path, '/home/deploy/v.txt', file))).toBeInstanceOf(
      Error,
    );

    const [backup] = leftIn(server, /\.old$/);
    const [part] = leftIn(server, /\.part$/);
    expect(server.nodes.get(backup ?? '')?.data.toString()).toBe('v1');
    expect(server.nodes.get(part ?? '')?.data.toString()).toBe('v2');
  });

  it('lets go of the local file when the upload fails before any byte is read', async () => {
    const server = createFakeFtpServer();
    const sources: Readable[] = [];
    const remote = await openFtpRemote(target(), {
      createClient: () => {
        const client = server.createClient();
        const upload = client.uploadFrom.bind(client);
        client.uploadFrom = (source, to) => {
          sources.push(source as Readable);
          return upload(source, to);
        };
        return client;
      },
    });
    const file = await local('never read');

    // STOR into a folder that is not there is refused before the transfer starts.
    const refused = await failure(remote.putFile(file.path, '/home/deploy/missing/a.txt', file));

    expect(refused).toBeInstanceOf(Error);
    expect(sources).toHaveLength(1);
    await vi.waitFor(() => expect(sources[0]?.destroyed).toBe(true));
  });

  it('keeps the mode of the file it replaces with SITE CHMOD', async () => {
    for (const mlsd of [true, false]) {
      const server = createFakeFtpServer({ mlsd });
      server.file('/home/deploy/config.php', 'old', 0o600);
      const remote = await openFtpRemote(target(), { createClient: server.createClient });
      const file = await local('new');

      await remote.putFile(file.path, '/home/deploy/config.php', file);

      expect(server.nodes.get('/home/deploy/config.php')?.mode).toBe(0o600);
      expect(server.log.some((line) => line.startsWith('SITE CHMOD 600 '))).toBe(true);
    }
  });

  it('cancels by closing the client, then reconnects and clears the part file', async () => {
    const server = createFakeFtpServer();
    server.file('/home/deploy/big.js', 'old');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });
    const file = await local('x'.repeat(300_000));
    const controller = new AbortController();

    const cancelled = await failure(
      remote.putFile(file.path, '/home/deploy/big.js', {
        ...file,
        signal: controller.signal,
        onBytes: () => controller.abort(),
      }),
    );

    expect(filesErrorCode(cancelled)).toBe('cancelled');
    expect(server.clients[0].closed).toBe(true);
    expect(server.nodes.get('/home/deploy/big.js')?.data.toString()).toBe('old');
    expect(await remote.stat('/home/deploy/big.js')).toMatchObject({ size: 3 });
    expect(server.clients).toHaveLength(2);
    expect([...server.nodes.keys()].filter((path) => path.endsWith('.part'))).toEqual([]);
  });

  it('reconnects after the server dropped the connection', async () => {
    const server = createFakeFtpServer();
    const remote = await openFtpRemote(target(), { createClient: server.createClient });
    server.clients[0].close();

    expect(await remote.realpath('.')).toBe('/home/deploy');
    expect(server.clients).toHaveLength(2);
  });

  it('resolves paths against the login folder', async () => {
    const server = createFakeFtpServer();
    server.dir('/home/deploy/www');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    expect(await remote.realpath('.')).toBe('/home/deploy');
    expect(await remote.realpath('www')).toBe('/home/deploy/www');
    expect(filesErrorCode(await failure(remote.realpath('/nope')))).toBe('remoteFolderMissing');
  });

  it('codes login and connection failures', async () => {
    const wrong = createFakeFtpServer({ password: 'other' });
    const refused = createFakeFtpServer({ refuseConnect: 'ECONNREFUSED' });

    expect(
      filesErrorCode(await failure(openFtpRemote(target(), { createClient: wrong.createClient }))),
    ).toBe('auth');
    expect(
      filesErrorCode(
        await failure(openFtpRemote(target(), { createClient: refused.createClient })),
      ),
    ).toBe('unreachable');
    expect(wrong.clients[0].closed).toBe(true);
  });

  it('refuses to start when already cancelled', async () => {
    const server = createFakeFtpServer();

    const cancelled = await failure(
      openFtpRemote(target(), { createClient: server.createClient, signal: AbortSignal.abort() }),
    );

    expect(filesErrorCode(cancelled)).toBe('cancelled');
    expect(server.log).toEqual([]);
  });

  it('removes files and empty folders, and tells a missing one apart', async () => {
    const server = createFakeFtpServer();
    server.dir('/srv');
    server.dir('/srv/full');
    server.file('/srv/full/a', 'a');
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    await remote.remove('/srv/full/missing');
    expect(await remote.removeEmptyDir('/srv/full')).toBe(false);
    await remote.remove('/srv/full/a');
    expect(await remote.removeEmptyDir('/srv/full')).toBe(true);
    expect(await remote.removeEmptyDir('/srv/full')).toBe(false);
    expect(filesErrorCode(await failure(remote.remove('/srv')))).toBe('server');
  });

  it('refuses calls after close', async () => {
    const server = createFakeFtpServer();
    const remote = await openFtpRemote(target(), { createClient: server.createClient });

    await remote.close();

    expect(server.clients[0].closed).toBe(true);
    expect(filesErrorCode(await failure(remote.list('/')))).toBe('unreachable');
    expect(server.clients).toHaveLength(1);
  });
});

describe('FTPS certificates', () => {
  const failure = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => error,
    );

  it('refuses a self-signed certificate before sending the password, with what it showed', async () => {
    const server = createFakeFtpServer({ tls: selfSigned });

    const error = await failure(
      openFtpRemote(target('ftps'), { createClient: server.createClient }),
    );

    expect(error).toBeInstanceOf(FilesTransportError);
    expect(filesErrorCode(error)).toBe('tlsUntrusted');
    expect((error as FilesTransportError).certificate).toMatchObject({
      fingerprint256: PIN,
      names: ['ftp.example.com'],
      reason: 'selfSigned',
    });
    expect(server.log.some((line) => line.startsWith('USER'))).toBe(false);
  });

  it('refuses a certificate for another name and checks the name the site gives', async () => {
    const shared = { chainTrusted: true, names: ['*.sharedhost.net'], fingerprint256: FINGERPRINT };
    const server = createFakeFtpServer({ tls: shared });

    const mismatch = await failure(
      openFtpRemote(target('ftps'), { createClient: server.createClient }),
    );
    expect(filesErrorCode(mismatch)).toBe('tlsNameMismatch');
    expect((mismatch as FilesTransportError).certificate?.reason).toBe('nameMismatch');

    const named = createFakeFtpServer({
      tls: { ...shared, names: ['server12.sharedhost.net'] },
    });
    const remote = await openFtpRemote(
      target('ftps', { tlsServername: 'server12.sharedhost.net' }),
      { createClient: named.createClient },
    );
    expect(named.clients[0].tlsOptionsUsed?.servername).toBe('server12.sharedhost.net');
    expect(named.clients[0].ftp.tlsOptions).toMatchObject({
      servername: 'server12.sharedhost.net',
      rejectUnauthorized: true,
    });
    await remote.close();
  });

  it('says so when the server does not offer TLS', async () => {
    const server = createFakeFtpServer({ tls: { ...selfSigned, refused: true } });

    const error = await failure(
      openFtpRemote(target('ftps'), { createClient: server.createClient }),
    );

    expect(filesErrorCode(error)).toBe('tlsUnavailable');
  });

  it('accepts a pinned certificate and checks it again on every data connection', async () => {
    const server = createFakeFtpServer({ tls: selfSigned });

    const remote = await openFtpRemote(target('ftps', { tlsPin: FINGERPRINT }), {
      createClient: server.createClient,
    });

    const options = server.clients[0].ftp.tlsOptions;
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.checkServerIdentity).toEqual(expect.any(Function));
    const data = new FakeTlsSocket(fakeCertificate({ names: [], fingerprint256: 'ff' }));
    server.clients[0].ftp.dataSocket = data as never;
    data.emit('secureConnect');
    expect(data.destroyed).toBe(true);
    // Coded, so a run breaks off and Deploy on save pauses instead of retrying.
    expect(filesErrorCode(data.destroyError)).toBe('tlsUntrusted');
    expect(filesErrorCode(mapFtpError(data.destroyError, '/srv/site/a.txt'))).toBe('tlsUntrusted');
    await remote.close();
  });

  it('refuses a certificate other than the pinned one, before logging in', async () => {
    const server = createFakeFtpServer({ tls: selfSigned });

    const error = await failure(
      openFtpRemote(target('ftps', { tlsPin: 'ff'.repeat(32) }), {
        createClient: server.createClient,
      }),
    );

    expect(filesErrorCode(error)).toBe('tlsUntrusted');
    expect((error as FilesTransportError).certificate?.fingerprint256).toBe(PIN);
    expect(server.log.some((line) => line.startsWith('USER'))).toBe(false);
  });

  it('reads the certificate without logging in', async () => {
    const server = createFakeFtpServer({ tls: selfSigned });

    const info = await readCertificate(target('ftps'), { createClient: server.createClient });

    expect(info).toMatchObject({ fingerprint256: PIN, reason: 'selfSigned' });
    expect(server.log.some((line) => line.startsWith('USER'))).toBe(false);
    expect(server.clients[0].closed).toBe(true);
  });

  it('pins by fingerprint in the identity check', () => {
    const check = pinnedIdentityCheck(FINGERPRINT);

    expect(check('x', fakeCertificate({ names: [], fingerprint256: FINGERPRINT }))).toBeUndefined();
    expect(check('x', fakeCertificate({ names: [], fingerprint256: 'AA:BB' }))).toBeInstanceOf(
      Error,
    );
  });

  it('lets a resumed data session through and a matching one stay open', () => {
    const ftp = { dataSocket: undefined as unknown };
    guardDataSockets(ftp as never, PIN);
    const resumed = new FakeTlsSocket(fakeCertificate({ names: [], fingerprint256: '' }), true);
    const matching = new FakeTlsSocket(fakeCertificate({ names: [], fingerprint256: FINGERPRINT }));
    const plain = new EventEmitter();

    ftp.dataSocket = resumed;
    resumed.emit('secureConnect');
    ftp.dataSocket = matching;
    matching.emit('secureConnect');
    ftp.dataSocket = plain;

    expect(resumed.destroyed).toBe(false);
    expect(matching.destroyed).toBe(false);
    expect(ftp.dataSocket).toBe(plain);
  });

  it('describes a certificate in plain terms', () => {
    const info = certificateInfo(
      {
        ...fakeCertificate({ names: [], fingerprint256: FINGERPRINT }),
        subject: { CN: 'example.com', O: ['A', 'B'] },
        subjectaltname: 'DNS:example.com, DNS:www.example.com, IP Address:10.0.0.1',
      } as never,
      'CERT_HAS_EXPIRED',
    );

    expect(info).toEqual({
      fingerprint256: PIN,
      subject: 'CN=example.com, O=A, O=B',
      issuer: 'CN=unknown, O=Runova Test',
      names: ['example.com', 'www.example.com', '10.0.0.1'],
      validTo: 'Jan  1 00:00:00 2036 GMT',
      reason: 'expired',
    });
    expect(
      certificateInfo(
        {
          ...fakeCertificate({ names: [], fingerprint256: FINGERPRINT }),
          subjectaltname: undefined,
        } as never,
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ),
    ).toMatchObject({ names: ['unknown'], reason: 'untrusted' });
  });
});

describe('mapFtpError', () => {
  const reply = (code: number, message: string) => Object.assign(new Error(message), { code });
  const nodeError = (code: string, message = code) => Object.assign(new Error(message), { code });

  it.each([
    [reply(530, '530 Login incorrect.'), 'auth'],
    [reply(421, '421 Too many connections'), 'unreachable'],
    [reply(426, '426 Connection closed; transfer aborted.'), 'unreachable'],
    [reply(552, '552 Quota exceeded'), 'diskFull'],
    [reply(452, '452 Insufficient storage space'), 'diskFull'],
    [reply(550, '550 /a: Permission denied'), 'permissionDenied'],
    [reply(550, '550 /a: No such file or directory'), 'remoteFolderMissing'],
    [reply(501, '501 Syntax error'), 'server'],
    [nodeError('ERR_TLS_CERT_ALTNAME_INVALID'), 'tlsNameMismatch'],
    [nodeError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tlsUntrusted'],
    [nodeError('CERT_HAS_EXPIRED'), 'tlsUntrusted'],
    [new Error('Timeout (control socket)'), 'timeout'],
    [nodeError('ETIMEDOUT', 'connect ETIMEDOUT'), 'timeout'],
    [nodeError('ECONNRESET', 'read ECONNRESET'), 'unreachable'],
    [nodeError('ENOTFOUND', 'getaddrinfo ENOTFOUND ftp.example.com'), 'unreachable'],
    [new Error('Server sent FIN packet unexpectedly, closing connection.'), 'unreachable'],
    [new Error('Something odd'), 'server'],
  ])('codes %s as %s', (error, code) => {
    expect(filesErrorCode(mapFtpError(error, '/a'))).toBe(code);
  });

  it('keeps an error that already has a code', () => {
    const coded = new FilesTransportError('localChanged', 'edited');
    expect(mapFtpError(coded, '/a')).toBe(coded);
  });
});

describe('parseMlstReply', () => {
  it('reads the type, size, time and mode of an MLST answer, whatever the path holds', () => {
    const reply =
      '250-Start of list for /srv/my file.txt\r\n type=file;size=12;modify=20260102030405;unix.mode=0640;UNIX.owner=1000; /srv/my file.txt\r\n250 End';

    expect(parseMlstReply(reply)).toEqual({
      isDirectory: false,
      size: 12,
      mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
      mode: 0o640,
    });
  });

  it('reads a folder, fractions of a second like basic-ftp does, and missing facts', () => {
    expect(parseMlstReply('250-x\n Type=dir;modify=20260102030405.250; /srv\n250 End')).toEqual({
      isDirectory: true,
      size: 0,
      mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5, 250),
      mode: null,
    });
    expect(parseMlstReply('250 no facts here')).toBeNull();
  });
});
