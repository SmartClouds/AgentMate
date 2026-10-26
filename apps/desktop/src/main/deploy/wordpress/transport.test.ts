import { describe, expect, it } from 'vitest';
import { wordPressError, wordPressErrorCode } from '../../../shared/wordpressErrors';
import { cleanSiteOrigin, cleanSiteText } from './siteText';
import { createFetchTransport, networkError, type WpHttpRequest } from './transport';

/**
 * How network failures turn into `[wp:code]` errors, as Electron's net.fetch reports them
 * (net::ERR_* messages, "Redirect was cancelled") and as Node's fetch does (a cause code).
 */

function request(overrides: Partial<WpHttpRequest> = {}): WpHttpRequest {
  return {
    url: 'https://shop.example/wp-json/runova/v1/hello',
    method: 'POST',
    headers: {},
    body: new Uint8Array([1]),
    signal: new AbortController().signal,
    maxResponseBytes: 1000,
    ...overrides,
  };
}

function withCause(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

describe('networkError', () => {
  it('maps Electron and Node failures to codes', () => {
    const cases: [unknown, string][] = [
      [new Error('net::ERR_CERT_AUTHORITY_INVALID'), 'tlsUntrusted'],
      [new Error('net::ERR_CERT_DATE_INVALID'), 'tlsUntrusted'],
      [withCause('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tlsUntrusted'],
      [withCause('ERR_TLS_CERT_ALTNAME_INVALID'), 'tlsUntrusted'],
      [new Error('Redirect was cancelled'), 'redirected'],
      [new Error("Attempted to redirect, but redirect policy was 'error'"), 'redirected'],
      [new Error('net::ERR_UNSAFE_PORT'), 'unreachable'],
      [new Error('net::ERR_TIMED_OUT'), 'timeout'],
      [withCause('UND_ERR_HEADERS_TIMEOUT'), 'timeout'],
      [new Error('net::ERR_NAME_NOT_RESOLVED'), 'unreachable'],
      [withCause('ECONNREFUSED'), 'unreachable'],
      ['weird', 'unreachable'],
    ];
    for (const [error, code] of cases) {
      expect(wordPressErrorCode(networkError(error, request())), String(error)).toBe(code);
    }
    expect(networkError(new Error('net::ERR_NAME_NOT_RESOLVED'), request()).message).toContain(
      'shop.example (ERR_NAME_NOT_RESOLVED)',
    );
    expect(networkError(new Error('x'), request({ url: 'not a url' })).message).toContain(
      'Could not reach the site.',
    );
  });

  it('reports an aborted call with the reason it was aborted for', () => {
    const controller = new AbortController();
    controller.abort(wordPressError('timeout', 'Too slow.'));
    expect(
      networkError(new Error('AbortError'), request({ signal: controller.signal })).message,
    ).toBe('[wp:timeout] Too slow.');
    const plain = new AbortController();
    plain.abort('just because');
    expect(
      wordPressErrorCode(networkError(new Error('x'), request({ signal: plain.signal }))),
    ).toBe('cancelled');
  });
});

describe('createFetchTransport', () => {
  it('sends no cookies, never follows redirects, and reads the body', async () => {
    const seen: Record<string, unknown>[] = [];
    const transport = createFetchTransport(async (_url, init) => {
      seen.push(init as unknown as Record<string, unknown>);
      return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { 'x-a': 'b' } });
    });
    const response = await transport(request());
    expect([...response.body]).toEqual([9, 8, 7]);
    expect(response.header('x-a')).toBe('b');
    expect(seen[0]).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' });

    const noBody = createFetchTransport(async () => new Response(null, { status: 204 }));
    expect((await noBody(request({ body: undefined, method: 'GET' }))).body.length).toBe(0);
  });

  it('turns a 3xx into a redirect error that names only the origin', async () => {
    const transport = createFetchTransport(
      async () =>
        new Response('moved', {
          status: 301,
          headers: { location: 'https://www.shop.example/path?token=abc' },
        }),
    );
    const error = (await transport(request()).catch((caught) => caught)) as Error;
    expect(wordPressErrorCode(error)).toBe('redirected');
    expect(error.message).toContain('https://www.shop.example');
    expect(error.message).not.toContain('token');

    const opaque = createFetchTransport(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    });
    expect(wordPressErrorCode(await opaque(request()).catch((caught) => caught))).toBe(
      'redirected',
    );
  });

  it('refuses a reply that is too large, by its header or as it streams', async () => {
    const declared = createFetchTransport(
      async () => new Response('x', { headers: { 'content-length': '5000' } }),
    );
    expect(wordPressErrorCode(await declared(request()).catch((caught) => caught))).toBe(
      'foreignResponse',
    );
    const streamed = createFetchTransport(async () => new Response(new Uint8Array(2000)));
    expect(wordPressErrorCode(await streamed(request()).catch((caught) => caught))).toBe(
      'foreignResponse',
    );
  });

  it('maps a failure while the body streams', async () => {
    const broken = createFetchTransport(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('net::ERR_CONNECTION_RESET'));
            },
          }),
        ),
    );
    expect(wordPressErrorCode(await broken(request()).catch((caught) => caught))).toBe(
      'unreachable',
    );
    const refused = createFetchTransport(async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });
    expect(wordPressErrorCode(await refused(request()).catch((caught) => caught))).toBe(
      'unreachable',
    );
  });
});

describe('site text', () => {
  it('strips control and bidi characters and cuts long text', () => {
    expect(cleanSiteText('  My\u0000 Shop\u202e\n\t ', 50)).toBe('My Shop');
    expect(cleanSiteText(42, 10)).toBe('');
    expect(cleanSiteText('abcdefghij', 6)).toBe('abc...');
    expect(cleanSiteText('\u00e9'.repeat(5), 5)).toBe('\u00e9\u00e9\u00e9\u00e9\u00e9');
  });

  it('keeps only the origin of a site URL', () => {
    expect(cleanSiteOrigin('https://a.example:8443/x?y=1')).toBe('https://a.example:8443');
    expect(cleanSiteOrigin('javascript:alert(1)')).toBe('');
    expect(cleanSiteOrigin('not a url')).toBe('');
    expect(cleanSiteOrigin(null)).toBe('');
  });
});
