import { createServer, type Server } from 'node:net';
import { POSTMAN_SCHEMA_V21, type PostmanRequestItem } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, type LocalServer, startHttpServer } from '../../../test/main/fixtures';
import { postmanEngine } from './postmanEngine';
import type { EngineEvent, EngineRunInput, EngineRunOptions } from './types';

/**
 * Runs Postman's real runtime against a local server. This is the only test that touches the
 * runtime itself; everything above it talks to the ApiEngine interface.
 */

let server: LocalServer;

beforeEach(async () => {
  server = await startHttpServer((request, response, body) => {
    if (request.url?.startsWith('/missing')) return json(response, { error: 'nope' }, 404);
    if (request.url?.startsWith('/slow')) return; // never answers
    if (request.url?.startsWith('/big')) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('x'.repeat(5000));
      return;
    }
    if (request.url?.startsWith('/png')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
      return;
    }
    json(response, { method: request.method, url: request.url, headers: request.headers, body });
  });
});

afterEach(async () => {
  await server.close();
});

const options = (overrides: Partial<EngineRunOptions> = {}): EngineRunOptions => ({
  timeoutMs: 5000,
  strictSSL: true,
  followRedirects: true,
  maxInlineBodyBytes: 1024 * 1024,
  scriptsEnabled: true,
  proxy: null,
  ...overrides,
});

function input(
  item: Pick<PostmanRequestItem, 'request' | 'event'>,
  extra: Partial<EngineRunInput> = {},
): EngineRunInput {
  const requestItem: PostmanRequestItem = { id: 'item-1', name: 'Request', ...item };
  return {
    collection: {
      info: { name: 'Test', schema: POSTMAN_SCHEMA_V21 },
      item: [requestItem],
      variable: [{ key: 'base', value: server.url }],
    },
    entrypoint: 'item-1',
    options: options(),
    ...extra,
  };
}

async function run(runInput: EngineRunInput) {
  const events: EngineEvent[] = [];
  const handle = postmanEngine.run(runInput, (event) => events.push(event));
  const summary = await handle.done;
  const response = events.find((e) => e.type === 'response');
  return { events, summary, response: response?.type === 'response' ? response : null };
}

describe('postmanEngine', () => {
  it('sends a GET with resolved variables and reports status, headers, body and timings', async () => {
    const { response, summary } = await run(
      input(
        { request: { method: 'GET', url: '{{base}}/users?page={{page}}' } },
        { environment: [{ key: 'page', value: '2' }] },
      ),
    );

    expect(summary.error).toBeNull();
    expect(response?.error).toBeNull();
    expect(response?.response?.status).toBe(200);
    expect(response?.response?.statusText).toBe('OK');
    expect(response?.response?.mime).toBe('application/json');
    expect(response?.response?.bodyEncoding).toBe('utf8');
    expect(JSON.parse(response?.response?.body ?? '{}')).toMatchObject({
      method: 'GET',
      url: '/users?page=2',
    });
    expect(response?.response?.headers).toContainEqual({
      key: 'content-type',
      value: 'application/json',
    });
    expect(response?.response?.timings.total).toBeGreaterThan(0);
    expect(response?.response?.size.body).toBeGreaterThan(0);
    expect(response?.sent?.url).toBe(`${server.url}/users?page=2`);
  });

  it('sends a raw JSON body with its headers', async () => {
    const { response } = await run(
      input({
        request: {
          method: 'POST',
          url: '{{base}}/echo',
          header: [{ key: 'X-Trace', value: 'abc' }],
          body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
        },
      }),
    );

    const echoed = JSON.parse(response?.response?.body ?? '{}');
    expect(echoed.body).toBe('{"a":1}');
    expect(echoed.headers['x-trace']).toBe('abc');
    expect(echoed.headers['content-type']).toBe('application/json');
    expect(response?.sent?.body).toBe('{"a":1}');
    expect(response?.sent?.headers).toContainEqual({ key: 'X-Trace', value: 'abc' });
  });

  it('reports a 404 as a normal response', async () => {
    const { response } = await run(input({ request: { method: 'GET', url: '{{base}}/missing' } }));
    expect(response?.response?.status).toBe(404);
    expect(response?.error).toBeNull();
  });

  it('reports a refused connection as an error with no response', async () => {
    const closed: Server = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    const port = typeof address === 'object' && address ? address.port : 1;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const { response } = await run(
      input({ request: { method: 'GET', url: `http://127.0.0.1:${port}/` } }),
    );
    expect(response?.response).toBeNull();
    expect(response?.error).toMatch(/ECONNREFUSED/);
  });

  it('times out a request that never answers', async () => {
    const { response } = await run({
      ...input({ request: { method: 'GET', url: '{{base}}/slow' } }),
      options: options({ timeoutMs: 300 }),
    });
    expect(response?.response).toBeNull();
    expect(response?.error).toMatch(/timed out|ESOCKETTIMEDOUT|ETIMEDOUT/i);
  });

  it('stops when cancelled and says so', async () => {
    const events: EngineEvent[] = [];
    const handle = postmanEngine.run(
      input({ request: { method: 'GET', url: '{{base}}/slow' } }),
      (event) => events.push(event),
    );
    setTimeout(() => handle.cancel(), 100);
    const summary = await handle.done;
    expect(summary.cancelled).toBe(true);
  });

  it('cuts a body that is over the inline limit', async () => {
    const { response } = await run({
      ...input({ request: { method: 'GET', url: '{{base}}/big' } }),
      options: options({ maxInlineBodyBytes: 100 }),
    });
    expect(response?.response?.body).toHaveLength(100);
    expect(response?.response?.bodyTruncated).toBe(true);
    expect(response?.response?.size.body).toBe(5000);
  });

  it('sends binary bodies back as base64', async () => {
    const { response } = await run(input({ request: { method: 'GET', url: '{{base}}/png' } }));
    expect(response?.response?.bodyEncoding).toBe('base64');
    expect(Buffer.from(response?.response?.body ?? '', 'base64')).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
    );
  });

  it('runs test scripts, reports assertions and console output, and returns changed variables', async () => {
    const { events, summary } = await run(
      input({
        request: { method: 'GET', url: '{{base}}/users' },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'pm.test("is ok", () => pm.response.to.have.status(200));',
                'pm.test("is created", () => pm.response.to.have.status(201));',
                'pm.environment.set("seen", pm.response.json().method);',
                'console.log("done", 1);',
              ],
            },
          },
        ],
      }),
    );

    // The runtime reports each pm.test as it finishes, so results arrive over several events.
    const results = events.flatMap((e) => (e.type === 'assertion' ? e.results : []));
    expect(results).toEqual([
      { name: 'is ok', passed: true, skipped: false, error: null },
      { name: 'is created', passed: false, skipped: false, error: expect.stringContaining('201') },
    ]);
    const log = events.find((e) => e.type === 'console');
    expect(log).toMatchObject({ type: 'console', level: 'log', messages: ['done', '1'] });
    expect(summary.environment).toContainEqual(
      expect.objectContaining({ key: 'seen', value: 'GET' }),
    );
  });

  it('reports a script that throws as an exception', async () => {
    const { events } = await run(
      input({
        request: { method: 'GET', url: '{{base}}/users' },
        event: [{ listen: 'prerequest', script: { exec: ['throw new Error("broken script")'] } }],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'exception',
        message: expect.stringContaining('broken script'),
      }),
    );
  });

  it('skips every script when scripts are disabled', async () => {
    const { events, summary } = await run({
      ...input({
        request: { method: 'GET', url: '{{base}}/users' },
        event: [{ listen: 'test', script: { exec: ['pm.environment.set("ran", "yes")'] } }],
      }),
      options: options({ scriptsEnabled: false }),
    });
    expect(events.some((e) => e.type === 'assertion' || e.type === 'console')).toBe(false);
    expect(summary.environment.find((v) => v.key === 'ran')).toBeUndefined();
  });

  it('sends requests through a proxy when one is given', async () => {
    const proxy = await startHttpServer((request, response) => {
      // A forward proxy for plain http sees the full target URL on the request line.
      json(response, { proxied: request.url });
    });
    try {
      const { response } = await run({
        ...input({ request: { method: 'GET', url: 'http://api.example.invalid/ping' } }),
        options: options({ proxy: { url: proxy.url, bypass: [] } }),
      });
      expect(JSON.parse(response?.response?.body ?? '{}')).toEqual({
        proxied: 'http://api.example.invalid/ping',
      });
    } finally {
      await proxy.close();
    }
  });
});
