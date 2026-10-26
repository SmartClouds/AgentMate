import { describe, expect, it } from 'vitest';
import { LEGACY_IGNORE_FILE, LEGACY_PROJECT_DIR } from '../../legacyNames.js';
import {
  createWpIgnoreRules,
  findWpCaseCollisions,
  isWpHardDenied,
  validateWpItemPath,
  wpItemKey,
  wpItemRoot,
  wpMirrorPath,
} from './pathPolicy.js';

describe('the hard deny list', () => {
  it('matches any segment, in any case', () => {
    expect(isWpHardDenied('inc/.Claude/x.md')).toBe(true);
    expect(isWpHardDenied('a/b/Gemini.MD')).toBe(true);
    expect(isWpHardDenied('certs/site.PEM')).toBe(true);
    expect(isWpHardDenied('inc/environment.php')).toBe(false);
    // Lookalikes a case-insensitive disk may fold into a denied name (the long s).
    expect(isWpHardDenied('.curſor/rules/r.mdc')).toBe(true);
    expect(isWpHardDenied('AGENTſ.md')).toBe(true);
    expect(isWpHardDenied('claude.php')).toBe(false);
  });

  it('keeps every folder or file that starts with .claude or .runova on this computer', () => {
    for (const path of [
      '.claude-plugin/plugin.json',
      'inc/.claude.local/x.md',
      '.claudeignore',
      '.CLAUDE-notes/a.txt',
      '.runova-cache/a.json',
      'build/.runova.old/a',
      '.runovafoo',
    ]) {
      expect(isWpHardDenied(path), path).toBe(true);
      expect(validateWpItemPath(path), path).toEqual({ ok: false, reason: 'hardDenied' });
    }
    // The folder and ignore file of projects made before the rename, too.
    for (const path of [
      `${LEGACY_PROJECT_DIR}/hooks/notify.sh`,
      `inc/${LEGACY_PROJECT_DIR}-cache/a.json`,
      LEGACY_IGNORE_FILE,
    ]) {
      expect(validateWpItemPath(path), path).toEqual({ ok: false, reason: 'hardDenied' });
    }
    // Only the dot names: a plain word, or a longer name that merely shares the letters, is fine.
    for (const path of ['claude-notes/a.txt', 'inc/runova.php', '.claudia/x', '.agent/x']) {
      expect(isWpHardDenied(path), path).toBe(false);
    }
  });
});

describe('mirror paths', () => {
  it('keep the site layout inside the project folder', () => {
    expect(wpItemRoot({ kind: 'mu-plugin', slug: 'loader.php' })).toBe(
      'wp-content/mu-plugins/loader.php',
    );
    expect(wpMirrorPath({ kind: 'theme', slug: 't' }, false, 'inc/a.php')).toBe(
      'wp-content/themes/t/inc/a.php',
    );
    expect(wpMirrorPath({ kind: 'plugin', slug: 'hello.php' }, true, 'hello.php')).toBe(
      'wp-content/plugins/hello.php',
    );
    expect(() => wpMirrorPath({ kind: 'plugin', slug: 'hello.php' }, true, 'other.php')).toThrow();
    expect(wpItemKey({ kind: 'plugin', slug: 'akismet' })).toBe('plugin:akismet');
  });
});

describe('case collisions', () => {
  it('find paths that are one file on Windows or macOS', () => {
    expect(findWpCaseCollisions(['a.php', 'A.php', 'b.php', 'x/Y', 'X/y'])).toEqual([
      ['a.php', 'A.php'],
      ['x/Y', 'X/y'],
    ]);
  });
});

describe('ignore rules', () => {
  it('leave local clutter out until the site has it, at any depth', () => {
    const built = createWpIgnoreRules([]);
    if (!built.ok) throw new Error('should compile');
    const { rules } = built;
    expect(rules.excludedUnlessTracked('assets/debug.log')).toBe(true);
    expect(rules.excludedUnlessTracked('skills/x.md')).toBe(true);
    expect(rules.excludedUnlessTracked('inc/skills/x.md')).toBe(false);
    expect(rules.excluded('assets/debug.log')).toBe(false);
    expect(rules.canSkipFolder('node_modules')).toBe(true);
    expect(rules.canSkipFolder('inc')).toBe(false);
  });

  it("apply the user's own files both ways, and let them put defaults back", () => {
    const built = createWpIgnoreRules([
      { source: '.distignore', text: '# dev only\n/tests/\nphpunit.xml\r\n\n' },
      { source: '.runovaignore', text: '!.editorconfig\n!/skills/\n' },
    ]);
    if (!built.ok) throw new Error('should compile');
    const { rules } = built;
    expect(rules.excluded('tests/a.php')).toBe(true);
    expect(rules.excluded('inc/tests/a.php')).toBe(false);
    expect(rules.excluded('sub/phpunit.xml')).toBe(true);
    expect(rules.excludedUnlessTracked('.editorconfig')).toBe(false);
    expect(rules.excludedUnlessTracked('skills/x.md')).toBe(false);
    // `!.editorconfig` could put back node_modules/.editorconfig, so the walker has to look.
    expect(rules.canSkipFolder('node_modules')).toBe(false);
    expect(rules.canSkipFolder('skills')).toBe(false);
  });

  it('let a layer from the site only leave more out, never put things back', () => {
    const built = createWpIgnoreRules([
      {
        source: '.distignore',
        text: '!.editorconfig\n!node_modules/\n/tests/\n',
        negations: false,
      },
    ]);
    if (!built.ok) throw new Error('should compile');
    expect(built.rules.excludedUnlessTracked('.editorconfig')).toBe(true);
    expect(built.rules.excludedUnlessTracked('node_modules/x.js')).toBe(true);
    expect(built.rules.excluded('tests/a.php')).toBe(true);
  });

  it('say which file and line is wrong', () => {
    expect(createWpIgnoreRules([{ source: '.runovaignore', text: 'ok\n[a' }])).toEqual({
      ok: false,
      source: '.runovaignore',
      line: 2,
      reason: expect.stringContaining('never closed'),
    });
  });

  it('skip lines that are only a slash or a bang', () => {
    const built = createWpIgnoreRules([{ source: '.distignore', text: '/\n!\n' }]);
    expect(built.ok).toBe(true);
  });

  it("leave out what the item's and the project's .gitignore name, until the site has it", () => {
    const built = createWpIgnoreRules([], {
      itemRoot: 'wp-content/plugins/shop',
      item: '/dist/\n*.map\n!keep.map\n',
      project: 'vendor/\n/wp-content/plugins/shop/tests/\n/wp-content/uploads/\n',
    });
    if (!built.ok) throw new Error('should compile');
    const { rules } = built;
    expect(rules.excludedUnlessTracked('dist/app.js')).toBe(true);
    expect(rules.excludedUnlessTracked('inc/dist/app.js')).toBe(false);
    expect(rules.excludedUnlessTracked('a/b.js.map')).toBe(true);
    expect(rules.excludedUnlessTracked('keep.map')).toBe(false);
    expect(rules.excludedUnlessTracked('vendor/autoload.php')).toBe(true);
    expect(rules.excludedUnlessTracked('tests/a.php')).toBe(true);
    expect(rules.excludedUnlessTracked('inc/shop.php')).toBe(false);
    expect(rules.excluded('dist/app.js')).toBe(false);
  });

  it('keep a .gitignore from putting a built-in default back', () => {
    const built = createWpIgnoreRules([], {
      itemRoot: 'wp-content/themes/t',
      item: '!node_modules/\n!debug.log\n',
    });
    if (!built.ok) throw new Error('should compile');
    expect(built.rules.excludedUnlessTracked('node_modules/x.js')).toBe(true);
    expect(built.rules.excludedUnlessTracked('debug.log')).toBe(true);
  });

  it('never fail on a .gitignore line it cannot read', () => {
    const built = createWpIgnoreRules([], {
      itemRoot: 'wp-content/themes/t',
      item: '[a\ndist/\n',
      project: '[z-a\nbuild/\n',
    });
    if (!built.ok) throw new Error('should compile');
    expect(built.rules.excludedUnlessTracked('dist/a.js')).toBe(true);
    expect(built.rules.excludedUnlessTracked('build/a.js')).toBe(true);
  });

  it('let the project .gitignore whitelist one theme out of a folder it ignores', () => {
    const built = createWpIgnoreRules([], {
      itemRoot: 'wp-content/themes/mine',
      project: '/wp-content/themes/*\n!/wp-content/themes/mine\n',
    });
    if (!built.ok) throw new Error('should compile');
    expect(built.rules.excludedUnlessTracked('functions.php')).toBe(false);
  });
});
