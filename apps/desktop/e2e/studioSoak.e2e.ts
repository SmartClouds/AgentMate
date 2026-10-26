import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { startFakeTtsApis, TTS_KEY } from './fakeTtsApis';

/**
 * Studio's soak (E39): for RUNOVA_STUDIO_SOAK minutes (15 for the acceptance run), the built app
 * edits, narrates and renders a video over and over while the main process's event loop delay and
 * memory are sampled. It passes when main's event-loop p99 stays at 50 ms or less and the memory
 * shows no climbing trend once warmed up. Too long for every run, so it runs only when asked:
 *
 *   RUNOVA_STUDIO_SOAK=15 npx playwright test -c e2e/playwright.config.ts studioSoak
 */

const minutes = Number(process.env.RUNOVA_STUDIO_SOAK ?? 0);
const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);
const FLICKS = 705_600_000;

type Bridge = {
  runova: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<{ session: { status: { seq: number } } }>;
      applyEdits(input: unknown): Promise<{ ok: boolean; status: { seq: number } }>;
    };
    studioScenes: { saveFiles(input: unknown): Promise<unknown> };
    studioAudio: {
      speak(input: unknown): Promise<unknown>;
      jobs(videoId: string): Promise<{ status: string }[]>;
    };
    studioRender: {
      start(input: unknown): Promise<{ id: string }>;
      jobs(videoId?: string): Promise<{ id: string; status: string }[]>;
    };
  };
};

/** Least-squares slope of y over x. */
function slope(points: { x: number; y: number }[]): number {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

test.skip(!minutes, 'The soak runs only with RUNOVA_STUDIO_SOAK=<minutes>.');
test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

test('holds steady under a long session of edits, narration and renders', async () => {
  test.setTimeout((minutes + 5) * 60_000);
  const tts = await startFakeTtsApis();
  const app = await launchApp({
    settings: { openaiApiKey: TTS_KEY },
    env: { RUNOVA_STUDIO_TTS_URL: tts.url },
  });
  opened.push(app);
  const page = app.page;
  try {
    // The main process's event loop, measured from inside it.
    await app.app.evaluate(() => {
      // No dynamic import in here; the built-in modules are reached this way instead.
      const { monitorEventLoopDelay } = process.getBuiltinModule(
        'node:perf_hooks',
      ) as typeof import('node:perf_hooks');
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      (globalThis as { __soakLoop?: typeof histogram }).__soakLoop = histogram;
    });
    const videoId = await page.evaluate(
      async ({ library, flicks }) => {
        const { studio, studioScenes } = (window as unknown as Bridge).runova;
        await studio.updateSettings({ defaultRoot: library, autoResumeRenders: false });
        const video = await studio.create({
          title: 'Soak',
          projectId: null,
          language: 'en',
          aspect: '16:9',
        });
        const session = await studio.open(video.id);
        await studio.applyEdits({
          videoId: video.id,
          baseSeq: session.session.status.seq,
          ops: [
            ...['a', 'b'].map((id, index) => ({
              op: 'scene.add',
              index,
              scene: {
                id,
                title: id,
                narration: `Scene ${id}.`,
                onScreenText: [],
                targetDuration: flicks,
                timing: 'fixed',
                visualKind: 'motion',
                visualBrief: '',
                transitionOut: null,
                musicCue: '',
                voiceRef: null,
                notes: '',
                code: { treeHash: null },
                params: {},
              },
            })),
            {
              op: 'render.set',
              patch: { resolution: '720p', fps: 24, quality: 'draft', hwEncode: false },
            },
          ],
          label: 'Scenes',
        });
        for (const sceneId of ['a', 'b']) {
          await studioScenes.saveFiles({
            videoId: video.id,
            sceneId,
            files: [
              {
                path: 'index.html',
                content:
                  '<!doctype html><html><body style="margin:0"><script>Studio.scene({ render(t, ctx) { document.body.style.background = `hsl(${Math.round(ctx.progress * 300)},60%,40%)`; } });</script></body></html>',
              },
            ],
          });
        }
        return video.id;
      },
      { library: join(app.root, 'Videos', 'Runova Studio'), flicks: FLICKS },
    );

    const samples: { minute: number; heapMb: number; rssMb: number; appMb: number }[] = [];
    const sample = async (minute: number) => {
      const m = await app.app.evaluate(({ app: electron }) => {
        const usage = process.memoryUsage();
        const metrics = electron.getAppMetrics();
        return {
          heap: usage.heapUsed,
          rss: usage.rss,
          app: metrics.reduce((sum, p) => sum + p.memory.workingSetSize * 1024, 0),
        };
      });
      samples.push({
        minute,
        heapMb: m.heap / 1024 ** 2,
        rssMb: m.rss / 1024 ** 2,
        appMb: m.app / 1024 ** 2,
      });
    };

    const started = Date.now();
    let round = 0;
    let lastSample = 0;
    await sample(0);
    while (Date.now() - started < minutes * 60_000) {
      round += 1;
      await page.evaluate(
        async ({ id, round: n }) => {
          const { studio, studioAudio, studioRender } = (window as unknown as Bridge).runova;
          let seq = (await studio.open(id)).session.status.seq;
          for (let k = 0; k < 20; k++) {
            const done = await studio.applyEdits({
              videoId: id,
              baseSeq: seq,
              ops: [
                {
                  op: 'scene.update',
                  sceneId: 'a',
                  patch: { narration: `Round ${n}, edit ${k}.` },
                },
              ],
              label: `Edit ${n}.${k}`,
            });
            seq = done.status.seq;
          }
          await studioAudio.speak({ videoId: id, sceneIds: ['a', 'b'], voiceRef: 'openai:alloy' });
          for (let w = 0; w < 600; w++) {
            const [job] = await studioAudio.jobs(id);
            if (job && job.status !== 'running') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          if (n % 3 === 0) {
            const job = await studioRender.start({ videoId: id, fileName: `Soak ${n}` });
            for (let w = 0; w < 1200; w++) {
              const found = (await studioRender.jobs(id)).find((j) => j.id === job.id);
              if (found && !['queued', 'running'].includes(found.status)) break;
              await new Promise((r) => setTimeout(r, 250));
            }
          }
        },
        { id: videoId, round },
      );
      const minute = (Date.now() - started) / 60_000;
      if (minute - lastSample >= 0.5) {
        await sample(minute);
        lastSample = minute;
      }
    }
    const loop = await app.app.evaluate(() => {
      const h = (globalThis as { __soakLoop?: import('node:perf_hooks').IntervalHistogram })
        .__soakLoop;
      if (!h) return null;
      return { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6 };
    });
    // The first two minutes warm up (caches, JIT); the trend is read after them.
    const warm = samples.filter((s) => s.minute >= Math.min(2, minutes / 4));
    const report = {
      minutes,
      rounds: round,
      eventLoopMs: loop,
      heapSlopeMbPerMin: slope(warm.map((s) => ({ x: s.minute, y: s.heapMb }))),
      rssSlopeMbPerMin: slope(warm.map((s) => ({ x: s.minute, y: s.rssMb }))),
      samples,
    };
    mkdirSync(join(__dirname, '..', 'test-results'), { recursive: true });
    writeFileSync(
      join(__dirname, '..', 'test-results', 'studio-soak.json'),
      JSON.stringify(report, null, 2),
    );
    test.info().annotations.push({
      type: 'soak',
      description: `p99 ${loop?.p99.toFixed(1)} ms, heap ${report.heapSlopeMbPerMin.toFixed(2)} MB/min over ${round} rounds`,
    });
    expect(loop?.p99 ?? Infinity).toBeLessThanOrEqual(50);
    expect(report.heapSlopeMbPerMin).toBeLessThan(2);
  } finally {
    await tts.stop();
  }
});
