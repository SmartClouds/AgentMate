import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isWpHardDenied,
  validateWpItemPath,
  WP_DEFAULT_IGNORE,
  WP_HARD_DENY_DIRS,
  WP_HARD_DENY_FILES,
} from '../wordpress/pathPolicy.js';
import {
  createFileSiteIgnoreRules,
  deniedReasonForSync,
  FILE_DEFAULT_IGNORE,
  FILE_SITE_AGENT_DIRS,
  FILE_SITE_AGENT_FILES,
  FILE_SITE_HARD_DENY_FILES,
  isFileSiteHardDenied,
  syncPathFolder,
  validateSyncPath,
} from './pathPolicy.js';

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../wordpress/vectors/${name}`, import.meta.url), 'utf8')) as T;

const vectors = read<{ paths: { path: string; ok: boolean; reason?: string }[] }>(
  'protocol-v1.json',
);
const agentFiles = read<{ files: { path: string; expect: string }[] }>('agent-files.json');

/** The two names a shared host needs on a plain site, and WordPress items never carry. */
const HOST_CONFIG = new Set(['php.ini', '.user.ini']);

function hasHostConfigSegment(path: string): boolean {
  return path
    .split('/')
    .some((segment) => HOST_CONFIG.has(segment.normalize('NFKC').toLowerCase()));
}

describe('the file-site hard deny list', () => {
  it.each([
    ['.htaccess', false],
    ['.user.ini', false],
    ['php.ini', false],
    ['public/PHP.INI', false],
    ['index.html', false],
    ['css/site.css', false],
    ['.well-known/acme-challenge/x', false],
    ['.env', true],
    ['.env.production', true],
    ['.git/config', true],
    ['.claude/settings.json', true],
    ['docs/AGENTS.md', true],
    ['CLAUDE.md', true],
    ['.mcp.json', true],
    ['id_rsa', true],
    ['keys/id_ed25519.pub', true],
    ['certs/x.pem', true],
    ['putty.PPK', true],
    ['.agentmateignore', true],
    ['.npmrc', true],
    ['.DS_Store', true],
    // Lookalikes a case-insensitive disk may fold into a denied name (the long s).
    ['.curſor/rules/r.mdc', true],
    ['AGENTſ.md', true],
  ])('%s denied: %s', (path, denied) => {
    expect(isFileSiteHardDenied(path)).toBe(denied);
  });

  it('works on a bare segment too', () => {
    expect(isFileSiteHardDenied('.git')).toBe(true);
    expect(isFileSiteHardDenied('php.ini')).toBe(false);
  });

  it('is the WordPress list minus php.ini and .user.ini, nothing else', () => {
    expect(FILE_SITE_HARD_DENY_FILES).toEqual(
      WP_HARD_DENY_FILES.filter((name) => !HOST_CONFIG.has(name)),
    );
    expect(FILE_SITE_HARD_DENY_FILES.length).toBe(WP_HARD_DENY_FILES.length - 2);
  });

  it('agrees with the WordPress list on every vector and fixture path but the host config', () => {
    const paths = [...vectors.paths.map((v) => v.path), ...agentFiles.files.map((f) => f.path)];
    for (const path of paths) {
      const expected = isWpHardDenied(path) && !hasHostConfigSegment(path);
      expect(isFileSiteHardDenied(path), path).toBe(expected);
    }
  });
});

describe('validateSyncPath', () => {
  it.each([
    ['', 'empty'],
    ['a/'.repeat(201), 'tooLong'],
    ['a\u0001b', 'controlChar'],
    ['a\\b', 'backslash'],
    ['/etc/passwd', 'absolute'],
    ['C:/x', 'driveLetter'],
    ['ab:c', 'colon'],
    ['a//b', 'emptySegment'],
    ['a/../b', 'traversal'],
    [`${'x'.repeat(201)}/a`, 'segmentTooLong'],
    ['a./b', 'trailingDotOrSpace'],
    ['con.txt', 'reservedName'],
    ['.env', 'hardDenied'],
    ['.claude/settings.json', 'hardDenied'],
  ])('%j is refused as %s', (path, reason) => {
    expect(validateSyncPath(path)).toEqual({ ok: false, reason });
  });

  it.each(['.htaccess', '.user.ini', 'php.ini', 'wp/php.ini', 'a b/ü.html'])(
    '%j is allowed',
    (path) => {
      expect(validateSyncPath(path)).toEqual({ ok: true });
    },
  );

  it('checks shape before the deny list, in the WordPress order', () => {
    // A denied name that is also broken reports the shape problem first.
    expect(validateSyncPath('.env/../x')).toEqual({ ok: false, reason: 'traversal' });
    expect(validateSyncPath('.git\\x')).toEqual({ ok: false, reason: 'backslash' });
  });

  it('gives the WordPress reason for every shared vector, except the host config files', () => {
    let flipped = 0;
    for (const vector of vectors.paths) {
      const wp = validateWpItemPath(vector.path);
      const ours = validateSyncPath(vector.path);
      if (!wp.ok && wp.reason === 'hardDenied' && hasHostConfigSegment(vector.path)) {
        expect(ours, vector.path).toEqual({ ok: true });
        flipped += 1;
      } else {
        expect(ours, vector.path).toEqual(wp);
      }
    }
    // php.ini and .user.ini are both in the vectors, so the exception is really exercised.
    expect(flipped).toBe(2);
  });
});

describe('deniedReasonForSync', () => {
  it.each([
    ['.claude/settings.json', 'agentFiles'],
    ['sub/.agentmate/x', 'agentFiles'],
    ['AGENTS.md', 'agentFiles'],
    ['.aider.chat.history.md', 'agentFiles'],
    ['.agentmateignore', 'agentFiles'],
    ['.curſor/rules/r.mdc', 'agentFiles'],
    ['.git/HEAD', 'hardDenied'],
    ['.env', 'hardDenied'],
    ['keys/id_rsa', 'hardDenied'],
    ['x.pem', 'hardDenied'],
    // The first denied segment decides.
    ['.git/.claude/x', 'hardDenied'],
    ['.claude/.env', 'agentFiles'],
  ])('%s is %s', (path, reason) => {
    expect(deniedReasonForSync(path)).toBe(reason);
  });

  it('skips the host config files when looking for the denied segment', () => {
    expect(deniedReasonForSync('php.ini/.claude/x')).toBe('agentFiles');
  });

  it('only names agent entries that are on the deny list', () => {
    for (const name of FILE_SITE_AGENT_DIRS) expect(WP_HARD_DENY_DIRS).toContain(name);
    for (const name of FILE_SITE_AGENT_FILES) expect(FILE_SITE_HARD_DENY_FILES).toContain(name);
  });
});

describe('FILE_DEFAULT_IGNORE', () => {
  it('is the WordPress default list without .distignore', () => {
    expect(FILE_DEFAULT_IGNORE).toEqual(WP_DEFAULT_IGNORE.filter((line) => line !== '.distignore'));
    expect(FILE_DEFAULT_IGNORE).not.toContain('.distignore');
  });

  it('leaves out local clutter until the server has it', () => {
    const built = createFileSiteIgnoreRules([]);
    if (!built.ok) throw new Error('should compile');
    const { rules } = built;
    expect(rules.excludedUnlessTracked('node_modules/x/index.js')).toBe(true);
    expect(rules.excludedUnlessTracked('logs/debug.log')).toBe(true);
    expect(rules.excludedUnlessTracked('.gitignore')).toBe(true);
    expect(rules.excludedUnlessTracked('skills/x.md')).toBe(true);
    expect(rules.excludedUnlessTracked('.distignore')).toBe(false);
    expect(rules.excludedUnlessTracked('index.html')).toBe(false);
    expect(rules.excluded('logs/debug.log')).toBe(false);
    expect(rules.canSkipFolder('node_modules')).toBe(true);
  });

  it("applies the site's own patterns both ways and puts defaults back with !", () => {
    const built = createFileSiteIgnoreRules([
      { source: '.agentmateignore', text: '!/skills/\n!keep.log\n' },
      { source: 'site patterns', text: 'drafts/\n*.psd\n' },
    ]);
    if (!built.ok) throw new Error('should compile');
    const { rules } = built;
    expect(rules.excludedUnlessTracked('skills/x.md')).toBe(false);
    expect(rules.excludedUnlessTracked('keep.log')).toBe(false);
    expect(rules.excludedUnlessTracked('other.log')).toBe(true);
    expect(rules.excluded('drafts/a.html')).toBe(true);
    expect(rules.excluded('img/hero.psd')).toBe(true);
    expect(rules.canSkipFolder('skills')).toBe(false);
  });

  it('reports a broken pattern with its source and line', () => {
    expect(createFileSiteIgnoreRules([{ source: 'site patterns', text: '[a' }])).toEqual({
      ok: false,
      source: 'site patterns',
      line: 1,
      reason: expect.stringContaining('never closed'),
    });
  });
});

describe('syncPathFolder', () => {
  it.each([
    ['index.html', ''],
    ['css/site.css', 'css'],
    ['a/b/c.txt', 'a/b'],
  ])('%s is in %j', (path, folder) => {
    expect(syncPathFolder(path)).toBe(folder);
  });
});
