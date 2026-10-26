import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { SECONDS_PER_CHAR, startFakeTtsApis, TTS_KEY } from './fakeTtsApis';

/**
 * Studio's voice (E36) in the built app with the real ffmpeg: Persian scenes spoken by an online
 * engine (a fake OpenAI on loopback), each scene fitted to its voice, a scene captioned where its
 * words are spoken, another recorded through Chromium's fake microphone, an ElevenLabs key sealed
 * on disk, and a render whose length is the sum of the narrated scenes.
 *
 * It needs ffmpeg on PATH (Dev Setup installs it; the CI e2e runners have it).
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);
const FLICKS = 705_600_000;
const FPS = 24;
const FRAME = FLICKS / FPS;
const ONE = 'سلام. این ویدیوی آزمایشی است.';
const TWO = 'و این صحنه دوم است که خودم می‌خوانم.';

type Clip = { id: string; trackId: string; start: number; duration: number };
type Scene = { id: string; targetDuration: number; voiceRef: string | null };
type Bridge = {
  agentmat: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<{
        state: string;
        session: {
          status: { seq: number };
          document: { scenario: { scenes: Scene[] }; timeline: { clips: Clip[] } };
        };
      }>;
      applyEdits(input: unknown): Promise<{ ok: boolean }>;
    };
    studioScenes: { saveFiles(input: unknown): Promise<unknown> };
    studioAudio: {
      setKey(input: unknown): Promise<{ id: string; problem: string | null }[]>;
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

/** A 2.5 s tone for the fake microphone to hear. */
function writeToneWav(path: string): void {
  const rate = 48_000;
  const data = Buffer.alloc(rate * 2.5 * 2);
  for (let i = 0; i < rate * 2.5; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 9000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** A scene timed by its voice: the voice, half a second, up to a whole frame, at least 1 s. */
const fitted = (voice: number) => Math.max(FLICKS, Math.ceil((voice + FLICKS / 2) / FRAME) * FRAME);

const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

test('narrates Persian scenes, captions one by its voice, records another and renders them to length', async () => {
  test.setTimeout(300_000);
  const tts = await startFakeTtsApis();
  const tone = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `studio-voice-${Date.now()}.wav`,
  );
  writeToneWav(tone);
  const app = await launchApp({
    settings: { openaiApiKey: TTS_KEY },
    env: { AGENTMATE_STUDIO_TTS_URL: tts.url },
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${tone}`,
      // macOS sandboxes the audio service, which then cannot read the tone file.
      ...(process.platform === 'darwin' ? ['--no-sandbox'] : []),
    ],
  });
  opened.push(app);
  const page = app.page;
  try {
    const library = join(app.root, 'Videos', 'AgentMate Studio');
    const videoId = await page.evaluate(
      async ({ library, html, one, two }) => {
        const { studio, studioScenes } = (window as unknown as Bridge).agentmat;
        await studio.updateSettings({ defaultRoot: library });
        const video = await studio.create({
          title: 'Voice test',
          projectId: null,
          language: 'fa',
          aspect: '16:9',
        });
        const session = await studio.open(video.id);
        const scene = (id: string, narration: string) => ({
          id,
          title: id,
          narration,
          onScreenText: [],
          targetDuration: 705_600_000 * 3,
          timing: 'narration',
          visualKind: 'motion',
          visualBrief: '',
          transitionOut: null,
          musicCue: '',
          voiceRef: null,
          notes: '',
          code: { treeHash: null },
          params: {},
        });
        await studio.applyEdits({
          videoId: video.id,
          baseSeq: session.session.status.seq,
          ops: [
            { op: 'scene.add', index: 0, scene: scene('one', one) },
            { op: 'scene.add', index: 1, scene: scene('two', two) },
            {
              op: 'render.set',
              patch: { resolution: '720p', fps: 24, quality: 'draft', hwEncode: false },
            },
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
      { library, html: SCENE_HTML, one: ONE, two: TWO },
    );
    const doc = async () =>
      (await page.evaluate((id) => (window as unknown as Bridge).agentmat.studio.open(id), videoId))
        .session.document;

    await page.evaluate((id) => {
      location.hash = `#/studio/${id}`;
    }, videoId);
    await page.getByRole('radio', { name: 'Voice' }).click();
    const panel = page.getByRole('region', { name: 'Voice' });
    const row = (n: number) => panel.getByRole('listitem', { name: `Scene ${n}` });

    // Speak both scenes with OpenAI's first voice.
    await expect(panel.getByRole('button', { name: 'Speak every scene' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Speak every scene' }).click();
    await expect(row(1).getByText('OpenAI, alloy')).toBeVisible({ timeout: 60_000 });
    await expect(row(2).getByText('OpenAI, alloy')).toBeVisible({ timeout: 60_000 });
    expect(tts.requests.map((r) => r.text)).toEqual([ONE, TWO]);

    // Each scene is as long as its voice and a pause; each voice starts with its scene.
    let current = await doc();
    const voices = current.timeline.clips.filter((c) => c.trackId === 'track-voice');
    const [one, two] = current.scenario.scenes as [Scene, Scene];
    expect(voices.map((v) => v.start)).toEqual([0, one.targetDuration]);
    for (const [k, text] of [ONE, TWO].entries()) {
      const voice = voices[k] as Clip;
      expect(Math.abs(voice.duration - [...text].length * SECONDS_PER_CHAR * FLICKS)).toBeLessThan(
        FLICKS / 1000,
      );
      expect(current.scenario.scenes[k]?.targetDuration).toBe(fitted(voice.duration));
    }
    expect(two.voiceRef).toBe('openai:alloy');

    // Speaking again reuses every piece: nothing more is asked of the engine.
    await panel.getByRole('button', { name: 'Speak scene 1' }).click();
    await expect(page.getByRole('status', { name: 'Narration progress' })).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(tts.requests).toHaveLength(2);

    // Captions for scene 1, from its narration, inside the scene.
    await row(1).getByRole('button', { name: 'Caption' }).click();
    await expect
      .poll(
        async () => (await doc()).timeline.clips.filter((c) => c.trackId === 'track-text').length,
      )
      .toBe(2);

    // Scene 2 in the user's own voice, through the fake microphone.
    await row(2).getByRole('button', { name: 'Record scene 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record scene 2' });
    await expect(dialog.getByLabel('Narration to read')).toHaveText(TWO);
    await dialog.getByRole('button', { name: 'Start recording' }).click();
    await page.waitForTimeout(2_000);
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await dialog.getByRole('button', { name: 'Use this take' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(row(2).getByText('Your recording')).toBeVisible();
    current = await doc();
    const recorded = current.timeline.clips.find(
      (c) => c.trackId === 'track-voice' && c.start > 0,
    ) as Clip;
    expect(current.scenario.scenes[1]?.voiceRef).toBe('recording');
    expect(recorded.duration).toBeGreaterThan(FLICKS);
    expect(current.scenario.scenes[1]?.targetDuration).toBe(fitted(recorded.duration));

    // An ElevenLabs key is sealed on disk, never written out as it is.
    const engines = await page.evaluate(
      (key) =>
        (window as unknown as Bridge).agentmat.studioAudio.setKey({ engine: 'elevenlabs', key }),
      TTS_KEY,
    );
    expect(engines.find((e) => e.id === 'elevenlabs')?.problem).toBeNull();
    const secrets = join(app.userDataDir, 'data', 'studio', 'secrets.json');
    expect(existsSync(secrets)).toBe(true);
    expect(readFileSync(secrets, 'utf8')).not.toContain(TTS_KEY);

    // The render is as long as the narrated scenes, and carries their sound.
    const total = (current.scenario.scenes as Scene[]).reduce((s, c) => s + c.targetDuration, 0);
    await page.getByRole('button', { name: 'Render', exact: true }).click();
    const render = page.getByRole('dialog', { name: 'Render the video' });
    await render.getByRole('button', { name: 'Render', exact: true }).click();
    await page.keyboard.press('Escape');
    const renderJobs = () =>
      page.evaluate((id) => (window as unknown as Bridge).agentmat.studioRender.jobs(id), videoId);
    // Waits for the render to end either way, then names what went wrong if it failed.
    await expect
      .poll(
        async () => ['done', 'failed', 'cancelled'].includes((await renderJobs())[0]?.status ?? ''),
        {
          timeout: 180_000,
        },
      )
      .toBe(true);
    const [job] = await renderJobs();
    expect(job?.error ?? null).toBeNull();
    expect(job?.status).toBe('done');
    const probe = JSON.parse(
      spawnSync(
        'ffprobe',
        ['-v', 'error', '-count_packets', '-show_streams', '-of', 'json', job?.output as string],
        { encoding: 'utf8' },
      ).stdout,
    ) as { streams: { codec_type: string; nb_read_packets?: string }[] };
    const video = probe.streams.find((s) => s.codec_type === 'video');
    expect(Number(video?.nb_read_packets)).toBe(Math.round(total / FRAME));
    expect(probe.streams.some((s) => s.codec_type === 'audio')).toBe(true);
  } finally {
    await tts.stop();
  }
});
