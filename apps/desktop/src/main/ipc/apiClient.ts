import type { PostmanRequestItem } from '@runova/core';
import { ipcMain } from 'electron';
import type {
  ApiCollectionSummary,
  ApiExecutionResult,
  ExecuteApiRequestInput,
  SaveApiRequestInput,
} from '../../shared/apiClientTypes';
import { IPC } from '../../shared/ipcChannels';
import { collectionStore } from '../apiClient/collectionStore';
import type { ApiEngine, EngineEvent, EngineRun } from '../apiClient/engine/types';
import { buildRunInput, collectExecution } from '../apiClient/executor';
import { createHostEngine, type HostEngine } from '../apiClient/hostClient';
import { proxyForRuns } from '../apiClient/proxyForRuns';
import { spawnRunnerHost } from '../apiClient/runnerProcess';
import { currentProxySettings, resolveSystemProxy } from '../network/proxy';

/** The engine the handlers use. A real one is created on first use; tests pass a fake. */
let engine: ApiEngine | null = null;
let hostEngine: HostEngine | null = null;
const inFlight = new Map<string, EngineRun>();

function getEngine(): ApiEngine {
  if (!engine) {
    hostEngine = createHostEngine({ spawn: spawnRunnerHost });
    engine = hostEngine;
  }
  return engine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExecuteInput(input: unknown): asserts input is ExecuteApiRequestInput {
  if (!isRecord(input) || typeof input.requestId !== 'string' || !input.requestId) {
    throw new Error('That is not a request the API Client can send.');
  }
  if (!isRecord(input.request)) throw new Error('That is not a request the API Client can send.');
}

function assertSaveInput(input: unknown): asserts input is SaveApiRequestInput {
  const item = isRecord(input) ? input.item : null;
  if (
    !isRecord(input) ||
    typeof input.collectionId !== 'string' ||
    !isRecord(item) ||
    typeof item.id !== 'string' ||
    !isRecord(item.request)
  ) {
    throw new Error('That is not a request that can be saved.');
  }
}

async function execute(input: ExecuteApiRequestInput): Promise<ApiExecutionResult> {
  const startedAt = Date.now();
  let collection = null;
  let scriptsEnabled = true;
  if (input.collectionId) {
    try {
      collection = await collectionStore.get(input.collectionId);
      scriptsEnabled = (await collectionStore.meta(input.collectionId)).scriptsTrusted;
    } catch {
      // Deleted while its tab was open: send the request on its own rather than refuse.
      collection = null;
    }
  }

  const proxy = await proxyForRuns(currentProxySettings(), resolveSystemProxy);
  const runInput = buildRunInput(input, collection, { scriptsEnabled, proxy });
  const events: EngineEvent[] = [];
  const run = getEngine().run(runInput, (event) => events.push(event));
  inFlight.set(input.requestId, run);
  try {
    return collectExecution(input.requestId, startedAt, events, await run.done);
  } finally {
    inFlight.delete(input.requestId);
  }
}

export function registerApiClientHandlers(deps: { engine?: ApiEngine } = {}): void {
  if (deps.engine) engine = deps.engine;

  ipcMain.handle(
    IPC.apiClient.listCollections,
    (): Promise<ApiCollectionSummary[]> => collectionStore.list(),
  );

  ipcMain.handle(IPC.apiClient.getCollection, (_event, id: string) => collectionStore.get(id));

  ipcMain.handle(
    IPC.apiClient.createCollection,
    (_event, name: string): Promise<ApiCollectionSummary> => collectionStore.create(name),
  );

  ipcMain.handle(
    IPC.apiClient.renameCollection,
    (_event, id: string, name: string): Promise<ApiCollectionSummary> =>
      collectionStore.rename(id, name),
  );

  ipcMain.handle(
    IPC.apiClient.removeCollection,
    (_event, id: string): Promise<void> => collectionStore.remove(id),
  );

  ipcMain.handle(
    IPC.apiClient.saveRequest,
    (_event, input: unknown): Promise<ApiCollectionSummary> => {
      assertSaveInput(input);
      return collectionStore.saveRequest({
        collectionId: input.collectionId,
        parentId: typeof input.parentId === 'string' ? input.parentId : null,
        item: input.item as PostmanRequestItem,
      });
    },
  );

  ipcMain.handle(
    IPC.apiClient.createFolder,
    (_event, collectionId: string, parentId: string | null, name: string) =>
      collectionStore.createFolder(collectionId, parentId, name),
  );

  ipcMain.handle(
    IPC.apiClient.removeItem,
    (_event, collectionId: string, itemId: string): Promise<ApiCollectionSummary> =>
      collectionStore.removeItem(collectionId, itemId),
  );

  ipcMain.handle(IPC.apiClient.execute, (_event, input: unknown): Promise<ApiExecutionResult> => {
    assertExecuteInput(input);
    return execute(input);
  });

  ipcMain.handle(IPC.apiClient.cancel, (_event, requestId: string): boolean => {
    const run = inFlight.get(requestId);
    if (!run) return false;
    run.cancel();
    return true;
  });
}

/** Stops the request process on quit, so it never outlives the app. */
export function shutdownApiClient(): void {
  hostEngine?.shutdown();
}
