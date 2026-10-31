import type { AppNotification, NewsLocalState } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type { NewsNotifyLevel } from '../../shared/newsSettings';
import type { InstalledTool, NewsListItem } from '../../shared/newsTypes';
import { createNewsNotifier } from './notify';
import { markNews } from './state';

/**
 * A matched high or critical security item is announced once (E42): an OS notification and an
 * inbox entry. Never again after that, nor after the user read or dismissed it, and never for an
 * item that does not affect this machine.
 */

const NOW = new Date('2026-10-31T10:00:00.000Z');

const installed: InstalledTool[] = [
  { slug: 'git', version: '2.44.0', label: 'Git' },
  { slug: 'claude-code', version: '1.0.20', label: 'Claude Code' },
];

function newsItem(id: number, overrides: Partial<NewsListItem> = {}): NewsListItem {
  return {
    id,
    slug: `item-${id}`,
    url: `https://runovahq.com/news/item-${id}`,
    title: `Git fixes a remote code execution bug`,
    summary: 'Summary.',
    category: 'security',
    severity: 'critical',
    technologies: [{ technology: 'git', name: 'Git', versionRange: '<2.45.1', fixedIn: '2.45.1' }],
    cveIds: ['CVE-2026-1234'],
    cvssScore: 9.8,
    tags: [],
    publishedAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
    ...overrides,
  };
}

function setup(initial: NewsLocalState = { read: {}, dismissed: {}, notified: {} }) {
  let state = initial;
  const added: AppNotification[] = [];
  const toast = vi.fn();
  const deps = {
    inbox: {
      add: async (notification: AppNotification) => {
        added.push(notification);
      },
    },
    toast,
    getState: () => state,
    updateState: async (update: (current: NewsLocalState) => NewsLocalState) => {
      state = update(state);
    },
    now: () => NOW,
  };
  return { deps, added, toast, state: () => state, notifier: createNewsNotifier(deps) };
}

describe('createNewsNotifier', () => {
  it('announces a matched critical item with an inbox entry and an OS notification', async () => {
    const { notifier, added, toast, state } = setup();
    await notifier.notify([newsItem(7)], installed);

    expect(added).toEqual([
      {
        id: 'news:7',
        kind: 'news-security',
        title: 'Security fix for Git',
        body: 'Git fixes a remote code execution bug. Update to 2.45.1.',
        projectId: null,
        projectName: 'News',
        htmlUrl: 'https://runovahq.com/news/item-7',
        route: '/?news=item-7',
        createdAt: NOW.toISOString(),
        read: false,
      },
    ]);
    expect(toast).toHaveBeenCalledWith({
      title: 'Security fix for Git',
      body: 'Git fixes a remote code execution bug. Update to 2.45.1.',
      route: '/?news=item-7',
    });
    expect(state().notified).toEqual({ '7': NOW.toISOString() });
  });

  it('leaves out the update hint when no fixed version is known', async () => {
    const { notifier, added } = setup();
    const item = newsItem(7, {
      technologies: [{ technology: 'git', name: 'Git', versionRange: '<2.45.1', fixedIn: null }],
    });
    await notifier.notify([item], installed);
    expect(added[0]?.body).toBe('Git fixes a remote code execution bug');
  });

  it('notifies once, not again on a later poll', async () => {
    const { notifier, added, toast } = setup();
    await notifier.notify([newsItem(7)], installed);
    await notifier.notify([newsItem(7)], installed);
    expect(added).toHaveLength(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('does not notify again after a restart, from the saved state', async () => {
    const first = setup();
    await first.notifier.notify([newsItem(7)], installed);

    const second = setup(first.state());
    await second.notifier.notify([newsItem(7)], installed);
    expect(second.added).toHaveLength(0);
    expect(second.toast).not.toHaveBeenCalled();
  });

  it('never notifies about an item already read or dismissed', async () => {
    const empty = { read: {}, dismissed: {}, notified: {} };
    for (const mark of ['read', 'dismissed'] as const) {
      const { notifier, added, toast } = setup(markNews(empty, mark, [7], NOW));
      await notifier.notify([newsItem(7)], installed);
      expect(added, mark).toHaveLength(0);
      expect(toast, mark).not.toHaveBeenCalled();
    }
  });

  it('runs two calls one after the other, so overlapping polls still notify once', async () => {
    const { notifier, added } = setup();
    await Promise.all([
      notifier.notify([newsItem(7)], installed),
      notifier.notify([newsItem(7)], installed),
    ]);
    expect(added).toHaveLength(1);
  });

  it.each([
    ['an item that affects nothing installed', newsItem(7, { technologies: [] })],
    [
      'a version outside the range',
      newsItem(7, {
        technologies: [
          { technology: 'git', name: 'Git', versionRange: '<2.40.0', fixedIn: '2.40.0' },
        ],
      }),
    ],
    [
      'a tool that is not installed',
      newsItem(7, {
        technologies: [{ technology: 'docker', name: 'Docker', versionRange: '*', fixedIn: null }],
      }),
    ],
    ['a medium security item', newsItem(7, { severity: 'medium' })],
    ['a critical item that is not about security', newsItem(7, { category: 'release' })],
  ])('never notifies about %s', async (_name, item) => {
    const { notifier, added, toast, state } = setup();
    await notifier.notify([item], installed);
    expect(added).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
    expect(state().notified).toEqual({});
  });

  it('notifies about a high item, and raises the bar when asked', async () => {
    const high = newsItem(8, { severity: 'high' });
    const defaults = setup();
    await defaults.notifier.notify([high], installed);
    expect(defaults.added).toHaveLength(1);

    const strict = setup();
    const notifier = createNewsNotifier({ ...strict.deps, minSeverity: () => 'critical' });
    await notifier.notify([high], installed);
    expect(strict.added).toHaveLength(0);
  });

  it('reads the minimum severity on every call, so a change in Settings applies to the next poll', async () => {
    let level: NewsNotifyLevel = 'critical';
    const { deps, added, toast } = setup();
    const notifier = createNewsNotifier({ ...deps, minSeverity: async () => level });
    const medium = newsItem(9, { severity: 'medium' });

    await notifier.notify([medium], installed);
    expect(added).toHaveLength(0);

    level = 'medium';
    await notifier.notify([medium], installed);
    expect(added.map((item) => item.id)).toEqual(['news:9']);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('announces nothing at Never, and marks nothing, so turning it back on still notifies', async () => {
    let level: NewsNotifyLevel = 'never';
    const { deps, added, state } = setup();
    const notifier = createNewsNotifier({ ...deps, minSeverity: () => level });

    await notifier.notify([newsItem(10)], installed);
    expect(added).toHaveLength(0);
    expect(state().notified).toEqual({});

    level = 'high';
    await notifier.notify([newsItem(10)], installed);
    expect(added).toHaveLength(1);
  });

  it('marks every new match in one write before announcing any of them', async () => {
    const { deps, added } = setup();
    const updateState = vi.fn(deps.updateState);
    const notifier = createNewsNotifier({ ...deps, updateState });
    await notifier.notify([newsItem(7), newsItem(9)], installed);
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(added.map((entry) => entry.id)).toEqual(['news:7', 'news:9']);
  });

  it('skips the announcement when the state could not be saved, so it never repeats', async () => {
    const { deps, added, toast } = setup();
    const notifier = createNewsNotifier({
      ...deps,
      log: () => undefined,
      updateState: async () => {
        throw new Error('disk full');
      },
    });
    await expect(notifier.notify([newsItem(7)], installed)).resolves.toBeUndefined();
    expect(added).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });
});
