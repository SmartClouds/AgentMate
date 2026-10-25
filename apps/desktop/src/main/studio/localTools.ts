import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STUDIO_PIPER } from '@agentmat/core';
import { installMarkerSchema, parseWav, studioToolPaths } from '@agentmat/studio';
import type { LocalVoiceTools } from '@agentmat/studio/node';

/**
 * What Dev Setup has installed of Studio's local voices (E37), read from the markers each install
 * writes last in `<userData>/studio-tools`, the same way Dev Setup's own check reads them. An
 * install counts only while what its marker names is still in place.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function marker(path: string) {
  try {
    return installMarkerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

export async function findLocalVoiceTools(root: string, os: string): Promise<LocalVoiceTools> {
  const paths = studioToolPaths(root, os);
  const env = async (tool: 'piper' | 'omnivoice') =>
    (await marker(paths.marker(tool))) && (await exists(paths.envPython(tool)))
      ? paths.envPython(tool)
      : null;

  const piperPython = await env('piper');
  const voicesDir = paths.modelsDir('piper-voices');
  const voices: string[] = [];
  if (piperPython && (await marker(paths.marker('piper-voices')))) {
    for (const voice of STUDIO_PIPER.voices) {
      if (await exists(join(voicesDir, `${voice.id}.onnx`))) voices.push(voice.id);
    }
  }

  const omniPython = await env('omnivoice');
  const weights = await marker(paths.marker('omnivoice-weights'));
  const modelDir = paths.modelsDir('omnivoice-weights');
  let weightsInPlace = weights !== null;
  for (const file of weights?.files ?? []) {
    if (!(await exists(join(modelDir, ...file.path.split('/'))))) weightsInPlace = false;
  }

  return {
    piper: piperPython ? { python: piperPython, voicesDir, voices } : null,
    omnivoice: omniPython && weightsInPlace ? { python: omniPython, modelDir } : null,
  };
}

/**
 * A take (16-bit mono WAV, as Studio makes them) as the 16 kHz float samples Whisper reads,
 * resampled by straight-line interpolation, which is plenty for recognising speech.
 */
export function wavToWhisperSamples(bytes: Uint8Array): Float32Array {
  const wav = parseWav(bytes);
  if (wav.bitsPerSample !== 16) throw new Error('Only 16-bit recordings can be transcribed.');
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + wav.dataOffset,
    wav.frames * wav.channels * 2,
  );
  const source = new Float32Array(wav.frames);
  for (let i = 0; i < wav.frames; i++) {
    source[i] = view.getInt16(i * wav.channels * 2, true) / 32768;
  }
  const ratio = wav.sampleRate / 16_000;
  const out = new Float32Array(Math.floor(wav.frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const left = Math.floor(at);
    const right = Math.min(left + 1, source.length - 1);
    const t = at - left;
    out[i] = (source[left] ?? 0) * (1 - t) + (source[right] ?? 0) * t;
  }
  return out;
}
