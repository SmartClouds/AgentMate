import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@agentmat/studio';
import { describe, expect, it } from 'vitest';
import { findLocalVoiceTools, wavToWhisperSamples } from './localTools';

/** What Studio sees of its local voices, from the markers Dev Setup's installs write last. */

const os = process.platform === 'win32' ? 'win32' : process.platform;

function tools() {
  const root = mkdtempSync(join(tmpdir(), 'studio-tools-'));
  const put = (path: string, text = '') => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const python = (env: string) =>
    os === 'win32' ? `envs/${env}/Scripts/python.exe` : `envs/${env}/bin/python3`;
  const mark = (tool: string, files?: { path: string; size: number }[]) =>
    put(`${tool}.installed.json`, JSON.stringify({ tool, version: '1', installedAt: 1, files }));
  return { root, put, python, mark };
}

describe('findLocalVoiceTools', () => {
  it('finds nothing in an empty folder', async () => {
    const { root } = tools();
    expect(await findLocalVoiceTools(root, os)).toEqual({ piper: null, omnivoice: null });
  });

  it('offers Piper with the voices that are in place, and OmniVoice once its model is', async () => {
    const t = tools();
    t.mark('piper');
    t.put(t.python('piper'));
    t.mark('piper-voices');
    t.put('models/piper-voices/fa_IR-amir-medium.onnx');
    t.mark('omnivoice');
    t.put(t.python('omnivoice'));
    t.mark('omnivoice-weights', [{ path: 'audio_tokenizer/model.safetensors', size: 1 }]);
    const half = await findLocalVoiceTools(t.root, os);
    expect(half.piper?.voices).toEqual(['fa_IR-amir-medium']);
    expect(half.piper?.python).toBe(join(t.root, ...t.python('piper').split('/')));
    expect(half.omnivoice).toBeNull();
    t.put('models/omnivoice-weights/audio_tokenizer/model.safetensors');
    expect((await findLocalVoiceTools(t.root, os)).omnivoice?.modelDir).toBe(
      join(t.root, 'models', 'omnivoice-weights'),
    );
  });

  it('does not count an install whose Python was removed', async () => {
    const t = tools();
    t.mark('piper');
    expect((await findLocalVoiceTools(t.root, os)).piper).toBeNull();
  });
});

describe('wavToWhisperSamples', () => {
  it('turns a 24 kHz take into 16 kHz floats', () => {
    const pcm = new Int16Array(24_000).fill(16384);
    const samples = wavToWhisperSamples(encodeWav(new Uint8Array(pcm.buffer), 24_000));
    expect(samples.length).toBe(16_000);
    expect(samples[100]).toBeCloseTo(0.5, 3);
  });
});
