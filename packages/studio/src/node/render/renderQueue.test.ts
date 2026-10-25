import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RenderJobView, StudioEvent } from '../../api.js';
import { createDocument, createScene, type StudioDocument } from '../../document/schema.js';
import { type FakeFrameHostOptions, fakeFrameHost } from '../../test/fakeFrames.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import {
  createStudioRender,
  defaultFileName,
  freeBytesAt,
  type StudioRender,
  type StudioRenderDeps,
} from './renderQueue.js';

const tempDir = useTempDirs();
const SMALL = { width: 16, height: 9 };
afterEach(() => {
  delete process.env.FAKE_FFMPEG;
});
const cue = (value: Record<string, unknown>) => {
  process.env.FAKE_FFMPEG = JSON.stringify(value);
};

function video(edit?: (doc: StudioDocument) => void): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'Launch day', language: 'en' });
  doc.renderSettings.fps = 24;
  doc.renderSettings.resolution = '720p';
  doc.renderSettings.hwEncode = false;
  doc.scenario.scenes = [
    createScene({
      id: 's1',
      code: { treeHash: 'a'.repeat(64) },
      targetDuration: secondsToFlicks(1),
    }),
    createScene({
      id: 's2',
      code: { treeHash: 'b'.repeat(64) },
      targetDuration: secondsToFlicks(1),
    }),
  ];
  edit?.(doc);
  return doc;
}

interface Setup {
  render: StudioRender;
  events: StudioEvent[];
  folder: string;
  cacheDir: string;
  dataDir: string;
  served: string[];
  deps: StudioRenderDeps;
}

async function setup(
  overrides: Partial<StudioRenderDeps> & { frames?: FakeFrameHostOptions } = {},
  shared?: { dataDir: string; folder: string; cacheDir: string },
): Promise<Setup> {
  const dataDir = shared?.dataDir ?? (await tempDir());
  const folder = shared?.folder ?? (await tempDir());
  const cacheDir = shared?.cacheDir ?? (await tempDir());
  const events: StudioEvent[] = [];
  const served: string[] = [];
  let n = 0;
  const { frames = {}, ...rest } = overrides;
  const deps: StudioRenderDeps = {
    // Small frames (scaled up to 720p by the chunk) keep each render to well under a second.
    host: { tools: async () => fakeTools, frames: fakeFrameHost({ fixedSize: SMALL, ...frames }) },
    dataDir,
    now: () => 1_000 + n,
    newId: () => `job${++n}`,
    notify: (event) => events.push(event),
    video: async () => ({ folder, title: 'Launch day' }),
    cache: async () => ({ dir: cacheDir, capBytes: 10 * 1024 ** 3 }),
    autoResume: async () => true,
    serveTrees: (videoId) => {
      served.push(`+${videoId}`);
      return () => served.push(`-${videoId}`);
    },
    runtimeVersion: async () => 'r1',
    freeBytes: async () => 100 * 1024 ** 3,
    ...rest,
  };
  return { render: createStudioRender(deps), events, folder, cacheDir, dataDir, served, deps };
}

async function startAndWait(s: Setup, doc = video(), fileName?: string): Promise<RenderJobView> {
  const started = await s.render.start({
    videoId: 'v1',
    document: doc,
    allowedHosts: [],
    fileName,
  });
  await s.render.idle();
  const [job] = (await s.render.jobs('v1')).filter((j) => j.id === started.id);
  return job as RenderJobView;
}

describe('the render queue', () => {
  it('renders a video into its renders folder, and says so as it goes', async () => {
    const s = await setup();
    const job = await startAndWait(s);
    expect(job).toMatchObject({
      status: 'done',
      title: 'Launch day',
      fileName: 'Launch-day-16x9-720p.mp4',
      output: join(s.folder, 'renders', 'Launch-day-16x9-720p.mp4'),
      width: 1280,
      height: 720,
      frames: 48,
      durationSeconds: 2,
      capturedChunks: 2,
      reusedChunks: 0,
      hardware: null,
      error: null,
      resumed: false,
      nonCommercial: [],
    });
    expect(JSON.parse(await readFile(job.output as string, 'utf8'))).toMatchObject({ frames: 48 });
    expect(s.events.filter((e) => e.type === 'render-changed').length).toBeGreaterThanOrEqual(3);
    expect(s.events.filter((e) => e.type === 'render-finished')).toEqual([
      {
        type: 'render-finished',
        jobId: job.id,
        videoId: 'v1',
        fileName: 'Launch-day-16x9-720p.mp4',
        ok: true,
        error: null,
      },
    ]);
    const progress = s.events.filter((e) => e.type === 'render-progress');
    expect(progress.at(-1)).toMatchObject({ phase: 'encode', done: 48, total: 48 });
    // The code was served for the render's length only.
    expect(s.served).toEqual(['+v1', '-v1']);
  });

  it('records which voices in it are for non-commercial use only', async () => {
    const s = await setup();
    const job = await startAndWait(
      s,
      video((doc) => {
        (doc.scenario.scenes[0] as { voiceRef: string | null }).voiceRef = 'omnivoice:p1';
        (doc.scenario.scenes[1] as { voiceRef: string | null }).voiceRef =
          'piper:en_US-hfc_female-medium';
      }),
    );
    expect(job.nonCommercial).toEqual(['OmniVoice', 'Piper HFC Female']);
  });

  it('runs one render at a time, in the order they were asked for', async () => {
    const s = await setup();
    const a = await s.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    const b = await s.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    expect(b.fileName).toBe('Launch-day-16x9-720p (2).mp4');
    expect(await s.render.busy('v1')).toBe(true);
    await s.render.idle();
    const jobs = await s.render.jobs();
    expect(jobs.map((j) => [j.id, j.status])).toEqual([
      [b.id, 'done'],
      [a.id, 'done'],
    ]);
    const [newer, older] = jobs as [RenderJobView, RenderJobView];
    expect((newer.startedAt as number) >= (older.endedAt as number)).toBe(true);
    // The second found every chunk in the cache.
    expect(newer.reusedChunks).toBe(2);
    expect(await s.render.busy('v1')).toBe(false);
    expect(await s.render.jobs('other')).toEqual([]);
  });

  it('keeps a file that is already there, and uses the name it is given', async () => {
    const s = await setup();
    await mkdir(join(s.folder, 'renders'), { recursive: true });
    await writeFile(join(s.folder, 'renders', 'Teaser.mp4'), 'mine');
    const job = await startAndWait(s, video(), 'Teaser');
    expect(job.fileName).toBe('Teaser (2).mp4');
    expect(await readFile(join(s.folder, 'renders', 'Teaser.mp4'), 'utf8')).toBe('mine');
  });

  it('fails with a way forward when ffmpeg is missing', async () => {
    const s = await setup({
      host: {
        tools: async () => ({ ffmpeg: null, ffprobe: null }),
        frames: fakeFrameHost({ fixedSize: SMALL }),
      },
    });
    const job = await startAndWait(s);
    expect(job.status).toBe('failed');
    expect(job.error).toBe(
      'ffmpeg is not installed. Install it from Agent Tools, Dev Setup (Studio), then try again.',
    );
    const tools = await s.render.tools();
    expect(tools.ffmpeg).toEqual({ found: false, version: null });
    expect(tools.codecs.h264).toBe(job.error);
  });

  it('refuses to start without a render host or with a video that cannot render', async () => {
    const none = await setup({ host: undefined });
    await expect(
      none.render.start({ videoId: 'v1', document: video(), allowedHosts: [] }),
    ).rejects.toThrow('Rendering is not available here.');
    expect((await none.render.tools()).ffmpeg.found).toBe(false);
    const s = await setup();
    const empty = video((doc) => {
      doc.scenario.scenes = [];
    });
    await expect(
      s.render.start({ videoId: 'v1', document: empty, allowedHosts: [] }),
    ).rejects.toThrow('The video has no scenes yet.');
  });

  it('says which codecs this ffmpeg lacks, and fails a render that asks for one', async () => {
    const s = await setup();
    const tools = await s.render.tools();
    expect(tools).toMatchObject({
      ffmpeg: { found: true, version: '9.0.2' },
      ffprobe: { found: true },
    });
    expect(tools.codecs.h264).toBeNull();
    expect(tools.codecs.vp9).toContain('no libvpx-vp9 encoder');
    const job = await startAndWait(
      s,
      video((doc) => {
        doc.renderSettings.codec = 'vp9';
      }),
    );
    expect(job).toMatchObject({ status: 'failed', fileName: 'Launch-day-16x9-720p.webm' });
    expect(job.error).toContain('no libvpx-vp9 encoder');
  });

  it('reports an ffmpeg that does not answer', async () => {
    const s = await setup({
      host: {
        tools: async () => ({
          ffmpeg: { file: join(await tempDir(), 'gone.exe') },
          ffprobe: fakeTools.ffprobe,
        }),
        frames: fakeFrameHost(),
      },
    });
    const tools = await s.render.tools();
    expect(tools.ffmpeg).toEqual({ found: true, version: null });
    expect(tools.codecs.h264).toMatch(/^ffmpeg is installed but did not answer: Could not start/);
  });

  it('will not start on a nearly full disk, and warns when space looks short', async () => {
    const s = await setup({ freeBytes: async () => 100 * 1024 * 1024 });
    const job = await startAndWait(s);
    expect(job.error).toBe(
      'There is not enough free space on the cache folder (0.1 GB left) to render.',
    );
    const long = video((doc) => {
      doc.renderSettings.resolution = '2160p';
      doc.scenario.scenes[0]!.targetDuration = secondsToFlicks(60);
    });
    const estimate = await s.render.estimate({ videoId: 'v1', document: long });
    expect(estimate).toMatchObject({
      ok: true,
      frames: 1464,
      width: 3840,
      height: 2160,
      extension: 'mp4',
    });
    if (!estimate.ok) throw new Error('no estimate');
    expect(estimate.fileName).toBe('Launch-day-16x9-2160p');
    expect(estimate.warnings).toEqual([
      expect.stringMatching(/^The cache folder may run out of space/),
      expect.stringMatching(/^The video folder may run out of space/),
    ]);
  });

  it('estimates without warnings when there is room, and lists what blocks a render', async () => {
    const s = await setup();
    const estimate = await s.render.estimate({ videoId: 'v1', document: video() });
    expect(estimate.ok && estimate.warnings).toEqual([]);
    const blocked = await s.render.estimate({
      videoId: 'v1',
      document: video((doc) => {
        doc.scenario.scenes[0]!.code = { treeHash: null };
      }),
    });
    expect(blocked).toEqual({
      ok: false,
      problems: ['Scene 1 has no animation yet. Animate it, or remove it.'],
    });
  });

  it('cancels a running render and a queued one, then carries on from the cache on retry', async () => {
    let cancelAt: ((n: number) => void) | null = null;
    const s = await setup({ frames: { onFrame: (n) => cancelAt?.(n) } });
    const running = await s.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    const queued = await s.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    await s.render.cancel(queued.id);
    const stopped = new Promise<void>((resolve) => {
      cancelAt = (n) => {
        if (n === 30) {
          cancelAt = null;
          void s.render.cancel(running.id).then(resolve);
        }
      };
    });
    await stopped;
    await s.render.idle();
    const byId = async (id: string) =>
      (await s.render.jobs()).find((j) => j.id === id) as RenderJobView;
    expect((await byId(running.id)).status).toBe('cancelled');
    expect((await byId(queued.id)).status).toBe('cancelled');

    await s.render.retry(running.id);
    await s.render.idle();
    expect(await byId(running.id)).toMatchObject({
      status: 'done',
      reusedChunks: 1,
      capturedChunks: 1,
    });
    // Retrying a finished render changes nothing.
    expect((await s.render.retry(running.id)).status).toBe('done');
  });

  it('resumes a render the app stopped in the middle of, using what it had finished', async () => {
    let stopAt: ((n: number) => void) | null = null;
    const first = await setup({ frames: { onFrame: (n) => stopAt?.(n) } });
    const job = await first.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    await new Promise<void>((resolve) => {
      stopAt = (n) => {
        if (n === 30) {
          stopAt = null;
          void first.render.shutdown().then(resolve);
        }
      };
    });
    expect((await first.render.jobs())[0]?.status).toBe('running');

    const second = await setup({}, first);
    await second.render.resumeAfterStart();
    expect(second.events.find((e) => e.type === 'render-resumed')).toEqual({
      type: 'render-resumed',
      jobId: job.id,
      videoId: 'v1',
      fileName: 'Launch-day-16x9-720p.mp4',
    });
    await second.render.idle();
    expect((await second.render.jobs())[0]).toMatchObject({
      id: job.id,
      status: 'done',
      resumed: true,
      reusedChunks: 1,
      capturedChunks: 1,
    });
  });

  it('leaves a stopped render for the user to resume when auto-resume is off', async () => {
    const first = await setup();
    await mkdir(first.dataDir, { recursive: true });
    const job = await first.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    await first.render.shutdown();
    await first.render.idle();
    // Mark it as a crashed run would have left it.
    const file = join(first.dataDir, 'renders.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.jobs[0].status = 'running';
    await writeFile(file, JSON.stringify(data));

    const second = await setup({ autoResume: async () => false }, first);
    await second.render.resumeAfterStart();
    const [stopped] = await second.render.jobs();
    expect(stopped).toMatchObject({
      id: job.id,
      status: 'interrupted',
      error: 'AgentMate stopped during this render. Resume it to carry on where it was.',
    });
    await second.render.retry(job.id);
    await second.render.idle();
    expect((await second.render.jobs())[0]?.status).toBe('done');
  });

  it('uses a hardware encoder that passes its test, and falls back when it fails on the video', async () => {
    const hw = video((doc) => {
      doc.renderSettings.hwEncode = true;
    });
    const s = await setup();
    expect(await startAndWait(s, hw)).toMatchObject({ status: 'done', hardware: 'h264_nvenc' });

    cue({ failEncoder: 'h264_nvenc' });
    const fallback = await setup();
    expect(await startAndWait(fallback, hw)).toMatchObject({ status: 'done', hardware: null });

    cue({ brokenEncoders: ['h264_nvenc'] });
    const broken = await setup();
    expect(await startAndWait(broken, hw)).toMatchObject({ status: 'done', hardware: null });
  });

  it('passes on why a render failed', async () => {
    cue({ failAssembly: 'Error initializing complex filters.' });
    const s = await setup();
    expect(await startAndWait(s)).toMatchObject({
      status: 'failed',
      error: 'Error initializing complex filters.',
    });
    expect(s.events.find((e) => e.type === 'render-finished')).toMatchObject({
      ok: false,
      error: 'Error initializing complex filters.',
    });
  });

  it('removes finished renders from the list but keeps their files, and refuses a running one', async () => {
    const s = await setup();
    const done = await startAndWait(s);
    await s.render.remove(done.id);
    expect(await s.render.jobs()).toEqual([]);
    expect(await readdir(join(s.folder, 'renders'))).toEqual(['Launch-day-16x9-720p.mp4']);
    await expect(s.render.remove(done.id)).rejects.toThrow(
      'That render is not in the list any more.',
    );

    const queued = await s.render.start({ videoId: 'v1', document: video(), allowedHosts: [] });
    await expect(s.render.remove(queued.id)).rejects.toThrow(
      'Cancel the render before removing it from the list.',
    );
    await s.render.idle();
  });
});

describe('helpers', () => {
  it('names the file from the title and the format', () => {
    const doc = video((d) => {
      d.title = 'معرفی محصول';
      d.renderSettings.aspect = '9:16';
      d.renderSettings.resolution = '1080p';
    });
    expect(defaultFileName(doc)).toBe('معرفی-محصول-9x16-1080p');
  });

  it('reads free space from the nearest folder that exists', async () => {
    const dir = await tempDir();
    const free = await freeBytesAt(join(dir, 'not', 'made', 'yet'));
    expect(free).toBeGreaterThan(0);
  });
});
