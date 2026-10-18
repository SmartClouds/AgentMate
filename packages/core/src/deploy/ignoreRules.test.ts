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
