import { isIP, connect as netConnect, type Socket } from 'node:net';
import {
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type TLSSocket,
  connect as tlsConnect,
} from 'node:tls';
import type { RdpCertificateInfo, RdpFailureInfo, RdpProxyErrorCode } from '../../shared/apiTypes';
import { openTunnel, TunnelError, type TunnelRoute } from '../network/tunnel';
import { tpktRemaining } from './rdcleanpath';

/**
 * The TCP connect, X.224 negotiation and TLS upgrade that come before an RDP session. The
 * session window can't open sockets, so the proxy (and the certificate check) run this for it.
 *
 * Nothing from a socket or TLS library reaches a person as it is: every failure leaves here as an
 * `RdpHandshakeError` with a plain sentence and, separately, the library's own reason for
 * anyone digging in.
 */

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * TLS settings for servers whose certificate only allows key encipherment. Windows makes such a
 * certificate for Remote Desktop itself (Key Usage: Key Encipherment, Data Encipherment). The
 * TLS stack in Electron (BoringSSL) refuses it for ECDHE and for TLS 1.3, which sign with the
 * certificate's key, with KEY_USAGE_BIT_INCORRECT. Plain RSA key exchange only needs the
 * encipherment bit, and the server's choice of ciphers stays within what is listed here. It
 * gives up forward secrecy, so it is only tried after the normal handshake fails that way. Trust
 * does not rest on the certificate chain either way: it comes from the saved fingerprint.
 */
export const RSA_KEY_EXCHANGE_TLS = {
  maxVersion: 'TLSv1.2',
  ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA:AES128-SHA',
} as const satisfies Pick<ConnectionOptions, 'maxVersion' | 'ciphers'>;

export class RdpHandshakeError extends Error implements RdpFailureInfo {
  constructor(
    readonly code: RdpProxyErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'RdpHandshakeError';
  }
}

/** The part the handshake needs from the network, so a test can stand in for the TLS library. */
export interface HandshakeDeps {
  netConnect: typeof netConnect;
  tlsConnect: typeof tlsConnect;
  /**
   * The proxy to go through, asked again for every connection so a proxy saved in between
   * applies to the next one. Null, or no `route` at all, connects straight to the server.
   */
  route?: (host: string, port: number) => Promise<TunnelRoute | null>;
}

/** Straight to the server. The app adds its proxy settings on top of these. */
export const directHandshakeDeps: HandshakeDeps = { netConnect, tlsConnect };

export interface Handshake {
  /** The resolved IP address actually connected to. */
  address: string;
  x224Response: Buffer;
  tlsSocket: TLSSocket;
  cert: RdpCertificateInfo;
  chain: Buffer[];
  /** `rsa` when the certificate only allowed key encipherment and the retry was needed. */
  keyExchange: 'default' | 'rsa';
}

/** True for the TLS error BoringSSL raises when a certificate can't be used the way TLS needs. */
export function isKeyUsageError(text: string): boolean {
  return /KEY_USAGE_BIT_INCORRECT/i.test(text);
}

/**
 * A TLS library error without its internals. BoringSSL words them as
 * `105556096:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:..\..\third_party\...\ssl_cert.cc:397:`,
 * which reads as `KEY_USAGE_BIT_INCORRECT (SSL routines)` here. Text in no known shape only
 * loses its source locations.
 */
export function cleanTlsDetail(text: string): string {
  const library = text.match(/error:[0-9a-f]{8}:([^:]+):[^:]*:([^:\r\n]+)/i);
  if (library) return `${library[2].trim()} (${library[1].trim()})`;
  return text
    .replace(/\S*[\\/]\S+\.(?:cc|c|h|rs|cpp):\d+:?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatName(name: Record<string, string | string[]> | undefined): string {
  if (!name) return '';
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
    .join(', ');
}

function certChain(peer: DetailedPeerCertificate): Buffer[] {
  const chain: Buffer[] = [];
  const seen = new Set<string>();
  let current: DetailedPeerCertificate | undefined = peer;
  while (current?.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    chain.push(Buffer.from(current.raw));
    current = current.issuerCertificate === current ? undefined : current.issuerCertificate;
  }
  return chain;
}

/** Turns a socket error into something a person can act on. */
export function socketFailure(
  error: NodeJS.ErrnoException,
  host: string,
  port: number,
): RdpHandshakeError {
  const detail = cleanTlsDetail(error.code ? `${error.code}: ${error.message}` : error.message);
  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new RdpHandshakeError('host-not-found', `Could not find ${host}.`, detail);
    case 'ECONNREFUSED':
      return new RdpHandshakeError('refused', `${host}:${port} refused the connection.`, detail);
    case 'ETIMEDOUT':
      return new RdpHandshakeError('timeout', `${host}:${port} did not answer in time.`, detail);
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new RdpHandshakeError(
        'unreachable',
        `${host} is not reachable from this network.`,
        detail,
      );
    case 'ECONNRESET':
    case 'EPIPE':
      return new RdpHandshakeError(
        'closed',
        `${host}:${port} closed the connection during setup.`,
        detail,
      );
    default:
      return new RdpHandshakeError('other', `Could not connect to ${host}:${port}.`, detail);
  }
}

/**
 * A system error code like ECONNRESET, as opposed to the TLS library's own (`ERR_SSL_...`,
 * EPROTO) whose message holds the library's text.
 */
function isSocketError(error: NodeJS.ErrnoException): boolean {
  return (
    error.code !== undefined &&
    error.code !== 'EPROTO' &&
    /^E[A-Z0-9]+$/.test(error.code) &&
    !isKeyUsageError(error.message)
  );
}

/** A TLS failure, in words. `tls-key-usage` carries the sentence for "the retry didn't help either". */
function tlsFailure(error: Error, host: string, port: number): RdpHandshakeError {
  const detail = cleanTlsDetail(error.message);
  if (isKeyUsageError(error.message)) {
    return new RdpHandshakeError(
      'tls-key-usage',
      `The certificate ${host}:${port} presented can't be used to set up an encrypted connection.`,
      detail,
    );
  }
  return new RdpHandshakeError(
    'tls-failed',
    `Runova couldn't set up a secure connection with ${host}:${port}.`,
    detail,
  );
}

function attempt(
  host: string,
  port: number,
  x224Request: Buffer,
  tlsOptions: Pick<ConnectionOptions, 'maxVersion' | 'ciphers'>,
  deps: HandshakeDeps,
): Promise<Omit<Handshake, 'keyExchange'>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let tcp: Socket | null = null;
    let tlsSocket: TLSSocket | null = null;
    let route: TunnelRoute | null = null;
    let received = Buffer.alloc(0);
    // Gives up on a proxy that is still being set up when time runs out.
    const giveUp = new AbortController();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      giveUp.abort();
      tlsSocket?.destroy();
      tcp?.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      const detail = `No answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`;
      // Still setting up the proxy, so it was the proxy that kept quiet, not the server.
      if (route && !tcp) {
        fail(
          new RdpHandshakeError(
            'proxy-failed',
            `The proxy at ${route.host}:${route.port} did not answer in time.`,
            detail,
          ),
        );
        return;
      }
      fail(new RdpHandshakeError('timeout', `${host}:${port} did not answer in time.`, detail));
    }, CONNECT_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      let remaining: number;
      try {
        remaining = tpktRemaining(received);
      } catch (error) {
        fail(
          new RdpHandshakeError(
            'not-rdp',
            `${host}:${port} does not look like a Remote Desktop server.`,
            (error as Error).message,
          ),
        );
        return;
      }
      if (remaining > 0) return;
      // The server says nothing more until our TLS ClientHello, so TLS can take the socket over.
      tcp?.off('data', onData);

      tlsSocket = deps.tlsConnect(
        {
          socket: tcp as Socket,
          // SNI must not be an IP address.
          servername: isIP(host) ? undefined : host,
          // RDP servers use self-signed certificates. Trust comes from the saved fingerprint.
          rejectUnauthorized: false,
          ...tlsOptions,
        },
        () => {
          if (settled || !tlsSocket) return;
          const peer = tlsSocket.getPeerCertificate(true);
          if (!peer?.raw) {
            fail(
              new RdpHandshakeError('tls-failed', `${host}:${port} did not present a certificate.`),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({
            // Through a proxy the socket's far end is the proxy, not the server.
            address: (route ? undefined : tcp?.remoteAddress) ?? host,
            x224Response: received,
            tlsSocket,
            chain: certChain(peer),
            cert: {
              fingerprint: peer.fingerprint256,
              subject: formatName(peer.subject as unknown as Record<string, string>),
              issuer: formatName(peer.issuer as unknown as Record<string, string>),
              validTo: peer.valid_to,
            },
          });
        },
      );
      tlsSocket.on('error', (error: NodeJS.ErrnoException) =>
        fail(
          isSocketError(error) ? socketFailure(error, host, port) : tlsFailure(error, host, port),
        ),
      );
    };
    const watch = (socket: Socket): void => {
      tcp = socket;
      socket.on('error', (error: NodeJS.ErrnoException) => fail(socketFailure(error, host, port)));
      socket.on('data', onData);
      socket.on('close', () =>
        fail(
          new RdpHandshakeError('closed', `${host}:${port} closed the connection during setup.`),
        ),
      );
    };

    void (async () => {
      route = (await deps.route?.(host, port)) ?? null;
      if (settled) return;
      if (!route) {
        const socket = deps.netConnect({ host, port }, () => socket.write(x224Request));
        watch(socket);
        return;
      }
      let socket: Socket;
      try {
        socket = await openTunnel(route, host, port, deps, giveUp.signal);
      } catch (error) {
        fail(tunnelFailure(error, route, host, port));
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      watch(socket);
      socket.resume();
      socket.write(x224Request);
    })().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

/** A failure on the way through the proxy, in words that say which side it was. */
export function tunnelFailure(
  error: unknown,
  route: TunnelRoute,
  host: string,
  port: number,
): RdpHandshakeError {
  const proxy = `${route.host}:${route.port}`;
  const detail = cleanTlsDetail(error instanceof Error ? error.message : String(error));
  const reason = error instanceof TunnelError ? error.reason : 'proxy-protocol';
  switch (reason) {
    case 'proxy-unreachable':
      return new RdpHandshakeError(
        'proxy-failed',
        `Could not reach the proxy at ${proxy}.`,
        detail,
      );
    case 'proxy-auth':
      return new RdpHandshakeError(
        'proxy-failed',
        route.username
          ? `The proxy at ${proxy} turned down the username and password.`
          : `The proxy at ${proxy} asks for a username and password.`,
        detail,
      );
    case 'proxy-refused':
      return new RdpHandshakeError(
        'proxy-failed',
        `The proxy at ${proxy} would not connect to ${host}:${port}.`,
        detail,
      );
    case 'target-refused':
      return new RdpHandshakeError('refused', `${host}:${port} refused the connection.`, detail);
    case 'target-unreachable':
      return new RdpHandshakeError(
        'unreachable',
        `${host} is not reachable from the proxy at ${proxy}.`,
        detail,
      );
    default:
      return new RdpHandshakeError(
        'proxy-failed',
        `The proxy at ${proxy} did not finish connecting to ${host}:${port}.`,
        detail,
      );
  }
}

/** Failures of the retry that mean the server is not there, not that it refused the encryption. */
const GONE_ON_RETRY: ReadonlySet<RdpProxyErrorCode> = new Set([
  'host-not-found',
  'refused',
  'unreachable',
  'proxy-failed',
]);

/**
 * Connects to the server, negotiates RDP security and upgrades to TLS. A certificate that only
 * allows key encipherment (see `RSA_KEY_EXCHANGE_TLS`) makes the first attempt fail; the socket
 * is dead by then, so the retry starts over with a new connection. It is tried once.
 */
export async function handshake(
  host: string,
  port: number,
  x224Request: Buffer,
  deps: HandshakeDeps = directHandshakeDeps,
): Promise<Handshake> {
  try {
    return { ...(await attempt(host, port, x224Request, {}, deps)), keyExchange: 'default' };
  } catch (first) {
    if (!(first instanceof RdpHandshakeError) || first.code !== 'tls-key-usage') throw first;
    try {
      const retried = await attempt(host, port, x224Request, RSA_KEY_EXCHANGE_TLS, deps);
      return { ...retried, keyExchange: 'rsa' };
    } catch (second) {
      // The server being gone says more than the TLS failure before it. Anything else on the
      // retry (an alert, a reset, silence) means it turned the older encryption down, so the
      // certificate is still the story.
      if (second instanceof RdpHandshakeError && GONE_ON_RETRY.has(second.code)) throw second;
      throw new RdpHandshakeError(
        'tls-key-usage',
        first.message,
        [first.detail, second instanceof RdpHandshakeError ? second.detail : undefined]
          .filter(Boolean)
          .join('; then '),
      );
    }
  }
}

/**
 * X.224 connection request asking for TLS or CredSSP, which is all the certificate check needs
 * from the server. The session itself sends its own, built by the RDP engine.
 */
export function buildProbeConnectionRequest(): Buffer {
  return Buffer.from('030000130ee000000000000100080003000000', 'hex');
}

/** Reads the certificate a server presents, without signing in or starting a session. */
export async function fetchServerCertificate(
  host: string,
  port: number,
  deps?: HandshakeDeps,
): Promise<RdpCertificateInfo> {
  const result = await handshake(host, port, buildProbeConnectionRequest(), deps);
  result.tlsSocket.destroy();
  return result.cert;
}

/** The failure to report for anything `handshake` threw. */
export function toFailureInfo(error: unknown, host: string, port: number): RdpFailureInfo {
  if (error instanceof RdpHandshakeError) {
    return { code: error.code, message: error.message, detail: error.detail };
  }
  const detail = cleanTlsDetail(error instanceof Error ? error.message : String(error));
  return { code: 'other', message: `Could not connect to ${host}:${port}.`, detail };
}
