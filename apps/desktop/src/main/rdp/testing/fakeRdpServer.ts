import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { TestCertificate } from './rdpCertificate';

/**
 * X.224 connection confirm that selects TLS, the first thing a real Remote Desktop server answers
 * a connection request with. TPKT header, X.224 CC, then RDP_NEG_RSP (selected protocol: SSL).
 */
export const X224_CONFIRM_TLS = Buffer.from('030000130ed000001234000200080001000000', 'hex');

export interface FakeRdpServer {
  port: number;
  /** How many connections arrived, the retry after a failed TLS attempt included. */
  connections: () => number;
  close: () => Promise<void>;
}

/**
 * Speaks just enough RDP to get a client to its TLS handshake: reads the connection request,
 * answers with a confirm that selects TLS, then upgrades the same socket to a TLS server using
 * `certificate`. Anything the client sends after the handshake is ignored, unless `echo` is on,
 * which sends it straight back.
 */
export async function startFakeRdpServer(
  certificate: TestCertificate,
  tlsOptions: { ciphers?: string; maxVersion?: 'TLSv1.2' | 'TLSv1.3' } = {},
  /** A port to listen on, to stand in for a server that was reinstalled at the same address. */
  port = 0,
  echo = false,
): Promise<FakeRdpServer> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write(X224_CONFIRM_TLS);
      const secure = new TLSSocket(socket, { isServer: true, ...certificate, ...tlsOptions });
      secure.on('error', () => undefined);
      secure.on('data', (data: Buffer) => {
        if (echo) secure.write(data);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fake server did not bind.');
  return {
    port: address.port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
