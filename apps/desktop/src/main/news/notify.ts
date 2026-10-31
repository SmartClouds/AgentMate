import type { AppNotification, NewsLocalState } from '@runova/core';
import { DEFAULT_NEWS_NOTIFY_LEVEL, type NewsNotifyLevel } from '../../shared/newsSettings';
import { type InstalledTool, NEWS_SEVERITIES, type NewsListItem } from '../../shared/newsTypes';
import type { OsNotificationInput } from '../notifications/osNotification';
import { matchNews } from './match';
import { markNews } from './state';

/**
 * Announces a security item that affects this machine (E42): an OS notification and an entry in
 * the app's inbox, both opening the item. Each item is announced once. It is marked notified
 * before anything is shown, so a crash halfway costs one notification, never a repeat, and an
 * item the user already read or dismissed stays quiet.
 */

export interface NewsNotifierDeps {
  inbox: { add: (notification: AppNotification) => Promise<void> };
  toast: (input: Pick<OsNotificationInput, 'title' | 'body' | 'route'>) => void;
  getState: () => NewsLocalState | Promise<NewsLocalState>;
  updateState: (update: (state: NewsLocalState) => NewsLocalState) => Promise<void>;
  /**
   * The lowest severity worth a notification, or never. Read on every call, so a change in
   * Settings applies to the next poll. High unless set.
   */
  minSeverity?: () => NewsNotifyLevel | Promise<NewsNotifyLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface NewsNotifier {
  notify(items: readonly NewsListItem[], installed: readonly InstalledTool[]): Promise<void>;
}

export function newsRoute(slug: string): string {
  return `/?news=${encodeURIComponent(slug)}`;
}

export function createNewsNotifier(deps: NewsNotifierDeps): NewsNotifier {
  const now = deps.now ?? (() => new Date());
  // biome-ignore lint/suspicious/noConsole: the only record of an announcement that was skipped
  const log = deps.log ?? ((message: string) => console.warn(message));
  const minSeverity = deps.minSeverity ?? (() => DEFAULT_NEWS_NOTIFY_LEVEL);
  // A poll and a detection change can both ask at once; one after the other, the second sees the
  // first one's marks.
  let queue: Promise<void> = Promise.resolve();

  function seen(state: NewsLocalState, id: number): boolean {
    const key = String(id);
    return key in state.notified || key in state.read || key in state.dismissed;
  }

  async function run(items: readonly NewsListItem[], installed: readonly InstalledTool[]) {
    const level = await minSeverity();
    if (level === 'never') return;
    const minRank = NEWS_SEVERITIES.indexOf(level);
    const candidates = items.flatMap((item) => {
      if (item.category !== 'security' || NEWS_SEVERITIES.indexOf(item.severity) < minRank)
        return [];
      const match = matchNews(item, installed);
      return match ? [{ item, match }] : [];
    });
    if (candidates.length === 0) return;
    const before = await deps.getState();
    if (candidates.every(({ item }) => seen(before, item.id))) return;

    const at = now();
    let due: typeof candidates = [];
    try {
      // Picked again from what is saved at the moment of writing, so an item read in between stays quiet.
      await deps.updateState((current) => {
        due = candidates.filter(({ item }) => !seen(current, item.id));
        if (due.length === 0) return current;
        return markNews(
          current,
          'notified',
          due.map(({ item }) => item.id),
          at,
        );
      });
    } catch (error) {
      log(`[news] could not save which items were announced: ${String(error)}`);
      return;
    }

    for (const { item, match } of due) {
      const title = `Security fix for ${match.label}`;
      const headline = item.title.replace(/\.+$/, '');
      const body = match.fixedIn ? `${headline}. Update to ${match.fixedIn}.` : headline;
      const route = newsRoute(item.slug);
      await deps.inbox
        .add({
          id: `news:${item.id}`,
          kind: 'news-security',
          title,
          body,
          projectId: null,
          projectName: 'News',
          htmlUrl: item.url,
          route,
          createdAt: at.toISOString(),
          read: false,
        })
        .catch((error: unknown) =>
          log(`[news] could not add ${item.slug} to the inbox: ${String(error)}`),
        );
      deps.toast({ title, body, route });
    }
  }

  return {
    notify(items, installed) {
      const next = queue.then(() => run(items, installed));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
