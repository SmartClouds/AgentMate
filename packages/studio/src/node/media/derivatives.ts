import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FfmpegTools, runTool } from '../render/ffmpegTool.js';

/**
 * What the editor shows of an imported file, made once and kept in the local cache: a small proxy
 * that seeks quickly in the preview (540p at most, a key frame every half second), a poster frame,
 * a strip of thumbnails for the timeline, and waveform peaks. The render always uses the original.
 */

export type DerivativeName = 'proxy' | 'poster' | 'sprite' | 'peaks';

export const DERIVATIVE_FILES: Record<DerivativeName, string> = {
  proxy: 'proxy.mp4',
  poster: 'poster.jpg',
  sprite: 'sprite.jpg',
  peaks: 'peaks.json',
};

/** Waveform resolution: peaks per second of sound. */
export const PEAKS_PER_SECOND = 100;
/** Thumbnails in a clip's strip. */
export const SPRITE_TILES = 10;

export interface DerivativeInput {
  source: string;
  kind: 'video' | 'audio' | 'image';
  seconds: number | null;
  hasAudio: boolean;
  /** This file's folder in the cache. */
  dir: string;
  signal?: AbortSignal;
}

/** Which files a kind of media gets. */
export function derivativesFor(kind: DerivativeInput['kind'], hasAudio: boolean): DerivativeName[] {
  if (kind === 'image') return ['poster'];
  if (kind === 'audio') return ['proxy', 'peaks'];
  return hasAudio ? ['proxy', 'poster', 'sprite', 'peaks'] : ['proxy', 'poster', 'sprite'];
}

const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];

/** ffmpeg arguments for one derivative, written to `output`. */
export function derivativeArgs(
  name: Exclude<DerivativeName, 'peaks'>,
  input: DerivativeInput,
  output: string,
): string[] {
  const seconds = input.seconds ?? 0;
  if (name === 'proxy') {
    if (input.kind === 'audio') {
      return [
        ...quiet,
        '-i',
        input.source,
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        output,
      ];
    }
    return [
      ...quiet,
      '-i',
      input.source,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      "scale=-2:'min(540,ih)':flags=bilinear,format=yuv420p",
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-g',
      '15',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      output,
    ];
  }
  if (name === 'poster') {
    const at = input.kind === 'video' ? Math.min(1, seconds / 2).toFixed(3) : '0';
    return [
      ...quiet,
      '-ss',
      at,
      '-i',
      input.source,
      '-frames:v',
      '1',
      '-vf',
      'scale=-2:180',
      '-q:v',
      '4',
      output,
    ];
  }
  // A strip of thumbnails taken evenly across the clip.
  const rate = seconds > 0 ? SPRITE_TILES / seconds : 1;
  return [
    ...quiet,
    '-i',
    input.source,
    '-vf',
    `fps=${rate.toFixed(6)},scale=-2:90,tile=${SPRITE_TILES}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    output,
  ];
}

/** The loudest sample in each slice of sound, 0 to 255, from 16-bit mono samples. */
export function peaksFromSamples(samples: Int16Array, perPeak: number): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += perPeak) {
    let max = 0;
    const end = Math.min(samples.length, i + perPeak);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j] as number);
      if (v > max) max = v;
    }
    peaks.push(Math.min(255, Math.round((max / 32768) * 255)));
  }
  return peaks;
}

const PEAK_RATE = 8000;

/** Reads the sound as mono 16-bit samples and turns it into peaks. */
async function readPeaks(tools: FfmpegTools, input: DerivativeInput): Promise<number[]> {
  const args = [
    ...quiet,
    '-i',
    input.source,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(PEAK_RATE),
    '-f',
    's16le',
    '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(tools.ffmpeg.file, [...(tools.ffmpeg.args ?? []), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err = (err + chunk).slice(-2000);
    });
    const onAbort = () => child.kill();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        reject(new Error(err.trim() || `ffmpeg stopped with exit code ${code}.`));
        return;
      }
      const all = Buffer.concat(chunks);
      const samples = new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2));
      resolve(peaksFromSamples(samples, PEAK_RATE / PEAKS_PER_SECOND));
    });
  });
}

/**
 * Makes each derivative this file does not have yet, writing it beside its final name and
 * renaming it into place, so a file that exists is a whole one. Returns what failed, by name.
 */
export async function makeDerivatives(
  tools: FfmpegTools,
  input: DerivativeInput,
  have: ReadonlySet<DerivativeName> = new Set(),
): Promise<Partial<Record<DerivativeName, string>>> {
  await mkdir(input.dir, { recursive: true });
  const failed: Partial<Record<DerivativeName, string>> = {};
  for (const name of derivativesFor(input.kind, input.hasAudio)) {
    if (have.has(name) || input.signal?.aborted) continue;
    const final = join(input.dir, DERIVATIVE_FILES[name]);
    const temp = final.replace(/(\.[a-z0-9]+)$/, '.part$1');
    try {
      if (name === 'peaks') {
        const peaks = await readPeaks(tools, input);
        await writeFile(temp, JSON.stringify({ perSecond: PEAKS_PER_SECOND, peaks }));
      } else {
        await runTool(tools.ffmpeg, derivativeArgs(name, input, temp), { signal: input.signal });
      }
      await rename(temp, final);
    } catch (error) {
      await rm(temp, { force: true });
      failed[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return failed;
}
