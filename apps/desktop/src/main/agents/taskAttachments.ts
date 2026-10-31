import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { nativeImage } from 'electron';

/**
 * Files the user pasted or dropped into an AI task. Images are copied into a folder of the run's
 * own, so the AI can look at them (a CLI by path, an API provider as image data) and the copies go
 * when the run ends. Text files go into the task itself, which every AI can read. Anything else is
 * refused up front with the file's name, rather than failing somewhere in the middle of a run.
 */

export const MAX_TASK_ATTACHMENTS = 10;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Each step sends the whole task again, so text files are kept to what a prompt can carry. */
const MAX_TEXT_BYTES = 512 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** True for a file attached as an image rather than read as text. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export interface TaskAttachments {
  /** The run's copies of the images, as absolute paths. */
  images: string[];
  /** Where those copies live, removed with `disposeTaskAttachments`. Null without images. */
  dir: string | null;
  /** The text files, as a block for the end of the task. Empty without any. */
  text: string;
  /** Every attached file's name, for the history. */
  names: string[];
}

export const NO_ATTACHMENTS: TaskAttachments = { images: [], dir: null, text: '', names: [] };

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/** Reads and checks every file before anything is copied, so a bad one leaves nothing behind. */
export async function loadTaskAttachments(paths: readonly string[]): Promise<TaskAttachments> {
  if (paths.length === 0) return NO_ATTACHMENTS;
  if (paths.length > MAX_TASK_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_TASK_ATTACHMENTS} files to one task.`);
  }
  const images: string[] = [];
  const texts: { name: string; path: string; content: string }[] = [];
  let textBytes = 0;
  for (const path of paths) {
    const name = basename(path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile())
      throw new Error(`${name} is no longer there. Remove it and attach it again.`);
    if (isImagePath(path)) {
      if (info.size > MAX_IMAGE_BYTES) throw new Error(`${name} is too large to attach.`);
      images.push(path);
      continue;
    }
    textBytes += info.size;
    if (textBytes > MAX_TEXT_BYTES) {
      throw new Error(
        `The attached text files come to more than ${kib(MAX_TEXT_BYTES)}. Attach less, or paste the part that matters.`,
      );
    }
    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      throw new Error(`${name} isn't text or an image, so the AI can't read it.`);
    }
    texts.push({ name, path, content: bytes.toString('utf8') });
  }

  let dir: string | null = null;
  const copies: string[] = [];
  if (images.length > 0) {
    dir = await mkdtemp(join(tmpdir(), 'runova-attach-'));
    try {
      for (const [index, path] of images.entries()) {
        // Numbered, so two screenshots both called image.png stay apart.
        const copy = join(dir, `${index + 1}-${basename(path)}`);
        await copyFile(path, copy);
        copies.push(copy);
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  const blocks = texts.map(
    (file) =>
      `----- ${file.name} (${file.path}) -----\n${file.content.trimEnd()}\n----- end of ${file.name} -----`,
  );
  const imageLine =
    images.length > 0
      ? `\n\nThe user attached ${images.length === 1 ? 'an image' : `${images.length} images`} (${images
          .map((path) => basename(path))
          .join(
            ', ',
          )}), which come with this prompt. Look at ${images.length === 1 ? 'it' : 'them'} before you start.`
      : '';
  const textBlock =
    texts.length > 0
      ? `\n\nThe user attached ${texts.length === 1 ? 'this file' : 'these files'}:\n\n${blocks.join('\n\n')}`
      : '';
  return {
    images: copies,
    dir,
    text: imageLine + textBlock,
    names: paths.map((path) => basename(path)),
  };
}

export async function disposeTaskAttachments(attachments: TaskAttachments): Promise<void> {
  if (attachments.dir) {
    await rm(attachments.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The images as base64 PNG, the way an API provider takes them (they all send it labelled as PNG).
 * A JPEG is converted; a format Electron cannot decode is refused with what to do instead.
 */
export async function attachmentImageData(attachments: TaskAttachments): Promise<string[]> {
  return Promise.all(
    attachments.images.map(async (path) => {
      if (extname(path).toLowerCase() === '.png') return (await readFile(path)).toString('base64');
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) {
        throw new Error(
          `${basename(path)} can't be sent to the AI provider. Attach it as PNG or JPEG, or pick an AI CLI.`,
        );
      }
      return image.toPNG().toString('base64');
    }),
  );
}
