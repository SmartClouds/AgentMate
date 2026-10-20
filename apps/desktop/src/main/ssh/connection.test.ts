import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { sshErrorCode } from '../../shared/sshErrors';
import type { SftpFileClient } from '../sftp/client';
import type { SshEndpoint } from './connectConfig';
import { SshConnection, TunnelRefusedError } from './connection';
import { type FakeSftpOptions, fakeSftp, useSftp } from './testing/fakeSftpSession';
import {
  echoStream,
  type FakeSshServer,
  type FakeSshServerOptions,
  type ForwardTarget,
  startFakeSshServer,
} from './testing/fakeSshServer';

/**
 * The non-interactive SSH connection the Deploy section runs on: commands with real exit codes,
 * stdin for secrets, and tunnels to the server core's socket.
 */

const PASSWORD = 'correct horse battery staple';

let server: FakeSshServer | null = null;
let connection: SshConnection | null = null;

afterEach(async () => {
  connection?.close();
  connection = null;
  await server?.close();
  server = null;
});

async function connect(
  options: FakeSshServerOptions = {},
  endpoint: Partial<SshEndpoint> = {},
  hooks: Parameters<typeof SshConnection.open>[1] = {},
): Promise<{ server: FakeSshServer; connection: SshConnection }> {
  server = await startFakeSshServer({ password: PASSWORD, ...options });
  connection = await SshConnection.open(
    {
      host: server.host,
      port: server.port,
      username: 'deploy',
      authMethod: 'password',
      password: PASSWORD,
      ...endpoint,
    },
    hooks,
  );
  return { server, connection };
}

function readAll(stream: NodeJS.ReadableStream, length: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= length) resolve(Buffer.concat(chunks));
    });
  });
}

describe('SshConnection.exec', () => {
  it('returns stdout and stderr separately with the exit code', async () => {
    const { connection } = await connect({
      exec: () => ({ stdout: 'installed\n', stderr: 'warning: slow mirror\n', exitCode: 3 }),
    });

    const result = await connection.exec('apt-get install -y curl');

    expect(result).toEqual({
      stdout: 'installed\n',
      stderr: 'warning: slow mirror\n',
      exitCode: 3,
      signal: null,
      timedOut: false,
    });
  });

  it('sends stdin byte for byte and then closes it', async () => {
    const payload = Buffer.from([0, 1, 2, 255, 10, 13, 42]);
    const { connection, server } = await connect();

    await connection.exec('cat > /dev/null', { stdin: payload });

    expect(server.execRequests[0].stdin.equals(payload)).toBe(true);
  });

  it('closes stdin right away when there is nothing to send', async () => {
    const { connection, server } = await connect();

    const result = await connection.exec('true');

    expect(result.exitCode).toBe(0);
    expect(server.execRequests).toEqual([{ command: 'true', stdin: Buffer.alloc(0) }]);
  });

  it('gives up on a command that outlives its timeout', async () => {
    const { connection } = await connect({ exec: () => new Promise(() => undefined) });

    const result = await connection.exec('sleep 999', { timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('counts the wait for the server to take the command against the timeout', async () => {
    const { connection } = await connect({ neverAnswer: 'commands' });

    const result = await connection.exec('true', { timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('stops collecting output past the cap and says so', async () => {
    const { connection } = await connect({ exec: () => ({ stdout: 'x'.repeat(5000) }) });

    const result = await connection.exec('yes', { maxOutputBytes: 1000 });

    expect(result.stdout.length).toBeLessThan(1100);
    expect(result.stdout).toContain('[output truncated]');
  });

  it('keeps the exit code of a command that finishes in the same packet burst it started in', async () => {
    // The exec reply, the output and the exit status arrive together, so ssh2 reports the exit
    // before the caller could have attached a listener for it.
    const { connection } = await connect({
      interactiveExec: (_command, channel) => {
        channel.write('out\n');
        channel.stderr.write('err\n');
        channel.exit(7);
        channel.end();
        return true;
      },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await connection.exec('sh -c "exit 7"');

      expect(result).toMatchObject({ stdout: 'out\n', stderr: 'err\n', exitCode: 7 });
    }
  });

  it('streams output to callbacks as it arrives', async () => {
    const { connection } = await connect({
      exec: () => ({ stdout: 'step 1\nstep 2\n', exitCode: 0 }),
    });
    const lines: string[] = [];

    await connection.exec('install', { onStdout: (text) => lines.push(text) });

    expect(lines.join('')).toBe('step 1\nstep 2\n');
  });
});

describe('SshConnection.openStream', () => {
  it('tunnels to a Unix socket on the server', async () => {
    const targets: ForwardTarget[] = [];
    const { connection } = await connect({
      forward: (target) => {
        targets.push(target);
        return echoStream();
      },
    });

    const stream = await connection.openStream({ socketPath: '/run/agentmate-core/core.sock' });
    const echoed = readAll(stream, 5);
    stream.write('hello');

    expect((await echoed).toString()).toBe('hello');
    expect(targets).toEqual([{ kind: 'unix', path: '/run/agentmate-core/core.sock' }]);
    stream.destroy();
  });

  it('tunnels to a TCP port on the server', async () => {
    const targets: ForwardTarget[] = [];
    const { connection } = await connect({
      forward: (target) => {
        targets.push(target);
        return echoStream();
      },
    });

    const stream = await connection.openStream({ host: '127.0.0.1', port: 7810 });
    const echoed = readAll(stream, 4);
    stream.write('ping');

    expect((await echoed).toString()).toBe('ping');
    expect(targets).toEqual([{ kind: 'tcp', host: '127.0.0.1', port: 7810 }]);
    stream.destroy();
  });

  it('gives up on a tunnel the server never answers, without reading it as a refusal', async () => {
    const { connection } = await connect({ neverAnswer: 'tunnels' });

    const failure = await connection
      .openStream({ socketPath: '/run/agentmate-core/core.sock' }, { timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TunnelRefusedError);
    expect(String(failure)).toMatch(/did not open within/);
  });

  it('explains a tunnel the server refused', async () => {
    const { connection } = await connect({ forward: () => null });

    await expect(
      connection.openStream({ socketPath: '/run/agentmate-core/core.sock' }),
    ).rejects.toThrow(/could not open a tunnel to \/run\/agentmate-core\/core\.sock/i);
  });
});

describe('SshConnection.openStream refusals', () => {
  it('marks a tunnel that sshd refuses by policy', async () => {
    const { connection } = await connect({ forwarding: 'prohibited' });

    const failure = await connection
      .openStream({ socketPath: '/run/x.sock' })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(TunnelRefusedError);
    expect((failure as TunnelRefusedError).prohibited).toBe(true);
  });

  it('tells a refusal by policy apart from nothing listening at the target', async () => {
    const { connection } = await connect({ forward: () => null });

    const failure = await connection
      .openStream({ socketPath: '/run/x.sock' })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(TunnelRefusedError);
    expect((failure as TunnelRefusedError).prohibited).toBe(false);
  });
});

describe('SshConnection.openExecStream', () => {
  it('opens a two-way stream to a long-running command', async () => {
    const commands: string[] = [];
    const { connection } = await connect({
      interactiveExec: (command, channel) => {
        commands.push(command);
        channel.pipe(channel);
        return true;
      },
    });

    const stream = await connection.openExecStream('agentmate-core bridge');
    const echoed = readAll(stream, 5);
    stream.write('hello');

    expect((await echoed).toString()).toBe('hello');
    expect(commands).toEqual(['agentmate-core bridge']);
    stream.destroy();
  });

  it('gives up on a command stream the server never starts', async () => {
    const { connection } = await connect({ neverAnswer: 'commands' });

    await expect(
      connection.openExecStream('agentmate-core bridge', { timeoutMs: 100 }),
    ).rejects.toThrow(/did not start within/);
  });

  it('refuses work after the connection closed', async () => {
    const { connection } = await connect();
    connection.close();

    await expect(connection.openExecStream('agentmate-core bridge')).rejects.toThrow(/closed/);
  });
});

describe('SshConnection.createStagingDirectory', () => {
  it('returns the folder mktemp made', async () => {
    const { connection } = await connect({
      exec: ({ command }) => ({
        stdout: command.startsWith('mktemp -d') ? '/tmp/agentmate.Ab12Cd34Ef\n' : '',
      }),
    });

    expect(await connection.createStagingDirectory()).toBe('/tmp/agentmate.Ab12Cd34Ef');
  });

  it('refuses an answer that is not a fresh agentmate folder, since it gets removed later', async () => {
    for (const answer of ['/\n', '/tmp\n', 'agentmate.Ab12Cd34Ef\n', '/tmp/agentmate.x y\n']) {
      const { connection } = await connect({ exec: () => ({ stdout: answer }) });

      await expect(connection.createStagingDirectory()).rejects.toThrow(/staging folder/);
      connection.close();
      await server?.close();
    }
  });
});

describe('SshConnection lifecycle', () => {
  it('reports a first-use host key so it can be stored', async () => {
    const onHostKeyTrusted = vi.fn();
    const { server } = await connect({}, {}, { onHostKeyTrusted });

    expect(onHostKeyTrusted).toHaveBeenCalledWith(server.fingerprint());
  });

  it('refuses a changed host key with the coded error', async () => {
    server = await startFakeSshServer({ password: PASSWORD });
    const stored = server.fingerprint();
    await server.rotateHostKey();

    const failure = SshConnection.open({
      host: server.host,
      port: server.port,
      username: 'deploy',
      authMethod: 'password',
      password: PASSWORD,
      storedFingerprint: stored,
    });

    await expect(failure).rejects.toSatisfy((error) => sshErrorCode(error) === 'host-key-changed');
  });

  it('notices when the server goes away', async () => {
    const onClose = vi.fn();
    const { server, connection } = await connect({}, {}, { onClose });

    await server.close();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(connection.isOpen).toBe(false);
  });

  it('refuses work after it was closed', async () => {
    const { connection } = await connect();
    connection.close();

    await expect(connection.exec('true')).rejects.toThrow(/closed/);
  });
});

describe('SshConnection.open against something that is not an SSH server', () => {
  /** Accepts connections and ends them the way `end` says, before any SSH banner is sent. */
  async function listenAndDrop(
    end: 'reset' | 'close',
  ): Promise<{ port: number; stop: () => void }> {
    const sockets = new Set<Socket>();
    const dropper = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      if (end === 'reset') socket.resetAndDestroy();
      else socket.destroy();
    });
    await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', resolve));
    return {
      port: (dropper.address() as AddressInfo).port,
      stop: () => {
        for (const socket of sockets) socket.destroy();
        dropper.close();
      },
    };
  }

  it.each(['reset', 'close'] as const)(
    'rejects with a readable error when the connection is %s before the handshake',
    async (end) => {
      const { port, stop } = await listenAndDrop(end);
      try {
        const failure = SshConnection.open({
          host: '127.0.0.1',
          port,
          username: 'deploy',
          authMethod: 'password',
          password: PASSWORD,
        });

        await expect(failure).rejects.toThrow(
          /^The connection to 127\.0\.0\.1:\d+ was closed by the other end while connecting/,
        );
        // ssh2 can emit a second 'error' on close; nothing may be left to throw it uncaught.
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        stop();
      }
    },
  );
});

describe('SshConnection.sftpList', () => {
  it('lists folders and files with their size and mtime in milliseconds', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp({
      '/srv': { kind: 'dir' },
      '/srv/app': { kind: 'dir', mtime: 50 },
      '/srv/a.jsonl': { kind: 'file', content: 'hello', mtime: 1_700_000_000 },
    });
    useSftp(connection, session);

    const entries = await connection.sftpList('/srv');

    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'a.jsonl', isDirectory: false, isFile: true, size: 5, mtimeMs: 1_700_000_000_000 },
      { name: 'app', isDirectory: true, isFile: false, size: 4096, mtimeMs: 50_000 },
    ]);
  });

  it('counts a link as what it points at and skips a dangling one', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp({
      '/srv': { kind: 'dir' },
      '/data/real.jsonl': { kind: 'file', content: 'abc', mtime: 7 },
      '/srv/linked.jsonl': { kind: 'link', target: '/data/real.jsonl' },
      '/srv/broken.jsonl': { kind: 'link', target: '/data/gone.jsonl' },
    });
    useSftp(connection, session);

    const entries = await connection.sftpList('/srv');

    expect(entries).toEqual([
      { name: 'linked.jsonl', isDirectory: false, isFile: true, size: 3, mtimeMs: 7000 },
    ]);
  });

  it('rejects for a folder that is not there', async () => {
    const { connection } = await connect();
    useSftp(connection, fakeSftp({}).session);

    await expect(connection.sftpList('/nope')).rejects.toThrow(/No such file/);
  });

  it('gives up on a server that never answers', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp({ '/srv': { kind: 'dir' } }, { hang: new Set(['readdir']) });
    useSftp(connection, session);

    await expect(connection.sftpList('/srv', { timeoutMs: 50 })).rejects.toThrow(/did not answer/);
  });

  it('starts SFTP again after a failed start', async () => {
    const { connection } = await connect();
    const spy = useSftp(connection, fakeSftp({ '/srv': { kind: 'dir' } }).session, 1);

    await expect(connection.sftpList('/srv')).rejects.toThrow(/subsystem/);
    await expect(connection.sftpList('/srv')).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('SshConnection.sftpListDetailed', () => {
  const INDEX_LINE = '-rw-r-----    1 deploy   www-data        5 Nov 14  2023 index.html';

  it('lists entries with their permission bits and the line the server sent', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp({
      '/srv': { kind: 'dir' },
      '/srv/site': { kind: 'dir', mode: 0o2750, mtime: 50 },
      '/srv/index.html': {
        kind: 'file',
        content: 'hello',
        mode: 0o640,
        mtime: 1_700_000_000,
        longname: INDEX_LINE,
      },
    });
    useSftp(connection, session);

    const entries = await connection.sftpListDetailed('/srv');

    expect(entries.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: 'index.html',
        isDirectory: false,
        isFile: true,
        size: 5,
        mtimeMs: 1_700_000_000_000,
        isSymlink: false,
        brokenLink: false,
        mode: 0o640,
        longname: INDEX_LINE,
      },
      {
        name: 'site',
        isDirectory: true,
        isFile: false,
        size: 4096,
        mtimeMs: 50_000,
        isSymlink: false,
        brokenLink: false,
        mode: 0o2750,
        longname: expect.stringMatching(/^d.* site$/),
      },
    ]);
  });

  it('counts a working link as its target and keeps a broken one, marked', async () => {
    const { connection } = await connect();
    const fake = fakeSftp({
      '/data': { kind: 'dir', mode: 0o750, mtime: 4 },
      '/data/real.txt': { kind: 'file', content: 'abc', mode: 0o600, mtime: 7 },
      '/srv': { kind: 'dir' },
      '/srv/to-dir': { kind: 'link', target: '/data' },
      '/srv/to-file': { kind: 'link', target: '/data/real.txt' },
      '/srv/gone': { kind: 'link', target: '/data/nowhere', mtime: 3 },
    });
    useSftp(connection, fake.session);

    const entries = await connection.sftpListDetailed('/srv/');
    const byName = (name: string) => entries.find((entry) => entry.name === name);

    expect(byName('to-dir')).toMatchObject({
      isDirectory: true,
      isFile: false,
      isSymlink: true,
      brokenLink: false,
      mode: 0o750,
      mtimeMs: 4000,
    });
    expect(byName('to-file')).toMatchObject({
      isDirectory: false,
      isFile: true,
      isSymlink: true,
      brokenLink: false,
      size: 3,
      mtimeMs: 7000,
      mode: 0o600,
    });
    expect(byName('gone')).toEqual({
      name: 'gone',
      isDirectory: false,
      isFile: false,
      isSymlink: true,
      brokenLink: true,
      size: '/data/nowhere'.length,
      mtimeMs: 3000,
      mode: 0o777,
      longname: expect.stringMatching(/^lrwxrwxrwx.* gone$/),
    });
    expect(fake.ops).toContain('stat /srv/to-dir');
    expect(fake.ops).not.toContain('stat /srv//to-dir');
  });

  it('rejects for a folder that is not there, with the SFTP status', async () => {
    const { connection } = await connect();
    useSftp(connection, fakeSftp({}).session);

    await expect(connection.sftpListDetailed('/nope')).rejects.toMatchObject({ code: 2 });
  });

  it('gives up on a server that never answers', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp({ '/srv': { kind: 'dir' } }, { hang: new Set(['readdir']) });
    useSftp(connection, session);

    await expect(connection.sftpListDetailed('/srv', { timeoutMs: 50 })).rejects.toThrow(
      /Listing \/srv .*did not answer/,
    );
  });

  it('counts a link whose target never answers against the same deadline', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp(
      { '/srv': { kind: 'dir' }, '/srv/l': { kind: 'link', target: '/srv' } },
      { hang: new Set(['stat']) },
    );
    useSftp(connection, session);

    await expect(connection.sftpListDetailed('/srv', { timeoutMs: 50 })).rejects.toThrow(
      /did not answer/,
    );
  });
});

describe('SshConnection.sftpReadRange', () => {
  it('reads the range across short reads', async () => {
    const { connection } = await connect();
    const { session, closed } = fakeSftp(
      { '/f.txt': { kind: 'file', content: 'hello wonderful world' } },
      { maxRead: 3 },
    );
    useSftp(connection, session);

    const bytes = await connection.sftpReadRange('/f.txt', 6, 9);

    expect(bytes.toString()).toBe('wonderful');
    expect(closed).toEqual(['h0']);
  });

  it('stops at the end of a file that is shorter than asked', async () => {
    const { connection } = await connect();
    useSftp(connection, fakeSftp({ '/f.txt': { kind: 'file', content: 'short' } }).session);

    const bytes = await connection.sftpReadRange('/f.txt', 2, 1000);

    expect(bytes.toString()).toBe('ort');
  });

  it('closes the file when a read fails', async () => {
    const { connection } = await connect();
    const { session, closed } = fakeSftp(
      { '/f.txt': { kind: 'file', content: 'data' } },
      { failRead: true },
    );
    useSftp(connection, session);

    await expect(connection.sftpReadRange('/f.txt', 0, 4)).rejects.toThrow(/Failure/);
    expect(closed).toEqual(['h0']);
  });

  it('gives up on a read that never comes back', async () => {
    const { connection } = await connect();
    const { session } = fakeSftp(
      { '/f.txt': { kind: 'file', content: 'data' } },
      { hang: new Set(['read']) },
    );
    useSftp(connection, session);

    await expect(connection.sftpReadRange('/f.txt', 0, 4, { timeoutMs: 50 })).rejects.toThrow(
      /did not answer/,
    );
  });
});

describe('SshConnection.sftpRealpath', () => {
  it('resolves a path on the server', async () => {
    const { connection } = await connect();
    useSftp(connection, fakeSftp({}).session);

    await expect(connection.sftpRealpath('.')).resolves.toBe('/home/deploy');
  });
});

/**
 * A stand-in SFTP session that can be written to, for the file operations E23's SFTP sites run
 * on. It answers the way ssh2 does: errors carry the SFTP status as a number in `code`, and the
 * OpenSSH extensions throw at once when the server did not advertise them.
 */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

interface WritableNode {
  kind: 'file' | 'dir';
  data: Buffer;
  mode: number;
  mtime: number;
}

interface WritableSftpOptions {
  /** Default: posix-rename and fsync, like OpenSSH. */
  extensions?: string[];
  /** Requests of these kinds are never answered. */
  hang?: ReadonlySet<string>;
  /** Requests of these kinds fail with permission denied. */
  deny?: ReadonlySet<string>;
  /** Called on every write request before it is answered. */
  onWrite?: () => void;
  /** Called on every request, with its kind, before it is answered. */
  onRequest?: (kind: string) => void;
  /** How long a write takes to be answered, like a link with some latency. */
  writeDelayMs?: number;
  /** A plain rename this says yes to fails with Failure, whatever the names. */
  refuseRename?: (from: string, to: string) => boolean;
}

type Done = (error?: Error) => void;

function sftpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function writableSftp(options: WritableSftpOptions = {}) {
  const nodes = new Map<string, WritableNode>([
    ['/', { kind: 'dir', data: Buffer.alloc(0), mode: 0o755, mtime: 1 }],
  ]);
  const handles = new Map<string, string>();
  const ops: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const extensions = options.extensions ?? ['posix-rename@openssh.com', 'fsync@openssh.com'];
  const extended = (name: string): void => {
    if (!extensions.includes(name)) {
      throw new Error('Server does not support this extended request');
    }
  };
  const parent = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/';
  const answer = (kind: string, path: string, cb: Done, reply: () => void): void => {
    ops.push(`${kind} ${path}`);
    options.onRequest?.(kind);
    if (options.hang?.has(kind)) return;
    const respond = (): void => {
      if (options.deny?.has(kind)) cb(sftpError(PERMISSION_DENIED, 'Permission denied'));
      else reply();
    };
    if (kind === 'write' && options.writeDelayMs) setTimeout(respond, options.writeDelayMs);
    else setImmediate(respond);
  };
  const attrs = (node: WritableNode) => ({
    mode: (node.kind === 'dir' ? 0o040000 : 0o100000) | node.mode,
    size: node.data.length,
    mtime: node.mtime,
    isDirectory: () => node.kind === 'dir',
    isFile: () => node.kind === 'file',
    isSymbolicLink: () => false,
  });
  const move = (from: string, to: string, cb: Done): void => {
    const node = nodes.get(from);
    if (!node) return cb(sftpError(NO_SUCH_FILE, 'No such file'));
    nodes.delete(from);
    nodes.set(to, node);
    cb();
  };
  const session = {
    _extensions: Object.fromEntries(extensions.map((name) => [name, '1'])),
    stat: (path: string, cb: (error?: Error, value?: unknown) => void) =>
      answer('stat', path, cb, () => {
        const node = nodes.get(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        cb(undefined, attrs(node));
      }),
    mkdir: (path: string, attributes: { mode?: number }, cb: Done) =>
      answer('mkdir', path, cb, () => {
        if (nodes.has(path)) return cb(sftpError(FAILURE, 'Failure'));
        if (nodes.get(parent(path))?.kind !== 'dir') {
          return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        }
        nodes.set(path, {
          kind: 'dir',
          data: Buffer.alloc(0),
          mode: attributes.mode ?? 0o755,
          mtime: 9,
        });
        cb();
      }),
    rmdir: (path: string, cb: Done) =>
      answer('rmdir', path, cb, () => {
        if (nodes.get(path)?.kind !== 'dir') return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        if ([...nodes.keys()].some((key) => key.startsWith(`${path}/`))) {
          return cb(sftpError(FAILURE, 'Failure'));
        }
        nodes.delete(path);
        cb();
      }),
    unlink: (path: string, cb: Done) =>
      answer('unlink', path, cb, () => {
        if (nodes.get(path)?.kind !== 'file') return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        nodes.delete(path);
        cb();
      }),
    chmod: (path: string, mode: number, cb: Done) =>
      answer('chmod', path, cb, () => {
        const node = nodes.get(path);
        if (!node) return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        node.mode = mode;
        cb();
      }),
    rename: (from: string, to: string, cb: Done) =>
      answer('rename', `${from} -> ${to}`, cb, () => {
        // SFTP version 3 refuses to rename onto an existing name.
        if (nodes.has(to) || options.refuseRename?.(from, to)) {
          return cb(sftpError(FAILURE, 'Failure'));
        }
        move(from, to, cb);
      }),
    ext_openssh_rename: (from: string, to: string, cb: Done) => {
      extended('posix-rename@openssh.com');
      answer('posix-rename', `${from} -> ${to}`, cb, () => move(from, to, cb));
    },
    open: (
      path: string,
      _flags: string,
      attributes: { mode?: number },
      cb: (error?: Error, handle?: Buffer) => void,
    ) =>
      answer('open', path, cb, () => {
        if (nodes.get(parent(path))?.kind !== 'dir') {
          return cb(sftpError(NO_SUCH_FILE, 'No such file'));
        }
        // A umask of 077 on the server, so only an explicit chmod gives 0644.
        nodes.set(path, {
          kind: 'file',
          data: Buffer.alloc(0),
          mode: (attributes.mode ?? 0o644) & 0o700,
          mtime: 1_700_000_123,
        });
        const handle = `w${handles.size}`;
        handles.set(handle, path);
        cb(undefined, Buffer.from(handle));
      }),
    write: (
      handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: Done,
    ) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      options.onWrite?.();
      const path = handles.get(handle.toString()) ?? '';
      answer('write', path, cb, () => {
        inFlight -= 1;
        const node = nodes.get(path);
        if (!node) return cb(sftpError(FAILURE, 'Failure'));
        const data = Buffer.alloc(Math.max(node.data.length, position + length));
        node.data.copy(data);
        buffer.copy(data, position, offset, offset + length);
        node.data = data;
        cb();
      });
    },
    ext_openssh_fsync: (handle: Buffer, cb: Done) => {
      extended('fsync@openssh.com');
      answer('fsync', handles.get(handle.toString()) ?? '', cb, () => cb());
    },
    close: (handle: Buffer, cb: Done) =>
      answer('close', handles.get(handle.toString()) ?? '', cb, () => cb()),
  };
  return {
    session,
    nodes,
    ops,
    maxInFlight: () => maxInFlight,
    file: (path: string, content: string, mode = 0o644) =>
      nodes.set(path, { kind: 'file', data: Buffer.from(content), mode, mtime: 5 }),
    dir: (path: string) =>
      nodes.set(path, { kind: 'dir', data: Buffer.alloc(0), mode: 0o755, mtime: 5 }),
    text: (path: string) => nodes.get(path)?.data.toString('utf8') ?? null,
    parts: () => [...nodes.keys()].filter((key) => key.endsWith('.part')),
    backups: () => [...nodes.keys()].filter((key) => key.endsWith('.old')),
  };
}

describe('SshConnection SFTP file operations', () => {
  it('makes, stats and removes folders and files', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    fake.file('/srv/a.txt', 'hello', 0o640);
    useSftp(connection, fake.session);

    await connection.sftpMkdir('/srv/site');
    await connection.sftpChmod('/srv/a.txt', 0o600);
    await connection.sftpRename('/srv/a.txt', '/srv/b.txt');

    expect(await connection.sftpStat('/srv/site')).toMatchObject({
      isDirectory: true,
      isFile: false,
      mode: 0o755,
    });
    expect(await connection.sftpStat('/srv/b.txt')).toEqual({
      isDirectory: false,
      isFile: true,
      size: 5,
      mtimeMs: 5000,
      mode: 0o600,
    });
    expect(await connection.sftpStat('/srv/a.txt')).toBeNull();

    await connection.sftpUnlink('/srv/b.txt');
    await connection.sftpRmdir('/srv/site');
    expect([...fake.nodes.keys()]).toEqual(['/', '/srv']);
  });

  it('passes on stat failures other than a missing file', async () => {
    const { connection } = await connect();
    useSftp(connection, writableSftp({ deny: new Set(['stat']) }).session);

    await expect(connection.sftpStat('/root')).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it('gives each operation its own deadline', async () => {
    const { connection } = await connect();
    useSftp(connection, writableSftp({ hang: new Set(['mkdir']) }).session);

    await expect(connection.sftpMkdir('/srv/x', { timeoutMs: 50 })).rejects.toThrow(
      /did not answer/,
    );
  });

  it('says which extensions the server advertised', async () => {
    const { connection } = await connect();
    useSftp(connection, writableSftp({ extensions: ['fsync@openssh.com'] }).session);

    expect(await connection.sftpSupports('fsync@openssh.com')).toBe(true);
    expect(await connection.sftpSupports('posix-rename@openssh.com')).toBe(false);
  });
});

describe('SshConnection.uploadFile', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'agentmate-upload-file-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function local(content: string | Buffer) {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    const path = join(scratch, `f-${randomBytes(4).toString('hex')}`);
    await writeFile(path, bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  }

  it('streams a new file through a part file and makes it readable by the web server', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('<h1>hello</h1>');

    const result = await connection.uploadFile(file.path, '/srv/index.html', {
      expectedSha256: file.sha256,
    });

    expect(fake.text('/srv/index.html')).toBe('<h1>hello</h1>');
    expect(result).toEqual({
      stat: {
        isDirectory: false,
        isFile: true,
        size: 14,
        mtimeMs: 1_700_000_123_000,
        mode: 0o644,
      },
      atomic: true,
      replaced: false,
      sha256: file.sha256,
    });
    expect(fake.parts()).toEqual([]);
    const opened = fake.ops.find((op) => op.startsWith('open '));
    expect(opened).toMatch(/^open \/srv\/index\.html\.agentmate-[0-9a-f]{8}\.part$/);
    expect(fake.ops).toContain(`fsync ${opened?.slice(5)}`);
    expect(fake.ops.some((op) => op.startsWith('posix-rename '))).toBe(true);
  });

  it('keeps the mode of the file it replaces, or the one asked for', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    fake.file('/srv/config.php', 'old', 0o600);
    useSftp(connection, fake.session);
    const file = await local('new');

    await connection.uploadFile(file.path, '/srv/config.php', { expectedSha256: file.sha256 });
    expect(fake.nodes.get('/srv/config.php')?.mode).toBe(0o600);
    expect(fake.text('/srv/config.php')).toBe('new');

    await connection.uploadFile(file.path, '/srv/run.sh', {
      expectedSha256: file.sha256,
      mode: 0o755,
    });
    expect(fake.nodes.get('/srv/run.sh')?.mode).toBe(0o755);
  });

  it('keeps up to 16 writes in flight and reports progress', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ writeDelayMs: 20 });
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local(randomBytes(1_100_000));
    const progress: number[] = [];

    await connection.uploadFile(file.path, '/srv/big.bin', {
      expectedSha256: file.sha256,
      onProgress: (sent) => progress.push(sent),
    });

    expect(fake.nodes.get('/srv/big.bin')?.data.equals(file.bytes)).toBe(true);
    expect(fake.maxInFlight()).toBeGreaterThan(1);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(16);
    expect(progress.at(-1)).toBe(1_100_000);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('sends an empty file', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('');

    const result = await connection.uploadFile(file.path, '/srv/.keep', {
      expectedSha256: file.sha256,
    });

    expect(result.stat.size).toBe(0);
    expect(fake.text('/srv/.keep')).toBe('');
  });

  it('sends a file without an expected hash and reports the one it computed', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    fake.file('/srv/notes.txt', 'old');
    useSftp(connection, fake.session);
    const file = await local('edited in the file manager');

    const result = await connection.uploadFile(file.path, '/srv/notes.txt');

    expect(result).toMatchObject({ replaced: true, atomic: true, sha256: file.sha256 });
    expect(fake.text('/srv/notes.txt')).toBe('edited in the file manager');
    expect(fake.parts()).toEqual([]);
  });

  it('refuses to put bytes in place that do not match the plan', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    fake.file('/srv/app.js', 'old');
    useSftp(connection, fake.session);
    const file = await local('edited since');

    const failure = await connection
      .uploadFile(file.path, '/srv/app.js', { expectedSha256: '0'.repeat(64) })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('localChanged');
    expect(fake.text('/srv/app.js')).toBe('old');
    expect(fake.parts()).toEqual([]);
  });

  it('replaces a file by moving it aside first on a server without posix-rename', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ extensions: [] });
    fake.dir('/srv');
    fake.file('/srv/a.css', 'old');
    useSftp(connection, fake.session);
    const file = await local('body{}');

    const replaced = await connection.uploadFile(file.path, '/srv/a.css', {
      expectedSha256: file.sha256,
    });
    const created = await connection.uploadFile(file.path, '/srv/b.css', {
      expectedSha256: file.sha256,
    });

    expect(replaced).toMatchObject({ atomic: false, replaced: true });
    expect(created).toMatchObject({ atomic: true, replaced: false });
    expect(fake.text('/srv/a.css')).toBe('body{}');
    expect(fake.text('/srv/b.css')).toBe('body{}');
    expect(fake.ops.some((op) => op.startsWith('fsync'))).toBe(false);
    expect(fake.ops).not.toContain('unlink /srv/a.css');
    expect(
      fake.ops.some((op) =>
        /^rename \/srv\/a\.css -> \/srv\/a\.css\.agentmate-[0-9a-f]{8}\.old$/.test(op),
      ),
    ).toBe(true);
    expect(fake.parts()).toEqual([]);
    expect(fake.backups()).toEqual([]);
  });

  it('puts the old file back when the new one cannot take its name after it was moved aside', async () => {
    const { connection } = await connect();
    const fake = writableSftp({
      extensions: [],
      // The part's second try, once the old file is out of the way.
      refuseRename: (from, to) => from.endsWith('.part') && !fake.nodes.has(to),
    });
    fake.dir('/srv');
    fake.file('/srv/a.css', 'old');
    useSftp(connection, fake.session);
    const file = await local('body{}');

    await expect(
      connection.uploadFile(file.path, '/srv/a.css', { expectedSha256: file.sha256 }),
    ).rejects.toThrow();

    expect(fake.text('/srv/a.css')).toBe('old');
    expect(fake.parts()).toEqual([]);
    expect(fake.backups()).toEqual([]);
  });

  it('never removes the new file while the old one is moved aside and cannot be put back', async () => {
    const { connection } = await connect();
    const fake = writableSftp({
      extensions: [],
      refuseRename: (from, to) =>
        (from.endsWith('.part') && !fake.nodes.has(to)) || from.endsWith('.old'),
    });
    fake.dir('/srv');
    fake.file('/srv/a.css', 'old');
    useSftp(connection, fake.session);
    const file = await local('body{}');

    await expect(
      connection.uploadFile(file.path, '/srv/a.css', { expectedSha256: file.sha256 }),
    ).rejects.toThrow();

    expect(fake.text('/srv/a.css')).toBeNull();
    expect(fake.backups().map((path) => fake.text(path))).toEqual(['old']);
    expect(fake.parts().map((path) => fake.text(path))).toEqual(['body{}']);
  });

  it('passes on a rename the server refuses for another reason', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ extensions: [], deny: new Set(['rename']) });
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('x');

    await expect(
      connection.uploadFile(file.path, '/srv/x', { expectedSha256: file.sha256 }),
    ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    expect(fake.parts()).toEqual([]);
    expect(fake.text('/srv/x')).toBeNull();
  });

  it('removes the part file and keeps the old one when cancelled', async () => {
    const { connection } = await connect();
    const controller = new AbortController();
    const fake = writableSftp({ onWrite: () => controller.abort() });
    fake.dir('/srv');
    fake.file('/srv/bundle.js', 'old');
    useSftp(connection, fake.session);
    const file = await local(randomBytes(500_000));

    const failure = await connection
      .uploadFile(file.path, '/srv/bundle.js', {
        expectedSha256: file.sha256,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    await vi.waitFor(() => expect(fake.parts()).toEqual([]));
    expect(fake.text('/srv/bundle.js')).toBe('old');
  });

  it('finishes and reports an upload whose rename was already sent when cancelled', async () => {
    const { connection } = await connect();
    const controller = new AbortController();
    const fake = writableSftp({
      onRequest: (kind) => {
        if (kind === 'posix-rename') controller.abort();
      },
    });
    fake.dir('/srv');
    fake.file('/srv/bundle.js', 'old');
    useSftp(connection, fake.session);
    const file = await local(Buffer.from('new contents'));

    const result = await connection.uploadFile(file.path, '/srv/bundle.js', {
      expectedSha256: file.sha256,
      signal: controller.signal,
    });

    expect(result.stat.size).toBe(12);
    expect(fake.text('/srv/bundle.js')).toBe('new contents');
    expect(fake.parts()).toEqual([]);
  });

  it('stops before the rename when cancelled after the bytes are written', async () => {
    const { connection } = await connect();
    const controller = new AbortController();
    const fake = writableSftp({
      onRequest: (kind) => {
        if (kind === 'chmod') controller.abort();
      },
    });
    fake.dir('/srv');
    fake.file('/srv/bundle.js', 'old');
    useSftp(connection, fake.session);
    const file = await local(Buffer.from('new contents'));

    const failure = await connection
      .uploadFile(file.path, '/srv/bundle.js', {
        expectedSha256: file.sha256,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    await vi.waitFor(() => expect(fake.parts()).toEqual([]));
    expect(fake.text('/srv/bundle.js')).toBe('old');
  });

  it('refuses to start when already cancelled', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('x');

    const failure = await connection
      .uploadFile(file.path, '/srv/x', {
        expectedSha256: file.sha256,
        signal: AbortSignal.abort(),
      })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    expect(fake.ops).toEqual([]);
  });

  it('gives up on a write that stalls, without a deadline for the whole upload', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ hang: new Set(['write']) });
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('stuck');

    const failure = await connection
      .uploadFile(file.path, '/srv/x', { expectedSha256: file.sha256, stallTimeoutMs: 50 })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('timeout');
    expect(String(failure)).toMatch(/stopped answering/);
    await vi.waitFor(() => expect(fake.parts()).toEqual([]));
  });

  it('fails a local file that cannot be read and cleans up', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/srv');
    useSftp(connection, fake.session);

    await expect(
      connection.uploadFile(join(scratch, 'missing'), '/srv/x', { expectedSha256: 'x' }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.waitFor(() => expect(fake.parts()).toEqual([]));
  });

  it('fails when the connection ends mid-upload', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ hang: new Set(['write']), onWrite: () => connection.close() });
    fake.dir('/srv');
    useSftp(connection, fake.session);
    const file = await local('x');

    await expect(
      connection.uploadFile(file.path, '/srv/x', { expectedSha256: file.sha256 }),
    ).rejects.toThrow(/closed/);
  });
});

describe('SshConnection.upload', () => {
  it('writes a buffer as 0600 through a partial file, fsync and posix-rename', async () => {
    const { connection } = await connect();
    const fake = writableSftp();
    fake.dir('/etc');
    useSftp(connection, fake.session);
    const progress: number[] = [];

    await connection.upload(Buffer.from('secret: yes'), '/etc/core.yaml', {
      onProgress: (sent, total) => progress.push(sent / total),
    });

    expect(fake.text('/etc/core.yaml')).toBe('secret: yes');
    expect(fake.nodes.get('/etc/core.yaml')?.mode).toBe(0o600);
    expect(progress).toEqual([1]);
    expect(fake.ops.some((op) => op.startsWith('fsync /etc/core.yaml.'))).toBe(true);
    expect([...fake.nodes.keys()].filter((key) => key.endsWith('.partial'))).toEqual([]);
  });

  it('removes the partial file when the rename fails', async () => {
    const { connection } = await connect();
    const fake = writableSftp({ extensions: ['fsync@openssh.com'] });
    fake.dir('/etc');
    useSftp(connection, fake.session);

    await expect(connection.upload(Buffer.from('x'), '/etc/core.yaml')).rejects.toThrow(
      /does not support/,
    );
    expect([...fake.nodes.keys()]).toEqual(['/', '/etc']);
  });
});

describe('SshConnection.downloadFile', () => {
  let scratch = '';
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'agentmate-download-file-'));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const MTIME = 1_700_000_000;
  let counter = 0;
  const target = (): string => {
    counter += 1;
    return join(scratch, `target-${counter}.bin`);
  };
  const parts = async (): Promise<string[]> =>
    (await readdir(scratch)).filter((name) => name.endsWith('.part'));
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

  async function serve(content: Buffer | string, options: FakeSftpOptions = {}) {
    const { connection } = await connect();
    const fake = fakeSftp(
      { '/srv': { kind: 'dir' }, '/srv/f.bin': { kind: 'file', content, mtime: MTIME } },
      options,
    );
    useSftp(connection, fake.session);
    return { connection, fake };
  }

  it('fetches a big file across short reads with several in flight', async () => {
    const bytes = randomBytes(1024 * 1024);
    const { connection, fake } = await serve(bytes, { maxRead: 4000 });
    const local = target();

    const result = await connection.downloadFile('/srv/f.bin', local);

    expect(result).toEqual({ size: bytes.length, mtimeMs: MTIME * 1000, replaced: false });
    expect(sha(await readFile(local))).toBe(sha(bytes));
    expect(fake.peak('read')).toBeGreaterThan(1);
    expect(fake.peak('read')).toBeLessThanOrEqual(16);
    expect(fake.openHandles()).toEqual([]);
    expect(await parts()).toEqual([]);
  });

  it('reports progress that only goes up and ends at the size', async () => {
    const bytes = randomBytes(300_000);
    const { connection } = await serve(bytes, { maxRead: 10_000 });
    const progress: [number, number][] = [];

    await connection.downloadFile('/srv/f.bin', target(), {
      onProgress: (received, total) => progress.push([received, total]),
    });

    const received = progress.map(([got]) => got);
    expect(received).toEqual([...received].sort((a, b) => a - b));
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
    expect(progress.every(([, total]) => total === bytes.length)).toBe(true);
  });

  it('writes to a part file first and only then replaces the target', async () => {
    const { connection } = await serve('new contents');
    const local = target();
    await writeFile(local, 'old local');
    const seen: { parts: string[]; target: string }[] = [];

    const result = await connection.downloadFile('/srv/f.bin', local, {
      onProgress: () =>
        seen.push({
          parts: readdirSync(scratch).filter((name) => name.endsWith('.part')),
          target: readFileSync(local, 'utf-8'),
        }),
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const moment of seen) {
      expect(moment.target).toBe('old local');
      expect(moment.parts).toHaveLength(1);
      expect(moment.parts[0]).toMatch(/^target-\d+\.bin\.agentmate-[0-9a-f]{8}\.part$/);
    }
    expect(result.replaced).toBe(true);
    await expect(readFile(local, 'utf-8')).resolves.toBe('new contents');
    expect(await parts()).toEqual([]);
  });

  it('fetches an empty file', async () => {
    const { connection } = await serve('');
    const local = target();

    const result = await connection.downloadFile('/srv/f.bin', local);

    expect(result.size).toBe(0);
    await expect(readFile(local, 'utf-8')).resolves.toBe('');
  });

  it('gives the local file the remote mtime unless told not to', async () => {
    const { connection } = await serve('dated');
    const kept = target();
    const fresh = target();

    await connection.downloadFile('/srv/f.bin', kept);
    await connection.downloadFile('/srv/f.bin', fresh, { preserveMtime: false });

    expect((await stat(kept)).mtimeMs).toBe(MTIME * 1000);
    expect((await stat(fresh)).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it('leaves the target alone and removes the part file when a read fails', async () => {
    const { connection, fake } = await serve(randomBytes(100_000));
    fake.failOn('read', '/srv/f.bin');
    const local = target();
    await writeFile(local, 'old local');

    await expect(connection.downloadFile('/srv/f.bin', local)).rejects.toMatchObject({ code: 4 });

    await expect(readFile(local, 'utf-8')).resolves.toBe('old local');
    expect(await parts()).toEqual([]);
    expect(fake.openHandles()).toEqual([]);
  });

  it('passes on a remote file that is not there without creating anything', async () => {
    const { connection } = await serve('x');
    const local = target();

    await expect(connection.downloadFile('/srv/missing', local)).rejects.toMatchObject({
      code: 2,
    });

    expect(await parts()).toEqual([]);
    await expect(stat(local)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes the remote file when the local folder is missing', async () => {
    const { connection, fake } = await serve('x');

    await expect(
      connection.downloadFile('/srv/f.bin', join(scratch, 'no-such-dir', 'f.bin')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(fake.closed).toEqual(['h0']);
  });

  it('removes the part file and keeps the target when cancelled', async () => {
    const controller = new AbortController();
    const { connection } = await serve(randomBytes(200_000), {
      onRequest: (kind) => {
        if (kind === 'read') controller.abort();
      },
    });
    const local = target();
    await writeFile(local, 'old local');

    const failure = await connection
      .downloadFile('/srv/f.bin', local, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    await expect(readFile(local, 'utf-8')).resolves.toBe('old local');
    expect(await parts()).toEqual([]);
  });

  it('still stops when cancelled after the last byte, before the target is replaced', async () => {
    const controller = new AbortController();
    const { connection } = await serve('new contents', {
      onRequest: (kind) => {
        if (kind === 'close') controller.abort();
      },
    });
    const local = target();
    await writeFile(local, 'old local');

    const failure = await connection
      .downloadFile('/srv/f.bin', local, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    await expect(readFile(local, 'utf-8')).resolves.toBe('old local');
    expect(await parts()).toEqual([]);
  });

  it('removes the part file when it cannot take the target name', async () => {
    const { connection } = await serve('x');
    const local = target();
    await mkdir(join(local, 'inside'), { recursive: true });

    await expect(connection.downloadFile('/srv/f.bin', local)).rejects.toThrow();

    expect(await parts()).toEqual([]);
    expect((await stat(local)).isDirectory()).toBe(true);
  });

  it('refuses to start when already cancelled', async () => {
    const { connection, fake } = await serve('x');

    const failure = await connection
      .downloadFile('/srv/f.bin', target(), { signal: AbortSignal.abort() })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('cancelled');
    expect(fake.ops).toEqual([]);
  });

  it('gives up on a read that stalls', async () => {
    const { connection, fake } = await serve('stuck');
    fake.hang('read');

    const failure = await connection
      .downloadFile('/srv/f.bin', target(), { stallTimeoutMs: 50 })
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('timeout');
    expect(String(failure)).toMatch(/Fetching \/srv\/f\.bin: .* stopped answering/);
    expect(await parts()).toEqual([]);
  });

  it('fails a file that shrinks while it is read, and keeps the target', async () => {
    const { connection } = await serve(randomBytes(200_000), {
      maxRead: 8000,
      truncateAt: { path: '/srv/f.bin', size: 50_000 },
    });
    const local = target();
    await writeFile(local, 'old local');

    const failure = await connection
      .downloadFile('/srv/f.bin', local)
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('changedOnServer');
    await expect(readFile(local, 'utf-8')).resolves.toBe('old local');
    expect(await parts()).toEqual([]);
  });

  it('fails a file that grows while it is read', async () => {
    let grown = false;
    const { connection, fake } = await serve('short', {
      onRequest: (kind) => {
        if (kind !== 'read' || grown) return;
        grown = true;
        const node = fake.nodes.get('/srv/f.bin');
        if (node?.kind === 'file') node.content = 'short and then some';
      },
    });

    const failure = await connection
      .downloadFile('/srv/f.bin', target())
      .catch((error: unknown) => error);

    expect(filesErrorCode(failure)).toBe('changedOnServer');
    expect(await parts()).toEqual([]);
  });

  it('fails and cleans up when the connection ends mid-download', async () => {
    const { connection, fake } = await serve('x');
    fake.hang('read');
    const local = target();
    const download = connection.downloadFile('/srv/f.bin', local);
    await vi.waitFor(() => expect(fake.ops.some((op) => op.startsWith('read'))).toBe(true));
    connection.close();

    await expect(download).rejects.toThrow(/closed/);
    expect(await parts()).toEqual([]);
    await expect(stat(local)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SshConnection as the file manager client', () => {
  it('has the shape main/sftp is written against', () => {
    // Fails to compile when SshConnection and SftpFileClient drift apart.
    const asClient = (connection: SshConnection): SftpFileClient => connection;
    expect(asClient).toBeTypeOf('function');
  });
});
