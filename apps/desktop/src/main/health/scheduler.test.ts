import type { HealthProbeState, HealthReport } from '@runova/core';
import { probeFailureReport } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { tempDir } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';
import { VaultLockedError } from '../ssh/vaultErrors';
import type { HealthTransition } from './alerts';
import type { HealthSchedulerDeps } from './scheduler';
import type { StoredHealthTarget } from './store';

/**
 * The scheduler decides when each target is probed and what a probe's result means: a sample on
 * the timeline, and an incident only once a change has been seen twice in a row. It never runs
 * more than four probes at once, leaves paused targets and archived projects alone, and waits
 * for the vault instead of recording a failure when the key is locked away.
 */

const userData = useTempUserData();
const T0 = 1_760_000_000_000;
const ENVELOPE: SecretEnvelope = { mode: 'safeStorage', ciphertext: 'ZW5jOnNlY3JldA==' };
let health: typeof import('./store');
let clock = T0;

function report(state: HealthProbeState, at = clock): HealthReport {
  return {
    state,
    httpStatus: state === 'pass' ? 200 : 503,
    latencyMs: 5,
    checkedAt: at,
    serviceId: null,
    description: null,
    releaseId: null,
    version: null,
    output: null,
    services:
      state === 'fail'
        ? [
            {
              key: 'postgres:connection',
              name: 'postgres',
              measurement: 'connection',
              componentId: null,
              componentType: null,
              status: 'fail',
              observedValue: null,
              observedUnit: null,
              time: null,
              error: {
                message: 'connect ECONNREFUSED',
                code: null,
                detail: null,
                stack: null,
                hint: null,
                since: null,
              },
            },
          ]
        : [],
    problem: null,
    raw: null,
  };
}

function target(id: string, overrides: Partial<StoredHealthTarget> = {}): StoredHealthTarget {
  return {
    id,
    projectId: 'p1',
    environmentId: null,
    name: id.toUpperCase(),
    serverLabel: null,
    serverLink: null,
    url: `https://${id}.example.com/health`,
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: true,
    createdAt: 1,
    updatedAt: 1,
    paused: false,
    secretEnvelope: ENVELOPE,
    secretRotatedAt: null,
    ...overrides,
  };
}

async function seed(...targets: StoredHealthTarget[]) {
  await health.mutateHealth((state) => {
    state.targets = targets;
  });
}

async function results(id: string) {
  return (await health.readHealthState()).results[id];
}

function harness(overrides: Partial<HealthSchedulerDeps> = {}) {
  const states = new Map<string, HealthProbeState[]>();
  const probe = vi.fn<HealthSchedulerDeps['probe']>(async (probed) => {
    const queue = states.get(probed.id) ?? [];
    return report(queue.length > 1 ? (queue.shift() as HealthProbeState) : (queue[0] ?? 'pass'));
  });
  const announce = vi.fn<(transition: HealthTransition) => Promise<void>>(async () => undefined);
  const diagnose = vi.fn(async (_targetId: string, _incidentId: string) => undefined);
  const changed = vi.fn();
  const listeners: (() => void)[] = [];
  const deps: HealthSchedulerDeps = {
    probe,
    unseal: async () => 'the-key',
    isLocked: () => false,
    announce,
    diagnose,
    changed,
    now: () => clock,
    random: () => 0,
    onUnlocked: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    ...overrides,
  };
  return {
    deps,
    probe,
    announce,
    diagnose,
    changed,
    listeners,
    /** The states the next probes of a target return, the last one repeating. */
    script: (id: string, ...next: HealthProbeState[]) => states.set(id, next),
  };
}

async function scheduler(deps: HealthSchedulerDeps) {
  const { createHealthScheduler } = await import('./scheduler');
  return createHealthScheduler(deps);
}

/** Probes whatever is due at `at` and waits for every result to land. */
async function tickAt(s: Awaited<ReturnType<typeof scheduler>>, at: number) {
  clock = at;
  await s.tick();
  await s.idle();
}

beforeEach(async () => {
  clock = T0;
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), archived: false, createdAt: '2026-01-01' },
    { id: 'p2', name: 'Old', folderPath: tempDir(), archived: true, createdAt: '2026-01-01' },
  ]);
  health = await import('./store');
});

describe('when targets are probed', () => {
  it('probes a new target and records the sample, the report and the next check', async () => {
    await seed(target('a'));
    const h = harness();
    const s = await scheduler(h.deps);
    await tickAt(s, T0);

    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.probe.mock.calls[0][1]).toBe('the-key');
    const record = await results('a');
    expect(record.samples).toEqual([{ at: T0, state: 'pass', latencyMs: 5 }]);
    expect(record.report?.state).toBe('pass');
    expect(record.lastCheckedAt).toBe(T0);
    expect(record.nextCheckAt).toBe(T0 + 60_000);
    expect(h.changed).toHaveBeenCalledWith(['a']);
  });

  it('counts each check in its hour, which outlives the 200-sample ring', async () => {
    await seed(target('a'));
    const s = await scheduler(harness().deps);
    await tickAt(s, T0);
    const [hour] = (await results('a')).hours;
    expect(hour).toMatchObject({ checks: 1, failures: 0, p50: 5, p95: 5 });
    expect(hour.start).toBeLessThanOrEqual(T0);
    expect(T0 - hour.start).toBeLessThan(3_600_000);
  });

  it('keeps each target on its own interval', async () => {
    await seed(target('fast', { intervalSec: 15 }), target('slow', { intervalSec: 60 }));
    const h = harness();
    const s = await scheduler(h.deps);
    const probed = () => h.probe.mock.calls.map(([one]) => one.id);

    await tickAt(s, T0);
    expect(probed()).toEqual(['fast', 'slow']);
    await tickAt(s, T0 + 10_000);
    expect(probed()).toHaveLength(2);
    await tickAt(s, T0 + 16_000);
    expect(probed().slice(2)).toEqual(['fast']);
    await tickAt(s, T0 + 61_000);
    expect(probed().slice(3)).toEqual(['fast', 'slow']);
  });

  it('runs at most four probes at once and starts the rest as slots free up', async () => {
    await seed(...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => target(id)));
    const pending: ((value: HealthReport) => void)[] = [];
    const h = harness({
      probe: vi.fn(() => new Promise<HealthReport>((resolve) => pending.push(resolve))),
    });
    const s = await scheduler(h.deps);
    await s.tick();
    expect(h.deps.probe).toHaveBeenCalledTimes(4);

    pending[0](report('pass'));
    await vi.waitFor(() => expect(h.deps.probe).toHaveBeenCalledTimes(5));
    pending[1](report('pass'));
    await vi.waitFor(() => expect(h.deps.probe).toHaveBeenCalledTimes(6));
    for (const resolve of pending.slice(2)) resolve(report('pass'));
    await s.idle();
    expect(Object.keys((await health.readHealthState()).results).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('leaves paused targets, archived projects and missing projects alone', async () => {
    await seed(
      target('paused', { paused: true }),
      target('archived', { projectId: 'p2' }),
      target('orphan', { projectId: 'gone' }),
      target('live'),
    );
    const h = harness();
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    expect(h.probe.mock.calls.map(([one]) => one.id)).toEqual(['live']);
  });

  it('keeps the newest 200 samples', async () => {
    await seed(target('a'));
    await health.mutateHealth((state) => {
      state.results.a = {
        ...health.emptyHealthResult(),
        samples: Array.from({ length: 200 }, (_, index) => ({
          at: index,
          state: 'pass' as const,
          latencyMs: 1,
        })),
      };
    });
    const s = await scheduler(harness().deps);
    await tickAt(s, T0);
    const { samples } = await results('a');
    expect(samples).toHaveLength(200);
    expect(samples[0].at).toBe(1);
    expect(samples[199].at).toBe(T0);
  });

  it('records a target with no key, or a key that cannot be read, as invalid', async () => {
    await seed(target('nokey', { secretEnvelope: null }), target('broken'));
    const h = harness({
      unseal: async () => {
        throw new Error('safeStorage cannot decrypt');
      },
    });
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    expect(h.probe).not.toHaveBeenCalled();
    expect((await results('nokey')).report).toMatchObject({ state: 'invalid' });
    expect((await results('nokey')).report?.problem).toMatch(/no key/);
    expect((await results('broken')).report?.problem).toMatch(/could not be read/);
  });

  it('records nothing for a target removed while it was probed', async () => {
    await seed(target('a'));
    let release!: (value: HealthReport) => void;
    const h = harness({ probe: vi.fn(() => new Promise<HealthReport>((r) => (release = r))) });
    const s = await scheduler(h.deps);
    await s.tick();
    await seed();
    release(report('pass'));
    await s.idle();
    expect(await results('a')).toBeUndefined();
  });
});

describe('a locked vault', () => {
  it('skips the target with no sample, and probes it once the vault opens', async () => {
    await seed(target('a'));
    let locked = true;
    const h = harness({ isLocked: () => locked });
    const s = await scheduler(h.deps);
    s.start();
    await s.idle();
    expect(h.probe).not.toHaveBeenCalled();
    expect(await results('a')).toBeUndefined();
    await expect(s.checkNow('a')).rejects.toThrow(/locked/);

    locked = false;
    for (const listener of h.listeners) listener();
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    await s.idle();
    s.stop();
    expect(h.listeners).toHaveLength(0);
  });

  it('treats a VaultLockedError while unsealing the same way, until the vault opens', async () => {
    await seed(target('a'));
    const unseal = vi.fn(async (): Promise<string> => {
      throw new VaultLockedError();
    });
    const h = harness({ unseal });
    const s = await scheduler(h.deps);
    s.start();
    await s.idle();
    await tickAt(s, T0 + 60_000);
    expect(unseal).toHaveBeenCalledOnce();
    expect(h.probe).not.toHaveBeenCalled();
    expect(await results('a')).toBeUndefined();

    unseal.mockResolvedValue('the-key');
    for (const listener of h.listeners) listener();
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    await s.idle();
    s.stop();
  });

  it('waits a little before retrying a target whose result could not be recorded', async () => {
    await seed(target('a'));
    const h = harness();
    h.probe.mockRejectedValueOnce(new Error('disk full'));
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    await tickAt(s, T0 + 10_000);
    expect(h.probe).toHaveBeenCalledOnce();
    await tickAt(s, T0 + 31_000);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect((await results('a')).samples).toHaveLength(1);
  });
});

describe('incidents', () => {
  it('ignores a single bad sample and rechecks it sooner', async () => {
    await seed(target('a', { intervalSec: 300 }));
    const h = harness();
    h.script('a', 'pass', 'fail', 'pass');
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    await tickAt(s, T0 + 300_000);
    expect((await results('a')).nextCheckAt).toBe(T0 + 300_000 + 15_000);
    await tickAt(s, T0 + 315_000);

    const record = await results('a');
    expect(record.samples.map((sample) => sample.state)).toEqual(['pass', 'fail', 'pass']);
    expect(record.incidents).toEqual([]);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it('opens an incident on the second bad sample, announces it once and diagnoses it', async () => {
    await seed(target('a', { intervalSec: 15 }));
    const h = harness();
    h.script('a', 'pass', 'fail');
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    await tickAt(s, T0 + 15_000);
    await tickAt(s, T0 + 30_000);
    await tickAt(s, T0 + 45_000);

    const [incident, ...rest] = (await results('a')).incidents;
    expect(rest).toEqual([]);
    expect(incident).toMatchObject({
      targetId: 'a',
      openedAt: T0 + 30_000,
      resolvedAt: null,
      state: 'fail',
      summary: 'postgres:connection: connect ECONNREFUSED',
      failingServices: ['postgres:connection'],
      diagnosis: null,
    });
    expect(h.announce).toHaveBeenCalledOnce();
    expect(h.announce.mock.calls[0][0]).toMatchObject({
      kind: 'opened',
      target: { id: 'a' },
      project: { id: 'p1' },
      incident: { id: incident.id },
    });
    expect(h.diagnose).toHaveBeenCalledWith('a', incident.id);
  });

  it('resolves the incident on the second good sample and announces that', async () => {
    await seed(target('a', { intervalSec: 15 }));
    const h = harness();
    h.script('a', 'unreachable', 'unreachable', 'pass');
    const s = await scheduler(h.deps);
    for (let step = 0; step < 4; step++) await tickAt(s, T0 + step * 15_000);

    const [incident] = (await results('a')).incidents;
    expect(incident.openedAt).toBe(T0 + 15_000);
    expect(incident.resolvedAt).toBe(T0 + 45_000);
    expect(h.announce.mock.calls.map(([event]) => event.kind)).toEqual(['opened', 'resolved']);
    expect(h.diagnose).toHaveBeenCalledOnce();
  });

  it('sums up a probe problem when there is no failing service', async () => {
    await seed(target('a'));
    const h = harness({
      probe: vi.fn(async () => probeFailureReport('Timed out after 10 s.', clock)),
    });
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    await tickAt(s, T0 + 15_000);
    expect((await results('a')).incidents[0]).toMatchObject({
      state: 'unreachable',
      summary: 'Timed out after 10 s.',
      failingServices: [],
    });
  });

  it('keeps the newest 50 incidents', async () => {
    await seed(target('a'));
    await health.mutateHealth((state) => {
      state.results.a = {
        ...health.emptyHealthResult(),
        track: { confirmed: 'ok', streak: 1, pending: true },
        incidents: Array.from({ length: 50 }, (_, index) => ({
          id: `old-${index}`,
          targetId: 'a',
          openedAt: index,
          resolvedAt: index + 1,
          state: 'fail' as const,
          summary: 'x',
          failingServices: [],
          diagnosis: null,
        })),
      };
    });
    const h = harness();
    h.script('a', 'fail');
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    const { incidents } = await results('a');
    expect(incidents).toHaveLength(50);
    expect(incidents[0].openedAt).toBe(T0);
    expect(incidents[49].id).toBe('old-48');
  });

  it('keeps recording when announcing or diagnosing fails', async () => {
    await seed(target('a', { intervalSec: 15 }));
    const h = harness({
      announce: vi.fn(async () => {
        throw new Error('no notifications');
      }),
      diagnose: vi.fn(async () => {
        throw new Error('no cli');
      }),
    });
    h.script('a', 'fail');
    const s = await scheduler(h.deps);
    await tickAt(s, T0);
    await tickAt(s, T0 + 15_000);
    await tickAt(s, T0 + 30_000);
    expect((await results('a')).samples).toHaveLength(3);
  });
});

describe('checkNow', () => {
  it('probes right away, even a paused target that is not due', async () => {
    await seed(target('a', { paused: true }));
    const h = harness();
    const s = await scheduler(h.deps);
    await s.checkNow('a');
    expect(h.probe).toHaveBeenCalledOnce();
    expect((await results('a')).samples).toHaveLength(1);
  });

  it('waits for a probe already running instead of starting another', async () => {
    await seed(target('a'));
    let release!: (value: HealthReport) => void;
    const h = harness({ probe: vi.fn(() => new Promise<HealthReport>((r) => (release = r))) });
    const s = await scheduler(h.deps);
    await s.tick();
    const checked = s.checkNow('a');
    release(report('pass'));
    await checked;
    expect(h.deps.probe).toHaveBeenCalledOnce();
    expect((await results('a')).samples).toHaveLength(1);
  });

  it('refuses a target that does not exist', async () => {
    const s = await scheduler(harness().deps);
    await expect(s.checkNow('nope')).rejects.toThrow(/no longer exists/);
  });
});

describe('start and stop', () => {
  it('ticks right away and then on the interval, until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await seed(target('a', { intervalSec: 15 }));
    const h = harness({ tickMs: 5_000 });
    const s = await scheduler(h.deps);
    s.start();
    s.start();
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    await s.idle();

    clock = T0 + 16_000;
    vi.advanceTimersByTime(5_000);
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledTimes(2));
    await s.idle();

    s.stop();
    s.stop();
    clock = T0 + 60_000;
    vi.advanceTimersByTime(20_000);
    await s.idle();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it('runs one more pass when asked while a pass is running', async () => {
    await seed(target('a'));
    const h = harness();
    const s = await scheduler(h.deps);
    const first = s.tick();
    await seed(target('a'), target('b'));
    const second = s.tick();
    await Promise.all([first, second]);
    await s.idle();
    expect(h.probe.mock.calls.map(([one]) => one.id).sort()).toEqual(['a', 'b']);
  });
});
