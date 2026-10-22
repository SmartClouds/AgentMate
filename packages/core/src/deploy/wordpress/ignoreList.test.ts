import { describe, expect, it } from 'vitest';
import {
  ignorePatternForExtension,
  ignorePatternForPath,
  normalizeWpIgnore,
  WP_IGNORE_ALL,
  WP_IGNORE_MAX_LINE,
  WP_IGNORE_MAX_LINES,
  withoutWpIgnore,
  withWpIgnore,
  wpIgnoreLinesFor,
} from './ignoreList.js';
import { createWpIgnoreRules } from './pathPolicy.js';

const THEME = { kind: 'theme', slug: 'foo' } as const;
const PLUGIN = { kind: 'plugin', slug: 'shop' } as const;

function rulesFor(...lines: string[]) {
  const built = createWpIgnoreRules([{ source: 'saved', text: lines.join('\n') }]);
  if (!built.ok) throw new Error(`should compile: ${built.reason}`);
  return built.rules;
}

describe('normalizeWpIgnore', () => {
  it('keeps lines for every item and for the linked items, trimmed and without repeats', () => {
    expect(
      normalizeWpIgnore(
        {
          '*': ['  *.map ', '*.map', '/docs/'],
          'theme:foo': ['/src/', ''],
          'plugin:shop': ['/tests/'],
        },
        [THEME, PLUGIN],
      ),
    ).toEqual({
      '*': ['*.map', '/docs/'],
      'theme:foo': ['/src/'],
      'plugin:shop': ['/tests/'],
    });
  });

  it('drops keys of items the project does not link, and anything that is not text', () => {
    expect(
      normalizeWpIgnore(
        {
          'plugin:gone': ['/a/'],
          'theme:foo': ['/ok/', 7, null, 'line\nbreak', 'bell\u0007'],
          'not a key': ['/x/'],
          '*': 'nope',
        },
        [THEME],
      ),
    ).toEqual({ 'theme:foo': ['/ok/'] });
  });

  it('is undefined when nothing is left, or the value is not an object', () => {
    expect(normalizeWpIgnore({ 'theme:foo': [] }, [THEME])).toBeUndefined();
    expect(normalizeWpIgnore({}, [THEME])).toBeUndefined();
    expect(normalizeWpIgnore(undefined, [THEME])).toBeUndefined();
    expect(normalizeWpIgnore(['/a/'], [THEME])).toBeUndefined();
    expect(normalizeWpIgnore('x', [THEME])).toBeUndefined();
  });

  it('caps how long a line and how many lines a key can hold', () => {
    const long = `/${'a'.repeat(WP_IGNORE_MAX_LINE)}`;
    const many = Array.from({ length: WP_IGNORE_MAX_LINES + 20 }, (_, index) => `/f${index}`);
    const result = normalizeWpIgnore({ [WP_IGNORE_ALL]: [long, '/short'], 'theme:foo': many }, [
      THEME,
    ]);
    expect(result?.[WP_IGNORE_ALL]).toEqual(['/short']);
    expect(result?.['theme:foo']).toHaveLength(WP_IGNORE_MAX_LINES);
  });
});

describe('wpIgnoreLinesFor', () => {
  it("gives the lines for every item first, then the item's own", () => {
    expect(
      wpIgnoreLinesFor({ '*': ['*.map'], 'theme:foo': ['/src/'], 'plugin:shop': ['/x/'] }, THEME),
    ).toEqual(['*.map', '/src/']);
    expect(wpIgnoreLinesFor(undefined, THEME)).toEqual([]);
    expect(wpIgnoreLinesFor({ 'plugin:shop': ['/x/'] }, THEME)).toEqual([]);
  });
});

describe('withWpIgnore and withoutWpIgnore', () => {
  it('add lines to a key without repeating one, and leave the other keys alone', () => {
    const first = withWpIgnore(undefined, 'theme:foo', ['/src/', '/docs/']);
    expect(first).toEqual({ 'theme:foo': ['/src/', '/docs/'] });
    const second = withWpIgnore(first, 'theme:foo', ['/docs/', '/tests/']);
    expect(second).toEqual({ 'theme:foo': ['/src/', '/docs/', '/tests/'] });
    expect(withWpIgnore(second, WP_IGNORE_ALL, ['*.map'])).toEqual({
      'theme:foo': ['/src/', '/docs/', '/tests/'],
      '*': ['*.map'],
    });
    // The list it was given is not changed.
    expect(first).toEqual({ 'theme:foo': ['/src/', '/docs/'] });
  });

  it('take one line out, and drop a key that is left empty', () => {
    const list = { 'theme:foo': ['/src/', '/docs/'], '*': ['*.map'] };
    expect(withoutWpIgnore(list, 'theme:foo', '/src/')).toEqual({
      'theme:foo': ['/docs/'],
      '*': ['*.map'],
    });
    expect(withoutWpIgnore(list, '*', '*.map')).toEqual({ 'theme:foo': ['/src/', '/docs/'] });
    expect(withoutWpIgnore({ '*': ['*.map'] }, '*', '*.map')).toBeUndefined();
    expect(withoutWpIgnore(list, 'theme:foo', '/missing/')).toEqual(list);
  });
});

describe('ignorePatternForPath', () => {
  it('anchors a file or a folder to the item root', () => {
    expect(ignorePatternForPath('src/app.ts', 'file')).toBe('/src/app.ts');
    expect(ignorePatternForPath('node_modules', 'folder')).toBe('/node_modules/');
    expect(ignorePatternForPath('assets/css/', 'folder')).toBe('/assets/css/');
  });

  it('leaves out exactly the path it was made from, whatever characters the name holds', () => {
    for (const name of ['a[1].js', 'star*.js', 'q?.js', 'a]b.js', '#hash.js', '!bang.js']) {
      const pattern = ignorePatternForPath(`inc/${name}`, 'file') as string;
      expect(pattern, name).toBeTruthy();
      const rules = rulesFor(pattern);
      expect(rules.excluded(`inc/${name}`), name).toBe(true);
      expect(rules.excluded('inc/a1.js'), name).toBe(false);
      expect(rules.excluded(`other/inc/${name}`), name).toBe(false);
    }
  });

  it('covers everything inside a folder and nothing beside it', () => {
    const rules = rulesFor(ignorePatternForPath('src/vendor', 'folder') as string);
    expect(rules.excluded('src/vendor/a/b.js')).toBe(true);
    expect(rules.excluded('src/vendor.js')).toBe(false);
    expect(rules.excluded('lib/src/vendor/a.js')).toBe(false);
    expect(rules.canSkipFolder('src/vendor')).toBe(true);
  });

  it('gives no pattern for a path it cannot say safely', () => {
    expect(ignorePatternForPath('', 'file')).toBeNull();
    expect(ignorePatternForPath('a//b', 'file')).toBeNull();
    expect(ignorePatternForPath('../a', 'file')).toBeNull();
    expect(ignorePatternForPath('inc/ lead.js', 'file')).toBeNull();
    expect(ignorePatternForPath('a\nb', 'file')).toBeNull();
    expect(ignorePatternForPath('inc/back\\slash.js', 'file')).toBeNull();
  });
});

describe('ignorePatternForExtension', () => {
  it('names every file with the same ending, at any depth', () => {
    expect(ignorePatternForExtension('assets/app.js.map')).toBe('*.map');
    expect(ignorePatternForExtension('Readme.MD')).toBe('*.MD');
    const rules = rulesFor(ignorePatternForExtension('x/y.map') as string);
    expect(rules.excluded('a/b/c.map')).toBe(true);
    expect(rules.excluded('a/b/c.mapx')).toBe(false);
  });

  it('gives none for a file with no ending, a dot file, or an odd ending', () => {
    expect(ignorePatternForExtension('LICENSE')).toBeNull();
    expect(ignorePatternForExtension('inc/.htaccess')).toBeNull();
    expect(ignorePatternForExtension('a/b.')).toBeNull();
    expect(ignorePatternForExtension('a/b.[x]')).toBeNull();
    expect(ignorePatternForExtension('a/b.j s')).toBeNull();
  });
});
