import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './defaultSettings';
import { isCategoryShown, newsSettingsOf, notifyThreshold } from './newsSettings';

/**
 * The news settings in Settings > Notifications (E42): on by default, every category, and security
 * fixes at high or worse notify. Whatever settings.json holds is read back into those shapes.
 */

describe('newsSettingsOf', () => {
  it('reads the defaults as news on, every category and notify at high', () => {
    expect(newsSettingsOf(DEFAULT_SETTINGS)).toEqual({
      enabled: true,
      categories: [],
      notifyMinSeverity: 'high',
    });
  });

  it('keeps what was saved', () => {
    expect(
      newsSettingsOf({
        newsEnabled: false,
        newsCategories: ['ai', 'security'],
        newsNotifyMinSeverity: 'never',
      }),
    ).toEqual({ enabled: false, categories: ['security', 'ai'], notifyMinSeverity: 'never' });
  });

  it('drops what this version does not know, and only false turns news off', () => {
    expect(
      newsSettingsOf({
        newsEnabled: 'no' as unknown as boolean,
        newsCategories: ['security', 'gossip', 7 as unknown as string],
        newsNotifyMinSeverity: 'urgent',
      }),
    ).toEqual({ enabled: true, categories: ['security'], notifyMinSeverity: 'high' });
    expect(
      newsSettingsOf({ newsCategories: 'security' as unknown as string[] }).categories,
    ).toEqual([]);
  });
});

describe('isCategoryShown', () => {
  it('shows every category when none were picked', () => {
    expect(isCategoryShown([], 'industry')).toBe(true);
    expect(isCategoryShown(['security'], 'security')).toBe(true);
    expect(isCategoryShown(['security'], 'release')).toBe(false);
  });
});

describe('notifyThreshold', () => {
  it('is the saved severity while news is on', () => {
    expect(notifyThreshold({ enabled: true, categories: [], notifyMinSeverity: 'critical' })).toBe(
      'critical',
    );
  });

  it('is never while news is off, whatever the severity says', () => {
    expect(notifyThreshold({ enabled: false, categories: [], notifyMinSeverity: 'low' })).toBe(
      'never',
    );
  });
});
