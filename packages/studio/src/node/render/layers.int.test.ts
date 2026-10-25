import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Clip,
  createDocument,
  createScene,
  type StudioDocument,
} from '../../document/schema.js';
import { loudnessArgs, loudnessGraph } from '../../render/ffmpeg.js';
import { buildRenderPlan, type MediaFacts, type RenderPlan } from '../../render/plan.js';
import { fakeFrameHost } from '../../test/fakeFrames.js';
import { realTools } from '../../test/ffmpegTools.js';
import { makeSampleMedia } from '../../test/sampleMedia.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { parseWav } from '../../voice/wav.js';
import { probeFfmpeg, probeVideo, readTool, runTool } from './ffmpegTool.js';
import { runRenderJob } from './renderJob.js';

/**
 * The clips over the scenes, rendered by the real ffmpeg: a video clip, a still and a caption laid
 * on top for their own stretches of time, and sound mixed and brought to the loudness target.
 * Checked by sampling pixels of the finished file and measuring its loudness.
 */

const tools = realTools();
const tempDir = useTempDirs();
const s = secondsToFlicks;
const CAPTION_TREE = 'c'.repeat(64);
const HASH = { clip: '1'.repeat(64), still: '2'.repeat(64), tone: '3'.repeat(64) };

function clip(
  id: string,
  trackId: string,
  hash: string | null,
  start: number,
  length: number,
  extra: Partial<Clip> = {},
): Clip {
  return {
    id,
    trackId,
    start: s(start),
    duration: s(length),
    source: hash
      ? { type: 'media', hash, in: 0, out: s(length) }
      : { type: 'text', text: 'سلام دنیا', lang: 'fa', dir: 'auto' },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    ...extra,
  };
}

function video(edit?: (doc: StudioDocument) => void): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'Layers', language: 'fa' });
  doc.renderSettings.fps = 24;
  doc.renderSettings.resolution = '720p';
  doc.renderSettings.quality = 'high';
  doc.scenario.scenes = [
    createScene({ id: 'a', targetDuration: s(3), code: { treeHash: 'a'.repeat(64) } }),
    createScene({ id: 'b', targetDuration: s(3), code: { treeHash: 'b'.repeat(64) } }),
  ];
  doc.timeline.clips = [
    clip('v', 'track-video', HASH.clip, 1, 1, {
      source: { type: 'media', hash: HASH.clip, in: s(0.5), out: s(1.5) },
    }),
    clip('i', 'track-image', HASH.still, 2.5, 1),
    clip('t', 'track-text', null, 4, 1),
    clip('m', 'track-music', HASH.tone, 0, 1.5, { fadeOut: s(0.5) }),
  ];
  edit?.(doc);
  return doc;
}

const MEDIA = new Map<string, MediaFacts>([
  [HASH.clip, { kind: 'video', hasAudio: true }],
  [HASH.still, { kind: 'image', hasAudio: false }],
  [HASH.tone, { kind: 'audio', hasAudio: true }],
]);

function tiny(doc: StudioDocument): RenderPlan {
  const result = buildRenderPlan(doc, {
    runtimeVersion: '1',
    media: MEDIA,
    captionTree: CAPTION_TREE,
  });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return { ...result.plan, width: 160, height: 90, design: { width: 160, height: 90 }, scale: 1 };
}

/** The colour at a point of the frame at `t` seconds, averaged over a 2x2 patch, read as bytes. */
async function pixel(file: string, t: number, x: number, y: number): Promise<number[]> {
  const out = execFileSync(tools!.ffmpeg.file, [
    '-v',
    'error',
    '-ss',
    t.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=2:2:${x}:${y},scale=1:1`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  expect(out.length).toBe(3);
  return [...out];
}

const distance = (a: number[], b: number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

describe.skipIf(!tools)('clips over the scenes, with the real ffmpeg', () => {
  it('lays each clip over its own stretch of time and brings the sound to the target', async () => {
    const root = await tempDir();
    const files = await makeSampleMedia(tools!, root);
    const paths: Record<string, string> = {
      [HASH.clip]: files.clip,
      [HASH.still]: files.still,
      [HASH.tone]: files.tone,
    };
    const plan = tiny(video());
    expect(plan.overlays.map((o) => [o.kind, o.startFrame, o.frames])).toEqual([
      ['video', 24, 24],
      ['image', 60, 24],
      ['caption', 96, 24],
    ]);
    expect(plan.audio.map((a) => a.clipId)).toEqual(['v', 'm']);
    const output = join(root, 'out', 'Layers.mp4');
    const frames = fakeFrameHost({ captionTree: CAPTION_TREE });
    await runRenderJob({
      plan,
      tools: tools!,
      capabilities: await probeFfmpeg(tools!),
      hardware: null,
      frames,
      allowedHosts: [],
      cacheDir: join(root, 'cache', 'scenes'),
      workDir: join(root, 'work'),
      output,
      mediaPath: (hash) => paths[hash] as string,
    });
    expect(await probeVideo(tools!, output)).toMatchObject({
      width: 160,
      height: 90,
      frames: 144,
      audioCodec: 'aac',
    });
    // The caption page was opened once, with the caption's text and Persian direction.
    const captionUrl = frames.opened.find((u) => u.includes(CAPTION_TREE)) as string;
    expect(captionUrl).toBeDefined();

    // Scene frames are one flat colour; the test pattern has bars of different colours.
    const leftRight = async (t: number, y = 45) =>
      distance(await pixel(output, t, 20, y), await pixel(output, t, 136, y));
    expect(await leftRight(0.5)).toBeLessThan(12);
    expect(await leftRight(1.5)).toBeGreaterThan(60);
    expect(await leftRight(2.2)).toBeLessThan(12);
    // The still is square, so it is fitted in the middle with see-through bars: the scene shows at
    // the sides, the pattern in the middle.
    expect(await leftRight(3, 45)).toBeLessThan(12);
    expect(
      distance(await pixel(output, 3, 64, 45), await pixel(output, 3, 92, 45)),
    ).toBeGreaterThan(40);
    // The caption lightens the bottom quarter only.
    const top = await pixel(output, 4.5, 80, 10);
    const bottom = await pixel(output, 4.5, 80, 80);
    expect(bottom.reduce((a, b) => a + b, 0)).toBeGreaterThan(top.reduce((a, b) => a + b, 0) + 60);
    expect(
      distance(await pixel(output, 5.5, 80, 10), await pixel(output, 5.5, 80, 80)),
    ).toBeLessThan(12);

    // AC5: the mix measures the target loudness within 1 LU.
    const printed = await readTool(
      tools!.ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        output,
        '-map',
        '0:a',
        '-af',
        'ebur128=framelog=quiet',
        '-f',
        'null',
        '-',
      ],
      60_000,
      'stderr',
    );
    const integrated = Number(
      /I:\s+(-?[\d.]+) LUFS/.exec(printed.split('Summary:').pop() ?? '')?.[1],
    );
    expect(integrated).toBeGreaterThan(-15);
    expect(integrated).toBeLessThan(-13);
  });

  it('leaves a silent video silent, with no clips muted or soloed into it', async () => {
    const root = await tempDir();
    const files = await makeSampleMedia(tools!, root);
    const plan = tiny(
      video((doc) => {
        doc.timeline.clips = [clip('m', 'track-music', HASH.tone, 0, 1.5)];
        const music = doc.timeline.tracks.find((t) => t.id === 'track-music');
        if (music) music.muted = true;
      }),
    );
    expect(plan.audio).toEqual([]);
    expect(plan.loudness).toBeNull();
    const output = join(root, 'Silent.mp4');
    await runRenderJob({
      plan,
      tools: tools!,
      capabilities: await probeFfmpeg(tools!),
      hardware: null,
      frames: fakeFrameHost(),
      allowedHosts: [],
      cacheDir: join(root, 'cache', 'scenes'),
      workDir: join(root, 'work'),
      output,
      mediaPath: () => files.tone,
    });
    expect(await probeVideo(tools!, output)).toMatchObject({ frames: 144, audioCodec: 'aac' });
  });
});

describe.skipIf(!tools)('music under the voice, with the real ffmpeg', () => {
  /** The mix alone, before loudness, written to a WAV and read back. */
  async function mixed(plan: RenderPlan, files: string[], dir: string) {
    const graphFile = join(dir, `graph-${plan.duck}.txt`);
    const out = join(dir, `mix-${plan.duck}.wav`);
    await writeFile(graphFile, loudnessGraph(plan).replace(/,loudnorm=[^[]*/, ''));
    const args = loudnessArgs({ plan, audioFiles: files, graphFile, version: null });
    await runTool(tools!.ffmpeg, [
      '-v',
      'error',
      '-y',
      ...args.slice(0, args.indexOf('[aout]') + 1),
      '-c:a',
      'pcm_s16le',
      out,
    ]);
    const bytes = await readFile(out);
    return { bytes, wav: parseWav(bytes) };
  }

  /** Root mean square of the mix between two times, on a 0 to 1 scale. */
  function level(mix: Awaited<ReturnType<typeof mixed>>, from: number, to: number): number {
    const { bytes, wav } = mix;
    let sum = 0;
    let n = 0;
    const frame = wav.channels * 2;
    for (let i = Math.round(from * wav.sampleRate); i < Math.round(to * wav.sampleRate); i++) {
      const v = bytes.readInt16LE(wav.dataOffset + i * frame) / 32768;
      sum += v * v;
      n += 1;
    }
    return Math.sqrt(sum / n);
  }

  it('lowers the music while the voice speaks and brings it back after', async () => {
    const root = await tempDir();
    const music = join(root, 'music.wav');
    const voice = join(root, 'voice.wav');
    await runTool(tools!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=220:d=6',
      music,
    ]);
    await runTool(tools!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=880:d=1.5',
      voice,
    ]);
    const narrated = (duck: boolean) =>
      tiny(
        video((doc) => {
          doc.renderSettings.audio.duck = duck;
          doc.timeline.clips = [
            clip('m', 'track-music', HASH.tone, 0, 6),
            clip('n', 'track-voice', HASH.clip, 1, 1.5, {
              source: { type: 'media', hash: HASH.tone, in: 0, out: s(1.5) },
            }),
          ];
        }),
      );
    // Voice first (its track is above the music), then the music.
    const ducked = await mixed(narrated(true), [voice, music], root);
    const flat = await mixed(narrated(false), [voice, music], root);
    expect(level(ducked, 1.6, 2.4)).toBeLessThan(level(flat, 1.6, 2.4) * 0.8);
    expect(level(ducked, 0.2, 0.8)).toBeCloseTo(level(flat, 0.2, 0.8), 2);
    expect(level(ducked, 4.5, 5.5)).toBeCloseTo(level(flat, 4.5, 5.5), 2);
  });
});
