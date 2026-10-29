import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSnapshot } from '../../shared/apiTypes';
import { PASTE_BOOST_MIN_CHARS, type PasteBoost } from './pasteBoost';
import type { SessionListener } from './sessionManager';

/**
 * Exercises the real pty path, because the bugs this class exists to prevent (a snapshot taken
 * before the emulator drained, output lost between attach and hand-over, a resize applied to
 * unparsed bytes) only show up against a process that actually writes to a terminal.
 *
 * The native module is rebuilt for Electron's ABI by `pnpm dev`, after which plain Node cannot
 * load it, so the whole file steps aside rather than failing when that has happened.
 */
const ptyLoads = await (async (): Promise<boolean> => {
  try {
    await import('node-pty');
    return true;
  } catch {
    return false;
  }
})();

/**
 * Stands in for a login shell: the Node binary with a preload that writes a known marker. Booting
 * a real shell would make every assertion depend on the developer's dotfiles and prompt.
 */
const SHIM = `
const mode = process.env.RUNOVA_PTY_TEST_MODE;
process.stdout.write('READY\\n');
if (mode === 'exit7') {
  process.exit(7);
}
if (mode === 'interactive') {
  // Node with no script also opens its REPL on the console. Two readers race for the input, and
  // once something attaches to the console (the paste boost's process lookup) keystrokes go to
  // the REPL. The REPL gets an idle stream, so the shim reads the console alone, as a shell would,
  // and in raw mode like one, so a key arrives without waiting for Enter.
  const input = process.stdin;
  Object.defineProperty(process, 'stdin', {
    value: new (require('node:stream').PassThrough)(),
    configurable: true,
  });
  if (input.isTTY) input.setRawMode(true);
  input.on('data', (chunk) => {
    const text = String(chunk);
    if (text.includes('Q')) process.exit(9);
    process.stdout.write('GOT:' + text.trim() + '\\n');
  });
}
`;

interface Recorder extends SessionListener {
  data: string[];
  exits: [string, number][];
  text: () => string;
}

function recorder(): Recorder {
  const data: string[] = [];
  const exits: [string, number][] = [];
  return {
    data,
    exits,
    text: () => data.join(''),
    onData: (_sessionId, chunk) => data.push(chunk),
    onExit: (sessionId, code) => exits.push([sessionId, code]),
  };
}

describe.skipIf(!ptyLoads)('PtySessionManager', async () => {
  const { PtySessionManager } = await import('./sessionManager');

  let dir = '';
  let shimPath = '';
  let manager: InstanceType<typeof PtySessionManager>;
  let changes = 0;

  /** Env for a session: the real environment plus the preload that makes the fake shell talk. */
  const envFor = (mode: string): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    RUNOVA_PTY_TEST_MODE: mode,
    NODE_OPTIONS: `--require "${shimPath.replace(/\\/g, '/')}"`,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'runova-pty-'));
    shimPath = join(dir, 'shim.cjs');
    writeFileSync(shimPath, SHIM, 'utf-8');
    changes = 0;
    manager = new PtySessionManager(() => {
      changes += 1;
    });
  });

  afterEach(() => {
    manager.killAll();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps a handle on the folder until the killed shell is fully reaped. The OS
      // clears the temp folder later; failing the test over it would only add flakiness.
    }
  });

  it('spawns a session and streams its output to the listener', async () => {
    const listener = recorder();

    const result = await manager.createOrAttach(
      {
        sessionId: 's1',
        shell: process.execPath,
        cwd: dir,
        cols: 80,
        rows: 24,
        env: envFor('interactive'),
        projectId: 'proj-1',
      },
      listener,
    );

    expect(result).toEqual({ isNew: true, snapshot: null });
    expect(manager.size).toBe(1);
    // A new session has to be announced, since the host reports its count to the app.
    expect(changes).toBe(1);

    await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });

    const listed = manager.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sessionId: 's1', projectId: 'proj-1' });
    expect(listed[0].pid).toBeGreaterThan(0);
    expect(listed[0].createdAt).toBeGreaterThan(0);
  });

  it('reports the exit code and forgets the session', async () => {
    const listener = recorder();
    await manager.createOrAttach(
      { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('exit7') },
      listener,
    );

    await vi.waitFor(() => expect(listener.exits).toHaveLength(1), { timeout: 15_000 });

    expect(listener.exits[0]).toEqual(['s1', 7]);
    expect(manager.size).toBe(0);
    expect(manager.list()).toEqual([]);
    // Spawn plus finish, so the host's session count stays accurate.
    expect(changes).toBe(2);
  });

  it('delivers written input to the shell', async () => {
    const listener = recorder();
    await manager.createOrAttach(
      { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
      listener,
    );
    await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });

    manager.write('s1', 'ping\r');

    await vi.waitFor(() => expect(listener.text()).toContain('GOT:'), { timeout: 15_000 });
  });

  it('writing to an unknown session is a no-op', () => {
    expect(() => manager.write('nope', 'x')).not.toThrow();
    expect(() => manager.resize('nope', 10, 10)).not.toThrow();
    expect(() => manager.kill('nope')).not.toThrow();
    expect(changes).toBe(0);
  });

  it('sends the initial input as soon as the shell starts', async () => {
    const listener = recorder();
    await manager.createOrAttach(
      {
        sessionId: 's1',
        shell: process.execPath,
        cwd: dir,
        env: envFor('interactive'),
        initialInput: 'hello\r',
      },
      listener,
    );

    await vi.waitFor(() => expect(listener.text()).toContain('GOT:'), { timeout: 15_000 });
  });

  it('kills a session and stops tracking it', async () => {
    const listener = recorder();
    await manager.createOrAttach(
      { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
      listener,
    );
    await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });

    manager.kill('s1');

    expect(manager.size).toBe(0);
    // kill() is deliberate, so no exit is reported back to whoever asked for it.
    expect(listener.exits).toEqual([]);
    expect(changes).toBe(2);
    // A write after the kill must not resurrect or throw.
    expect(() => manager.write('s1', 'x')).not.toThrow();
  });

  it('killAll clears every session', async () => {
    const listener = recorder();
    for (const id of ['a', 'b', 'c']) {
      await manager.createOrAttach(
        { sessionId: id, shell: process.execPath, cwd: dir, env: envFor('interactive') },
        listener,
      );
    }
    expect(manager.size).toBe(3);

    manager.killAll();

    expect(manager.size).toBe(0);
  });

  describe('paste boost', () => {
    const fakeBoost = () => ({
      boost: vi.fn<PasteBoost['boost']>(),
      consolesChanged: vi.fn(),
      dispose: vi.fn(),
    });

    it('boosts a large write and leaves keystrokes alone', async () => {
      const boost = fakeBoost();
      const boosted = new PtySessionManager(undefined, undefined, boost);
      const listener = recorder();
      try {
        await boosted.createOrAttach(
          { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
          listener,
        );
        await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });
        // Spawning a console makes the cached conhost list stale.
        expect(boost.consolesChanged).toHaveBeenCalledTimes(1);

        // Every write ends its line. The shim reads a line at a time, and an unfinished line over
        // the terminal's limit (1024 bytes on macOS) leaves node-pty retrying a write that fails
        // with EBADF or EIO once killAll closes the pty.
        boosted.write('s1', 'ls\r');
        boosted.write('s1', `${'x'.repeat(PASTE_BOOST_MIN_CHARS - 2)}\r`);
        expect(boost.boost).not.toHaveBeenCalled();

        const paste = `\x1b[200~${'y'.repeat(PASTE_BOOST_MIN_CHARS)}\x1b[201~\r`;
        boosted.write('s1', paste);
        expect(boost.boost).toHaveBeenCalledTimes(1);
        const [sessionId, clients, chars] = boost.boost.mock.calls[0];
        expect(sessionId).toBe('s1');
        expect(chars).toBe(paste.length);
        // The clients are looked up from the live console, so the shell itself is among them.
        await expect(clients()).resolves.toContain(boosted.list()[0].pid);
        // The paste has to reach the shell before the session goes, or the kill cuts it off. The
        // shim exits on Q, and input arrives in order, so once it has gone the paste was read.
        boosted.write('s1', 'Q\r');
        await vi.waitFor(() => expect(listener.exits).toEqual([['s1', 9]]), { timeout: 15_000 });
      } finally {
        boosted.killAll();
      }
      expect(boost.dispose).toHaveBeenCalled();
    });

    it('does not boost a write to a session that is gone', () => {
      const boost = fakeBoost();
      const boosted = new PtySessionManager(undefined, undefined, boost);

      boosted.write('nope', 'x'.repeat(PASTE_BOOST_MIN_CHARS * 4));

      expect(boost.boost).not.toHaveBeenCalled();
    });
  });

  describe('attach', () => {
    it('refuses attachOnly for a session that is not running', async () => {
      const result = await manager.createOrAttach(
        { sessionId: 'ghost', shell: process.execPath, attachOnly: true },
        recorder(),
      );
      expect(result).toBeNull();
      expect(manager.size).toBe(0);
    });

    it('hands the new listener a snapshot of what was already printed', async () => {
      const first = recorder();
      await manager.createOrAttach(
        {
          sessionId: 's1',
          shell: process.execPath,
          cwd: dir,
          cols: 80,
          rows: 24,
          env: envFor('interactive'),
        },
        first,
      );
      await vi.waitFor(() => expect(first.text()).toContain('READY'), { timeout: 15_000 });

      const second = recorder();
      const result = await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, attachOnly: true },
        second,
      );

      expect(result?.isNew).toBe(false);
      const snapshot = result?.snapshot as TerminalSnapshot;
      // The point of the snapshot is that a reconnecting window can repaint what it missed.
      expect(snapshot.data).toContain('READY');
      expect(snapshot.cols).toBe(80);
      expect(snapshot.rows).toBe(24);
    });

    it('moves output over to the new listener and leaves the old one', async () => {
      const first = recorder();
      await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
        first,
      );
      await vi.waitFor(() => expect(first.text()).toContain('READY'), { timeout: 15_000 });

      const second = recorder();
      await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, attachOnly: true },
        second,
      );
      // setImmediate defers the hand-over so the attach reply goes out before any output.
      await new Promise((resolve) => setImmediate(resolve));

      const beforeCount = first.data.length;
      manager.write('s1', 'after\r');
      await vi.waitFor(() => expect(second.text()).toContain('GOT:'), { timeout: 15_000 });

      // Exactly one listener gets the output, otherwise two windows would both draw it.
      expect(first.data.length).toBe(beforeCount);
    });

    it('reports an exit that happened while the attach was in flight', async () => {
      const first = recorder();
      await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
        first,
      );
      await vi.waitFor(() => expect(first.text()).toContain('READY'), { timeout: 15_000 });

      const second = recorder();
      const attaching = manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, attachOnly: true },
        second,
      );
      manager.write('s1', 'Q');
      await attaching;

      await vi.waitFor(() => expect(second.exits).toHaveLength(1), { timeout: 15_000 });
      expect(second.exits[0]).toEqual(['s1', 9]);
      expect(manager.size).toBe(0);
    });

    it('detachListener stops output without killing the shell', async () => {
      const listener = recorder();
      await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, cwd: dir, env: envFor('interactive') },
        listener,
      );
      await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });

      manager.detachListener(listener);
      const before = listener.data.length;
      manager.write('s1', 'quiet\r');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(listener.data.length).toBe(before);
      // The shell is still there for the next window to attach to.
      expect(manager.size).toBe(1);
    });
  });

  describe('resize', () => {
    const snapshotSize = async (): Promise<{ cols: number; rows: number }> => {
      const result = await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, attachOnly: true },
        recorder(),
      );
      const snapshot = result?.snapshot as TerminalSnapshot;
      return { cols: snapshot.cols, rows: snapshot.rows };
    };

    beforeEach(async () => {
      const listener = recorder();
      await manager.createOrAttach(
        {
          sessionId: 's1',
          shell: process.execPath,
          cwd: dir,
          cols: 80,
          rows: 24,
          env: envFor('interactive'),
        },
        listener,
      );
      await vi.waitFor(() => expect(listener.text()).toContain('READY'), { timeout: 15_000 });
    });

    it('applies a new size to the emulator behind the queued output', async () => {
      manager.resize('s1', 120, 40);

      // The snapshot queues behind the resize, so it already reports the new size.
      await expect(snapshotSize()).resolves.toEqual({ cols: 120, rows: 40 });
    });

    it('ignores a degenerate size', async () => {
      manager.resize('s1', 0, 40);
      manager.resize('s1', 120, 0);
      manager.resize('s1', -5, -5);

      await expect(snapshotSize()).resolves.toEqual({ cols: 80, rows: 24 });
    });

    it('ignores a resize to the size it already has', async () => {
      manager.resize('s1', 80, 24);

      await expect(snapshotSize()).resolves.toEqual({ cols: 80, rows: 24 });
    });

    it('takes the size from an attach payload that carries one', async () => {
      await manager.createOrAttach(
        { sessionId: 's1', shell: process.execPath, attachOnly: true, cols: 100, rows: 30 },
        recorder(),
      );

      await expect(snapshotSize()).resolves.toEqual({ cols: 100, rows: 30 });
    });
  });
});
