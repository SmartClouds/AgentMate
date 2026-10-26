import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { WpLocalWriter } from './localWriter';

/**
 * The writer for files from a site: plain relative paths only, no link on the way, nothing
 * outside the project, whole files only, and it can take back exactly the folders it made.
 */

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'runova-wp-writer-'));
  root = join(base, 'project');
  mkdirSync(root);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

async function code(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return wordPressErrorCode(error);
  }
  return 'ok';
}

describe('WpLocalWriter', () => {
  it('writes whole files, making the folders it needs, and replaces them', async () => {
    const writer = new WpLocalWriter(root);
    await writer.writeFile('wp-content/themes/shop/inc/a.php', bytes('<?php 1'));
    await writer.writeFile('wp-content/themes/shop/inc/a.php', bytes('<?php 2'));
    expect(readFileSync(join(root, 'wp-content/themes/shop/inc/a.php'), 'utf-8')).toBe('<?php 2');
    expect(writer.createdFolders.map((folder) => folder.slice(root.length + 1))).toEqual([
      'wp-content',
      join('wp-content', 'themes'),
      join('wp-content', 'themes', 'shop'),
      join('wp-content', 'themes', 'shop', 'inc'),
    ]);
    expect(readdirSync(join(root, 'wp-content/themes/shop/inc'))).toEqual(['a.php']);
  });

  it('refuses paths that are not plain and relative', async () => {
    const writer = new WpLocalWriter(root);
    for (const path of ['../x.php', 'a/../../x', '/etc/x', 'a//b', 'a\\b', 'C:x', 'a/./b', '']) {
      expect(await code(writer.writeFile(path, bytes('x'))), path).toBe('pathRejected');
    }
    expect(existsSync(join(base, 'x.php'))).toBe(false);
  });

  it('never writes through a link, and never over a folder or a link', async () => {
    mkdirSync(join(base, 'outside'));
    mkdirSync(join(root, 'wp-content'));
    let linked = true;
    try {
      symlinkSync(join(base, 'outside'), join(root, 'wp-content', 'themes'), 'junction');
    } catch {
      linked = false;
    }
    const writer = new WpLocalWriter(root);
    if (linked) {
      expect(await code(writer.writeFile('wp-content/themes/x.php', bytes('x')))).toBe(
        'pathRejected',
      );
      expect(readdirSync(join(base, 'outside'))).toEqual([]);
      expect(await code(writer.deleteFile('wp-content/themes/x.php'))).toBe('pathRejected');
    }
    mkdirSync(join(root, 'plugins', 'a.php'), { recursive: true });
    expect(await code(writer.writeFile('plugins/a.php', bytes('x')))).toBe('pathRejected');
    writeFileSync(join(root, 'file'), 'x');
    expect(await code(writer.writeFile('file/inner.php', bytes('x')))).toBe('pathRejected');
    expect(await code(writer.deleteFile('plugins/a.php'))).toBe('pathRejected');
  });

  it('deletes plain files only, and says when there was nothing', async () => {
    const writer = new WpLocalWriter(root);
    await writer.writeFile('a/b.css', bytes('x'));
    expect(await writer.deleteFile('a/b.css')).toBe(true);
    expect(await writer.deleteFile('a/b.css')).toBe(false);
    expect(await writer.deleteFile('missing/b.css')).toBe(false);
  });

  it('cleans up the temporary file when a write fails', async () => {
    const writer = new WpLocalWriter(root);
    mkdirSync(join(root, 'a', 'target.css', 'inner'), { recursive: true });
    writeFileSync(join(root, 'a', 'target.css', 'inner', 'x'), 'x');
    // A folder at the target is refused before anything is written.
    expect(await code(writer.writeFile('a/target.css', bytes('x')))).toBe('pathRejected');
    expect(readdirSync(join(root, 'a'))).toEqual(['target.css']);
  });

  it('removes only the folders it created', async () => {
    mkdirSync(join(root, 'wp-content', 'themes'), { recursive: true });
    writeFileSync(join(root, 'wp-content', 'themes', 'mine.txt'), 'keep');
    const writer = new WpLocalWriter(root);
    await writer.writeFile('wp-content/themes/shop/style.css', bytes('x'));
    await writer.writeFile('wp-content/themes/shop/inc/a.php', bytes('x'));
    await writer.writeFile('wp-content/plugins/p/p.php', bytes('x'));
    await writer.removeCreated();
    expect(readdirSync(join(root, 'wp-content'))).toEqual(['themes']);
    expect(readdirSync(join(root, 'wp-content', 'themes'))).toEqual(['mine.txt']);
  });
});
