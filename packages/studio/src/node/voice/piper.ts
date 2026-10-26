import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STUDIO_PIPER } from '@runova/core';
import { TtsError } from './engines.js';
import { runLocal } from './localProcess.js';

/**
 * Piper on this computer (piper-tts in Studio's own Python, E37): one process per piece of text.
 * The text goes in a UTF-8 file rather than on the command line or through stdin, either of which
 * a Windows code page can mangle; the voice is a file Dev Setup downloaded and checked.
 */

export interface PiperSetup {
  /** The environment's Python. */
  python: string;
  /** Put before `-m piper`; the tests run a stand-in script this way. */
  prefixArgs?: readonly string[];
  /** Where the voice files are (`<name>.onnx` with its `.onnx.json`). */
  voicesDir: string;
  /** Scratch space for each piece's text and sound. */
  workDir: string;
}

/** Loading a voice takes a few seconds; then Piper speaks far faster than real time. */
const timeoutFor = (text: string) => 60_000 + text.length * 200;

export function createPiperSpeaker(setup: PiperSetup) {
  return async ({
    voice,
    text,
    signal,
  }: {
    voice: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array> => {
    if (!STUDIO_PIPER.voices.some((v) => v.id === voice)) {
      throw new TtsError('Pick one of the offered voices.', false);
    }
    await mkdir(setup.workDir, { recursive: true });
    const name = randomBytes(6).toString('hex');
    const input = join(setup.workDir, `${name}.txt`);
    const output = join(setup.workDir, `${name}.wav`);
    // One line: Piper speaks each line of its input, and pieces are sentences already.
    await writeFile(input, `${text.replace(/\s+/g, ' ').trim()}\n`, 'utf8');
    try {
      const result = await runLocal({
        command: setup.python,
        args: [
          ...(setup.prefixArgs ?? []),
          '-m',
          'piper',
          '-m',
          join(setup.voicesDir, `${voice}.onnx`),
          '-i',
          input,
          '-f',
          output,
          '--sentence-silence',
          '0.25',
        ],
        timeoutMs: timeoutFor(text),
        signal,
      });
      if (result.aborted) throw new TtsError('Stopped.', false);
      if (result.timedOut) throw new TtsError('Piper stopped responding.', true);
      if (result.code !== 0) {
        throw new TtsError(`Piper could not speak this. ${result.tail.at(-1) ?? ''}`.trim(), false);
      }
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  };
}
