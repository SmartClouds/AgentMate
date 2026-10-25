import { access, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { ImportResult, MediaVariant, MediaView, StudioEvent } from '../../api.js';
import { secondsToFlicks } from '../../time/flicks.js';
import type { BlobStore } from '../blobs/blobStore.js';
import type { MediaRecord } from '../db/history.js';
import { type FfmpegTools, probeMedia } from '../render/ffmpegTool.js';
import {
  DERIVATIVE_FILES,
  type DerivativeName,
  derivativesFor,
  makeDerivatives,
} from './derivatives.js';

/**
 * A video's imported files. A file is copied into the video's blob store (so the video keeps
 * working when the original is moved or deleted), probed with ffprobe, recorded in the video's
 * history, and given preview files in the local cache, one file at a time in the background.
 */

/** The files Studio takes, by extension; anything else is skipped with a reason. */
export const IMPORT_EXTENSIONS = {
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'],
} as const;

const ALL_EXTENSIONS = new Set<string>(Object.values(IMPORT_EXTENSIONS).flat());

/** A video's records and blobs, as the open video's store hands them over. */
export interface MediaStore {
  blobs: BlobStore;
  addMedia(record: MediaRecord): MediaRecord;
  media(hash: string): MediaRecord | undefined;
  mediaList(): MediaRecord[];
}

export interface MediaLibraryDeps {
  tools(): Promise<FfmpegTools | null>;
  /** This video's media folder in the cache. */
  cacheDir(videoId: string): Promise<string>;
  notify(event: StudioEvent): void;
  now(): number;
}

export interface MediaLibrary {
  importFiles(videoId: string, store: MediaStore, paths: readonly string[]): Promise<ImportResult>;
  list(videoId: string, store: MediaStore): Promise<MediaView[]>;
  /** A file to serve for the preview, or null when the video has no such media or file yet. */
  file(
    videoId: string,
    store: MediaStore,
    hash: string,
    variant: MediaVariant,
  ): Promise<string | null>;
  /** Makes missing preview files for every file of an opened video. */
  prepare(videoId: string, store: MediaStore): void;
  /** Resolves when no preview files are being made. Tests only. */
  idle(): Promise<void>;
  shutdown(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const NO_FFMPEG =
  'Importing needs ffmpeg, which is not installed yet. Install it from Agent Tools, Dev Setup (Studio).';

export function createMediaLibrary(deps: MediaLibraryDeps): MediaLibrary {
  const preparing = new Set<string>();
  const problems = new Map<string, string>();
  const queue: { videoId: string; record: MediaRecord; source: string }[] = [];
  let running: Promise<void> | null = null;
  const controller = new AbortController();

  const key = (videoId: string, hash: string) => `${videoId}:${hash}`;

  async function folder(videoId: string, hash: string): Promise<string> {
    return join(await deps.cacheDir(videoId), hash);
  }

  async function have(videoId: string, hash: string): Promise<Set<DerivativeName>> {
    const dir = await folder(videoId, hash);
    const found = new Set<DerivativeName>();
    for (const name of Object.keys(DERIVATIVE_FILES) as DerivativeName[]) {
      if (await exists(join(dir, DERIVATIVE_FILES[name]))) found.add(name);
    }
    return found;
  }

  function enqueue(videoId: string, record: MediaRecord, source: string): void {
    const k = key(videoId, record.hash);
    if (preparing.has(k)) return;
    preparing.add(k);
    queue.push({ videoId, record, source });
    running ??= drain().finally(() => {
      running = null;
    });
  }

  async function drain(): Promise<void> {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const k = key(job.videoId, job.record.hash);
      try {
        const tools = await deps.tools();
        if (!tools) {
          problems.set(k, NO_FFMPEG);
          continue;
        }
        const failed = await makeDerivatives(
          tools,
          {
            source: job.source,
            kind: job.record.kind,
            seconds:
              job.record.info.duration === null
                ? null
                : job.record.info.duration / secondsToFlicks(1),
            hasAudio: job.record.info.hasAudio,
            dir: await folder(job.videoId, job.record.hash),
            signal: controller.signal,
          },
          await have(job.videoId, job.record.hash),
        );
        const first = Object.entries(failed)[0];
        if (first) problems.set(k, `The ${first[0]} preview could not be made: ${first[1]}`);
        else problems.delete(k);
      } finally {
        preparing.delete(k);
        deps.notify({ type: 'media-changed', videoId: job.videoId });
      }
    }
  }

  async function view(videoId: string, record: MediaRecord): Promise<MediaView> {
    const made = await have(videoId, record.hash);
    const k = key(videoId, record.hash);
    return {
      hash: record.hash,
      name: record.name,
      kind: record.kind,
      duration: record.info.duration,
      width: record.info.width,
      height: record.info.height,
      fps: record.info.fps,
      hasAudio: record.info.hasAudio,
      bytes: record.bytes,
      importedAt: record.importedAt,
      ready: {
        proxy: made.has('proxy'),
        poster: made.has('poster'),
        sprite: made.has('sprite'),
        peaks: made.has('peaks'),
      },
      preparing: preparing.has(k),
      problem: problems.get(k) ?? null,
    };
  }

  return {
    async importFiles(videoId, store, paths) {
      const imported: MediaView[] = [];
      const skipped: ImportResult['skipped'] = [];
      const tools = await deps.tools();
      for (const path of paths) {
        if (!ALL_EXTENSIONS.has(extname(path).toLowerCase())) {
          skipped.push({ path, reason: 'Studio does not take this kind of file.' });
          continue;
        }
        if (!tools) {
          skipped.push({ path, reason: NO_FFMPEG });
          continue;
        }
        try {
          if (!(await stat(path)).isFile()) throw new Error('That is not a file.');
          const probe = await probeMedia(tools, path);
          const { hash, bytes } = await store.blobs.putFile(path);
          const record = store.addMedia({
            hash,
            name: basename(path),
            kind: probe.kind,
            info: {
              duration: probe.seconds === null ? null : secondsToFlicks(probe.seconds),
              width: probe.width,
              height: probe.height,
              fps: probe.fps,
              hasAudio: probe.hasAudio,
              hasVideo: probe.hasVideo,
            },
            bytes,
            importedAt: deps.now(),
          });
          enqueue(videoId, record, store.blobs.path(hash));
          imported.push(await view(videoId, record));
        } catch (error) {
          skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      if (imported.length > 0) deps.notify({ type: 'media-changed', videoId });
      return { imported, skipped };
    },

    async list(videoId, store) {
      return Promise.all(store.mediaList().map((record) => view(videoId, record)));
    },

    async file(videoId, store, hash, variant) {
      const record = store.media(hash);
      if (!record) return null;
      if (variant === 'original') return store.blobs.path(hash);
      const name = variant as DerivativeName;
      if (!derivativesFor(record.kind, record.info.hasAudio).includes(name)) {
        // An image has no proxy: the picture itself is small enough to show.
        return variant === 'proxy' && record.kind === 'image' ? store.blobs.path(hash) : null;
      }
      const path = join(await folder(videoId, hash), DERIVATIVE_FILES[name]);
      return (await exists(path)) ? path : null;
    },

    prepare(videoId, store) {
      void (async () => {
        for (const record of store.mediaList()) {
          const wanted = derivativesFor(record.kind, record.info.hasAudio);
          const made = await have(videoId, record.hash);
          if (wanted.some((name) => !made.has(name)))
            enqueue(videoId, record, store.blobs.path(record.hash));
        }
      })();
    },

    async idle() {
      while (running) await running;
    },

    async shutdown() {
      controller.abort();
      queue.length = 0;
      await running?.catch(() => undefined);
    },
  };
}
