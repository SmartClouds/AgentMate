import { once } from 'node:events';
import {
  type AddressInfo,
  createServer,
  connect as netConnect,
  type Server,
  type Socket,
} from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openTunnel, parseProxyUrl, TunnelError, type TunnelRoute } from './tunnel';

/**
 * Remote Desktop opens a raw socket, which Chromium's proxy settings never touch, so it went
 * straight to the server even with a proxy turned on. These play each kind of proxy on loopback
 * and check that the bytes arrive at the far end through it, and that a proxy saying no comes
 * back as the right kind of failure.
 */

const servers: Server[] = [];
const accepted = new Set<Socket>();

afterEach(async () => {
  // A proxy that never answers keeps its connection open, which would hold `close` up.
  for (const socket of accepted) socket.destroy();
  accepted.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Socket) => {
    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** Answers every line with "echo:" in front, so a test can tell it reached the far end. */
async function startEcho(): Promise<number> {
  return listen(
    createServer((socket) => {
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    }),
  );
}

function readUntil(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (received.length < length) return;
      socket.off('data', onData);
      // Called once per handshake step on the same socket, so the listener has to go too.
      socket.off('error', reject);
      socket.pause();
      if (received.length > length) socket.unshift(received.subarray(length));
      resolve(received.subarray(0, length));
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.resume();
  });
}

function pipeTo(client: Socket, port: number, onOpen: () => void): void {
  const upstream = netConnect({ host: '127.0.0.1', port }, () => {
    onOpen();
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  upstream.on('error', () => client.destroy());
}

interface FakeProxy {
  port: number;
  /** "host:port" of every connection the proxy was asked to open. */
  requests: string[];
}

async function startHttpProxy(
  options: { auth?: string; status?: number } = {},
): Promise<FakeProxy> {
  const requests: string[] = [];
  const port = await listen(
    createServer((client) => {
      client.on('error', () => undefined);
      let head = '';
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        client.off('data', onData);
        client.pause();
        const [, authority] = head.match(/^CONNECT (\S+) HTTP/) ?? [];
        requests.push(authority);
        if (options.auth && !head.includes(`Proxy-Authorization: Basic ${options.auth}`)) {
          client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
        if (options.status) {
          client.end(`HTTP/1.1 ${options.status} Nope\r\n\r\n`);
          return;
        }
        const target = Number(authority.slice(authority.lastIndexOf(':') + 1));
        pipeTo(client, target, () => client.write('HTTP/1.1 200 Connection established\r\n\r\n'));
      };
      client.on('data', onData);
    }),
  );
  return { port, requests };
}

async function startSocks5Proxy(
  options: { user?: string; pass?: string; reply?: number } = {},
): Promise<FakeProxy> {
  const requests: string[] = [];
  const port = await listen(
    createServer(async (client) => {
      client.on('error', () => undefined);
      try {
        const greeting = await readUntil(client, 2);
        const methods = await readUntil(client, greeting[1]);
        const wantsAuth = options.user !== undefined;
        if (wantsAuth && !methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, wantsAuth ? 2 : 0]));
        if (wantsAuth) {
          const [, userLength] = await readUntil(client, 2);
          const user = (await readUntil(client, userLength)).toString();
          const [passLength] = await readUntil(client, 1);
          const pass = (await readUntil(client, passLength)).toString();
          const ok = user === options.user && pass === options.pass;
          client.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) return void client.end();
        }
        const head = await readUntil(client, 4);
        let host: string;
        if (head[3] === 3) {
          const [length] = await readUntil(client, 1);
          host = (await readUntil(client, length)).toString();
        } else if (head[3] === 1) {
          host = [...(await readUntil(client, 4))].join('.');
        } else {
          host = (await readUntil(client, 16)).toString('hex');
        }
        const target = (await readUntil(client, 2)).readUInt16BE();
        requests.push(`${host}:${target}`);
        if (options.reply) {
          client.end(Buffer.from([5, options.reply, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        pipeTo(client, target, () => client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])));
      } catch {
        client.destroy();
      }
    }),
  );
  return { port, requests };
}

async function startSocks4Proxy(): Promise<FakeProxy> {
  const requests: string[] = [];
  const port = await listen(
    createServer((client) => {
      client.on('error', () => undefined);
      let received = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        received = Buffer.concat([received, chunk]);
        const userEnd = received.indexOf(0, 8);
        if (userEnd < 0) return;
        const socks4a = received[4] === 0 && received[5] === 0 && received[6] === 0;
        const nameEnd = socks4a ? received.indexOf(0, userEnd + 1) : userEnd;
        if (nameEnd < 0) return;
        client.off('data', onData);
        client.pause();
        const target = received.readUInt16BE(2);
        const host = socks4a
          ? received.subarray(userEnd + 1, nameEnd).toString()
          : [...received.subarray(4, 8)].join('.');
        requests.push(`${host}:${target}`);
        pipeTo(client, target, () => client.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])));
      };
      client.on('data', onData);
    }),
  );
  return { port, requests };
}

function route(protocol: TunnelRoute['protocol'], port: number, auth?: [string, string]) {
  return {
    protocol,
    host: '127.0.0.1',
    port,
    username: auth?.[0] ?? '',
    password: auth?.[1] ?? '',
  } satisfies TunnelRoute;
}

async function roundTrip(socket: Socket): Promise<string> {
  socket.resume();
  socket.write('hello');
  const [chunk] = (await once(socket, 'data')) as [Buffer];
  socket.destroy();
  return chunk.toString();
}

async function failureOf(promise: Promise<unknown>): Promise<TunnelError> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the tunnel to fail');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TunnelError);
  return error as TunnelError;
}

describe('openTunnel', () => {
  it('goes through an HTTP proxy with CONNECT', async () => {
    const echo = await startEcho();
    const proxy = await startHttpProxy();

    const socket = await openTunnel(route('http', proxy.port), '127.0.0.1', echo);

    expect(await roundTrip(socket)).toBe('echo:hello');
    expect(proxy.requests).toEqual([`127.0.0.1:${echo}`]);
  });

  it('sends the username and password to an HTTP proxy that asks for them', async () => {
    const echo = await startEcho();
    const proxy = await startHttpProxy({ auth: Buffer.from('me:secret').toString('base64') });

    const socket = await openTunnel(route('http', proxy.port, ['me', 'secret']), '127.0.0.1', echo);
    expect(await roundTrip(socket)).toBe('echo:hello');

    const wrong = await failureOf(
      openTunnel(route('http', proxy.port, ['me', 'nope']), '127.0.0.1', echo),
    );
    expect(wrong.reason).toBe('proxy-auth');
  });

  it('reports an HTTP proxy that turns the port down as a refusal by the proxy', async () => {
    const proxy = await startHttpProxy({ status: 403 });

    const error = await failureOf(openTunnel(route('http', proxy.port), 'rdp.example', 3389));

    expect(error.reason).toBe('proxy-refused');
    expect(error.message).toContain('403');
    expect(proxy.requests).toEqual(['rdp.example:3389']);
  });

  it('goes through a SOCKS5 proxy and leaves the name lookup to it', async () => {
    const echo = await startEcho();
    const proxy = await startSocks5Proxy();

    const socket = await openTunnel(route('socks5', proxy.port), 'localhost', echo);

    expect(await roundTrip(socket)).toBe('echo:hello');
    expect(proxy.requests).toEqual([`localhost:${echo}`]);
  });

  it('signs in to a SOCKS5 proxy, and says so when the credentials are wrong', async () => {
    const echo = await startEcho();
    const proxy = await startSocks5Proxy({ user: 'me', pass: 'secret' });

    const socket = await openTunnel(
      route('socks5', proxy.port, ['me', 'secret']),
      '127.0.0.1',
      echo,
    );
    expect(await roundTrip(socket)).toBe('echo:hello');

    const wrong = await failureOf(
      openTunnel(route('socks5', proxy.port, ['me', 'nope']), '127.0.0.1', echo),
    );
    expect(wrong.reason).toBe('proxy-auth');
    const missing = await failureOf(openTunnel(route('socks5', proxy.port), '127.0.0.1', echo));
    expect(missing.reason).toBe('proxy-auth');
  });

  it.each([
    [2, 'proxy-refused'],
    [4, 'target-unreachable'],
    [5, 'target-refused'],
  ] as const)('reads SOCKS5 reply %i as %s', async (reply, reason) => {
    const proxy = await startSocks5Proxy({ reply });

    const error = await failureOf(openTunnel(route('socks5', proxy.port), '10.0.0.5', 3389));

    expect(error.reason).toBe(reason);
    expect(proxy.requests).toEqual(['10.0.0.5:3389']);
  });

  it('goes through a SOCKS4 proxy, by name with SOCKS4a', async () => {
    const echo = await startEcho();
    const proxy = await startSocks4Proxy();

    const byAddress = await openTunnel(route('socks4', proxy.port), '127.0.0.1', echo);
    expect(await roundTrip(byAddress)).toBe('echo:hello');
    const byName = await openTunnel(route('socks4', proxy.port), 'localhost', echo);
    expect(await roundTrip(byName)).toBe('echo:hello');

    expect(proxy.requests).toEqual([`127.0.0.1:${echo}`, `localhost:${echo}`]);
  });

  it('says the proxy itself is unreachable when nothing listens there', async () => {
    const closed = await listen(createServer());
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    const error = await failureOf(openTunnel(route('socks5', closed), '127.0.0.1', 3389));

    expect(error.reason).toBe('proxy-unreachable');
    expect(error.message).toMatch(/ECONNREFUSED/);
  });

  it('reports a proxy that hangs up mid-setup', async () => {
    const port = await listen(createServer((socket) => socket.destroy()));

    const error = await failureOf(openTunnel(route('http', port), '127.0.0.1', 3389));

    expect(error.reason).toBe('proxy-protocol');
  });

  it('gives up when the signal fires before the proxy answers', async () => {
    const port = await listen(createServer(() => undefined));
    const controller = new AbortController();

    const pending = openTunnel(
      route('http', port),
      '127.0.0.1',
      3389,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);

    expect((await failureOf(pending)).reason).toBe('proxy-protocol');
  });
});

describe('parseProxyUrl', () => {
  it('reads what the resolver hands back, credentials added', () => {
    expect(parseProxyUrl('socks5://10.0.0.1:1080', { username: 'u', password: 'p' })).toEqual({
      protocol: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      username: 'u',
      password: 'p',
    });
    expect(parseProxyUrl('https://proxy.example')).toMatchObject({ protocol: 'https', port: 443 });
    expect(parseProxyUrl('http://[::1]:3128')).toMatchObject({ host: '::1', port: 3128 });
  });

  it('turns down what it cannot speak', () => {
    expect(parseProxyUrl('quic://proxy.example:443')).toBeNull();
    expect(parseProxyUrl('not a url')).toBeNull();
  });
});
