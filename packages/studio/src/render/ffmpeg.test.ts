import { describe, expect, it } from 'vitest';
import { createDocument, createScene } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import {
  assemblyArgs,
  assemblyGraph,
  chunkArgs,
  codecProblem,
  containerFor,
  type FfmpegCapabilities,
  hardwareCandidates,
  hardwareEncoderName,
  parseCapabilities,
  parseProgress,
  readsFilterFileOption,
  videoEncoderArgs,
} from './ffmpeg.js';
import { buildRenderPlan, type RenderPlan } from './plan.js';

const TREE = 'c'.repeat(64);

function planOf(scenes: Parameters<typeof createScene>[0][]): RenderPlan {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'en' });
  doc.scenario.scenes = scenes.map((s) => createScene({ code: { treeHash: TREE }, ...s }));
  const result = buildRenderPlan(doc, { runtimeVersion: '1' });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return result.plan;
}

function caps(encoders: string[], version: string | null = '9.0.2'): FfmpegCapabilities {
  return { version, encoders: new Set(encoders), filters: new Set(['xfade', 'concat']) };
}

describe('video encoder arguments', () => {
  it('uses x264 with a preset and CRF per quality', () => {
    expect(videoEncoderArgs({ codec: 'h264', quality: 'standard' })).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(videoEncoderArgs({ codec: 'h264', quality: 'draft' })).toContain('veryfast');
    expect(videoEncoderArgs({ codec: 'h264', quality: 'master' })).toContain('15');
  });

  it('tags H.265 as hvc1 so Apple players open it', () => {
    expect(videoEncoderArgs({ codec: 'h265', quality: 'high' })).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'slow',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hvc1',
    ]);
  });

  it('runs VP9 in constant quality, faster for a draft', () => {
    const high = videoEncoderArgs({ codec: 'vp9', quality: 'high' });
    expect(high.slice(0, 6)).toEqual(['-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0']);
    expect(high).toEqual(expect.arrayContaining(['good', '2']));
    expect(videoEncoderArgs({ codec: 'vp9', quality: 'draft' })).toEqual(
      expect.arrayContaining(['realtime', '6']),
    );
  });

  it('hands quality to each hardware encoder in the option it reads', () => {
    expect(videoEncoderArgs({ codec: 'h264', quality: 'standard' }, 'h264_nvenc')).toEqual([
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p4',
      '-cq',
      '22',
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p',
    ]);
    expect(videoEncoderArgs({ codec: 'h265', quality: 'standard' }, 'hevc_qsv')).toEqual([
      '-c:v',
      'hevc_qsv',
      '-global_quality',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hvc1',
    ]);
    expect(videoEncoderArgs({ codec: 'h264', quality: 'high' }, 'h264_amf')).toEqual(
      expect.arrayContaining(['-rc', 'cqp', '-qp_i', '19', '-qp_p', '19']),
    );
    expect(videoEncoderArgs({ codec: 'h264', quality: 'standard' }, 'h264_videotoolbox')).toEqual(
      expect.arrayContaining(['-q:v', '56']),
    );
  });

  it('puts VP9 in WebM and the rest in MP4', () => {
    expect(containerFor('vp9')).toBe('webm');
    expect(containerFor('h264')).toBe('mp4');
    expect(containerFor('h265')).toBe('mp4');
  });
});

describe('what this ffmpeg can do', () => {
  it('says why a codec is missing, and nothing when it is there', () => {
    expect(codecProblem('h264', caps(['libx264']))).toBeNull();
    expect(codecProblem('h265', caps(['libx264']))).toBe(
      'This ffmpeg has no libx265 encoder, so H265 is not available. The full build from Dev Setup has it.',
    );
  });

  it('lists the hardware encoders it was built with, in the order they are tried', () => {
    const all = caps(['h264_nvenc', 'h264_qsv', 'hevc_amf', 'h264_videotoolbox']);
    expect(hardwareCandidates('h264', all)).toEqual([
      'h264_nvenc',
      'h264_qsv',
      'h264_videotoolbox',
    ]);
    expect(hardwareCandidates('h265', all)).toEqual(['hevc_amf']);
    expect(hardwareCandidates('vp9', all)).toEqual([]);
    expect(hardwareEncoderName('nvenc', 'vp9')).toBeUndefined();
    expect(hardwareEncoderName('qsv', 'vp9')).toBe('vp9_qsv');
  });

  it('reads the version and the names from real listings, past their legends', () => {
    const version =
      'ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc 16.2.0';
    const encoders = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' S..... = Subtitle',
      ' .F.... = Frame-level multithreading',
      ' ------',
      ' V.S..D ffv1                 FFmpeg video codec #1',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)',
      ' S..... ass                  ASS (Advanced SubStation Alpha) subtitle',
    ].join('\r\n');
    const filters = [
      'Filters:',
      '  T.. = Timeline support',
      '  .S. = Slice threading',
      '  ------',
      ' .. anullsrc          |->A       Null audio source, return empty audio frames.',
      ' .S xfade             VV->V      Cross fade one video with another video.',
      ' TSC scale            V->V       Scale the input video size.',
    ].join('\n');
    const parsed = parseCapabilities(version, encoders, filters);
    expect(parsed.version).toBe('9.0.2');
    expect([...parsed.encoders]).toEqual(['ffv1', 'libx264', 'aac', 'ass']);
    expect([...parsed.filters]).toEqual(['anullsrc', 'xfade', 'scale']);
  });

  it('reads a git build as having no release number', () => {
    expect(
      parseCapabilities('ffmpeg version N-118000-g1234abcd Copyright', '', '').version,
    ).toBeNull();
    expect(parseCapabilities('ffmpeg version 7.1 Copyright', '', '').version).toBe('7.1');
  });

  it('passes the graph file in the option this version reads', () => {
    expect(readsFilterFileOption('7.1')).toBe(true);
    expect(readsFilterFileOption('7.1.1')).toBe(true);
    expect(readsFilterFileOption('9.0.2')).toBe(true);
    expect(readsFilterFileOption('7.0.2')).toBe(false);
    expect(readsFilterFileOption('6.1')).toBe(false);
    expect(readsFilterFileOption(null)).toBe(true);
  });
});

describe('chunk arguments', () => {
  it('reads raw BGRA from stdin and writes lossless intra-only frames', () => {
    expect(
      chunkArgs({ width: 1920, height: 1080, fps: 30, output: 'C:/cache/s1/0003.mkv' }),
    ).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'bgra',
      '-s',
      '1920x1080',
      '-r',
      '30',
      '-i',
      '-',
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
      'C:/cache/s1/0003.mkv',
    ]);
  });

  it('scales frames a scaled display drew larger back to the output size', () => {
    const args = chunkArgs({
      width: 1920,
      height: 1080,
      input: { width: 2400, height: 1350 },
      fps: 30,
      output: 'c.mkv',
    });
    expect(args.slice(8, 10)).toEqual(['-s', '2400x1350']);
    expect(args).toEqual(expect.arrayContaining(['-vf', 'scale=1920:1080:flags=lanczos']));
    expect(
      chunkArgs({ width: 8, height: 8, input: { width: 8, height: 8 }, fps: 30, output: 'c.mkv' }),
    ).not.toContain('-vf');
  });
});

describe('the assembly graph', () => {
  it('joins scenes with cuts and transitions, each transition overlapping both scenes', () => {
    const plan = planOf([
      {
        id: 's1',
        targetDuration: secondsToFlicks(3),
        transitionOut: { kind: 'fade', duration: secondsToFlicks(0.5) },
      },
      { id: 's2', targetDuration: secondsToFlicks(2) },
      {
        id: 's3',
        targetDuration: secondsToFlicks(2),
        transitionOut: { kind: 'wipeleft', duration: secondsToFlicks(1) },
      },
      { id: 's4', targetDuration: secondsToFlicks(4) },
    ]);
    expect(assemblyGraph(plan)).toBe(
      [
        '[0:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s0];',
        '[1:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s1];',
        '[2:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s2];',
        '[3:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s3];',
        // Scene 1 is 90 frames, the fade 15: it starts at frame 75 (2.5 s).
        '[s0][s1]xfade=transition=fade:duration=0.500000:offset=2.500000[j1];',
        // 75 + 60 = 135 frames so far, then a cut.
        '[j1][s2]concat=n=2:v=1:a=0[j2];',
        // 135 + 60 = 195 frames, less the 30 frame wipe: offset 165 (5.5 s).
        '[j2][s3]xfade=transition=wipeleft:duration=1.000000:offset=5.500000[vout]',
        '',
      ].join('\n'),
    );
    expect(plan.totalFrames).toBe(165 + 120);
  });

  it('passes a single scene straight through', () => {
    expect(assemblyGraph(planOf([{ id: 's1' }]))).toBe(
      '[0:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s0];\n[s0]null[vout]\n',
    );
  });

  it('writes offsets that land on frames at 24 fps', () => {
    const plan = planOf([
      {
        id: 's1',
        targetDuration: secondsToFlicks(1),
        transitionOut: { kind: 'dissolve', duration: secondsToFlicks(0.25) },
      },
      { id: 's2', targetDuration: secondsToFlicks(1) },
    ]);
    plan.fps = 24;
    plan.scenes[0]!.frames = 24;
    plan.scenes[1]!.frames = 24;
    plan.transitions[0]!.frames = 6;
    expect(assemblyGraph(plan)).toContain('duration=0.250000:offset=0.750000[vout]');
  });
});

describe('assembly arguments', () => {
  const plan = planOf([{ id: 's1' }, { id: 's2' }]);

  it('reads one concat list per scene and a silent stereo track, and writes a fast-start MP4', () => {
    expect(
      assemblyArgs({
        plan,
        sceneLists: ['w/s0.txt', 'w/s1.txt'],
        graphFile: 'w/graph.txt',
        output: 'out/Launch.mp4',
        version: '9.0.2',
      }),
    ).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostats',
      '-progress',
      'pipe:1',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'w/s0.txt',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'w/s1.txt',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-/filter_complex',
      'w/graph.txt',
      '-map',
      '[vout]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      '-r',
      '30',
      '-frames:v',
      '300',
      '-shortest',
      'out/Launch.mp4',
    ]);
  });

  it('uses the older graph file option, Opus for WebM, and the hardware encoder it is given', () => {
    const webm = structuredClone(plan);
    webm.settings.codec = 'vp9';
    const args = assemblyArgs({
      plan: webm,
      sceneLists: ['a.txt', 'b.txt'],
      graphFile: 'g.txt',
      output: 'o.webm',
      version: '6.1',
    });
    expect(args).toContain('-filter_complex_script');
    expect(args).not.toContain('-/filter_complex');
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'libopus']));
    expect(args).not.toContain('+faststart');

    const hw = assemblyArgs({
      plan,
      sceneLists: ['a.txt', 'b.txt'],
      graphFile: 'g.txt',
      output: 'o.mp4',
      version: '9.0.2',
      hardware: 'h264_nvenc',
    });
    expect(hw).toEqual(expect.arrayContaining(['-c:v', 'h264_nvenc']));
  });
});

describe('progress', () => {
  it('reads the latest frame and time from a block, and the end', () => {
    const block =
      'frame=42\nfps=30.0\nout_time_us=1400000\nout_time=00:00:01.400000\nprogress=continue\n';
    expect(parseProgress(block)).toEqual({ frame: 42, outTimeUs: 1_400_000, done: false });
    expect(parseProgress('frame=300\r\nout_time_ms=10000000\r\nprogress=end\r\n')).toEqual({
      frame: 300,
      outTimeUs: 10_000_000,
      done: true,
    });
  });

  it('ignores values ffmpeg prints before it has any', () => {
    expect(parseProgress('frame=N/A\nout_time_us=N/A\nprogress=continue')).toEqual({
      frame: null,
      outTimeUs: null,
      done: false,
    });
  });
});
