import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import { parseWav } from '../../voice/wav.js';
import { speak } from './engines.js';
import { createPiperSpeaker } from './piper.js';

const FAKE = join(__dirname, '..', '..', 'test', 'fakePiper.mjs');
const tempDir = useTempDirs();

async function setup() {
  const root = await tempDir();
  const voicesDir = join(root, 'voices');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(voicesDir);
  await writeFile(join(voicesDir, 'fa_IR-amir-medium.onnx'), 'model');
  const log = join(root, 'log.json');
  process.env.FAKE_PIPER_LOG = log;
  const piper = createPiperSpeaker({
    python: process.execPath,
    prefixArgs: [FAKE],
    voicesDir,
    workDir: join(root, 'work'),
  });
  return { root, piper, log };
}

describe('Piper on this computer', () => {
  it('speaks Persian text from a UTF-8 file with the chosen voice, and leaves nothing behind', async () => {
    const { root, piper, log } = await setup();
    const text = 'سلام.\nاین یک   آزمایش است.';
    const wav = parseWav(await piper({ voice: 'fa_IR-amir-medium', text }));
    expect(wav.sampleRate).toBe(22_050);
    const said = JSON.parse(await readFile(log, 'utf8'));
    expect(said.text).toBe('سلام. این یک آزمایش است.');
    expect(said.model).toBe(join(root, 'voices', 'fa_IR-amir-medium.onnx'));
    expect(wav.seconds).toBeCloseTo([...said.text].length * 0.05, 2);
    expect(await readdir(join(root, 'work'))).toEqual([]);
  });

  it('is what the narrator reaches through the engine call, and says when it is missing', async () => {
    const { piper } = await setup();
    const spoken = await speak({
      engine: 'piper',
      voice: 'fa_IR-amir-medium',
      text: 'سلام',
      lang: 'fa',
      keys: {},
      fetch,
      local: { piper },
    });
    expect(parseWav(spoken.wav).frames).toBeGreaterThan(0);
    await expect(
      speak({ engine: 'piper', voice: 'x', text: 'a', lang: 'fa', keys: {}, fetch }),
    ).rejects.toThrow(/^Piper is not installed yet\. Install Piper and its voices/);
    await expect(
      speak({
        engine: 'omnivoice',
        voice: 'x',
        text: 'a',
        lang: 'fa',
        keys: {},
        fetch,
        local: { piper },
      }),
    ).rejects.toThrow(/^OmniVoice is not installed yet/);
  });

  it('says why it failed, refuses a voice it does not offer, and stops when asked', async () => {
    const { piper } = await setup();
    await expect(piper({ voice: 'fa_IR-amir-medium', text: 'FAIL here' })).rejects.toThrow(
      'Piper could not speak this. RuntimeError: something broke inside onnxruntime',
    );
    await expect(piper({ voice: 'fa_IR-ganji-medium', text: 'سلام' })).rejects.toThrow(
      /Unable to find voice/,
    );
    await expect(piper({ voice: 'zz-made-up', text: 'سلام' })).rejects.toThrow(
      'Pick one of the offered voices.',
    );
    const controller = new AbortController();
    const hanging = piper({ voice: 'fa_IR-amir-medium', text: 'HANG', signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(hanging).rejects.toThrow('Stopped.');
  });
});
