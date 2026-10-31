import type { NewsLocalState } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstalledTool,
  NewsItemDetail,
  NewsListItem,
  NewsSeverity,
} from '../../shared/newsTypes';
import type { NewsCache, NewsSnapshot } from './client';
import { createNewsService } from './service';

/**
 * The news service (E42): the list and detail the renderer asks for, built from the cache with the
 * read, dismissed and affected fields added, plus the poll that refreshes it and tells windows and
 * the notifier.
 */

const NOW = new Date('2026-10-31T10:00:00.000Z');
const CHECKED = '2026-10-31T09:30:00.000Z';

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

const gitFix = (id: number, severity: NewsSeverity = 'critical') =>
  newsItem(id, {
    category: 'security',
    severity,
    technologies: [
      { technology: 'git', name: 'Git', versionRange: '<2.45.1', fixedIn: '2.45.1' },
      {
        technology: 'nodejs',
        name: 'Node.js',
        versionRange: '>=22.0.0 <22.5.0',
        fixedIn: '22.5.0',
      },
    ],
  });

const installed: InstalledTool[] = [
  { slug: 'git', version: '2.44.0', label: 'Git' },
  { slug: 'nodejs', version: '22.1.0', label: 'Node.js' },
];

function setup(items: NewsListItem[] = [], options: { state?: NewsLocalState } = {}) {
  let state: NewsLocalState = options.state ?? { read: {}, dismissed: {}, notified: {} };
  let cache: NewsCache = { etag: 'W/"v1"', checkedAt: CHECKED, items, details: {} };
  const fetchList = vi.fn(
    async (): Promise<NewsSnapshot> => ({
      ok: true,
      stale: false,
      checkedAt: NOW.toISOString(),
      items: cache.items,
    }),
  );
  const fetchDetail = vi.fn(async (_slug: string): Promise<NewsItemDetail | null> => null);
  const notify = vi.fn(async () => undefined);
  const broadcast = vi.fn();
  const updateState = vi.fn(async (update: (current: NewsLocalState) => NewsLocalState) => {
    state = update(state);
  });
  const service = createNewsService({
    client: { fetchList, fetchDetail, cached: async () => cache },
    getState: async () => state,
    updateState,
    installed: () => installed,
    notifier: { notify },
    broadcast,
    now: () => NOW,
  });
  return {
    service,
    fetchList,
    fetchDetail,
    notify,
    broadcast,
    updateState,
    state: () => state,
    setCache: (next: Partial<NewsCache>) => {
      cache = { ...cache, ...next };
    },
  };
}

describe('list', () => {
  it('serves the cached items with read, dismissed and affected added', async () => {
    const { service } = setup([gitFix(1), newsItem(2)], {
      state: { read: { '2': CHECKED }, dismissed: {}, notified: {} },
    });
    const result = await service.list({});
    expect(result).toMatchObject({ page: 1, totalPages: 1, stale: false, checkedAt: CHECKED });
    expect(result.items.map((item) => [item.id, item.read, item.dismissed])).toEqual([
      [1, false, false],
      [2, true, false],
    ]);
    expect(result.items[0]?.affected).toEqual({
      slug: 'git',
      label: 'Git',
      version: '2.44.0',
      versionRange: '<2.45.1',
      fixedIn: '2.45.1',
    });
    expect(result.items[1]?.affected).toBeNull();
  });

  it('leaves dismissed items out of the list', async () => {
    const { service } = setup([newsItem(1), newsItem(2)], {
      state: { read: {}, dismissed: { '1': CHECKED }, notified: {} },
    });
    expect((await service.list({})).items.map((item) => item.id)).toEqual([2]);
  });

  it('filters by category and minimum severity', async () => {
    const { service } = setup([
      newsItem(1, { category: 'security', severity: 'medium' }),
      newsItem(2, { category: 'security', severity: 'high' }),
      newsItem(3, { category: 'ai', severity: 'critical' }),
      newsItem(4, { category: 'release', severity: 'critical' }),
    ]);
    const ids = async (query: Parameters<typeof service.list>[0]) =>
      (await service.list(query)).items.map((item) => item.id);
    expect(await ids({ category: ['security', 'ai'] })).toEqual([1, 2, 3]);
    expect(await ids({ minSeverity: 'high' })).toEqual([2, 3, 4]);
    expect(await ids({ category: ['security'], minSeverity: 'high' })).toEqual([2]);
    expect(await ids({ category: [] })).toEqual([1, 2, 3, 4]);
  });

  it('pages 20 at a time by default, and keeps the page in range', async () => {
    const items = Array.from({ length: 45 }, (_, index) => newsItem(index + 1));
    const { service } = setup(items);
    const first = await service.list({});
    expect(first.items).toHaveLength(20);
    expect(first.totalPages).toBe(3);
    const last = await service.list({ page: 3 });
    expect(last.items.map((item) => item.id)).toEqual([41, 42, 43, 44, 45]);
    expect((await service.list({ page: 9 })).page).toBe(3);
    expect((await service.list({ page: 2, pageSize: 5 })).items[0]?.id).toBe(6);
  });

  it('answers one empty page when there is nothing', async () => {
    const { service } = setup([]);
    expect(await service.list({})).toEqual({
      items: [],
      page: 1,
      totalPages: 1,
      stale: false,
      checkedAt: CHECKED,
    });
  });
});

describe('polling', () => {
  it('a successful poll broadcasts, runs the notifier and reports success', async () => {
    const { service, broadcast, notify } = setup([gitFix(1)]);
    await expect(service.poll()).resolves.toBe(true);
    expect(broadcast).toHaveBeenCalledWith({ checkedAt: NOW.toISOString(), stale: false });
    expect(notify).toHaveBeenCalledWith([gitFix(1)], installed);
  });

  it('a failed poll serves the cache marked stale until the next success', async () => {
    const { service, fetchList, broadcast } = setup([newsItem(1)]);
    fetchList.mockResolvedValueOnce({
      ok: false,
      stale: true,
      checkedAt: CHECKED,
      items: [newsItem(1)],
    });
    await expect(service.poll()).resolves.toBe(false);
    expect(broadcast).toHaveBeenCalledWith({ checkedAt: CHECKED, stale: true });
    const offline = await service.list({});
    expect(offline.stale).toBe(true);
    expect(offline.items.map((item) => item.id)).toEqual([1]);

    await service.poll();
    expect((await service.list({})).stale).toBe(false);
  });

  it('refresh polls now and answers the unfiltered list', async () => {
    const { service, fetchList } = setup([newsItem(1), newsItem(2, { category: 'ai' })]);
    const result = await service.refresh();
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.id)).toEqual([1, 2]);
  });

  it('prunes marks older than 180 days, and writes nothing when there are none', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    const { service, updateState, state } = setup([], {
      state: { read: { '1': old, '2': CHECKED }, dismissed: {}, notified: {} },
    });
    await service.poll();
    expect(state().read).toEqual({ '2': CHECKED });
    expect(updateState).toHaveBeenCalledTimes(1);
    await service.poll();
    expect(updateState).toHaveBeenCalledTimes(1);
  });
});

describe('detail', () => {
  it('adds the local fields and every affected technology', async () => {
    const { service, fetchDetail } = setup([gitFix(1)], {
      state: { read: { '1': CHECKED }, dismissed: {}, notified: {} },
    });
    fetchDetail.mockResolvedValueOnce({
      ...gitFix(1),
      bodyHtml: '<p>Update.</p>',
      sourceLinks: [],
    });
    const detail = await service.get('item-1');
    expect(fetchDetail).toHaveBeenCalledWith('item-1');
    expect(detail).toMatchObject({
      id: 1,
      read: true,
      dismissed: false,
      bodyHtml: '<p>Update.</p>',
    });
    expect(detail?.affected?.slug).toBe('git');
    expect(detail?.affectedAll.map((match) => match.slug)).toEqual(['git', 'nodejs']);
  });

  it('is null for an item the API does not have', async () => {
    const { service } = setup([]);
    expect(await service.get('gone')).toBeNull();
  });
});

describe('marks', () => {
  it('marking read and dismissing save the id and tell the windows', async () => {
    const { service, state, broadcast } = setup([newsItem(1)]);
    await service.markRead(1);
    await service.dismiss(1);
    expect(state().read).toEqual({ '1': NOW.toISOString() });
    expect(state().dismissed).toEqual({ '1': NOW.toISOString() });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith({ checkedAt: CHECKED, stale: false });
  });
});

describe('installed tools changed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the notifier on the cached items once, after a burst of changes settles', async () => {
    const { service, notify, broadcast } = setup([gitFix(1)]);
    service.installedChanged();
    service.installedChanged();
    service.installedChanged();
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith([gitFix(1)], installed);
    // The badges may have changed too.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('does nothing once stopped', async () => {
    const { service, notify } = setup([gitFix(1)]);
    service.installedChanged();
    service.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notify).not.toHaveBeenCalled();
  });

  it('starts the poll schedule and stops it', async () => {
    const { service, fetchList } = setup([]);
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchList).toHaveBeenCalledTimes(1);
    service.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchList).toHaveBeenCalledTimes(1);
  });
});
