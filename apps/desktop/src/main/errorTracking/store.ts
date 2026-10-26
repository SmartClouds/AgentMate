import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import type { SecretEnvelope } from '../../shared/apiTypes';
import type {
  ErrorConnectionSummary,
  ErrorProjectLink,
  ErrorTrackingChangedEvent,
} from '../../shared/errorTrackingTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import type { SealedSecretStore } from '../ssh/vault';
import { store } from '../store';

/**
 * Error tracking (E24) on disk: `error-tracking.json` in the app's data folder holds the saved
 * connections and which provider projects each Runova project is linked to. A connection's
 * token is only ever stored sealed with the Servers vault, and moves with a passkey change. Every
 * change goes through one queue, so a status check finishing while the user links a project
 * cannot lose either.
 *
 * A file that does not parse is refused rather than written over, since that would lose the
 * setup. Entries that do not fit the schema are dropped, and so are links whose connection is
 * gone.
 */

export interface StoredErrorConnection extends Omit<ErrorConnectionSummary, 'locked'> {
  tokenEnvelope: SecretEnvelope;
}

export interface ErrorTrackingState {
  connections: StoredErrorConnection[];
  links: ErrorProjectLink[];
}

const FILE = 'error-tracking.json';

const envelopeSchema = z.union([
  z.object({ mode: z.literal('safeStorage'), ciphertext: z.string() }),
  z.object({
    mode: z.literal('passphrase'),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  }),
]);

const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative();

const connectionSchema = z.object({
  id,
  provider: z.literal('sentry'),
  label: z.string().max(200),
  host: z.string().max(2048),
  apiBase: z.string().max(2048),
  orgSlug: z.string().min(1).max(200),
  orgName: z.string().max(200),
  scopes: z.array(z.string().max(100)).nullable(),
  canWrite: z.boolean(),
  createdAt: time,
  checkedAt: time.nullable(),
  problem: z.string().max(2000).nullable(),
  tokenEnvelope: envelopeSchema,
});

const linkSchema = z.object({
  projectId: id,
  connectionId: id,
  remoteProjectId: z.string().min(1).max(200),
  remoteSlug: z.string().max(200),
  remoteName: z.string().max(200),
});

function filePath(): string {
  return join(app.getPath('userData'), 'data', FILE);
}

/** Written to a temporary name and renamed over, readable only by the user. */
async function writeState(state: ErrorTrackingState): Promise<void> {
  const path = filePath();
  await mkdir(join(app.getPath('userData'), 'data'), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseState(value: unknown): ErrorTrackingState {
  const state: ErrorTrackingState = { connections: [], links: [] };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return state;
  const { connections, links } = value as { connections?: unknown; links?: unknown };
  for (const entry of Array.isArray(connections) ? connections : []) {
    const parsed = connectionSchema.safeParse(entry);
    if (parsed.success && !state.connections.some((one) => one.id === parsed.data.id)) {
      state.connections.push(parsed.data);
    }
  }
  const live = new Set(state.connections.map((one) => one.id));
  const seen = new Set<string>();
  for (const entry of Array.isArray(links) ? links : []) {
    const parsed = linkSchema.safeParse(entry);
    if (!parsed.success || !live.has(parsed.data.connectionId)) continue;
    const key = `${parsed.data.projectId}\n${parsed.data.connectionId}\n${parsed.data.remoteProjectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.links.push(parsed.data);
  }
  return state;
}

async function readUnqueued(): Promise<ErrorTrackingState> {
  let raw: string;
  try {
    raw = await readFile(filePath(), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connections: [], links: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${FILE} is not valid JSON. Fix or remove it to use error tracking.`);
  }
  return parseState(value);
}

let queue: Promise<unknown> = Promise.resolve();

export async function readErrorTracking(): Promise<ErrorTrackingState> {
  await queue;
  return readUnqueued();
}

/**
 * Reads the file, lets `change` edit it in place, and writes it back when it changed. Changes run
 * one after another; one that throws writes nothing and does not stop the next.
 */
export function mutateErrorTracking<T>(
  change: (state: ErrorTrackingState) => Promise<T> | T,
): Promise<T> {
  const next = queue.then(async () => {
    const state = await readUnqueued();
    const before = JSON.stringify(state);
    const result = await change(state);
    if (JSON.stringify(state) !== before) await writeState(state);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Tells every window what changed, so the Errors tab can read it again. */
export function broadcastErrorTrackingChanged(reason: ErrorTrackingChangedEvent['reason']): void {
  broadcastToWindows(IPC.errorTracking.onChanged, { reason } satisfies ErrorTrackingChangedEvent);
}

/** Moves every sealed token when the Servers passkey changes (see ssh/vault.ts). */
export const errorTrackingSealedKeys: SealedSecretStore = {
  prepare: async (move) => {
    const moved = new Map<string, SecretEnvelope>();
    for (const connection of (await readErrorTracking()).connections) {
      moved.set(connection.id, await move(connection.tokenEnvelope));
    }
    return () =>
      mutateErrorTracking((state) => {
        for (const connection of state.connections) {
          const next = moved.get(connection.id);
          if (next) connection.tokenEnvelope = next;
        }
      });
  },
};

/**
 * Forgets the links of deleted projects. Takes the ids just removed, and also sweeps against what
 * is saved, which is how it catches what a restored backup left behind at startup. Never throws:
 * a disk error leaves the orphans for the next sweep.
 */
export async function pruneOrphanErrorLinks(
  removed: { projectIds?: string[] } = {},
): Promise<void> {
  try {
    const live = new Set((await store.getProjects()).map((project) => project.id));
    const gone = new Set(removed.projectIds ?? []);
    const changed = await mutateErrorTracking((state) => {
      const before = state.links.length;
      state.links = state.links.filter(
        (link) => live.has(link.projectId) && !gone.has(link.projectId),
      );
      return state.links.length !== before;
    });
    if (changed) broadcastErrorTrackingChanged('links');
  } catch {
    // Left for the next launch.
  }
}
