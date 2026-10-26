import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type HealthHourBucket,
  type HealthIncident,
  type HealthReport,
  type HealthSample,
  type HealthTrack,
  healthHoursFromSamples,
  INITIAL_HEALTH_TRACK,
  normalizeHealthInterval,
  normalizeHealthTimeout,
} from '@runova/core';
import { app } from 'electron';
import { z } from 'zod';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type { HealthTargetInput } from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import type { SealedSecretStore } from '../ssh/vault';
import { store } from '../store';

/**
 * Project healthchecks (E22) on disk: `health-targets.json` holds what the user set up, and
 * `health-results.json` what the probes found, both in the app's data folder beside the other
 * stores. The key or password of a target is only ever stored sealed with the Servers vault, and
 * moves with a passkey change. Every change goes through one queue, so a probe finishing while
 * the user edits a target cannot lose either.
 *
 * Results can be rebuilt by probing again, so a results file that does not parse reads as empty.
 * A targets file that does not parse is refused instead: writing over it would lose the setup.
 */

export interface StoredHealthTarget extends HealthTargetInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  secretEnvelope: SecretEnvelope | null;
  secretRotatedAt: number | null;
}

export interface HealthResultRecord {
  /** The last report, already redacted by the core parser. */
  report: HealthReport | null;
  /** Oldest first, at most HEALTH_MAX_SAMPLES. */
  samples: HealthSample[];
  /** Every check, rolled up by hour for 30 days, oldest first. Uptime and the charts read it. */
  hours: HealthHourBucket[];
  track: HealthTrack;
  /** Newest first, at most HEALTH_MAX_INCIDENTS. */
  incidents: HealthIncident[];
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
}

export interface HealthStoreState {
  targets: StoredHealthTarget[];
  /** By target id. */
  results: Record<string, HealthResultRecord>;
}

export const HEALTH_MAX_SAMPLES = 200;
export const HEALTH_MAX_INCIDENTS = 50;

const TARGETS_FILE = 'health-targets.json';
const RESULTS_FILE = 'health-results.json';
const MAX_NAME = 80;
const MAX_LABEL = 80;
const MAX_USER = 128;
const MAX_URL = 2048;

export function emptyHealthResult(): HealthResultRecord {
  return {
    report: null,
    samples: [],
    hours: [],
    track: { ...INITIAL_HEALTH_TRACK },
    incidents: [],
    lastCheckedAt: null,
    nextCheckAt: null,
  };
}

const envelopeSchema = z.union([
  z.object({ mode: z.literal('safeStorage'), ciphertext: z.string() }),
  z.object({
    mode: z.literal('passphrase'),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  }),
]);

const time = z.number().int().nonnegative();
const nullableText = z.string().nullable();

const targetSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1),
  environmentId: nullableText,
  name: z.string(),
  serverLabel: nullableText,
  serverLink: z
    .object({ kind: z.enum(['ssh', 'wordpress']), id: z.string().min(1).max(128) })
    .nullable(),
  url: z.string().max(MAX_URL),
  intervalSec: z.number(),
  timeoutSec: z.number(),
  authMode: z.enum(['bearer', 'basic']),
  basicUser: nullableText,
  allowInsecure: z.boolean(),
  autoDiagnose: z.boolean(),
  createdAt: time,
  updatedAt: time,
  paused: z.boolean(),
  secretEnvelope: envelopeSchema.nullable(),
  secretRotatedAt: time.nullable(),
});

const probeState = z.enum(['pass', 'warn', 'fail', 'unreachable', 'unauthorized', 'invalid']);

/** The report and incidents were checked when they were written; this only guards the shape. */
const resultSchema = z.object({
  report: z.object({ state: probeState, checkedAt: z.number() }).passthrough().nullable(),
  samples: z.array(
    z.object({ at: z.number(), state: probeState, latencyMs: z.number().nullable() }),
  ),
  // Missing from files written before hours were kept; built from the samples then.
  hours: z
    .array(
      z
        .object({
          start: z.number(),
          checks: z.number(),
          failures: z.number(),
          p50: z.number().nullable(),
          p95: z.number().nullable(),
        })
        .passthrough(),
    )
    .optional(),
  track: z.object({
    confirmed: z.enum(['ok', 'problem']).nullable(),
    streak: z.number(),
    pending: z.boolean(),
  }),
  incidents: z.array(z.object({ id: z.string(), targetId: z.string() }).passthrough()),
  lastCheckedAt: z.number().nullable(),
  nextCheckAt: z.number().nullable(),
});

function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

/** The parsed file, null when there is none, and `invalid` when it is not JSON. */
async function readJson(fileName: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir(), fileName), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return INVALID;
  }
}

const INVALID = Symbol('invalid');

/** Written to a temporary name and renamed over, readable only by the user. */
async function writeJson(fileName: string, value: unknown): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const path = join(dataDir(), fileName);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseTargets(value: unknown): StoredHealthTarget[] {
  if (value === INVALID) {
    throw new Error(`${TARGETS_FILE} is not valid JSON. Fix or remove it to use healthchecks.`);
  }
  if (!Array.isArray(value)) return [];
  const targets: StoredHealthTarget[] = [];
  for (const entry of value) {
    const parsed = targetSchema.safeParse(entry);
    if (parsed.success && !targets.some((target) => target.id === parsed.data.id)) {
      targets.push(parsed.data);
    }
  }
  return targets;
}

function parseResults(value: unknown): Record<string, HealthResultRecord> {
  const results: Record<string, HealthResultRecord> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return results;
  for (const [id, entry] of Object.entries(value)) {
    if (!resultSchema.safeParse(entry).success) continue;
    const record = entry as HealthResultRecord;
    if (!record.hours) record.hours = healthHoursFromSamples(record.samples);
    results[id] = record;
  }
  return results;
}

export async function readHealthTargets(): Promise<StoredHealthTarget[]> {
  await queue;
  return parseTargets(await readJson(TARGETS_FILE));
}

export async function readHealthState(): Promise<HealthStoreState> {
  await queue;
  return readUnqueued();
}

async function readUnqueued(): Promise<HealthStoreState> {
  return {
    targets: parseTargets(await readJson(TARGETS_FILE)),
    results: parseResults(await readJson(RESULTS_FILE)),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Reads both files, lets `change` edit them in place, and writes back whichever one changed.
 * Changes run one after another; one that throws writes nothing and does not stop the next.
 */
export function mutateHealth<T>(change: (state: HealthStoreState) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const state = await readUnqueued();
    const before = {
      targets: JSON.stringify(state.targets),
      results: JSON.stringify(state.results),
    };
    const result = await change(state);
    if (JSON.stringify(state.targets) !== before.targets)
      await writeJson(TARGETS_FILE, state.targets);
    if (JSON.stringify(state.results) !== before.results)
      await writeJson(RESULTS_FILE, state.results);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Tells every window these targets changed. */
export function broadcastHealthChanged(targetIds: string[]): void {
  if (targetIds.length === 0) return;
  broadcastToWindows(IPC.health.onChanged, { targetIds });
}

/** Moves every sealed key when the Servers passkey changes (see ssh/vault.ts). */
export const healthSealedKeys: SealedSecretStore = {
  prepare: async (move) => {
    const moved = new Map<string, SecretEnvelope>();
    for (const target of await readHealthTargets()) {
      if (target.secretEnvelope) moved.set(target.id, await move(target.secretEnvelope));
    }
    return () =>
      mutateHealth((state) => {
        for (const target of state.targets) {
          const next = moved.get(target.id);
          if (next) target.secretEnvelope = next;
        }
      });
  },
};

function cleanUrl(value: string): string {
  const text = String(value ?? '').trim();
  if (text.length > MAX_URL) throw new Error('That address is too long.');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Enter the full URL of the healthcheck, such as https://example.com/health.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The healthcheck URL must start with https:// (or http:// for this computer).');
  }
  if (url.username || url.password) {
    throw new Error(
      'Leave the username or password out of the URL. Pick HTTP Basic instead, and Runova sends them in a header.',
    );
  }
  return text;
}

function cleanOptional(value: string | null, max: number, what: string): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw new Error(`Keep the ${what} to ${max} characters.`);
  return text;
}

/**
 * Checks and tidies what the target dialog sent: the name and URL, the ranges, the Basic
 * username, and that the project and environment exist and belong together.
 */
export async function cleanHealthTargetInput(input: HealthTargetInput): Promise<HealthTargetInput> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('Give the healthcheck a name.');
  if (name.length > MAX_NAME) throw new Error(`Keep the name to ${MAX_NAME} characters.`);
  const url = cleanUrl(input.url);

  let basicUser: string | null = null;
  if (input.authMode === 'basic') {
    basicUser = String(input.basicUser ?? '').trim();
    if (!basicUser) throw new Error('HTTP Basic needs a username.');
    if (basicUser.length > MAX_USER) {
      throw new Error(`Keep the username to ${MAX_USER} characters.`);
    }
    if (basicUser.includes(':')) throw new Error('An HTTP Basic username cannot hold a colon.');
  }

  const project = (await store.getProjects()).find((p) => p.id === input.projectId);
  if (!project) throw new Error('That project no longer exists.');
  if (input.environmentId !== null) {
    const environment = (await store.getProjectEnvironments()).find(
      (e) => e.id === input.environmentId,
    );
    if (!environment) throw new Error('That environment no longer exists.');
    if (environment.projectId !== project.id) {
      throw new Error('That environment belongs to another project.');
    }
  }

  return {
    projectId: project.id,
    environmentId: input.environmentId,
    name,
    serverLabel: cleanOptional(input.serverLabel, MAX_LABEL, 'server name'),
    serverLink: input.serverLink ? { kind: input.serverLink.kind, id: input.serverLink.id } : null,
    url,
    intervalSec: normalizeHealthInterval(input.intervalSec),
    timeoutSec: normalizeHealthTimeout(input.timeoutSec),
    authMode: input.authMode === 'basic' ? 'basic' : 'bearer',
    basicUser,
    allowInsecure: input.allowInsecure === true,
    autoDiagnose: input.autoDiagnose === true,
  };
}

/**
 * Forgets the targets (and results) of deleted projects, and lets go of deleted environments
 * while keeping the target. Takes the ids just removed, and also sweeps against what is saved,
 * which is how it catches what a restored backup left behind at startup. Never throws: a disk
 * error leaves the orphans for the next sweep.
 */
export async function pruneOrphanHealthTargets(
  removed: { projectIds?: string[]; environmentIds?: string[] } = {},
): Promise<void> {
  try {
    const [projects, environments] = await Promise.all([
      store.getProjects(),
      store.getProjectEnvironments(),
    ]);
    const goneProjects = new Set(removed.projectIds ?? []);
    const goneEnvironments = new Set(removed.environmentIds ?? []);
    const liveProjects = new Set(projects.map((project) => project.id));
    const liveEnvironments = new Set(environments.map((environment) => environment.id));

    const changed = await mutateHealth((state) => {
      const ids: string[] = [];
      state.targets = state.targets.filter((target) => {
        if (liveProjects.has(target.projectId) && !goneProjects.has(target.projectId)) return true;
        ids.push(target.id);
        delete state.results[target.id];
        return false;
      });
      for (const target of state.targets) {
        const environmentId = target.environmentId;
        if (environmentId === null) continue;
        if (liveEnvironments.has(environmentId) && !goneEnvironments.has(environmentId)) continue;
        target.environmentId = null;
        ids.push(target.id);
      }
      return ids;
    });
    broadcastHealthChanged(changed);
  } catch {
    // Left for the next launch.
  }
}
