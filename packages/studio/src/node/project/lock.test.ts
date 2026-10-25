import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { acquireVideoLock, type HeldLock, LOCK_FILE, type LockOptions } from './lock.js';

const tempDir = useTempDirs();
const held: HeldLock[] = [];
afterEach(async () => {
  await Promise.all(held.splice(0).map((lock) => lock.release()));
});

function options(over: Partial<LockOptions> = {}): LockOptions {
  return {
    appId: 'AgentMate',
    pid: 100,
    host: 'laptop',
    now: () => 1_000_000,
    staleMs: 30_000,
    isAlive: () => true,
    heartbeatMs: 0,
    ...over,
  };
}

async function acquire(folder: string, over: Partial<LockOptions> = {}) {
  const result = await acquireVideoLock(folder, options(over));
  if (result.ok) held.push(result.lock);
  return result;
}

describe('acquireVideoLock', () => {
  it('takes a free folder and writes who holds it', async () => {
    const dir = await tempDir();
    const result = await acquire(dir);
    expect(result.ok).toBe(true);
    const info = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
    expect(info).toMatchObject({
      appId: 'AgentMate',
      pid: 100,
      host: 'laptop',
      heartbeatAt: 1_000_000,
    });
  });

  it('refuses a folder another live app holds, and says who', async () => {
    const dir = await tempDir();
    await acquire(dir, { appId: 'AgentMate Dev', pid: 200 });
    const result = await acquire(dir);
    expect(result).toEqual({
      ok: false,
      holder: expect.objectContaining({ appId: 'AgentMate Dev', pid: 200, host: 'laptop' }),
      stale: false,
    });
  });

  it('reports a lock whose holder stopped sending heartbeats as stale, and leaves it to the user', async () => {
    const dir = await tempDir();
    await acquire(dir, { pid: 200, now: () => 1_000_000 });
    const result = await acquire(dir, { now: () => 1_000_000 + 31_000 });
    expect(result).toMatchObject({ ok: false, stale: true });
  });

  it('takes over a stale lock when the user says so', async () => {
    const dir = await tempDir();
    await acquire(dir, { pid: 200, now: () => 1_000_000 });
    const result = await acquire(dir, { now: () => 1_000_000 + 31_000, takeOverStale: true });
    expect(result.ok).toBe(true);
  });

  it('never takes over a lock that is still beating, even when asked', async () => {
    const dir = await tempDir();
    await acquire(dir, { pid: 200 });
    expect((await acquire(dir, { takeOverStale: true })).ok).toBe(false);
  });

  it('stops beating when abandoned, and leaves the file for the next opener to judge', async () => {
    const dir = await tempDir();
    const result = await acquireVideoLock(dir, options({ heartbeatMs: 5 }));
    if (!result.ok) throw new Error('expected the lock');
    result.lock.abandon();
    await result.lock.heartbeat();
    await expect(readFile(join(dir, LOCK_FILE), 'utf8')).resolves.toContain('"pid": 100');
  });

  it('takes over at once when the holder on this machine is no longer running', async () => {
    const dir = await tempDir();
    await acquire(dir, { pid: 200 });
    const result = await acquire(dir, { isAlive: (pid) => pid !== 200 });
    expect(result.ok).toBe(true);
  });

  it('does not judge a process on another machine by pid', async () => {
    const dir = await tempDir();
    await acquire(dir, { pid: 200, host: 'desktop' });
    const result = await acquire(dir, { isAlive: () => false });
    expect(result.ok).toBe(false);
  });

  it('lets the same app open the folder again', async () => {
    const dir = await tempDir();
    await acquire(dir);
    expect((await acquire(dir)).ok).toBe(true);
  });

  it('treats an unreadable lock file as stale rather than locking the user out forever', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, LOCK_FILE), 'not json');
    expect((await acquire(dir)).ok).toBe(true);
  });

  it('removes its lock on release, but never a lock someone else took over', async () => {
    const dir = await tempDir();
    const first = await acquireVideoLock(dir, options());
    if (!first.ok) throw new Error('expected the lock');
    await first.lock.release();
    await expect(readFile(join(dir, LOCK_FILE))).rejects.toThrow();

    const mine = await acquireVideoLock(dir, options());
    if (!mine.ok) throw new Error('expected the lock');
    await acquire(dir, { pid: 300, now: () => 1_000_000 + 60_000, takeOverStale: true });
    await mine.lock.release();
    const info = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
    expect(info.pid).toBe(300);
  });

  it('refreshes its heartbeat', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    const result = await acquire(dir, { now: () => clock });
    if (!result.ok) throw new Error('expected the lock');
    clock += 5_000;
    await result.lock.heartbeat();
    const info = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
    expect(info.heartbeatAt).toBe(1_005_000);
  });

  it('beats on a timer when asked to', async () => {
    const dir = await tempDir();
    let clock = 1_000_000;
    await acquire(dir, { now: () => clock, heartbeatMs: 10 });
    clock = 2_000_000;
    await vi.waitFor(async () => {
      const info = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
      expect(info.heartbeatAt).toBe(2_000_000);
    });
  });
});
