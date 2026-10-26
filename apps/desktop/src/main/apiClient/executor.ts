import { randomUUID } from 'node:crypto';
import {
  findItem,
  insertItem,
  isRequestItem,
  POSTMAN_SCHEMA_V21,
  type PostmanCollection,
  type PostmanRequestItem,
  updateItem,
} from '@runova/core';
import type { ApiExecutionResult, ExecuteApiRequestInput } from '../../shared/apiClientTypes';
import type {
  EngineEvent,
  EngineProxy,
  EngineRunInput,
  EngineRunOptions,
  EngineRunSummary,
} from './engine/types';

export const DEFAULT_RUN_OPTIONS: Omit<EngineRunOptions, 'scriptsEnabled' | 'proxy'> = {
  timeoutMs: 60_000,
  strictSSL: true,
  followRedirects: true,
  maxRedirects: 10,
  maxInlineBodyBytes: 5 * 1024 * 1024,
};

/**
 * Builds what the engine runs for one tab. A saved request runs where it sits in its collection,
 * which is how it picks up the folder's auth and scripts and the collection's variables; its
 * request and scripts are swapped for what the tab currently shows, saved or not.
 */
export function buildRunInput(
  input: ExecuteApiRequestInput,
  collection: PostmanCollection | null,
  options: { scriptsEnabled: boolean; proxy: EngineProxy | null },
): EngineRunInput {
  const events = input.events ?? [];
  const existing = collection && input.itemId ? findItem(collection, input.itemId) : null;

  let runnable: PostmanCollection;
  let entrypoint: string;
  if (collection && existing && isRequestItem(existing)) {
    entrypoint = existing.id;
    runnable = updateItem(collection, existing.id, (item) => {
      const next: PostmanRequestItem = { ...(item as PostmanRequestItem), request: input.request };
      if (events.length > 0) next.event = events;
      else delete next.event;
      return next;
    });
  } else {
    const item: PostmanRequestItem = {
      id: randomUUID(),
      name: input.name || 'Untitled Request',
      request: input.request,
      ...(events.length > 0 ? { event: events } : {}),
    };
    entrypoint = item.id;
    runnable = collection
      ? insertItem(collection, null, item)
      : { info: { name: 'Scratch', schema: POSTMAN_SCHEMA_V21 }, item: [item] };
  }

  return {
    collection: runnable,
    entrypoint,
    options: { ...DEFAULT_RUN_OPTIONS, ...options },
  };
}

/** Folds the engine's events for one request into the result the tab shows. */
export function collectExecution(
  requestId: string,
  startedAt: number,
  events: readonly EngineEvent[],
  summary: EngineRunSummary,
): ApiExecutionResult {
  const result: ApiExecutionResult = {
    requestId,
    ok: false,
    cancelled: summary.cancelled,
    error: null,
    response: null,
    sent: null,
    tests: [],
    console: [],
    scriptErrors: [],
    startedAt,
  };

  for (const event of events) {
    switch (event.type) {
      case 'response':
        result.response = event.response;
        result.sent = event.sent;
        result.error = event.error;
        result.ok = event.response !== null;
        break;
      case 'assertion':
        result.tests.push(...event.results);
        break;
      case 'console':
        result.console.push({ level: event.level, messages: event.messages, at: Date.now() });
        break;
      case 'exception':
        result.scriptErrors.push(event.message);
        break;
    }
  }

  if (!result.ok && !result.error && !summary.cancelled) result.error = summary.error;
  return result;
}
