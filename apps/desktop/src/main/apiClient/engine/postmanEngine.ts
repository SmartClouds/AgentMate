import type { PostmanCollection, PostmanItem } from '@runova/core';
import sdk, { type SdkRequest, type SdkResponse, type SdkVariable } from 'postman-collection';
import runtime from 'postman-runtime';
import type {
  ApiHeader,
  ApiResponseData,
  ApiSentRequest,
  ApiTestResult,
} from '../../../shared/apiClientTypes';
import {
  consoleText,
  isTextMime,
  mediaType,
  phaseTimings,
  type TimingOffsets,
} from './responseShape';
import type {
  ApiEngine,
  EngineEvent,
  EngineProxy,
  EngineRunInput,
  EngineRunSummary,
  EngineVariable,
} from './types';

/**
 * Runs collections on Postman's own runtime, the engine behind Newman and the Postman app, so
 * scripts, auth helpers and variable resolution behave the way they do there. This file only
 * translates between that runtime and the plain data in ./types.
 */

interface HistoryEntry {
  request?: { method?: string; href?: string; headers?: ApiHeader[] };
  response?: { httpVersion?: string };
  timings?: { offset?: TimingOffsets };
}

interface RunHistory {
  execution?: { data?: HistoryEntry[] };
}

interface Cursor {
  ref?: string;
}

function toValues(variables: EngineVariable[] | undefined): unknown[] {
  return (variables ?? []).map((v) => ({
    key: v.key,
    value: v.value,
    type: v.type ?? 'default',
    disabled: v.enabled === false,
  }));
}

function fromValues(list: SdkVariable[]): EngineVariable[] {
  return list.map((v) => ({
    key: v.key,
    value: v.value == null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
    type: v.type,
    enabled: v.disabled !== true,
  }));
}

function withoutEvents<T extends { event?: unknown; item?: PostmanItem[] }>(node: T): T {
  const { event: _event, ...rest } = node;
  const copy = rest as T;
  if (Array.isArray(node.item)) copy.item = node.item.map((child) => withoutEvents(child));
  return copy;
}

/** Glob-style hosts from the proxy settings as the match patterns Postman's proxy list reads. */
function bypassPattern(host: string): string {
  return `http+https://${host.trim()}/*`;
}

function proxyList(proxy: EngineProxy | null): unknown {
  if (!proxy) return undefined;
  const url = new URL(proxy.url);
  return new sdk.ProxyConfigList({}, [
    {
      match: 'http+https://*/*',
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      authenticate: Boolean(url.username),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      bypass: proxy.bypass.filter(Boolean).map(bypassPattern),
    },
  ]);
}

function bodyBuffer(response: SdkResponse): Buffer {
  const stream = response.stream;
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  return Buffer.from(stream.data);
}

function toResponse(
  response: SdkResponse,
  history: HistoryEntry | undefined,
  maxInlineBytes: number,
): ApiResponseData {
  const buffer = bodyBuffer(response);
  const mime = mediaType(response.headers.get('content-type'));
  const text = isTextMime(mime, buffer);
  const truncated = buffer.length > maxInlineBytes;
  const inline = truncated ? buffer.subarray(0, maxInlineBytes) : buffer;
  const size = response.size();
  return {
    status: response.code,
    statusText: response.status ?? '',
    headers: response.headers.all().map((h) => ({ key: h.key, value: String(h.value) })),
    body: inline.toString(text ? 'utf-8' : 'base64'),
    bodyEncoding: text ? 'utf8' : 'base64',
    bodyTruncated: truncated,
    mime,
    size: { body: buffer.length, headers: size.header ?? 0 },
    timings: phaseTimings(history?.timings?.offset, response.responseTime ?? 0),
    httpVersion: history?.response?.httpVersion ?? '1.1',
  };
}

function toSent(
  request: SdkRequest | undefined,
  history: HistoryEntry | undefined,
): ApiSentRequest | null {
  if (!request && !history?.request) return null;
  const body = request?.body && request.body.mode ? request.body.toString() : '';
  return {
    method: history?.request?.method ?? request?.method ?? 'GET',
    url: history?.request?.href ?? request?.url.toString() ?? '',
    headers:
      history?.request?.headers?.map((h) => ({ key: h.key, value: String(h.value) })) ??
      request?.headers
        .all()
        .filter((h) => !h.disabled)
        .map((h) => ({ key: h.key, value: String(h.value) })) ??
      [],
    body: body || null,
  };
}

function toAssertions(
  results: {
    name?: string;
    passed?: boolean;
    skipped?: boolean;
    error?: { message?: string } | null;
  }[],
): ApiTestResult[] {
  return results.map((r) => ({
    name: r.name ?? '',
    passed: r.passed === true,
    skipped: r.skipped === true,
    error: r.error ? (r.error.message ?? String(r.error)) : null,
  }));
}

function messageOf(error: unknown): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  const { message, code } = error as { message?: string; code?: string };
  if (message && code && !message.includes(code)) return `${code}: ${message}`;
  return message ?? code ?? String(error);
}

export const postmanEngine: ApiEngine = {
  run(input: EngineRunInput, onEvent: (event: EngineEvent) => void) {
    const { options } = input;
    const source: PostmanCollection = options.scriptsEnabled
      ? input.collection
      : withoutEvents(input.collection);
    const collection = new sdk.Collection(source);
    const environment = new sdk.VariableScope({ values: toValues(input.environment) });
    const globals = new sdk.VariableScope({ values: toValues(input.globals) });

    let handle: { abort(): void } | null = null;
    let cancelRequested = false;
    let cancelled = false;
    // The runtime reports the item per callback only on some events; the rest are attributed to
    // whatever item started last.
    let currentItem: string | null = null;

    const done = new Promise<EngineRunSummary>((resolve) => {
      let settled = false;
      const finish = (error: unknown): void => {
        if (settled) return;
        settled = true;
        resolve({
          error: error && !cancelled ? messageOf(error) : null,
          cancelled,
          environment: fromValues(environment.values.all()),
          globals: fromValues(globals.values.all()),
          collectionVariables: fromValues(collection.variables.all()),
        });
      };

      new runtime.Runner().run(
        collection,
        {
          environment,
          globals,
          entrypoint: input.entrypoint ? { execute: input.entrypoint } : undefined,
          timeout: { request: options.timeoutMs },
          requester: {
            strictSSL: options.strictSSL,
            followRedirects: options.followRedirects,
            maxRedirects: options.maxRedirects,
            timings: true,
          },
          proxies: proxyList(options.proxy),
        },
        (error, run) => {
          if (error) {
            finish(error);
            return;
          }
          handle = run;
          const callbacks = {
            beforeItem: (_error: unknown, _cursor: Cursor, item: { id: string }) => {
              currentItem = item.id;
            },
            response: (
              responseError: unknown,
              _cursor: Cursor,
              response: SdkResponse | undefined,
              request: SdkRequest | undefined,
              item: { id: string },
              _cookies: unknown,
              history: RunHistory | undefined,
            ) => {
              const entries = history?.execution?.data ?? [];
              const last = entries[entries.length - 1];
              onEvent({
                type: 'response',
                itemId: item?.id ?? currentItem ?? '',
                response: response ? toResponse(response, last, options.maxInlineBodyBytes) : null,
                sent: toSent(request, last),
                error: responseError ? messageOf(responseError) : null,
              });
            },
            assertion: (_cursor: Cursor, results: Parameters<typeof toAssertions>[0]) => {
              onEvent({
                type: 'assertion',
                itemId: currentItem ?? '',
                results: toAssertions(results),
              });
            },
            console: (_cursor: Cursor, level: string, ...args: unknown[]) => {
              onEvent({ type: 'console', itemId: currentItem, level, messages: consoleText(args) });
            },
            exception: (_cursor: Cursor, exceptionError: unknown) => {
              onEvent({
                type: 'exception',
                itemId: currentItem,
                message: messageOf(exceptionError),
              });
            },
            abort: () => {
              cancelled = true;
              finish(null);
            },
            done: (doneError: unknown) => finish(doneError),
          };
          run.start(callbacks as unknown as Record<string, (...args: never[]) => void>);
          if (cancelRequested) run.abort();
        },
      );
    });

    return {
      cancel() {
        cancelRequested = true;
        cancelled = true;
        handle?.abort();
      },
      done,
    };
  },
};
