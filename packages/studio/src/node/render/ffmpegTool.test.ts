import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FfmpegProgress } from '../../render/ffmpeg.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { useTempDirs } from '../../test/tempDir.js';
import {
  countFrames,
  encoderWorks,
  FfmpegError,
  probeFfmpeg,
  probeVideo,
  RenderCancelledError,
  readTool,
  runTool,
  startTool,
  type ToolCommand,
} from './ffmpegTool.js';

const tempDir = useTempDirs();
afterEach(() => {
  delete process.env.FAKE_FFMPEG;
});

/** A tool that runs a line of Node, for the cases the fake does not cover. */
const node = (code: string): ToolCommand => ({ file: process.execPath, args: ['-e', code, '--'] });

describe('probing ffmpeg', () => {
  it('reads the version, encoders and filters', async () => {
    const caps = await probeFfmpeg(fakeTools);
    expect(caps.version).toBe('9.0.2');
    expect([...caps.encoders]).toEqual(['libx264', 'h264_nvenc', 'ffv1', 'aac']);
    expect([...caps.filters]).toEqual(['xfade']);
  });

  it('trusts a hardware encoder only when a test frame encodes', async () => {
    process.env.FAKE_FFMPEG = JSON.stringify({ brokenEncoders: ['h264_nvenc'] });
    expect(await encoderWorks(fakeTools, 'h264_nvenc')).toBe(false);
    expect(await encoderWorks(fakeTools, 'libx264')).toBe(true);
  });
});

describe('reading a file', () => {
  it('counts frames and reads what a finished file holds', async () => {
    const file = join(await tempDir(), 'v.mp4');
    await writeFile(
      file,
      JSON.stringify({ frames: 72, width: 96, height: 54, fps: 24, codec: 'h264', audio: 'aac' }),
    );
    expect(await countFrames(fakeTools, file)).toBe(72);
    expect(await probeVideo(fakeTools, file)).toEqual({
      width: 96,
      height: 54,
      frames: 72,
      fps: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('says so when ffprobe prints no count, or the file has no video', async () => {
    const tools = { ffmpeg: fakeTools.ffmpeg, ffprobe: node('process.stdout.write("N/A")') };
    await expect(countFrames(tools, 'x.mkv')).rejects.toThrow(
      'ffprobe could not count the frames of x.mkv.',
    );
    const audioOnly = {
      ffmpeg: fakeTools.ffmpeg,
      ffprobe: node('process.stdout.write(JSON.stringify({streams:[{codec_type:"audio"}]}))'),
    };
    await expect(probeVideo(audioOnly, 'x.mp4')).rejects.toThrow('x.mp4 has no video stream.');
    const silent = { ffmpeg: fakeTools.ffmpeg, ffprobe: node('process.stdout.write("{}")') };
    await expect(probeVideo(silent, 'x.mp4')).rejects.toThrow('x.mp4 has no video stream.');
  });
});

describe('running a tool', () => {
  it('passes on the last lines of what a failing tool printed', async () => {
    const failing = node(
      'console.error("line one\\nInvalid argument\\nConversion failed!"); process.exit(1)',
    );
    const error = await runTool(failing, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).message).toBe('line one Invalid argument Conversion failed!');
    expect((error as FfmpegError).exitCode).toBe(1);
    await expect(runTool(node('process.exit(3)'), [])).rejects.toThrow(
      'ffmpeg stopped with exit code 3.',
    );
    await expect(readTool(node('console.error("bad"); process.exit(2)'), [])).rejects.toThrow(
      'bad',
    );
    await expect(readTool(node('process.exit(2)'), [])).rejects.toThrow('Exit code 2.');
  });

  it('says when the tool is not there', async () => {
    const missing = { file: join(await tempDir(), 'no-ffmpeg.exe') };
    await expect(runTool(missing, [])).rejects.toThrow(/^Could not start .*no-ffmpeg\.exe/);
    await expect(readTool(missing, [])).rejects.toThrow(/^Could not start .*no-ffmpeg\.exe/);
  });

  it('gives up on a tool that does not answer', async () => {
    await expect(readTool(node('setTimeout(() => {}, 10000)'), [], 100)).rejects.toThrow(
      'did not answer within 0.1 seconds.',
    );
  });

  it('stops the tool on cancel, even one cancelled before it began', async () => {
    const controller = new AbortController();
    const run = startTool(node('setTimeout(() => {}, 10000)'), [], { signal: controller.signal });
    controller.abort();
    await expect(run.done).rejects.toBeInstanceOf(RenderCancelledError);
    await expect(
      runTool(node('setTimeout(() => {}, 10000)'), [], { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RenderCancelledError);
  });

  it('reads progress blocks even when they arrive split across writes', async () => {
    const seen: FfmpegProgress[] = [];
    const script = [
      'const w = (s) => process.stdout.write(s);',
      'w("frame=1\\nout_time_us=41666\\nprog");',
      'setTimeout(() => w("ress=continue\\nframe=2\\nout_time_us=83333\\nprogress=continue\\nframe=3\\n"), 20);',
      'setTimeout(() => w("progress=end\\n"), 40);',
    ].join('');
    await runTool(node(script), [], { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { frame: 1, outTimeUs: 41_666, done: false },
      { frame: 2, outTimeUs: 83_333, done: false },
      { frame: 3, outTimeUs: null, done: true },
    ]);
  });
});
