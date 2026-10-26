import { createHash, type X509Certificate } from 'node:crypto';
import { type ConnectionOptions, type TLSSocket, connect as tlsConnect } from 'node:tls';
import { encodeCoreError } from '../../../shared/coreErrors';
import type { CoreTransport } from '../connection/transport';
import type { ClientCertificate } from './clientCertificate';

/**
 * Direct TLS (E16): the core's own HTTPS port, for servers the app cannot reach over SSH. TLS 1.3
 * with this computer's device key as the client certificate. The server's certificate is
 * self-signed, so no CA can vouch for it; its public key has to hash to the pin the app read over
 * SSH, and nothing is written to the socket before that is checked. HTTP and the hub then run over
 * the socket exactly as they do over an SSH channel.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** The name sent in SNI; the core has one certificate and ignores it. */
const SERVER_NAME = 'runova-core';

export interface DirectTlsTarget {
  host: string;
  port: number;
  /** base64 SHA-256 of the server certificate's SubjectPublicKeyInfo, read over SSH. */
  pin: string;
}

/** base64 SHA-256 of a certificate's SubjectPublicKeyInfo: the same value the core reports. */
export function spkiPin(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('base64');
}

/**
 * The server answered with a key other than the pinned one. Either the core's certificate was
 * replaced (a reinstall that lost its data) or something stands between this computer and the
 * server. Never a reason to try another way in quietly.
 */
export class PinMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    endpoint: string,
  ) {
    super(
      encodeCoreError(
        'tlsPinMismatch',
        `The certificate at ${endpoint} does not match the one pinned over SSH, so Runova stopped instead of connecting another way. Something may be intercepting the connection, or the server core was reinstalled. Check the server, then read the pin again over SSH in the server's Security section, or turn direct TLS off there.`,
      ),
    );
    this.name = 'PinMismatchError';
  }
}

/** The port did not answer, or refused the handshake: worth trying SSH instead. */
export class DirectTlsUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectTlsUnreachableError';
  }
}

export type TlsConnect = (options: ConnectionOptions) => TLSSocket;

export function directTlsTransport(
  target: DirectTlsTarget,
  credentials: () => Promise<ClientCertificate>,
  connect: TlsConnect = tlsConnect,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): CoreTransport {
  const endpoint = `${target.host}:${target.port}`;
  return {
    kind: 'direct-tls',
    openStream: async () => {
      const { certificate, key } = await credentials();
      return new Promise<TLSSocket>((resolve, reject) => {
        const socket = connect({
          host: target.host,
          port: target.port,
          servername: SERVER_NAME,
          cert: certificate,
          key,
          minVersion: 'TLSv1.3',
          ALPNProtocols: ['http/1.1'],
          // No CA can vouch for a self-signed certificate; the pin below decides instead.
          rejectUnauthorized: false,
        });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(
            new DirectTlsUnreachableError(
              `The direct TLS port at ${endpoint} did not answer in time.`,
            ),
          );
        }, timeoutMs);
        socket.once('secureConnect', () => {
          clearTimeout(timer);
          const peer = socket.getPeerX509Certificate();
          const actual = peer ? spkiPin(peer) : '';
          if (actual !== target.pin) {
            socket.destroy();
            reject(new PinMismatchError(target.pin, actual, endpoint));
            return;
          }
          resolve(socket);
        });
        socket.once('error', (error: Error) => {
          clearTimeout(timer);
          reject(
            new DirectTlsUnreachableError(
              `Could not reach the direct TLS port at ${endpoint}: ${error.message}`,
            ),
          );
        });
      });
    },
  };
}
