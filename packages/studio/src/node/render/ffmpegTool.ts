import { type ChildProcess, spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import type { Writable } from 'node:stream';
import {
  type FfmpegCapabilities,
  type FfmpegProgress,
  parseCapabilities,
  parseProgress,
} from '../../render/ffmpeg.js';

/**
 * Running ffmpeg and ffprobe. A tool is a command plus arguments that go before the real ones, so
 * the host can hand in the ffmpeg it found and tests can hand in a stand-in script run by Node.
 * Everything runs below normal priority, so a render never makes the app feel slow.
 */

export interface ToolCommand {
  file: string;
  /** Arguments put before every call's own (a test script, for a stand-in). */
  args?: readonly string[];
}

export interface FfmpegTools {
  ffmpeg: ToolCommand;
  ffprobe: ToolCommand;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export class RenderCancelledError extends Error {
  constructor() {
    super('The render was cancelled.');
    this.name = 'RenderCancelledError';
  }
}

/** The last few KB of stderr, which is where ffmpeg says what went wrong. */
const STDERR_KEEP = 4096;

export interface FfmpegRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FfmpegProgress) => void;
  /** Feed stdin (raw frames). Without it, stdin is closed. */
  stdin?: boolean;
}

export interface FfmpegRun {
  stdin: Writable | null;
  /** Resolves when ffmpeg exits cleanly; rejects with FfmpegError or RenderCancelledError. */
  done: Promise<void>;
  kill(): void;
}

function lowerPriority(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not allowed here (some containers); it only makes the app less responsive during a render.
  }
}

export function startTool(
  tool: ToolCommand,
  args: readonly string[],
  options: FfmpegRunOptions = {},
): FfmpegRun {
  const child = spawn(tool.file, [...(tool.args ?? []), ...args], {
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  lowerPriority(child);
  let stderr = '';
  let progressText = '';
  let cancelled = false;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (!options.onProgress) return;
    progressText += chunk;
    // Each update ends with a progress=continue or progress=end line.
    let end = progressText.search(/progress=(continue|end)\r?\n/);
    while (end >= 0) {
      const lineEnd = progressText.indexOf('\n', end) + 1;
      options.onProgress(parseProgress(progressText.slice(0, lineEnd)));
      progressText = progressText.slice(lineEnd);
      end = progressText.search(/progress=(continue|end)\r?\n/);
    }
  });
  // A write after ffmpeg has gone fails with EPIPE; the exit below says why it went.
  child.stdin?.on('error', () => undefined);

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  const onAbort = () => {
    cancelled = true;
    kill();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`Could not start ${tool.file}: ${error.message}`, stderr, null));
    });
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new RenderCancelledError());
      else if (code === 0) resolve();
      else {
        const last = stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim();
        reject(new FfmpegError(last || `ffmpeg stopped with exit code ${code}.`, stderr, code));
      }
    });
  });
  return { stdin: child.stdin, done, kill };
}

export async function runTool(
  tool: ToolCommand,
  args: readonly string[],
  options: FfmpegRunOptions = {},
): Promise<void> {
  await startTool(tool, args, options).done;
}

/** Runs a short command and returns what it printed, or throws after `timeoutMs`. */
export function readTool(
  tool: ToolCommand,
  args: readonly string[],
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.file, [...(tool.args ?? []), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err = (err + chunk).slice(-STDERR_KEEP);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new FfmpegError(
          `${tool.file} did not answer within ${timeoutMs / 1000} seconds.`,
          err,
          null,
        ),
      );
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new FfmpegError(`Could not start ${tool.file}: ${error.message}`, err, null));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else
        reject(new FfmpegError(err.trim().split(/\r?\n/).pop() || `Exit code ${code}.`, err, code));
    });
  });
}

/** What this ffmpeg is and can do. */
export async function probeFfmpeg(tools: FfmpegTools): Promise<FfmpegCapabilities> {
  const [version, encoders, filters] = await Promise.all([
    readTool(tools.ffmpeg, ['-hide_banner', '-version']),
    readTool(tools.ffmpeg, ['-hide_banner', '-encoders']),
    readTool(tools.ffmpeg, ['-hide_banner', '-filters']),
  ]);
  return parseCapabilities(version, encoders, filters);
}

/**
 * Whether a hardware encoder really works here: being built in is not enough, it also needs the
 * GPU and its driver. One small frame tells.
 */
export async function encoderWorks(tools: FfmpegTools, encoder: string): Promise<boolean> {
  try {
    await runTool(tools.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=256x256:d=0.1',
      '-frames:v',
      '1',
      '-c:v',
      encoder,
      '-f',
      'null',
      '-',
    ]);
    return true;
  } catch {
    return false;
  }
}

/** The number of video frames in a file, counted (not guessed from the header). */
export async function countFrames(tools: FfmpegTools, file: string): Promise<number> {
  const out = await readTool(tools.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_packets',
    '-show_entries',
    'stream=nb_read_packets',
    '-of',
    'csv=p=0',
    file,
  ]);
  const frames = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(frames))
    throw new FfmpegError(`ffprobe could not count the frames of ${file}.`, out, 0);
  return frames;
}

export interface VideoFacts {
  width: number;
  height: number;
  frames: number;
  /** Frames per second, as the stream states it. */
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
}

/** What a finished file holds, to check it against the plan. */
export async function probeVideo(tools: FfmpegTools, file: string): Promise<VideoFacts> {
  const out = await readTool(tools.ffprobe, [
    '-v',
    'error',
    '-count_packets',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_packets',
    '-of',
    'json',
    file,
  ]);
  const streams = (JSON.parse(out) as { streams?: Record<string, unknown>[] }).streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new FfmpegError(`${file} has no video stream.`, out, 0);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const [num = 0, den = 1] = String(video.avg_frame_rate ?? '0/1')
    .split('/')
    .map(Number);
  return {
    width: Number(video.width),
    height: Number(video.height),
    frames: Number(video.nb_read_packets),
    fps: den ? num / den : 0,
    videoCodec: String(video.codec_name),
    audioCodec: audio ? String(audio.codec_name) : null,
  };
}
