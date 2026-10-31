import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (path: string) => ({
      isEmpty: () => path.endsWith('.webp'),
      toPNG: () => Buffer.from(`png of ${path}`),
    }),
  },
}));

import {
  attachmentImageData,
  disposeTaskAttachments,
  isImagePath,
  loadTaskAttachments,
  NO_ATTACHMENTS,
} from './taskAttachments';

/**
 * Files pasted into an AI task: images are copied for the run and removed with it, text files go
 * into the task, and anything else is refused with the file's name before a copy is made.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'attach-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: string | Buffer): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe('loadTaskAttachments', () => {
  it('is nothing for no files', async () => {
    expect(await loadTaskAttachments([])).toBe(NO_ATTACHMENTS);
  });

  it('copies images into a folder of the run and tells the AI they come along', async () => {
    const a = await file('image.png', 'first');
    await mkdir(join(dir, 'other'));
    const b = await file('other/image.png', 'second');
    const attached = await loadTaskAttachments([a, b]);
    try {
      expect(attached.images).toHaveLength(2);
      // Two files with one name stay apart.
      expect(new Set(attached.images).size).toBe(2);
      expect(await readFile(attached.images[0] as string, 'utf8')).toBe('first');
      expect(await readFile(attached.images[1] as string, 'utf8')).toBe('second');
      expect(attached.text).toContain('2 images');
      expect(attached.names).toEqual(['image.png', 'image.png']);
    } finally {
      await disposeTaskAttachments(attached);
    }
    expect(await stat(attached.dir as string).catch(() => null)).toBeNull();
  });

  it('puts text files into the task with their names', async () => {
    const notes = await file('notes.md', '# Plan\nRestart the api.\n');
    const attached = await loadTaskAttachments([notes]);
    expect(attached.dir).toBeNull();
    expect(attached.images).toEqual([]);
    expect(attached.text).toContain('notes.md');
    expect(attached.text).toContain('# Plan\nRestart the api.');
  });

  it('refuses a file that is neither text nor an image, naming it', async () => {
    const zip = await file('backup.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    await expect(loadTaskAttachments([zip])).rejects.toThrow("backup.zip isn't text or an image");
  });

  it('refuses a file that is gone', async () => {
    await expect(loadTaskAttachments([join(dir, 'gone.txt')])).rejects.toThrow(
      'gone.txt is no longer there',
    );
  });

  it('refuses more text than a prompt can carry', async () => {
    const big = await file('big.log', 'x'.repeat(600 * 1024));
    await expect(loadTaskAttachments([big])).rejects.toThrow('more than 512 KB');
  });

  it('refuses more than ten files', async () => {
    const paths = await Promise.all(Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, 'x')));
    await expect(loadTaskAttachments(paths)).rejects.toThrow('at most 10');
  });

  it('copies nothing when a later file is refused', async () => {
    const shot = await file('shot.png', 'png');
    const zip = await file('backup.zip', Buffer.from([0, 1, 2]));
    const runFolders = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith('runova-attach-')).sort();
    const before = await runFolders();
    await expect(loadTaskAttachments([shot, zip])).rejects.toThrow('backup.zip');
    expect(await runFolders()).toEqual(before);
  });
});

describe('attachmentImageData', () => {
  it('sends a PNG as it is and converts other images to PNG', async () => {
    const png = await file('a.png', 'raw png');
    const jpg = await file('b.jpg', 'raw jpg');
    const data = await attachmentImageData({ ...NO_ATTACHMENTS, images: [png, jpg] });
    expect(Buffer.from(data[0] as string, 'base64').toString()).toBe('raw png');
    expect(Buffer.from(data[1] as string, 'base64').toString()).toBe(`png of ${jpg}`);
  });

  it('says what to do with an image it cannot convert', async () => {
    const webp = await file('c.webp', 'raw');
    await expect(attachmentImageData({ ...NO_ATTACHMENTS, images: [webp] })).rejects.toThrow(
      "c.webp can't be sent to the AI provider",
    );
  });
});

describe('isImagePath', () => {
  it('knows images by their extension, in any case', () => {
    expect(isImagePath('C:/x/Shot.JPEG')).toBe(true);
    expect(isImagePath('/x/notes.txt')).toBe(false);
  });
});
