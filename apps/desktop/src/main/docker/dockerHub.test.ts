import { describe, expect, it, vi } from 'vitest';
import {
  DockerHubClient,
  type DockerHubFetch,
  DockerHubRejectedError,
  DockerHubSignedOutError,
} from './dockerHub';

/**
 * The Docker Hub view lists the signed-in account's repositories and their tags through Hub's
 * HTTP API. What can go wrong is mostly at the edges: the sign-in being refused, a token going
 * stale between calls, more repositories than one page holds, and Hub being unreachable.
 */

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeHub(routes: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetch: DockerHubFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return routes(url, init);
    }),
  };
}

const SIGN_IN = { username: 'hubber', secret: 'dckr_pat_x' };

function repo(name: string, lastUpdated = '2024-05-01T10:00:00.000000Z'): Record<string, unknown> {
  return {
    name,
    namespace: 'hubber',
    description: `${name} service`,
    is_private: name === 'secret',
    star_count: 3,
    pull_count: 1200,
    last_updated: lastUpdated,
  };
}

function standardRoutes(url: string): Response {
  if (url.endsWith('/v2/auth/token')) return json({ access_token: 'jwt-1' });
  if (url.includes('/repositories?')) {
    return json({ count: 2, next: null, results: [repo('api'), repo('secret')] });
  }
  return json({}, 404);
}

describe('DockerHubClient sign-in', () => {
  it('trades the saved sign-in for a token and sends it on every read', async () => {
    const hub = fakeHub(standardRoutes);
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await client.repositories();

    const [auth, list] = hub.calls;
    expect(auth.url).toBe('https://hub.docker.com/v2/auth/token');
    expect(auth.init.method).toBe('POST');
    expect(JSON.parse(String(auth.init.body))).toEqual({
      identifier: 'hubber',
      secret: 'dckr_pat_x',
    });
    expect(new Headers(list.init.headers).get('authorization')).toBe('Bearer jwt-1');
  });

  it('reuses the token for a while instead of signing in for every call', async () => {
    const hub = fakeHub(standardRoutes);
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await client.repositories();
    await client.repositories();

    expect(hub.calls.filter((call) => call.url.endsWith('/auth/token'))).toHaveLength(1);
  });

  it('signs in again once the cached token is old', async () => {
    let now = 0;
    const hub = fakeHub(standardRoutes);
    const client = new DockerHubClient({
      signIn: async () => SIGN_IN,
      fetch: hub.fetch,
      now: () => now,
    });

    await client.repositories();
    now += 10 * 60_000;
    await client.repositories();

    expect(hub.calls.filter((call) => call.url.endsWith('/auth/token'))).toHaveLength(2);
  });

  it('signs in again when the saved sign-in was replaced', async () => {
    let signIn = SIGN_IN;
    const hub = fakeHub(standardRoutes);
    const client = new DockerHubClient({ signIn: async () => signIn, fetch: hub.fetch });

    await client.repositories();
    signIn = { username: 'other', secret: 'dckr_pat_y' };
    await client.repositories();

    const auths = hub.calls.filter((call) => call.url.endsWith('/auth/token'));
    expect(JSON.parse(String(auths[1]?.init.body))).toMatchObject({ identifier: 'other' });
    expect(hub.calls.at(-1)?.url).toContain('/v2/namespaces/other/repositories');
  });

  it('falls back to the older login endpoint where the token one is missing', async () => {
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({}, 404);
      if (url.endsWith('/v2/users/login')) return json({ token: 'jwt-old' });
      return standardRoutes(url);
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await client.repositories();

    const login = hub.calls.find((call) => call.url.endsWith('/v2/users/login'));
    expect(JSON.parse(String(login?.init.body))).toEqual({
      username: 'hubber',
      password: 'dckr_pat_x',
    });
    expect(new Headers(hub.calls.at(-1)?.init.headers).get('authorization')).toBe('Bearer jwt-old');
  });

  it('says so plainly when Docker Hub refuses the sign-in', async () => {
    const hub = fakeHub(() => json({ detail: 'Incorrect authentication credentials' }, 401));
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await expect(client.repositories()).rejects.toBeInstanceOf(DockerHubRejectedError);
  });

  it('throws a signed-out error when there is no saved sign-in', async () => {
    const hub = fakeHub(standardRoutes);
    const client = new DockerHubClient({ signIn: async () => null, fetch: hub.fetch });

    await expect(client.repositories()).rejects.toBeInstanceOf(DockerHubSignedOutError);
    expect(hub.calls).toHaveLength(0);
  });

  it('drops a token Hub stopped taking and retries once with a fresh one', async () => {
    let tokens = 0;
    let listCalls = 0;
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({ access_token: `jwt-${++tokens}` });
      listCalls += 1;
      return listCalls === 1 ? json({}, 401) : json({ next: null, results: [repo('api')] });
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    const repositories = await client.repositories();

    expect(repositories).toHaveLength(1);
    expect(new Headers(hub.calls.at(-1)?.init.headers).get('authorization')).toBe('Bearer jwt-2');
  });

  it('reports an unreachable Hub with the reason', async () => {
    const client = new DockerHubClient({
      signIn: async () => SIGN_IN,
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND hub.docker.com');
      },
    });

    await expect(client.repositories()).rejects.toThrow(
      'Docker Hub could not be reached: getaddrinfo ENOTFOUND hub.docker.com',
    );
  });

  it('names rate limiting rather than showing a bare status code', async () => {
    const hub = fakeHub((url) =>
      url.endsWith('/v2/auth/token') ? json({ access_token: 'jwt' }) : json({}, 429),
    );
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await expect(client.repositories()).rejects.toThrow(/too many requests/i);
  });
});

describe('DockerHubClient.repositories', () => {
  it("lists the signed-in account's repositories, newest push first", async () => {
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({ access_token: 'jwt' });
      return json({
        next: null,
        results: [repo('old', '2023-01-01T00:00:00Z'), repo('secret', '2024-06-01T00:00:00Z')],
      });
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    const repositories = await client.repositories();

    expect(hub.calls[1]?.url).toBe(
      'https://hub.docker.com/v2/namespaces/hubber/repositories?page_size=100&ordering=last_updated',
    );
    expect(repositories).toEqual([
      {
        namespace: 'hubber',
        name: 'secret',
        description: 'secret service',
        isPrivate: true,
        starCount: 3,
        pullCount: 1200,
        lastUpdated: Date.parse('2024-06-01T00:00:00Z'),
      },
      expect.objectContaining({ name: 'old', isPrivate: false }),
    ]);
  });

  it('follows the next links across pages', async () => {
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({ access_token: 'jwt' });
      if (url.includes('page=2')) return json({ next: null, results: [repo('b')] });
      return json({
        next: 'https://hub.docker.com/v2/namespaces/hubber/repositories?page=2&page_size=100',
        results: [repo('a')],
      });
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    const repositories = await client.repositories();

    expect(repositories.map((item) => item.name).sort()).toEqual(['a', 'b']);
  });

  it('stops after ten pages so a huge organisation cannot stall the view', async () => {
    let page = 0;
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({ access_token: 'jwt' });
      page += 1;
      return json({
        next: `https://hub.docker.com/v2/namespaces/hubber/repositories?page=${page + 1}`,
        results: [repo(`r${page}`)],
      });
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    const repositories = await client.repositories();

    expect(repositories).toHaveLength(10);
  });

  it('never follows a next link off Docker Hub, since it carries the token', async () => {
    const hub = fakeHub((url) => {
      if (url.endsWith('/v2/auth/token')) return json({ access_token: 'jwt' });
      return json({ next: 'https://evil.example/steal', results: [repo('a')] });
    });
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await client.repositories();

    expect(hub.calls.some((call) => call.url.startsWith('https://evil.example'))).toBe(false);
  });
});

describe('DockerHubClient.tags', () => {
  const TAGS = {
    next: null,
    results: [
      {
        name: '1.3',
        full_size: 52_000_000,
        last_updated: '2024-04-01T00:00:00Z',
        digest: 'sha256:old',
        images: [{ os: 'linux', architecture: 'amd64' }],
      },
      {
        name: '1.4',
        full_size: 54_000_000,
        last_updated: '2024-05-01T00:00:00Z',
        digest: 'sha256:new',
        images: [
          { os: 'linux', architecture: 'amd64' },
          { os: 'linux', architecture: 'arm64', variant: 'v8' },
          // Build attestations show up as their own "unknown" platform.
          { os: 'unknown', architecture: 'unknown' },
          { os: 'linux', architecture: 'amd64' },
        ],
      },
    ],
  };

  it("lists a repository's tags, newest first, with their platforms", async () => {
    const hub = fakeHub((url) =>
      url.endsWith('/v2/auth/token') ? json({ access_token: 'jwt' }) : json(TAGS),
    );
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    const tags = await client.tags('hubber', 'api');

    expect(hub.calls[1]?.url).toBe(
      'https://hub.docker.com/v2/namespaces/hubber/repositories/api/tags?page_size=100&ordering=last_updated',
    );
    expect(tags).toEqual([
      {
        name: '1.4',
        sizeBytes: 54_000_000,
        lastPushed: Date.parse('2024-05-01T00:00:00Z'),
        digest: 'sha256:new',
        platforms: ['linux/amd64', 'linux/arm64/v8'],
      },
      expect.objectContaining({ name: '1.3', platforms: ['linux/amd64'] }),
    ]);
  });

  it('encodes the names it puts in the path', async () => {
    const hub = fakeHub((url) =>
      url.endsWith('/v2/auth/token') ? json({ access_token: 'jwt' }) : json(TAGS),
    );
    const client = new DockerHubClient({ signIn: async () => SIGN_IN, fetch: hub.fetch });

    await client.tags('hub ber', 'a/b');

    expect(hub.calls[1]?.url).toContain('/namespaces/hub%20ber/repositories/a%2Fb/tags');
  });
});
