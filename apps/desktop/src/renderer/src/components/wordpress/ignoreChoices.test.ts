import { describe, expect, it } from 'vitest';
import {
  addIgnoreLines,
  ignoreChoicesFor,
  ignoreRows,
  ignoreSummary,
  linesForFiles,
} from './ignoreChoices';

const THEME = { kind: 'theme', slug: 'storefront' } as const;
const PLUGIN = { kind: 'plugin', slug: 'woocommerce' } as const;
const SOLO = { kind: 'plugin', slug: 'solo.php' } as const;

describe('ignoreChoicesFor', () => {
  it('offers the file, its folders from the top down, and every file with the same ending', () => {
    const choices = ignoreChoicesFor(THEME, 'assets/css/app.css.map');
    expect(choices.map((choice) => [choice.id, choice.key, choice.pattern])).toEqual([
      ['file', 'theme:storefront', '/assets/css/app.css.map'],
      ['folder:assets', 'theme:storefront', '/assets/'],
      ['folder:assets/css', 'theme:storefront', '/assets/css/'],
      ['extension', 'theme:storefront', '*.map'],
      ['extension:all', '*', '*.map'],
    ]);
    expect(choices.map((choice) => choice.label)).toEqual([
      'Ignore this file',
      'Ignore the folder assets/',
      'Ignore the folder assets/css/',
      'Ignore every .map file in this theme',
      'Ignore every .map file in every theme and plugin',
    ]);
  });

  it('names the kind of item in the ending choice', () => {
    expect(ignoreChoicesFor(PLUGIN, 'a.log').find((c) => c.id === 'extension')?.label).toBe(
      'Ignore every .log file in this plugin',
    );
  });

  it('keeps the top folder and the two nearest when the path is deep', () => {
    const ids = ignoreChoicesFor(THEME, 'a/b/c/d/e/f.txt')
      .filter((choice) => choice.id.startsWith('folder'))
      .map((choice) => choice.id);
    expect(ids).toEqual(['folder:a', 'folder:a/b/c/d', 'folder:a/b/c/d/e']);
  });

  it('has no folder choice for a file at the top, and no ending choice without an ending', () => {
    expect(ignoreChoicesFor(THEME, 'style.css').map((choice) => choice.id)).toEqual([
      'file',
      'extension',
      'extension:all',
    ]);
    expect(ignoreChoicesFor(THEME, 'LICENSE').map((choice) => choice.id)).toEqual(['file']);
    expect(ignoreChoicesFor(THEME, 'inc/.htaccess').map((choice) => choice.id)).toEqual([
      'file',
      'folder:inc',
    ]);
  });

  it('escapes the pattern for a name with special characters, and shows the plain name', () => {
    const [file] = ignoreChoicesFor(THEME, 'inc/a[1].js');
    expect(file.pattern).toBe('/inc/a\\[1\\].js');
  });

  it('offers nothing for the one file of a single-file plugin', () => {
    expect(ignoreChoicesFor(SOLO, 'solo.php')).toEqual([]);
  });

  it('offers nothing for a path it cannot say safely', () => {
    expect(ignoreChoicesFor(THEME, 'inc/back\\slash.js')).toEqual([]);
  });
});

describe('linesForFiles', () => {
  it('turns picked files into one anchored line each, by item, without repeats', () => {
    const lines = linesForFiles([
      { item: THEME, path: 'inc/a.php' },
      { item: THEME, path: 'inc/b.php' },
      { item: THEME, path: 'inc/a.php' },
      { item: PLUGIN, path: 'readme.txt' },
    ]);
    expect(lines).toEqual([
      { key: 'theme:storefront', patterns: ['/inc/a.php', '/inc/b.php'] },
      { key: 'plugin:woocommerce', patterns: ['/readme.txt'] },
    ]);
  });

  it('skips a file of a single-file plugin and a path it cannot say safely', () => {
    expect(
      linesForFiles([
        { item: SOLO, path: 'solo.php' },
        { item: THEME, path: 'x\\y' },
      ]),
    ).toEqual([]);
  });
});

describe('addIgnoreLines', () => {
  it('adds to the saved list without touching what is there', () => {
    const next = addIgnoreLines({ '*': ['*.map'] }, [
      { key: 'theme:storefront', patterns: ['/vendor/'] },
      { key: '*', patterns: ['*.map', '*.zip'] },
    ]);
    expect(next).toEqual({ '*': ['*.map', '*.zip'], 'theme:storefront': ['/vendor/'] });
  });
});

describe('ignoreRows', () => {
  it('reads the saved lines back as folders, files and patterns, for every item first', () => {
    const rows = ignoreRows(
      {
        'plugin:woocommerce': ['/tests/', '/inc/a\\[1\\].js'],
        '*': ['*.map', '!keep.map'],
        'theme:storefront': ['/vendor/'],
        'plugin:gone': ['/x/'],
      },
      [THEME, PLUGIN],
    );
    expect(rows.map((row) => [row.scope, row.kind, row.label, row.pattern])).toEqual([
      ['all', 'pattern', '*.map', '*.map'],
      ['all', 'pattern', '!keep.map', '!keep.map'],
      ['theme:storefront', 'folder', 'vendor/', '/vendor/'],
      ['plugin:woocommerce', 'folder', 'tests/', '/tests/'],
      ['plugin:woocommerce', 'file', 'inc/a[1].js', '/inc/a\\[1\\].js'],
    ]);
    expect(rows[2].item).toEqual(THEME);
    expect(rows[0].item).toBeNull();
  });

  it('is empty for no list', () => {
    expect(ignoreRows(undefined, [THEME])).toEqual([]);
  });
});

describe('ignoreSummary', () => {
  it('says what was ignored in plain words', () => {
    expect(ignoreSummary([{ key: 'theme:storefront', patterns: ['/a.php'] }])).toBe(
      'Ignored 1 file in storefront.',
    );
    expect(
      ignoreSummary([
        { key: 'theme:storefront', patterns: ['/a.php', '/b.php'] },
        { key: 'plugin:woocommerce', patterns: ['/c.php'] },
      ]),
    ).toBe('Ignored 3 files in 2 themes and plugins.');
    expect(ignoreSummary([{ key: 'theme:storefront', patterns: ['/vendor/'] }])).toBe(
      'Ignored vendor/ in storefront.',
    );
    expect(ignoreSummary([{ key: '*', patterns: ['*.map'] }])).toBe(
      'Ignored *.map in every theme and plugin.',
    );
  });
});
