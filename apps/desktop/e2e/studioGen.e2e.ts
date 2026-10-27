import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type FakeGen, GEN_KEY, startFakeGen } from '../../../packages/studio/src/test/fakeGen';
import { closeApp, type LaunchedApp, launchApp } from './app';

/**
 * Studio's generated media (E38) in the built app, against OpenAI's and Gemini's APIs faked on
 * loopback in their documented shapes: a picture asked for, priced, confirmed and made into the
 * media library and onto the timeline; a clip whose app is killed while the provider is still
 * making it, finished after the restart. Real files (a PNG and an 8-second MP4) come back, so the
 * real ffmpeg probes them. Needs ffmpeg on PATH, like the other Studio specs.
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);

type GenJob = {
  kind: string;
  status: string;
  mediaName: string | null;
  resumed: boolean;
  stage: string | null;
};
type Bridge = {
  runova: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<unknown>;
    };
    studioGen: { jobs(videoId: string): Promise<GenJob[]> };
    studioMedia: {
      list(videoId: string): Promise<{ name: string; kind: string; duration: number | null }[]>;
    };
  };
};

function makeMedia(dir: string): { picture: Buffer; clip: Buffer } {
  mkdirSync(dir, { recursive: true });
  const png = join(dir, 'made.png');
  const mp4 = join(dir, 'made.mp4');
  const q = ['-v', 'error', '-y'];
  execFileSync('ffmpeg', [
    ...q,
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=640x360:d=0.04',
    '-frames:v',
    '1',
    png,
  ]);
  execFileSync('ffmpeg', [
    ...q,
    '-f',
    'lavfi',
    '-i',
    'testsrc=s=320x180:r=24:d=8',
    '-f',
    'lavfi',
    '-i',
    'sine=f=300:d=8',
    '-shortest',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    mp4,
  ]);
  return { picture: readFileSync(png), clip: readFileSync(mp4) };
}

const opened: LaunchedApp[] = [];
let gen: FakeGen | undefined;
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
  await gen?.close();
  gen = undefined;
});

test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

const jobs = (page: Page, videoId: string) =>
  page.evaluate((id) => (window as unknown as Bridge).runova.studioGen.jobs(id), videoId);

test('makes a picture after confirming its price, and finishes a clip after a restart', async () => {
  test.setTimeout(300_000);
  const scratch = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `studio-gen-${Date.now()}`,
  );
  const media = makeMedia(scratch);
  gen = await startFakeGen({ ...media, processingPolls: 100_000 });
  const launch = (reuseRoot?: string) =>
    launchApp({
      reuseRoot,
      settings: { openaiApiKey: GEN_KEY, geminiApiKey: GEN_KEY },
      env: { RUNOVA_STUDIO_TTS_URL: gen?.url ?? '' },
    });
  const first = await launch();
  opened.push(first);
  const page = first.page;
  const videoId = await page.evaluate(
    async (library) => {
      const { studio } = (window as unknown as Bridge).runova;
      await studio.updateSettings({ defaultRoot: library });
      const video = await studio.create({
        title: 'Made',
        projectId: null,
        language: 'en',
        aspect: '16:9',
      });
      return video.id;
    },
    join(first.root, 'Videos', 'Runova Studio'),
  );

  await page.evaluate((id) => {
    location.hash = `#/studio/${id}`;
  }, videoId);
  await page.getByRole('radio', { name: 'Timeline' }).click();
  const panel = page.getByRole('region', { name: 'Media' });
  await panel.getByRole('button', { name: 'Generate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate' });

  // A picture: priced, confirmed, made, imported, then laid on the timeline.
  await expect(dialog.getByLabel('Estimate')).toHaveText(
    /^\$0\.03\. \$0\.0336 for one 1K picture\./,
  );
  await dialog.getByLabel('What to make').fill('A red bicycle against a blue wall');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make this with Google Gemini?' });
  await expect(confirm).toContainText('This bills your Google Gemini account about $0.03.');
  await confirm.getByRole('button', { name: 'Make it' }).click();
  await expect(
    dialog
      .getByRole('listitem', { name: 'A red bicycle against a blue wall' })
      .getByText('In Media'),
  ).toBeVisible({ timeout: 60_000 });
  expect(gen.requests.filter((r) => r.path === '/v1beta/interactions')).toHaveLength(1);

  // A clip: the app is killed while Gemini is still making it.
  await dialog.getByRole('radio', { name: 'Clip' }).click();
  await expect(dialog.getByLabel('Estimate')).toHaveText(/^\$0\.80\./);
  await dialog.getByLabel('What to make').fill('Waves rolling onto a beach');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await page
    .getByRole('dialog', { name: 'Make this with Google Gemini Omni?' })
    .getByRole('button', { name: 'Make it' })
    .click();
  await expect
    .poll(async () => (await jobs(page, videoId)).find((j) => j.kind === 'video')?.stage, {
      timeout: 60_000,
    })
    .toBe('waiting');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole('listitem', { name: 'Generated picture 1.png' })).toBeVisible();
  await panel.getByRole('button', { name: 'Add Generated picture 1.png at the playhead' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Timeline' })
      .getByRole('button', { name: /^Generated picture 1\.png, / }),
  ).toBeVisible();

  first.app.process().kill('SIGKILL');
  await closeApp(first.app).catch(() => undefined);
  opened.splice(opened.indexOf(first), 1);
  gen.finishClips();

  const second = await launch(first.root);
  opened.push(second);
  await expect
    .poll(async () => (await jobs(second.page, videoId)).find((j) => j.kind === 'video')?.status, {
      timeout: 120_000,
    })
    .toBe('done');
  await second.page.evaluate((id) => (window as unknown as Bridge).runova.studio.open(id), videoId);
  await expect
    .poll(
      async () =>
        (
          await second.page.evaluate(
            (id) => (window as unknown as Bridge).runova.studioMedia.list(id),
            videoId,
          )
        )
          .map((m) => `${m.name}:${m.kind}`)
          .sort(),
      { timeout: 60_000 },
    )
    .toEqual(['Generated clip 1.mp4:video', 'Generated picture 1.png:image']);
  // The job is marked imported just after the media item is saved, so it can trail the list.
  await expect
    .poll(async () => (await jobs(second.page, videoId)).find((j) => j.kind === 'video'), {
      timeout: 10_000,
    })
    .toMatchObject({ resumed: true, mediaName: 'Generated clip 1.mp4' });
  const files = await second.page.evaluate(
    (id) => (window as unknown as Bridge).runova.studioMedia.list(id),
    videoId,
  );
  // The clip came through whole: 8 seconds, as made.
  expect(Math.round((files.find((m) => m.kind === 'video')?.duration ?? 0) / 705_600_000)).toBe(8);
  // Only one clip was asked for: the restart carried on, it did not ask again.
  expect(gen.requests.filter((r) => r.path === '/v1beta/interactions')).toHaveLength(2);
});
