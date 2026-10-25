import { join } from 'node:path';
import { type FfmpegTools, runTool } from '../node/render/ffmpegTool.js';

/**
 * Small real media files made by ffmpeg for tests: a 3 s test-pattern video with a tone, a
 * 1.5 s tone, a test-pattern still, and a song with cover art.
 */
export async function makeSampleMedia(tools: FfmpegTools, dir: string) {
  const q = ['-v', 'error', '-y'];
  const clip = join(dir, 'clip.mp4');
  const tone = join(dir, 'tone.wav');
  const still = join(dir, 'still.png');
  const song = join(dir, 'song.mp3');
  const lavfi = (source: string) => ['-f', 'lavfi', '-i', source];
  await runTool(tools.ffmpeg, [
    ...q,
    ...lavfi('testsrc=s=1280x720:r=25:d=3'),
    ...lavfi('sine=d=3'),
    '-shortest',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    clip,
  ]);
  await runTool(tools.ffmpeg, [...q, ...lavfi('sine=d=1.5'), tone]);
  await runTool(tools.ffmpeg, [...q, ...lavfi('testsrc=s=64x64:d=0.04'), '-frames:v', '1', still]);
  await runTool(tools.ffmpeg, [
    ...q,
    '-i',
    tone,
    '-i',
    still,
    '-map',
    '0',
    '-map',
    '1',
    '-c:a',
    'libmp3lame',
    '-c:v',
    'png',
    '-disposition:v',
    'attached_pic',
    song,
  ]);
  return { clip, tone, still, song };
}
