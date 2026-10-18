import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BaseMap, findWpCaseCollisions } from '@agentmat/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../../shared/deployFilesErrors';
import { tempDir, writeTree } from '../../../test/main/fixtures';
import type { HashCache } from '../hashFile';
import { seedHashCache, walkSiteFolder } from './localWalk';

/**
 * The walk of an FTP or SFTP site's deploy folder: what goes is hashed, everything left out is
 * reported with its reason, the default ignore list gives way to tracked files, links are never
 * followed, the caps hold, and the hash cache keeps unchanged files from being read again.
 */

let root: string;

beforeEach(() => {
  root = tempDir('agentmate-files-walk-');
});

function put(files: Record<string, string>): void {
  writeTree(root, files);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function reasons(walk: { leftOut: { path: string; reason: string }[] }): Record<string, string> {
  return Object.fromEntries(walk.leftOut.map((entry) => [entry.path, entry.reason]));
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

describe('a plain static site', () => {
  it('sends every file with its hash, size and time, and lists the folders that hold them', async () => {
    put({
      'index.html': '<h1>hi</h1>',
      'css/site.css': 'body{}',
      'assets/fonts/a.woff2': 'font',
      'img/logo.svg': '<svg/>',
    });
    mkdirSync(join(root, 'empty'));
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(walk.exists).toBe(true);
    expect(Object.keys(walk.files).sort()).toEqual([
      'assets/fonts/a.woff2',
      'css/site.css',
      'img/logo.svg',
      'index.html',
    ]);
    expect(walk.files['index.html']).toEqual({
      sha256: sha('<h1>hi</h1>'),
      size: 11,
      mtimeMs: statSync(join(root, 'index.html')).mtimeMs,
    });
    expect(walk.dirs).toEqual(['assets', 'assets/fonts', 'css', 'img']);
    expect(walk.leftOut).toEqual([]);
  });

  it('sends the host config files a shared host reads', async () => {
    put({
      '.htaccess': 'RewriteEngine On',
      '.user.ini': 'x=1',
      'php.ini': 'y=2',
      'a/.htaccess': '',
    });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files).sort()).toEqual([
      '.htaccess',
      '.user.ini',
      'a/.htaccess',
      'php.ini',
    ]);
  });
});

describe('the hard deny list', () => {
  it('leaves agent files, version control and secrets out, and tells agent files apart', async () => {
    put({
      'index.html': 'x',
      '.claude/settings.json': '{}',
      '.git/HEAD': 'ref',
      '.env': 'SECRET=1',
      'AGENTS.md': '# agents',
      'docs/CLAUDE.md': '# claude',
      '.agentmateignore': '# nothing\n',
      'keys/id_rsa': 'key',
    });
    const walk = await walkSiteFolder({
      root,
      ignorePatterns: [],
      // Tracked or not, a hard denied path never goes.
      tracked: new Set(['.env', '.claude/settings.json']),
    });
    expect(Object.keys(walk.files)).toEqual(['index.html']);
    expect(reasons(walk)).toEqual({
      '.agentmateignore': 'agentFiles',
      '.claude/settings.json': 'agentFiles',
      '.env': 'hardDenied',
      '.git/HEAD': 'hardDenied',
      'AGENTS.md': 'agentFiles',
      'docs/CLAUDE.md': 'agentFiles',
      'keys/id_rsa': 'hardDenied',
    });
    expect(walk.dirs).toEqual([]);
  });

  it('reports a big denied folder once, and an empty one as a folder', async () => {
    const objects: Record<string, string> = { 'index.html': 'x' };
    for (let index = 0; index < 120; index++) objects[`.git/objects/${index}`] = 'o';
    put(objects);
    mkdirSync(join(root, '.cursor'));
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(walk.leftOut).toEqual([
      { path: '.cursor/', reason: 'agentFiles' },
      { path: '.git/', reason: 'hardDenied' },
    ]);
  });

  it('leaves out names the server could refuse', async () => {
    const long = 'é'.repeat(110);
    put({ 'index.html': 'x', [`${long}.html`]: 'x', [`${long}/a.css`]: 'x' });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files)).toEqual(['index.html']);
    expect(reasons(walk)).toEqual({ [`${long}.html`]: 'invalidPath', [`${long}/`]: 'invalidPath' });
  });
});

describe('ignore layers', () => {
  it('leaves the default list out, as whole folders when nothing can put them back', async () => {
    put({
      'index.html': 'x',
      'node_modules/x/index.js': 'x',
      '.vscode/settings.json': '{}',
      'debug.log': 'log',
      'skills/a.md': 'a',
      'blog/skills/b.md': 'b',
    });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files).sort()).toEqual(['blog/skills/b.md', 'index.html']);
    expect(reasons(walk)).toEqual({
      '.vscode/': 'ignored',
      'debug.log': 'ignored',
      'node_modules/': 'ignored',
      'skills/': 'ignored',
    });
  });

  it('keeps a default-ignored file the last deploy already sent', async () => {
    put({ 'index.html': 'x', 'node_modules/x/index.js': 'x', 'node_modules/y/index.js': 'y' });
    const walk = await walkSiteFolder({
      root,
      ignorePatterns: [],
      tracked: new Set(['node_modules/x/index.js']),
    });
    expect(Object.keys(walk.files).sort()).toEqual(['index.html', 'node_modules/x/index.js']);
    // A folder the base has nothing in is left out whole.
    expect(reasons(walk)).toEqual({ 'node_modules/y/': 'ignored' });
    expect(walk.dirs).toEqual(['node_modules', 'node_modules/x']);
  });

  it('applies the folder .agentmateignore, with ! putting a default back', async () => {
    put({
      'index.html': 'x',
      'drafts/post.html': 'x',
      'notes.txt': 'x',
      'debug.log': 'log',
      '.agentmateignore': 'drafts/\nnotes.txt\n!debug.log\n',
    });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files).sort()).toEqual(['debug.log', 'index.html']);
    // A `!` line could put back something inside any folder, so folders are walked and their
    // files reported one by one.
    expect(reasons(walk)).toEqual({
      '.agentmateignore': 'agentFiles',
      'drafts/post.html': 'ignored',
      'notes.txt': 'ignored',
    });
  });

  it('applies the site patterns after the folder file, so they have the last word', async () => {
    put({
      'index.html': 'x',
      'art/cover.psd': 'x',
      'private/a.html': 'x',
      'blog/private/b.html': 'x',
      'notes.txt': 'x',
      '.agentmateignore': 'notes.txt\n',
    });
    const walk = await walkSiteFolder({
      root,
      ignorePatterns: ['*.psd', '/private/', '!notes.txt'],
    });
    expect(Object.keys(walk.files).sort()).toEqual([
      'blog/private/b.html',
      'index.html',
      'notes.txt',
    ]);
    expect(reasons(walk)).toMatchObject({
      'art/cover.psd': 'ignored',
      'private/a.html': 'ignored',
    });
  });

  it('says which ignore line it cannot read', async () => {
    put({ 'index.html': 'x', '.agentmateignore': 'ok\n[z-a]\n' });
    const error = await walkSiteFolder({ root, ignorePatterns: [] }).catch((caught) => caught);
    expect(filesErrorCode(error)).toBe('invalidInput');
    expect(error.message).toContain('Line 2 of .agentmateignore');

    put({ '.agentmateignore': '' });
    const fromSite = await walkSiteFolder({ root, ignorePatterns: ['a', 'b', '[z-a]'] }).catch(
      (caught) => caught,
    );
    expect(filesErrorCode(fromSite)).toBe('invalidInput');
    expect(fromSite.message).toContain('Line 3 of site settings');
  });

  it('does not read a linked or oversized .agentmateignore', async () => {
    put({
      'index.html': 'x',
      'notes.txt': 'x',
      '.agentmateignore': `${'#'.repeat(300 * 1024)}\nindex.html\n`,
    });
    expect((await walkSiteFolder({ root, ignorePatterns: [] })).files['index.html']).toBeDefined();
    const outside = tempDir('agentmate-files-outside-');
    writeFileSync(join(outside, 'rules'), 'notes.txt\n');
    rmSync(join(root, '.agentmateignore'));
    if (!link(join(outside, 'rules'), '.agentmateignore', false)) return;
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(walk.files['notes.txt']).toBeDefined();
  });
});

describe('links, caps and odd names', () => {
  it('never follows a link or sends one', async () => {
    put({ 'index.html': 'x' });
    const outside = tempDir('agentmate-files-outside-');
    writeTree(outside, { 'id.txt': 'secret' });
    if (!link(outside, 'leak', true)) return;
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files)).toEqual(['index.html']);
    expect(walk.leftOut).toEqual([{ path: 'leak', reason: 'symlink' }]);
  });

  it('leaves out names that differ only by case', async () => {
    // A case-insensitive disk cannot hold both, so the collision is checked on its own too.
    expect(findWpCaseCollisions(['a.css', 'A.css', 'b.css'])).toEqual([['a.css', 'A.css']]);
    if (process.platform !== 'linux') return;
    put({ 'index.html': 'x', 'css/site.css': 'a', 'css/Site.css': 'b' });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files)).toEqual(['index.html']);
    expect(walk.leftOut).toEqual([
      { path: 'css/Site.css', reason: 'caseCollision' },
      { path: 'css/site.css', reason: 'caseCollision' },
    ]);
    expect(walk.dirs).toEqual([]);
  });

  it('leaves out a file too large', async () => {
    put({ 'big.bin': 'x'.repeat(50), 'a.css': 'a' });
    const walk = await walkSiteFolder({ root, ignorePatterns: [], maxFileBytes: 40 });
    expect(Object.keys(walk.files)).toEqual(['a.css']);
    expect(walk.leftOut).toEqual([{ path: 'big.bin', reason: 'tooLarge' }]);
  });

  it('stops at too many files', async () => {
    put({ 'a.css': 'a', 'b.css': 'b', 'c/d.css': 'd' });
    const error = await walkSiteFolder({ root, ignorePatterns: [], maxFiles: 2 }).catch(
      (caught) => caught,
    );
    expect(filesErrorCode(error)).toBe('tooManyFiles');
    expect(error.message).toContain('more than 2 files');
    // Files left out do not count.
    put({ 'node_modules/a.js': 'a', 'node_modules/b.js': 'b' });
    const ok = await walkSiteFolder({ root, ignorePatterns: [], maxFiles: 3 });
    expect(Object.keys(ok.files)).toHaveLength(3);
  });

  it('leaves out a name that is not UTF-8', async () => {
    // Only Linux lets a file name hold bytes that are not UTF-8.
    if (process.platform !== 'linux') return;
    put({ 'index.html': 'x' });
    writeFileSync(
      Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0x66, 0xff, 0x2e, 0x68])]),
      'x',
    );
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(Object.keys(walk.files)).toEqual(['index.html']);
    expect(walk.leftOut).toEqual([{ path: 'f\ufffd.h', reason: 'notUtf8' }]);
  });

  it('gives the left-out list in path order', async () => {
    put({ 'z.log': 'x', 'a/.env': 'x', 'm/debug.log': 'x', '.env': 'x', 'index.html': 'x' });
    const walk = await walkSiteFolder({ root, ignorePatterns: [] });
    expect(walk.leftOut.map((entry) => entry.path)).toEqual([
      '.env',
      'a/.env',
      'm/debug.log',
      'z.log',
    ]);
  });
});

describe('a deploy folder that is not there', () => {
  it('reports a missing folder or a file in its place as not there', async () => {
    const missing = await walkSiteFolder({ root: join(root, 'gone'), ignorePatterns: [] });
    expect(missing).toEqual({ exists: false, files: {}, leftOut: [], dirs: [] });
    put({ 'file.txt': 'x' });
    const file = await walkSiteFolder({ root: join(root, 'file.txt'), ignorePatterns: [] });
    expect(file.exists).toBe(false);
  });
});

describe('the hash cache', () => {
  it('reuses the hash the last deploy recorded while size and time are unchanged', async () => {
    put({ 'index.html': 'hello', 'a.css': 'a' });
    const info = statSync(join(root, 'index.html'));
    const base: BaseMap = {
      'index.html': { sha256: 'f'.repeat(64), size: 5, localMtimeMs: info.mtimeMs, remote: null },
      'gone.css': { sha256: 'e'.repeat(64), size: 1, localMtimeMs: 1, remote: null },
    };
    const hashes = seedHashCache(base);
    expect(hashes.get('index.html')).toEqual({
      size: 5,
      mtimeMs: info.mtimeMs,
      sha256: 'f'.repeat(64),
    });
    const walk = await walkSiteFolder({ root, ignorePatterns: [], hashes });
    // The seeded value stands in for a fresh read, which is how a skipped hash shows.
    expect(walk.files['index.html'].sha256).toBe('f'.repeat(64));
    expect(walk.files['a.css'].sha256).toBe(sha('a'));
    expect(hashes.get('a.css')?.sha256).toBe(sha('a'));

    const later = new Date(info.mtimeMs + 5000);
    utimesSync(join(root, 'index.html'), later, later);
    const again = await walkSiteFolder({ root, ignorePatterns: [], hashes });
    expect(again.files['index.html'].sha256).toBe(sha('hello'));
    expect(again.files['index.html'].mtimeMs).toBe(statSync(join(root, 'index.html')).mtimeMs);
  });

  it('forgets files that are no longer sent', async () => {
    put({ 'a.css': 'a', 'b.css': 'b' });
    const hashes: HashCache = new Map();
    await walkSiteFolder({ root, ignorePatterns: [], hashes });
    expect([...hashes.keys()].sort()).toEqual(['a.css', 'b.css']);
    await walkSiteFolder({ root, ignorePatterns: ['b.css'], hashes });
    expect([...hashes.keys()]).toEqual(['a.css']);
  });
});

describe('cancel', () => {
  it('stops when the signal is aborted', async () => {
    put({ 'index.html': 'x', 'a/b.css': 'b' });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      walkSiteFolder({ root, ignorePatterns: [], signal: controller.signal }),
    ).rejects.toThrow('stop');
  });

  it('stops part way through a walk', async () => {
    const tree: Record<string, string> = {};
    for (let index = 0; index < 30; index++) tree[`d${index}/f.css`] = 'x';
    put(tree);
    const controller = new AbortController();
    const hashes: HashCache = new Map();
    // A cache whose first write aborts the walk: the next folder must not be read.
    const set = hashes.set.bind(hashes);
    hashes.set = (key, value) => {
      controller.abort(new Error('stop'));
      return set(key, value);
    };
    await expect(
      walkSiteFolder({ root, ignorePatterns: [], hashes, signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(hashes.size).toBe(1);
  });
});
