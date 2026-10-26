import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlueprintAttachment, ProjectBlueprint } from '@runova/core';
import { BLUEPRINT_FILE_HOST, BLUEPRINT_FILE_SCHEME, blueprintFileNameFromUrl } from '@runova/core';
import { app, net, protocol } from 'electron';
import type { BackupAttachmentBlob } from '../shared/apiTypes';

/**
 * Blueprint attachments live beside the rest of the app data, and the record the
 * app reads back carries only their names. The renderer never sees the bytes at
 * all: it points an `<img>` or a `<video>` at the app's own URL scheme and the
 * handler below streams the file off disk, which is what lets a screen recording
 * play and seek instead of arriving as one enormous base64 string.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Ceiling on what one backup carries in attachments. Export builds the whole
 * envelope as a string in memory and import holds a rollback snapshot beside the
 * payload, so the per-file cap on its own isn't enough of a bound.
 */
export const MAX_ATTACHMENT_EXPORT_BYTES = 100 * 1024 * 1024;

/**
 * Per-file ceiling for what a backup carries. Deliberately below the on-disk
 * cap: an image is comfortably under it and rides along, a video usually isn't
 * and travels as a name the restore can tell the user about. Export builds the
 * whole envelope as a string in memory and import holds a rollback snapshot
 * beside it, so this is the number that keeps both bounded.
 */
export const MAX_BACKUP_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Only files worth attaching to a spec. The values double as the accepted types. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  // Only the two containers every Chromium build can actually play. A .mov or
  // .avi would attach happily and then show an empty player, which is worse
  // than being told up front that it isn't supported.
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** First extension wins, so image/jpeg lands on .jpg rather than .jpeg. */
const EXTENSION_BY_MIME: Record<string, string> = {};
for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
  if (!EXTENSION_BY_MIME[mime]) EXTENSION_BY_MIME[mime] = ext;
}

export const ATTACHMENT_EXTENSIONS = Object.keys(MIME_BY_EXTENSION).map((ext) => ext.slice(1));

const ALLOWED_MIME = new Set(Object.values(MIME_BY_EXTENSION));

function filesDir(): string {
  return join(app.getPath('userData'), 'data', 'blueprint-files');
}

export function attachmentPath(fileName: string): string {
  // basename keeps a doctored blueprints.json or backup from pointing elsewhere.
  return join(filesDir(), basename(fileName));
}

function mimeForFileName(fileName: string): string {
  return MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function extensionForMime(mime: string): string | null {
  return EXTENSION_BY_MIME[mime.toLowerCase()] ?? null;
}

export interface AttachmentBytes {
  mime: string;
  bytes: Buffer;
}

/**
 * Splits a data URL into its parts, for any type rather than images only.
 *
 * `projectIcons.ts` parses one already, but it rejects anything that isn't an
 * image, and its companion re-encodes through `nativeImage`, which would flatten
 * an animated GIF attached as a spec and can't touch a PDF at all.
 */
export function parseAttachmentDataUrl(dataUrl: string): AttachmentBytes | null {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(dataUrl.trim());
  if (!match) return null;
  // The header can carry parameters of its own, e.g. "text/plain;charset=utf-8;base64".
  const [type, ...params] = match[1].split(';').map((part) => part.trim().toLowerCase());
  let bytes: Buffer;
  try {
    bytes = params.includes('base64')
      ? Buffer.from(match[2], 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf-8');
  } catch {
    // Percent-escapes that don't decode: not something to throw over.
    return null;
  }
  if (bytes.byteLength === 0) return null;
  return { mime: type, bytes };
}

const MB = 1024 * 1024;

function assertAcceptable(mime: string, size: number): void {
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error(`Runova can't attach ${mime || 'that kind of'} files.`);
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `That file is ${Math.round(size / MB)} MB. Attachments are limited to ${MAX_ATTACHMENT_BYTES / MB} MB.`,
    );
  }
}

async function writeBytes(
  displayName: string,
  { mime, bytes }: AttachmentBytes,
): Promise<BlueprintAttachment> {
  assertAcceptable(mime, bytes.byteLength);
  const fileName = `${randomUUID()}${extensionForMime(mime) ?? '.bin'}`;
  await mkdir(filesDir(), { recursive: true });
  await writeFile(attachmentPath(fileName), bytes);
  return {
    id: randomUUID(),
    fileName,
    displayName: displayName.trim() || fileName,
    mime,
    size: bytes.byteLength,
    createdAt: new Date().toISOString(),
  };
}

/** The paste and drag-drop path: the renderer already holds the bytes as a data URL. */
export async function writeAttachmentFromDataUrl(
  displayName: string,
  dataUrl: string,
): Promise<BlueprintAttachment> {
  const parsed = parseAttachmentDataUrl(dataUrl);
  if (!parsed) throw new Error('That file could not be read.');
  return writeBytes(displayName, parsed);
}

/** The native picker path. The type comes from the extension, never from the renderer. */
export async function writeAttachmentFromPath(filePath: string): Promise<BlueprintAttachment> {
  const mime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(`Runova can't attach ${extname(filePath) || 'that kind of'} files.`);
  }
  const bytes = await readFile(filePath);
  return writeBytes(basename(filePath), { mime, bytes });
}

/**
 * Serves `runova-file://blueprint/<name>` off disk. Registered once, after
 * the app is ready.
 *
 * `net.fetch` over a file URL is what handles range requests, so seeking in an
 * attached video works the way it would on a real server. The name is put back
 * through `attachmentPath`, whose `basename` is the only thing standing between
 * a crafted URL and the rest of the disk.
 */
export function registerBlueprintFileProtocol(): void {
  protocol.handle(BLUEPRINT_FILE_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== BLUEPRINT_FILE_HOST) return new Response('Not found', { status: 404 });

    const fileName = blueprintFileNameFromUrl(request.url);
    if (!fileName || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
      return new Response('Not found', { status: 404 });
    }
    try {
      // Just the URL: `net.fetch` reads a file: URL itself, and forwarding the
      // request headers to it is not part of that contract.
      return await net.fetch(pathToFileURL(attachmentPath(fileName)).toString());
    } catch {
      // A file that was removed, or a backup that couldn't carry it: the preview
      // shows a broken image rather than the app throwing.
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Every file name the given blueprints still point at. */
export function referencedAttachmentFiles(blueprints: ProjectBlueprint[]): Set<string> {
  return new Set(
    blueprints.flatMap((blueprint) =>
      blueprint.sections.flatMap((section) =>
        section.attachments.map((attachment) => attachment.fileName),
      ),
    ),
  );
}

/** Drops files nothing points at any more: a removed attachment, a deleted project. */
export async function removeOrphanAttachments(keep: Set<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(filesDir());
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => !keep.has(name))
      .map(async (name) => {
        await unlink(attachmentPath(name)).catch(() => undefined);
      }),
  );
}

/**
 * Reads the referenced files for a backup. A file past the per-file cap, or past
 * the budget for the export as a whole, keeps its record and loses its bytes, so
 * a restore can still show the user what went missing and why.
 */
export async function exportAttachments(keep: Set<string>): Promise<BackupAttachmentBlob[]> {
  const blobs: BackupAttachmentBlob[] = [];
  let budget = MAX_ATTACHMENT_EXPORT_BYTES;
  for (const fileName of [...keep].sort()) {
    const mime = mimeForFileName(fileName);
    try {
      const bytes = await readFile(attachmentPath(fileName));
      const size = bytes.byteLength;
      if (size > MAX_BACKUP_ATTACHMENT_BYTES || size > budget) {
        blobs.push({ fileName, mime, size, dataBase64: null, omitted: 'too-large' });
        continue;
      }
      budget -= size;
      blobs.push({ fileName, mime, size, dataBase64: bytes.toString('base64') });
    } catch {
      blobs.push({ fileName, mime, size: 0, dataBase64: null, omitted: 'unreadable' });
    }
  }
  return blobs;
}

/**
 * Writes a backup's attachment bytes back out. This has to run before the
 * blueprints themselves are stored: storing those collects anything unreferenced,
 * which would delete the very files it is about to be handed.
 */
export async function importAttachments(blobs: BackupAttachmentBlob[]): Promise<void> {
  await mkdir(filesDir(), { recursive: true });
  for (const blob of blobs) {
    if (!blob.dataBase64) continue;
    const bytes = Buffer.from(blob.dataBase64, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
    await writeFile(attachmentPath(blob.fileName), bytes);
  }
}
