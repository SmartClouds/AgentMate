import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { BlobStore } from '../blobs/blobStore.js';
import {
  importTree,
  isSafeTreePath,
  readTree,
  storeTree,
  TreeImportError,
  treeFile,
  treeFromFiles,
  treeHashOf,
} from './codeTree.js';

const tempDir = useTempDirs();

async function sceneFolder(files: Record<string, string>) {
  const dir = await tempDir();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe('isSafeTreePath', () => {
  it('takes plain relative paths only', () => {
    expect(isSafeTreePath('index.html')).toBe(true);
    expect(isSafeTreePath('assets/logo.svg')).toBe(true);
    for (const bad of [
      '',
      '/etc/passwd',
      '../x.js',
      'a/../../x',
      'a\\b.js',
      'a//b',
      './a',
      'a\0b',
    ]) {
      expect(isSafeTreePath(bad), bad).toBe(false);
    }
  });
});

describe('importTree', () => {
  it('stores every allowed file and names the tree by its content', async () => {
    const dir = await sceneFolder({
      'index.html': '<div id="t">سلام</div>',
      'scene.js': 'Studio.scene({ render() {} })',
      'assets/logo.svg': '<svg/>',
      '.claude/settings.json': '{}',
    });
    const blobs = BlobStore.forVideo(await tempDir());
    const tree = await importTree(dir, blobs);
    expect(tree.manifest.files.map((f) => f.path)).toEqual([
      'assets/logo.svg',
      'index.html',
      'scene.js',
    ]);
    expect(tree.skipped).toEqual([]);
    expect(await readTree(blobs, tree.treeHash)).toEqual(tree.manifest);
    const html = treeFile(tree.manifest, 'index.html');
    expect(await blobs.text(html?.hash ?? '')).toBe('<div id="t">سلام</div>');
    expect(treeHashOf(tree.manifest)).toBe(tree.treeHash);

    // The same code in another folder is the same tree.
    const again = await importTree(
      await sceneFolder({
        'scene.js': 'Studio.scene({ render() {} })',
        'index.html': '<div id="t">سلام</div>',
        'assets/logo.svg': '<svg/>',
      }),
      blobs,
    );
    expect(again.treeHash).toBe(tree.treeHash);
  });

  it('leaves out files of other types and never follows a link', async () => {
    const dir = await sceneFolder({ 'index.html': 'x', 'run.exe': 'MZ', 'notes.md': '#' });
    const outside = await sceneFolder({ 'secret.txt': 'token' });
    let linked = true;
    try {
      await symlink(join(outside, 'secret.txt'), join(dir, 'secret.txt'));
    } catch {
      // Windows needs developer mode or admin for links; the rest of the test still holds.
      linked = false;
    }
    const tree = await importTree(dir, BlobStore.forVideo(await tempDir()));
    expect(tree.manifest.files.map((f) => f.path)).toEqual(['index.html']);
    expect(tree.skipped).toContain('run.exe: this type of file is not taken');
    expect(tree.skipped).toContain('notes.md: this type of file is not taken');
    if (linked) expect(tree.skipped).toContain('secret.txt: links are not followed');
  });

  it('refuses a folder with no index.html or nothing usable', async () => {
    const blobs = BlobStore.forVideo(await tempDir());
    await expect(importTree(await sceneFolder({ 'scene.js': 'x' }), blobs)).rejects.toThrow(
      /needs an index.html/,
    );
    await expect(importTree(await sceneFolder({ 'a.exe': 'x' }), blobs)).rejects.toThrow(
      TreeImportError,
    );
  });
});

describe('treeFromFiles', () => {
  it('builds a tree from fenced files, keeping the last copy of a path and dropping unsafe ones', async () => {
    const blobs = BlobStore.forVideo(await tempDir());
    const tree = await treeFromFiles(
      [
        { path: './index.html', content: 'first' },
        { path: 'index.html', content: 'second' },
        { path: '../escape.js', content: 'x' },
        { path: 'tool.exe', content: 'x' },
        { path: 'style.css', content: 'body{}' },
      ],
      blobs,
    );
    expect(tree.manifest.files.map((f) => f.path)).toEqual(['index.html', 'style.css']);
    expect(await blobs.text(treeFile(tree.manifest, 'index.html')?.hash ?? '')).toBe('second');
    expect(tree.skipped).toEqual([
      '../escape.js: not a safe path',
      'tool.exe: this type of file is not taken',
    ]);
    await expect(treeFromFiles([{ path: 'x.exe', content: '' }], blobs)).rejects.toThrow(
      /no usable files/,
    );
  });

  it('will not store a manifest with an unsafe path', async () => {
    const blobs = BlobStore.forVideo(await tempDir());
    await expect(
      storeTree(blobs, {
        version: 1,
        files: [
          { path: 'index.html', hash: 'a'.repeat(64), size: 1 },
          { path: '../x', hash: 'a'.repeat(64), size: 1 },
        ],
      }),
    ).rejects.toThrow(/not a safe path/);
    expect(treeFile({ version: 1, files: [] }, '../x')).toBeUndefined();
  });
});
