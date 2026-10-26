import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type AddressInfo, createServer, connect as netConnect, type Socket } from 'node:net';
import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildProbeConnectionRequest,
  cleanTlsDetail,
  fetchServerCertificate,
  type HandshakeDeps,
  handshake,
  isKeyUsageError,
  RdpHandshakeError,
  RSA_KEY_EXCHANGE_TLS,
  socketFailure,
  toFailureInfo,
} from './handshake';
import { type FakeRdpServer, startFakeRdpServer } from './testing/fakeRdpServer';
import { rdpStyleCertificate, type TestCertificate } from './testing/rdpCertificate';

/**
 * A server reinstalled with Windows' own Remote Desktop certificate (Key Usage: Key Encipherment
 * and Data Encipherment, no Digital Signature) could not be connected to: Electron's TLS stack
 * refused it with KEY_USAGE_BIT_INCORRECT before the saved fingerprint was even looked at, and the
 * raw library text was shown to the user. The tests run in Node, whose OpenSSL accepts such a
 * certificate, so the BoringSSL refusal is played by a stand-in for `tls.connect`. What Electron
 * really does with it is covered by handshake.boringssl.test.ts.
 */

const BORINGSSL_KEY_USAGE =
  '105556096:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:..\\..\\third_party\\boringssl\\src\\ssl\\ssl_cert.cc:397:';
const OPENSSL_VERIFY =
  'error:0A000086:SSL routines:tls_post_process_server_certificate:certificate verify failed';
const LIBRARY_TEXT = /error:|OPENSSL_internal|ssl_cert\.cc|third_party|boringssl/i;

type Behaviour =
  | 'refuse-key-usage-then-allow-rsa'
  | 'refuse-key-usage-then-reset'
  | 'refuse-key-usage-always'
  | 'other-error';

/** `tls.connect`, except that the way BoringSSL fails is played back on the attempts it would. */
function standIn(behaviour: Behaviour, onFirstAttempt?: () => void) {
  const attempts: Array<Pick<ConnectionOptions, 'maxVersion' | 'ciphers'>> = [];
  const connect = ((options: ConnectionOptions, callback?: () => void): TLSSocket => {
    attempts.push({ maxVersion: options.maxVersion, ciphers: options.ciphers });
    if (attempts.length === 1) onFirstAttempt?.();
    const offersRsaOnly = options.ciphers !== undefined;
    if (behaviour === 'refuse-key-usage-then-allow-rsa' && offersRsaOnly) {
      return tlsConnect(options, callback);
    }
    const failure =
      behaviour === 'refuse-key-usage-then-reset' && offersRsaOnly
        ? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        : new Error(behaviour === 'other-error' ? OPENSSL_VERIFY : BORINGSSL_KEY_USAGE);
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    setImmediate(() => socket.emit('error', failure));
    return socket as unknown as TLSSocket;
  }) as typeof tlsConnect;
  const deps: HandshakeDeps = { netConnect, tlsConnect: connect };
  return { deps, attempts };
}

let windows: TestCertificate;
let signing: TestCertificate;
const servers: FakeRdpServer[] = [];

beforeAll(() => {
  windows = rdpStyleCertificate('windows');
  signing = rdpStyleCertificate('signature');
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  certificate: TestCertificate,
  options?: Parameters<typeof startFakeRdpServer>[1],
): Promise<FakeRdpServer> {
  const server = await startFakeRdpServer(certificate, options);
  servers.push(server);
  return server;
}

const request = buildProbeConnectionRequest();

describe('handshake', () => {
  it('connects once and keeps the normal key exchange when the certificate is fine', async () => {
    const server = await serve(signing);
    const result = await handshake('127.0.0.1', server.port, request);
    result.tlsSocket.destroy();

    expect(result.keyExchange).toBe('default');
    expect(server.connections()).toBe(1);
    expect(result.cert.fingerprint).toBe(new X509Certificate(signing.cert).fingerprint256);
  });

  it('retries on a fresh connection with RSA key exchange when the certificate only allows encipherment', async () => {
    const server = await serve(windows);
    const { deps, attempts } = standIn('refuse-key-usage-then-allow-rsa');

    const result = await handshake('127.0.0.1', server.port, request, deps);
    const protocol = result.tlsSocket.getProtocol();
    result.tlsSocket.destroy();

    // The socket of the failed attempt is dead, so the retry starts over, X.224 included.
    expect(server.connections()).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual({ maxVersion: undefined, ciphers: undefined });
    expect(attempts[1]).toEqual(RSA_KEY_EXCHANGE_TLS);
    expect(result.keyExchange).toBe('rsa');
    expect(protocol).toBe('TLSv1.2');
    expect(result.cert.fingerprint).toBe(new X509Certificate(windows.cert).fingerprint256);
  });

  it('only offers key exchange that needs the encipherment bit on the retry', () => {
    expect(RSA_KEY_EXCHANGE_TLS.maxVersion).toBe('TLSv1.2');
    for (const cipher of RSA_KEY_EXCHANGE_TLS.ciphers.split(':')) {
      expect(cipher).toMatch(/^AES(?:128|256)-/);
      expect(cipher).not.toMatch(/ECDHE|DHE|ECDSA|CHACHA/);
    }
  });

  it('says so in plain words when the server turns the older encryption down as well', async () => {
    const server = await serve(windows);
    const { deps, attempts } = standIn('refuse-key-usage-always');

    const failure = await handshake('127.0.0.1', server.port, request, deps).catch(
      (error: unknown) => error,
    );

    // Tried twice, not more.
    expect(attempts).toHaveLength(2);
    expect(failure).toBeInstanceOf(RdpHandshakeError);
    const error = failure as RdpHandshakeError;
    expect(error.code).toBe('tls-key-usage');
    expect(error.message).toBe(
      `The certificate 127.0.0.1:${server.port} presented can't be used to set up an encrypted connection.`,
    );
    expect(error.message).not.toMatch(LIBRARY_TEXT);
    expect(error.detail).toBe(
      'KEY_USAGE_BIT_INCORRECT (SSL routines); then KEY_USAGE_BIT_INCORRECT (SSL routines)',
    );
  });

  it('reports a server that refuses the RSA ciphers too as the certificate problem it started as', async () => {
    // Only ECDHE on offer: the retry gets a handshake failure, which on its own would read as
    // an unrelated TLS problem.
    const server = await serve(windows, { ciphers: 'ECDHE-RSA-AES128-GCM-SHA256' });
    const { deps } = standIn('refuse-key-usage-then-allow-rsa');

    const failure = (await handshake('127.0.0.1', server.port, request, deps).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(failure.code).toBe('tls-key-usage');
    expect(failure.message).not.toMatch(LIBRARY_TEXT);
    expect(failure.detail).toMatch(/^KEY_USAGE_BIT_INCORRECT \(SSL routines\); then /);
    expect(failure.detail).not.toMatch(LIBRARY_TEXT);
  });

  it('keeps telling the certificate story when the server resets the connection on the retry', async () => {
    const server = await serve(windows);
    const { deps } = standIn('refuse-key-usage-then-reset');

    const failure = (await handshake('127.0.0.1', server.port, request, deps).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(failure.code).toBe('tls-key-usage');
    expect(failure.detail).toBe(
      'KEY_USAGE_BIT_INCORRECT (SSL routines); then ECONNRESET: read ECONNRESET',
    );
  });

  it('does not retry for any other TLS failure', async () => {
    const server = await serve(windows);
    const { deps, attempts } = standIn('other-error');

    const failure = (await handshake('127.0.0.1', server.port, request, deps).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(attempts).toHaveLength(1);
    expect(server.connections()).toBe(1);
    expect(failure.code).toBe('tls-failed');
    expect(failure.message).toBe(
      `Runova couldn't set up a secure connection with 127.0.0.1:${server.port}.`,
    );
    expect(failure.detail).toBe('certificate verify failed (SSL routines)');
  });

  it('lets a network failure on the retry speak for itself', async () => {
    const server = await serve(windows);
    // The server goes away right after the first attempt.
    const { deps } = standIn('refuse-key-usage-then-allow-rsa', () => void server.close());

    const failure = (await handshake('127.0.0.1', server.port, request, deps).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(failure.code).toBe('refused');
  });

  it('turns a refused connection into a sentence with the system code kept apart', async () => {
    const closed = await serve(signing);
    const { port } = closed;
    await closed.close();

    const failure = (await handshake('127.0.0.1', port, request).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(failure.code).toBe('refused');
    expect(failure.message).toBe(`127.0.0.1:${port} refused the connection.`);
    expect(failure.detail).toMatch(/ECONNREFUSED/);
  });

  it('recognises a port that is not Remote Desktop', async () => {
    const web = createServer((socket) => {
      socket.once('data', () => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    const port = (web.address() as { port: number }).port;

    try {
      const failure = (await handshake('127.0.0.1', port, request).catch(
        (error: unknown) => error,
      )) as RdpHandshakeError;
      expect(failure.code).toBe('not-rdp');
      expect(failure.message).toBe(`127.0.0.1:${port} does not look like a Remote Desktop server.`);
    } finally {
      web.close();
    }
  });
});

/**
 * Remote Desktop opened its socket straight to the server even with a proxy turned on in the
 * Network settings. A plain HTTP CONNECT proxy on loopback stands in for the user's.
 */
async function startConnectProxy(): Promise<{
  port: number;
  requests: string[];
  close: () => void;
}> {
  const requests: string[] = [];
  const proxy = createServer((client) => {
    client.on('error', () => undefined);
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);
      client.pause();
      const authority = head.match(/^CONNECT (\S+) HTTP/)?.[1] ?? '';
      requests.push(authority);
      const target = Number(authority.slice(authority.lastIndexOf(':') + 1));
      const upstream = netConnect({ host: '127.0.0.1', port: target }, () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    port: (proxy.address() as AddressInfo).port,
    requests,
    close: () => proxy.close(),
  };
}

function viaProxy(port: number, base: HandshakeDeps = { netConnect, tlsConnect }) {
  const asked: string[] = [];
  const deps: HandshakeDeps = {
    ...base,
    route: async (host, target) => {
      asked.push(`${host}:${target}`);
      return { protocol: 'http', host: '127.0.0.1', port, username: '', password: '' };
    },
  };
  return { deps, asked };
}

describe('handshake through a proxy', () => {
  it('reaches the server through the proxy and reports the server, not the proxy, as the address', async () => {
    const server = await serve(signing);
    const proxy = await startConnectProxy();
    const { deps, asked } = viaProxy(proxy.port);

    try {
      const result = await handshake('localhost', server.port, request, deps);
      result.tlsSocket.destroy();

      expect(asked).toEqual([`localhost:${server.port}`]);
      expect(proxy.requests).toEqual([`localhost:${server.port}`]);
      expect(result.address).toBe('localhost');
      expect(result.cert.fingerprint).toBe(new X509Certificate(signing.cert).fingerprint256);
    } finally {
      proxy.close();
    }
  });

  it('asks for the route again for the retry with RSA key exchange', async () => {
    const server = await serve(windows);
    const proxy = await startConnectProxy();
    const { deps: standInDeps } = standIn('refuse-key-usage-then-allow-rsa');
    const { deps, asked } = viaProxy(proxy.port, standInDeps);

    try {
      const result = await handshake('127.0.0.1', server.port, request, deps);
      result.tlsSocket.destroy();

      expect(result.keyExchange).toBe('rsa');
      expect(asked).toHaveLength(2);
      expect(proxy.requests).toHaveLength(2);
      expect(server.connections()).toBe(2);
    } finally {
      proxy.close();
    }
  });

  it('goes straight to the server when the route says to skip the proxy', async () => {
    const server = await serve(signing);
    const deps: HandshakeDeps = { netConnect, tlsConnect, route: async () => null };

    const result = await handshake('127.0.0.1', server.port, request, deps);
    result.tlsSocket.destroy();

    expect(result.address).toBe('127.0.0.1');
    expect(server.connections()).toBe(1);
  });

  it('blames the proxy, not the server, when the proxy is not there', async () => {
    const proxy = await startConnectProxy();
    proxy.close();
    const { deps } = viaProxy(proxy.port);

    const failure = (await handshake('rdp.example', 3389, request, deps).catch(
      (error: unknown) => error,
    )) as RdpHandshakeError;

    expect(failure.code).toBe('proxy-failed');
    expect(failure.message).toBe(`Could not reach the proxy at 127.0.0.1:${proxy.port}.`);
    expect(failure.detail).toMatch(/ECONNREFUSED/);
  });

  it('blames the proxy when it is the one that never answers', async () => {
    const accepted: Socket[] = [];
    const silent = createServer((socket) => {
      accepted.push(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const { deps } = viaProxy(port);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const pending = handshake('rdp.example', 3389, request, deps).catch(
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(accepted).toHaveLength(1), { interval: 5 });
      vi.advanceTimersByTime(15_000);
      const failure = (await pending) as RdpHandshakeError;

      expect(failure.code).toBe('proxy-failed');
      expect(failure.message).toBe(`The proxy at 127.0.0.1:${port} did not answer in time.`);
    } finally {
      vi.useRealTimers();
      for (const socket of accepted) socket.destroy();
      silent.close();
    }
  });

  it('checks the certificate through the proxy as well', async () => {
    const server = await serve(signing);
    const proxy = await startConnectProxy();
    const { deps } = viaProxy(proxy.port);

    try {
      const cert = await fetchServerCertificate('127.0.0.1', server.port, deps);
      expect(cert.fingerprint).toBe(new X509Certificate(signing.cert).fingerprint256);
      expect(proxy.requests).toEqual([`127.0.0.1:${server.port}`]);
    } finally {
      proxy.close();
    }
  });
});

describe('fetchServerCertificate', () => {
  it('reads the certificate a server presents and closes the connection', async () => {
    const server = await serve(signing);
    const certificate = await fetchServerCertificate('127.0.0.1', server.port);
    const parsed = new X509Certificate(signing.cert);

    expect(certificate.fingerprint).toBe(parsed.fingerprint256);
    expect(certificate.subject).toBe('CN=WIN-RDP-TEST');
    expect(certificate.validTo).toBe(parsed.validTo);
  });

  it('gets the certificate of a Windows-style server too, through the retry', async () => {
    const server = await serve(windows);
    const { deps } = standIn('refuse-key-usage-then-allow-rsa');
    const certificate = await fetchServerCertificate('127.0.0.1', server.port, deps);
    expect(certificate.fingerprint).toBe(new X509Certificate(windows.cert).fingerprint256);
  });
});

describe('buildProbeConnectionRequest', () => {
  it('is a TPKT frame holding an X.224 connection request for TLS or CredSSP', () => {
    const frame = buildProbeConnectionRequest();
    expect(frame[0]).toBe(0x03);
    expect(frame.readUInt16BE(2)).toBe(frame.length);
    // X.224 length indicator, then the connection request code.
    expect(frame[4]).toBe(frame.length - 5);
    expect(frame[5]).toBe(0xe0);
    // RDP_NEG_REQ: type 1, length 8, requested protocols SSL | HYBRID.
    expect(frame[11]).toBe(0x01);
    expect(frame.readUInt16LE(13)).toBe(8);
    expect(frame.readUInt32LE(15)).toBe(0x03);
  });
});

describe('isKeyUsageError', () => {
  it('matches the text BoringSSL gives', () => {
    expect(isKeyUsageError(BORINGSSL_KEY_USAGE)).toBe(true);
  });

  it('leaves other TLS errors alone', () => {
    expect(isKeyUsageError(OPENSSL_VERIFY)).toBe(false);
    expect(isKeyUsageError('write EPROTO')).toBe(false);
  });
});

describe('cleanTlsDetail', () => {
  it('reduces the error the user reported to its reason', () => {
    expect(cleanTlsDetail(BORINGSSL_KEY_USAGE)).toBe('KEY_USAGE_BIT_INCORRECT (SSL routines)');
  });

  it('reads OpenSSL wording the same way', () => {
    expect(cleanTlsDetail(OPENSSL_VERIFY)).toBe('certificate verify failed (SSL routines)');
    expect(
      cleanTlsDetail(
        'write EPROTO C0A60000:error:0A000410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:916:SSL alert number 40',
      ),
    ).toBe('sslv3 alert handshake failure (SSL routines)');
  });

  it('drops source locations from text in no known shape', () => {
    const cleaned = cleanTlsDetail('something broke at ..\\..\\third_party\\x\\file.cc:12: oops');
    expect(cleaned).toBe('something broke at oops');
    expect(cleaned).not.toMatch(/third_party|\.cc/);
  });

  it('leaves a plain message as it is', () => {
    expect(cleanTlsDetail('socket hang up')).toBe('socket hang up');
  });
});

describe('socketFailure', () => {
  const cases: Array<[string, string]> = [
    ['ENOTFOUND', 'host-not-found'],
    ['EAI_AGAIN', 'host-not-found'],
    ['ECONNREFUSED', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ECONNRESET', 'closed'],
    ['EPIPE', 'closed'],
    ['EWHATEVER', 'other'],
  ];

  it.each(cases)(
    '%s becomes %s, in words, with the code kept for the details',
    (code, expected) => {
      const failure = socketFailure(
        Object.assign(new Error(`connect ${code} 10.0.0.5:3389`), { code }),
        'server.example',
        3389,
      );
      expect(failure.code).toBe(expected);
      expect(failure.message).toMatch(/server\.example/);
      expect(failure.message).not.toMatch(/E[A-Z]{3,}/);
      expect(failure.detail).toContain(code);
    },
  );
});

describe('toFailureInfo', () => {
  it('passes a handshake failure through', () => {
    expect(toFailureInfo(new RdpHandshakeError('refused', 'No.', 'ECONNREFUSED'), 'h', 1)).toEqual({
      code: 'refused',
      message: 'No.',
      detail: 'ECONNREFUSED',
    });
  });

  it('never lets the text of an unexpected error into the sentence', () => {
    const failure = toFailureInfo(new Error(BORINGSSL_KEY_USAGE), 'server.example', 3389);
    expect(failure.code).toBe('other');
    expect(failure.message).toBe('Could not connect to server.example:3389.');
    expect(failure.detail).toBe('KEY_USAGE_BIT_INCORRECT (SSL routines)');
  });
});
