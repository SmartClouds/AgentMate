import { randomBytes } from 'node:crypto';
import {
  encodeWpFrame,
  encodeWpResponse,
  WP_BATCH_MAX_BYTES,
  WP_BATCH_MIN_BYTES,
  WP_ROUTES,
  wpCanonicalResponse,
} from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import {
  WpBatchSizer,
  WpClient,
  type WpClientOptions,
  WpRemoteError,
  wpAjaxRouteUrl,
  wpRequestCap,
  wpRescueRouteUrl,
  wpRestRouteUrl,
} from './client';
import { gzipBytes, privateKeyFromPem, privateKeyFromSeed, sha256Hex, signEd25519 } from './crypto';
import { pairWithSite } from './pairing';
import { FakeConnector } from './testing/fakeConnector';
import { seedBytes, WP_VECTORS } from './testing/vectors';
import { createFetchTransport, type WpHttpResponse, type WpTransport } from './transport';

/**
 * The signed client against the fake connector over real HTTP: verified replies, the endpoint
 * fallback, foreign replies, redirects, HTTP Basic, 413, rate limits, a skewed clock, timeouts,
 * cancels, and replies that are signed wrong or not at all.
 */

const nodeTransport = createFetchTransport(globalThis.fetch as never);
let fake: FakeConnector;

beforeEach(async () => {
  fake = await new FakeConnector().start();
});
afterEach(async () => {
  await fake.stop();
});

async function connected(overrides: Partial<WpClientOptions> = {}): Promise<WpClient> {
  const paired = await pairWithSite({
    connectionKey: fake.createKey(),
    allowPlainHttp: false,
    httpAuth: overrides.httpAuth ?? null,
    transport: nodeTransport,
    deviceName: 'test-laptop',
  });
  return new WpClient({
    transport: nodeTransport,
    endpoints: { restUrl: fake.restUrl, ajaxUrl: fake.ajaxUrl, rescueUrl: fake.rescueUrl },
    sitePublicKey: paired.sitePublicKey,
    connectionId: paired.pair.connectionId,
    privateKey: privateKeyFromPem(paired.keyPair.privateKeyPem),
    endpoint: paired.endpoint,
    clockOffset: paired.clockOffset,
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<WpRemoteError | Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

describe('WpClient against the fake connector', () => {
  it('makes signed calls the site verifies, and verifies every reply', async () => {
    const client = await connected();
    const { data } = await client.call(WP_ROUTES.siteInfo, {});
    expect(data.siteName).toBe('Fake Shop');
    expect(data.connection.id).toBe(client.connectionId);
    expect(client.endpoint).toBe('rest');
    expect(fake.requests.map((request) => request.route)).toEqual([
      '/hello',
      '/pair',
      '/site/info',
    ]);
  });

  it('falls back to admin-ajax when the REST API is blocked, then stays there', async () => {
    fake.switches.restBlocked = true;
    const client = await connected({ endpoint: null });
    await client.call(WP_ROUTES.itemsList, {});
    expect(client.endpoint).toBe('ajax');
    expect(fake.requests.at(-1)?.endpoint).toBe('ajax');
    fake.switches.restBlocked = false;
    await client.call(WP_ROUTES.itemsList, {});
    expect(fake.requests.at(-1)?.endpoint).toBe('ajax');
  });

  it('does not switch endpoints once one has worked', async () => {
    const client = await connected();
    expect(client.endpoint).toBe('rest');
    fake.switches.restBlocked = true;
    const error = await failure(client.call(WP_ROUTES.itemsList, {}));
    expect(wordPressErrorCode(error)).toBe('foreignResponse');
    expect(error.message).toContain('HTTP 404');
    expect(fake.requests.at(-1)?.endpoint).toBe('rest');
  });

  it('reports the first foreign reply when no endpoint answers', async () => {
    fake.switches.restBlocked = true;
    fake.switches.ajaxBlocked = true;
    const client = await connected({ endpoint: null }).catch((error) => error);
    expect(wordPressErrorCode(client)).toBe('foreignResponse');
  });

  it('tells a Cloudflare challenge apart', async () => {
    const client = await connected();
    fake.switches.foreign = { status: 403, cloudflare: true };
    const error = await failure(client.call(WP_ROUTES.siteInfo, {}));
    expect(wordPressErrorCode(error)).toBe('foreignResponse');
    expect(error.message).toContain('Cloudflare');
    fake.switches.foreign = { status: 503 };
    expect((await failure(client.call(WP_ROUTES.siteInfo, {}))).message).toContain('HTTP 503');
  });

  it('never follows a redirect', async () => {
    const client = await connected();
    fake.switches.redirectTo = 'https://www.elsewhere.example/wp-json/x?secret=1';
    const error = await failure(client.call(WP_ROUTES.siteInfo, {}));
    expect(wordPressErrorCode(error)).toBe('redirected');
    expect(error.message).toContain('https://www.elsewhere.example');
    expect(error.message).not.toContain('secret=1');
  });

  it('asks for an HTTP sign-in, and sends the saved one', async () => {
    const client = await connected();
    fake.switches.basicAuth = { username: 'stage', password: 'pw' };
    const missing = await failure(client.call(WP_ROUTES.siteInfo, {}));
    expect(wordPressErrorCode(missing)).toBe('httpAuthRequired');
    expect(missing.message).toContain('Add them');

    const signedIn = await connected({ httpAuth: { username: 'stage', password: 'pw' } });
    expect((await signedIn.call(WP_ROUTES.siteInfo, {})).data.siteName).toBe('Fake Shop');

    const wrong = new WpClient({
      ...(signedIn as unknown as { options: WpClientOptions }).options,
      httpAuth: { username: 'stage', password: 'nope' },
    });
    const refused = await failure(wrong.call(WP_ROUTES.siteInfo, {}));
    expect(wordPressErrorCode(refused)).toBe('httpAuthRequired');
    expect(refused.message).toContain('did not accept');
  });

  it('reports a web server 413 as too large', async () => {
    const client = await connected();
    fake.switches.maxBodyBytes = 100;
    const error = (await failure(client.call(WP_ROUTES.siteInfo, {}))) as WpRemoteError;
    expect(error.code).toBe('tooLarge');
    expect(error.status).toBe(413);
  });

  it('waits out the rate limiter, and reports a long wait instead of sleeping', async () => {
    const sleeps: number[] = [];
    const client = await connected({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    fake.switches.rateLimitNext = 2;
    expect((await client.call(WP_ROUTES.itemsList, {})).data.items).toEqual([]);
    expect(sleeps).toEqual([2000, 4000]);

    fake.switches.rateLimitNext = 1;
    fake.switches.retryAfter = 3;
    await client.call(WP_ROUTES.itemsList, {});
    expect(sleeps.at(-1)).toBe(3000);

    fake.switches.rateLimitNext = 1;
    fake.switches.retryAfter = 600;
    const error = await failure(client.call(WP_ROUTES.itemsList, {}));
    expect(wordPressErrorCode(error)).toBe('rateLimited');
    expect(error.message).toContain('10 minutes');

    fake.switches.rateLimitNext = 10;
    fake.switches.retryAfter = null;
    const gaveUp = await failure(client.call(WP_ROUTES.itemsList, {}));
    expect(gaveUp.message).toContain('Wait a few minutes');
  });

  it('refuses replies signed by another key or for another request', async () => {
    const client = await connected();
    fake.switches.badSignature = true;
    expect(wordPressErrorCode(await failure(client.call(WP_ROUTES.siteInfo, {})))).toBe(
      'badResponseSignature',
    );
    fake.switches.badSignature = false;
    fake.switches.replayReply = true;
    expect(wordPressErrorCode(await failure(client.call(WP_ROUTES.siteInfo, {})))).toBe(
      'badResponseSignature',
    );
  });

  it('fixes its clock once when the site says the time is stale', async () => {
    const client = await connected();
    fake.switches.clockSkew = 4000;
    await client.call(WP_ROUTES.siteInfo, {});
    expect(client.clockOffset).toBeGreaterThanOrEqual(3998);
    expect(client.siteNow()).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3990);
  });

  it('times out and cancels', async () => {
    const client = await connected({ timeoutMs: 100 });
    fake.switches.delayMs = 1000;
    const late = await failure(client.call(WP_ROUTES.siteInfo, {}));
    expect(wordPressErrorCode(late)).toBe('timeout');

    const controller = new AbortController();
    const pending = client.call(
      WP_ROUTES.siteInfo,
      {},
      { signal: controller.signal, timeoutMs: 5000 },
    );
    setTimeout(() => controller.abort(new WpRemoteError('cancelled', 'Stopped.')), 50);
    expect(wordPressErrorCode(await failure(pending))).toBe('cancelled');

    const done = new AbortController();
    done.abort(new WpRemoteError('cancelled', 'Stopped.'));
    expect(
      wordPressErrorCode(
        await failure(client.call(WP_ROUTES.siteInfo, {}, { signal: done.signal })),
      ),
    ).toBe('cancelled');
  });

  it('reaches rescue.php when the site itself is failing', async () => {
    const client = await connected();
    fake.switches.siteFatal = true;
    const { data } = await client.call(WP_ROUTES.rescueStatus, {});
    expect(data.pending).toBeNull();
    expect(fake.requests.at(-1)?.endpoint).toBe('rescue');
    expect(client.endpoint).toBe('rest');
    expect(wordPressErrorCode(await failure(client.call(WP_ROUTES.siteInfo, {})))).toBe(
      'foreignResponse',
    );
  });

  it('passes the site errors through, with their details, as text', async () => {
    const client = await connected();
    fake.connections.get(client.connectionId as string)!.revoked = true;
    const error = (await failure(client.call(WP_ROUTES.siteInfo, {}))) as WpRemoteError;
    expect(error.code).toBe('revoked');
    expect(error.status).toBe(401);
    expect(error.message).toBe('[wp:revoked] This connection was revoked.');

    const reader = await connected();
    await reader.call(WP_ROUTES.deployBegin, { label: 'x', items: [], ops: [] });
    const busy = (await failure(
      reader.call(WP_ROUTES.deployBegin, { label: 'y', items: [], ops: [] }),
    )) as WpRemoteError;
    expect(busy.code).toBe('busy');
    expect(typeof busy.details.deployId).toBe('string');
  });

  it('refuses a reply larger than it allows', async () => {
    fake.addItem({ kind: 'theme', slug: 'big' }, { 'a.bin': randomBytes(300_000) });
    const client = await connected({ maxResponseBytes: 50_000 });
    const error = await failure(
      client.call(WP_ROUTES.filesRead, {
        item: { kind: 'theme', slug: 'big' },
        files: [{ path: 'a.bin' }],
      }),
    );
    expect(wordPressErrorCode(error)).toBe('foreignResponse');
    expect(error.message).toContain('more than');
  });
});

describe('WpClient with a stub transport', () => {
  const siteKey = privateKeyFromSeed(seedBytes(WP_VECTORS.keys.site.seedHex));

  function client(reply: (url: string, auth: string) => WpHttpResponse): WpClient {
    const transport: WpTransport = async (request) => {
      const text = Buffer.from(request.body ?? []).toString('latin1');
      const auth = /name="am_auth"\r\n\r\n([^\r]+)/.exec(text)?.[1] ?? '';
      return reply(request.url, auth);
    };
    return new WpClient({
      transport,
      endpoints: {
        restUrl: 'https://shop.example/?rest_route=/runova/v1',
        ajaxUrl: 'https://shop.example/wp-admin/admin-ajax.php',
        rescueUrl: null,
      },
      sitePublicKey: WP_VECTORS.keys.site.publicKey,
      connectionId: null,
      privateKey: null,
      endpoint: 'rest',
    });
  }

  function signedReply(
    auth: string,
    route: string,
    body: unknown,
    status = 200,
    tamper?: (payload: Uint8Array) => Uint8Array,
  ): WpHttpResponse {
    const nonce = auth.split('.')[3];
    let payload = gzipBytes(encodeWpFrame({ route: route as never, body, blobs: [] }));
    if (tamper) payload = tamper(payload);
    const sig = signEd25519(
      siteKey,
      wpCanonicalResponse({
        route: '/hello',
        requestNonce: nonce,
        connectionId: null,
        timestamp: 1,
        httpStatus: status,
        bodySha256: sha256Hex(payload),
      }),
    );
    return {
      status,
      header: () => null,
      body: encodeWpResponse({ ts: 1, status, sig }, payload),
    };
  }

  it('sends the REST route inside rest_route for plain permalinks', async () => {
    const urls: string[] = [];
    const stub = client((url, auth) => {
      urls.push(url);
      return signedReply(auth, '/hello', { ok: true, data: { protocol: 1 } });
    });
    expect((await stub.call(WP_ROUTES.hello, {})).data).toEqual({ protocol: 1 });
    expect(new URL(urls[0]).searchParams.get('rest_route')).toBe('/runova/v1/hello');
  });

  it('refuses an unsigned reply that is not the rate limiter', async () => {
    const stub = client(() => ({
      status: 200,
      header: () => null,
      body: encodeWpResponse({ ts: 1, status: 200, sig: '' }, gzipBytes(new Uint8Array(1))),
    }));
    expect(wordPressErrorCode(await failure(stub.call(WP_ROUTES.hello, {})))).toBe(
      'badResponseSignature',
    );
  });

  it('takes a "too large" reply signed without the request, and nothing else signed that way', async () => {
    const withoutRequest = (status: number): WpHttpResponse => {
      const payload = gzipBytes(
        encodeWpFrame({
          route: '/hello',
          body: { ok: false, error: { code: 'tooLarge', message: 'Over post_max_size.' } },
          blobs: [],
        }),
      );
      const sig = signEd25519(
        siteKey,
        wpCanonicalResponse({
          route: '/hello',
          requestNonce: '-',
          connectionId: null,
          timestamp: 1,
          httpStatus: status,
          bodySha256: sha256Hex(payload),
        }),
      );
      return {
        status,
        header: () => null,
        body: encodeWpResponse({ ts: 1, status, sig }, payload),
      };
    };

    const tooLarge = client(() => withoutRequest(413));
    expect(wordPressErrorCode(await failure(tooLarge.call(WP_ROUTES.hello, {})))).toBe('tooLarge');

    const replayed = client(() => withoutRequest(200));
    expect(wordPressErrorCode(await failure(replayed.call(WP_ROUTES.hello, {})))).toBe(
      'badResponseSignature',
    );
  });

  it('refuses a signed reply it cannot read, or one for another route', async () => {
    const garbage = client((_url, auth) =>
      signedReply(auth, '/hello', {}, 200, () => new Uint8Array([1, 2, 3])),
    );
    expect(wordPressErrorCode(await failure(garbage.call(WP_ROUTES.hello, {})))).toBe('internal');

    const other = client((_url, auth) => signedReply(auth, '/pair', { ok: true, data: {} }));
    expect(wordPressErrorCode(await failure(other.call(WP_ROUTES.hello, {})))).toBe('internal');

    const shapeless = client((_url, auth) => signedReply(auth, '/hello', 'yes'));
    expect(wordPressErrorCode(await failure(shapeless.call(WP_ROUTES.hello, {})))).toBe('internal');

    for (const data of [null, 'text', [1]]) {
      const odd = client((_url, auth) => signedReply(auth, '/hello', { ok: true, data }));
      expect(wordPressErrorCode(await failure(odd.call(WP_ROUTES.hello, {})))).toBe('internal');
    }
  });

  it('cleans what the site says and maps unknown codes to internal', async () => {
    const stub = client((_url, auth) =>
      signedReply(
        auth,
        '/hello',
        {
          ok: false,
          error: { code: 'explode', message: `bad\u202e\nthing ${'x'.repeat(600)}`, details: [] },
        },
        500,
      ),
    );
    const error = (await failure(stub.call(WP_ROUTES.hello, {}))) as WpRemoteError;
    expect(error.code).toBe('internal');
    expect(error.message).not.toMatch(/[\n\u202e]/);
    expect(error.message.length).toBeLessThan(530);
    expect(error.details).toEqual({});

    const empty = client((_url, auth) =>
      signedReply(auth, '/hello', { ok: false, error: { code: 'readOnly' } }, 403),
    );
    expect((await failure(empty.call(WP_ROUTES.hello, {}))).message).toBe(
      '[wp:readOnly] The site refused the call (readOnly).',
    );
  });

  it('reads the wait from a signed rateLimited error', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const transport: WpTransport = async (request) => {
      calls += 1;
      const text = Buffer.from(request.body ?? []).toString('latin1');
      const auth = /name="am_auth"\r\n\r\n([^\r]+)/.exec(text)?.[1] ?? '';
      return calls === 1
        ? signedReply(
            auth,
            '/hello',
            {
              ok: false,
              error: { code: 'rateLimited', message: 'Slow', details: { retryAfter: 1 } },
            },
            429,
          )
        : signedReply(auth, '/hello', { ok: true, data: {} });
    };
    const stub = new WpClient({
      transport,
      endpoints: {
        restUrl: 'https://a.example/wp-json/runova/v1',
        ajaxUrl: 'https://a.example/x',
        rescueUrl: null,
      },
      sitePublicKey: WP_VECTORS.keys.site.publicKey,
      connectionId: null,
      privateKey: null,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await stub.call(WP_ROUTES.hello, {});
    expect(sleeps).toEqual([1000]);
  });

  it('passes other errors through untouched', async () => {
    const stub = new WpClient({
      transport: async () => {
        throw new Error('boom');
      },
      endpoints: {
        restUrl: 'https://a.example/wp-json/runova/v1',
        ajaxUrl: 'https://a.example/x',
        rescueUrl: null,
      },
      sitePublicKey: WP_VECTORS.keys.site.publicKey,
      connectionId: null,
      privateKey: null,
    });
    expect((await failure(stub.call(WP_ROUTES.hello, {}))).message).toBe('boom');
  });

  it('throws a staleTimestamp it cannot fix', async () => {
    const stub = client((_url, auth) =>
      signedReply(
        auth,
        '/hello',
        { ok: false, error: { code: 'staleTimestamp', message: 'Late' } },
        401,
      ),
    );
    expect(wordPressErrorCode(await failure(stub.call(WP_ROUTES.hello, {})))).toBe(
      'staleTimestamp',
    );
  });
});

describe('route URLs', () => {
  it('builds REST, ajax and rescue URLs', () => {
    expect(wpRestRouteUrl('https://a.example/wp-json/runova/v1/', '/site/info')).toBe(
      'https://a.example/wp-json/runova/v1/site/info',
    );
    expect(wpAjaxRouteUrl('https://a.example/wp-admin/admin-ajax.php', '/hello')).toBe(
      'https://a.example/wp-admin/admin-ajax.php?action=runova_connector&route=%2Fhello',
    );
    expect(wpRescueRouteUrl('https://a.example/r.php', '/rescue/status')).toBe(
      'https://a.example/r.php?route=%2Frescue%2Fstatus',
    );
  });
});

describe('batch sizing', () => {
  it('caps requests at 80% of what PHP takes, within the protocol bounds', () => {
    expect(wpRequestCap({ maxRequestBytes: 8 * 1024 * 1024 })).toBe(
      Math.floor(8 * 1024 * 1024 * 0.8),
    );
    expect(wpRequestCap({ maxRequestBytes: 1000 })).toBe(WP_BATCH_MIN_BYTES);
    expect(wpRequestCap({ maxRequestBytes: 1024 ** 3 })).toBe(WP_BATCH_MAX_BYTES);
  });

  it('starts at 512 KiB, doubles when quick, halves on 413, and gives up below 64 KiB', () => {
    const sizer = new WpBatchSizer(2 * 1024 * 1024, 1000);
    expect(sizer.current).toBe(512 * 1024);
    sizer.succeeded(5000);
    expect(sizer.current).toBe(512 * 1024);
    sizer.succeeded(10);
    sizer.succeeded(10);
    sizer.succeeded(10);
    expect(sizer.current).toBe(2 * 1024 * 1024);
    for (let step = 0; step < 5; step++) sizer.tooLarge();
    expect(sizer.current).toBe(WP_BATCH_MIN_BYTES);
    let error: unknown;
    try {
      sizer.tooLarge();
    } catch (caught) {
      error = caught;
    }
    expect(wordPressErrorCode(error)).toBe('bodyTooLarge');
    expect((error as Error).message).toContain('client_max_body_size');
    expect(new WpBatchSizer(100_000).current).toBe(100_000);
  });
});

vi.setConfig({ testTimeout: 20_000 });
