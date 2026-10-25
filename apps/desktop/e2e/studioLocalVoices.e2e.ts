import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { startFakeTtsApis, TTS_KEY } from './fakeTtsApis';

/**
 * Studio's local voices and voice profiles (E37) in the built app: Piper and OmniVoice point to
 * Dev Setup until they are installed, Dev Setup names their licenses before an install, and a
 * voice profile is recorded through Chromium's fake microphone, trimmed by the real ffmpeg, saved
 * only with consent, uploaded to a fake ElevenLabs on request and removed from it with the profile.
 *
 * The installs themselves download hash-pinned files (wheels, models), so they are covered by the
 * installer's tests and a real install, not here. Needs ffmpeg on PATH, like the other Studio specs.
 */

const hasFfmpeg = ['ffmpeg', 'ffprobe'].every(
  (tool) => spawnSync(tool, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0,
);
const SAID = 'سلام، این صدای من است.';

/** Six seconds of a tone, loud enough that trimming silence keeps it, for the fake microphone. */
function writeToneWav(path: string): void {
  const rate = 48_000;
  const seconds = 6;
  const data = Buffer.alloc(rate * seconds * 2);
  for (let i = 0; i < rate * seconds; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / rate) * 12_000), i * 2);
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

type Bridge = {
  agentmat: {
    studio: {
      updateSettings(p: unknown): Promise<unknown>;
      create(input: unknown): Promise<{ id: string }>;
      open(videoId: string): Promise<{ session: { status: { seq: number } } }>;
      applyEdits(input: unknown): Promise<unknown>;
    };
    studioAudio: { setKey(input: unknown): Promise<unknown> };
  };
};

const opened: LaunchedApp[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

test.skip(!hasFfmpeg, 'ffmpeg is not installed here; Dev Setup (Studio) installs it.');

test('points to Dev Setup for local voices, and makes a voice profile with consent', async () => {
  test.setTimeout(240_000);
  const tts = await startFakeTtsApis();
  const tone = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `studio-take-${Date.now()}.wav`,
  );
  writeToneWav(tone);
  const app = await launchApp({
    env: { AGENTMATE_STUDIO_TTS_URL: tts.url, AGENTMATE_STUDIO_TRANSCRIPT: SAID },
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${tone}`,
      ...(process.platform === 'darwin' ? ['--no-sandbox'] : []),
    ],
  });
  opened.push(app);
  const page = app.page;
  try {
    const videoId = await page.evaluate(
      async ({ library, key }) => {
        const { studio, studioAudio } = (window as unknown as Bridge).agentmat;
        await studio.updateSettings({ defaultRoot: library });
        await studioAudio.setKey({ engine: 'elevenlabs', key });
        const video = await studio.create({
          title: 'Voices',
          projectId: null,
          language: 'fa',
          aspect: '16:9',
        });
        const session = await studio.open(video.id);
        await studio.applyEdits({
          videoId: video.id,
          baseSeq: session.session.status.seq,
          ops: [
            {
              op: 'scene.add',
              index: 0,
              scene: {
                id: 'one',
                title: 'یک',
                narration: 'سلام دنیا.',
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
              },
            },
          ],
          label: 'Scene',
        });
        return video.id;
      },
      { library: join(app.root, 'Videos', 'AgentMate Studio'), key: TTS_KEY },
    );

    // Piper is not installed: the panel says so and leads to Dev Setup's Studio tools.
    await page.evaluate((id) => {
      location.hash = `#/studio/${id}`;
    }, videoId);
    await page.getByRole('radio', { name: 'Voice' }).click();
    const panel = page.getByRole('region', { name: 'Voice' });
    await panel.getByRole('combobox', { name: 'Voice engine' }).click();
    await page.getByRole('option', { name: 'Piper (on this computer) (not set up)' }).click();
    await expect(
      panel.getByText('Install Piper and its voices from Agent Tools, Dev Setup (Studio).'),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Open Dev Setup' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('stack=studio');

    // Dev Setup names OmniVoice's license before anything is downloaded.
    const studio = page.getByRole('region', { name: 'Studio' });
    await expect(studio.getByText('OmniVoice', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(studio.getByText('Piper', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Install OmniVoice', exact: true }).click();
    const agreements = page.getByRole('dialog', { name: 'Accept the agreements?' });
    await expect(
      agreements.getByText('OmniVoice model weights are CC BY-NC 4.0: non-commercial use only'),
    ).toBeVisible();
    await agreements.getByRole('button', { name: 'Cancel' }).click();

    // A voice profile, recorded and saved with consent.
    await page.evaluate((id) => {
      location.hash = `#/studio/${id}`;
    }, videoId);
    await page.getByRole('radio', { name: 'Voice' }).click();
    await panel.getByRole('button', { name: 'Voices' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Voices' });
    await expect(dialog.getByText('No voices yet')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'New voice' }).fill('Amin');
    await dialog.getByRole('button', { name: 'Record', exact: true }).click();
    await page.waitForTimeout(5_000);
    await dialog.getByRole('button', { name: 'Stop' }).click();
    await expect(dialog.getByLabel('What the take says')).toHaveValue(SAID, { timeout: 30_000 });
    const save = dialog.getByRole('button', { name: 'Save voice' });
    await expect(save).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await save.click();
    const amin = dialog.getByRole('listitem', { name: 'Amin' });
    await expect(amin).toBeVisible({ timeout: 30_000 });
    const profiles = JSON.parse(
      readFileSync(join(app.userDataDir, 'data', 'studio', 'voices', 'profiles.json'), 'utf8'),
    );
    expect(profiles.profiles[0]).toMatchObject({
      name: 'Amin',
      transcript: SAID,
      consent: { statement: expect.stringMatching(/^This is my own voice/) },
    });
    expect(profiles.profiles[0].seconds).toBeGreaterThan(3);

    // Uploaded to ElevenLabs once the person agrees, and removed from it with the profile.
    await amin.getByRole('button', { name: 'Upload to ElevenLabs' }).click();
    await page
      .getByRole('dialog', { name: 'Upload Amin to ElevenLabs?' })
      .getByRole('button', { name: 'Upload' })
      .click();
    await expect(amin.getByText('In ElevenLabs')).toBeVisible();
    expect(tts.requests.find((r) => r.path === 'POST /v1/voices/add')?.text).toBe('wav');
    await amin.getByRole('button', { name: 'Delete Amin' }).click();
    await page
      .getByRole('dialog', { name: 'Delete Amin?' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(dialog.getByText('No voices yet')).toBeVisible();
    expect(tts.requests.at(-1)?.path).toBe('DELETE /v1/voices/v-cloned');
  } finally {
    await tts.stop();
  }
});
