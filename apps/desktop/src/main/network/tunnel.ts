import { isIP, isIPv4, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { ProxyProtocol } from '@runova/core';

/**
 * A raw TCP connection opened through a proxy, for the features that need a socket rather than
 * an HTTP request (Remote Desktop). Chromium only proxies its own requests, so this speaks the
 * proxy protocols itself: HTTP CONNECT (over TLS for an HTTPS proxy), SOCKS5 and SOCKS4a.
 *
 * It knows nothing about what runs over the socket. Every failure is a `TunnelError` whose
 * `reason` says whether the proxy or the far end was the problem, and whose message is the
 * technical detail, for the caller to put in its own words.
 */

export interface TunnelRoute {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  /** Blank when the proxy needs no credentials. */
  username: string;
  password: string;
}

export type TunnelFailure =
  /** The proxy itself could not be reached (or, for HTTPS, its TLS failed). */
  | 'proxy-unreachable'
  /** The proxy wants credentials, or turned down the ones given. */
  | 'proxy-auth'
  /** The proxy answered but would not open the connection (a ruleset, a blocked port). */
  | 'proxy-refused'
  /** The proxy said something this module did not understand, or hung up mid-setup. */
  | 'proxy-protocol'
  /** The proxy reports that the far end refused, or could not be reached. */
  | 'target-refused'
  | 'target-unreachable';

export class TunnelError extends Error {
  constructor(
    readonly reason: TunnelFailure,
    message: string,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export interface TunnelDeps {
  netConnect: typeof netConnect;
  tlsConnect: typeof tlsConnect;
}

const DEFAULT_PORTS: Record<ProxyProtocol, number> = {
  http: 80,
  https: 443,
  socks5: 1080,
  socks4: 1080,
};

/**
 * "socks5://10.0.0.1:1080" and the like (what Chromium's resolver answers, turned into a URL)
 * as a route, or null for a scheme this module can't speak.
 */
export function parseProxyUrl(
  url: string,
  credentials: { username: string; password: string } = { username: '', password: '' },
): TunnelRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase() as ProxyProtocol;
  if (!(protocol in DEFAULT_PORTS)) return null;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[protocol];
  return { protocol, host, port, username: credentials.username, password: credentials.password };
}

function describeSocketError(error: NodeJS.ErrnoException): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

/** Opens the connection to the proxy itself, TLS included for an HTTPS proxy. */
function connectToProxy(
  route: TunnelRoute,
  deps: TunnelDeps,
  signal: AbortSignal | undefined,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const where = `${route.host}:${route.port}`;
    const socket =
      route.protocol === 'https'
        ? deps.tlsConnect(
            {
              host: route.host,
              port: route.port,
              // SNI must not be an IP address.
              servername: isIP(route.host) ? undefined : route.host,
            },
            () => done(),
          )
        : deps.netConnect({ host: route.host, port: route.port }, () => done());
    const onError = (error: NodeJS.ErrnoException): void => {
      signal?.removeEventListener('abort', onAbort);
      reject(new TunnelError('proxy-unreachable', `${where}: ${describeSocketError(error)}`));
    };
    const onAbort = (): void => {
      socket.off('error', onError);
      socket.on('error', () => undefined);
      socket.destroy();
      reject(new TunnelError('proxy-unreachable', `${where}: gave up waiting`));
    };
    const done = (): void => {
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      resolve(socket);
    };
    socket.once('error', onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Writes `request` and collects the answer until `complete` says how long it is (or -1 while
 * it isn't all there yet). Anything after it is handed back to the socket for whoever reads next.
 */
function exchange(
  socket: Socket,
  request: Buffer,
  complete: (received: Buffer) => number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const length = complete(received);
      if (length < 0) return;
      cleanup();
      // Stop the flow until the next reader attaches, so the leftover isn't emitted to nobody.
      socket.pause();
      if (received.length > length) socket.unshift(received.subarray(length));
      resolve(received.subarray(0, length));
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      reject(new TunnelError('proxy-protocol', describeSocketError(error)));
    };
    const onClose = (): void => {
      cleanup();
      reject(new TunnelError('proxy-protocol', 'The proxy closed the connection during setup'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    // The previous exchange left the socket paused, and a new listener doesn't undo that.
    socket.resume();
    socket.write(request);
  });
}

function bracketed(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function httpConnect(socket: Socket, route: TunnelRoute, host: string, port: number) {
  const authority = `${bracketed(host)}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (route.username) {
    const token = Buffer.from(`${route.username}:${route.password}`, 'utf-8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  const head = await exchange(
    socket,
    Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
    (r) => {
      const end = r.indexOf('\r\n\r\n');
      return end < 0 ? -1 : end + 4;
    },
  );
  const statusLine = head.toString('latin1').split('\r\n')[0] ?? '';
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
  if (!match) throw new TunnelError('proxy-protocol', `Unexpected answer: ${statusLine}`);
  const status = Number(match[1]);
  if (status >= 200 && status < 300) return;
  if (status === 407) throw new TunnelError('proxy-auth', statusLine);
  throw new TunnelError('proxy-refused', statusLine);
}

const SOCKS5_REPLIES: Record<number, { reason: TunnelFailure; text: string }> = {
  1: { reason: 'proxy-refused', text: 'general SOCKS server failure' },
  2: { reason: 'proxy-refused', text: 'connection not allowed by ruleset' },
  3: { reason: 'target-unreachable', text: 'network unreachable' },
  4: { reason: 'target-unreachable', text: 'host unreachable' },
  5: { reason: 'target-refused', text: 'connection refused' },
  6: { reason: 'target-unreachable', text: 'TTL expired' },
  7: { reason: 'proxy-protocol', text: 'command not supported' },
  8: { reason: 'proxy-protocol', text: 'address type not supported' },
};

function socks5Address(host: string): Buffer {
  if (isIPv4(host)) return Buffer.from([1, ...host.split('.').map(Number)]);
  if (isIP(host) === 6) {
    const bytes = Buffer.alloc(16);
    // Expand "::" so every group is there, then write the eight 16-bit groups.
    const [head, tail = ''] = host.split('::');
    const left = head ? head.split(':') : [];
    const right = host.includes('::') && tail ? tail.split(':') : [];
    const groups = host.includes('::')
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;
    groups.forEach((group, i) => bytes.writeUInt16BE(Number.parseInt(group, 16), i * 2));
    return Buffer.concat([Buffer.from([4]), bytes]);
  }
  const name = Buffer.from(host, 'utf-8');
  if (name.length > 255) throw new TunnelError('proxy-protocol', 'Host name too long for SOCKS5');
  // The proxy resolves the name, so the lookup happens where the connection is made from.
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

async function socks5Connect(socket: Socket, route: TunnelRoute, host: string, port: number) {
  const methods = route.username ? [0x00, 0x02] : [0x00];
  const greeting = await exchange(socket, Buffer.from([5, methods.length, ...methods]), (r) =>
    r.length >= 2 ? 2 : -1,
  );
  if (greeting[0] !== 5) throw new TunnelError('proxy-protocol', 'Not a SOCKS5 proxy');
  if (greeting[1] === 0xff || !methods.includes(greeting[1])) {
    throw new TunnelError('proxy-auth', 'The proxy accepted none of the offered sign-in methods');
  }

  if (greeting[1] === 0x02) {
    const user = Buffer.from(route.username, 'utf-8');
    const pass = Buffer.from(route.password, 'utf-8');
    if (user.length > 255 || pass.length > 255) {
      throw new TunnelError('proxy-auth', 'Username or password too long for SOCKS5');
    }
    const auth = await exchange(
      socket,
      Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]),
      (r) => (r.length >= 2 ? 2 : -1),
    );
    if (auth[1] !== 0) throw new TunnelError('proxy-auth', 'The proxy rejected the credentials');
  }

  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const reply = await exchange(
    socket,
    Buffer.concat([Buffer.from([5, 1, 0]), socks5Address(host), portBytes]),
    (r) => {
      if (r.length < 2) return -1;
      // A refusal is all that matters, whatever follows it.
      if (r[1] !== 0) return r.length;
      if (r.length < 5) return -1;
      const length =
        r[3] === 1 ? 4 + 4 + 2 : r[3] === 4 ? 4 + 16 + 2 : r[3] === 3 ? 4 + 1 + r[4] + 2 : 0;
      if (length === 0) return r.length;
      return r.length >= length ? length : -1;
    },
  );
  if (reply[0] !== 5) throw new TunnelError('proxy-protocol', 'Not a SOCKS5 proxy');
  if (reply[1] !== 0) {
    const known = SOCKS5_REPLIES[reply[1]];
    throw new TunnelError(
      known?.reason ?? 'proxy-refused',
      `SOCKS5 reply ${reply[1]}${known ? ` (${known.text})` : ''}`,
    );
  }
  if (![1, 3, 4].includes(reply[3])) {
    throw new TunnelError('proxy-protocol', `Unknown SOCKS5 address type ${reply[3]}`);
  }
}

async function socks4Connect(socket: Socket, route: TunnelRoute, host: string, port: number) {
  if (isIP(host) === 6) {
    throw new TunnelError('proxy-protocol', 'A SOCKS4 proxy cannot reach an IPv6 address');
  }
  const head = Buffer.alloc(8);
  head[0] = 4;
  head[1] = 1;
  head.writeUInt16BE(port, 2);
  // SOCKS4a: 0.0.0.x with a name after the user id asks the proxy to resolve it.
  const ipv4 = isIPv4(host) ? host.split('.').map(Number) : [0, 0, 0, 1];
  ipv4.forEach((byte, i) => {
    head[4 + i] = byte;
  });
  const parts = [head, Buffer.from(route.username, 'utf-8'), Buffer.from([0])];
  if (!isIPv4(host)) parts.push(Buffer.from(host, 'utf-8'), Buffer.from([0]));

  const reply = await exchange(socket, Buffer.concat(parts), (r) => (r.length >= 8 ? 8 : -1));
  if (reply[1] === 0x5a) return;
  if (reply[1] === 0x5c || reply[1] === 0x5d) {
    throw new TunnelError('proxy-auth', `SOCKS4 reply ${reply[1]} (identd check failed)`);
  }
  throw new TunnelError('proxy-refused', `SOCKS4 reply ${reply[1]} (request rejected or failed)`);
}

/**
 * A socket connected to `host:port` through `route`, ready for the caller's own bytes. It comes
 * back paused, so the caller calls `resume()` once its own reader is attached.
 * `signal` gives up on a proxy that never answers; the socket is destroyed either way.
 */
export async function openTunnel(
  route: TunnelRoute,
  host: string,
  port: number,
  deps: TunnelDeps = { netConnect, tlsConnect },
  signal?: AbortSignal,
): Promise<Socket> {
  let socket: Socket | null = null;
  const onAbort = (): void => {
    socket?.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    socket = await connectToProxy(route, deps, signal);
    if (route.protocol === 'socks5') await socks5Connect(socket, route, host, port);
    else if (route.protocol === 'socks4') await socks4Connect(socket, route, host, port);
    else await httpConnect(socket, route, host, port);
    return socket;
  } catch (error) {
    socket?.destroy();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
