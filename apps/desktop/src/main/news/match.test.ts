import { describe, expect, it } from 'vitest';
import type { InstalledTool, NewsListItem, NewsTechnology } from '../../shared/newsTypes';
import { matchNews, matchNewsAll, parseVersionRange, satisfiesRange } from './match';

/**
 * The version range grammar from docs/website/api-contract.md. The cases are the same as the
 * website API's VersionRangeTests, so the server's validation and this matcher agree.
 */

describe('parseVersionRange', () => {
  it.each(['*', '>=9.8.0 <10.3.0', '>=2.40.0 <2.47.1 || =2.39.5', '<=1', '>1.2.3.4', '=v24.3.0'])(
    'parses %j',
    (text) => {
      expect(parseVersionRange(text)).not.toBeNull();
    },
  );

  it.each([
    '',
    ' ',
    '9.8.0',
    '>= 9.8.0',
    '>=9.8.0  <10.3.0',
    '>=9.8.0 <10.3.0 ',
    '>=9.8.0 ||',
    '|| <1.0.0',
    '>=9.8.0||<1.0.0',
    '~1.2.3',
    '^1.2.3',
    '>=latest',
    '<1.2.3.4.5',
    '<2.47.1.windows.1',
    '* <1.0.0',
    '=',
  ])('refuses %j', (text) => {
    expect(parseVersionRange(text)).toBeNull();
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['*', '0.0.1', true],
    ['*', 'anything-1', false],
    ['>=9.8.0 <10.3.0', '9.8.0', true],
    ['>=9.8.0 <10.3.0', '10.2.99', true],
    ['>=9.8.0 <10.3.0', '10.3.0', false],
    ['>=9.8.0 <10.3.0', '9.7', false],
    ['>=2.40.0 <2.47.1 || =2.39.5', '2.39.5', true],
    ['>=2.40.0 <2.47.1 || =2.39.5', '2.39.4', false],
    ['<2.47.1', '2.47.1.windows.1', false],
    ['<2.47.1', '2.47.0.windows.2', true],
    ['=24.3.0', 'v24.3.0', true],
    ['>=10.0.400', '10.0.401', true],
    ['=1.2', '1.2.0.0', true],
    ['>1.2.3', '1.2.3.1', true],
    ['<=1.2.3', '1.2.3', true],
    ['>=1.0.0', '', false],
    ['>=1.0.0', 'latest', false],
    ['>=1.0.0', 'unknown', false],
    ['>=0.0.0', 'vv1.0.0', false],
  ] as const)('%j holds for %j: %s', (range, version, expected) => {
    expect(satisfiesRange(range, version)).toBe(expected);
  });

  it('never matches a range that does not parse', () => {
    expect(satisfiesRange('~2.0.0', '2.0.0')).toBe(false);
  });
});

function tech(
  technology: string,
  versionRange: string,
  fixedIn: string | null = null,
): NewsTechnology {
  return { technology, name: technology, versionRange, fixedIn };
}

function item(...technologies: NewsTechnology[]): NewsListItem {
  return {
    id: 1,
    slug: 'git-fixes-a-leak',
    url: 'https://runovahq.com/news/git-fixes-a-leak',
    title: 'Git fixes a leak',
    summary: 'Update.',
    category: 'security',
    severity: 'high',
    technologies,
    cveIds: [],
    cvssScore: null,
    tags: [],
    publishedAt: '2026-10-29T08:00:00.000Z',
    updatedAt: '2026-10-29T08:00:00.000Z',
  };
}

const git = (version: string): InstalledTool => ({ slug: 'git', version, label: 'Git' });

describe('matchNews', () => {
  it.each([
    ['inside the range', [git('2.47.0.windows.1')], true],
    ['at the fixed version', [git('2.47.1')], false],
    ['above the range', [git('2.48.0')], false],
    ['below the range', [git('2.39.0')], false],
    ['not installed', [], false],
    ['with no readable version', [git('unknown')], false],
    ['with an empty version', [git('')], false],
  ] as const)('a tool %s: affected is %s', (_case, installed, affected) => {
    const news = item(tech('git', '>=2.40.0 <2.47.1', '2.47.1'));
    const match = matchNews(news, [...installed]);
    expect(match !== null).toBe(affected);
  });

  it('names the tool, the installed version and the fix', () => {
    const news = item(tech('git', '>=2.40.0 <2.47.1', '2.47.1'));
    expect(matchNews(news, [git('2.47.0')])).toEqual({
      slug: 'git',
      label: 'Git',
      version: '2.47.0',
      versionRange: '>=2.40.0 <2.47.1',
      fixedIn: '2.47.1',
    });
  });

  it('matches any installed version of a "*" range', () => {
    expect(
      matchNews(item(tech('docker', '*')), [
        { slug: 'docker', version: '28.1.1', label: 'Docker' },
      ]),
    ).not.toBeNull();
  });

  it('ignores a technology the app cannot detect', () => {
    expect(matchNews(item(tech('openssh', '*')), [git('2.47.0')])).toBeNull();
  });

  it('prefers the installed Node.js over the one inside Runova when both match', () => {
    const installed: InstalledTool[] = [
      { slug: 'nodejs', version: '24.3.0', label: 'Node.js' },
      { slug: 'nodejs', version: '24.1.0', label: 'Node.js (inside Runova)' },
    ];
    expect(matchNews(item(tech('nodejs', '<25.0.0')), installed)?.label).toBe('Node.js');
  });

  it('names the Node.js inside Runova when only that one matches', () => {
    const installed: InstalledTool[] = [
      { slug: 'nodejs', version: '22.0.0', label: 'Node.js' },
      { slug: 'nodejs', version: '24.1.0', label: 'Node.js (inside Runova)' },
    ];
    expect(matchNews(item(tech('nodejs', '>=24.0.0')), installed)?.label).toBe(
      'Node.js (inside Runova)',
    );
  });

  it('lists every affected technology, the first being the badge', () => {
    const news = item(tech('openssh', '*'), tech('git', '<3.0.0'), tech('docker', '*'));
    const installed: InstalledTool[] = [
      { slug: 'docker', version: '28.1.1', label: 'Docker' },
      git('2.47.0'),
    ];
    expect(matchNewsAll(news, installed).map((match) => match.slug)).toEqual(['git', 'docker']);
    expect(matchNews(news, installed)?.slug).toBe('git');
  });
});
