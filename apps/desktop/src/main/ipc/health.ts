import { randomUUID } from 'node:crypto';
import {
  buildHealthFixPrompt,
  buildHealthSetupPrompt,
  buildHealthSpecMarkdown,
  HEALTH_DEFAULT_PATH,
  HEALTH_ENV,
  type HealthAuthMode,
} from '@runova/core';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { z } from 'zod';
import type {
  HealthCreateResult,
  HealthSecretReveal,
  HealthSetupPrompt,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import { healthDiagnoser } from '../health/diagnose';
import { getHealthScheduler } from '../health/scheduler';
import {
  broadcastHealthChanged,
  cleanHealthTargetInput,
  type HealthResultRecord,
  healthSealedKeys,
  mutateHealth,
  readHealthState,
  type StoredHealthTarget,
} from '../health/store';
import { toHealthDetail, toHealthSummary } from '../health/summary';
import { generateHealthPassword, generateHealthToken, sha256Hex } from '../health/token';
import { encryptSecret, isLockedEnvelope, registerSealedSecretStore } from '../ssh/vault';
import { store } from '../store';

/**
 * The Health page's channels (E22). Every argument is checked here before anything reads it. A
 * target's key or password is generated here, sealed with the Servers vault at once, and shown
 * exactly once, by create and by rotate; every other answer only says whether there is one.
 */

const id = z.string().min(1).max(128);

const inputSchema = z.object({
  projectId: id,
  environmentId: id.nullable(),
  name: z.string().max(500),
  serverLabel: z.string().max(500).nullable(),
  serverLink: z.object({ kind: z.enum(['ssh', 'wordpress']), id }).nullable(),
  url: z.string().max(4096),
  intervalSec: z.number(),
  timeoutSec: z.number(),
  authMode: z.enum(['bearer', 'basic']),
  basicUser: z.string().max(500).nullable(),
  allowInsecure: z.boolean(),
  autoDiagnose: z.boolean(),
});

const patchSchema = inputSchema.partial();
const filterSchema = z.object({ projectId: id.optional() }).optional();

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join('.');
  throw new Error(`That healthcheck ${what} is not valid${field ? ` (${field})` : ''}.`);
}

const targetId = (value: unknown) => parse(id, value, 'id');

function inputOf(target: StoredHealthTarget): HealthTargetInput {
  return {
    projectId: target.projectId,
    environmentId: target.environmentId,
    name: target.name,
    serverLabel: target.serverLabel,
    serverLink: target.serverLink,
    url: target.url,
    intervalSec: target.intervalSec,
    timeoutSec: target.timeoutSec,
    authMode: target.authMode,
    basicUser: target.basicUser,
    allowInsecure: target.allowInsecure,
    autoDiagnose: target.autoDiagnose,
  };
}

function context(target: StoredHealthTarget) {
  return { now: Date.now(), locked: isLockedEnvelope(target.secretEnvelope ?? undefined) };
}

function summary(target: StoredHealthTarget, result: HealthResultRecord | undefined) {
  return toHealthSummary(target, result, context(target));
}

function findTarget(targets: StoredHealthTarget[], targetId: string): StoredHealthTarget {
  const target = targets.find((one) => one.id === targetId);
  if (!target) throw new Error('That healthcheck no longer exists.');
  return target;
}

async function detail(targetId: string): Promise<HealthTargetDetail | null> {
  const { targets, results } = await readHealthState();
  const target = targets.find((one) => one.id === targetId);
  return target ? toHealthDetail(target, results[target.id], context(target)) : null;
}

function newSecret(authMode: HealthAuthMode): string {
  return authMode === 'basic' ? generateHealthPassword() : generateHealthToken();
}

function reveal(target: StoredHealthTarget, secret: string): HealthSecretReveal {
  return {
    targetId: target.id,
    authMode: target.authMode,
    secret,
    sha256: sha256Hex(secret),
    basicUser: target.basicUser,
    hashEnvVar: target.authMode === 'basic' ? HEALTH_ENV.passwordHash : HEALTH_ENV.tokenHash,
  };
}

async function environmentName(target: StoredHealthTarget): Promise<string | null> {
  if (!target.environmentId) return null;
  const environments = await store.getProjectEnvironments();
  return environments.find((one) => one.id === target.environmentId)?.name ?? null;
}

async function projectName(target: StoredHealthTarget): Promise<string> {
  const project = (await store.getProjects()).find((one) => one.id === target.projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project.name;
}

export interface HealthHandlerOptions {
  /** True for the windows that may use these channels (the main window, in the app). */
  guard?: (event: IpcMainInvokeEvent) => boolean;
}

export function registerHealthHandlers(options: HealthHandlerOptions = {}): void {
  registerSealedSecretStore(healthSealedKeys);

  const handle = (channel: string, listener: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (options.guard && !options.guard(event)) {
        throw new Error('Healthchecks answer only the main window.');
      }
      return listener(...args);
    });
  };

  handle(IPC.health.list, async (filter): Promise<HealthTargetSummary[]> => {
    const projectId = parse(filterSchema, filter, 'filter')?.projectId;
    const { targets, results } = await readHealthState();
    return targets
      .filter((target) => projectId === undefined || target.projectId === projectId)
      .map((target) => summary(target, results[target.id]));
  });

  handle(IPC.health.get, (value) => detail(targetId(value)));

  handle(IPC.health.create, async (value): Promise<HealthCreateResult> => {
    const input = await cleanHealthTargetInput(parse(inputSchema, value, 'setup'));
    const secret = newSecret(input.authMode);
    const now = Date.now();
    const target: StoredHealthTarget = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      paused: false,
      secretEnvelope: await encryptSecret(secret),
      secretRotatedAt: null,
    };
    await mutateHealth((state) => {
      state.targets.push(target);
    });
    broadcastHealthChanged([target.id]);
    return { target: summary(target, undefined), secret: reveal(target, secret) };
  });

  handle(IPC.health.update, async (value, patchValue): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    const patch = parse(patchSchema, patchValue, 'change');
    const updated = await mutateHealth(async (state) => {
      const target = findTarget(state.targets, idValue);
      Object.assign(target, await cleanHealthTargetInput({ ...inputOf(target), ...patch }));
      target.updatedAt = Date.now();
      // New settings are worth seeing at once rather than at the end of the old interval.
      const result = state.results[target.id];
      if (result) result.nextCheckAt = null;
      return summary(target, result);
    });
    broadcastHealthChanged([idValue]);
    return updated;
  });

  handle(IPC.health.remove, async (value): Promise<void> => {
    const idValue = targetId(value);
    healthDiagnoser.cancel(idValue);
    await mutateHealth((state) => {
      state.targets = state.targets.filter((target) => target.id !== idValue);
      delete state.results[idValue];
    });
    broadcastHealthChanged([idValue]);
  });

  handle(IPC.health.setPaused, async (value, pausedValue): Promise<HealthTargetSummary> => {
    const idValue = targetId(value);
    const paused = parse(z.boolean(), pausedValue, 'pause switch');
    const updated = await mutateHealth((state) => {
      const target = findTarget(state.targets, idValue);
      target.paused = paused;
      target.updatedAt = Date.now();
      const result = state.results[target.id];
      if (!paused && result) result.nextCheckAt = null;
      return summary(target, result);
    });
    broadcastHealthChanged([idValue]);
    return updated;
  });

  handle(IPC.health.checkNow, async (value): Promise<HealthTargetDetail> => {
    const idValue = targetId(value);
    await getHealthScheduler().checkNow(idValue);
    const found = await detail(idValue);
    if (!found) throw new Error('That healthcheck no longer exists.');
    return found;
  });

  handle(IPC.health.rotateSecret, async (value): Promise<HealthSecretReveal> => {
    const idValue = targetId(value);
    const current = findTarget((await readHealthState()).targets, idValue);
    const secret = newSecret(current.authMode);
    const envelope = await encryptSecret(secret);
    const rotated = await mutateHealth((state) => {
      const target = findTarget(state.targets, idValue);
      if (target.authMode !== current.authMode) {
        throw new Error('The target changed while the key was made. Try again.');
      }
      target.secretEnvelope = envelope;
      target.secretRotatedAt = Date.now();
      target.updatedAt = target.secretRotatedAt;
      return target;
    });
    broadcastHealthChanged([idValue]);
    return reveal(rotated, secret);
  });

  handle(IPC.health.setupPrompt, async (value): Promise<HealthSetupPrompt> => {
    const target = findTarget((await readHealthState()).targets, targetId(value));
    let path = HEALTH_DEFAULT_PATH;
    try {
      const pathname = new URL(target.url).pathname;
      if (pathname && pathname !== '/') path = pathname;
    } catch {
      // The URL was checked when it was saved; the default path is a fine fallback.
    }
    return {
      prompt: buildHealthSetupPrompt({
        projectName: await projectName(target),
        environmentName: await environmentName(target),
        serverLabel: target.serverLabel,
        path,
        authMode: target.authMode,
      }),
      spec: buildHealthSpecMarkdown(),
    };
  });

  handle(IPC.health.spec, () => buildHealthSpecMarkdown());

  handle(IPC.health.fixPrompt, async (value): Promise<string | null> => {
    const { targets, results } = await readHealthState();
    const target = findTarget(targets, targetId(value));
    const result = results[target.id];
    if (!result?.report) return null;
    const incident =
      result.incidents.find((one) => one.resolvedAt === null) ?? result.incidents[0] ?? null;
    const diagnosis = incident?.diagnosis?.status === 'done' ? incident.diagnosis.text : null;
    return buildHealthFixPrompt({
      projectName: await projectName(target),
      targetName: target.name,
      environmentName: await environmentName(target),
      serverLabel: target.serverLabel,
      url: target.url,
      report: result.report,
      diagnosis,
    });
  });

  handle(IPC.health.diagnoseNow, (value) => healthDiagnoser.diagnoseNow(targetId(value)));

  handle(IPC.health.cancelDiagnose, (value) => {
    healthDiagnoser.cancel(targetId(value));
  });
}
