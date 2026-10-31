import { DEFAULT_SETTINGS } from '@shared/defaultSettings';
import type {
  NewsItemDetailView,
  NewsItemView,
  NewsListQuery,
  NewsListResult,
  NewsSeverity,
} from '@shared/newsTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { NewsCard } from './NewsCard';

/**
 * The News card (E42): what it shows in each state, the order and badges people read at a glance,
 * the filters, keyboard use, and the detail sheet, which must never run markup the API sends.
 */

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

function item(id: number, overrides: Partial<NewsItemView> = {}): NewsItemView {
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
    publishedAt: ago(5),
    updatedAt: ago(5),
    read: true,
    dismissed: false,
    affected: null,
    ...overrides,
  };
}

const gitFix = item(1, {
  title: 'Git 2.47.1 fixes a credential leak over HTTP',
  category: 'security',
  severity: 'high',
  publishedAt: ago(2),
  read: false,
  technologies: [{ technology: 'git', name: 'Git', versionRange: '<2.47.1', fixedIn: '2.47.1' }],
  cveIds: ['CVE-2026-1234'],
  affected: {
    slug: 'git',
    label: 'Git',
    version: '2.47.0',
    versionRange: '<2.47.1',
    fixedIn: '2.47.1',
  },
});

function result(items: NewsItemView[], overrides: Partial<NewsListResult> = {}): NewsListResult {
  return {
    items,
    page: 1,
    totalPages: 1,
    total: items.length,
    stale: false,
    checkedAt: ago(0.5),
    ...overrides,
  };
}

function detail(base: NewsItemView, overrides: Partial<NewsItemDetailView> = {}) {
  return {
    ...base,
    bodyHtml: '<p>Update now.</p>',
    sourceLinks: [{ title: 'Git release notes', url: 'https://git-scm.com/notes' }],
    affectedAll: base.affected ? [base.affected] : [],
    ...overrides,
  } satisfies NewsItemDetailView;
}

function renderCard(
  list: NewsListResult | ((query?: NewsListQuery) => Promise<NewsListResult>),
  options: { bridge?: Record<string, unknown>; route?: string } = {},
) {
  return renderWithProviders(<NewsCard />, {
    route: options.route,
    bridge: {
      'news.list': typeof list === 'function' ? list : async () => list,
      'news.refresh': async () => (typeof list === 'function' ? list() : list),
      'news.get': async (slug: string) => (slug === gitFix.slug ? detail(gitFix) : null),
      'settings.get': DEFAULT_SETTINGS,
      'settings.update': async (patch: object) => ({ ...DEFAULT_SETTINGS, ...patch }),
      ...options.bridge,
    },
  });
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'News' })).getAllByRole('button');
}

describe('NewsCard rows', () => {
  it('shows the severity, category, title, time and an unread dot for each item', async () => {
    renderCard(result([gitFix, item(2, { title: 'Node.js 24.11 is the new LTS' })]));

    const [first, second] = await waitFor(rows);
    expect(within(first).getByText('High')).toBeInTheDocument();
    expect(within(first).getByText('Security')).toBeInTheDocument();
    expect(within(first).getByText('2h ago')).toBeInTheDocument();
    expect(within(first).getByRole('img', { name: 'Unread' })).toBeInTheDocument();
    expect(within(second).getByText('Node.js 24.11 is the new LTS')).toBeInTheDocument();
    expect(within(second).queryByRole('img', { name: 'Unread' })).toBeNull();
  });

  it('keeps the order main sends, so an affected security item is first with its badge', async () => {
    renderCard(result([gitFix, item(2), item(3)]));

    const [first] = await waitFor(rows);
    expect(within(first).getByText('Affects your system: Git 2.47.0')).toBeInTheDocument();
    expect(screen.getAllByText(/Affects your system/)).toHaveLength(1);
  });

  it('never shows severity by color alone: every level has its own icon and label', async () => {
    const levels: [NewsSeverity, string][] = [
      ['info', 'Info'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['critical', 'Critical'],
    ];
    renderCard(result(levels.map(([severity], index) => item(index + 1, { severity }))));

    const found = await waitFor(rows);
    const icons = levels.map(([, label], index) => {
      const badge = within(found[index]).getByText(label).closest('[data-severity]');
      expect(badge).not.toBeNull();
      const icon = badge?.querySelector('svg');
      expect(icon).not.toBeNull();
      return icon?.getAttribute('data-icon');
    });
    expect(new Set(icons).size).toBe(levels.length);
  });

  it('shows View all with the total and five items at most', async () => {
    const many = Array.from({ length: 5 }, (_, index) => item(index + 1));
    renderCard(result(many, { total: 24, totalPages: 5 }));

    expect(await screen.findByRole('button', { name: 'View all (24)' })).toBeInTheDocument();
    expect(rows()).toHaveLength(5);
  });

  it('uses tooltips, never a title attribute', async () => {
    const { container } = renderCard(result([gitFix]));
    await waitFor(rows);
    expect(container.querySelector('[title]')).toBeNull();
  });
});

describe('NewsCard states', () => {
  it('shimmers on the card while loading', async () => {
    const { container } = renderCard(() => new Promise<NewsListResult>(() => undefined));

    await waitFor(() => expect(container.querySelector('.shimmer')).not.toBeNull());
    expect(screen.getByRole('list', { name: 'News' })).toHaveAttribute('aria-busy', 'true');
  });

  it('says so when there is nothing yet', async () => {
    renderCard(result([]));
    expect(await screen.findByText('No news yet.')).toBeInTheDocument();
  });

  it('offline with a cache, shows the cached items with a stale note', async () => {
    const checkedAt = '2026-10-30T09:15:00.000Z';
    renderCard(result([gitFix], { stale: true, checkedAt }));

    await waitFor(rows);
    const time = new Date(checkedAt).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(screen.getByText(`Offline, showing news from ${time}`)).toBeInTheDocument();
  });

  it('offline with no cache, offers Try again, which asks main to fetch now', async () => {
    const { user, bridge } = renderCard(result([], { stale: true, checkedAt: null }));

    expect(await screen.findByText('News could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(bridge.$fn('news.refresh')).toHaveBeenCalled();
  });

  it('treats an error from main like being offline', async () => {
    renderCard(() => Promise.reject(new Error('boom')));
    expect(await screen.findByText('News could not be loaded')).toBeInTheDocument();
  });

  it('reloads when main says the news changed', async () => {
    const list = vi.fn(async () => result([item(2)]));
    const { bridge } = renderCard(list);
    await waitFor(rows);
    const calls = list.mock.calls.length;

    bridge.$emit('news.onChanged', { checkedAt: ago(0), stale: false });

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('NewsCard filters', () => {
  it('filters by category and minimum severity, and keeps the choice in settings', async () => {
    const list = vi.fn(async (_query?: NewsListQuery) => result([gitFix]));
    const { user, bridge } = renderCard(list);
    await waitFor(rows);

    await user.click(screen.getByRole('button', { name: 'All categories' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Security' }));
    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: ['security'], minSeverity: 'info' }),
      ),
    );
    expect(bridge.$fn('settings.update')).toHaveBeenLastCalledWith({
      dashboardNewsFilter: { categories: ['security'], minSeverity: 'info' },
    });

    await user.click(screen.getByRole('button', { name: 'Any severity' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'High and up' }));

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: ['security'], minSeverity: 'high' }),
      ),
    );
  });

  it('starts from the filters saved in settings', async () => {
    const list = vi.fn(async (_query?: NewsListQuery) => result([gitFix]));
    renderCard(list, {
      bridge: {
        'settings.get': {
          ...DEFAULT_SETTINGS,
          dashboardNewsFilter: { categories: ['ai', 'bogus'], minSeverity: 'medium' },
        },
      },
    });

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: ['ai'], minSeverity: 'medium' }),
      ),
    );
    expect(await screen.findByRole('button', { name: 'AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Medium and up' })).toBeInTheDocument();
  });

  it('only offers the categories Settings shows', async () => {
    const { user } = renderCard(result([gitFix]), {
      bridge: { 'settings.get': { ...DEFAULT_SETTINGS, newsCategories: ['security', 'ai'] } },
    });
    await waitFor(rows);

    await user.click(screen.getByRole('button', { name: 'All categories' }));
    const offered = await screen.findAllByRole('menuitemcheckbox');
    expect(offered.map((one) => one.textContent)).toEqual(['Security', 'AI']);
  });

  it('drops a saved card filter on a category Settings now hides', async () => {
    const list = vi.fn(async (_query?: NewsListQuery) => result([gitFix]));
    renderCard(list, {
      bridge: {
        'settings.get': {
          ...DEFAULT_SETTINGS,
          newsCategories: ['security'],
          dashboardNewsFilter: { categories: ['ai'], minSeverity: 'info' },
        },
      },
    });

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list).toHaveBeenLastCalledWith(expect.not.objectContaining({ category: ['ai'] }));
    expect(screen.getByRole('button', { name: 'All categories' })).toBeInTheDocument();
  });
});

describe('NewsCard keyboard', () => {
  it('arrow keys move between items, Enter opens the sheet and Escape closes it', async () => {
    const { user } = renderCard(result([gitFix, item(2), item(3)]));
    const [first, second, third] = await waitFor(rows);

    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(third).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(first).toHaveFocus();
    // Only one row is in the tab order at a time.
    expect(rows().filter((row) => row.tabIndex === 0)).toEqual([first]);

    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: gitFix.title })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('NewsCard detail sheet', () => {
  it('strips scripts and event handlers from the body even when the API sends them', async () => {
    const hostile = [
      '<p>Patch <strong>today</strong>.</p>',
      '<script>window.__pwned = 1</script>',
      '<img src="x" onerror="window.__pwned = 1">',
      '<a href="javascript:alert(1)" onclick="window.__pwned = 1">click</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<div style="background:url(javascript:alert(1))" onmouseover="x()">hover</div>',
    ].join('');
    const { user } = renderCard(result([gitFix]), {
      bridge: { 'news.get': async () => detail(gitFix, { bodyHtml: hostile }) },
    });
    await user.click((await waitFor(rows))[0]);

    const sheet = await screen.findByRole('dialog');
    const body = await within(sheet).findByTestId('news-body');
    expect(within(body).getByText('today')).toBeInTheDocument();
    expect(body.querySelector('script, iframe')).toBeNull();
    for (const element of body.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) {
        expect(attribute.startsWith('on')).toBe(false);
      }
      expect(element.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
      expect(element.getAttribute('style') ?? '').not.toMatch(/javascript:/i);
    }
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('shows what to do, the affected technologies and CVEs, and marks the item read', async () => {
    const { user, bridge } = renderCard(result([gitFix]));
    await user.click((await waitFor(rows))[0]);
    const sheet = await screen.findByRole('dialog');

    expect(await within(sheet).findByText('What to do')).toBeInTheDocument();
    expect(
      within(sheet).getByText('Update Git to 2.47.1 or later. This machine has 2.47.0.'),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('<2.47.1')).toBeInTheDocument();
    expect(within(sheet).getByText('CVE-2026-1234')).toBeInTheDocument();
    await waitFor(() => expect(bridge.$fn('news.markRead')).toHaveBeenCalledWith(gitFix.id));
  });

  it('opens the website and the sources outside the app', async () => {
    const { user, bridge } = renderCard(result([gitFix]));
    await user.click((await waitFor(rows))[0]);
    const sheet = await screen.findByRole('dialog');

    await user.click(await within(sheet).findByRole('button', { name: /Open on website/ }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(gitFix.url);
    await user.click(within(sheet).getByRole('button', { name: /Git release notes/ }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('https://git-scm.com/notes');
  });

  it('keeps Mark as read for when marking on open did not stick', async () => {
    const markRead = vi
      .fn(async (_id: number) => undefined)
      .mockRejectedValueOnce(new Error('settings could not be saved'));
    const { user } = renderCard(result([gitFix]), { bridge: { 'news.markRead': markRead } });
    await user.click((await waitFor(rows))[0]);
    const sheet = await screen.findByRole('dialog');

    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));
    await user.click(await within(sheet).findByRole('button', { name: 'Mark as read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
    expect(await within(sheet).findByRole('button', { name: 'Read' })).toBeDisabled();
  });

  it('opens from the notification route, /?news=<slug>', async () => {
    renderCard(result([gitFix]), { route: `/?news=${gitFix.slug}` });

    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByRole('heading', { name: gitFix.title })).toBeInTheDocument();
  });
});

describe('NewsCard view all', () => {
  it('opens the full list from the palette route, /?newsAll=1, and closes it again', async () => {
    const { user } = renderCard(result([gitFix]), { route: '/?newsAll=1' });
    const dialog = await screen.findByRole('dialog', { name: 'News' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'News' })).toBeNull());
  });

  it('pages through everything, 20 at a time, with the same filters', async () => {
    const list = vi.fn(async (query?: NewsListQuery) =>
      result(
        query?.pageSize === 20
          ? [item(query.page === 2 ? 21 : 1, { title: `Page ${query.page ?? 1} item` })]
          : [item(1)],
        { total: 24, totalPages: query?.pageSize === 20 ? 2 : 5, page: query?.page ?? 1 },
      ),
    );
    const { user } = renderCard(list);

    await user.click(await screen.findByRole('button', { name: 'View all (24)' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Page 1 item')).toBeInTheDocument();
    expect(within(dialog).getByText('Page 1 of 2')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next page' }));
    expect(await within(dialog).findByText('Page 2 item')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2, pageSize: 20, minSeverity: 'info' }),
    );
    expect(within(dialog).getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});
