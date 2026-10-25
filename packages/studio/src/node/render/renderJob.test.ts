import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument, createScene, type StudioDocument } from '../../document/schema.js';
import type { FfmpegCapabilities } from '../../render/ffmpeg.js';
import { buildRenderPlan, type RenderPlan } from '../../render/plan.js';
import { type FakeFrameHostOptions, fakeFrameHost } from '../../test/fakeFrames.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { FfmpegError, RenderCancelledError } from './ffmpegTool.js';
import {
  chunkFile,
  concatList,
  type RenderJobInput,
  type RenderProgress,
  runRenderJob,
  sceneCacheDir,
  unpremultiply,
  writeChunk,
} from './renderJob.js';

const tempDir = useTempDirs();
const CAPS: FfmpegCapabilities = {
  version: '9.0.2',
  encoders: new Set(['libx264']),
  filters: new Set(['xfade']),
};

function cue(value: Record<string, unknown>) {
  process.env.FAKE_FFMPEG = JSON.stringify(value);
}
afterEach(() => {
  delete process.env.FAKE_FFMPEG;
});

function plan(edit?: (doc: StudioDocument) => void): RenderPlan {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'en' });
  doc.renderSettings.fps = 24;
  doc.scenario.scenes = [
    createScene({
      id: 's1',
      code: { treeHash: 'a'.repeat(64) },
      targetDuration: secondsToFlicks(1),
      transitionOut: { kind: 'fade', duration: secondsToFlicks(0.25) },
    }),
    createScene({
      id: 's2',
      code: { treeHash: 'b'.repeat(64) },
      targetDuration: secondsToFlicks(1),
    }),
  ];
  edit?.(doc);
  const result = buildRenderPlan(doc, { runtimeVersion: '1', chunkSeconds: 0.5 });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return { ...result.plan, width: 8, height: 6, design: { width: 8, height: 6 }, scale: 1 };
}

async function job(
  overrides: Partial<RenderJobInput> & { frameOptions?: FakeFrameHostOptions } = {},
) {
  const cache = await tempDir();
  const out = await tempDir();
  const { frameOptions, ...rest } = overrides;
  const input: RenderJobInput = {
    plan: plan(),
    tools: fakeTools,
    capabilities: CAPS,
    hardware: null,
    frames: fakeFrameHost(frameOptions),
    allowedHosts: [],
    cacheDir: join(cache, 'scenes'),
    workDir: join(cache, 'work'),
    output: join(out, 'Launch.mp4'),
    ...rest,
  };
  return { input, cache, out };
}

describe('runRenderJob', () => {
  it('captures every chunk, joins them, and reports progress through both phases', async () => {
    const progress: RenderProgress[] = [];
    const { input, out, cache } = await job({ onProgress: (p) => progress.push(p) });
    const result = await runRenderJob(input);
    // 24 + 24 frames less a 6 frame fade.
    expect(result).toEqual({
      output: join(out, 'Launch.mp4'),
      frames: 42,
      capturedChunks: 4,
      reusedChunks: 0,
      recycledForMemory: 0,
    });
    const file = JSON.parse(await readFile(result.output, 'utf8'));
    expect(file).toMatchObject({
      kind: 'video',
      frames: 42,
      width: 8,
      height: 6,
      codec: 'libx264',
      audio: 'aac',
    });
    expect(file.hashes).toHaveLength(48);
    expect(file.graph).toContain('xfade=transition=fade:duration=0.250000:offset=0.750000[vout]');

    expect(progress[0]).toEqual({ phase: 'capture', done: 1, total: 48 });
    expect(progress.filter((p) => p.phase === 'capture').at(-1)).toEqual({
      phase: 'capture',
      done: 48,
      total: 48,
    });
    expect(progress.at(-1)).toEqual({ phase: 'encode', done: 42, total: 42 });
    expect(progress.some((p) => p.phase === 'encode' && p.done > 0 && p.done < 42)).toBe(true);
    // The scratch folder goes; the chunks of both scenes stay for next time.
    expect(await readdir(cache)).toEqual(['scenes']);
    expect(await readdir(input.cacheDir)).toHaveLength(2);
    expect(await readdir(out)).toEqual(['Launch.mp4']);
  });

  it('opens each scene at its own address with the project hosts, and throws away a warm-up frame', async () => {
    const frames = fakeFrameHost();
    const { input } = await job({ frames, allowedHosts: ['cdn.example.com'] });
    await runRenderJob(input);
    expect(frames.opened).toHaveLength(2);
    expect(frames.opened[0]).toMatch(/^studio-scene:\/\/t-a{64}\//);
    expect(frames.opened[1]).toMatch(/^studio-scene:\/\/t-b{64}\//);
    expect(frames.drawn).toBe(48 + 2);
    expect(frames.closed).toBe(2);
  });

  it('reuses chunks that are already in the cache', async () => {
    const first = await job();
    await runRenderJob(first.input);
    const frames = fakeFrameHost();
    const result = await runRenderJob({
      ...first.input,
      frames,
      output: join(await tempDir(), 'Again.mp4'),
    });
    expect(result).toMatchObject({ capturedChunks: 0, reusedChunks: 4 });
    expect(frames.opened).toEqual([]);
  });

  it('opens a fresh scene window every few chunks, and when the windows use too much memory', async () => {
    const steady = fakeFrameHost();
    const a = await job({ frames: steady, recycleEveryChunks: 1 });
    await runRenderJob(a.input);
    expect(steady.opened).toHaveLength(4);

    let memory = 10;
    const leaking = fakeFrameHost({ memory: () => (memory += 100) });
    const b = await job({ frames: leaking, memoryCapBytes: 150 });
    const result = await runRenderJob(b.input);
    expect(result.recycledForMemory).toBe(3);
    expect(leaking.opened).toHaveLength(3);
  });

  it('stops on cancel, keeps the chunks it finished and leaves no output', async () => {
    const controller = new AbortController();
    const { input, out } = await job({
      signal: controller.signal,
      frameOptions: { onFrame: (n) => n === 20 && controller.abort() },
    });
    await expect(runRenderJob(input)).rejects.toBeInstanceOf(RenderCancelledError);
    expect(await readdir(out)).toEqual([]);
    const dir = sceneCacheDir(input.cacheDir, input.plan.scenes[0]!);
    expect((await readdir(dir)).sort()).toEqual(['chunk-0000.mkv', 'inputs.json']);
  });

  it('stops a cancel during the encode and removes the half-written file', async () => {
    cue({ slowAssembly: true });
    const controller = new AbortController();
    const { input, out } = await job({
      signal: controller.signal,
      onProgress: (p) => p.phase === 'encode' && p.done > 0 && controller.abort(),
    });
    await expect(runRenderJob(input)).rejects.toBeInstanceOf(RenderCancelledError);
    expect(await readdir(out)).toEqual([]);
  });

  it('cancels before starting when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const frames = fakeFrameHost();
    const { input } = await job({ signal: controller.signal, frames });
    await expect(runRenderJob(input)).rejects.toBeInstanceOf(RenderCancelledError);
    expect(frames.opened).toEqual([]);
  });

  it('names the scene that would not get ready', async () => {
    const { input } = await job({ frameOptions: { neverReady: true }, readyTimeoutMs: 10 });
    await expect(runRenderJob(input)).rejects.toThrow(
      'Scene 1 could not be drawn: Scene 1 did not get ready to draw. Check it in the scene panel.',
    );
  });

  it('says what the scene window reported when a frame fails', async () => {
    const { input } = await job({ frameOptions: { failAtFrame: 30 } });
    await expect(runRenderJob(input)).rejects.toThrow(
      'Scene 2 could not be drawn: The scene page stopped (crashed). The scene page stopped (crashed).',
    );
  });

  it('passes on what ffmpeg said when a chunk fails', async () => {
    cue({ failChunk: true });
    const { input } = await job();
    await expect(runRenderJob(input)).rejects.toThrow(
      'Scene 1 could not be drawn: Error while encoding a chunk',
    );
    const dir = sceneCacheDir(input.cacheDir, input.plan.scenes[0]!);
    expect(await readdir(dir)).toEqual(['inputs.json']);
  });

  it('fails when the joining fails, with what ffmpeg said', async () => {
    cue({ failAssembly: 'Error initializing complex filters.' });
    const { input, out } = await job();
    await expect(runRenderJob(input)).rejects.toThrow('Error initializing complex filters.');
    expect(await readdir(out)).toEqual([]);
  });

  it('refuses a finished file that does not match the plan', async () => {
    cue({ outputFrames: 30, noAudio: true });
    const { input, out } = await job();
    await expect(runRenderJob(input)).rejects.toThrow(
      'The finished file came out wrong: 30 frames instead of 42, no sound track.',
    );
    expect(await readdir(out)).toEqual([]);
  });

  it('accepts a finished file one frame off, as encoders round the last frame', async () => {
    cue({ outputFrames: 43 });
    const { input } = await job();
    await expect(runRenderJob(input)).resolves.toMatchObject({ frames: 42 });
  });
});

describe('writeChunk', () => {
  const base = async () => ({
    tools: fakeTools,
    output: chunkFile(await tempDir(), 0),
    width: 4,
    height: 2,
    fps: 24,
    count: 3,
  });
  const solid = (width: number, height: number) => async () => ({
    width,
    height,
    bitmap: new Uint8Array(width * height * 4),
  });

  it('refuses frames that change size mid-chunk', async () => {
    let n = 0;
    await expect(
      writeChunk({
        ...(await base()),
        frame: async () => {
          n += 1;
          return solid(n === 1 ? 4 : 6, 2)();
        },
      }),
    ).rejects.toThrow('The scene window changed size mid-chunk (4x2 to 6x2).');
  });

  it('refuses a chunk whose frames do not count up', async () => {
    cue({ chunkFrames: 2 });
    const input = { ...(await base()), frame: solid(4, 2) };
    await expect(writeChunk(input)).rejects.toThrow('A chunk came out with 2 frames instead of 3.');
    await expect(readdir(join(input.output, '..'))).resolves.toEqual([]);
  });

  it('fails cleanly when ffmpeg dies while frames are still coming', async () => {
    cue({ dieAfterFrames: 1 });
    const big = { ...(await base()), width: 512, height: 512, count: 40 };
    const failed = writeChunk({ ...big, frame: solid(512, 512) });
    await expect(failed).rejects.toBeInstanceOf(FfmpegError);
    await expect(failed).rejects.toThrow('Conversion failed!');
  });
});

describe('concatList', () => {
  it('quotes each path, with forward slashes and quotes escaped', () => {
    expect(concatList(['C:\\cache\\a.mkv', "/tmp/it's/b.mkv"])).toBe(
      "file 'C:/cache/a.mkv'\nfile '/tmp/it'\\''s/b.mkv'\n",
    );
  });

  it('round-trips through the fake, as the real demuxer reads it', async () => {
    const dir = await tempDir();
    const odd = join(dir, "it's");
    const file = chunkFile(odd, 0);
    await writeChunk({
      tools: fakeTools,
      output: file,
      width: 2,
      height: 2,
      fps: 24,
      count: 1,
      frame: async () => ({ width: 2, height: 2, bitmap: new Uint8Array(16) }),
    });
    await writeFile(join(dir, 'list.txt'), concatList([file]));
    expect(await readFile(join(dir, 'list.txt'), 'utf8')).toContain("it'\\''s");
  });
});

describe('unpremultiply', () => {
  it('takes the alpha back out of the colour, and leaves see-through pixels black', () => {
    expect([
      ...unpremultiply(Uint8Array.from([0, 0, 128, 128, 10, 20, 30, 0, 255, 255, 255, 255])),
    ]).toEqual([0, 0, 255, 128, 0, 0, 0, 0, 255, 255, 255, 255]);
  });
});

describe('clips over the scenes', () => {
  const CAPTION = 'c'.repeat(64);
  const SONG = 's'.repeat(64);
  const layeredPlan = () => {
    const doc = createDocument({ id: 'v1', title: 'T', language: 'fa' });
    doc.renderSettings.fps = 24;
    doc.scenario.scenes = [
      createScene({
        id: 'a',
        code: { treeHash: 'a'.repeat(64) },
        targetDuration: secondsToFlicks(1),
      }),
    ];
    const base = {
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      duration: secondsToFlicks(0.5),
    };
    doc.timeline.clips = [
      {
        ...base,
        id: 't',
        trackId: 'track-text',
        start: 0,
        source: { type: 'text', text: 'سلام', lang: 'fa', dir: 'auto' },
      },
      {
        ...base,
        id: 'm',
        trackId: 'track-music',
        start: 0,
        source: { type: 'media', hash: SONG, in: 0, out: base.duration },
      },
    ];
    const result = buildRenderPlan(doc, {
      runtimeVersion: '1',
      chunkSeconds: 0.5,
      captionTree: CAPTION,
      media: new Map([[SONG, { kind: 'audio', hasAudio: true }]]),
    });
    if (!result.ok) throw new Error(result.problems.join(' '));
    return { ...result.plan, width: 8, height: 6, design: { width: 8, height: 6 }, scale: 1 };
  };

  it('draws each caption once, measures the mix, and hands both to the join', async () => {
    const frames = fakeFrameHost({ captionTree: CAPTION });
    const { input } = await job({ plan: layeredPlan(), frames, mediaPath: () => 'song.mp3' });
    const result = await runRenderJob(input);
    const file = JSON.parse(await readFile(result.output, 'utf8'));
    expect(file.graph).toContain('overlay=0:0:eof_action=pass');
    expect(file.graph).toContain('measured_I=-35.75');
    expect(frames.opened.filter((u) => u.includes(CAPTION))).toHaveLength(1);

    // A second render reuses the caption's still.
    const again = fakeFrameHost({ captionTree: CAPTION });
    await runRenderJob({ ...input, frames: again, output: join(await tempDir(), 'Again.mp4') });
    expect(again.opened.filter((u) => u.includes(CAPTION))).toEqual([]);
  });

  it('mixes without bringing to a loudness when the measurement says nothing', async () => {
    cue({ loudnorm: 'no measurement' });
    const { input } = await job({
      plan: layeredPlan(),
      frames: fakeFrameHost({ captionTree: CAPTION }),
      mediaPath: () => 'song.mp3',
    });
    const file = JSON.parse(await readFile((await runRenderJob(input)).output, 'utf8'));
    expect(file.graph).not.toContain('loudnorm');
  });

  it('fails clearly when a clip file cannot be found, or the caption page will not get ready', async () => {
    const { input } = await job({
      plan: layeredPlan(),
      frames: fakeFrameHost({ captionTree: CAPTION }),
    });
    await expect(runRenderJob(input)).rejects.toThrow(
      'A clip plays a file this render cannot find.',
    );
    const stuck = await job({
      plan: layeredPlan(),
      frames: fakeFrameHost({ captionTree: CAPTION, neverReady: true }),
      mediaPath: () => 'song.mp3',
      readyTimeoutMs: 10,
    });
    await expect(runRenderJob(stuck.input)).rejects.toThrow();
  });
});
