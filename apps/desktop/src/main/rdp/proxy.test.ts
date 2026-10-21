import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { RdpFailureInfo } from '../../shared/apiTypes';
import { buildProbeConnectionRequest, type HandshakeDeps } from './handshake';
import { RdpProxy, type RdpProxyHooks, type RdpProxyTarget } from './proxy';
import { buildRdCleanPathError, buildRdCleanPathRequest } from './rdcleanpath';
import { type FakeRdpServer, startFakeRdpServer, X224_CONFIRM_TLS } from './testing/fakeRdpServer';
import { rdpStyleCertificate, type TestCertificate } from './testing/rdpCertificate';

/**
 * The path a session takes through the local proxy, with a Remote Desktop server in the middle
 * that answers like Windows does. These are the cases that went wrong after a Windows Server was
 * reinstalled: its new certificate was refused by the TLS stack before the saved fingerprint was
 * compared, and the window showed the library's raw error.
 */

const BORINGSSL_KEY_USAGE =
  '105556096:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:..\\..\\third_party\\boringssl\\src\\ssl\\ssl_cert.cc:397:';
const LIBRARY_TEXT = /error:|OPENSSL_internal|ssl_cert\.cc|third_party|boringssl/i;

/** BoringSSL's refusal, played back whenever the normal key exchange is attempted. */
function boringSslLike(options: { allowRsa: boolean }): HandshakeDeps {
  const connect = ((tlsOptions: ConnectionOptions, callback?: () => void): TLSSocket => {
    if (options.allowRsa && tlsOptions.ciphers !== undefined) {
      return tlsConnect(tlsOptions, callback);
    }
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    setImmediate(() => socket.emit('error', new Error(BORINGSSL_KEY_USAGE)));
    return socket as unknown as TLSSocket;
  }) as typeof tlsConnect;
  return { netConnect, tlsConnect: connect };
}

let windows: TestCertificate;
let fingerprint: string;
let server: FakeRdpServer | null = null;
let proxy: RdpProxy | null = null;
const sockets: WebSocket[] = [];

beforeAll(() => {
  windows = rdpStyleCertificate('windows');
  fingerprint = new X509Certificate(windows.cert).fingerprint256;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  proxy?.shutdown();
  proxy = null;
  await server?.close();
  server = null;
});

function makeHooks() {
  return {
    onCertificateFirstSeen: vi.fn(),
    onCertificateMismatch: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn<(target: RdpProxyTarget, failure: RdpFailureInfo) => void>(),
  } satisfies RdpProxyHooks;
}

/** Opens a session through the proxy and returns the first message the window would get. */
async function openSession(
  hooks: RdpProxyHooks,
  deps: HandshakeDeps | undefined,
  target: Partial<RdpProxyTarget> & { port: number },
): Promise<Buffer> {
  proxy = new RdpProxy(hooks, deps);
  const full: RdpProxyTarget = { sessionId: 's1', host: '127.0.0.1', ...target };
  const url = await proxy.issueUrl(full);
  const ws = new WebSocket(url);
  sockets.push(ws);
  const reply = new Promise<Buffer>((resolve, reject) => {
    ws.once('message', (data) => resolve(data as Buffer));
    ws.once('error', reject);
    ws.once('close', () => reject(new Error('closed without an answer')));
  });
  await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  ws.send(
    buildRdCleanPathRequest({
      destination: `127.0.0.1:${full.port}`,
      x224ConnectionRequest: buildProbeConnectionRequest(),
    }),
  );
  return reply;
}

describe('RdpProxy with a Windows server certificate that only allows key encipherment', () => {
  it('connects a server seen for the first time and saves its certificate', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();

    const reply = await openSession(hooks, boringSslLike({ allowRsa: true }), {
      port: server.port,
    });

    // A success carries the server's X.224 confirm back to the window.
    expect(reply.includes(X224_CONFIRM_TLS)).toBe(true);
    expect(hooks.onError).not.toHaveBeenCalled();
    expect(hooks.onConnected).toHaveBeenCalledOnce();
    expect(hooks.onCertificateFirstSeen).toHaveBeenCalledOnce();
    expect(hooks.onCertificateFirstSeen.mock.calls[0][1]).toMatchObject({
      fingerprint,
      subject: 'CN=WIN-RDP-TEST',
    });
  });

  it('asks about the new certificate of a reinstalled server instead of failing on the old pin', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();

    const reply = await openSession(hooks, boringSslLike({ allowRsa: true }), {
      port: server.port,
      expectedFingerprint: 'AA:BB:CC:OLD:CERTIFICATE',
    });

    expect(hooks.onCertificateMismatch).toHaveBeenCalledOnce();
    expect(hooks.onCertificateMismatch.mock.calls[0][1].fingerprint).toBe(fingerprint);
    expect(hooks.onConnected).not.toHaveBeenCalled();
    // The window is told why it was turned away, so its failure screen can offer the review.
    expect(hooks.onError).toHaveBeenCalledOnce();
    expect(hooks.onError.mock.calls[0][1]).toMatchObject({ code: 'certificate-changed' });
    expect(reply.equals(buildRdCleanPathError(1, 403))).toBe(true);
  });

  it('connects when the saved certificate still matches', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();

    await openSession(hooks, boringSslLike({ allowRsa: true }), {
      port: server.port,
      expectedFingerprint: fingerprint,
    });

    expect(hooks.onConnected).toHaveBeenCalledOnce();
    expect(hooks.onCertificateFirstSeen).not.toHaveBeenCalled();
    expect(hooks.onCertificateMismatch).not.toHaveBeenCalled();
  });

  it('reports a certificate it cannot use in plain words, with the library text kept apart', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();

    const reply = await openSession(hooks, boringSslLike({ allowRsa: false }), {
      port: server.port,
    });

    expect(hooks.onError).toHaveBeenCalledOnce();
    const failure = hooks.onError.mock.calls[0][1];
    expect(failure.code).toBe('tls-key-usage');
    expect(failure.message).not.toMatch(LIBRARY_TEXT);
    expect(failure.detail).not.toMatch(LIBRARY_TEXT);
    expect(failure.detail).toContain('KEY_USAGE_BIT_INCORRECT');
    expect(reply.equals(buildRdCleanPathError(1, 502))).toBe(true);
  });
});

describe('RdpProxy link stats', () => {
  it('measures what crosses an open session and drops it when the session closes', async () => {
    server = await startFakeRdpServer(windows, {}, 0, true);
    await openSession(makeHooks(), boringSslLike({ allowRsa: true }), { port: server.port });

    // Connected, but nothing has crossed yet.
    expect(proxy?.linkStats('s1')).toEqual({
      downBytesPerSec: 0,
      upBytesPerSec: 0,
      latencyMs: null,
    });

    sockets[0].send(Buffer.alloc(1000));
    await vi.waitFor(() => {
      const stats = proxy?.linkStats('s1');
      expect(stats?.upBytesPerSec).toBeGreaterThan(0);
      expect(stats?.downBytesPerSec).toBeGreaterThan(0);
      expect(stats?.latencyMs).not.toBeNull();
    });

    proxy?.closeSession('s1');
    expect(proxy?.linkStats('s1')).toBeNull();
  });

  it('has nothing for a session that was never connected', async () => {
    proxy = new RdpProxy(makeHooks());
    expect(proxy.linkStats('s1')).toBeNull();
  });
});

describe('RdpProxy errors', () => {
  it('names a refused connection without the system error code', async () => {
    server = await startFakeRdpServer(windows);
    const { port } = server;
    await server.close();
    server = null;
    const hooks = makeHooks();

    await openSession(hooks, undefined, { port });

    const failure = hooks.onError.mock.calls[0][1];
    expect(failure.code).toBe('refused');
    expect(failure.message).toBe(`127.0.0.1:${port} refused the connection.`);
  });

  it('turns away a session that asks for a different server than it was opened for', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();
    proxy = new RdpProxy(hooks);
    const url = await proxy.issueUrl({ sessionId: 's1', host: '127.0.0.1', port: server.port });
    const ws = new WebSocket(url);
    sockets.push(ws);
    const reply = new Promise<Buffer>((resolve) =>
      ws.once('message', (data) => resolve(data as Buffer)),
    );
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(
      buildRdCleanPathRequest({
        destination: '10.9.9.9:3389',
        x224ConnectionRequest: buildProbeConnectionRequest(),
      }),
    );

    expect((await reply).equals(buildRdCleanPathError(1, 403))).toBe(true);
    expect(hooks.onError.mock.calls[0][1]).toEqual({
      code: 'other',
      message: 'The session asked for a different server than the one it was opened for.',
    });
  });

  it('answers a request it cannot read with a sentence, not the parser error', async () => {
    server = await startFakeRdpServer(windows);
    const hooks = makeHooks();
    proxy = new RdpProxy(hooks);
    const url = await proxy.issueUrl({ sessionId: 's1', host: '127.0.0.1', port: server.port });
    const ws = new WebSocket(url);
    sockets.push(ws);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(Buffer.from([0x01, 0x02, 0x03]));
    await vi.waitFor(() => expect(hooks.onError).toHaveBeenCalled());

    const failure = hooks.onError.mock.calls[0][1];
    expect(failure.message).toBe('The session sent a request AgentMate did not understand.');
    expect(failure.detail).toBeTruthy();
  });

  it('closes a connection that has no valid token', async () => {
    proxy = new RdpProxy(makeHooks());
    const url = await proxy.issueUrl({ sessionId: 's1', host: '127.0.0.1', port: 3389 });
    const ws = new WebSocket(url.replace(/\/[0-9a-f]+$/, '/not-a-token'));
    sockets.push(ws);
    const closed = await new Promise<number>((resolve) =>
      ws.once('close', (code) => resolve(code)),
    );
    expect(closed).toBe(1008);
  });
});
