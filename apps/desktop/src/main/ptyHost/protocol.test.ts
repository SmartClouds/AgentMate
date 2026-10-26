import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withPlatform } from '../../test/main/fixtures';
import {
  createLineReader,
  encodeLine,
  type HostMessage,
  MAX_LINE_BYTES,
  PTY_HOST_PROTOCOL_VERSION,
  ptyHostPaths,
} from './protocol';

/**
 * The pty host runs in its own process and talks to the app over a pipe, so these two pieces
 * decide whether the app can find the host at all and whether what comes back over the pipe is
 * read correctly. Both have already been the cause of a shipped bug.
 */

const WINDOWS_DATA = 'C:\\Users\\tester\\AppData\\Roaming\\Runova';
const POSIX_DATA = '/home/tester/.config/Runova';

describe('ptyHostPaths', () => {
  it('puts the runtime files under the given userData folder', async () => {
    const paths = await withPlatform('linux', () => ptyHostPaths(POSIX_DATA));
    expect(paths.runtimeDir).toBe(join(POSIX_DATA, 'pty-host'));
    expect(paths.tokenFile).toBe(join(POSIX_DATA, 'pty-host', 'token'));
    expect(paths.logFile).toBe(join(POSIX_DATA, 'pty-host', 'host.log'));
  });

  it('returns the same endpoint every time for one userData folder', async () => {
    // The app relaunches and has to reconnect to the host it left running, which only works
    // if the endpoint name is a pure function of the profile folder.
    const [first, second] = await withPlatform('win32', () => [
      ptyHostPaths(WINDOWS_DATA),
      ptyHostPaths(WINDOWS_DATA),
    ]);
    expect(first).toEqual(second);
  });

  it('gives two profiles different endpoints, so two installs never collide', async () => {
    const [first, second] = await withPlatform('win32', () => [
      ptyHostPaths(WINDOWS_DATA),
      ptyHostPaths(`${WINDOWS_DATA}-beta`),
    ]);
    expect(first.endpoint).not.toBe(second.endpoint);
  });

  it('uses a named pipe on Windows', async () => {
    const paths = await withPlatform('win32', () => ptyHostPaths(WINDOWS_DATA));
    expect(paths.endpoint).toMatch(/^\\\\\.\\pipe\\runova-pty-host-[0-9a-f]{12}$/);
  });

  it('uses a socket inside the runtime folder on posix', async () => {
    const paths = await withPlatform('darwin', () => ptyHostPaths(POSIX_DATA));
    expect(paths.endpoint).toBe(join(POSIX_DATA, 'pty-host', 'host.sock'));
  });

  it('falls back to the temp folder when the socket path would be too long', async () => {
    // Unix sockets are capped near 104 bytes, and "Application Support" plus a long user name
    // gets there. Past the cap the socket has to live somewhere short instead.
    const longData = join('/Users', 'a'.repeat(90), 'Library', 'Application Support', 'Runova');
    const paths = await withPlatform('darwin', () => ptyHostPaths(longData));
    expect(Buffer.byteLength(join(longData, 'pty-host', 'host.sock'))).toBeGreaterThanOrEqual(100);
    expect(paths.endpoint).toMatch(/runova-pty-[0-9a-f]{12}\.sock$/);
    expect(paths.endpoint.startsWith(tmpdir())).toBe(true);
    // The token and log still belong to the profile, only the socket moved.
    expect(paths.runtimeDir).toBe(join(longData, 'pty-host'));
  });

  it('keeps the same suffix in the fallback as in the pipe name', async () => {
    const longData = join('/Users', 'b'.repeat(90), 'Library', 'Application Support', 'Runova');
    const [socket, pipe] = await Promise.all([
      withPlatform('darwin', () => ptyHostPaths(longData)),
      withPlatform('win32', () => ptyHostPaths(longData)),
    ]);
    const suffix = /([0-9a-f]{12})/.exec(socket.endpoint)?.[1];
    expect(suffix).toBeDefined();
    expect(pipe.endpoint).toContain(suffix as string);
  });
});

describe('createLineReader', () => {
  function reader(): {
    write: (chunk: Buffer | string) => void;
    messages: unknown[];
    overflows: () => number;
  } {
    const messages: unknown[] = [];
    const onOverflow = vi.fn();
    const write = createLineReader((message) => messages.push(message), onOverflow);
    return { write, messages, overflows: () => onOverflow.mock.calls.length };
  }

  it('reads one whole line', () => {
    const { write, messages } = reader();
    write('{"kind":"response","id":1,"ok":true}\n');
    expect(messages).toEqual([{ kind: 'response', id: 1, ok: true }]);
  });

  it('reads several messages out of one chunk', () => {
    const { write, messages } = reader();
    write(`${encodeLine({ id: 1 })}${encodeLine({ id: 2 })}${encodeLine({ id: 3 })}`);
    expect(messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('waits for the rest of a message split across chunks', () => {
    const { write, messages } = reader();
    const line = encodeLine({ kind: 'event', event: 'data', sessionId: 's1', data: 'hello' });
    write(line.slice(0, 10));
    expect(messages).toEqual([]);
    write(line.slice(10, 25));
    expect(messages).toEqual([]);
    write(line.slice(25));
    expect(messages).toEqual([{ kind: 'event', event: 'data', sessionId: 's1', data: 'hello' }]);
  });

  it('holds a multi-byte character that straddles two chunks', () => {
    // The regression this guards: decoding each chunk on its own turned the split character
    // into replacement characters, which shifted the rest of the terminal line sideways.
    const { write, messages } = reader();
    const payload = 'ls \u65e5\u672c\u8a9e \u2500\u2500 \u{1f680} done';
    const line = Buffer.from(
      encodeLine({ kind: 'event', event: 'data', sessionId: 's1', data: payload }),
      'utf-8',
    );

    // Split right inside a continuation byte, which is where a pipe chunk really lands.
    const split = line.findIndex((byte) => byte >= 0x80 && byte < 0xc0);
    expect(split).toBeGreaterThan(0);
    write(line.subarray(0, split));
    write(line.subarray(split));

    const message = messages[0] as { data: string };
    expect(message.data).toBe(payload);
    expect(message.data).not.toContain('\ufffd');
  });

  it('holds a multi-byte character split one byte at a time', () => {
    const { write, messages } = reader();
    const payload = '\u{1f510}\u00e9\u4e2d';
    const line = Buffer.from(encodeLine({ data: payload }), 'utf-8');
    for (const byte of line) write(Buffer.from([byte]));
    expect(messages).toEqual([{ data: payload }]);
  });

  it('ignores blank and whitespace-only lines', () => {
    const { write, messages, overflows } = reader();
    write('\n\n   \n\t\n');
    write(encodeLine({ id: 7 }));
    expect(messages).toEqual([{ id: 7 }]);
    expect(overflows()).toBe(0);
  });

  it('drops a malformed line and keeps reading the next one', () => {
    // A host that logs to stdout, or a partial write after a crash, must not kill the pipe.
    const { write, messages } = reader();
    write('not json at all\n');
    write('{"broken":\n');
    write(encodeLine({ id: 9 }));
    expect(messages).toEqual([{ id: 9 }]);
  });

  it('tolerates carriage returns before the newline', () => {
    const { write, messages } = reader();
    write('{"id":4}\r\n');
    expect(messages).toEqual([{ id: 4 }]);
  });

  it('accepts a JSON scalar line, since the reader does not judge the shape', () => {
    const { write, messages } = reader();
    write('123\n"text"\nnull\n');
    expect(messages).toEqual([123, 'text', null]);
  });

  it('drops the buffer and reports overflow when one line never ends', () => {
    const { write, messages, overflows } = reader();
    write('x'.repeat(MAX_LINE_BYTES + 1));
    expect(overflows()).toBe(1);
    expect(messages).toEqual([]);

    // Whatever followed the dropped garbage still has to be read.
    write(encodeLine({ id: 11 }));
    expect(messages).toEqual([{ id: 11 }]);
    expect(overflows()).toBe(1);
  });

  it('does not report overflow for a long line that is still under the cap', () => {
    const { write, messages, overflows } = reader();
    const big = encodeLine({ data: 'y'.repeat(1024 * 1024) });
    write(big.slice(0, 500_000));
    expect(overflows()).toBe(0);
    write(big.slice(500_000));
    expect(overflows()).toBe(0);
    expect((messages[0] as { data: string }).data).toHaveLength(1024 * 1024);
  });
});

describe('encodeLine', () => {
  it('round-trips every message kind through the reader', () => {
    const sent: HostMessage[] = [
      { kind: 'response', id: 1, ok: true, result: { isNew: true, snapshot: null } },
      { kind: 'response', id: 2, ok: false, error: 'no such session' },
      { kind: 'event', event: 'data', sessionId: 's1', data: 'prompt$ \u2500\u2500\n' },
      { kind: 'event', event: 'exit', sessionId: 's1', exitCode: 130 },
    ];
    const messages: unknown[] = [];
    const write = createLineReader((message) => messages.push(message), vi.fn());
    write(Buffer.from(sent.map(encodeLine).join(''), 'utf-8'));
    expect(messages).toEqual(sent);
  });

  it('ends with exactly one newline, which is what frames a message', () => {
    const line = encodeLine({ type: 'hello', token: 't', protocolVersion: 1 });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
  });

  it('escapes an embedded newline so terminal output cannot forge a frame', () => {
    const messages: unknown[] = [];
    const write = createLineReader((message) => messages.push(message), vi.fn());
    write(encodeLine({ data: 'first\n{"kind":"forged"}\n' }));
    expect(messages).toEqual([{ data: 'first\n{"kind":"forged"}\n' }]);
  });
});

describe('protocol version', () => {
  it('is a whole number, since a host on another one is only told to shut down', () => {
    expect(Number.isInteger(PTY_HOST_PROTOCOL_VERSION)).toBe(true);
    expect(PTY_HOST_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
