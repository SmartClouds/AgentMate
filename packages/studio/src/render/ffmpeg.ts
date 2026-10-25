import type { Codec, Quality, RenderSettings } from '../document/schema.js';
import type { RenderPlan } from './plan.js';

/**
 * The ffmpeg command lines a render runs, built as plain argument arrays (never one shell string),
 * so a title or a path with spaces or Persian letters can never change what runs. Pure, and tested
 * against golden output, because a wrong offset here is a wrong frame in someone's video.
 */

export type HardwareEncoder = 'nvenc' | 'qsv' | 'amf' | 'videotoolbox';

export interface FfmpegCapabilities {
  /** `9.0.2`, or null for a git build that names no release. */
  version: string | null;
  encoders: ReadonlySet<string>;
  filters: ReadonlySet<string>;
}

const SOFTWARE: Record<Codec, string> = { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9' };

const HARDWARE: Record<HardwareEncoder, Partial<Record<Codec, string>>> = {
  nvenc: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv', vp9: 'vp9_qsv' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf' },
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
};

/** The encoder ffmpeg names for a codec on a given hardware encoder, if it has one. */
export function hardwareEncoderName(hw: HardwareEncoder, codec: Codec): string | undefined {
  return HARDWARE[hw][codec];
}

/** Why a codec cannot be used with this ffmpeg, or null when it can. */
export function codecProblem(codec: Codec, caps: FfmpegCapabilities): string | null {
  const name = SOFTWARE[codec];
  if (caps.encoders.has(name)) return null;
  return `This ffmpeg has no ${name} encoder, so ${codec.toUpperCase()} is not available. The full build from Dev Setup has it.`;
}

/** The hardware encoder names this ffmpeg was built with, in the order they are tried. */
export function hardwareCandidates(codec: Codec, caps: FfmpegCapabilities): string[] {
  return (Object.keys(HARDWARE) as HardwareEncoder[])
    .map((hw) => HARDWARE[hw][codec])
    .filter((name): name is string => !!name && caps.encoders.has(name));
}

const CRF: Record<Codec, Record<Quality, number>> = {
  h264: { draft: 28, standard: 22, high: 19, master: 15 },
  h265: { draft: 30, standard: 26, high: 22, master: 18 },
  vp9: { draft: 40, standard: 33, high: 28, master: 22 },
};
const PRESET: Record<Quality, string> = {
  draft: 'veryfast',
  standard: 'medium',
  high: 'slow',
  master: 'slower',
};
const NVENC_PRESET: Record<Quality, string> = {
  draft: 'p2',
  standard: 'p4',
  high: 'p6',
  master: 'p7',
};

/** Video encoder arguments for the codec and quality, on a hardware encoder when one is given. */
export function videoEncoderArgs(
  settings: Pick<RenderSettings, 'codec' | 'quality'>,
  hardware: string | null = null,
): string[] {
  const { codec, quality } = settings;
  const crf = String(CRF[codec][quality]);
  if (hardware) {
    const args = ['-c:v', hardware];
    if (hardware.endsWith('_nvenc'))
      args.push('-preset', NVENC_PRESET[quality], '-cq', crf, '-b:v', '0');
    else if (hardware.endsWith('_qsv')) args.push('-global_quality', crf);
    else if (hardware.endsWith('_amf')) args.push('-rc', 'cqp', '-qp_i', crf, '-qp_p', crf);
    else if (hardware.endsWith('_videotoolbox')) args.push('-q:v', String(100 - Number(crf) * 2));
    args.push('-pix_fmt', 'yuv420p');
    if (codec === 'h265') args.push('-tag:v', 'hvc1');
    return args;
  }
  if (codec === 'vp9') {
    return [
      '-c:v',
      'libvpx-vp9',
      '-crf',
      crf,
      '-b:v',
      '0',
      '-row-mt',
      '1',
      '-deadline',
      quality === 'draft' ? 'realtime' : 'good',
      '-cpu-used',
      quality === 'draft' ? '6' : '2',
      '-pix_fmt',
      'yuv420p',
    ];
  }
  const args = [
    '-c:v',
    SOFTWARE[codec],
    '-preset',
    PRESET[quality],
    '-crf',
    crf,
    '-pix_fmt',
    'yuv420p',
  ];
  if (codec === 'h265') args.push('-tag:v', 'hvc1');
  return args;
}

export function containerFor(codec: Codec): 'mp4' | 'webm' {
  return codec === 'vp9' ? 'webm' : 'mp4';
}

export interface ChunkArgsInput {
  /** The output size; frames that come in another size are scaled to it. */
  width: number;
  height: number;
  /** The size frames arrive in, when the window drew them at another size (a scaled display). */
  input?: { width: number; height: number };
  fps: number;
  output: string;
}

/**
 * Captured frames (raw BGRA on stdin) to one lossless chunk file. FFV1, intra only: every frame
 * stands alone, so chunks join without re-encoding and a resumed render reuses them as they are.
 */
export function chunkArgs(input: ChunkArgsInput): string[] {
  const from = input.input ?? input;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'bgra',
    '-s',
    `${from.width}x${from.height}`,
    '-r',
    String(input.fps),
    '-i',
    '-',
  ];
  if (from.width !== input.width || from.height !== input.height) {
    args.push('-vf', `scale=${input.width}:${input.height}:flags=lanczos`);
  }
  args.push(
    '-c:v',
    'ffv1',
    '-level',
    '3',
    '-g',
    '1',
    '-slices',
    '16',
    '-pix_fmt',
    'yuv444p',
    input.output,
  );
  return args;
}

/** Seconds as ffmpeg reads them, exact to the microsecond so offsets land on frames. */
function seconds(frames: number, fps: number): string {
  return (frames / fps).toFixed(6);
}

/**
 * The filter graph that joins the scenes: each scene's frames, put on one time base, then joined
 * to the next with its `xfade` transition or a plain cut. Each transition starts where the video so
 * far ends less the transition's length, so its overlap comes out of both scenes.
 */
export function assemblyGraph(plan: RenderPlan): string {
  const lines: string[] = [];
  plan.scenes.forEach((_, i) => {
    lines.push(`[${i}:v]settb=AVTB,fps=${plan.fps},setpts=PTS-STARTPTS,format=yuv420p[s${i}]`);
  });
  let current = 's0';
  let frames = plan.scenes[0]?.frames ?? 0;
  for (let i = 1; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (!scene) continue;
    const transition = plan.transitions.find((t) => t.after === i - 1);
    const label = i === plan.scenes.length - 1 ? 'vout' : `j${i}`;
    if (transition) {
      const offset = frames - transition.frames;
      lines.push(
        `[${current}][s${i}]xfade=transition=${transition.kind}:duration=${seconds(transition.frames, plan.fps)}:offset=${seconds(offset, plan.fps)}[${label}]`,
      );
      frames = frames + scene.frames - transition.frames;
    } else {
      lines.push(`[${current}][s${i}]concat=n=2:v=1:a=0[${label}]`);
      frames += scene.frames;
    }
    current = label;
  }
  if (plan.scenes.length === 1) lines.push('[s0]null[vout]');
  return `${lines.join(';\n')}\n`;
}

/** Whether this ffmpeg takes a filter graph file as `-/filter_complex` (7.1 and later). */
export function readsFilterFileOption(version: string | null): boolean {
  if (!version) return true; // A git build is newer than any release with the old option only.
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 7 || (major === 7 && minor >= 1);
}

export interface AssemblyInput {
  plan: RenderPlan;
  /** One concat list per scene, naming that scene's chunk files in order. */
  sceneLists: string[];
  graphFile: string;
  output: string;
  version: string | null;
  hardware?: string | null;
}

/**
 * The command that turns the scene chunks into the finished file. The graph goes in a file, which
 * keeps a long video's command line clear of the 32 KB limit on Windows. Until voice arrives (E36)
 * the video carries a silent stereo track, since some players and sites expect one.
 */
export function assemblyArgs(input: AssemblyInput): string[] {
  const { plan } = input;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  for (const list of input.sceneLists) args.push('-f', 'concat', '-safe', '0', '-i', list);
  const audioIndex = input.sceneLists.length;
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(readsFilterFileOption(input.version) ? '-/filter_complex' : '-filter_complex_script');
  args.push(input.graphFile);
  args.push('-map', '[vout]', '-map', `${audioIndex}:a`);
  args.push(...videoEncoderArgs(plan.settings, input.hardware ?? null));
  if (containerFor(plan.settings.codec) === 'webm') args.push('-c:a', 'libopus', '-b:a', '128k');
  else args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
  args.push(
    '-r',
    String(plan.fps),
    '-frames:v',
    String(plan.totalFrames),
    '-shortest',
    input.output,
  );
  return args;
}

export interface FfmpegProgress {
  frame: number | null;
  /** Microseconds of output written. */
  outTimeUs: number | null;
  done: boolean;
}

/** Reads ffmpeg's `-progress` output: `key=value` lines, a block per update. */
export function parseProgress(text: string): FfmpegProgress {
  let frame: number | null = null;
  let outTimeUs: number | null = null;
  let done = false;
  for (const line of text.split(/\r?\n/)) {
    const [key, value] = line.split('=', 2);
    if (key === 'frame' && value && /^\d+$/.test(value)) frame = Number(value);
    else if ((key === 'out_time_us' || key === 'out_time_ms') && value && /^\d+$/.test(value)) {
      outTimeUs = Number(value);
    } else if (key === 'progress' && value === 'end') done = true;
  }
  return { frame, outTimeUs, done };
}

/** Reads `ffmpeg -version`, `-encoders` and `-filters` output into capabilities. */
export function parseCapabilities(
  versionText: string,
  encodersText: string,
  filtersText: string,
): FfmpegCapabilities {
  const version =
    /ffmpeg version (\d+\.\d+(?:\.\d+)?)/.exec(versionText.split(/\r?\n/)[0] ?? '')?.[1] ?? null;
  // Both listings open with a legend ("V..... = Video") that ends at a line of dashes.
  const names = (text: string, pattern: RegExp) => {
    const set = new Set<string>();
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^\s*-{3,}\s*$/.test(line)) + 1;
    for (const line of lines.slice(start)) {
      const match = pattern.exec(line);
      if (match?.[1]) set.add(match[1]);
    }
    return set;
  };
  return {
    version,
    // " V....D libx264              libx264 H.264 ..."
    encoders: names(encodersText, /^\s*[VAS][A-Z.]{5}\s+(\S+)/),
    // " ... xfade             VV->V      Cross fade ..."
    filters: names(filtersText, /^\s*[T.][S.][C.]?\s+(\S+)\s/),
  };
}
