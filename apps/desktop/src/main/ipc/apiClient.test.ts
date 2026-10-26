import type { PostmanCollection, PostmanRequestItem } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiCollectionSummary,
  ApiExecutionResult,
  ApiResponseData,
} from '../../shared/apiClientTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type {
  ApiEngine,
  EngineEvent,
  EngineRunInput,
  EngineRunSummary,
} from '../apiClient/engine/types';

/**
 * The API Client's IPC surface. The engine is a fake here: these check what main hands it and
 * what the renderer gets back, and leave running real requests to the engine's own tests.
 */

useTempUserData();
expectChannelsCovered(IPC.apiClient);

const response: ApiResponseData = {
  status: 201,
  statusText: 'Created',
  headers: [{ key: 'content-type', value: 'application/json' }],
  body: '{"id":1}',
  bodyEncoding: 'utf8',
  bodyTruncated: false,
  mime: 'application/json',
  size: { body: 8, headers: 30 },
  timings: { dns: 1, tcp: 1, tls: 0, firstByte: 5, download: 1, total: 8 },
  httpVersion: '1.1',
};

const summary = (overrides: Partial<EngineRunSummary> = {}): EngineRunSummary => ({
  error: null,
  cancelled: false,
  environment: [],
  globals: [],
  collectionVariables: [],
  ...overrides,
});

let runs: {
  input: EngineRunInput;
  finish: (s?: Partial<EngineRunSummary>) => void;
  cancelled: boolean;
}[];

const fakeEngine: ApiEngine = {
  run(input, onEvent) {
    let resolve: (s: EngineRunSummary) => void = () => undefined;
    const done = new Promise<EngineRunSummary>((r) => {
      resolve = r;
    });
    const entry = {
      input,
      cancelled: false,
      finish: (s: Partial<EngineRunSummary> = {}) => {
        const event: EngineEvent = {
          type: 'response',
          itemId: input.entrypoint ?? '',
          response: s.cancelled ? null : response,
          sent: null,
          error: null,
        };
        onEvent(event);
        resolve(summary(s));
      },
    };
    runs.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
        entry.finish({ cancelled: true });
      },
      done,
    };
  },
};

beforeEach(async () => {
  runs = [];
  await loadIpc(
    () => import('./apiClient'),
    (module) => module.registerApiClientHandlers({ engine: fakeEngine }),
  );
});

const item = (id: string): PostmanRequestItem => ({
  id,
  name: 'Create user',
  request: { method: 'POST', url: '{{base}}/users' },
});

async function waitForRun(count = 1): Promise<void> {
  await vi.waitFor(() => expect(runs.length).toBeGreaterThanOrEqual(count));
}

describe('apiClient collections', () => {
  it('creates, lists, renames and removes collections', async () => {
    const created = await invoke<ApiCollectionSummary>(IPC.apiClient.createCollection, 'Users API');
    expect(created.name).toBe('Users API');

    await invoke(IPC.apiClient.renameCollection, created.id, 'People API');
    const listed = await invoke<ApiCollectionSummary[]>(IPC.apiClient.listCollections);
    expect(listed.map((c) => c.name)).toEqual(['People API']);

    await invoke(IPC.apiClient.removeCollection, created.id);
    expect(await invoke(IPC.apiClient.listCollections)).toEqual([]);
  });

  it('saves requests into folders and reads the collection back', async () => {
    const { id } = await invoke<ApiCollectionSummary>(IPC.apiClient.createCollection, 'API');
    const { folderId } = await invoke<{ folderId: string }>(
      IPC.apiClient.createFolder,
      id,
      null,
      'Users',
    );
    const saved = await invoke<ApiCollectionSummary>(IPC.apiClient.saveRequest, {
      collectionId: id,
      parentId: folderId,
      item: item('r1'),
    });
    expect(saved.requestCount).toBe(1);

    const collection = await invoke<PostmanCollection>(IPC.apiClient.getCollection, id);
    expect(JSON.stringify(collection)).toContain('Create user');

    const afterRemove = await invoke<ApiCollectionSummary>(IPC.apiClient.removeItem, id, 'r1');
    expect(afterRemove.requestCount).toBe(0);
  });

  it('rejects a save that is missing its item', async () => {
    const { id } = await invoke<ApiCollectionSummary>(IPC.apiClient.createCollection, 'API');
    await expect(
      invoke(IPC.apiClient.saveRequest, { collectionId: id, parentId: null }),
    ).rejects.toThrow(/request/i);
  });
});

describe('apiClient.execute', () => {
  it('runs a scratch request and returns the response', async () => {
    const pending = invoke<ApiExecutionResult>(IPC.apiClient.execute, {
      requestId: 'req-1',
      request: { method: 'GET', url: 'https://a.test' },
    });
    await waitForRun();
    expect(runs[0]?.input.collection.item).toHaveLength(1);
    expect(runs[0]?.input.options.proxy).toBeNull();
    runs[0]?.finish();

    const result = await pending;
    expect(result).toMatchObject({ requestId: 'req-1', ok: true, response: { status: 201 } });
  });

  it('runs a saved request inside its collection', async () => {
    const { id } = await invoke<ApiCollectionSummary>(IPC.apiClient.createCollection, 'API');
    await invoke(IPC.apiClient.saveRequest, { collectionId: id, parentId: null, item: item('r1') });

    const pending = invoke<ApiExecutionResult>(IPC.apiClient.execute, {
      requestId: 'req-2',
      request: { method: 'PUT', url: '{{base}}/users/1' },
      collectionId: id,
      itemId: 'r1',
    });
    await waitForRun();
    expect(runs[0]?.input.entrypoint).toBe('r1');
    expect(runs[0]?.input.options.scriptsEnabled).toBe(true);
    runs[0]?.finish();
    await pending;
  });

  it('still runs when the collection has gone, as a scratch request', async () => {
    const pending = invoke<ApiExecutionResult>(IPC.apiClient.execute, {
      requestId: 'req-3',
      request: { method: 'GET', url: 'https://a.test' },
      collectionId: 'deleted',
      itemId: 'r1',
    });
    await waitForRun();
    expect(runs[0]?.input.collection.info.name).toBe('Scratch');
    runs[0]?.finish();
    await pending;
  });

  it('cancels a request that is still running', async () => {
    const pending = invoke<ApiExecutionResult>(IPC.apiClient.execute, {
      requestId: 'req-4',
      request: { method: 'GET', url: 'https://a.test' },
    });
    await waitForRun();

    expect(await invoke(IPC.apiClient.cancel, 'req-4')).toBe(true);
    expect(runs[0]?.cancelled).toBe(true);
    expect(await pending).toMatchObject({ cancelled: true, ok: false });
    expect(await invoke(IPC.apiClient.cancel, 'req-4')).toBe(false);
  });

  it('rejects input that is not a request', async () => {
    await expect(invoke(IPC.apiClient.execute, { requestId: '' })).rejects.toThrow(/request/i);
  });
});
