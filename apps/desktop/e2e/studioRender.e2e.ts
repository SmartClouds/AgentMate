import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp } from './app';

/**
 * Studio rendering (E34) in the built app with the real ffmpeg and the real offscreen scene
 * windows: two scenes with a fade between them are rendered from the Render dialog, the app is
 * killed in the middle, and on the next start the render carries on by itself from the parts it
 * had finished, to a file with exactly the frames and size asked for.
 *
 * It needs ffmpeg on PATH (Dev Setup installs it; the CI e2e runners have it).
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);

const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

type Bridge = {
  agentmat: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string; folder: string }>;
      open(videoId: string): Promise<{
        state: string;
        session: { status: { seq: number } };
      }>;
      applyEdits(
        input: unknown,
      ): Promise<{ ok: boolean; document: { scenario: { scenes: { id: string }[] } } }>;
    };
    studioScenes: { saveFiles(input: unknown): Promise<unknown> };
    studioRender: {
      jobs(videoId?: string): Promise<
        {
          status: string;
          resumed: boolean;
          reusedChunks: number;
          capturedChunks: number;
          output: string | null;
          error: string | null;
        }[]
      >;
    };
  };
};

/** A scene whose every frame is different and follows from t alone: a colour sweep and a box. */
const SCENE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; }
#box { position: absolute; top: 40%; width: 20vw; height: 20vh; background: #fff; }
</style></head>
<body><div id="box"></div>
<script>
Studio.scene({
  render(t, ctx) {
    document.body.style.background = 'hsl(' + Math.round(ctx.progress * 300) + ', 70%, 40%)';
    document.getElementById('box').style.left = (ctx.progress * 80) + 'vw';
  },
});
</script></body></html>`;

/** A standalone video with two 3 second scenes and a half second fade, ready to render. */
async function renderableVideo(page: Page, library: string): Promise<string> {
  return page.evaluate(
    async ({ library, html }) => {
      const { studio, studioScenes } = (window as unknown as Bridge).agentmat;
      await studio.updateSettings({ defaultRoot: library });
      const video = await studio.create({
        title: 'Render test',
        projectId: null,
        language: 'en',
        aspect: '16:9',
      });
      const opened = await studio.open(video.id);
      const scene = (id: string, fade: boolean) => ({
        id,
        title: id,
        narration: '',
        onScreenText: [],
        targetDuration: 3 * 705_600_000,
        timing: 'fixed',
        visualKind: 'motion',
        visualBrief: '',
        transitionOut: fade ? { kind: 'fade', duration: 352_800_000 } : null,
        musicCue: '',
        voiceRef: null,
        notes: '',
        code: { treeHash: null },
        params: {},
      });
      await studio.applyEdits({
        videoId: video.id,
        baseSeq: opened.session.status.seq,
        ops: [
          { op: 'scene.add', index: 0, scene: scene('one', true) },
          { op: 'scene.add', index: 1, scene: scene('two', false) },
        ],
        label: 'Scenes',
      });
      for (const sceneId of ['one', 'two']) {
        await studioScenes.saveFiles({
          videoId: video.id,
          sceneId,
          files: [{ path: 'index.html', content: html }],
        });
      }
      return video.id;
    },
    { library, html: SCENE_HTML },
  );
}

async function jobs(page: Page) {
  return page.evaluate(() => (window as unknown as Bridge).agentmat.studioRender.jobs());
}

test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

test('renders from the dialog, survives being killed mid-render, and resumes to the exact frames', async () => {
  test.setTimeout(240_000);
  const first = await launchApp({});
  opened.push(first);
  const library = join(first.root, 'Videos', 'AgentMate Studio');
  const videoId = await renderableVideo(first.page, library);

  await first.page.evaluate((id) => {
    location.hash = `#/studio/${id}`;
  }, videoId);
  await first.page.getByRole('button', { name: 'Render', exact: true }).click();
  const dialog = first.page.getByRole('dialog', { name: 'Render the video' });
  await dialog.getByRole('radio', { name: '720p' }).click();
  await dialog.getByRole('radio', { name: '24 fps' }).click();
  await dialog.getByRole('radio', { name: 'Draft' }).click();
  await dialog.getByRole('switch', { name: 'Encode on the graphics card when it can' }).click();
  // 72 + 72 frames less the 12 frame fade.
  await expect(dialog.getByText(/^6 s long, 1280x720, 132 frames\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Render', exact: true }).click();
  await first.page.keyboard.press('Escape');

  const strip = first.page.getByRole('region', { name: 'Render under way' });
  await expect(strip.getByRole('progressbar')).toBeVisible();
  // Two finished parts on disk (of four), so there is something to resume from.
  const cache = join(first.userDataDir, 'studio-cache', videoId, 'scenes');
  const chunks = () =>
    existsSync(cache)
      ? readdirSync(cache).flatMap((dir) =>
          readdirSync(join(cache, dir)).filter((f) => /^chunk-\d+\.mkv$/.test(f)),
        )
      : [];
  await expect
    .poll(() => chunks().length, { timeout: 120_000, intervals: [50] })
    .toBeGreaterThanOrEqual(2);

  // No goodbye: the process dies as a crash or a power cut would end it.
  first.app.process().kill('SIGKILL');
  await closeApp(first.app).catch(() => undefined);
  opened.splice(opened.indexOf(first), 1);

  const second = await launchApp({ reuseRoot: first.root });
  opened.push(second);
  await expect
    .poll(async () => (await jobs(second.page))[0]?.status, { timeout: 180_000 })
    .toBe('done');
  const [job] = await jobs(second.page);
  expect(job).toMatchObject({ resumed: true, error: null });
  expect(job?.reusedChunks).toBeGreaterThanOrEqual(1);
  expect((job?.reusedChunks ?? 0) + (job?.capturedChunks ?? 0)).toBe(4);
  const output = job?.output as string;
  expect(existsSync(output)).toBe(true);

  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,nb_read_packets',
      '-of',
      'json',
      output,
    ]).toString(),
  ) as { streams: Record<string, string | number>[] };
  const video = probe.streams.find((s) => s.codec_type === 'video');
  expect(video).toMatchObject({
    codec_name: 'h264',
    width: 1280,
    height: 720,
    nb_read_packets: '132',
  });
  expect(probe.streams.find((s) => s.codec_type === 'audio')?.codec_name).toBe('aac');

  // The finished render is listed in the editor's dialog, ready to play.
  await second.page.evaluate((id) => {
    location.hash = `#/studio/${id}`;
  }, videoId);
  await second.page.getByRole('button', { name: 'Render', exact: true }).click();
  const list = second.page.getByRole('region', { name: 'Renders of this video' });
  await expect(list.getByText('Done')).toBeVisible();
  await expect(list.getByText('Resumed')).toBeVisible();
});
