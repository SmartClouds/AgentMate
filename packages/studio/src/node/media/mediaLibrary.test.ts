import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../api.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { BlobStore } from '../blobs/blobStore.js';
import type { MediaRecord } from '../db/history.js';
import type { FfmpegTools } from '../render/ffmpegTool.js';
import { peaksFromSamples } from './derivatives.js';
import { createMediaLibrary, type MediaLibrary, type MediaStore } from './mediaLibrary.js';

const tempDir = useTempDirs();
afterEach(() => {
  delete process.env.FAKE_FFMPEG;
});

function memoryStore(dir: string): MediaStore {
  const records = new Map<string, MediaRecord>();
  return {
    blobs: new BlobStore(join(dir, 'blobs')),
    addMedia(record) {
      if (!records.has(record.hash)) records.set(record.hash, record);
      return records.get(record.hash) as MediaRecord;
    },
    media: (hash) => records.get(hash),
    mediaList: () => [...records.values()],
  };
}

/** A "media file" the fake ffprobe reads its answer from. */
async function mediaFile(dir: string, name: string, probe: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ probe }));
  return path;
}

const VIDEO_PROBE = {
  format: { duration: '4.000000', format_name: 'mov,mp4' },
  streams: [
    {
      codec_type: 'video',
      width: 1280,
      height: 720,
      avg_frame_rate: '30/1',
      disposition: { attached_pic: 0 },
    },
    { codec_type: 'audio', disposition: { attached_pic: 0 } },
  ],
};
const STILL_PROBE = {
  format: { format_name: 'png_pipe' },
  streams: [
    {
      codec_type: 'video',
      width: 64,
      height: 64,
      avg_frame_rate: '25/1',
      disposition: { attached_pic: 0 },
    },
  ],
};
const SONG_PROBE = {
  format: { duration: '2.5', format_name: 'mp3' },
  streams: [
    { codec_type: 'audio', disposition: { attached_pic: 0 } },
    {
      codec_type: 'video',
      width: 300,
      height: 300,
      avg_frame_rate: '0/0',
      disposition: { attached_pic: 1 },
    },
  ],
};

async function setup(tools: FfmpegTools | null = fakeTools) {
  const root = await tempDir();
  const events: StudioEvent[] = [];
  const library: MediaLibrary = createMediaLibrary({
    tools: async () => tools,
    cacheDir: async (videoId) => join(root, 'cache', videoId, 'media'),
    notify: (e) => events.push(e),
    now: () => 1000,
  });
  return { root, events, library, store: memoryStore(root) };
}

describe('importing media', () => {
  it('copies each file into the video, tells video, still and song apart, and makes its previews', async () => {
    const s = await setup();
    const paths = [
      await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE),
      await mediaFile(s.root, 'logo.png', STILL_PROBE),
      await mediaFile(s.root, 'song.mp3', SONG_PROBE),
    ];
    const result = await s.library.importFiles('v1', s.store, paths);
    expect(result.skipped).toEqual([]);
    expect(result.imported.map((m) => [m.name, m.kind, m.duration, m.width, m.hasAudio])).toEqual([
      ['beach.mp4', 'video', secondsToFlicks(4), 1280, true],
      ['logo.png', 'image', null, 64, false],
      ['song.mp3', 'audio', secondsToFlicks(2.5), null, true],
    ]);
    expect(result.imported[0]?.fps).toBe(30);
    // The copy is the original's bytes, under its hash.
    const [video] = result.imported;
    expect(await readFile(s.store.blobs.path(video?.hash as string), 'utf8')).toBe(
      await readFile(paths[0] as string, 'utf8'),
    );

    await s.library.idle();
    const listed = await s.library.list('v1', s.store);
    const byName = Object.fromEntries(listed.map((m) => [m.name, m]));
    expect(byName['beach.mp4']?.ready).toEqual({
      proxy: true,
      poster: true,
      sprite: true,
      peaks: true,
    });
    expect(byName['logo.png']?.ready).toEqual({
      proxy: false,
      poster: true,
      sprite: false,
      peaks: false,
    });
    expect(byName['song.mp3']?.ready).toEqual({
      proxy: true,
      poster: false,
      sprite: false,
      peaks: true,
    });
    expect(listed.every((m) => !m.preparing && m.problem === null)).toBe(true);
    expect(s.events.filter((e) => e.type === 'media-changed').length).toBeGreaterThanOrEqual(4);

    const peaks = JSON.parse(
      await readFile(
        (await s.library.file('v1', s.store, video?.hash as string, 'peaks')) as string,
        'utf8',
      ),
    );
    expect(peaks.perSecond).toBe(100);
    expect(peaks.peaks).toHaveLength(100);
  });

  it('keeps one copy of a file imported twice, and skips what it cannot take', async () => {
    const s = await setup();
    const clip = await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE);
    await s.library.importFiles('v1', s.store, [clip]);
    const again = await s.library.importFiles('v1', s.store, [
      clip,
      join(s.root, 'notes.txt'),
      join(s.root, 'missing.mp4'),
      s.root,
    ]);
    expect(again.imported).toHaveLength(1);
    expect(again.skipped.map((x) => x.reason)).toEqual([
      'Studio does not take this kind of file.',
      expect.stringMatching(/ENOENT|no such file/),
      'Studio does not take this kind of file.',
    ]);
    expect(await s.library.list('v1', s.store)).toHaveLength(1);
  });

  it('says ffmpeg is needed when it is missing', async () => {
    const s = await setup(null);
    const clip = await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE);
    const result = await s.library.importFiles('v1', s.store, [clip]);
    expect(result.skipped[0]?.reason).toMatch(/^Importing needs ffmpeg/);
  });

  it('refuses a file with no picture or sound', async () => {
    const s = await setup();
    const empty = await mediaFile(s.root, 'empty.mkv', {
      format: { format_name: 'matroska' },
      streams: [],
    });
    const result = await s.library.importFiles('v1', s.store, [empty]);
    expect(result.skipped[0]?.reason).toMatch(/has no picture or sound Studio can use/);
  });
});

describe('preview files', () => {
  it('serves the original and each preview file once it exists, only for this video media', async () => {
    const s = await setup();
    const [video] = (
      await s.library.importFiles('v1', s.store, [
        await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE),
      ])
    ).imported;
    const [still] = (
      await s.library.importFiles('v1', s.store, [await mediaFile(s.root, 'logo.png', STILL_PROBE)])
    ).imported;
    await s.library.idle();
    const hash = video?.hash as string;
    expect(await s.library.file('v1', s.store, hash, 'original')).toBe(s.store.blobs.path(hash));
    expect(await s.library.file('v1', s.store, hash, 'proxy')).toBe(
      join(s.root, 'cache', 'v1', 'media', hash, 'proxy.mp4'),
    );
    expect(await s.library.file('v1', s.store, 'a'.repeat(64), 'original')).toBeNull();
    // A still image is its own preview, and has no thumbnail strip.
    expect(await s.library.file('v1', s.store, still?.hash as string, 'proxy')).toBe(
      s.store.blobs.path(still?.hash as string),
    );
    expect(await s.library.file('v1', s.store, still?.hash as string, 'sprite')).toBeNull();
  });

  it('says which preview failed, and makes the missing ones when the video opens again', async () => {
    process.env.FAKE_FFMPEG = JSON.stringify({ failDerivative: 'sprite' });
    const s = await setup();
    await s.library.importFiles('v1', s.store, [await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE)]);
    await s.library.idle();
    const [first] = await s.library.list('v1', s.store);
    expect(first?.ready.sprite).toBe(false);
    expect(first?.problem).toMatch(/^The sprite preview could not be made: Could not make/);

    delete process.env.FAKE_FFMPEG;
    s.library.prepare('v1', s.store);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await s.library.idle();
    const [second] = await s.library.list('v1', s.store);
    expect(second?.ready.sprite).toBe(true);
    expect(second?.problem).toBeNull();
  });

  it('stops making previews on shutdown', async () => {
    const s = await setup();
    await s.library.importFiles('v1', s.store, [await mediaFile(s.root, 'beach.mp4', VIDEO_PROBE)]);
    await s.library.shutdown();
    s.library.prepare('v1', s.store);
    await s.library.idle();
  });

  it('turns samples into peaks, the loudest in each slice', () => {
    const samples = Int16Array.from([0, 100, -32768, 5, 16384, -16384, 0, 0, 1]);
    expect(peaksFromSamples(samples, 3)).toEqual([255, 128, 0]);
  });
});
