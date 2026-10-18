import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TOKEN, type FakeSentry, startFakeSentry } from '../../test/main/fakeSentry';
import { json, startHttpServer } from '../../test/main/fixtures';
import {
  createSentryClient,
  SENTRY_MAX_BODY_BYTES,
  SentryApiError,
  type SentryClientOptions,
  type SentryTransport,
} from './sentryClient';

/**
 * The Sentry HTTP client (E24) against a Sentry on loopback: what it sends, where it sends it,
 * and how every way a call can fail reads to the user. The token goes in one header to the one
 * host it was given, never to a redirect, and never into an error message.
 */

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function sentry(options: Parameters<typeof startFakeSentry>[0] = {}): Promise<FakeSentry> {
  const fake = await startFakeSentry(options);
  servers.push(fake);
  return fake;
}

function client(baseUrl: string, overrides: Partial<SentryClientOptions> = {}) {
  return createSentryClient({
    baseUrl,
    token: FAKE_TOKEN,
    transport: (url, init) => fetch(url, init),
    ...overrides,
  });
}

async function failure(work: Promise<unknown>): Promise<SentryApiError> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SentryApiError);
  const apiError = error as SentryApiError;
  expect(apiError.message).not.toContain(FAKE_TOKEN);
  expect(apiError.message).not.toContain(FAKE_TOKEN.slice(7));
  return apiError;
}

describe('requests', () => {
  it('sends the token as a Bearer header and nothing ambient', async () => {
    const fake = await sentry();
    const transport = vi.fn<SentryTransport>((url, init) => fetch(url, init));
    await client(fake.url, { transport }).listOrgs();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(`${fake.url}/api/0/organizations/`);
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: expect.objectContaining({ Authorization: `Bearer ${FAKE_TOKEN}` }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('keeps a self-hosted base path and drops a trailing slash', async () => {
    const fake = await sentry();
    fake.state.override = (request, response, url) => {
      if (!url.pathname.startsWith('/sentry/')) return false;
      json(response, [{ path: url.pathname, auth: request.headers.authorization }]);
      return true;
    };
    const data = await client(`${fake.url}/sentry/`).listOrgs();
    expect(data).toEqual([{ path: '/sentry/api/0/organizations/', auth: `Bearer ${FAKE_TOKEN}` }]);
  });

  it('reads the scopes from the API root', async () => {
    const fake = await sentry({ scopes: ['org:read', 'event:read'] });
    expect(await client(fake.url).root()).toEqual({ scopes: ['org:read', 'event:read'] });
  });

  it('reads unknown scopes as null', async () => {
    const fake = await sentry({ scopes: null });
    expect(await client(fake.url).root()).toEqual({ scopes: null });
    fake.state.override = (_request, response) => {
      json(response, { detail: 'nope' }, 404);
      return true;
    };
    expect(await client(fake.url).root()).toEqual({ scopes: null });
    fake.state.override = (_request, response) => {
      json(response, { auth: { scopes: 'not a list' } });
      return true;
    };
    expect(await client(fake.url).root()).toEqual({ scopes: null });
  });

  it('still refuses a rejected token at the root', async () => {
    const fake = await sentry();
    const error = await failure(client(fake.url, { token: 'sntryu_wrong' }).root());
    expect(error.kind).toBe('unauthorized');
  });

  it('lists projects with a cursor and returns the Link header', async () => {
    const fake = await sentry();
    fake.state.override = (_request, response, url) => {
      if (!url.pathname.endsWith('/projects/')) return false;
      response.writeHead(200, {
        'content-type': 'application/json',
        link: '<x>; rel="next"; results="false"; cursor="0:100:0"',
      });
      response.end(JSON.stringify([{ id: '1', cursor: url.searchParams.get('cursor') }]));
      return true;
    };
    const reply = await client(fake.url).listProjects('acme', '0:100:0');
    expect(reply).toEqual({
      data: [{ id: '1', cursor: '0:100:0' }],
      link: '<x>; rel="next"; results="false"; cursor="0:100:0"',
    });
    expect((await client(fake.url).listProjects('acme')).data).toEqual([{ id: '1', cursor: null }]);
  });

  it('lists environments of a project', async () => {
    const fake = await sentry();
    const data = await client(fake.url).listEnvironments('acme', 'storefront-api');
    expect(data).toEqual([
      { id: '1', name: 'production', isHidden: false },
      { id: '2', name: 'staging', isHidden: false },
    ]);
    expect(fake.requestsTo('/api/0/projects/acme/storefront-api/environments/')).toHaveLength(1);
  });

  it('escapes path segments', async () => {
    const fake = await sentry();
    await failure(client(fake.url).listEnvironments('a/b', '../x'));
    expect(fake.requests[0].url).toBe('/api/0/projects/a%2Fb/..%2Fx/environments/');
  });
});

describe('issues', () => {
  it('sends every filter, one project parameter per id, and returns the Link cursor', async () => {
    const fake = await sentry();
    fake.state.issueLink =
      '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"';
    const reply = await client(fake.url).listIssues('acme', {
      projects: [
        { id: '101', slug: 'storefront-web' },
        { id: '102', slug: 'storefront-api' },
      ],
      environment: 'production',
      statsPeriod: '24h',
      query: 'is:unresolved checkout',
      sort: 'date',
      limit: 50,
      cursor: '0:50:0',
    });
    const sent = new URL(fake.requests[0].url, 'http://x');
    expect(sent.pathname).toBe('/api/0/organizations/acme/issues/');
    expect(sent.searchParams.getAll('project')).toEqual(['101', '102']);
    expect(Object.fromEntries([...sent.searchParams].filter(([key]) => key !== 'project'))).toEqual(
      {
        environment: 'production',
        statsPeriod: '24h',
        query: 'is:unresolved checkout',
        sort: 'date',
        limit: '50',
        cursor: '0:50:0',
      },
    );
    expect((reply.data as unknown[]).length).toBe(2);
    expect(reply.link).toBe(fake.state.issueLink);
  });

  it('sends an empty query explicitly, since Sentry reads a missing one as unresolved', async () => {
    const fake = await sentry();
    const reply = await client(fake.url).listIssues('acme', {
      projects: [{ id: '102', slug: 'storefront-api' }],
      statsPeriod: '14d',
      query: '',
      sort: 'freq',
      limit: 25,
    });
    expect(fake.requests[0].url).toContain('query=&');
    expect(fake.requests[0].url).not.toContain('environment');
    expect(fake.requests[0].url).not.toContain('cursor');
    expect(reply.link).toBeNull();
  });

  it('reads one issue, its latest event and changes its status', async () => {
    const fake = await sentry();
    const api = client(fake.url);
    expect(await api.getIssue('acme', '4501')).toMatchObject({ id: '4501' });
    expect(await api.latestEvent('acme', '4501')).toMatchObject({
      eventID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
    expect(await api.updateStatus('acme', '4501', { status: 'resolved' })).toMatchObject({
      status: 'resolved',
    });
    const put = fake.requestsTo('/api/0/organizations/acme/issues/4501/', 'PUT');
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0].body)).toEqual({ status: 'resolved' });
    expect(put[0].headers['content-type']).toBe('application/json');
  });
});

describe('GlitchTip fallback', () => {
  it('lists issues per project on the older path when the organization path is missing', async () => {
    const fake = await sentry({ glitchtip: true });
    const reply = await client(fake.url).listIssues('acme', {
      projects: [
        { id: '101', slug: 'storefront-web' },
        { id: '102', slug: 'storefront-api' },
      ],
      statsPeriod: '24h',
      query: 'is:unresolved',
      sort: 'date',
      limit: 25,
    });
    expect((reply.data as { id: string }[]).map((issue) => issue.id).sort()).toEqual([
      '4501',
      '4502',
    ]);
    expect(fake.requestsTo('/api/0/projects/acme/storefront-web/issues/')).toHaveLength(1);
    expect(fake.requestsTo('/api/0/projects/acme/storefront-api/issues/')).toHaveLength(1);
    expect(reply.link).toBeNull();
  });

  it('keeps the cursor of a single project on the older path', async () => {
    const fake = await sentry({ glitchtip: true });
    fake.state.issueLink = '<x>; rel="next"; results="true"; cursor="0:25:0"';
    const reply = await client(fake.url).listIssues('acme', {
      projects: [{ id: '102', slug: 'storefront-api' }],
      statsPeriod: '24h',
      query: '',
      sort: 'date',
      limit: 25,
    });
    expect(reply.link).toBe(fake.state.issueLink);
  });

  it('reads, changes and opens the latest event of an issue on the older paths', async () => {
    const fake = await sentry({ glitchtip: true });
    const api = client(fake.url);
    expect(await api.getIssue('acme', '4501')).toMatchObject({ id: '4501' });
    expect(await api.latestEvent('acme', '4501')).toMatchObject({ platform: 'node' });
    await api.updateStatus('acme', '4501', { status: 'ignored' });
    expect(fake.requestsTo('/api/0/issues/4501/', 'PUT')).toHaveLength(1);
    expect(fake.state.issues[0].status).toBe('ignored');
  });

  it('says not found when neither path has it', async () => {
    const fake = await sentry({ glitchtip: true });
    const error = await failure(client(fake.url).latestEvent('acme', '4502'));
    expect(error.kind).toBe('notFound');
    expect(error.status).toBe(404);
  });

  it('does not fall back without a project to ask about', async () => {
    const fake = await sentry({ glitchtip: true });
    const error = await failure(
      client(fake.url).listIssues('acme', {
        projects: [],
        statsPeriod: '24h',
        query: '',
        sort: 'date',
        limit: 25,
      }),
    );
    expect(error.kind).toBe('notFound');
  });
});

describe('errors read well and never hold the token', () => {
  async function answering(status: number, headers: Record<string, string> = {}, body = '{}') {
    const fake = await sentry();
    fake.state.override = (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(body);
      return true;
    };
    return fake;
  }

  it('401: the token was rejected', async () => {
    const fake = await sentry();
    const error = await failure(client(fake.url, { token: 'sntryu_wrong' }).listOrgs());
    expect(error).toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(error.message).toMatch(/Sentry rejected the token/);
  });

  it('403: names the scope the call needed', async () => {
    const fake = await sentry({ scopes: ['org:read', 'project:read', 'event:read'] });
    const error = await failure(
      client(fake.url).updateStatus('acme', '4501', { status: 'resolved' }),
    );
    expect(error).toMatchObject({ kind: 'forbidden', status: 403, scope: 'event:write' });
    expect(error.message).toContain('event:write');

    const refusing = await answering(403);
    const read = await failure(client(refusing.url).listOrgs());
    expect(read).toMatchObject({ kind: 'forbidden', scope: 'org:read' });
    expect(read.message).toContain('org:read');
  });

  it('403 on projects and issues names their scopes', async () => {
    const fake = await answering(403);
    expect((await failure(client(fake.url).listProjects('acme'))).scope).toBe('project:read');
    expect((await failure(client(fake.url).latestEvent('acme', '1'))).scope).toBe('event:read');
  });

  it('404: not found', async () => {
    const fake = await answering(404);
    const error = await failure(client(fake.url).listOrgs());
    expect(error).toMatchObject({ kind: 'notFound', status: 404 });
    expect(error.message).toMatch(/could not find/);
  });

  it('429: says when to try again, from the reset time', async () => {
    const fake = await answering(429, { 'x-sentry-rate-limit-reset': '1760000042' });
    const error = await failure(client(fake.url, { now: () => 1760000000_000 }).listOrgs());
    expect(error).toMatchObject({ kind: 'rateLimited', status: 429 });
    expect(error.message).toBe('Sentry is rate limiting requests, try again in 42s.');
    expect(fake.requests).toHaveLength(1);
  });

  it('429: falls back to Retry-After, then to no time at all', async () => {
    let fake = await answering(429, { 'retry-after': '7' });
    expect((await failure(client(fake.url).listOrgs())).message).toBe(
      'Sentry is rate limiting requests, try again in 7s.',
    );
    fake = await answering(429);
    expect((await failure(client(fake.url).listOrgs())).message).toBe(
      'Sentry is rate limiting requests, try again in a minute.',
    );
  });

  it('5xx: Sentry had a problem', async () => {
    const fake = await answering(503);
    const error = await failure(client(fake.url).listOrgs());
    expect(error).toMatchObject({ kind: 'server', status: 503 });
    expect(error.message).toMatch(/HTTP 503/);
  });

  it('another 4xx shows the detail Sentry gave, with the token masked', async () => {
    const fake = await answering(400, {}, JSON.stringify({ detail: `bad token ${FAKE_TOKEN}` }));
    const error = await failure(client(fake.url).listOrgs());
    expect(error).toMatchObject({ kind: 'http', status: 400 });
    expect(error.message).toMatch(/HTTP 400: bad token/);
  });

  it('another 4xx without a detail', async () => {
    const fake = await answering(418, {}, 'teapot');
    expect((await failure(client(fake.url).listOrgs())).message).toBe(
      'Sentry refused the request (HTTP 418).',
    );
  });

  it('a reply that is not JSON', async () => {
    const fake = await answering(200, {}, '<html>login</html>');
    const error = await failure(client(fake.url).listOrgs());
    expect(error.kind).toBe('invalid');
  });

  it('an empty reply reads as null', async () => {
    const fake = await answering(200, {}, '');
    expect(await client(fake.url).updateStatus('acme', '1', { status: 'resolved' })).toBeNull();
  });

  it('refuses a redirect, so its target never sees the token', async () => {
    const elsewhere = await startHttpServer((_request, response) => json(response, []));
    servers.push(elsewhere);
    const fake = await sentry();
    fake.state.override = (_request, response) => {
      response.writeHead(302, { location: `${elsewhere.url}/steal` });
      response.end();
      return true;
    };
    const error = await failure(client(fake.url).listOrgs());
    expect(error.kind).toBe('redirect');
    expect(error.message).toMatch(/redirect/);
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("treats Electron's opaque redirect as a redirect", async () => {
    const transport: SentryTransport = async () =>
      ({ type: 'opaqueredirect', status: 0, body: null, headers: new Headers() }) as Response;
    const error = await failure(client('https://sentry.io', { transport }).listOrgs());
    expect(error.kind).toBe('redirect');
  });

  it("treats Electron's cancelled redirect as a redirect", async () => {
    const transport: SentryTransport = async () => {
      throw new Error('Redirect was cancelled');
    };
    expect((await failure(client('https://sentry.io', { transport }).listOrgs())).kind).toBe(
      'redirect',
    );
  });

  it('times out', async () => {
    const fake = await sentry();
    fake.state.override = () => true;
    const error = await failure(client(fake.url, { timeoutMs: 200 }).listOrgs());
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe('Sentry did not answer within 0.2 s.');
  });

  it('defaults to a 15 second timeout', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const fake = await sentry();
    await client(fake.url).listOrgs();
    expect(spy).toHaveBeenCalledWith(15_000);
    spy.mockRestore();
  });

  it('stops reading a body over the cap, declared or not', async () => {
    const big = 'x'.repeat(SENTRY_MAX_BODY_BYTES + 10);
    let fake = await sentry();
    fake.state.override = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(`"${big}"`);
      return true;
    };
    expect((await failure(client(fake.url).listOrgs())).kind).toBe('tooLarge');

    fake = await sentry();
    fake.state.override = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(`"${big.slice(0, 1024 * 1024)}`);
      response.write(big.slice(0, 1024 * 1024));
      response.end(`${big.slice(0, 1024)}"`);
      return true;
    };
    expect((await failure(client(fake.url).listOrgs())).kind).toBe('tooLarge');
  });

  it('a refused connection', async () => {
    const fake = await sentry();
    const url = fake.url;
    await fake.close();
    servers.pop();
    const error = await failure(client(url).listOrgs());
    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/refused/);
  });

  function failing(error: unknown): SentryTransport {
    return async () => {
      throw error;
    };
  }

  it.each([
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /resolved/],
    [new Error('net::ERR_NAME_NOT_RESOLVED'), /resolved/],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), /certificate/],
    [
      Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
      }),
      /certificate/,
    ],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), /reset/],
    [new Error('net::ERR_CONNECTION_TIMED_OUT'), /timed out/i],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), /ERR_INTERNET_DISCONNECTED/],
    [Object.assign(new Error('Aborted'), { name: 'AbortError' }), /did not answer/],
    ['a plain string', /a plain string/],
  ])('explains %s', async (error, message) => {
    const caught = await failure(
      client('https://sentry.io', { transport: failing(error) }).listOrgs(),
    );
    expect(caught.message).toMatch(message);
  });

  it('masks the token in a network error that holds it', async () => {
    const caught = await failure(
      client('https://sentry.io', {
        transport: failing(new Error(`bad header Bearer ${FAKE_TOKEN}`)),
      }).listOrgs(),
    );
    expect(caught.message).toMatch(/Could not reach sentry\.io/);
  });
});
