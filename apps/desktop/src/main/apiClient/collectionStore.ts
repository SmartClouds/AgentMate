import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createCollection,
  findItem,
  findParentId,
  insertItem,
  isRequestItem,
  outline,
  type PostmanCollection,
  type PostmanFolder,
  parseCollection,
  removeItem,
  updateItem,
  walkItems,
} from '@runova/core';
import { app } from 'electron';
import type { ApiCollectionSummary, SaveApiRequestInput } from '../../shared/apiClientTypes';

/**
 * Where the API Client keeps its collections. Each collection is its own Postman v2.1 file, so a
 * large one is not rewritten when a different one changes, and each file can be opened in
 * Postman as it is. A small index beside them keeps the order and the app's own metadata.
 */

export interface CollectionMeta {
  id: string;
  name: string;
  projectIds: string[];
  /** Scripts in a collection from somewhere else only run after the user says so. */
  scriptsTrusted: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CollectionIndex {
  version: 1;
  collections: CollectionMeta[];
}

const MAX_NAME_LENGTH = 120;

function rootDir(): string {
  return join(app.getPath('userData'), 'data', 'api-client');
}

function indexPath(): string {
  return join(rootDir(), 'index.json');
}

function collectionPath(id: string): string {
  // Ids are ours (uuids), but a path must never be built from anything that could climb out.
  if (!/^[\w-]+$/.test(id)) throw new Error('That collection no longer exists.');
  return join(rootDir(), 'collections', `${id}.json`);
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(temp, path);
}

async function readIndex(): Promise<CollectionIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(), 'utf-8')) as Partial<CollectionIndex>;
    return { version: 1, collections: Array.isArray(parsed.collections) ? parsed.collections : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, collections: [] };
    throw error;
  }
}

async function readCollection(id: string): Promise<PostmanCollection> {
  let raw: string;
  try {
    raw = await readFile(collectionPath(id), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('That collection no longer exists.');
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('The collection file could not be read: it is not valid JSON.');
  }
  const parsed = parseCollection(json);
  if (!parsed.ok) throw new Error(`The collection file could not be read. ${parsed.error}`);
  return parsed.collection;
}

function countRequests(collection: PostmanCollection): number {
  let count = 0;
  walkItems(collection.item, (item) => {
    if (isRequestItem(item)) count++;
  });
  return count;
}

function summarize(meta: CollectionMeta, collection: PostmanCollection): ApiCollectionSummary {
  return {
    id: meta.id,
    name: meta.name,
    requestCount: countRequests(collection),
    tree: outline(collection),
    projectIds: meta.projectIds,
    updatedAt: meta.updatedAt,
    error: null,
  };
}

function cleanName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('Give it a name.');
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

/**
 * Every change reads, edits and writes back, so two quick saves from the renderer would race and
 * one would be lost. Running them one after another avoids that.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => undefined);
  return next;
}

async function requireMeta(index: CollectionIndex, id: string): Promise<CollectionMeta> {
  const meta = index.collections.find((c) => c.id === id);
  if (!meta) throw new Error('That collection no longer exists.');
  return meta;
}

/** Loads a collection, applies `change`, writes it and its index entry back. */
function mutateCollection(
  id: string,
  change: (collection: PostmanCollection) => PostmanCollection,
): Promise<ApiCollectionSummary> {
  return serialized(async () => {
    const index = await readIndex();
    const meta = await requireMeta(index, id);
    const next = change(await readCollection(id));
    meta.updatedAt = Date.now();
    await writeJsonAtomic(collectionPath(id), next);
    await writeJsonAtomic(indexPath(), index);
    return summarize(meta, next);
  });
}

export const collectionStore = {
  async list(): Promise<ApiCollectionSummary[]> {
    const index = await readIndex();
    return Promise.all(
      index.collections.map(async (meta) => {
        try {
          return summarize(meta, await readCollection(meta.id));
        } catch (error) {
          return {
            ...summarize(meta, createCollection(meta.name)),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  },

  async get(id: string): Promise<PostmanCollection> {
    await requireMeta(await readIndex(), id);
    return readCollection(id);
  },

  async meta(id: string): Promise<CollectionMeta> {
    return requireMeta(await readIndex(), id);
  },

  create(name: string): Promise<ApiCollectionSummary> {
    return serialized(async () => {
      const index = await readIndex();
      const collection = createCollection(cleanName(name));
      const now = Date.now();
      const meta: CollectionMeta = {
        id: randomUUID(),
        name: collection.info.name,
        projectIds: [],
        scriptsTrusted: true,
        createdAt: now,
        updatedAt: now,
      };
      await writeJsonAtomic(collectionPath(meta.id), collection);
      index.collections.push(meta);
      await writeJsonAtomic(indexPath(), index);
      return summarize(meta, collection);
    });
  },

  async rename(id: string, name: string): Promise<ApiCollectionSummary> {
    const clean = cleanName(name);
    return serialized(async () => {
      const index = await readIndex();
      const meta = await requireMeta(index, id);
      const collection = await readCollection(id);
      const next = { ...collection, info: { ...collection.info, name: clean } };
      meta.name = clean;
      meta.updatedAt = Date.now();
      await writeJsonAtomic(collectionPath(id), next);
      await writeJsonAtomic(indexPath(), index);
      return summarize(meta, next);
    });
  },

  remove(id: string): Promise<void> {
    return serialized(async () => {
      const index = await readIndex();
      index.collections = index.collections.filter((c) => c.id !== id);
      await writeJsonAtomic(indexPath(), index);
      await rm(collectionPath(id), { force: true });
    });
  },

  /** Adds the request, or replaces the item with the same id wherever it already sits. */
  saveRequest(input: SaveApiRequestInput): Promise<ApiCollectionSummary> {
    return mutateCollection(input.collectionId, (collection) => {
      const item = { ...input.item, name: cleanName(input.item.name) };
      if (findItem(collection, item.id)) return updateItem(collection, item.id, () => item);
      return insertItem(collection, input.parentId, item);
    });
  },

  async createFolder(
    collectionId: string,
    parentId: string | null,
    name: string,
  ): Promise<{ summary: ApiCollectionSummary; folderId: string }> {
    const folder: PostmanFolder = { id: randomUUID(), name: cleanName(name), item: [] };
    const summary = await mutateCollection(collectionId, (collection) =>
      insertItem(collection, parentId, folder),
    );
    return { summary, folderId: folder.id };
  },

  removeItem(collectionId: string, itemId: string): Promise<ApiCollectionSummary> {
    return mutateCollection(collectionId, (collection) => removeItem(collection, itemId));
  },

  /** The folder an item sits in, for callers that need its surroundings. */
  async parentOf(collectionId: string, itemId: string): Promise<string | null | undefined> {
    return findParentId(await this.get(collectionId), itemId);
  },
};
