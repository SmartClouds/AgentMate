import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WpItemRef } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import {
  deniedReason,
  hashFile,
  itemRootKind,
  type WpHashCache,
  walkLocalItem,
} from './localManifest';
import { WP_AGENT_FILES } from './testing/vectors';

/**
 * The walker against the shared agent-files fixture and the cases around it: only linked item
 * folders are read, nothing hard denied is ever in the result and every such path is reported,
 * the default ignore list gives way to tracked files, links are never followed, and the caps hold.
 */

let root: string;
const THEME = WP_AGENT_FILES.item as WpItemRef;
const THEME_ROOT = `wp-content/themes/${THEME.slug}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentmate-wp-walk-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, content = path): void {
  const full = join(root, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Symlinks need admin or developer mode on Windows; junctions do not. */
function link(target: string, path: string, folder: boolean): boolean {
  try {
    symlinkSync(target, join(root, ...path.split('/')), folder ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
}

describe('the shared agent-files fixture', () => {
  beforeEach(() => {
    for (const file of WP_AGENT_FILES.files) put(`${THEME_ROOT}/${file.path}`);
    // Agent files at the project root are never even looked at.
    put('AGENTS.md');
    put('.claude/settings.json');
    put('.agentmate/wordpress/conflicts/x/style.css');
  });

  it('sends what is synced, and never anything hard denied or ignored', async () => {
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    const sent = Object.keys(walk.files).sort();
    const synced = WP_AGENT_FILES.files
      .filter((file) => file.expect === 'synced')
      .map((file) => file.path)
      .sort();
    expect(sent).toEqual(synced);
    expect(walk.exists).toBe(true);
    expect(walk.files['style.css']).toEqual({
      sha256: sha(`${THEME_ROOT}/style.css`),
      size: `${THEME_ROOT}/style.css`.length,
    });
  });

  it('reports every hard denied path, with agent files told apart', async () => {
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    const reported = new Map(walk.leftOut.map((entry) => [entry.path, entry.reason]));
    for (const file of WP_AGENT_FILES.files.filter((entry) => entry.expect === 'hardDenied')) {
      expect(reported.get(file.path), file.path).toBe(deniedReason(file.path));
    }
    expect(reported.get('.claude/settings.json')).toBe('agentFiles');
    expect(reported.get('.agentmate/hooks/notify.sh')).toBe('agentFiles');
    expect(reported.get('AGENTS.md')).toBe('agentFiles');
    expect(reported.get('.mcp.json')).toBe('agentFiles');
    expect(reported.get('.git/HEAD')).toBe('hardDenied');
    expect(reported.get('.env.local')).toBe('hardDenied');
    expect(reported.get('inc/.DS_Store')).toBe('hardDenied');
    expect(walk.leftOut.every((entry) => entry.item === THEME)).toBe(true);
  });

  it('reports what the default list leaves out, as files or whole folders', async () => {
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    const ignored = walk.leftOut.filter((entry) => entry.reason === 'ignored').map((e) => e.path);
    expect(ignored.sort()).toEqual(
      [
        '.gitignore',
        '.vscode/',
        'agents/',
        'assets/node_modules/',
        'debug.log',
        'node_modules/',
        'skills/',
      ].sort(),
    );
  });

  it('keeps a default-ignored file the site or the last sync already has', async () => {
    const walk = await walkLocalItem({
      projectRoot: root,
      item: THEME,
      isFile: false,
      tracked: new Set(['skills/z/SKILL.md', 'debug.log', '.claude/settings.json']),
    });
    expect(walk.files['skills/z/SKILL.md']).toBeDefined();
    expect(walk.files['debug.log']).toBeDefined();
    // Tracked or not, a hard denied path never goes.
    expect(walk.files['.claude/settings.json']).toBeUndefined();
    expect(walk.files['agents/a.md']).toBeUndefined();
  });
});

describe('ignore layers', () => {
  it('applies .distignore and both .agentmateignore files, with ! putting things back', async () => {
    put(`${THEME_ROOT}/style.css`);
    put(`${THEME_ROOT}/src/app.ts`);
    put(`${THEME_ROOT}/notes.txt`);
    put(`${THEME_ROOT}/build/keep.js`);
    put(`${THEME_ROOT}/debug.log`);
    put(`${THEME_ROOT}/.distignore`, 'src/\n# comment\n');
    put('.agentmateignore', 'notes.txt\n!debug.log\n');
    put(`${THEME_ROOT}/.agentmateignore`, 'build/\n');
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(Object.keys(walk.files).sort()).toEqual(['debug.log', 'style.css']);
    const reasons = Object.fromEntries(walk.leftOut.map((entry) => [entry.path, entry.reason]));
    // A `!` line could put back something inside any folder, so folders are walked and their
    // files reported one by one.
    expect(reasons).toMatchObject({
      'src/app.ts': 'ignored',
      'notes.txt': 'ignored',
      'build/keep.js': 'ignored',
      '.distignore': 'ignored',
      '.agentmateignore': 'agentFiles',
    });
    expect(walk.rules.excluded('src/app.ts')).toBe(true);
  });

  it('drops ! lines from a .distignore, which can come from the site', async () => {
    put(`${THEME_ROOT}/style.css`);
    put(`${THEME_ROOT}/debug.log`);
    put(`${THEME_ROOT}/node_modules/x/index.js`);
    put(`${THEME_ROOT}/.distignore`, '!debug.log\n!node_modules/\nsrc/\n');
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(walk.files['debug.log']).toBeUndefined();
    expect(walk.files['node_modules/x/index.js']).toBeUndefined();
    expect(walk.rules.excluded('src/a.ts')).toBe(true);
    // The same line in the user's own .agentmateignore does put it back.
    put('.agentmateignore', '!debug.log\n');
    const own = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(own.files['debug.log']).toBeDefined();
  });

  it('says which ignore line it cannot read', async () => {
    put(`${THEME_ROOT}/style.css`);
    put('.agentmateignore', 'ok\n[z-a]\n');
    const error = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false }).catch(
      (caught) => caught,
    );
    expect(wordPressErrorCode(error)).toBe('badRequest');
    expect(error.message).toContain('Line 2 of .agentmateignore');
  });

  it('does not read a linked or oversized ignore file', async () => {
    put(`${THEME_ROOT}/style.css`);
    put(`${THEME_ROOT}/notes.txt`);
    put('outside.txt', 'notes.txt\n');
    put('.agentmateignore', `${'#'.repeat(300 * 1024)}\nstyle.css\n`);
    const linked = link(join(root, 'outside.txt'), `${THEME_ROOT}/.agentmateignore`, false);
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(walk.files['style.css']).toBeDefined();
    if (linked) expect(walk.files['notes.txt']).toBeDefined();
  });
});

describe('what git ignores', () => {
  const FOO: WpItemRef = { kind: 'theme', slug: 'foo' };
  const FOO_ROOT = 'wp-content/themes/foo';

  beforeEach(() => {
    put(`${FOO_ROOT}/style.css`);
    put(`${FOO_ROOT}/inc/a.php`);
  });

  it("leaves out what the item's own .gitignore names, and says so", async () => {
    put(`${FOO_ROOT}/dist/app.js`);
    put(`${FOO_ROOT}/assets/app.css.map`);
    put(`${FOO_ROOT}/.gitignore`, '/dist/\n*.map\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(Object.keys(walk.files).sort()).toEqual(['inc/a.php', 'style.css']);
    const ignored = walk.leftOut.filter((entry) => entry.reason === 'ignored').map((e) => e.path);
    expect(ignored.sort()).toEqual(['.gitignore', 'assets/app.css.map', 'dist/']);
  });

  it("leaves out what the project's .gitignore names, whether it is anchored or not", async () => {
    put(`${FOO_ROOT}/vendor/lib/x.php`);
    put(`${FOO_ROOT}/build/out.js`);
    put(`${FOO_ROOT}/inc/vendor/y.php`);
    put(`${FOO_ROOT}/pack.zip`);
    put('.gitignore', 'vendor/\n/wp-content/themes/foo/build/\n*.zip\n/wp-content/uploads/\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(Object.keys(walk.files).sort()).toEqual(['inc/a.php', 'style.css']);
  });

  it('keeps a theme the project .gitignore whitelists out of a folder it ignores', async () => {
    put('.gitignore', '/wp-content/themes/*\n!/wp-content/themes/foo\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(Object.keys(walk.files).sort()).toEqual(['inc/a.php', 'style.css']);
  });

  it('does not use a project .gitignore that ignores the whole item folder', async () => {
    put('.gitignore', '/wp-content/themes/foo/\n*.php\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(Object.keys(walk.files).sort()).toEqual(['inc/a.php', 'style.css']);
  });

  it('keeps a git-ignored file the site or the last sync already has', async () => {
    put(`${FOO_ROOT}/vendor/lib.php`);
    put(`${FOO_ROOT}/.gitignore`, 'vendor/\n');
    const fresh = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(fresh.files['vendor/lib.php']).toBeUndefined();
    const tracked = await walkLocalItem({
      projectRoot: root,
      item: FOO,
      isFile: false,
      tracked: new Set(['vendor/lib.php']),
    });
    expect(tracked.files['vendor/lib.php']).toBeDefined();
  });

  it("lets the user's .agentmateignore put a git-ignored file back, but not a built-in default", async () => {
    put(`${FOO_ROOT}/dist/app.js`);
    put(`${FOO_ROOT}/node_modules/x/index.js`);
    put(`${FOO_ROOT}/.gitignore`, 'dist/\n!node_modules/\n');
    put(`${FOO_ROOT}/.agentmateignore`, '!dist/\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(walk.files['dist/app.js']).toBeDefined();
    expect(walk.files['node_modules/x/index.js']).toBeUndefined();
  });

  it('does not stop on a .gitignore line it cannot read', async () => {
    put(`${FOO_ROOT}/dist/app.js`);
    put(`${FOO_ROOT}/.gitignore`, '[z-a]\ndist/\n');
    put('.gitignore', '[a\n');
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(walk.files['dist/app.js']).toBeUndefined();
    expect(walk.files['style.css']).toBeDefined();
  });

  it('does not read a .gitignore that is a link or too big', async () => {
    put(`${FOO_ROOT}/dist/app.js`);
    put(`${FOO_ROOT}/pack.zip`);
    put('.gitignore', `${'#'.repeat(300 * 1024)}\n*.zip\n`);
    put('outside.txt', 'dist/\n');
    const linked = link(join(root, 'outside.txt'), `${FOO_ROOT}/.gitignore`, false);
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(walk.files['pack.zip']).toBeDefined();
    if (linked) expect(walk.files['dist/app.js']).toBeDefined();
  });
});

describe('the saved ignore list', () => {
  const FOO: WpItemRef = { kind: 'theme', slug: 'foo' };
  const FOO_ROOT = 'wp-content/themes/foo';

  beforeEach(() => {
    put(`${FOO_ROOT}/style.css`);
    put(`${FOO_ROOT}/src/app.ts`);
    put(`${FOO_ROOT}/assets/app.css.map`);
    put(`${FOO_ROOT}/inc/src/keep.php`);
    put(`${FOO_ROOT}/debug.log`);
  });

  it('leaves files and folders out, and reports each one', async () => {
    const walk = await walkLocalItem({
      projectRoot: root,
      item: FOO,
      isFile: false,
      savedIgnore: ['*.map', '/src/'],
    });
    expect(Object.keys(walk.files).sort()).toEqual(['inc/src/keep.php', 'style.css']);
    const reasons = Object.fromEntries(walk.leftOut.map((entry) => [entry.path, entry.reason]));
    expect(reasons['src/']).toBe('ignored');
    expect(reasons['assets/app.css.map']).toBe('ignored');
    expect(walk.rules.excluded('src/app.ts')).toBe(true);
    expect(walk.rules.excluded('inc/src/keep.php')).toBe(false);
  });

  it('leaves a file out even when the site already has it', async () => {
    const walk = await walkLocalItem({
      projectRoot: root,
      item: FOO,
      isFile: false,
      tracked: new Set(['src/app.ts']),
      savedIgnore: ['/src/'],
    });
    expect(walk.files['src/app.ts']).toBeUndefined();
  });

  it('can put a default back with a ! line', async () => {
    const walk = await walkLocalItem({
      projectRoot: root,
      item: FOO,
      isFile: false,
      savedIgnore: ['!debug.log'],
    });
    expect(walk.files['debug.log']).toBeDefined();
  });

  it('says that the saved list is wrong when a line cannot be read', async () => {
    const error = await walkLocalItem({
      projectRoot: root,
      item: FOO,
      isFile: false,
      savedIgnore: ['/ok/', '[z-a]'],
    }).catch((caught) => caught);
    expect(wordPressErrorCode(error)).toBe('badRequest');
    expect(error.message).toContain('Line 2 of the saved ignore list');
  });

  it('leaves a single-file plugin out when its name is on the list', async () => {
    put('wp-content/plugins/hello.php');
    const walk = await walkLocalItem({
      projectRoot: root,
      item: { kind: 'plugin', slug: 'hello.php' },
      isFile: true,
      savedIgnore: ['/hello.php'],
    });
    expect(walk.files).toEqual({});
    expect(walk.leftOut).toEqual([
      { item: { kind: 'plugin', slug: 'hello.php' }, path: 'hello.php', reason: 'ignored' },
    ]);
  });
});

describe('agent folders by prefix', () => {
  const FOO: WpItemRef = { kind: 'theme', slug: 'foo' };
  const FOO_ROOT = 'wp-content/themes/foo';

  it('never sends a folder or file that starts with .claude or .agentmate', async () => {
    put(`${FOO_ROOT}/style.css`);
    put(`${FOO_ROOT}/.claude-plugin/plugin.json`);
    put(`${FOO_ROOT}/inc/.agentmate-cache/a.json`);
    put(`${FOO_ROOT}/.claudeignore`);
    const walk = await walkLocalItem({ projectRoot: root, item: FOO, isFile: false });
    expect(Object.keys(walk.files)).toEqual(['style.css']);
    const reasons = Object.fromEntries(walk.leftOut.map((entry) => [entry.path, entry.reason]));
    expect(reasons).toMatchObject({
      '.claude-plugin/plugin.json': 'agentFiles',
      'inc/.agentmate-cache/a.json': 'agentFiles',
      '.claudeignore': 'agentFiles',
    });
  });

  it('classes them as agent files', () => {
    expect(deniedReason('.claude-plugin/plugin.json')).toBe('agentFiles');
    expect(deniedReason('a/.agentmate.old/x')).toBe('agentFiles');
  });
});

describe('links, caps and odd names', () => {
  it('never follows a link inside an item, and refuses a linked item folder', async () => {
    put(`${THEME_ROOT}/style.css`);
    put('secrets/id.txt', 'secret');
    if (!link(join(root, 'secrets'), `${THEME_ROOT}/leak`, true)) return;
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(Object.keys(walk.files)).toEqual(['style.css']);
    expect(walk.leftOut).toContainEqual({ item: THEME, path: 'leak', reason: 'symlink' });

    const plugin: WpItemRef = { kind: 'plugin', slug: 'linked' };
    mkdirSync(join(root, 'wp-content', 'plugins'), { recursive: true });
    link(join(root, 'secrets'), 'wp-content/plugins/linked', true);
    const error = await walkLocalItem({ projectRoot: root, item: plugin, isFile: false }).catch(
      (caught) => caught,
    );
    expect(wordPressErrorCode(error)).toBe('pathRejected');
    expect(error.message).toContain('wp-content/plugins/linked is a link');
  });

  it('refuses a linked wp-content folder', async () => {
    put('real/themes/x/style.css');
    if (!link(join(root, 'real'), 'wp-content', true)) return;
    await expect(itemRootKind(root, { kind: 'theme', slug: 'x' })).rejects.toThrow(
      'wp-content is a link',
    );
  });

  it('leaves out files too large, and stops at too many files', async () => {
    put(`${THEME_ROOT}/big.bin`, 'x'.repeat(50));
    put(`${THEME_ROOT}/a.css`);
    put(`${THEME_ROOT}/b.css`);
    const walk = await walkLocalItem({
      projectRoot: root,
      item: THEME,
      isFile: false,
      maxFileBytes: 40,
    });
    expect(walk.leftOut).toContainEqual({ item: THEME, path: 'big.bin', reason: 'tooLarge' });
    const error = await walkLocalItem({
      projectRoot: root,
      item: THEME,
      isFile: false,
      maxFiles: 2,
    }).catch((caught) => caught);
    expect(wordPressErrorCode(error)).toBe('tooLarge');
  });

  it('leaves out names the site would refuse', async () => {
    put(`${THEME_ROOT}/style.css`);
    put(`${THEME_ROOT}/trailing./x.css`);
    put(`${THEME_ROOT}/aux.php`);
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    const reasons = Object.fromEntries(walk.leftOut.map((entry) => [entry.path, entry.reason]));
    if (process.platform !== 'win32') expect(reasons['trailing./']).toBe('pathRejected');
    expect(Object.keys(walk.files)).not.toContain('aux.php');
  });

  it('reports a big denied folder once', async () => {
    for (let index = 0; index < 120; index++) put(`${THEME_ROOT}/.git/objects/${index}`);
    put(`${THEME_ROOT}/.claude/empty/.keep`);
    mkdirSync(join(root, THEME_ROOT, '.cursor'));
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(walk.leftOut.filter((entry) => entry.path.startsWith('.git'))).toEqual([
      { item: THEME, path: '.git/', reason: 'hardDenied' },
    ]);
    expect(walk.leftOut).toContainEqual({ item: THEME, path: '.cursor/', reason: 'agentFiles' });
  });

  it('leaves out names that differ only by case', async () => {
    put(`${THEME_ROOT}/style.css`);
    const files = {
      'style.css': { sha256: 'a'.repeat(64), size: 1 },
      'Style.css': { sha256: 'b'.repeat(64), size: 1 },
    };
    // A case-insensitive disk cannot hold both, so the collision is checked on its own.
    const { findWpCaseCollisions } = await import('@agentmat/core');
    expect(findWpCaseCollisions(Object.keys(files))).toEqual([['style.css', 'Style.css']]);
    if (process.platform === 'linux') {
      put(`${THEME_ROOT}/Style.css`);
      const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
      expect(walk.leftOut.filter((entry) => entry.reason === 'caseCollision')).toHaveLength(2);
    }
  });
});

describe('items that are missing or single files', () => {
  it('reports a missing item as not there', async () => {
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(walk).toMatchObject({ exists: false, files: {}, leftOut: [] });
    put('wp-content/themes');
    expect(await itemRootKind(root, THEME)).toBeNull();
  });

  it('walks a single-file plugin by its own name', async () => {
    const hello: WpItemRef = { kind: 'plugin', slug: 'hello.php' };
    put('wp-content/plugins/hello.php', '<?php');
    const walk = await walkLocalItem({ projectRoot: root, item: hello, isFile: true });
    expect(walk.files).toEqual({ 'hello.php': { sha256: sha('<?php'), size: 5 } });

    expect(
      (await walkLocalItem({ projectRoot: root, item: hello, isFile: true, maxFileBytes: 2 }))
        .leftOut,
    ).toEqual([{ item: hello, path: 'hello.php', reason: 'tooLarge' }]);

    put('.agentmateignore', 'hello.php\n');
    expect(
      (await walkLocalItem({ projectRoot: root, item: hello, isFile: true })).leftOut[0].reason,
    ).toBe('ignored');

    const folderItem = await walkLocalItem({ projectRoot: root, item: THEME, isFile: true });
    expect(folderItem.exists).toBe(false);
    put(`${THEME_ROOT}/style.css`);
    expect((await walkLocalItem({ projectRoot: root, item: THEME, isFile: true })).exists).toBe(
      false,
    );
    expect((await walkLocalItem({ projectRoot: root, item: hello, isFile: false })).exists).toBe(
      false,
    );
  });
});

describe('hashFile', () => {
  it('reuses a hash while size and time are unchanged', async () => {
    put('a.txt', 'one');
    const cache: WpHashCache = new Map();
    const path = join(root, 'a.txt');
    expect(await hashFile(path, 3, 1, cache)).toBe(sha('one'));
    put('a.txt', 'two');
    expect(await hashFile(path, 3, 1, cache)).toBe(sha('one'));
    expect(await hashFile(path, 3, 2, cache)).toBe(sha('two'));
  });

  it('classes lookalike names and credential files', async () => {
    const longS = String.fromCharCode(0x17f);
    expect(deniedReason(`.cur${longS}or/rules.md`)).toBe('agentFiles');
    expect(deniedReason(`CLAUDE.md`)).toBe('agentFiles');
    for (const name of ['.npmrc', 'auth.json', '.netrc', '.git-credentials']) {
      expect(deniedReason(name), name).toBe('hardDenied');
      put(`${THEME_ROOT}/${name}`);
    }
    put(`${THEME_ROOT}/style.css`);
    const walk = await walkLocalItem({ projectRoot: root, item: THEME, isFile: false });
    expect(Object.keys(walk.files)).toEqual(['style.css']);
    expect(walk.leftOut.map((entry) => entry.reason)).toEqual([
      'hardDenied',
      'hardDenied',
      'hardDenied',
      'hardDenied',
    ]);
  });

  it('classifies denied paths', () => {
    expect(deniedReason('.aider.chat.history.md')).toBe('agentFiles');
    expect(deniedReason('a/id_rsa')).toBe('hardDenied');
    expect(deniedReason('nothing/denied')).toBe('hardDenied');
  });
});
