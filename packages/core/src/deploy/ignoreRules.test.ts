import { describe, expect, it } from 'vitest';
import { createIgnoreRules } from './ignoreRules.js';

function build(...args: Parameters<typeof createIgnoreRules>) {
  const built = createIgnoreRules(...args);
  if (!built.ok) throw new Error(`should compile: ${built.reason}`);
  return built.rules;
}

describe('createIgnoreRules', () => {
  it('leaves out what the given defaults name, at any depth, only until tracked', () => {
    const rules = build([], ['*.tmp', '/build/', 'cache/']);
    expect(rules.excludedUnlessTracked('a.tmp')).toBe(true);
    expect(rules.excludedUnlessTracked('deep/er/a.tmp')).toBe(true);
    expect(rules.excludedUnlessTracked('build/out.js')).toBe(true);
    expect(rules.excludedUnlessTracked('src/build/out.js')).toBe(false);
    expect(rules.excludedUnlessTracked('src/cache/x')).toBe(true);
    expect(rules.excludedUnlessTracked('a.txt')).toBe(false);
    // Defaults never leave anything out both ways.
    expect(rules.excluded('a.tmp')).toBe(false);
    expect(rules.canSkipFolder('build')).toBe(true);
    expect(rules.canSkipFolder('src')).toBe(false);
  });

  it('knows nothing of the WordPress defaults when given other ones', () => {
    const rules = build([], ['*.tmp']);
    expect(rules.excludedUnlessTracked('node_modules/x.js')).toBe(false);
    expect(rules.excludedUnlessTracked('.distignore')).toBe(false);
  });

  it('with no defaults, leaves out only what the user names', () => {
    const rules = build([{ source: '.agentmateignore', text: 'secret/\n' }], []);
    expect(rules.excluded('secret/a')).toBe(true);
    expect(rules.excludedUnlessTracked('secret/a')).toBe(true);
    expect(rules.excludedUnlessTracked('a.log')).toBe(false);
  });

  it('lets a user layer put a default back with !', () => {
    const rules = build([{ source: '.agentmateignore', text: '!keep.tmp\n' }], ['*.tmp']);
    expect(rules.excludedUnlessTracked('keep.tmp')).toBe(false);
    expect(rules.excludedUnlessTracked('sub/keep.tmp')).toBe(false);
    expect(rules.excludedUnlessTracked('other.tmp')).toBe(true);
  });

  it('ignores ! lines in a layer that may not put things back', () => {
    const rules = build(
      [{ source: 'site', text: '!keep.tmp\n/tests/\n', negations: false }],
      ['*.tmp'],
    );
    expect(rules.excludedUnlessTracked('keep.tmp')).toBe(true);
    expect(rules.excluded('tests/a.js')).toBe(true);
  });

  it('says which layer and line is wrong', () => {
    expect(createIgnoreRules([{ source: 'site patterns', text: 'ok\n\n[a' }], ['*.tmp'])).toEqual({
      ok: false,
      source: 'site patterns',
      line: 3,
      reason: expect.stringContaining('never closed'),
    });
  });

  it('reports a broken default as coming from the defaults', () => {
    expect(createIgnoreRules([], ['ok', '[a'])).toEqual({
      ok: false,
      source: 'default',
      line: 2,
      reason: expect.stringContaining('never closed'),
    });
  });
});

describe('default layers read from files', () => {
  const gitignore = { source: '.gitignore', text: 'dist/\n*.map\n/docs/\n', lenient: true };

  it('leave things out until tracked, and the user can put them back', () => {
    const rules = build([{ source: '.agentmateignore', text: '!app.js.map\n' }], ['*.tmp'], {
      defaultLayers: [gitignore],
    });
    expect(rules.excludedUnlessTracked('dist/app.js')).toBe(true);
    expect(rules.excludedUnlessTracked('assets/app.css.map')).toBe(true);
    expect(rules.excludedUnlessTracked('docs/a.md')).toBe(true);
    expect(rules.excludedUnlessTracked('src/docs/a.md')).toBe(false);
    expect(rules.excludedUnlessTracked('a.tmp')).toBe(true);
    expect(rules.excludedUnlessTracked('app.js.map')).toBe(false);
    // Never both ways: that is for the user's own layers.
    expect(rules.excluded('dist/app.js')).toBe(false);
    // A `!` line could put back a file inside any folder, so with none the walker can skip it.
    const plain = build([], ['*.tmp'], { defaultLayers: [gitignore] });
    expect(plain.canSkipFolder('dist')).toBe(true);
    expect(plain.canSkipFolder('src')).toBe(false);
  });

  it('cannot put one of the given defaults back with a ! line', () => {
    const rules = build([], ['node_modules/'], {
      defaultLayers: [{ source: '.gitignore', text: '!node_modules/\n!keep.tmp\n', lenient: true }],
    });
    expect(rules.excludedUnlessTracked('node_modules/x.js')).toBe(true);
  });

  it('keep their own ! lines working among themselves', () => {
    const rules = build([], [], {
      defaultLayers: [{ source: '.gitignore', text: '*.log\n!keep.log\n', lenient: true }],
    });
    expect(rules.excludedUnlessTracked('a.log')).toBe(true);
    expect(rules.excludedUnlessTracked('keep.log')).toBe(false);
  });

  it('skip a line that cannot be read instead of failing the rest', () => {
    const rules = build([], [], {
      defaultLayers: [{ source: '.gitignore', text: '[a\ndist/\n[z-a]\n', lenient: true }],
    });
    expect(rules.excludedUnlessTracked('dist/x')).toBe(true);
  });

  it('still fail on a line that cannot be read when they are not lenient', () => {
    expect(
      createIgnoreRules([], [], { defaultLayers: [{ source: 'file', text: 'ok\n[a' }] }),
    ).toEqual({
      ok: false,
      source: 'file',
      line: 2,
      reason: expect.stringContaining('never closed'),
    });
  });
});

describe('default layers written for a folder above the synced one', () => {
  const FOLDER = 'wp-content/themes/foo';
  const ancestor = (text: string) => ({
    source: '.gitignore',
    text,
    lenient: true,
    scope: 'ancestor' as const,
  });
  const within = (text: string, extra: string[] = []) =>
    build([], extra, { defaultLayers: [ancestor(text)], ancestorPath: FOLDER });

  it('match paths with the synced folder in front of them', () => {
    const rules = within(
      'node_modules\n*.zip\n/wp-content/themes/foo/build/\n/wp-content/uploads/\n',
    );
    expect(rules.excludedUnlessTracked('node_modules/x.js')).toBe(true);
    expect(rules.excludedUnlessTracked('assets/pack.zip')).toBe(true);
    expect(rules.excludedUnlessTracked('build/out.js')).toBe(true);
    expect(rules.excludedUnlessTracked('inc/build/out.js')).toBe(false);
    expect(rules.excludedUnlessTracked('inc/a.php')).toBe(false);
    expect(rules.canSkipFolder('build')).toBe(true);
  });

  it('keep a folder that a whitelist in the same file lets through', () => {
    const rules = within('/wp-content/themes/*\n!/wp-content/themes/foo\n');
    expect(rules.excludedUnlessTracked('functions.php')).toBe(false);
    expect(rules.excludedUnlessTracked('inc/a.php')).toBe(false);
    const other = build([], [], {
      defaultLayers: [ancestor('/wp-content/themes/*\n!/wp-content/themes/foo\n')],
      ancestorPath: 'wp-content/themes/bar',
    });
    // Ignored by that file, but the folder itself is what the user asked to sync.
    expect(other.excludedUnlessTracked('functions.php')).toBe(false);
  });

  it('are dropped when they ignore the synced folder itself', () => {
    const rules = within('/wp-content/themes/foo/\n*.zip\n');
    expect(rules.excludedUnlessTracked('functions.php')).toBe(false);
    expect(rules.excludedUnlessTracked('a.zip')).toBe(false);
    const parent = within('wp-content/\n');
    expect(parent.excludedUnlessTracked('functions.php')).toBe(false);
  });

  it('let the synced folder own layers and the given defaults work as before', () => {
    const rules = build([{ source: '.agentmateignore', text: '/tests/\n!keep.zip\n' }], ['*.tmp'], {
      defaultLayers: [
        ancestor('*.zip\n'),
        { source: 'foo/.gitignore', text: '/dist/\n', lenient: true },
      ],
      ancestorPath: FOLDER,
    });
    expect(rules.excluded('tests/a.php')).toBe(true);
    expect(rules.excluded('inc/tests/a.php')).toBe(false);
    expect(rules.excludedUnlessTracked('dist/a.js')).toBe(true);
    expect(rules.excludedUnlessTracked('inc/dist/a.js')).toBe(false);
    expect(rules.excludedUnlessTracked('x.tmp')).toBe(true);
    expect(rules.excludedUnlessTracked('a.zip')).toBe(true);
    expect(rules.excludedUnlessTracked('keep.zip')).toBe(false);
  });

  it('are left out when no ancestor path is given', () => {
    const rules = build([], [], { defaultLayers: [ancestor('*.zip\n')] });
    expect(rules.excludedUnlessTracked('a.zip')).toBe(false);
  });
});
