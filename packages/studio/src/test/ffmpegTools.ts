import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FfmpegTools } from '../node/render/ffmpegTool.js';

const FAKE = fileURLToPath(new URL('./fakeFfmpeg.mjs', import.meta.url));

/** ffmpeg and ffprobe played by `fakeFfmpeg.mjs`; set `FAKE_FFMPEG` to make them misbehave. */
export const fakeTools: FfmpegTools = {
  ffmpeg: { file: process.execPath, args: [FAKE, 'ffmpeg'] },
  ffprobe: { file: process.execPath, args: [FAKE, 'ffprobe'] },
};

/** The real ffmpeg and ffprobe on PATH, or null when this machine has none. */
export function realTools(): FfmpegTools | null {
  const found = (name: string) =>
    spawnSync(name, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0;
  return found('ffmpeg') && found('ffprobe')
    ? { ffmpeg: { file: 'ffmpeg' }, ffprobe: { file: 'ffprobe' } }
    : null;
}
