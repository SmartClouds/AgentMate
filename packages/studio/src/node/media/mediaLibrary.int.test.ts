import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { realTools } from '../../test/ffmpegTools.js';
import { makeSampleMedia } from '../../test/sampleMedia.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { BlobStore } from '../blobs/blobStore.js';
import type { MediaRecord } from '../db/history.js';
import { probeVideo } from '../render/ffmpegTool.js';
import { createMediaLibrary, type MediaStore } from './mediaLibrary.js';

/** Imports real files made by the real ffmpeg, and checks every preview file it makes. */

const tools = realTools();
const tempDir = useTempDirs();

describe.skipIf(!tools)('importing real media', () => {
  it('probes each kind right and makes previews the browser can play', async () => {
    const root = await tempDir();
    const samples = await makeSampleMedia(tools!, root);
    const records = new Map<string, MediaRecord>();
    const store: MediaStore = {
      blobs: new BlobStore(join(root, 'blobs')),
      addMedia: (r) => {
        records.set(r.hash, r);
        return r;
      },
      media: (h) => records.get(h),
      mediaList: () => [...records.values()],
    };
    const library = createMediaLibrary({
      tools: async () => tools,
      cacheDir: async () => join(root, 'cache'),
      notify: () => undefined,
      now: () => 1,
    });
    const result = await library.importFiles('v1', store, [
      samples.clip,
      samples.tone,
      samples.still,
      samples.song,
    ]);
    expect(result.skipped).toEqual([]);
    expect(result.imported.map((m) => [m.name, m.kind, m.duration, m.hasAudio])).toEqual([
      ['clip.mp4', 'video', secondsToFlicks(3), true],
      ['tone.wav', 'audio', secondsToFlicks(1.5), true],
      ['still.png', 'image', null, false],
      // The cover picture does not make the song a video.
      ['song.mp3', 'audio', expect.any(Number), true],
    ]);
    await library.idle();
    const listed = await library.list('v1', store);
    expect(listed.every((m) => m.problem === null)).toBe(true);

    const clip = result.imported[0]?.hash as string;
    const proxy = (await library.file('v1', store, clip, 'proxy')) as string;
    const facts = await probeVideo(tools!, proxy);
    expect(facts).toMatchObject({ width: 960, height: 540, videoCodec: 'h264', audioCodec: 'aac' });
    const peaks = JSON.parse(
      await readFile((await library.file('v1', store, clip, 'peaks')) as string, 'utf8'),
    );
    expect(peaks.peaks.length).toBeGreaterThanOrEqual(299);
    // The sine source plays at an eighth of full scale: 255 / 8 is about 32.
    expect(Math.max(...peaks.peaks)).toBeGreaterThanOrEqual(30);
    const sprite = await probeVideo(
      tools!,
      (await library.file('v1', store, clip, 'sprite')) as string,
    );
    expect(sprite.height).toBe(90);
    expect(sprite.width).toBe(160 * 10);
    const tone = result.imported[1]?.hash as string;
    expect(await library.file('v1', store, tone, 'proxy')).toMatch(/proxy\.mp4$/);
  });
});
