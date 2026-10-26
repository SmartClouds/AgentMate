import {
  validateWpItemPath,
  WP_BATCH_MAX_BYTES,
  WP_BATCH_MIN_BYTES,
  WP_MAX_FILE_BYTES,
  WP_MAX_FILES_PER_ITEM,
  WP_MAX_FRAME_BLOBS,
  WP_ROUTES,
  type WpFileMap,
  type WpItemRef,
  type WpLimits,
  type WpSkippedEntry,
  wpItemRoot,
  wpMirrorPath,
} from '@runova/core';
import { wordPressError } from '../../../shared/wordpressErrors';
import { WpBatchSizer, type WpClient, WpRemoteError } from './client';
import { sha256Hex } from './crypto';
import { cleanSiteText } from './siteText';

/**
 * Reading an item off the site (E19): its manifest, page by page, and its files, in batches the
 * site can serve. Everything the site says is checked: paths against the same policy the desktop
 * uses, hashes and sizes against the bytes that arrived.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAGES = 1000;
/** Paths the site says it left out, kept for the review; more than this are not listed. */
const MAX_SKIPPED = 1000;

export interface WpRemoteItem {
  /** False when the site has no such item. */
  exists: boolean;
  isFile: boolean;
  files: WpFileMap;
  /** What the site left out, and paths it listed that the desktop refuses. */
  skipped: WpSkippedEntry[];
}

export async function readRemoteManifest(
  client: WpClient,
  item: WpItemRef,
  signal?: AbortSignal,
): Promise<WpRemoteItem> {
  const result: WpRemoteItem = { exists: true, isFile: false, files: {}, skipped: [] };
  let cursor: string | null = null;
  let count = 0;
  const skip = (entry: WpSkippedEntry) => {
    if (result.skipped.length < MAX_SKIPPED) result.skipped.push(entry);
  };
  for (let page = 0; page < MAX_PAGES; page++) {
    let data: Awaited<ReturnType<WpClient['call']>>['data'];
    try {
      ({ data } = await client.call(
        WP_ROUTES.itemsManifest,
        { item, ...(cursor === null ? {} : { cursor }) },
        { signal },
      ));
    } catch (error) {
      if (error instanceof WpRemoteError && error.code === 'itemUnknown') {
        return { exists: false, isFile: false, files: {}, skipped: [] };
      }
      throw error;
    }
    const manifest = data as {
      isFile?: unknown;
      entries?: unknown;
      skipped?: unknown;
      cursor?: unknown;
    };
    result.isFile = manifest.isFile === true;
    for (const raw of Array.isArray(manifest.entries) ? manifest.entries : []) {
      const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as {
        path?: unknown;
        size?: unknown;
        sha256?: unknown;
      };
      const path = typeof entry.path === 'string' ? entry.path : '';
      const valid =
        validateWpItemPath(path).ok &&
        (!result.isFile || path === item.slug) &&
        typeof entry.sha256 === 'string' &&
        SHA256.test(entry.sha256) &&
        Number.isSafeInteger(entry.size) &&
        (entry.size as number) >= 0;
      if (!valid) {
        skip({ path: cleanSiteText(path, 400), reason: 'hardDenied' });
        continue;
      }
      if ((entry.size as number) > WP_MAX_FILE_BYTES) {
        skip({ path, reason: 'tooLarge' });
        continue;
      }
      count += 1;
      if (count > WP_MAX_FILES_PER_ITEM) {
        throw wordPressError(
          'tooLarge',
          `${wpItemRoot(item)} on the site holds more than ${WP_MAX_FILES_PER_ITEM} files, more than Runova syncs for one item.`,
        );
      }
      result.files[path] = { sha256: entry.sha256 as string, size: entry.size as number };
    }
    for (const raw of Array.isArray(manifest.skipped) ? manifest.skipped : []) {
      const skipped = (typeof raw === 'object' && raw !== null ? raw : {}) as {
        path?: unknown;
        reason?: unknown;
      };
      if (typeof skipped.path !== 'string' || typeof skipped.reason !== 'string') continue;
      skip({
        path: cleanSiteText(skipped.path, 400),
        reason: cleanSiteText(skipped.reason, 40) as WpSkippedEntry['reason'],
      });
    }
    if (typeof manifest.cursor !== 'string' || manifest.cursor === '') return result;
    if (manifest.cursor === cursor) break;
    cursor = manifest.cursor;
  }
  throw wordPressError('internal', 'The site kept sending manifest pages without an end.');
}

export interface WpWantedFile {
  path: string;
  /** From the manifest the plan was made from: what arrives must be exactly this file. */
  size: number;
  sha256: string;
}

export interface WpReadOptions {
  limits: Pick<WpLimits, 'maxResponseBytes' | 'maxPathsPerRead'>;
  /** A single-file item (its one path is its slug), for messages. */
  isFile: boolean;
  signal?: AbortSignal;
  /** Called once per file, with the whole file and its hash, in the order they arrive. */
  onFile: (path: string, bytes: Uint8Array, sha256: string) => Promise<void>;
  /** Bytes as they arrive, for progress. */
  onBytes?: (bytes: number) => void;
}

export function wpReadCap(limits: Pick<WpLimits, 'maxResponseBytes'>): number {
  const cap = Math.floor(limits.maxResponseBytes * 0.8);
  return Math.max(WP_BATCH_MIN_BYTES, Math.min(WP_BATCH_MAX_BYTES, cap));
}

function readFailed(path: string, why: string): Error {
  return wordPressError(
    'internal',
    `The site sent ${cleanSiteText(path, 300)} back wrong (${why}). Try again.`,
  );
}

/** The `[wp:conflict]` shape: a summary, then `<project path>: <what>`. */
function changedOnSite(item: WpItemRef, isFile: boolean, path: string): Error {
  let shown: string;
  try {
    shown = wpMirrorPath(item, isFile, path);
  } catch {
    shown = `${wpItemRoot(item)}/${path}`;
  }
  return wordPressError(
    'conflict',
    `1 file changed on the site after the review.\n${cleanSiteText(shown, 400)}: changed on the site since the review`,
  );
}

interface ReadResult {
  path: string;
  offset: number;
  length: number;
  size: number;
  sha256: string;
  missing?: boolean;
}

/**
 * Reads files of one item; returns the paths the site no longer has. Every file must arrive as
 * the manifest entry the plan was made from (same size, same hash): a site cannot stream more
 * than it listed, or swap in other bytes after the review.
 */
export async function readRemoteFiles(
  client: WpClient,
  item: WpItemRef,
  wanted: readonly WpWantedFile[],
  options: WpReadOptions,
): Promise<string[]> {
  for (const file of wanted) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > WP_MAX_FILE_BYTES) {
      throw readFailed(file.path, 'it is larger than Runova syncs');
    }
  }
  const sizer = new WpBatchSizer(wpReadCap(options.limits));
  let maxPaths = Math.max(1, Math.min(options.limits.maxPathsPerRead || 1, WP_MAX_FRAME_BLOBS));
  const missing: string[] = [];
  const queue = [...wanted];
  const sameAsPlanned = (file: WpWantedFile, result: ReadResult) =>
    result.size === file.size && result.sha256 === file.sha256;

  const read = async (files: { path: string; offset?: number; length?: number }[]) => {
    for (;;) {
      try {
        const { data, blobs, durationMs } = await client.call(
          WP_ROUTES.filesRead,
          { item, files },
          { signal: options.signal },
        );
        sizer.succeeded(durationMs);
        const results = (Array.isArray(data.files) ? data.files : []) as ReadResult[];
        if (results.length !== files.length || blobs.length !== files.length) {
          throw readFailed(files[0].path, 'the answer does not match the request');
        }
        return results.map((result, index) => {
          if (typeof result !== 'object' || result === null || result.path !== files[index].path) {
            throw readFailed(files[index].path, 'another file came back');
          }
          return { result, blob: blobs[index] };
        });
      } catch (error) {
        // Several files at once: the caller asks for fewer at a time.
        if (error instanceof WpRemoteError && error.code === 'tooLarge' && files.length > 1) {
          return null;
        }
        if (error instanceof WpRemoteError && error.code === 'tooLarge') {
          sizer.tooLarge();
          if (files[0].length !== undefined) {
            files = [{ ...files[0], length: Math.min(files[0].length, sizer.current) }];
          } else return null;
          continue;
        }
        throw error;
      }
    }
  };

  /** A file larger than one batch, in pieces of at most the batch size. */
  const readWhole = async (file: WpWantedFile): Promise<void> => {
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < file.size) {
      const length = Math.min(sizer.current, file.size - offset);
      const answer = await read([{ path: file.path, offset, length }]);
      if (!answer) continue;
      const [{ result, blob }] = answer;
      if (result.missing) {
        if (offset > 0) throw changedOnSite(item, options.isFile, file.path);
        missing.push(file.path);
        return;
      }
      if (!sameAsPlanned(file, result)) throw changedOnSite(item, options.isFile, file.path);
      if (
        result.offset !== offset ||
        blob.length !== result.length ||
        blob.length === 0 ||
        blob.length > length
      ) {
        throw readFailed(file.path, 'a piece was the wrong size');
      }
      parts.push(blob);
      offset += blob.length;
      options.onBytes?.(blob.length);
    }
    const bytes = Buffer.concat(parts);
    const sha256 = sha256Hex(bytes);
    if (sha256 !== file.sha256) throw readFailed(file.path, 'its hash does not match');
    await options.onFile(file.path, bytes, sha256);
  };

  while (queue.length > 0) {
    if (options.signal?.aborted) throw options.signal.reason;
    const first = queue[0];
    if (first.size > sizer.current) {
      queue.shift();
      await readWhole(first);
      continue;
    }
    const batch: WpWantedFile[] = [];
    let bytes = 0;
    while (
      queue.length > 0 &&
      batch.length < maxPaths &&
      queue[0].size <= sizer.current &&
      bytes + queue[0].size <= sizer.current
    ) {
      const next = queue.shift() as WpWantedFile;
      batch.push(next);
      bytes += next.size;
    }
    const answer = await read(batch.map((file) => ({ path: file.path })));
    if (!answer) {
      maxPaths = Math.max(1, Math.floor(batch.length / 2));
      queue.unshift(...batch);
      continue;
    }
    for (const [index, { result, blob }] of answer.entries()) {
      const file = batch[index];
      if (result.missing) {
        missing.push(file.path);
        continue;
      }
      if (!sameAsPlanned(file, result)) throw changedOnSite(item, options.isFile, file.path);
      if (result.offset !== 0 || blob.length !== file.size) {
        throw readFailed(file.path, 'it came back the wrong size');
      }
      const sha256 = sha256Hex(blob);
      if (sha256 !== file.sha256) throw readFailed(file.path, 'its hash does not match');
      options.onBytes?.(blob.length);
      await options.onFile(file.path, blob, sha256);
    }
  }
  return missing;
}
