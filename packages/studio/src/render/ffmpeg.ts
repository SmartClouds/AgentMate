import type { Codec, Quality, RenderSettings } from '../document/schema.js';
import type { PlannedAudio, RenderPlan } from './plan.js';

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

/** Seconds with six decimals, as ffmpeg reads them. */
function secs(value: number): string {
  return value.toFixed(6);
}

/**
 * The filter graph that joins the scenes: each scene's frames, put on one time base, then joined
 * to the next with its `xfade` transition or a plain cut. Each transition starts where the video so
 * far ends less the transition's length, so its overlap comes out of both scenes. Then the clips
 * over the scenes are laid on top, each for its own stretch of time, and the sound is mixed.
 */
export function assemblyGraph(plan: RenderPlan, loudnorm: LoudnormMeasure | null = null): string {
  const overlays = plan.overlays ?? [];
  const audio = plan.audio ?? [];
  const lines: string[] = [];
  const scenesOut = overlays.length > 0 ? 'vbase' : 'vout';
  plan.scenes.forEach((_, i) => {
    lines.push(`[${i}:v]settb=AVTB,fps=${plan.fps},setpts=PTS-STARTPTS,format=yuv420p[s${i}]`);
  });
  let current = 's0';
  let frames = plan.scenes[0]?.frames ?? 0;
  for (let i = 1; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    if (!scene) continue;
    const transition = plan.transitions.find((t) => t.after === i - 1);
    const label = i === plan.scenes.length - 1 ? scenesOut : `j${i}`;
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
  if (plan.scenes.length === 1) lines.push(`[s0]null[${scenesOut}]`);

  // Each clip is fitted inside the frame (bars where its shape differs: black for a video,
  // see-through for a picture or caption), faded, and shifted to start at its own time.
  const first = plan.scenes.length;
  current = scenesOut;
  overlays.forEach((overlay, k) => {
    const length = overlay.frames / plan.fps;
    const start = overlay.startFrame / plan.fps;
    const bars = overlay.kind === 'video' ? 'black' : 'black@0';
    let chain = `[${first + k}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=${bars},format=yuva420p,fps=${plan.fps}`;
    if (overlay.fadeInSeconds > 0)
      chain += `,fade=t=in:st=0:d=${secs(overlay.fadeInSeconds)}:alpha=1`;
    if (overlay.fadeOutSeconds > 0)
      chain += `,fade=t=out:st=${secs(length - overlay.fadeOutSeconds)}:d=${secs(overlay.fadeOutSeconds)}:alpha=1`;
    lines.push(`${chain},setpts=PTS-STARTPTS+${secs(start)}/TB[o${k}]`);
    const label = k === overlays.length - 1 ? 'vout' : `l${k}`;
    lines.push(
      `[${current}][o${k}]overlay=0:0:eof_action=pass:enable='between(t,${secs(start)},${secs(start + length)})'[${label}]`,
    );
    current = label;
  });

  if (audio.length > 0) {
    lines.push(...audioGraphLines(plan, first + overlays.length, loudnorm ?? 'none'));
  }
  return `${lines.join(';\n')}\n`;
}

/** loudnorm's first-pass measurements, which the second pass needs to hit the target exactly. */
export interface LoudnormMeasure {
  inputI: string;
  inputTp: string;
  inputLra: string;
  inputThresh: string;
  targetOffset: string;
}

/**
 * The mix: each sound on one format, faded, set to its volume, delayed to its start; all summed
 * without lowering any (amix would otherwise divide by the count); padded or cut to the video's
 * length; then brought to the loudness target. `measure` prints loudnorm's measurements instead.
 */
function audioGraphLines(
  plan: RenderPlan,
  firstInput: number,
  loudnorm: LoudnormMeasure | 'measure' | 'none',
): string[] {
  const audio = plan.audio ?? [];
  const lines: string[] = [];
  audio.forEach((sound, k) => {
    let chain = `[${firstInput + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS`;
    if (sound.fadeInSeconds > 0) chain += `,afade=t=in:st=0:d=${secs(sound.fadeInSeconds)}`;
    if (sound.fadeOutSeconds > 0)
      chain += `,afade=t=out:st=${secs(sound.seconds - sound.fadeOutSeconds)}:d=${secs(sound.fadeOutSeconds)}`;
    chain += `,volume=${sound.gain.toFixed(4)},adelay=${Math.round(sound.startSeconds * 1000)}:all=1`;
    lines.push(`${chain}[a${k}]`);
  });
  const mix = (labels: string[], out: string) =>
    labels.length > 1
      ? `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0[${out}]`
      : `${labels.join('')}anull[${out}]`;
  const labelsOf = (roles: PlannedAudio['role'][]) =>
    audio.flatMap((sound, k) => (roles.includes(sound.role) ? [`[a${k}]`] : []));
  const envelope = plan.duck ? duckEnvelope(audio) : null;
  const music = labelsOf(['music']);
  if (envelope && music.length > 0) {
    // The music, turned down while a voice plays. The voice clips' times are known, so this is a
    // volume curve rather than a compressor listening to the voice: the same every render.
    lines.push(mix(music, 'music'));
    lines.push(`[music]volume='${envelope}':eval=frame[ducked]`);
    lines.push(mix([...labelsOf(['voice', 'other']), '[ducked]'], 'amix'));
  } else {
    lines.push(
      mix(
        audio.map((_, k) => `[a${k}]`),
        'amix',
      ),
    );
  }
  const target = plan.loudness ?? -14;
  let tail = `[amix]apad,atrim=0:${secs(plan.totalFrames / plan.fps)},asetpts=PTS-STARTPTS`;
  if (loudnorm === 'measure') tail += `,loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`;
  else if (loudnorm !== 'none') {
    tail += `,loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${loudnorm.inputI}:measured_TP=${loudnorm.inputTp}:measured_LRA=${loudnorm.inputLra}:measured_thresh=${loudnorm.inputThresh}:offset=${loudnorm.targetOffset}:linear=true,aresample=48000`;
  }
  lines.push(`${tail}[aout]`);
  return lines;
}

/** How far music drops under a voice (about 10 dB), and how long it takes to get there. */
export const DUCK_LEVEL = 0.3;
export const DUCK_RAMP_SECONDS = 0.25;

/**
 * The music's volume over time as an ffmpeg expression in `t`: 1, easing down to DUCK_LEVEL a ramp
 * before each stretch of voice and back up a ramp after it. Voices less than two ramps apart count
 * as one stretch, so the music does not bob up between sentences. Null when nothing speaks.
 */
export function duckEnvelope(audio: readonly PlannedAudio[]): string | null {
  const spans = audio
    .filter((sound) => sound.role === 'voice' && sound.gain > 0)
    .map((sound) => [sound.startSeconds, sound.startSeconds + sound.seconds] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] - last[1] < DUCK_RAMP_SECONDS * 2) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  if (merged.length === 0) return null;
  const r = secs(DUCK_RAMP_SECONDS);
  // Each stretch is a trapezoid from 0 to 1; the deepest one at any moment sets the drop.
  const shapes = merged.map(
    ([from, to]) =>
      `min(clip((t-${secs(from)}+${r})/${r},0,1),clip((${secs(to)}+${r}-t)/${r},0,1))`,
  );
  const depth = shapes.reduce((all, shape) => `max(${all},${shape})`);
  return `1-${(1 - DUCK_LEVEL).toFixed(2)}*${depth}`;
}

/** Whether this ffmpeg takes a filter graph file as `-/filter_complex` (7.1 and later). */
export function readsFilterFileOption(version: string | null): boolean {
  if (!version) return true; // A git build is newer than any release with the old option only.
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 7 || (major === 7 && minor >= 1);
}

function graphOption(version: string | null): string {
  return readsFilterFileOption(version) ? '-/filter_complex' : '-filter_complex_script';
}

/** Inputs for the clips over the scenes: a video from where the clip starts, a still looped. */
function overlayInputs(plan: RenderPlan, files: readonly string[]): string[] {
  const args: string[] = [];
  (plan.overlays ?? []).forEach((overlay, k) => {
    const length = secs(overlay.frames / plan.fps);
    const file = files[k] as string;
    if (overlay.kind === 'video')
      args.push('-ss', secs(overlay.inSeconds), '-t', length, '-i', file);
    else args.push('-loop', '1', '-framerate', String(plan.fps), '-t', length, '-i', file);
  });
  return args;
}

function audioInputs(plan: RenderPlan, files: readonly string[]): string[] {
  return (plan.audio ?? []).flatMap((sound, k) => [
    '-ss',
    secs(sound.inSeconds),
    '-t',
    secs(sound.seconds),
    '-i',
    files[k] as string,
  ]);
}

export interface AssemblyInput {
  plan: RenderPlan;
  /** One concat list per scene, naming that scene's chunk files in order. */
  sceneLists: string[];
  /** One per overlay in the plan: the media file, or the caption's still. */
  overlayFiles?: string[];
  /** One per sound in the plan. */
  audioFiles?: string[];
  graphFile: string;
  output: string;
  version: string | null;
  hardware?: string | null;
}

/**
 * The command that turns the scene chunks and the clips into the finished file. The graph goes in
 * a file, which keeps a long video's command line clear of the 32 KB limit on Windows. A video with
 * no sound still carries a silent stereo track, since some players and sites expect one.
 */
export function assemblyArgs(input: AssemblyInput): string[] {
  const { plan } = input;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  for (const list of input.sceneLists) args.push('-f', 'concat', '-safe', '0', '-i', list);
  args.push(...overlayInputs(plan, input.overlayFiles ?? []));
  const silent = (plan.audio ?? []).length === 0;
  const silentIndex = input.sceneLists.length + (plan.overlays ?? []).length;
  if (silent) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  else args.push(...audioInputs(plan, input.audioFiles ?? []));
  args.push(graphOption(input.version), input.graphFile);
  args.push('-map', '[vout]', '-map', silent ? `${silentIndex}:a` : '[aout]');
  args.push(...videoEncoderArgs(plan.settings, input.hardware ?? null));
  if (containerFor(plan.settings.codec) === 'webm') args.push('-c:a', 'libopus', '-b:a', '128k');
  else args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
  args.push('-r', String(plan.fps), '-frames:v', String(plan.totalFrames));
  if (silent) args.push('-shortest');
  args.push(input.output);
  return args;
}

/** The mix alone, for loudnorm's measuring pass: its graph and its command. */
export function loudnessGraph(plan: RenderPlan): string {
  return `${audioGraphLines(plan, 0, 'measure').join(';\n')}\n`;
}

export function loudnessArgs(input: {
  plan: RenderPlan;
  audioFiles: string[];
  graphFile: string;
  version: string | null;
}): string[] {
  return [
    '-hide_banner',
    '-nostats',
    ...audioInputs(input.plan, input.audioFiles),
    graphOption(input.version),
    input.graphFile,
    '-map',
    '[aout]',
    '-f',
    'null',
    '-',
  ];
}

/** Reads loudnorm's measurements from what it printed (the last JSON block in its output). */
export function parseLoudnorm(output: string): LoudnormMeasure | null {
  const start = output.lastIndexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const m = JSON.parse(output.slice(start, end + 1)) as Record<string, string>;
    const fields = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset];
    if (fields.some((f) => typeof f !== 'string' || !/^-?(\d+(\.\d+)?|inf)$/.test(f))) return null;
    // A silent mix measures -inf; there is nothing to bring to a loudness.
    if (fields.some((f) => f?.includes('inf'))) return null;
    return {
      inputI: m.input_i as string,
      inputTp: m.input_tp as string,
      inputLra: m.input_lra as string,
      inputThresh: m.input_thresh as string,
      targetOffset: m.target_offset as string,
    };
  } catch {
    return null;
  }
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
