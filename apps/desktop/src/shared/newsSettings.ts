import type { AppSettings } from '@runova/core';
import {
  NEWS_CATEGORIES,
  NEWS_SEVERITIES,
  type NewsCategory,
  type NewsSeverity,
} from './newsTypes';

/**
 * The news choices in Settings > Notifications (E42). settings.json keeps them as plain strings
 * (core does not know the news enums), so both processes read them through here.
 */

/** The lowest severity of a matched security fix that notifies, or none at all. */
export type NewsNotifyLevel = NewsSeverity | 'never';

export const NEWS_NOTIFY_LEVELS: readonly NewsNotifyLevel[] = [...NEWS_SEVERITIES, 'never'];

export const DEFAULT_NEWS_NOTIFY_LEVEL: NewsNotifyLevel = 'high';

export interface NewsSettings {
  enabled: boolean;
  /** Empty shows every category. */
  categories: NewsCategory[];
  notifyMinSeverity: NewsNotifyLevel;
}

type SavedNewsSettings = Partial<
  Pick<AppSettings, 'newsEnabled' | 'newsCategories' | 'newsNotifyMinSeverity'>
>;

/** The saved choices with anything this version does not know dropped, categories in list order. */
export function newsSettingsOf(saved: SavedNewsSettings): NewsSettings {
  const categories = Array.isArray(saved.newsCategories) ? saved.newsCategories : [];
  return {
    enabled: saved.newsEnabled !== false,
    categories: NEWS_CATEGORIES.filter((one) => categories.includes(one)),
    notifyMinSeverity:
      NEWS_NOTIFY_LEVELS.find((one) => one === saved.newsNotifyMinSeverity) ??
      DEFAULT_NEWS_NOTIFY_LEVEL,
  };
}

export function isCategoryShown(shown: readonly NewsCategory[], category: NewsCategory): boolean {
  return shown.length === 0 || shown.includes(category);
}

/** What the notifier goes by: nothing about news notifies while news is off. */
export function notifyThreshold(settings: NewsSettings): NewsNotifyLevel {
  return settings.enabled ? settings.notifyMinSeverity : 'never';
}
