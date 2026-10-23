import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Voice input in the Build Prompt dialog, in the real app. Chromium's fake microphone plays a tone
 * file, so recording, decoding and resampling all run for real. Only the Whisper call in the main
 * process is swapped out, since downloading and running a speech model has no place in a test
 * run. The swap records what reached it, which is the language each microphone asked for.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** A second of a loud 440 Hz tone, 16-bit mono at 48 kHz, as the fake microphone's input. */
function writeToneWav(path: string): void {
  const rate = 48_000;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767), i * 2);
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

async function launchWithMicrophone(settings: Record<string, unknown>): Promise<LaunchedApp> {
  const wav = join(
    process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
    `agentmate-tone-${Date.now()}.wav`,
  );
  writeToneWav(wav);
  const app = await launchApp({
    settings,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      // macOS sandboxes the audio service, and from there the tone file cannot be read, so the
      // fake microphone records silence.
      ...(process.platform === 'darwin' ? ['--no-sandbox'] : []),
    ],
  });
  await app.app.evaluate(({ ipcMain }) => {
    const heard: { language: string; samples: number }[] = [];
    (globalThis as { __heard?: typeof heard }).__heard = heard;
    ipcMain.removeHandler('speech:transcribe');
    ipcMain.handle(
      'speech:transcribe',
      (_event, input: { language: string; samples: Float32Array }) => {
        heard.push({ language: input.language, samples: input.samples.length });
        return { ok: true, text: `spoken words ${heard.length}` };
      },
    );
  });
  return app;
}

function heard(app: LaunchedApp): Promise<{ language: string; samples: number }[]> {
  return app.app.evaluate(
    () => (globalThis as { __heard?: { language: string; samples: number }[] }).__heard ?? [],
  );
}

async function openBuildPrompt(current: LaunchedApp): Promise<Page> {
  const { page } = current;
  await page.evaluate(
    async ({ folderPath }) => {
      const api = (
        window as unknown as {
          agentmat: { projects: { create(input: unknown): Promise<{ id: string }> } };
        }
      ).agentmat;
      await api.projects.create({
        name: 'Voice demo',
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [],
      });
    },
    { folderPath: current.projectDir },
  );
  await page.evaluate(() => {
    location.hash = '#/projects';
  });
  await page.reload();
  await page.getByRole('button', { name: 'Build a prompt for this project' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Build Prompt' })).toBeVisible();
  return page;
}

test('Speak prompt records from the microphone and writes the words as the prompt, in English', async () => {
  launched = await launchWithMicrophone({ speechLanguage: 'fa', speechModel: 'large-v3-turbo' });
  const current = launched;
  const page = await openBuildPrompt(current);
  const dialog = page.getByRole('dialog', { name: 'Build Prompt' });

  await dialog.getByRole('button', { name: 'Speak prompt' }).click();
  await expect(dialog.getByRole('button', { name: 'Stop and transcribe' })).toBeVisible();
  // Long enough for the recorder to hand over more than the silence guard's minimum.
  await page.waitForTimeout(1500);
  await dialog.getByRole('button', { name: 'Stop and transcribe' }).click();

  await expect(dialog.getByLabel('Generated prompt')).toHaveValue('spoken words 1');
  await expect(dialog.getByLabel('Your request')).toHaveValue('');
  const calls = await heard(current);
  expect(calls).toHaveLength(1);
  // Dictate is set to Persian here; Speak prompt still listens for English.
  expect(calls[0]?.language).toBe('en');
  // Resampled to Whisper's 16 kHz: over a second of recording is well over 16k samples.
  expect(calls[0]?.samples).toBeGreaterThan(16_000);

  // Dictate, on the other hand, listens for the language the chip shows.
  await expect(
    dialog.getByRole('button', { name: 'Dictation language: Persian (فارسی)' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Dictate', exact: true }).click();
  await page.waitForTimeout(1500);
  await dialog.getByRole('button', { name: 'Stop and transcribe' }).click();
  await expect(dialog.getByLabel('Your request')).toHaveValue('spoken words 2');
  expect((await heard(current))[1]?.language).toBe('fa');
});

test('Escape throws a recording away and keeps the dialog open', async () => {
  launched = await launchWithMicrophone({});
  const current = launched;
  const page = await openBuildPrompt(current);
  const dialog = page.getByRole('dialog', { name: 'Build Prompt' });

  await dialog.getByRole('button', { name: 'Speak prompt' }).click();
  await expect(dialog.getByRole('button', { name: 'Stop and transcribe' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(dialog.getByRole('button', { name: 'Speak prompt' })).toBeEnabled();
  await expect(dialog).toBeVisible();
  expect(await heard(current)).toHaveLength(0);
});

test('Persian picked in Settings is saved, survives a reload, and reaches the dialog', async () => {
  // An old profile still holding the auto-detect that used to be the default.
  launched = await launchApp({ settings: { speechLanguage: 'auto', speechModel: 'base' } });
  const current = launched;
  const { page } = current;

  await page.evaluate(() => {
    location.hash = '#/settings?tab=ai';
  });
  const language = page.getByRole('combobox', { name: 'Spoken language' });
  await expect(language).toBeVisible();
  await language.click();
  await page.getByRole('option', { name: 'Persian (فارسی)' }).click();
  // The small model is called out, and switching from the note marks the card dirty too.
  await page.getByRole('note').getByRole('button', { name: 'Use this model' }).click();
  await page.getByRole('button', { name: /Save changes/ }).click();

  await expect.poll(() => current.settingsOnDisk().speechLanguage).toBe('fa');
  expect(current.settingsOnDisk().speechModel).toBe('large-v3-turbo');

  await page.reload();
  await page.evaluate(() => {
    location.hash = '#/settings?tab=ai';
  });
  await expect(page.getByRole('combobox', { name: 'Spoken language' })).toHaveText(/Persian/);
  expect(current.settingsOnDisk().speechLanguage).toBe('fa');
});
