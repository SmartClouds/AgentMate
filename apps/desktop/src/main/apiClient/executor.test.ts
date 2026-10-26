import {
  isFolder,
  POSTMAN_SCHEMA_V21,
  type PostmanCollection,
  type PostmanRequestItem,
} from '@runova/core';
import { describe, expect, it } from 'vitest';
import type { ApiResponseData } from '../../shared/apiClientTypes';
import type { EngineEvent, EngineRunSummary } from './engine/types';
import { buildRunInput, collectExecution, DEFAULT_RUN_OPTIONS } from './executor';

const saved: PostmanRequestItem = {
  id: 'item-1',
  name: 'Saved',
  request: { method: 'GET', url: 'https://old.test' },
  event: [{ listen: 'test', script: { exec: ['// old'] } }],
};

const collection = (): PostmanCollection => ({
  info: { name: 'API', schema: POSTMAN_SCHEMA_V21 },
  item: [{ id: 'folder', name: 'F', item: [saved], auth: { type: 'bearer' } }],
  variable: [{ key: 'base', value: 'https://api.test' }],
});

describe('buildRunInput', () => {
  it('wraps a request that belongs to no collection in a collection of its own', () => {
    const input = buildRunInput(
      { requestId: 'r', request: { method: 'POST', url: 'https://a.test' }, name: 'Draft' },
      null,
      { scriptsEnabled: true, proxy: null },
    );
    expect(input.collection.item).toHaveLength(1);
    expect(input.collection.item[0]).toMatchObject({
      name: 'Draft',
      request: { method: 'POST', url: 'https://a.test' },
    });
    expect(input.entrypoint).toBe(input.collection.item[0]?.id);
    expect(input.options).toMatchObject({ ...DEFAULT_RUN_OPTIONS, scriptsEnabled: true });
  });

  it('runs a saved request in place, so it inherits folder auth and collection variables', () => {
    const input = buildRunInput(
      {
        requestId: 'r',
        request: { method: 'PUT', url: '{{base}}/x' },
        events: [{ listen: 'test', script: { exec: ['// new'] } }],
        collectionId: 'c',
        itemId: 'item-1',
      },
      collection(),
      { scriptsEnabled: true, proxy: null },
    );

    expect(input.entrypoint).toBe('item-1');
    expect(input.collection.variable).toEqual([{ key: 'base', value: 'https://api.test' }]);
    const folder = input.collection.item[0];
    if (!folder || !isFolder(folder)) throw new Error('expected the folder');
    expect(folder.auth).toEqual({ type: 'bearer' });
    expect(folder.item[0]).toMatchObject({
      id: 'item-1',
      request: { method: 'PUT', url: '{{base}}/x' },
      event: [{ listen: 'test', script: { exec: ['// new'] } }],
    });
  });

  it('adds an unsaved request to the collection so its variables still apply', () => {
    const input = buildRunInput(
      { requestId: 'r', request: { method: 'GET', url: '{{base}}' }, collectionId: 'c' },
      collection(),
      { scriptsEnabled: false, proxy: { url: 'http://p:1', bypass: [] } },
    );
    expect(input.collection.item).toHaveLength(2);
    expect(input.entrypoint).toBe(input.collection.item[1]?.id);
    expect(input.options.scriptsEnabled).toBe(false);
    expect(input.options.proxy).toEqual({ url: 'http://p:1', bypass: [] });
  });
});

const response: ApiResponseData = {
  status: 200,
  statusText: 'OK',
  headers: [],
  body: '{}',
  bodyEncoding: 'utf8',
  bodyTruncated: false,
  mime: 'application/json',
  size: { body: 2, headers: 10 },
  timings: { dns: 0, tcp: 0, tls: 0, firstByte: 1, download: 1, total: 2 },
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

describe('collectExecution', () => {
  it('gathers the response, tests, console lines and script errors', () => {
    const events: EngineEvent[] = [
      { type: 'console', itemId: 'i', level: 'info', messages: ['hi'] },
      {
        type: 'response',
        itemId: 'i',
        response,
        sent: { method: 'GET', url: 'u', headers: [], body: null },
        error: null,
      },
      {
        type: 'assertion',
        itemId: 'i',
        results: [{ name: 't', passed: true, skipped: false, error: null }],
      },
      { type: 'exception', itemId: 'i', message: 'ReferenceError: x' },
    ];
    const result = collectExecution('req', 100, events, summary());
    expect(result).toMatchObject({
      requestId: 'req',
      ok: true,
      cancelled: false,
      error: null,
      response,
      sent: { url: 'u' },
      tests: [{ name: 't', passed: true }],
      console: [{ level: 'info', messages: ['hi'] }],
      scriptErrors: ['ReferenceError: x'],
      startedAt: 100,
    });
  });

  it('reports the network error when no response came back', () => {
    const result = collectExecution(
      'req',
      1,
      [{ type: 'response', itemId: 'i', response: null, sent: null, error: 'ECONNREFUSED' }],
      summary(),
    );
    expect(result).toMatchObject({ ok: false, error: 'ECONNREFUSED', response: null });
  });

  it('reports a run error or a cancel when nothing else happened', () => {
    expect(collectExecution('r', 1, [], summary({ error: 'engine died' }))).toMatchObject({
      ok: false,
      error: 'engine died',
    });
    expect(collectExecution('r', 1, [], summary({ cancelled: true }))).toMatchObject({
      ok: false,
      cancelled: true,
      error: null,
    });
  });
});
