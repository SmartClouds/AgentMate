import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { RemoteControlMessage, RemoteFileEntry } from '../../shared/remoteProtocol';
import { tempDir, withPlatform, writeTree } from '../../test/main/fixtures';

/**
 * `homedir()` is the one thing this module reads that would otherwise point at the developer's
 * real profile: `fm-list` with a null path lists it, and `fm-roots` hands it to the peer. Pointing
 * it at a temp folder keeps the suite off the real home directory.
 */
const osState = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    // `platform` stays the real one so `withPlatform` can still flip it per test.
    homedir: () => osState.home || actual.homedir(),
  };
});

const { FileManagerOps } = await import('./fileManagerOps');

/**
 * The socket is never read or written by this module: every message leaves through the injected
 * `sendControl` callback, and `ws` is only carried along so the caller knows which peer to answer.
 * A real server would add moving parts without covering a single extra line.
 */
const ws = {} as WebSocket;

interface Harness {
  ops: InstanceType<typeof FileManagerOps>;
  sent: RemoteControlMessage[];
  last: () => RemoteControlMessage;
}

function harness(): Harness {
  const sent: RemoteControlMessage[] = [];
  const ops = new FileManagerOps({
    sendControl: (_target: WebSocket, msg: RemoteControlMessage) => {
      sent.push(msg);
    },
  });
  return { ops, sent, last: () => sent[sent.length - 1] };
}

/** Pulls the correlation id out of whichever request was just sent. */
function reqIdOf(msg: RemoteControlMessage): string {
  if (!('reqId' in msg)) throw new Error(`message "${msg.t}" carries no reqId`);
  return msg.reqId;
}

/** Waits for the inbound handler, which runs detached, to push its reply. */
async function replyAfter(
  sent: RemoteControlMessage[],
  before: number,
): Promise<RemoteControlMessage> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before));
  return sent[before];
}

function ackOf(msg: RemoteControlMessage): { ok: boolean; error?: string } {
  if (msg.t !== 'fm-ack') throw new Error(`expected an fm-ack, got "${msg.t}"`);
  return { ok: msg.ok, error: msg.error };
}

function listingOf(msg: RemoteControlMessage): {
  path: string;
  entries: RemoteFileEntry[];
  error?: string;
} {
  if (msg.t !== 'fm-list-reply') throw new Error(`expected an fm-list-reply, got "${msg.t}"`);
  return { path: msg.path, entries: msg.entries, error: msg.error };
}

let root = '';

beforeEach(() => {
  root = tempDir('runova-fm-');
  osState.home = join(root, 'home');
  mkdirSync(osState.home, { recursive: true });
});

afterEach(() => {
  osState.home = '';
});

describe('outbound requests', () => {
  it('sends fm-roots and resolves with the roots the peer reported', async () => {
    const { ops, sent } = harness();
    const roots: RemoteFileEntry[] = [
      { name: 'C:\\', path: 'C:\\', isDirectory: true, size: 0, mtimeMs: 0 },
    ];

    const pending = ops.roots(ws);
    expect(sent[0].t).toBe('fm-roots');
    ops.handleControl(ws, { t: 'fm-roots-reply', reqId: reqIdOf(sent[0]), roots });

    await expect(pending).resolves.toEqual(roots);
  });

  it('sends fm-list with the requested path and resolves the listing', async () => {
    const { ops, sent } = harness();

    const pending = ops.list(ws, '/tmp/somewhere');
    expect(sent[0]).toMatchObject({ t: 'fm-list', path: '/tmp/somewhere' });
    ops.handleControl(ws, {
      t: 'fm-list-reply',
      reqId: reqIdOf(sent[0]),
      path: '/tmp/somewhere',
      entries: [],
    });

    await expect(pending).resolves.toEqual({ path: '/tmp/somewhere', entries: [] });
  });

  it('forwards a null path so the peer decides where browsing starts', () => {
    const { ops, sent } = harness();
    void ops.list(ws, null).catch(() => undefined);
    expect(sent[0]).toMatchObject({ t: 'fm-list', path: null });
  });

  it('rejects a listing the peer could not produce', async () => {
    const { ops, sent } = harness();

    const pending = ops.list(ws, '/nope');
    ops.handleControl(ws, {
      t: 'fm-list-reply',
      reqId: reqIdOf(sent[0]),
      path: '/nope',
      entries: [],
      error: 'ENOENT: no such file or directory',
    });

    await expect(pending).rejects.toThrow('ENOENT: no such file or directory');
  });

  it.each([
    ['mkdir', (ops: Harness['ops']) => ops.mkdir(ws, '/parent', 'child'), 'fm-mkdir'],
    ['delete', (ops: Harness['ops']) => ops.delete(ws, '/gone'), 'fm-delete'],
    ['rename', (ops: Harness['ops']) => ops.rename(ws, '/old', 'new'), 'fm-rename'],
  ] as const)('%s resolves on a positive ack', async (_label, call, expectedType) => {
    const { ops, sent } = harness();

    const pending = call(ops);
    expect(sent[0].t).toBe(expectedType);
    ops.handleControl(ws, { t: 'fm-ack', reqId: reqIdOf(sent[0]), ok: true });

    await expect(pending).resolves.toBeUndefined();
  });

  it('carries the mkdir parent and name so the peer does not have to join paths itself', () => {
    const { ops, sent } = harness();
    void ops.mkdir(ws, '/parent', 'child').catch(() => undefined);
    expect(sent[0]).toMatchObject({ t: 'fm-mkdir', parentPath: '/parent', name: 'child' });
  });

  it('rejects with the peer error text on a negative ack', async () => {
    const { ops, sent } = harness();

    const pending = ops.delete(ws, '/locked');
    ops.handleControl(ws, {
      t: 'fm-ack',
      reqId: reqIdOf(sent[0]),
      ok: false,
      error: 'EBUSY: resource busy',
    });

    await expect(pending).rejects.toThrow('EBUSY: resource busy');
  });

  it('falls back to a generic message when the peer gives no reason', async () => {
    const { ops, sent } = harness();

    const pending = ops.rename(ws, '/a', 'b');
    ops.handleControl(ws, { t: 'fm-ack', reqId: reqIdOf(sent[0]), ok: false });

    await expect(pending).rejects.toThrow('The peer rejected the request.');
  });

  it('rejects when the reply is the wrong shape for the request', async () => {
    const { ops, sent } = harness();

    const pending = ops.roots(ws);
    // Same correlation id, wrong message: the caller must not receive a bogus value.
    ops.handleControl(ws, { t: 'fm-ack', reqId: reqIdOf(sent[0]), ok: true });

    await expect(pending).rejects.toThrow('Unexpected reply.');
  });

  describe('requestFile', () => {
    it('resolves once the peer agrees to push the file', async () => {
      const { ops, sent } = harness();

      const pending = ops.requestFile(ws, '/peer/report.pdf');
      expect(sent[0]).toMatchObject({ t: 'file-request', path: '/peer/report.pdf' });
      ops.handleControl(ws, { t: 'file-request-ack', reqId: reqIdOf(sent[0]), ok: true });

      await expect(pending).resolves.toBeUndefined();
    });

    it('rejects with the peer reason when it declines', async () => {
      const { ops, sent } = harness();

      const pending = ops.requestFile(ws, '/peer/folder');
      ops.handleControl(ws, {
        t: 'file-request-ack',
        reqId: reqIdOf(sent[0]),
        ok: false,
        error: 'Not a file.',
      });

      await expect(pending).rejects.toThrow('Not a file.');
    });

    it('rejects with a default reason when the peer gives none', async () => {
      const { ops, sent } = harness();

      const pending = ops.requestFile(ws, '/peer/thing');
      ops.handleControl(ws, { t: 'file-request-ack', reqId: reqIdOf(sent[0]), ok: false });

      await expect(pending).rejects.toThrow('The peer declined.');
    });
  });
});

describe('request correlation', () => {
  it('matches each reply to its own request, whatever order they come back in', async () => {
    const { ops, sent } = harness();

    const first = ops.list(ws, '/one');
    const second = ops.list(ws, '/two');
    const firstId = reqIdOf(sent[0]);
    const secondId = reqIdOf(sent[1]);
    expect(firstId).not.toBe(secondId);

    // Answered back to front, so a client that just resolved the oldest promise would fail.
    ops.handleControl(ws, { t: 'fm-list-reply', reqId: secondId, path: '/two', entries: [] });
    ops.handleControl(ws, { t: 'fm-list-reply', reqId: firstId, path: '/one', entries: [] });

    await expect(first).resolves.toMatchObject({ path: '/one' });
    await expect(second).resolves.toMatchObject({ path: '/two' });
  });

  it('ignores a reply whose request it never made', () => {
    const { ops } = harness();
    // A stale reply from a previous session must not throw inside the socket handler.
    expect(() =>
      ops.handleControl(ws, { t: 'fm-ack', reqId: 'never-sent', ok: true }),
    ).not.toThrow();
  });

  it('times out a request the peer never answers', async () => {
    vi.useFakeTimers();
    const { ops } = harness();

    const pending = ops.roots(ws);
    const assertion = expect(pending).rejects.toThrow('Timed out waiting for the peer to reply.');
    await vi.advanceTimersByTimeAsync(15_000);

    await assertion;
  });

  it('drops a reply that arrives after the request timed out', async () => {
    vi.useFakeTimers();
    const { ops, sent } = harness();

    const pending = ops.roots(ws);
    const assertion = expect(pending).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The promise is already settled, so resolving it again would be a silent no-op at best.
    expect(() =>
      ops.handleControl(ws, { t: 'fm-roots-reply', reqId: reqIdOf(sent[0]), roots: [] }),
    ).not.toThrow();
  });

  it('does not time out a request that was answered in time', async () => {
    vi.useFakeTimers();
    const { ops, sent } = harness();

    const pending = ops.roots(ws);
    ops.handleControl(ws, { t: 'fm-roots-reply', reqId: reqIdOf(sent[0]), roots: [] });
    await expect(pending).resolves.toEqual([]);

    // The timer has to be cleared, otherwise it fires against an empty pending map forever.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('handleControl dispatch', () => {
  it.each(['ping', 'pong', 'rtc-request'] as const)(
    'leaves an unrelated %s message for another handler',
    (t) => {
      const { ops } = harness();
      expect(ops.handleControl(ws, { t })).toBe(false);
    },
  );

  it('claims every fm message so no other handler double-processes it', () => {
    const { ops } = harness();
    expect(ops.handleControl(ws, { t: 'fm-roots', reqId: 'a' })).toBe(true);
    expect(ops.handleControl(ws, { t: 'fm-list', reqId: 'b', path: root })).toBe(true);
    expect(ops.handleControl(ws, { t: 'fm-mkdir', reqId: 'c', parentPath: root, name: 'x' })).toBe(
      true,
    );
    expect(ops.handleControl(ws, { t: 'fm-delete', reqId: 'd', path: join(root, 'x') })).toBe(true);
    expect(
      ops.handleControl(ws, { t: 'fm-rename', reqId: 'e', path: join(root, 'y'), newName: 'z' }),
    ).toBe(true);
  });
});

describe('inbound fm-list', () => {
  it('lists a directory with folders first, then names in order', async () => {
    writeTree(root, {
      'tree/zebra.txt': 'z',
      'tree/apple.txt': 'apple contents',
      'tree/Beta/keep.txt': 'k',
      'tree/alpha/keep.txt': 'k',
    });
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: join(root, 'tree') });
    const reply = listingOf(await replyAfter(sent, 0));

    expect(reply.error).toBeUndefined();
    expect(reply.path).toBe(join(root, 'tree'));
    // Directories before files is what makes the remote browser usable at a glance.
    expect(reply.entries.map((entry) => entry.name)).toEqual([
      'alpha',
      'Beta',
      'apple.txt',
      'zebra.txt',
    ]);
    expect(reply.entries.map((entry) => entry.isDirectory)).toEqual([true, true, false, false]);
  });

  it('reports a real size and mtime for files and zeroes for directories', async () => {
    writeTree(root, { 'tree/apple.txt': 'apple contents', 'tree/sub/keep.txt': 'k' });
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: join(root, 'tree') });
    const reply = listingOf(await replyAfter(sent, 0));

    const dir = reply.entries.find((entry) => entry.name === 'sub');
    const file = reply.entries.find((entry) => entry.name === 'apple.txt');
    expect(dir).toMatchObject({ isDirectory: true, size: 0, mtimeMs: 0 });
    expect(file?.size).toBe('apple contents'.length);
    expect(file?.mtimeMs).toBeCloseTo(statSync(join(root, 'tree/apple.txt')).mtimeMs, 0);
    expect(file?.path).toBe(join(root, 'tree', 'apple.txt'));
  });

  it('falls back to the home directory when the peer sends no path', async () => {
    writeTree(osState.home, { 'notes.txt': 'hi' });
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: null });
    const reply = listingOf(await replyAfter(sent, 0));

    expect(reply.path).toBe(osState.home);
    expect(reply.entries.map((entry) => entry.name)).toEqual(['notes.txt']);
  });

  it('answers with an error instead of going silent when the path is unreadable', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: join(root, 'missing') });
    const reply = listingOf(await replyAfter(sent, 0));

    // A silent drop would leave the requester waiting out the full 15 second timeout.
    expect(reply.entries).toEqual([]);
    expect(reply.error).toMatch(/ENOENT|no such file/i);
    expect(reply.path).toBe(join(root, 'missing'));
  });

  it('returns an empty listing for an empty directory', async () => {
    mkdirSync(join(root, 'empty'));
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: join(root, 'empty') });
    const reply = listingOf(await replyAfter(sent, 0));

    expect(reply.entries).toEqual([]);
    expect(reply.error).toBeUndefined();
  });
});

describe('inbound fm-mkdir', () => {
  it('creates the folder and acks', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-mkdir', reqId: 'r1', parentPath: root, name: 'fresh' });

    expect(ackOf(await replyAfter(sent, 0))).toEqual({ ok: true, error: undefined });
    expect(statSync(join(root, 'fresh')).isDirectory()).toBe(true);
  });

  it('refuses a name that already exists rather than silently succeeding', async () => {
    mkdirSync(join(root, 'taken'));
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-mkdir', reqId: 'r1', parentPath: root, name: 'taken' });

    // `recursive: false` is what makes this an error, and the user needs to see it.
    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(false);
  });

  it('refuses to create a whole missing chain of parents', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, {
      t: 'fm-mkdir',
      reqId: 'r1',
      parentPath: join(root, 'not-there'),
      name: 'child',
    });

    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(false);
  });
});

describe('inbound fm-delete', () => {
  it('removes a whole folder tree', async () => {
    writeTree(root, { 'doomed/nested/deep.txt': 'x' });
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-delete', reqId: 'r1', path: join(root, 'doomed') });

    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(true);
    expect(() => statSync(join(root, 'doomed'))).toThrow();
  });

  it('reports a failure for a path that is not there', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-delete', reqId: 'r1', path: join(root, 'ghost') });

    // `force: false` on purpose: deleting nothing should not look like a success.
    const ack = ackOf(await replyAfter(sent, 0));
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/ENOENT|no such file/i);
  });
});

describe('inbound fm-rename', () => {
  it('renames within the same folder', async () => {
    writeTree(root, { 'before.txt': 'contents' });
    const { ops, sent } = harness();

    ops.handleControl(ws, {
      t: 'fm-rename',
      reqId: 'r1',
      path: join(root, 'before.txt'),
      newName: 'after.txt',
    });

    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(true);
    expect(statSync(join(root, 'after.txt')).size).toBe('contents'.length);
  });

  it('reports a failure for a path that is not there', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, {
      t: 'fm-rename',
      reqId: 'r1',
      path: join(root, 'ghost.txt'),
      newName: 'other.txt',
    });

    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(false);
  });

  it('lets a relative newName move the file out of its folder', async () => {
    writeTree(root, { 'box/inside.txt': 'contents' });
    const { ops, sent } = harness();

    ops.handleControl(ws, {
      t: 'fm-rename',
      reqId: 'r1',
      path: join(root, 'box', 'inside.txt'),
      newName: join('..', 'escaped.txt'),
    });

    // Pinned deliberately: the module documents that it runs no path jail, because a
    // remote-control session already hands the peer OS-level input on this machine. If a jail
    // is ever added, this expectation is the one that should be rewritten first.
    expect(ackOf(await replyAfter(sent, 0)).ok).toBe(true);
    expect(statSync(join(root, 'escaped.txt')).size).toBe('contents'.length);
  });
});

describe('inbound fm-roots', () => {
  it('offers Home and the filesystem root on POSIX', async () => {
    const { ops, sent } = harness();

    await withPlatform('linux', async () => {
      ops.handleControl(ws, { t: 'fm-roots', reqId: 'r1' });
      await vi.waitFor(() => expect(sent.length).toBe(1));
    });

    const reply = sent[0];
    if (reply.t !== 'fm-roots-reply') throw new Error('expected an fm-roots-reply');
    expect(reply.roots).toEqual([
      { name: 'Home', path: osState.home, isDirectory: true, size: 0, mtimeMs: 0 },
      { name: '/', path: '/', isDirectory: true, size: 0, mtimeMs: 0 },
    ]);
  });

  it.runIf(process.platform === 'win32')('offers the drive letters on Windows', async () => {
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-roots', reqId: 'r1' });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    const reply = sent[0];
    if (reply.t !== 'fm-roots-reply') throw new Error('expected an fm-roots-reply');
    // Only drives that actually exist are offered, so the browser never opens a dead root.
    expect(reply.roots.length).toBeGreaterThan(0);
    for (const entry of reply.roots) {
      expect(entry.path).toMatch(/^[A-Z]:\\$/);
      expect(entry).toMatchObject({ isDirectory: true, size: 0, mtimeMs: 0 });
    }
  });
});

describe('temp tree safety', () => {
  it('never reads outside the temp home the mock points at', async () => {
    writeFileSync(join(osState.home, 'only.txt'), 'x');
    const { ops, sent } = harness();

    ops.handleControl(ws, { t: 'fm-list', reqId: 'r1', path: null });
    const reply = listingOf(await replyAfter(sent, 0));

    expect(reply.path.startsWith(root)).toBe(true);
  });
});
