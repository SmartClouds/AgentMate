import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeSignalResult } from './processSuspend';
import { RunPauseRegistry } from './runPauseRegistry';

/**
 * Which runs are frozen, and the one way in and out of that state. The parts that matter: a
 * second pause must never freeze twice (Windows counts suspends, so it would take two resumes),
 * a frozen run must stay resumable after main restarts while the terminal host lives on, and a
 * run that failed to freeze must not be reported as paused.
 */

function signal(pids: number[], names = pids.map((pid) => `p${pid}`)): TreeSignalResult {
  return { pids, names, failed: [] };
}

function fakeSuspender() {
  return {
    suspendTree: vi.fn(async (_root: number) => signal([100, 200], ['bash', 'node'])),
    resumePids: vi.fn(async (pids: readonly number[]) => signal([...pids].reverse())),
  };
}

let dir = '';
let file = '';
let now = 1_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmate-run-pause-'));
  file = join(dir, 'paused-runs.json');
  now = 1_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function registry(suspender = fakeSuspender(), onChange = vi.fn()) {
  const runs = new RunPauseRegistry({ suspender, file, now: () => now, onChange });
  return { runs, suspender, onChange };
}

describe('RunPauseRegistry', () => {
  it('pauses a run and remembers what it froze', async () => {
    const { runs, onChange } = registry();

    const outcome = await runs.pause('s1', 100, 'user');

    expect(outcome).toEqual({
      ok: true,
      paused: true,
      reason: 'user',
      pausedAt: 1_000,
      processCount: 2,
      failedCount: 0,
      containersOnly: false,
    });
    expect(runs.get('s1')).toMatchObject({ pid: 100, pids: [100, 200], reason: 'user' });
    expect(onChange).toHaveBeenCalledWith({
      sessionId: 's1',
      paused: true,
      reason: 'user',
      pausedAt: 1_000,
    });
  });

  it('never freezes the same run twice, even when two pauses race', async () => {
    const { runs, suspender } = registry();

    await Promise.all([runs.pause('s1', 100, 'user'), runs.pause('s1', 100, 'user')]);
    await runs.pause('s1', 100, 'user');

    expect(suspender.suspendTree).toHaveBeenCalledTimes(1);
  });

  it('takes a run over from the agent when the user pauses it too', async () => {
    const { runs, suspender, onChange } = registry();
    await runs.pause('s1', 100, 'agent');

    const outcome = await runs.pause('s1', 100, 'user');

    expect(outcome).toMatchObject({ ok: true, paused: true, reason: 'user' });
    expect(suspender.suspendTree).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'user' }));
  });

  it('does not let the agent take over a run the user paused', async () => {
    const { runs } = registry();
    await runs.pause('s1', 100, 'user');

    expect(await runs.pause('s1', 100, 'agent')).toMatchObject({ reason: 'user' });
  });

  it('resumes what it froze, in the order the suspender expects', async () => {
    const { runs, suspender, onChange } = registry();
    await runs.pause('s1', 100, 'user');

    const outcome = await runs.resume('s1');

    expect(suspender.resumePids).toHaveBeenCalledWith([100, 200]);
    expect(outcome).toMatchObject({ ok: true, paused: false, reason: null, processCount: 2 });
    expect(runs.get('s1')).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith({
      sessionId: 's1',
      paused: false,
      reason: null,
      pausedAt: null,
    });
  });

  it('treats resuming a run that is not paused as done', async () => {
    const { runs, suspender } = registry();

    expect(await runs.resume('s1')).toMatchObject({ ok: true, paused: false });
    expect(suspender.resumePids).not.toHaveBeenCalled();
  });

  it('runs a pause and a resume clicked quickly one after the other in order', async () => {
    const { runs, suspender } = registry();

    const [paused, resumed] = await Promise.all([runs.pause('s1', 100, 'user'), runs.resume('s1')]);

    expect(paused.paused).toBe(true);
    expect(resumed.paused).toBe(false);
    expect(suspender.resumePids).toHaveBeenCalledTimes(1);
  });

  it('does not call a run paused when nothing could be frozen', async () => {
    const suspender = fakeSuspender();
    suspender.suspendTree.mockResolvedValueOnce({
      pids: [],
      names: [],
      failed: [{ pid: 100, reason: 'access denied' }],
    });
    const { runs, onChange } = registry(suspender);

    const outcome = await runs.pause('s1', 100, 'user');

    expect(outcome).toMatchObject({ ok: false, paused: false, error: 'access denied' });
    expect(runs.get('s1')).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the processes it could not freeze', async () => {
    const suspender = fakeSuspender();
    suspender.suspendTree.mockResolvedValueOnce({
      pids: [100, 200],
      names: ['bash', 'node'],
      failed: [{ pid: 300, reason: 'access denied' }],
    });
    const { runs } = registry(suspender);

    expect(await runs.pause('s1', 100, 'user')).toMatchObject({
      ok: true,
      processCount: 2,
      failedCount: 1,
    });
  });

  it('says when the only thing frozen was a Docker client', async () => {
    const suspender = fakeSuspender();
    suspender.suspendTree.mockResolvedValueOnce(signal([100, 200], ['powershell', 'docker']));
    const { runs } = registry(suspender);

    expect(await runs.pause('s1', 100, 'user')).toMatchObject({ containersOnly: true });
  });

  it('keeps a run paused when resuming it failed outright, so it can be tried again', async () => {
    const suspender = fakeSuspender();
    const { runs } = registry(suspender);
    await runs.pause('s1', 100, 'user');
    suspender.resumePids.mockResolvedValueOnce({
      pids: [],
      names: [],
      failed: [{ pid: 100, reason: 'powershell exited with code 1' }],
    });

    const outcome = await runs.resume('s1');

    expect(outcome).toMatchObject({ ok: false, paused: true, error: 'powershell exited with code 1' });
    expect(runs.get('s1')).toBeDefined();
  });

  it('forgets a run whose shell ended and says so', async () => {
    const { runs, onChange } = registry();
    await runs.pause('s1', 100, 'user');

    expect(runs.forget('s1')).toMatchObject({ pids: [100, 200] });
    expect(runs.get('s1')).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ paused: false }));
    expect(runs.forget('s1')).toBeUndefined();
  });

  describe('across a restart of main', () => {
    it('keeps the paused runs on disk', async () => {
      const { runs } = registry();
      await runs.pause('s1', 100, 'agent');
      await runs.flush();

      const saved = JSON.parse(readFileSync(file, 'utf-8'));
      expect(saved).toEqual({
        version: 1,
        runs: [
          {
            sessionId: 's1',
            pid: 100,
            pids: [100, 200],
            names: ['bash', 'node'],
            pausedAt: 1_000,
            reason: 'agent',
          },
        ],
      });
    });

    it('picks up runs that are still alive with the same shell, and drops the rest', async () => {
      const first = registry();
      await first.runs.pause('s1', 100, 'user');
      await first.runs.pause('s2', 500, 'agent');
      await first.runs.pause('s3', 700, 'user');
      await first.runs.flush();

      const { runs } = registry();
      await runs.load([
        { sessionId: 's1', pid: 100 },
        // Same session id, but its shell is a different process now.
        { sessionId: 's2', pid: 501 },
      ]);

      expect(runs.list().map((run) => run.sessionId)).toEqual(['s1']);
      await runs.flush();
      expect(JSON.parse(readFileSync(file, 'utf-8')).runs).toHaveLength(1);
    });

    it('starts empty from a missing or broken file', async () => {
      const { runs } = registry();
      await runs.load([{ sessionId: 's1', pid: 100 }]);
      expect(runs.list()).toEqual([]);

      writeFileSync(file, '{not json', 'utf-8');
      await runs.load([{ sessionId: 's1', pid: 100 }]);
      expect(runs.list()).toEqual([]);

      writeFileSync(file, JSON.stringify({ version: 1, runs: [{ sessionId: 's1', pid: 'x' }] }));
      await runs.load([{ sessionId: 's1', pid: 100 }]);
      expect(runs.list()).toEqual([]);
    });
  });
});
