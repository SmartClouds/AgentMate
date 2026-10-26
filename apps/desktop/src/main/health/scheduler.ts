import { randomUUID } from 'node:crypto';
import {
  addHealthSampleToHours,
  type HealthIncident,
  type HealthReport,
  type HealthSample,
  healthNextDelayMs,
  nextHealthTrack,
  probeFailureReport,
} from '@runova/core';
import { net } from 'electron';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { decryptSecret, isLockedEnvelope, onVaultUnlocked } from '../ssh/vault';
import { VaultLockedError } from '../ssh/vaultErrors';
import { store } from '../store';
import { announceHealthTransition, type HealthTransition } from './alerts';
import { healthDiagnoser } from './diagnose';
import { probeHealthTarget } from './probe';
import {
  broadcastHealthChanged,
  emptyHealthResult,
  HEALTH_MAX_INCIDENTS,
  HEALTH_MAX_SAMPLES,
  mutateHealth,
  readHealthState,
  type StoredHealthTarget,
} from './store';
import { healthHeadline } from './summary';

/**
 * When each healthcheck target is probed (E22), and what a probe means. Every few seconds the
 * scheduler starts the targets that are due, at most four at a time. Each result is a sample on
 * the target's timeline; a change of state has to be seen twice in a row before it opens or
 * resolves an incident, and only those transitions are announced and diagnosed.
 *
 * Paused targets and archived projects are left alone. A key sealed under a locked Servers
 * passkey is waited for, not recorded as a failure: the target shows as locked, and the vault
 * opening wakes the scheduler.
 */

export interface HealthSchedulerDeps {
  probe: (target: StoredHealthTarget, secret: string) => Promise<HealthReport>;
  unseal: (envelope: SecretEnvelope) => Promise<string>;
  isLocked: (envelope: SecretEnvelope | undefined) => boolean;
  announce: (transition: HealthTransition) => Promise<void>;
  diagnose: (targetId: string, incidentId: string) => Promise<void>;
  changed?: (targetIds: string[]) => void;
  /** Runs the listener whenever the vault opens; returns a function that stops it. */
  onUnlocked?: (listener: () => void) => () => void;
  now?: () => number;
  random?: () => number;
  tickMs?: number;
  maxInFlight?: number;
}

const DEFAULT_TICK_MS = 5_000;
const MAX_IN_FLIGHT = 4;
/** How long a target whose result could not be recorded waits before the next try. */
const RETRY_AFTER_FAILURE_MS = 30_000;

/** Why a target was not probed, so nothing about it is recorded. */
class SkipProbe extends Error {}

export function createHealthScheduler(deps: HealthSchedulerDeps) {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const changed = deps.changed ?? broadcastHealthChanged;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const inFlight = new Map<string, Promise<void>>();
  let timer: NodeJS.Timeout | null = null;
  let stopUnlocked: (() => void) | null = null;
  let ticking: Promise<void> | null = null;
  /** Set when a pass is asked for while one runs, so a target added meanwhile is not missed. */
  let tickAgain = false;
  /**
   * Targets that ended without a result, by the time before which they are not started again:
   * forever for a key the vault holds (until it opens), a short while after a failed write.
   * Without it a target that is due but cannot be recorded would restart the moment it ends.
   */
  const held = new Map<string, number>();

  async function secretFor(target: StoredHealthTarget): Promise<string | HealthReport> {
    if (!target.secretEnvelope) {
      return probeFailureReport(
        'This target has no key. Make a new one with "Rotate key".',
        now(),
        'invalid',
      );
    }
    if (deps.isLocked(target.secretEnvelope)) throw new SkipProbe();
    try {
      return await deps.unseal(target.secretEnvelope);
    } catch (error) {
      // By name, since a copy of the vault module loaded elsewhere has its own class.
      if ((error as Error | null)?.name === 'VaultLockedError') throw new SkipProbe();
      return probeFailureReport(
        'The saved key could not be read on this computer. Make a new one with "Rotate key".',
        now(),
        'invalid',
      );
    }
  }

  /** Adds the probe's result to the target's record; returns the transition it caused. */
  function record(targetId: string, report: HealthReport) {
    return mutateHealth((state): Omit<HealthTransition, 'project'> | null => {
      const target = state.targets.find((one) => one.id === targetId);
      if (!target) return null;
      const result = state.results[targetId] ?? emptyHealthResult();
      state.results[targetId] = result;
      const at = now();

      const sample: HealthSample = {
        at: report.checkedAt,
        state: report.state,
        latencyMs: report.latencyMs,
      };
      result.samples = [...result.samples, sample].slice(-HEALTH_MAX_SAMPLES);
      result.hours = addHealthSampleToHours(result.hours, sample);
      result.report = report;
      result.lastCheckedAt = report.checkedAt;
      const step = nextHealthTrack(result.track, report.state);
      result.track = step.track;
      result.nextCheckAt = at + healthNextDelayMs(target.intervalSec, step.track.pending, random);

      if (step.opened) {
        const incident: HealthIncident = {
          id: randomUUID(),
          targetId,
          openedAt: at,
          resolvedAt: null,
          state: report.state,
          summary: healthHeadline(report) ?? `The healthcheck reported ${report.state}.`,
          failingServices: report.services
            .filter((service) => service.status === 'fail')
            .map((service) => service.key),
          diagnosis: null,
        };
        result.incidents = [incident, ...result.incidents].slice(0, HEALTH_MAX_INCIDENTS);
        return { kind: 'opened', target, incident };
      }
      if (step.resolved) {
        const incident = result.incidents.find((one) => one.resolvedAt === null);
        if (!incident) return null;
        incident.resolvedAt = at;
        return { kind: 'resolved', target, incident };
      }
      return null;
    });
  }

  async function announce(transition: Omit<HealthTransition, 'project'>): Promise<void> {
    const project = (await store.getProjects()).find(
      (one) => one.id === transition.target.projectId,
    );
    if (!project) return;
    try {
      await deps.announce({ ...transition, project });
    } catch {
      // A notification that could not be shown must not stop the record or the diagnosis.
    }
    if (transition.kind !== 'opened') return;
    try {
      await deps.diagnose(transition.target.id, transition.incident.id);
    } catch {
      // Same: the incident stands without its analysis.
    }
  }

  async function probeOnce(target: StoredHealthTarget): Promise<void> {
    let secret: string | HealthReport;
    try {
      secret = await secretFor(target);
    } catch (error) {
      if (!(error instanceof SkipProbe)) throw error;
      held.set(target.id, Number.POSITIVE_INFINITY);
      return;
    }
    const report = typeof secret === 'string' ? await deps.probe(target, secret) : secret;
    const transition = await record(target.id, report);
    changed([target.id]);
    if (transition) await announce(transition);
  }

  /** Starts the probe of a target and keeps track of it until its result is recorded. */
  function launch(target: StoredHealthTarget): Promise<void> {
    held.delete(target.id);
    const run = probeOnce(target)
      .catch(() => {
        // Nothing was recorded, so nextCheckAt did not move: try again in a little while.
        held.set(target.id, now() + RETRY_AFTER_FAILURE_MS);
      })
      .finally(() => {
        inFlight.delete(target.id);
        // A slot just freed up for whatever is waiting.
        void tick();
      });
    inFlight.set(target.id, run);
    return run;
  }

  async function pass(): Promise<void> {
    const [{ targets, results }, projects] = await Promise.all([
      readHealthState(),
      store.getProjects(),
    ]);
    const live = new Map(projects.map((project) => [project.id, project]));
    const at = now();
    for (const target of targets) {
      if (inFlight.size >= maxInFlight) return;
      if (target.paused || inFlight.has(target.id)) continue;
      if ((held.get(target.id) ?? 0) > at) continue;
      const project = live.get(target.projectId);
      if (!project || project.archived) continue;
      if (deps.isLocked(target.secretEnvelope ?? undefined)) continue;
      const due = results[target.id]?.nextCheckAt ?? null;
      if (due !== null && due > at) continue;
      launch(target);
    }
  }

  function tick(): Promise<void> {
    if (ticking) {
      tickAgain = true;
      return ticking;
    }
    ticking = (async () => {
      try {
        do {
          tickAgain = false;
          await pass();
        } while (tickAgain);
      } catch {
        // The files could not be read this time; the next tick tries again.
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  return {
    tick,

    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, deps.tickMs ?? DEFAULT_TICK_MS);
      timer.unref?.();
      stopUnlocked =
        deps.onUnlocked?.(() => {
          for (const [id, until] of held) {
            if (until === Number.POSITIVE_INFINITY) held.delete(id);
          }
          void tick();
        }) ?? null;
      void tick();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      stopUnlocked?.();
      stopUnlocked = null;
    },

    /** Probes the target now (or waits for the probe already running) and records it. */
    async checkNow(targetId: string): Promise<void> {
      const running = inFlight.get(targetId);
      if (running) return running;
      const target = (await readHealthState()).targets.find((one) => one.id === targetId);
      if (!target) throw new Error('That healthcheck no longer exists.');
      if (target.secretEnvelope && deps.isLocked(target.secretEnvelope)) {
        throw new VaultLockedError();
      }
      return launch(target);
    },

    /** Resolves once no pass and no probe is running. */
    async idle(): Promise<void> {
      while (ticking || inFlight.size > 0) {
        await Promise.all([ticking, ...inFlight.values()]);
      }
    },
  };
}

export type HealthScheduler = ReturnType<typeof createHealthScheduler>;

function tickMs(): number {
  const override = Number(process.env.RUNOVA_HEALTH_TICK_MS);
  return Number.isFinite(override) && override >= 50 ? override : DEFAULT_TICK_MS;
}

let shared: HealthScheduler | null = null;

/** The app's scheduler: Electron's network stack, the vault, notifications and the diagnosis. */
export function getHealthScheduler(): HealthScheduler {
  shared ??= createHealthScheduler({
    probe: (target, secret) =>
      probeHealthTarget(target, secret, { transport: (url, init) => net.fetch(url, init) }),
    unseal: decryptSecret,
    isLocked: isLockedEnvelope,
    announce: announceHealthTransition,
    diagnose: (targetId, incidentId) => healthDiagnoser.onIncidentOpened(targetId, incidentId),
    onUnlocked: onVaultUnlocked,
    tickMs: tickMs(),
  });
  return shared;
}

export function startHealthScheduler(): void {
  getHealthScheduler().start();
}

export function stopHealthScheduler(): void {
  shared?.stop();
}
