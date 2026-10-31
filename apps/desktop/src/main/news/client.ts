import type { NewsItemDetail, NewsListItem } from '../../shared/newsTypes';
import { newsItemDetailSchema, newsListItemSchema, newsPageSchema } from './schema';

/**
 * Reads news from the website API (E42) and keeps the last good answer for offline use.
 *
 * The request carries nothing about the user or this machine beyond the app version and platform
 * in the User-Agent: no cookies, no account, no list of installed tools. Matching against those
 * tools happens locally, after the fact.
 */

export const DEFAULT_NEWS_API_URL = 'https://runovahq.com/api/v1';
const LIST_QUERY = 'pageSize=50&sort=-publishedAt';
const TIMEOUT_MS = 15_000;
/** The contract's slug rule, so nothing else can reach the path. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface NewsCache {
  /** The list's ETag, sent back as If-None-Match. */
  etag: string | null;
  /** When the API last answered 200 or 304. */
  checkedAt: string | null;
  items: NewsListItem[];
  /** Items read one by one, by slug, for the detail sheet. */
  details: Record<string, { etag: string | null; item: NewsItemDetail }>;
}

export interface NewsSnapshot {
  /** False when this fetch failed and the items are what was cached. */
  ok: boolean;
  stale: boolean;
  checkedAt: string | null;
  items: NewsListItem[];
}

export interface NewsClientDeps {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  userAgent: string;
  timeoutMs?: number;
  readCache: () => Promise<NewsCache | null>;
  writeCache: (cache: NewsCache) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface NewsClient {
  fetchList(): Promise<NewsSnapshot>;
  /** The cached item, refreshed from the API when it answers. Null when it is gone or never seen. */
  fetchDetail(slug: string): Promise<NewsItemDetail | null>;
  /** What is cached, without asking the API. */
  cached(): Promise<NewsCache>;
}

/** Only a development build may point the client somewhere else, for e2e tests and local work. */
export function newsApiBaseUrl(input: {
  isPackaged: boolean;
  env: Record<string, string | undefined>;
}): string {
  if (input.isPackaged) return DEFAULT_NEWS_API_URL;
  const override = input.env.RUNOVA_NEWS_API_URL?.trim();
  if (!override || !/^https?:\/\//i.test(override)) return DEFAULT_NEWS_API_URL;
  return override.replace(/\/+$/, '');
}

export function newsUserAgent(version: string, platform: string): string {
  return `Runova/${version} (${platform})`;
}

const EMPTY_CACHE: NewsCache = { etag: null, checkedAt: null, items: [], details: {} };

export function createNewsClient(deps: NewsClientDeps): NewsClient {
  const now = deps.now ?? (() => new Date());
  // biome-ignore lint/suspicious/noConsole: the only record of a news API that keeps refusing
  const log = deps.log ?? ((message: string) => console.warn(message));
  const loggedStatuses = new Set<number>();

  async function cached(): Promise<NewsCache> {
    return (await deps.readCache().catch(() => null)) ?? EMPTY_CACHE;
  }

  async function request(path: string, etag: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': deps.userAgent,
    };
    if (etag) headers['If-None-Match'] = etag;
    const response = await deps.fetch(`${deps.baseUrl}${path}`, {
      headers,
      credentials: 'omit',
      signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
    });
    if (response.status >= 400 && response.status < 500 && response.status !== 404) {
      // A 4xx will not fix itself on the next poll, so once is enough to say so.
      if (!loggedStatuses.has(response.status)) {
        loggedStatuses.add(response.status);
        log(`[news] ${path} answered ${response.status}`);
      }
    }
    return response;
  }

  async function body(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new Error('The news API answered something that is not JSON.');
    }
  }

  function parseItems(raw: unknown[]): NewsListItem[] {
    const items: NewsListItem[] = [];
    for (const entry of raw) {
      const parsed = newsListItemSchema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
      else log(`[news] skipped an item the app cannot read: ${parsed.error.issues[0]?.message}`);
    }
    return items;
  }

  async function fetchList(): Promise<NewsSnapshot> {
    const cache = await cached();
    try {
      const response = await request(`/news?${LIST_QUERY}`, cache.etag);
      const checkedAt = now().toISOString();
      if (response.status === 304) {
        await deps.writeCache({ ...cache, checkedAt });
        return { ok: true, stale: false, checkedAt, items: cache.items };
      }
      if (response.status !== 200) {
        throw new Error(`The news API answered ${response.status}.`);
      }
      const page = newsPageSchema.safeParse(await body(response));
      if (!page.success) throw new Error('The news API answered an unexpected page.');
      const items = parseItems(page.data.items);
      // A detail no longer in the list is an item that was archived or fell off the end.
      const slugs = new Set(items.map((item) => item.slug));
      const details = Object.fromEntries(
        Object.entries(cache.details).filter(([slug]) => slugs.has(slug)),
      );
      await deps.writeCache({ etag: response.headers.get('etag'), checkedAt, items, details });
      return { ok: true, stale: false, checkedAt, items };
    } catch {
      // Offline, timed out, a 4xx or 5xx, or a body the app cannot read: the cache stands.
      return { ok: false, stale: true, checkedAt: cache.checkedAt, items: cache.items };
    }
  }

  async function fetchDetail(slug: string): Promise<NewsItemDetail | null> {
    if (!SLUG.test(slug) || slug.length > 120) return null;
    const cache = await cached();
    const known = cache.details[slug] ?? null;
    try {
      const response = await request(`/news/${slug}`, known?.etag ?? null);
      if (response.status === 304 && known) return known.item;
      if (response.status === 404) {
        if (known) {
          const { [slug]: _gone, ...details } = cache.details;
          await deps.writeCache({ ...cache, details });
        }
        return null;
      }
      if (response.status !== 200) return known?.item ?? null;
      const parsed = newsItemDetailSchema.safeParse(await body(response));
      if (!parsed.success) return known?.item ?? null;
      const latest = await cached();
      await deps.writeCache({
        ...latest,
        details: {
          ...latest.details,
          [slug]: { etag: response.headers.get('etag'), item: parsed.data },
        },
      });
      return parsed.data;
    } catch {
      return known?.item ?? null;
    }
  }

  return { fetchList, fetchDetail, cached };
}
