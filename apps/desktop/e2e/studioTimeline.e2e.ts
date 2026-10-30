import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Studio's timeline editor (E35) in the built app with the real ffmpeg: media imported and laid
 * over the scenes, a Persian caption with a zero-width non-joiner, a split from the keyboard and an
 * undo, then a render checked with ffprobe for its frames, its sound and its loudness. And a
 * 500-clip timeline that draws only what is in view.
 *
 * It needs ffmpeg on PATH (Dev Setup installs it; the CI e2e runners have it).
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);
const FLICKS = 705_600_000;
const ZWNJ = String.fromCodePoint(0x200c);
// "می‌خواهم" (I want), joined by a zero-width non-joiner.
const CAPTION = `ما می${ZWNJ}خواهیم`;

const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

type Bridge = {
  runova: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<{
        state: string;
        session: { status: { seq: number }; document: { timeline: { clips: unknown[] } } };
      }>;
      applyEdits(input: unknown): Promise<{ ok: boolean; status: { seq: number } }>;
    };
    studioScenes: { saveFiles(input: unknown): Promise<unknown> };
    studioMedia: {
      importFiles(
        videoId: string,
        paths: string[],
      ): Promise<{ imported: { name: string }[]; skipped: unknown[] }>;
    };
    studioRender: {
      jobs(
        videoId?: string,
      ): Promise<{ status: string; output: string | null; error: string | null }[]>;
    };
  };
};

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; }
</style></head><body><script>
Studio.scene({ render(t, ctx) { document.body.style.background = 'hsl(' + Math.round(ctx.progress * 200) + ', 60%, 35%)'; } });
</script></body></html>`;

function makeMedia(dir: string) {
  mkdirSync(dir, { recursive: true });
  const q = ['-v', 'error', '-y'];
  const clip = join(dir, 'beach.mp4');
  const song = join(dir, 'song.wav');
  execFileSync('ffmpeg', [
    ...q,
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=640x360:r=25:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=f=330:d=3',
    '-shortest',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    clip,
  ]);
  execFileSync('ffmpeg', [
    ...q,
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=6,volume=0.3',
    '-ac',
    '2',
    song,
  ]);
  return { clip, song };
}

/** A video with one 6 second scene, its code saved, open and ready. */
async function sceneVideo(page: Page, library: string, narration = ''): Promise<string> {
  return page.evaluate(
    async ({ library, html, narration, flicks }) => {
      const { studio, studioScenes } = (window as unknown as Bridge).runova;
      await studio.updateSettings({ defaultRoot: library });
      const video = await studio.create({
        title: 'Timeline test',
        projectId: null,
        language: 'fa',
        aspect: '16:9',
      });
      const opened = await studio.open(video.id);
      await studio.applyEdits({
        videoId: video.id,
        baseSeq: opened.session.status.seq,
        ops: [
          {
            op: 'scene.add',
            index: 0,
            scene: {
              id: 'one',
              title: 'یک',
              narration,
              onScreenText: [],
              targetDuration: 6 * flicks,
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
          },
          {
            op: 'render.set',
            patch: { resolution: '720p', fps: 24, quality: 'draft', hwEncode: false },
          },
        ],
        label: 'Scene',
      });
      await studioScenes.saveFiles({
        videoId: video.id,
        sceneId: 'one',
        files: [{ path: 'index.html', content: html }],
      });
      return video.id;
    },
    { library, html: SCENE_HTML, narration, flicks: FLICKS },
  );
}

test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

test('lays media and a Persian caption over the scenes, edits them, and renders them as edited', async () => {
  test.setTimeout(300_000);
  const app = await launchApp({});
  opened.push(app);
  const media = makeMedia(join(app.root, 'media'));
  const videoId = await sceneVideo(app.page, join(app.root, 'Videos', 'Runova Studio'));
  const imported = await app.page.evaluate(
    ({ videoId, paths }) =>
      (window as unknown as Bridge).runova.studioMedia.importFiles(videoId, paths),
    { videoId, paths: [media.clip, media.song] },
  );
  expect(imported.imported.map((m) => m.name)).toEqual(['beach.mp4', 'song.wav']);

  await app.page.evaluate((id) => {
    location.hash = `#/studio/${id}`;
  }, videoId);
  const page = app.page;
  await page.getByRole('radio', { name: 'Timeline' }).click();
  const panel = page.getByRole('region', { name: 'Media' });
  await expect(panel.getByRole('listitem', { name: 'beach.mp4' })).toBeVisible();
  await expect(panel.getByText('Preparing')).toHaveCount(0, { timeout: 60_000 });

  // The music from the start, the video clip from 1 s.
  await panel.getByRole('button', { name: 'Add song.wav at the playhead' }).click();
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline.getByRole('button', { name: 'song.wav, 0.0 s to 6.0 s' })).toBeVisible();
  for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Playhead', { exact: true })).toHaveText(/^00:00:01:00/);
  await panel.getByRole('button', { name: 'Add beach.mp4 at the playhead' }).click();
  await expect(timeline.getByRole('button', { name: 'beach.mp4, 1.0 s to 4.0 s' })).toBeVisible();

  // Split the video clip at 2 s from the keyboard, then undo and redo it.
  for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('s');
  await expect(timeline.getByRole('button', { name: 'beach.mp4, 1.0 s to 2.0 s' })).toBeVisible();
  await expect(timeline.getByRole('button', { name: 'beach.mp4, 2.0 s to 4.0 s' })).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(timeline.getByRole('button', { name: 'beach.mp4, 1.0 s to 4.0 s' })).toBeVisible();
  await page.keyboard.press('Control+Shift+z');
  await expect(timeline.getByRole('button', { name: 'beach.mp4, 2.0 s to 4.0 s' })).toBeVisible();

  // A caption at 4 s, its words typed in the inspector, with a ZWNJ.
  for (let i = 0; i < 48; i++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Caption', exact: true }).click();
  const words = page.getByRole('region', { name: 'Inspector' }).getByLabel('Words');
  await words.fill(CAPTION);
  await words.blur();
  await expect(timeline.getByRole('button', { name: `${CAPTION}, 4.0 s to 6.0 s` })).toBeVisible();
  // The preview shows it right to left with the ZWNJ kept.
  const shown = page.getByRole('img', { name: 'Video preview' }).getByText(CAPTION);
  await expect(shown).toHaveAttribute('dir', 'rtl');
  expect(await shown.textContent()).toBe(CAPTION);

  // Everything is saved: reopening the video brings the clips back.
  const saved = await page.evaluate(async (id) => {
    const result = await (window as unknown as Bridge).runova.studio.open(id);
    return result.session.document.timeline.clips.length;
  }, videoId);
  expect(saved).toBe(4);

  // Render it and check what came out.
  await page.getByRole('button', { name: 'Render', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Render the video' });
  await expect(dialog.getByText(/^6 s long, 1280x720, 144 frames\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (id) => (window as unknown as Bridge).runova.studioRender.jobs(id),
            videoId,
          )
        )[0]?.status,
      {
        timeout: 180_000,
      },
    )
    .toBe('done');
  const [job] = await page.evaluate(
    (id) => (window as unknown as Bridge).runova.studioRender.jobs(id),
    videoId,
  );
  const output = job?.output as string;
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,width,height,nb_read_packets',
      '-of',
      'json',
      output,
    ]).toString(),
  ) as { streams: Record<string, string | number>[] };
  expect(probe.streams.find((s) => s.codec_type === 'video')).toMatchObject({
    width: 1280,
    height: 720,
    nb_read_packets: '144',
  });
  // The video clip shows from 1 s to 4 s: the test pattern differs across the frame, a scene does not.
  const pixel = (t: number, x: number) => [
    ...execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      output,
      '-frames:v',
      '1',
      '-vf',
      `crop=2:2:${x}:300,scale=1:1`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ]),
  ];
  const spread = (t: number) =>
    Math.max(...pixel(t, 150).map((v, i) => Math.abs(v - (pixel(t, 1100)[i] ?? 0))));
  expect(spread(0.5)).toBeLessThan(15);
  expect(spread(2.5)).toBeGreaterThan(60);
  expect(spread(5)).toBeLessThan(15);
  // AC5: the mix comes out at the -14 LUFS target, within 1 LU.
  const loudness = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      output,
      '-map',
      '0:a',
      '-af',
      // Plain ebur128: ffmpeg 4.4 has no framelog=quiet and reports 0 LUFS with it.
      'ebur128',
      '-f',
      'null',
      '-',
    ],
    {
      encoding: 'utf-8',
    },
  ).stderr;
  const integrated = Number(
    /I:\s+(-?[\d.]+) LUFS/.exec(loudness.split('Summary:').pop() ?? '')?.[1],
  );
  expect(integrated).toBeGreaterThan(-15);
  expect(integrated).toBeLessThan(-13);
});

test('a 500-clip timeline draws only the clips in view and stays quick to scroll', async () => {
  test.setTimeout(180_000);
  const app = await launchApp({});
  opened.push(app);
  const page = app.page;
  const videoId = await sceneVideo(page, join(app.root, 'Videos', 'Runova Studio'));
  await page.evaluate(
    async ({ id, flicks }) => {
      const { studio } = (window as unknown as Bridge).runova;
      const session = await studio.open(id);
      await studio.applyEdits({
        videoId: id,
        baseSeq: session.session.status.seq,
        ops: [
          // As long as the clips, so every scroll step below has clips to draw.
          { op: 'scene.update', sceneId: 'one', patch: { targetDuration: 500 * flicks } },
          ...Array.from({ length: 500 }, (_, i) => ({
            op: 'clip.add',
            clip: {
              id: `c${i}`,
              trackId: 'track-text',
              start: i * flicks,
              duration: flicks,
              transitionIn: null,
              gain: 1,
              fadeIn: 0,
              fadeOut: 0,
              source: { type: 'text', text: `line ${i}`, lang: 'fa', dir: 'auto' },
            },
          })),
        ],
        label: '500 captions',
      });
    },
    { id: videoId, flicks: FLICKS },
  );
  await page.evaluate((id) => {
    location.hash = `#/studio/${id}`;
  }, videoId);
  await page.getByRole('radio', { name: 'Timeline' }).click();
  const rows = page.getByLabel('Text clips');
  await expect(rows.getByRole('button').first()).toBeVisible();
  // Zoomed in, a few dozen of the 500 are drawn at a time.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const drawn = await rows.getByRole('button').count();
  expect(drawn).toBeGreaterThan(3);
  expect(drawn).toBeLessThan(120);

  // Scroll across the whole video in 40 even steps and time the app's own work per step: the
  // scroll handler and React's render, in MessageChannel turns (timers and frames are held to
  // about one a second in the e2e window, which is in the background). Setting scrollLeft itself
  // is left out: on a
  // composited scroller it waits for a compositor commit, which that window also makes about once
  // a second (a trace showed LayerTreeHost::WaitForCommitCompletion, not layout or script).
  const timings = await page.evaluate(async () => {
    const scroller = document.querySelector('[aria-label="Time ruler"]')?.parentElement
      ?.parentElement as HTMLElement;
    const nextTask = () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      });
    // Even steps over the scrollable range, not a view at a time: at this zoom the video is only
    // a few views wide, and steps past its end would time a scroll that moves nothing.
    const stride = (scroller.scrollWidth - scroller.clientWidth) / 40;
    const steps: number[] = [];
    const counts: number[] = [];
    for (let i = 1; i <= 40; i++) {
      scroller.scrollLeft = Math.round(i * stride);
      const started = performance.now();
      scroller.dispatchEvent(new Event('scroll'));
      await nextTask();
      await nextTask();
      steps.push(performance.now() - started);
      counts.push(document.querySelectorAll('[aria-label="Text clips"] button').length);
    }
    return { steps, counts };
  });
  // The real check: every step along the video draws only what is in view, not all 500.
  expect(Math.max(...timings.counts)).toBeLessThan(120);
  expect(Math.min(...timings.counts)).toBeGreaterThan(3);

  const sorted = [...timings.steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] as number;
  test.info().annotations.push({
    type: 'scroll step',
    description: `median ${median.toFixed(1)} ms, p90 ${p90.toFixed(1)} ms over ${sorted.length} steps`,
  });
  // The median, not the p90: the Linux runner shares its machine with other jobs, which stall a
  // few steps at random (a p90 of 42.7 ms once). Drawing all 500 slows every step, so the median
  // still catches it.
  expect(median).toBeLessThan(32);
});
