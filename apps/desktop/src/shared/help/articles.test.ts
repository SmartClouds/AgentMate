import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHelpArticle, HELP_ARTICLES, helpArticlesByCategory } from './articles';
import { HELP_CATEGORIES, parseArticle, resolveHelpLink } from './parse';
import { createHelpSearch } from './search';

/**
 * The bundled articles themselves, checked the way a reviewer would: every file loads, nothing
 * links to a page or heading that does not exist, the house style holds, and every page in the
 * main menu has an article that explains it.
 */

const articleDir = join(__dirname, 'articles');

describe('HELP_ARTICLES', () => {
  it('loads every markdown file in the articles folder', () => {
    const files = readdirSync(articleDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    expect(HELP_ARTICLES.map((a) => `${a.slug}.md`).sort()).toEqual(files.sort());
  });

  it('gives every article a known category, a summary and keywords', () => {
    for (const article of HELP_ARTICLES) {
      expect(HELP_CATEGORIES, article.slug).toContain(article.category);
      expect(article.summary, article.slug).not.toBe('');
      expect(article.keywords.length, article.slug).toBeGreaterThan(0);
    }
  });

  it('never uses the em dash', () => {
    // Built from its code point so this file does not contain the character it bans.
    const emDash = String.fromCharCode(0x2014);
    const offenders = HELP_ARTICLES.filter((a) => a.body.includes(emDash)).map((a) => a.slug);
    expect(offenders).toEqual([]);
  });

  it('only links to articles and headings that exist', () => {
    const broken: string[] = [];
    for (const article of HELP_ARTICLES) {
      for (const [, href] of article.body.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(href!)) continue;
        const target = resolveHelpLink(href, article.slug);
        const linked = target && getHelpArticle(target.slug);
        if (!linked || (target.anchor && !linked.sections.some((s) => s.id === target.anchor))) {
          broken.push(`${article.slug}: ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('covers every page in the main menu', () => {
    const nav = readFileSync(
      join(__dirname, '../../renderer/src/components/layout/mainNav.ts'),
      'utf-8',
    );
    const routes = [...nav.matchAll(/\bto: '(\/[^']*)'/g)].map((m) => m[1]);
    const covered = new Set(HELP_ARTICLES.map((a) => a.route));
    expect(routes.filter((r) => !covered.has(r))).toEqual([]);
  });
});

describe('the News article (E42)', () => {
  const raw = readFileSync(join(articleDir, 'news.md'), 'utf-8');

  it('parses with the help parser and opens the Dashboard', () => {
    const article = parseArticle('news', raw);
    expect(article.title).toBe('News');
    expect(article.category).toBe('Getting started');
    expect(article.route).toBe('/');
    expect(article.keywords).toEqual(expect.arrayContaining(['news', 'security']));
    expect(article.sections.map((section) => section.heading)).toEqual(
      expect.arrayContaining(['Affects your system', 'News settings', 'Privacy']),
    );
  });

  it('is listed on the Help page next to the Dashboard article', () => {
    const group = helpArticlesByCategory().find((g) => g.category === 'Getting started');
    expect(group?.articles.map((a) => a.slug)).toEqual(
      expect.arrayContaining(['dashboard', 'news']),
    );
  });

  it('is found by Help search', () => {
    const search = createHelpSearch(HELP_ARTICLES);
    expect(search('news')[0]?.slug).toBe('news');
    expect(search('affects your system').map((hit) => hit.slug)).toContain('news');
    expect(search('security fix notification').map((hit) => hit.slug)).toContain('news');
  });

  it('follows the website copy rules, since the website shows it too', () => {
    // No phone app is part of this feature, so the article never sends anyone to one.
    expect(raw).not.toMatch(/\bmobile\b|\bphone\b/i);
    expect(raw).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('helpArticlesByCategory', () => {
  it('groups articles in category order, each group sorted by order', () => {
    const groups = helpArticlesByCategory();
    const names = groups.map((g) => g.category);
    expect(names).toEqual(HELP_CATEGORIES.filter((c) => names.includes(c)));
    for (const group of groups) {
      const orders = group.articles.map((a) => a.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

describe('getHelpArticle', () => {
  it('finds an article by slug and returns undefined for unknown ones', () => {
    const first = HELP_ARTICLES[0]!;
    expect(getHelpArticle(first.slug)).toBe(first);
    expect(getHelpArticle('no-such-article')).toBeUndefined();
  });
});
