import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocument, createScene, type StudioDocument } from '../../document/schema.js';
import { buildRenderPlan, type RenderPlan } from '../../render/plan.js';
import { fakeFrameHost } from '../../test/fakeFrames.js';
import { realTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { probeFfmpeg, probeVideo, RenderCancelledError, readTool } from './ffmpegTool.js';
import { runRenderJob } from './renderJob.js';

/**
 * The whole render against the real ffmpeg: real chunks, the real graph, the real encoders. It
 * runs wherever ffmpeg is installed (Dev Setup, or the CI e2e runner) and is skipped elsewhere.
 * Frames come from a stand-in scene window; the desktop tests cover the real one.
 */

const tools = realTools();
const tempDir = useTempDirs();

const TREES = ['1', '2', '3'].map((c) => c.repeat(64));

function video(edit?: (doc: StudioDocument) => void): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'fa' });
  doc.renderSettings.fps = 24;
  doc.renderSettings.resolution = '720p';
  doc.scenario.scenes = [
    createScene({
      id: 's1',
      code: { treeHash: TREES[0] as string },
      targetDuration: secondsToFlicks(1.5),
      transitionOut: { kind: 'fade', duration: secondsToFlicks(0.5) },
    }),
    createScene({
      id: 's2',
      code: { treeHash: TREES[1] as string },
      targetDuration: secondsToFlicks(1),
    }),
    createScene({
      id: 's3',
      code: { treeHash: TREES[2] as string },
      targetDuration: secondsToFlicks(1),
    }),
  ];
  edit?.(doc);
  return doc;
}

/** The plan at a postage-stamp size, which keeps each render to a second or so. */
function tiny(doc: StudioDocument): RenderPlan {
  const result = buildRenderPlan(doc, { runtimeVersion: '1', chunkSeconds: 0.5 });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return { ...result.plan, width: 96, height: 54, design: { width: 96, height: 54 }, scale: 1 };
}

async function render(plan: RenderPlan, dirs: { cache: string; out: string }, extra = {}) {
  if (!tools) throw new Error('no ffmpeg');
  const output = join(dirs.out, `Launch.${plan.settings.codec === 'vp9' ? 'webm' : 'mp4'}`);
  return runRenderJob({
    plan,
    tools,
    capabilities: await probeFfmpeg(tools),
    hardware: null,
    frames: fakeFrameHost(),
    allowedHosts: [],
    cacheDir: dirs.cache,
    workDir: join(dirs.cache, 'work'),
    output,
    ...extra,
  });
}

/** One md5 per decoded frame, as `ffmpeg -f framemd5` prints them. */
async function frameHashes(file: string): Promise<string[]> {
  if (!tools) throw new Error('no ffmpeg');
  const out = await readTool(tools.ffmpeg, [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:v',
    '-f',
    'framemd5',
    '-',
  ]);
  return out
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(',').pop()?.trim() ?? '');
}

describe.skipIf(!tools)('rendering with the real ffmpeg', () => {
  it('renders three scenes with a fade and a cut to the exact frame count and size', async () => {
    const plan = tiny(video());
    const out = await tempDir();
    const result = await render(plan, { cache: await tempDir(), out });
    // 36 + 24 + 24 frames, less the 12 frame fade.
    expect(plan.totalFrames).toBe(72);
    expect(result).toMatchObject({ frames: 72, capturedChunks: 3 + 2 + 2, reusedChunks: 0 });
    expect(await probeVideo(tools!, result.output)).toEqual({
      width: 96,
      height: 54,
      frames: 72,
      fps: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    // Only the finished file is left in the output folder.
    expect(await readdir(out)).toEqual(['Launch.mp4']);
  });

  it('resumes after a cancel to the same frames as a render that never stopped', async () => {
    const plan = tiny(video());
    const whole = await render(plan, { cache: await tempDir(), out: await tempDir() });

    const cache = await tempDir();
    const out = await tempDir();
    const controller = new AbortController();
    // Cancel in the middle of the second scene.
    const frames = fakeFrameHost({ onFrame: (n) => n === 50 && controller.abort() });
    await expect(
      render(plan, { cache, out }, { frames, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RenderCancelledError);
    expect(await readdir(out)).toEqual([]);

    const again = fakeFrameHost();
    const resumed = await render(plan, { cache, out }, { frames: again });
    expect(resumed.reusedChunks).toBeGreaterThanOrEqual(3);
    expect(resumed.reusedChunks + resumed.capturedChunks).toBe(7);
    expect(again.drawn).toBeLessThan(84);
    expect(await frameHashes(resumed.output)).toEqual(await frameHashes(whole.output));
  });

  it('captures only the scene that changed', async () => {
    const cache = await tempDir();
    await render(tiny(video()), { cache, out: await tempDir() });
    const changed = tiny(
      video((doc) => {
        const scene = doc.scenario.scenes[1];
        if (scene) scene.code = { treeHash: '4'.repeat(64) };
      }),
    );
    const result = await render(changed, { cache, out: await tempDir() });
    expect(result).toMatchObject({ capturedChunks: 2, reusedChunks: 5 });
  });

  it('writes VP9 with Opus in WebM', async () => {
    const plan = tiny(
      video((doc) => {
        doc.renderSettings.codec = 'vp9';
        doc.renderSettings.quality = 'draft';
      }),
    );
    const result = await render(plan, { cache: await tempDir(), out: await tempDir() });
    expect(await probeVideo(tools!, result.output)).toMatchObject({
      frames: 72,
      videoCodec: 'vp9',
      audioCodec: 'opus',
    });
  });

  it('scales frames a scaled display drew larger back to the output size', async () => {
    const plan = tiny(video());
    const result = await render(
      plan,
      { cache: await tempDir(), out: await tempDir() },
      { frames: fakeFrameHost({ displayScale: 1.25 }) },
    );
    expect(await probeVideo(tools!, result.output)).toMatchObject({
      width: 96,
      height: 54,
      frames: 72,
    });
  });

  it('keeps chunks small: lossless flat frames take a fraction of their raw size', async () => {
    const cache = await tempDir();
    await render(tiny(video()), { cache, out: await tempDir() });
    const dirs = (await readdir(cache)).filter((d) => d !== 'work');
    const first = join(cache, dirs[0] as string, 'chunk-0000.mkv');
    expect((await stat(first)).size).toBeLessThan(96 * 54 * 4 * 12);
  });

  it('renders three scenes at full 1080p30 to the exact frame count and size (AC1)', async () => {
    const result = buildRenderPlan(
      video((doc) => {
        doc.renderSettings.fps = 30;
        doc.renderSettings.resolution = '1080p';
        doc.renderSettings.quality = 'draft';
      }),
      { runtimeVersion: '1' },
    );
    if (!result.ok) throw new Error(result.problems.join(' '));
    const plan = result.plan;
    // 45 + 30 + 30 frames, less the 15 frame fade.
    expect(plan.totalFrames).toBe(90);
    const rendered = await render(plan, { cache: await tempDir(), out: await tempDir() });
    expect(await probeVideo(tools!, rendered.output)).toEqual({
      width: 1920,
      height: 1080,
      frames: 90,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('stops within two seconds of a cancel, in the middle of drawing or of encoding (AC4)', async () => {
    const plan = tiny(video());
    for (const phase of ['capture', 'encode'] as const) {
      const controller = new AbortController();
      let cancelledAt = 0;
      const running = render(
        plan,
        { cache: await tempDir(), out: await tempDir() },
        {
          signal: controller.signal,
          onProgress: (p: { phase: string; done: number }) => {
            if (cancelledAt || p.phase !== phase || (phase === 'capture' && p.done < 20)) return;
            cancelledAt = Date.now();
            controller.abort();
          },
        },
      );
      await expect(running).rejects.toBeInstanceOf(RenderCancelledError);
      expect(cancelledAt).toBeGreaterThan(0);
      expect(Date.now() - cancelledAt).toBeLessThan(2000);
    }
  });
});
