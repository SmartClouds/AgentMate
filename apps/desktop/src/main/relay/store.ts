import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_RELAY_OPTIONS,
  normalizeDocsFolder,
  parseScopeId,
  type RelayLegRecord,
  type RelayOptions,
  type RelayState,
} from '@agentmat/core';
import { app } from 'electron';
import { z } from 'zod';
import type { RelayProjectSettings, RelaySettingsPatch } from '../../shared/relayTypes';
import { store } from '../store';
import { findProjectScope } from '../worktrees/resolve';

/**
 * Relay (E26) on disk: `relay.json` in the app's data folder. Per project it holds the run choices
 * (settings), the relays (the core reducer's state, saved after every step) and the history of the
 * sessions run on its tasks. The tasks themselves live in the project as Markdown files.
 *
 * Everything here can be rebuilt by running again, so a file that does not parse reads as empty.
 */

const FILE = 'relay.json';
export const RELAY_MAX_LEG_RECORDS = 200;
/** Finished relays kept per project; the live one is never dropped. */
const MAX_RELAYS = 20;

interface ProjectRelayData {
  settings?: RelayProjectSettings;
  relays: RelayState[];
  legs: RelayLegRecord[];
}

interface RelayFile {
  version: 1;
  projects: Record<string, ProjectRelayData>;
}

const choiceSchema = z.object({
  cliId: z.string().min(1).max(64),
  model: z.string().max(200).nullable(),
  effort: z.string().max(40).nullable(),
  autoSize: z.boolean(),
});

const optionsSchema = z.object({
  planFirst: z.boolean(),
  afterPlanMode: z.enum(['auto', 'acceptEdits']),
  maxLegsPerTask: z.number().int().min(1).max(50),
  guardShare: z.number().min(0.2).max(0.98),
  whenStuck: z.enum(['pause', 'continue']),
  commitPerTask: z.boolean(),
  closeFinishedTabs: z.boolean(),
  defaultBudget: z.number().int().min(10_000).max(10_000_000),
});

const overrideSchema = z.object({
  cliId: z.string().min(1).max(64).optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  autoSize: z.boolean().optional(),
  planFirst: z.boolean().optional(),
});

const settingsSchema = z.object({
  docsFolder: z.string(),
  defaults: choiceSchema,
  overrides: z.record(z.string().regex(/^T\d{3,}$/), overrideSchema),
  options: optionsSchema,
});

/** Our own writes; the shape is only guarded, not re-validated field by field. */
const relaySchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    status: z.enum(['waiting', 'running', 'paused', 'done', 'cancelled']),
    queue: z.array(z.string()),
    createdAt: z.number(),
  })
  .passthrough();

const legSchema = z
  .object({ legId: z.string(), relayId: z.string(), taskId: z.string(), legNo: z.number() })
  .passthrough();

export const settingsPatchSchema = z
  .object({
    docsFolder: z.string().max(260).optional(),
    defaults: choiceSchema.partial().optional(),
    overrides: z.record(z.string().regex(/^T\d{3,}$/), overrideSchema).optional(),
    options: optionsSchema.partial().optional(),
  })
  .strict();

function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

function emptyFile(): RelayFile {
  return { version: 1, projects: {} };
}

function parseFile(value: unknown): RelayFile {
  const file = emptyFile();
  const projects =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { projects?: unknown }).projects
      : null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return file;
  for (const [projectId, raw] of Object.entries(projects as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const settings = settingsSchema.safeParse(entry.settings);
    const relays = Array.isArray(entry.relays)
      ? entry.relays.filter((relay) => relaySchema.safeParse(relay).success)
      : [];
    const legs = Array.isArray(entry.legs)
      ? entry.legs.filter((leg) => legSchema.safeParse(leg).success)
      : [];
    file.projects[projectId] = {
      ...(settings.success ? { settings: settings.data as RelayProjectSettings } : {}),
      relays: relays as RelayState[],
      legs: legs as RelayLegRecord[],
    };
  }
  return file;
}

async function readUnqueued(): Promise<RelayFile> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir(), FILE), 'utf-8');
  } catch {
    return emptyFile();
  }
  try {
    return parseFile(JSON.parse(raw));
  } catch {
    return emptyFile();
  }
}

async function writeUnqueued(file: RelayFile): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const path = join(dataDir(), FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Reads the file, lets `change` edit it, and writes it back when it changed. One at a time. */
function mutate<T>(change: (file: RelayFile) => T | Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    const file = await readUnqueued();
    const before = JSON.stringify(file);
    const result = await change(file);
    if (JSON.stringify(file) !== before) await writeUnqueued(file);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

async function read(): Promise<RelayFile> {
  await queue;
  return readUnqueued();
}

function entryFor(file: RelayFile, projectId: string): ProjectRelayData {
  file.projects[projectId] ??= { relays: [], legs: [] };
  return file.projects[projectId];
}

/** What a project starts with: its Blueprint docs folder and its own CLI. */
async function defaultSettings(projectId: string): Promise<RelayProjectSettings> {
  const [project, blueprints, appSettings] = await Promise.all([
    findProjectScope(projectId),
    store.getBlueprints(),
    store.getSettings(),
  ]);
  if (!project) throw new Error('That project no longer exists.');
  const blueprint = blueprints.find((candidate) => candidate.projectId === project.parentId);
  return {
    docsFolder: normalizeDocsFolder(blueprint?.docsFolder),
    defaults: {
      cliId: project.cliId ?? appSettings.defaultCliId ?? 'claude-code',
      model: null,
      effort: null,
      autoSize: false,
    },
    overrides: {},
    options: { ...DEFAULT_RELAY_OPTIONS },
  };
}

/** The project's relay settings, its defaults filled in when it has saved none. */
export async function relaySettings(projectId: string): Promise<RelayProjectSettings> {
  const saved = (await read()).projects[projectId]?.settings;
  const base = await defaultSettings(projectId);
  if (!saved) return base;
  return { ...saved, options: { ...DEFAULT_RELAY_OPTIONS, ...saved.options } };
}

export async function saveRelaySettings(
  projectId: string,
  patch: RelaySettingsPatch,
): Promise<RelayProjectSettings> {
  const current = await relaySettings(projectId);
  const next: RelayProjectSettings = {
    docsFolder:
      patch.docsFolder === undefined ? current.docsFolder : normalizeDocsFolder(patch.docsFolder),
    defaults: { ...current.defaults, ...patch.defaults },
    overrides: patch.overrides ?? current.overrides,
    options: { ...current.options, ...(patch.options as Partial<RelayOptions> | undefined) },
  };
  const checked = settingsSchema.parse(next) as RelayProjectSettings;
  await mutate((file) => {
    entryFor(file, projectId).settings = checked;
  });
  return checked;
}

/** A project's relays, newest first. */
export async function relayStates(projectId: string): Promise<RelayState[]> {
  const relays = (await read()).projects[projectId]?.relays ?? [];
  return [...relays].sort((a, b) => b.createdAt - a.createdAt);
}

export async function allRelayStates(): Promise<RelayState[]> {
  return Object.values((await read()).projects).flatMap((entry) => entry.relays);
}

const LIVE: ReadonlySet<RelayState['status']> = new Set(['waiting', 'running', 'paused']);

export function saveRelayState(state: RelayState): Promise<void> {
  return mutate((file) => {
    const entry = entryFor(file, state.projectId);
    const index = entry.relays.findIndex((relay) => relay.id === state.id);
    if (index === -1) entry.relays.push(state);
    else entry.relays[index] = state;
    const finished = entry.relays
      .filter((relay) => !LIVE.has(relay.status))
      .sort((a, b) => b.createdAt - a.createdAt);
    const drop = new Set(finished.slice(MAX_RELAYS).map((relay) => relay.id));
    entry.relays = entry.relays.filter((relay) => !drop.has(relay.id));
  });
}

export function addLegRecord(projectId: string, record: RelayLegRecord): Promise<void> {
  return mutate((file) => {
    const entry = entryFor(file, projectId);
    entry.legs = [...entry.legs.filter((leg) => leg.legId !== record.legId), record].slice(
      -RELAY_MAX_LEG_RECORDS,
    );
  });
}

/** The sessions run on a project's tasks, oldest first, for one task when given. */
export async function legRecords(projectId: string, taskId?: string): Promise<RelayLegRecord[]> {
  const legs = (await read()).projects[projectId]?.legs ?? [];
  return taskId ? legs.filter((leg) => leg.taskId === taskId) : legs;
}

/**
 * Drops what belongs to deleted projects: the ones named, and any no longer in projects.json. A
 * worktree's workspace keeps its relays under its scope id, which goes with its project.
 */
export async function pruneOrphanRelays(removed: { projectIds?: string[] } = {}): Promise<void> {
  try {
    const live = new Set((await store.getProjects()).map((project) => project.id));
    const gone = new Set(removed.projectIds ?? []);
    await mutate((file) => {
      for (const projectId of Object.keys(file.projects)) {
        const owner = parseScopeId(projectId).projectId;
        if (!live.has(owner) || gone.has(owner)) delete file.projects[projectId];
      }
    });
  } catch {
    // The next startup sweeps again.
  }
}
