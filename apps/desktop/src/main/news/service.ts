import type { NewsLocalState } from '@runova/core';
import { isCategoryShown } from '../../shared/newsSettings';
import {
  type InstalledTool,
  NEWS_SEVERITIES,
  type NewsCategory,
  type NewsChangedEvent,
  type NewsItemDetailView,
  type NewsItemView,
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

/** A security fix for something installed here, which the card lists before everything else. */
function isAffectedSecurity(item: NewsItemView): boolean {
  return item.category === 'security' && item.affected !== null;
}

/**
 * Affected security items first, the most severe first, then everything else newest first. Done
 * before paging, so the card and every page of View all share one order.
 */
function orderNews(items: NewsItemView[]): NewsItemView[] {
  return [...items].sort((a, b) => {
    const urgent = Number(isAffectedSecurity(b)) - Number(isAffectedSecurity(a));
    if (urgent !== 0) return urgent;
    if (isAffectedSecurity(a)) {
      const worse = NEWS_SEVERITIES.indexOf(b.severity) - NEWS_SEVERITIES.indexOf(a.severity);
      if (worse !== 0) return worse;
    }
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
}

export interface NewsServiceDeps {
  client: Pick<NewsClient, 'fetchList' | 'fetchDetail' | 'cached'>;
  getState: () => Promise<NewsLocalState>;
  updateState: (update: (state: NewsLocalState) => NewsLocalState) => Promise<void>;
  installed: () => readonly InstalledTool[] | Promise<readonly InstalledTool[]>;
  notifier: NewsNotifier;
  broadcast: (event: NewsChangedEvent) => void;
  /** The categories picked in Settings, read on every list. Empty (or unset) shows all. */
  shownCategories?: () => readonly NewsCategory[] | Promise<readonly NewsCategory[]>;
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
    const [cache, state, installed, shown] = await Promise.all([
      deps.client.cached(),
      deps.getState(),
      deps.installed(),
      deps.shownCategories?.() ?? [],
    ]);
    const categories = query.category?.length ? new Set(query.category) : null;
    const minRank = NEWS_SEVERITIES.indexOf(query.minSeverity ?? 'info');
    const items = cache.items.filter(
      (item) =>
        !has(state.dismissed, item.id) &&
        isCategoryShown(shown, item.category) &&
        (!categories || categories.has(item.category)) &&
        NEWS_SEVERITIES.indexOf(item.severity) >= minRank,
    );
    const views = orderNews(
      items.map((item) => ({
        ...item,
        read: has(state.read, item.id),
        dismissed: false,
        affected: matchNews(item, installed),
      })),
    );
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(views.length / pageSize));
    const page = Math.min(Math.max(1, query.page ?? 1), totalPages);
    return {
      items: views.slice((page - 1) * pageSize, page * pageSize),
      page,
      totalPages,
      total: views.length,
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
