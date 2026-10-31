import type { NewsLocalState } from '@runova/core';
import {
  type InstalledTool,
  NEWS_SEVERITIES,
  type NewsChangedEvent,
  type NewsItemDetailView,
  type NewsListItem,
  type NewsListQuery,
  type NewsListResult,
} from '../../shared/newsTypes';
import type { NewsClient } from './client';
import { matchNews, matchNewsAll } from './match';
import type { NewsNotifier } from './notify';
import { createNewsPoller } from './poller';
import { markNews, pruneNewsState } from './state';

/**
 * What the news IPC handlers talk to (E42). The list and detail are built from the cache on every
 * call, with read, dismissed and affected worked out then, so a badge is never older than the last
 * detection. A poll refreshes the cache, tells the windows and lets the notifier look at it; so does
 * a change in what is installed, once a burst of them settles.
 */

const DEFAULT_PAGE_SIZE = 20;
const INSTALLED_SETTLE_MS = 2_000;

export interface NewsServiceDeps {
  client: Pick<NewsClient, 'fetchList' | 'fetchDetail' | 'cached'>;
  getState: () => Promise<NewsLocalState>;
  updateState: (update: (state: NewsLocalState) => NewsLocalState) => Promise<void>;
  installed: () => readonly InstalledTool[] | Promise<readonly InstalledTool[]>;
  notifier: NewsNotifier;
  broadcast: (event: NewsChangedEvent) => void;
  now?: () => Date;
}

export interface NewsService {
  list(query: NewsListQuery): Promise<NewsListResult>;
  get(slug: string): Promise<NewsItemDetailView | null>;
  /** Fetches now and answers the unfiltered list. */
  refresh(): Promise<NewsListResult>;
  markRead(id: number): Promise<void>;
  dismiss(id: number): Promise<void>;
  /** One fetch, as the poller runs it. Resolves to whether the API answered. */
  poll(): Promise<boolean>;
  /** Dev Setup or CLI Manager found something new. */
  installedChanged(): void;
  start(): void;
  stop(): void;
}

function has(map: Record<string, string>, id: number): boolean {
  return String(id) in map;
}

export function createNewsService(deps: NewsServiceDeps): NewsService {
  const now = deps.now ?? (() => new Date());
  // Only this run's polls know whether the API is reachable; before the first one the cache is
  // simply what there is.
  let stale = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  async function changed(): Promise<void> {
    const cache = await deps.client.cached();
    deps.broadcast({ checkedAt: cache.checkedAt, stale });
  }

  async function prune(): Promise<void> {
    const state = await deps.getState();
    const pruned = pruneNewsState(state, now());
    const count = (value: NewsLocalState) =>
      Object.keys(value.read).length +
      Object.keys(value.dismissed).length +
      Object.keys(value.notified).length;
    if (count(pruned) === count(state)) return;
    await deps.updateState((current) => pruneNewsState(current, now()));
  }

  async function notify(items: readonly NewsListItem[]): Promise<void> {
    await deps.notifier.notify(items, await deps.installed());
  }

  async function poll(): Promise<boolean> {
    const snapshot = await deps.client.fetchList();
    stale = snapshot.stale;
    deps.broadcast({ checkedAt: snapshot.checkedAt, stale });
    await prune().catch(() => undefined);
    await notify(snapshot.items).catch(() => undefined);
    return snapshot.ok;
  }

  const poller = createNewsPoller({ poll });

  async function list(query: NewsListQuery): Promise<NewsListResult> {
    const [cache, state, installed] = await Promise.all([
      deps.client.cached(),
      deps.getState(),
      deps.installed(),
    ]);
    const categories = query.category?.length ? new Set(query.category) : null;
    const minRank = NEWS_SEVERITIES.indexOf(query.minSeverity ?? 'info');
    const items = cache.items.filter(
      (item) =>
        !has(state.dismissed, item.id) &&
        (!categories || categories.has(item.category)) &&
        NEWS_SEVERITIES.indexOf(item.severity) >= minRank,
    );
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(Math.max(1, query.page ?? 1), totalPages);
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize).map((item) => ({
        ...item,
        read: has(state.read, item.id),
        dismissed: false,
        affected: matchNews(item, installed),
      })),
      page,
      totalPages,
      stale,
      checkedAt: cache.checkedAt,
    };
  }

  async function get(slug: string): Promise<NewsItemDetailView | null> {
    const item = await deps.client.fetchDetail(slug);
    if (!item) return null;
    const [state, installed] = await Promise.all([deps.getState(), deps.installed()]);
    const affectedAll = matchNewsAll(item, installed);
    return {
      ...item,
      read: has(state.read, item.id),
      dismissed: has(state.dismissed, item.id),
      affected: affectedAll[0] ?? null,
      affectedAll,
    };
  }

  async function mark(kind: 'read' | 'dismissed', id: number): Promise<void> {
    await deps.updateState((current) => markNews(current, kind, [id], now()));
    await changed();
  }

  return {
    list,
    get,
    async refresh() {
      await poller.refreshNow();
      return list({});
    },
    markRead: (id) => mark('read', id),
    dismiss: (id) => mark('dismissed', id),
    poll,
    installedChanged() {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        void (async () => {
          const cache = await deps.client.cached();
          await notify(cache.items);
          await changed();
        })().catch(() => undefined);
      }, INSTALLED_SETTLE_MS);
    },
    start: () => poller.start(),
    stop() {
      poller.stop();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
    },
  };
}
