import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp } from './app';
import { startFakeTtsApis, TTS_KEY } from './fakeTtsApis';

/**
 * Studio's crash drills (E39): the app is killed outright (SIGKILL, as a crash or a power cut ends
 * it) right after a burst of edits, and in the middle of narrating. After the restart every edit
 * the app said was saved is there (AC4), and narration carries on without asking the engine again
 * for what it already said. The drill in the middle of a render is studioRender.e2e.ts.
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);

type Session = {
  state: string;
  session: {
    status: { seq: number };
    document: { title: string; scenario: { scenes: { id: string; voiceRef: string | null }[] } };
  };
};
type Bridge = {
  runova: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<Session>;
      applyEdits(input: unknown): Promise<{ ok: boolean; status: { seq: number } }>;
    };
    studioAudio: {
      speak(input: unknown): Promise<unknown>;
      jobs(videoId: string): Promise<{ status: string; done: number; reused: number }[]>;
    };
  };
};

const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

function crash(app: LaunchedApp): Promise<void> {
  app.app.process().kill('SIGKILL');
  opened.splice(opened.indexOf(app), 1);
  return closeApp(app.app).catch(() => undefined);
}

const open = (page: Page, videoId: string) =>
  page.evaluate((id) => (window as unknown as Bridge).runova.studio.open(id), videoId);

test('keeps every acknowledged edit through a kill, one right after another', async () => {
  test.setTimeout(180_000);
  const first = await launchApp({});
  opened.push(first);
  const result = await first.page.evaluate(
    async (library) => {
      const { studio } = (window as unknown as Bridge).runova;
      await studio.updateSettings({ defaultRoot: library });
      const video = await studio.create({
        title: 'Drill',
        projectId: null,
        language: 'en',
        aspect: '16:9',
      });
      let seq = (await studio.open(video.id)).session.status.seq;
      // A burst of edits, each acknowledged before the next, the last one just before the kill.
      for (let n = 1; n <= 60; n++) {
        const done = await studio.applyEdits({
          videoId: video.id,
          baseSeq: seq,
          ops: [{ op: 'doc.set', field: 'title', value: `Drill ${n}` }],
          label: `Rename ${n}`,
        });
        if (!done.ok) throw new Error(`edit ${n} was refused`);
        seq = done.status.seq;
      }
      return { videoId: video.id, seq };
    },
    join(first.root, 'Videos', 'Runova Studio'),
  );
  await crash(first);

  const second = await launchApp({ reuseRoot: first.root });
  opened.push(second);
  const after = await open(second.page, result.videoId);
  expect(after.state).toBe('open');
  expect(after.session.status.seq).toBe(result.seq);
  expect(after.session.document.title).toBe('Drill 60');
});

test.describe(() => {
  test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

  test('narration killed part way carries on after the restart without asking again', async () => {
    test.setTimeout(240_000);
    const tts = await startFakeTtsApis();
    try {
      const launch = (reuseRoot?: string) =>
        launchApp({
          reuseRoot,
          settings: { openaiApiKey: TTS_KEY },
          env: { RUNOVA_STUDIO_TTS_URL: tts.url },
        });
      const first = await launch();
      opened.push(first);
      const videoId = await first.page.evaluate(
        async (library) => {
          const { studio } = (window as unknown as Bridge).runova;
          await studio.updateSettings({ defaultRoot: library });
          const video = await studio.create({
            title: 'Voice drill',
            projectId: null,
            language: 'en',
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
            ops: ['one', 'two', 'three'].map((id, index) => ({
              op: 'scene.add',
              index,
              scene: scene(id, `This is scene ${id}, said clearly.`),
            })),
            label: 'Scenes',
          });
          return video.id;
        },
        join(first.root, 'Videos', 'Runova Studio'),
      );

      // Each piece takes a while; the app is killed once the first scene is placed.
      tts.setDelay(1500);
      await first.page.evaluate(
        (id) =>
          (window as unknown as Bridge).runova.studioAudio.speak({
            videoId: id,
            sceneIds: ['one', 'two', 'three'],
            voiceRef: 'openai:alloy',
          }),
        videoId,
      );
      await expect
        .poll(
          async () =>
            (await open(first.page, videoId)).session.document.scenario.scenes.filter(
              (s) => s.voiceRef,
            ).length,
          { timeout: 60_000, intervals: [100] },
        )
        .toBeGreaterThanOrEqual(1);
      const asked = tts.requests.length;
      await crash(first);
      tts.setDelay(0);

      const second = await launch(first.root);
      opened.push(second);
      const before = await open(second.page, videoId);
      // The scene placed before the kill was an acknowledged edit: it is still there.
      expect(before.session.document.scenario.scenes[0]?.voiceRef).toBe('openai:alloy');
      await second.page.evaluate(
        (id) =>
          (window as unknown as Bridge).runova.studioAudio.speak({
            videoId: id,
            sceneIds: ['one', 'two', 'three'],
            voiceRef: 'openai:alloy',
          }),
        videoId,
      );
      await expect
        .poll(
          async () =>
            (
              await second.page.evaluate(
                (id) => (window as unknown as Bridge).runova.studioAudio.jobs(id),
                videoId,
              )
            )[0]?.status,
          {
            timeout: 60_000,
          },
        )
        .toBe('done');
      const [job] = await second.page.evaluate(
        (id) => (window as unknown as Bridge).runova.studioAudio.jobs(id),
        videoId,
      );
      // What was spoken before the kill came from the cache; only the rest was asked for.
      expect(job?.reused).toBeGreaterThanOrEqual(1);
      expect(tts.requests.length - asked).toBe(3 - (job?.reused ?? 0));
      const done = await open(second.page, videoId);
      expect(
        done.session.document.scenario.scenes.every((s) => s.voiceRef === 'openai:alloy'),
      ).toBe(true);
    } finally {
      await tts.stop();
    }
  });
});
