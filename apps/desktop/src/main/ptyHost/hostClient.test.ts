import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostClient } from './hostClient';
import {
  createLineReader,
  encodeLine,
  type HostMessage,
  type HostRequestEnvelope,
  PTY_HOST_PROTOCOL_VERSION,
} from './protocol';

/**
 * Drives HostClient against a real listening socket rather than a stub, because the parts that
 * break in practice are the ones only a socket has: partial lines, an id arriving after its
 * timeout, and every pending request being left hanging when the host dies.
 */

interface FakeHost {
  endpoint: string;
  tokenFile: string;
  /** Every request line the host received, in order. */
  received: HostRequestEnvelope[];
  /** Replaceable per test. Return nothing to stay silent (fire-and-forget or a hang). */
  onRequest: (request: HostRequestEnvelope, socket: Socket) => void;
  /** Pushes an unsolicited event line at every connected client. */
  push: (message: HostMessage) => void;
  /** Writes raw bytes, so a test can split or corrupt a line on purpose. */
  pushRaw: (text: string | Buffer) => void;
  /** Kills the connections without a graceful close, like a host process being killed. */
  dropConnections: () => void;
  close: () => Promise<void>;
}

const dirs: string[] = [];
const hosts: FakeHost[] = [];

/** A socket path (or Windows named pipe) unique to this test, cleaned up afterwards. */
function endpointFor(dir: string): string {
  const suffix = randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\runova-test-${suffix}`
    : join(dir, `h-${suffix}.sock`);
}

async function startFakeHost(token = 'correct-token'): Promise<FakeHost> {
  const dir = mkdtempSync(join(tmpdir(), 'runova-hostclient-'));
  dirs.push(dir);
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${token}\n`, 'utf-8');

  const received: HostRequestEnvelope[] = [];
  const sockets = new Set<Socket>();

  const host: FakeHost = {
    endpoint: endpointFor(dir),
    tokenFile,
    received,
    onRequest: (request, socket) => {
      if (request.type === 'hello') {
        if (request.token !== token) {
          socket.write(encodeLine({ kind: 'response', id: request.id, ok: false, error: 'bad t' }));
          return;
        }
        socket.write(
          encodeLine({
            kind: 'response',
            id: request.id,
            ok: true,
            result: {
              protocolVersion: PTY_HOST_PROTOCOL_VERSION,
              appVersion: '1.2.3',
              pid: 4242,
              sessionCount: 0,
            },
          }),
        );
      }
    },
    push: (message) => {
      for (const socket of sockets) socket.write(encodeLine(message));
    },
    pushRaw: (text) => {
      for (const socket of sockets) socket.write(text);
    },
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    const read = createLineReader(
      (message) => {
        const request = message as HostRequestEnvelope;
        received.push(request);
        host.onRequest(request, socket);
      },
      () => socket.destroy(),
    );
    socket.on('data', read);
  });
  server.on('error', () => undefined);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(host.endpoint, resolve);
  });

  hosts.push(host);
  return host;
}

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop();
    if (host) await host.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('HostClient.connect', () => {
  it('says hello with the token from disk and returns the host banner', async () => {
    const host = await startFakeHost();

    const { client, hello } = await HostClient.connect(host.endpoint, host.tokenFile);

    expect(hello).toEqual({
      protocolVersion: PTY_HOST_PROTOCOL_VERSION,
      appVersion: '1.2.3',
      pid: 4242,
      sessionCount: 0,
    });
    // The trailing newline in the token file must not reach the wire.
    expect(host.received[0]).toMatchObject({
      type: 'hello',
      token: 'correct-token',
      protocolVersion: PTY_HOST_PROTOCOL_VERSION,
      id: 1,
    });
    expect(client.connected).toBe(true);
    client.close();
  });

  it('rejects and closes the socket when the host refuses the token', async () => {
    const host = await startFakeHost('the-real-token');
    writeFileSync(host.tokenFile, 'a-stale-token', 'utf-8');

    await expect(HostClient.connect(host.endpoint, host.tokenFile)).rejects.toThrow('bad t');
    // A refused hello must not leave a half-open connection behind.
    expect(host.received).toHaveLength(1);
  });

  it('rejects when nothing is listening on the endpoint', async () => {
    const host = await startFakeHost();
    await host.close();
    hosts.length = 0;

    await expect(HostClient.connect(host.endpoint, host.tokenFile)).rejects.toThrow();
  });

  it('rejects when the token file is missing', async () => {
    const host = await startFakeHost();
    rmSync(host.tokenFile);

    await expect(HostClient.connect(host.endpoint, join(host.tokenFile))).rejects.toThrow();
  });
});

describe('HostClient.request', () => {
  it('matches each response to the request that carries the same id', async () => {
    const host = await startFakeHost();
    // Answer `list` out of order so a client that just resolved the oldest promise would fail.
    const queued: { id: number; socket: Socket; result: unknown }[] = [];
    host.onRequest = (request, socket) => {
      if (request.type === 'hello') {
        socket.write(encodeLine({ kind: 'response', id: request.id, ok: true, result: {} }));
        return;
      }
      queued.push({ id: request.id as number, socket, result: `answer-${request.id}` });
    };

    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    const first = client.request<string>({ type: 'list' });
    const second = client.request<string>({ type: 'list' });
    await vi.waitFor(() => expect(queued).toHaveLength(2));

    for (const entry of queued.reverse()) {
      entry.socket.write(
        encodeLine({ kind: 'response', id: entry.id, ok: true, result: entry.result }),
      );
    }

    expect(await first).toBe('answer-2');
    expect(await second).toBe('answer-3');
    client.close();
  });

  it('rejects the caller with the error text from a failed response', async () => {
    const host = await startFakeHost();
    host.onRequest = (request, socket) => {
      socket.write(
        request.type === 'hello'
          ? encodeLine({ kind: 'response', id: request.id, ok: true, result: {} })
          : encodeLine({ kind: 'response', id: request.id, ok: false, error: 'no such session' }),
      );
    };

    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    await expect(client.request({ type: 'kill', payload: { sessionId: 'gone' } })).rejects.toThrow(
      'no such session',
    );
    client.close();
  });

  it('rejects after the timeout when the host never answers', async () => {
    const host = await startFakeHost();
    host.onRequest = (request, socket) => {
      if (request.type === 'hello') {
        socket.write(encodeLine({ kind: 'response', id: request.id, ok: true, result: {} }));
      }
      // Everything else is deliberately ignored.
    };

    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    await expect(client.request({ type: 'list' }, 50)).rejects.toThrow(
      'terminal host did not answer list',
    );
    client.close();
  });

  it('ignores a response that arrives after its request already timed out', async () => {
    const host = await startFakeHost();
    const late: { id: number; socket: Socket }[] = [];
    host.onRequest = (request, socket) => {
      if (request.type === 'hello') {
        socket.write(encodeLine({ kind: 'response', id: request.id, ok: true, result: {} }));
        return;
      }
      late.push({ id: request.id as number, socket });
    };

    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    await expect(client.request({ type: 'list' }, 30)).rejects.toThrow();

    // A late response for a dropped id must not throw or resolve anything.
    late[0].socket.write(
      encodeLine({ kind: 'response', id: late[0].id, ok: true, result: 'late' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.connected).toBe(true);
    client.close();
  });

  it('refuses a request once the socket is gone instead of hanging', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    client.close();

    await expect(client.request({ type: 'list' })).rejects.toThrow(
      'terminal host is not connected',
    );
    expect(client.connected).toBe(false);
  });
});

describe('HostClient.notify', () => {
  it('sends a fire-and-forget line with no id', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    client.notify({ type: 'write', payload: { sessionId: 's1', data: 'ls\r' } });

    await vi.waitFor(() => expect(host.received).toHaveLength(2));
    // No id means the host knows not to answer, which is what keeps keystrokes cheap.
    expect(host.received[1]).toEqual({
      type: 'write',
      payload: { sessionId: 's1', data: 'ls\r' },
    });
    client.close();
  });

  it('drops a notify on a closed socket rather than throwing', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    client.close();

    expect(() => client.notify({ type: 'list' })).not.toThrow();
  });
});

describe('HostClient events', () => {
  it('dispatches data and exit events to the subscriber', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    const data: [string, string][] = [];
    const exits: [string, number][] = [];
    client.setEvents({
      onData: (sessionId, chunk) => data.push([sessionId, chunk]),
      onExit: (sessionId, code) => exits.push([sessionId, code]),
      onDisconnect: () => undefined,
    });

    host.push({ kind: 'event', event: 'data', sessionId: 's1', data: 'hello' });
    host.push({ kind: 'event', event: 'exit', sessionId: 's1', exitCode: 3 });

    await vi.waitFor(() => expect(exits).toHaveLength(1));
    expect(data).toEqual([['s1', 'hello']]);
    expect(exits).toEqual([['s1', 3]]);
    client.close();
  });

  it('reassembles an event split across two socket writes', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    const data: string[] = [];
    client.setEvents({
      onData: (_sessionId, chunk) => data.push(chunk),
      onExit: () => undefined,
      onDisconnect: () => undefined,
    });

    const line = encodeLine({ kind: 'event', event: 'data', sessionId: 's1', data: 'abcdef' });
    // Write the line in two pieces, which is what a busy pipe actually does.
    const half = Math.floor(line.length / 2);
    host.pushRaw(line.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(data).toEqual([]);

    host.pushRaw(line.slice(half));

    await vi.waitFor(() => expect(data).toEqual(['abcdef']));
    client.close();
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    const data: string[] = [];
    client.setEvents({
      onData: (_sessionId, chunk) => data.push(chunk),
      onExit: () => undefined,
      onDisconnect: () => undefined,
    });

    // Splitting inside the UTF-8 bytes of a box drawing character used to produce replacement
    // characters, which shifted every following terminal column.
    const bytes = Buffer.from(
      encodeLine({ kind: 'event', event: 'data', sessionId: 's1', data: '│─┤' }),
      'utf-8',
    );
    const cut = bytes.indexOf(Buffer.from('│', 'utf-8')) + 1;
    host.pushRaw(bytes.subarray(0, cut));
    host.pushRaw(bytes.subarray(cut));

    await vi.waitFor(() => expect(data).toEqual(['│─┤']));
    client.close();
  });

  it('survives a malformed line without dropping the connection', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    const data: string[] = [];
    client.setEvents({
      onData: (_sessionId, chunk) => data.push(chunk),
      onExit: () => undefined,
      onDisconnect: () => undefined,
    });

    host.pushRaw('this is not json\n');
    host.push({ kind: 'event', event: 'data', sessionId: 's1', data: 'still here' });

    await vi.waitFor(() => expect(data).toEqual(['still here']));
    expect(client.connected).toBe(true);
    client.close();
  });
});

describe('HostClient disconnect', () => {
  it('rejects every pending request when the host goes away', async () => {
    const host = await startFakeHost();
    host.onRequest = (request, socket) => {
      if (request.type === 'hello') {
        socket.write(encodeLine({ kind: 'response', id: request.id, ok: true, result: {} }));
      }
    };
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    const first = client.request({ type: 'list' });
    const second = client.request({ type: 'kill', payload: { sessionId: 's1' } });
    await vi.waitFor(() => expect(host.received).toHaveLength(3));

    host.dropConnections();

    await expect(first).rejects.toThrow('terminal host connection closed');
    await expect(second).rejects.toThrow('terminal host connection closed');
  });

  it('notifies the subscriber when the drop was not our doing', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    let disconnects = 0;
    client.setEvents({
      onData: () => undefined,
      onExit: () => undefined,
      onDisconnect: () => {
        disconnects += 1;
      },
    });

    host.dropConnections();

    await vi.waitFor(() => expect(disconnects).toBe(1));
    expect(client.connected).toBe(false);
  });

  it('stays quiet when we closed the connection ourselves', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    let disconnects = 0;
    client.setEvents({
      onData: () => undefined,
      onExit: () => undefined,
      onDisconnect: () => {
        disconnects += 1;
      },
    });

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // An intentional close is not a host crash, so nothing should try to restart anything.
    expect(disconnects).toBe(0);
  });

  it('closeAfterFlush resolves once the socket is down', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);

    client.notify({ type: 'write', payload: { sessionId: 's1', data: 'exit\r' } });
    await client.closeAfterFlush();

    expect(client.connected).toBe(false);
    // The write went out before the socket went down.
    expect(host.received.map((one) => one.type)).toContain('write');
  });

  it('closeAfterFlush resolves immediately on an already dead socket', async () => {
    const host = await startFakeHost();
    const { client } = await HostClient.connect(host.endpoint, host.tokenFile);
    client.close();

    await expect(client.closeAfterFlush()).resolves.toBeUndefined();
  });
});
