import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshAgentHistoryRun } from '../../shared/apiTypes';
import { createSshHistoryStore, SAVE_DELAY_MS } from './sshTaskHistoryStore';

function run(id: string, extra: Partial<SshAgentHistoryRun> = {}): SshAgentHistoryRun {
  return {
    id,
    sessionId: 'tab-1',
    serverId: 'srv-1',
    prompt: `task ${id}`,
    aiLabel: 'Gemini',
    startedAt: Number(id.replace(/\D/g, '')) || 1,
    endedAt: 10,
    status: 'finished',
    entries: [],
    ...extra,
  };
}

function setup(saved: unknown = []) {
  const write = vi.fn(async (_runs: SshAgentHistoryRun[]) => undefined);
  const read = vi.fn(async () => saved as SshAgentHistoryRun[]);
  return { read, write, history: createSshHistoryStore({ read, write, perServer: 3 }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loading', () => {
  it('reads the file once, however often it is asked', async () => {
    const { read, history } = setup([run('r1')]);
    const [a, b] = await Promise.all([history.load(), history.load()]);
    expect(a.map((r) => r.id)).toEqual(['r1']);
    expect(b).toBe(a);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('marks a task that was still going when Runova closed as stopped', async () => {
    const { history } = setup([
      run('r1', { status: 'running', endedAt: null }),
      run('r2', { status: 'paused', endedAt: null }),
    ]);
    const runs = await history.load();
    for (const r of runs) {
      expect(r.status).toBe('stopped');
      expect(r.endedAt).not.toBeNull();
      expect(r.entries.at(-1)).toMatchObject({
        kind: 'stopped',
        text: 'Runova closed while this was running.',
      });
    }
  });

  it('starts empty from a missing, unreadable or malformed file', async () => {
    for (const saved of [undefined, null, { runs: 'nope' }, [{ id: 3 }], 'x']) {
      const { history } = setup(saved);
      expect(await history.load()).toEqual([]);
    }
    const broken = createSshHistoryStore({
      read: async () => {
        throw new Error('EACCES');
      },
      write: vi.fn(),
    });
    expect(await broken.load()).toEqual([]);
  });
});

describe('saving', () => {
  it('writes a moment after the last change rather than on every one', async () => {
    const { write, history } = setup();
    history.save([run('r1')]);
    history.save([run('r1'), run('r2')]);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('keeps only tasks run on a saved server, since a local tab means nothing after a restart', async () => {
    const { write, history } = setup();
    history.save([run('r1'), run('r2', { serverId: undefined })]);
    await history.flush();
    expect(write.mock.calls[0]?.[0].map((r) => r.id)).toEqual(['r1']);
  });

  it('keeps the newest tasks of each server up to the limit', async () => {
    const { write, history } = setup();
    history.save([run('r1'), run('r2'), run('r3'), run('r4'), run('r5', { serverId: 'srv-2' })]);
    await history.flush();
    expect(write.mock.calls[0]?.[0].map((r) => r.id).sort()).toEqual(['r2', 'r3', 'r4', 'r5']);
  });

  it('flush writes what is pending at once, and nothing when there is not', async () => {
    const { write, history } = setup();
    await history.flush();
    expect(write).not.toHaveBeenCalled();
    history.save([run('r1')]);
    await history.flush();
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('survives a failed write, and the next change tries again', async () => {
    const { write, history } = setup();
    write.mockRejectedValueOnce(new Error('disk full'));
    history.save([run('r1')]);
    await history.flush();
    history.save([run('r1'), run('r2')]);
    await history.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
