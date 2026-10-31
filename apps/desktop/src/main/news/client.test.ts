import { describe, expect, it, vi } from 'vitest';
import type { NewsItemDetail, NewsListItem } from '../../shared/newsTypes';
import {
  createNewsClient,
  DEFAULT_NEWS_API_URL,
  type NewsCache,
  newsApiBaseUrl,
  newsUserAgent,
} from './client';

/**
 * The news client (E42): GET /api/v1/news with ETag caching, and the cached list served marked
 * stale whenever the API cannot be reached or answers something unusable.
 */

function newsItem(id: number, overrides: Partial<NewsListItem> = {}): NewsListItem {
  return {
    id,
    slug: `item-${id}`,
    url: `https://runovahq.com/news/item-${id}`,
    title: `Item ${id}`,
    summary: 'Summary.',
    category: 'release',
    severity: 'info',
    technologies: [],
    cveIds: [],
    cvssScore: null,
    tags: [],
    publishedAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
    ...overrides,
  };
}

function page(items: unknown[]): unknown {
  return { items, page: 1, pageSize: 50, totalItems: items.length, totalPages: 1 };
}

function json(body: unknown, status = 200, etag: string | null = 'W/"v1"'): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (etag) headers.etag = etag;
  return new Response(JSON.stringify(body), { status, headers });
}

function setup(options: { cache?: NewsCache | null; now?: string } = {}) {
  let cache: NewsCache | null = options.cache ?? null;
  const fetch = vi.fn<typeof globalThis.fetch>();
  const log = vi.fn<(message: string) => void>();
  const client = createNewsClient({
    fetch,
    baseUrl: 'https://runovahq.com/api/v1',
    userAgent: 'Runova/3.0.0 (win32)',
    timeoutMs: 50,
    readCache: async () => cache,
    writeCache: async (next) => {
      cache = next;
    },
    now: () => new Date(options.now ?? '2026-10-31T10:00:00.000Z'),
    log,
  });
  return { client, fetch, log, cache: () => cache };
}

const cached: NewsCache = {
  etag: 'W/"v1"',
  checkedAt: '2026-10-31T09:00:00.000Z',
  items: [newsItem(1)],
  details: {},
};

describe('fetching the list', () => {
  it('asks for the newest 50 with the app as the user agent and nothing about the user', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json(page([])));

    await client.fetchList();

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://runovahq.com/api/v1/news?pageSize=50&sort=-publishedAt');
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('Runova/3.0.0 (win32)');
    expect(headers.get('if-none-match')).toBeNull();
    expect(init?.credentials).toBe('omit');
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
  });

  it('caches a 200 with its ETag', async () => {
    const { client, fetch, cache } = setup();
    fetch.mockResolvedValue(json(page([newsItem(1), newsItem(2)]), 200, 'W/"abc"'));

    const result = await client.fetchList();

    expect(result).toMatchObject({ ok: true, stale: false, checkedAt: '2026-10-31T10:00:00.000Z' });
    expect(result.items.map((item) => item.id)).toEqual([1, 2]);
    expect(cache()).toMatchObject({ etag: 'W/"abc"', checkedAt: '2026-10-31T10:00:00.000Z' });
    expect(cache()?.items).toHaveLength(2);
  });

  it('sends If-None-Match, and a 304 keeps the cache and only moves checkedAt', async () => {
    const { client, fetch, cache } = setup({ cache: cached });
    fetch.mockResolvedValue(new Response(null, { status: 304 }));

    const result = await client.fetchList();

    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('if-none-match')).toBe('W/"v1"');
    expect(result).toMatchObject({ ok: true, stale: false, checkedAt: '2026-10-31T10:00:00.000Z' });
    expect(result.items).toEqual(cached.items);
    expect(cache()).toEqual({ ...cached, checkedAt: '2026-10-31T10:00:00.000Z' });
  });

  it('serves the cache marked stale when the network fails', async () => {
    const { client, fetch, cache } = setup({ cache: cached });
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    const result = await client.fetchList();

    expect(result).toEqual({
      ok: false,
      stale: true,
      checkedAt: '2026-10-31T09:00:00.000Z',
      items: cached.items,
    });
    expect(cache()).toEqual(cached);
  });

  it('serves an empty stale list when there is no cache to fall back on', async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.fetchList()).resolves.toEqual({
      ok: false,
      stale: true,
      checkedAt: null,
      items: [],
    });
  });

  it('gives up after the timeout and serves the cache', async () => {
    const { client, fetch } = setup({ cache: cached });
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const result = await client.fetchList();

    expect(result).toMatchObject({ ok: false, stale: true, items: cached.items });
  });

  it('treats a 5xx as a failure', async () => {
    const { client, fetch } = setup({ cache: cached });
    fetch.mockResolvedValue(json({ title: 'Server error' }, 503, null));

    await expect(client.fetchList()).resolves.toMatchObject({ ok: false, stale: true });
  });

  it('logs a 4xx once and treats it as a failure', async () => {
    const { client, fetch, log } = setup({ cache: cached });
    fetch.mockImplementation(async () => json({ title: 'Bad request' }, 400, null));

    await expect(client.fetchList()).resolves.toMatchObject({ ok: false, stale: true });
    await client.fetchList();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('400');
  });

  it('rejects a payload that is not a page and keeps the cache', async () => {
    const { client, fetch, cache } = setup({ cache: cached });
    fetch.mockResolvedValue(json({ items: 'nope' }));

    await expect(client.fetchList()).resolves.toMatchObject({ ok: false, stale: true });
    expect(cache()).toEqual(cached);
  });

  it('rejects a body that is not JSON', async () => {
    const { client, fetch } = setup({ cache: cached });
    fetch.mockResolvedValue(new Response('<html>', { status: 200 }));

    await expect(client.fetchList()).resolves.toMatchObject({ ok: false, stale: true });
  });

  it('drops an item that breaks the contract and keeps the others', async () => {
    const { client, fetch, log } = setup();
    fetch.mockResolvedValue(json(page([newsItem(1), { ...newsItem(2), severity: 'severe' }])));

    const result = await client.fetchList();

    expect(result.items.map((item) => item.id)).toEqual([1]);
    expect(log).toHaveBeenCalled();
  });
});

function detail(id: number): NewsItemDetail {
  return { ...newsItem(id), bodyHtml: '<p>Body</p>', sourceLinks: [] };
}

describe('fetching one item', () => {
  it('reads it by slug and caches it with its ETag', async () => {
    const { client, fetch, cache } = setup({ cache: cached });
    fetch.mockResolvedValue(json(detail(1), 200, '"x1"'));

    await expect(client.fetchDetail('item-1')).resolves.toEqual(detail(1));

    expect(String(fetch.mock.calls[0][0])).toBe('https://runovahq.com/api/v1/news/item-1');
    expect(cache()?.details['item-1']).toEqual({ etag: '"x1"', item: detail(1) });
  });

  it('serves the cached copy on a 304 or when the network fails', async () => {
    const withDetail = { ...cached, details: { 'item-1': { etag: '"x1"', item: detail(1) } } };
    const { client, fetch } = setup({ cache: withDetail });
    fetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(client.fetchDetail('item-1')).resolves.toEqual(detail(1));
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('if-none-match')).toBe('"x1"');
    await expect(client.fetchDetail('item-1')).resolves.toEqual(detail(1));
  });

  it('answers null for a 404 and forgets the cached copy', async () => {
    const withDetail = { ...cached, details: { 'item-1': { etag: '"x1"', item: detail(1) } } };
    const { client, fetch, cache } = setup({ cache: withDetail });
    fetch.mockResolvedValue(json({ title: 'Not found' }, 404, null));

    await expect(client.fetchDetail('item-1')).resolves.toBeNull();
    expect(cache()?.details['item-1']).toBeUndefined();
  });

  it('never puts an unsafe slug in the URL', async () => {
    const { client, fetch } = setup();

    await expect(client.fetchDetail('../users/me')).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops cached details of items no longer in the list', async () => {
    const withDetail = { ...cached, details: { 'item-1': { etag: '"x1"', item: detail(1) } } };
    const { client, fetch, cache } = setup({ cache: withDetail });
    fetch.mockResolvedValue(json(page([newsItem(2)])));

    await client.fetchList();

    expect(cache()?.details).toEqual({});
  });
});

describe('newsApiBaseUrl', () => {
  it('is runovahq.com by default', () => {
    expect(newsApiBaseUrl({ isPackaged: false, env: {} })).toBe(DEFAULT_NEWS_API_URL);
    expect(DEFAULT_NEWS_API_URL).toBe('https://runovahq.com/api/v1');
  });

  it('takes RUNOVA_NEWS_API_URL in a development build', () => {
    const env = { RUNOVA_NEWS_API_URL: 'http://127.0.0.1:5123/api/v1/' };
    expect(newsApiBaseUrl({ isPackaged: false, env })).toBe('http://127.0.0.1:5123/api/v1');
  });

  it('ignores RUNOVA_NEWS_API_URL in a packaged build', () => {
    const env = { RUNOVA_NEWS_API_URL: 'http://127.0.0.1:5123/api/v1' };
    expect(newsApiBaseUrl({ isPackaged: true, env })).toBe(DEFAULT_NEWS_API_URL);
  });

  it('ignores a value that is not an http URL', () => {
    expect(newsApiBaseUrl({ isPackaged: false, env: { RUNOVA_NEWS_API_URL: 'file:///etc' } })).toBe(
      DEFAULT_NEWS_API_URL,
    );
    expect(newsApiBaseUrl({ isPackaged: false, env: { RUNOVA_NEWS_API_URL: '  ' } })).toBe(
      DEFAULT_NEWS_API_URL,
    );
  });
});

describe('newsUserAgent', () => {
  it('names the app version and the platform only', () => {
    expect(newsUserAgent('3.0.0', 'darwin')).toBe('Runova/3.0.0 (darwin)');
  });
});
