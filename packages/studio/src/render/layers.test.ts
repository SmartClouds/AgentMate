import { describe, expect, it } from 'vitest';
import { type Clip, createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import {
  assemblyArgs,
  assemblyGraph,
  loudnessArgs,
  loudnessGraph,
  parseLoudnorm,
} from './ffmpeg.js';
import { buildRenderPlan, type MediaFacts, type RenderPlan } from './plan.js';

const s = secondsToFlicks;
const V = '1'.repeat(64);
const IMG = '2'.repeat(64);
const SONG = '3'.repeat(64);
const MEDIA = new Map<string, MediaFacts>([
  [V, { kind: 'video', hasAudio: true }],
  [IMG, { kind: 'image', hasAudio: false }],
  [SONG, { kind: 'audio', hasAudio: true }],
]);

function clip(
  id: string,
  trackId: string,
  source: Clip['source'],
  start: number,
  length: number,
  extra: Partial<Clip> = {},
): Clip {
  return {
    id,
    trackId,
    start: s(start),
    duration: s(length),
    source,
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    ...extra,
  };
}

const media = (hash: string, length: number, inAt = 0): Clip['source'] => ({
  type: 'media',
  hash,
  in: s(inAt),
  out: s(inAt + length),
});

function video(edit?: (doc: StudioDocument) => void): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'T', language: 'fa' });
  doc.scenario.scenes = [
    createScene({ id: 'a', targetDuration: s(4), code: { treeHash: 'a'.repeat(64) } }),
  ];
  edit?.(doc);
  return doc;
}

function plan(doc: StudioDocument, captionTree: string | null = 'c'.repeat(64)): RenderPlan {
  const result = buildRenderPlan(doc, { runtimeVersion: '1', media: MEDIA, captionTree });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return result.plan;
}

describe('planning the clips over the scenes', () => {
  it('stacks video under pictures under captions, and hears the video and the music', () => {
    const p = plan(
      video((doc) => {
        doc.timeline.clips = [
          clip('t', 'track-text', { type: 'text', text: 'سلام', lang: 'fa', dir: 'auto' }, 0.5, 1),
          clip('i', 'track-image', media(IMG, 1), 1, 1, { fadeIn: s(0.25) }),
          clip('v', 'track-video', media(V, 2, 3), 0, 2, { gain: 0.5 }),
          clip('m', 'track-music', media(SONG, 3), 1, 3, { fadeOut: s(5) }),
        ];
        doc.timeline.tracks.find((t) => t.id === 'track-music')!.volume = 0.8;
      }),
    );
    expect(p.overlays.map((o) => [o.clipId, o.kind, o.startFrame, o.frames, o.inSeconds])).toEqual([
      ['v', 'video', 0, 60, 3],
      ['i', 'image', 30, 30, 0],
      ['t', 'caption', 15, 30, 0],
    ]);
    expect(p.overlays[1]?.fadeInSeconds).toBe(0.25);
    expect(p.overlays[2]?.caption).toMatchObject({
      text: 'سلام',
      lang: 'fa',
      dir: 'rtl',
      config: { params: { text: 'سلام' }, duration: 1 },
    });
    expect(p.audio.map((a) => [a.clipId, a.startSeconds, a.inSeconds, a.seconds, a.gain])).toEqual([
      ['v', 0, 3, 2, 0.5],
      ['m', 1, 0, 3, 0.8],
    ]);
    // A fade is never longer than half the clip.
    expect(p.audio[1]?.fadeOutSeconds).toBe(1.5);
    expect(p.loudness).toBe(-14);
  });

  it('cuts a clip where the video ends and leaves out one that starts after it', () => {
    const p = plan(
      video((doc) => {
        doc.timeline.clips = [
          clip('late', 'track-image', media(IMG, 1), 5, 1),
          clip('long', 'track-image', media(IMG, 10), 3, 10),
        ];
      }),
    );
    expect(p.overlays.map((o) => [o.clipId, o.frames])).toEqual([['long', 30]]);
  });

  it('leaves out muted tracks, hears only soloed ones, and skips empty captions and silent clips', () => {
    const doc = video((d) => {
      d.timeline.clips = [
        clip('m', 'track-music', media(SONG, 1), 0, 1),
        clip('x', 'track-sfx', media(SONG, 1), 0, 1),
        clip('q', 'track-voice', media(SONG, 1), 0, 1, { gain: 0 }),
        clip('e', 'track-text', { type: 'text', text: '  ', lang: 'en', dir: 'auto' }, 0, 1),
        clip('n', 'track-video', media(V, 1), 2, 1),
      ];
      d.timeline.tracks.find((t) => t.id === 'track-sfx')!.solo = true;
      d.timeline.tracks.find((t) => t.id === 'track-video')!.muted = true;
    });
    const p = plan(doc);
    expect(p.audio.map((a) => a.clipId)).toEqual(['x']);
    expect(p.overlays).toEqual([]);
  });

  it('refuses a clip whose file is gone, and captions without the caption page', () => {
    const missing = buildRenderPlan(
      video((d) => {
        d.timeline.clips = [clip('m', 'track-music', media('9'.repeat(64), 1), 0, 1)];
      }),
      { runtimeVersion: '1', media: MEDIA },
    );
    expect(missing).toEqual({
      ok: false,
      problems: ['A clip on the Music track plays a file that is not in this video any more.'],
    });
    const noPage = buildRenderPlan(
      video((d) => {
        d.timeline.clips = [
          clip('t', 'track-text', { type: 'text', text: 'Hi', lang: 'en', dir: 'ltr' }, 0, 1),
        ];
      }),
      { runtimeVersion: '1' },
    );
    expect(noPage).toEqual({
      ok: false,
      problems: ['The caption page is missing from this copy of Studio.'],
    });
  });
});

describe('the graph for clips and sound', () => {
  const layered = () =>
    plan(
      video((doc) => {
        doc.timeline.clips = [
          clip('v', 'track-video', media(V, 1, 0.5), 1, 1, { fadeIn: s(0.2), fadeOut: s(0.2) }),
          clip('i', 'track-image', media(IMG, 1), 2, 1),
          clip('m', 'track-music', media(SONG, 2), 0, 2, { fadeIn: s(0.5), fadeOut: s(0.5) }),
        ];
      }),
    );

  it('lays each clip over its stretch and mixes the sound to the measured target', () => {
    const graph = assemblyGraph(layered(), {
      inputI: '-30.1',
      inputTp: '-20.0',
      inputLra: '1.0',
      inputThresh: '-40.1',
      targetOffset: '0.2',
    });
    expect(graph).toBe(
      [
        '[0:v]settb=AVTB,fps=30,setpts=PTS-STARTPTS,format=yuv420p[s0];',
        '[s0]null[vbase];',
        '[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuva420p,fps=30,fade=t=in:st=0:d=0.200000:alpha=1,fade=t=out:st=0.800000:d=0.200000:alpha=1,setpts=PTS-STARTPTS+1.000000/TB[o0];',
        "[vbase][o0]overlay=0:0:eof_action=pass:enable='between(t,1.000000,2.000000)'[l0];",
        '[2:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p,fps=30,setpts=PTS-STARTPTS+2.000000/TB[o1];',
        "[l0][o1]overlay=0:0:eof_action=pass:enable='between(t,2.000000,3.000000)'[vout];",
        '[3:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.200000,afade=t=out:st=0.800000:d=0.200000,volume=1.0000,adelay=1000:all=1[a0];',
        '[4:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.500000,afade=t=out:st=1.500000:d=0.500000,volume=1.0000,adelay=0:all=1[a1];',
        '[a0][a1]amix=inputs=2:normalize=0:duration=longest:dropout_transition=0[amix];',
        '[amix]apad,atrim=0:4.000000,asetpts=PTS-STARTPTS,loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-30.1:measured_TP=-20.0:measured_LRA=1.0:measured_thresh=-40.1:offset=0.2:linear=true,aresample=48000[aout]',
        '',
      ].join('\n'),
    );
  });

  it('feeds each clip from its file, the video from where the clip starts, the still looped', () => {
    const p = layered();
    const args = assemblyArgs({
      plan: p,
      sceneLists: ['s0.txt'],
      overlayFiles: ['clip.mp4', 'still.png'],
      audioFiles: ['clip.mp4', 'song.mp3'],
      graphFile: 'g.txt',
      output: 'out.mp4',
      version: '9.0.2',
    });
    const joined = args.join(' ');
    expect(joined).toContain(
      '-f concat -safe 0 -i s0.txt -ss 0.500000 -t 1.000000 -i clip.mp4 -loop 1 -framerate 30 -t 1.000000 -i still.png',
    );
    expect(joined).toContain(
      '-ss 0.500000 -t 1.000000 -i clip.mp4 -ss 0.000000 -t 2.000000 -i song.mp3',
    );
    expect(joined).toContain('-map [vout] -map [aout]');
    expect(args).not.toContain('anullsrc=r=48000:cl=stereo');
    expect(args).not.toContain('-shortest');
  });

  it('measures the mix alone first, and reads what loudnorm printed', () => {
    const p = layered();
    expect(loudnessGraph(p)).toContain('[0:a]aresample=48000');
    expect(loudnessGraph(p)).toContain('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]');
    expect(
      loudnessArgs({ plan: p, audioFiles: ['a.mp4', 'b.mp3'], graphFile: 'l.txt', version: '6.1' }),
    ).toEqual([
      '-hide_banner',
      '-nostats',
      '-ss',
      '0.500000',
      '-t',
      '1.000000',
      '-i',
      'a.mp4',
      '-ss',
      '0.000000',
      '-t',
      '2.000000',
      '-i',
      'b.mp3',
      '-filter_complex_script',
      'l.txt',
      '-map',
      '[aout]',
      '-f',
      'null',
      '-',
    ]);
    const printed = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-35.75",\n\t"input_tp" : "-35.05",\n\t"input_lra" : "0.00",\n\t"input_thresh" : "-45.75",\n\t"output_i" : "-14.03",\n\t"target_offset" : "0.03"\n}\n`;
    expect(parseLoudnorm(printed)).toEqual({
      inputI: '-35.75',
      inputTp: '-35.05',
      inputLra: '0.00',
      inputThresh: '-45.75',
      targetOffset: '0.03',
    });
    expect(parseLoudnorm(printed.replace('-35.75', '-inf'))).toBeNull();
    expect(parseLoudnorm('no json here')).toBeNull();
    expect(parseLoudnorm('{ broken')).toBeNull();
    expect(parseLoudnorm('{"input_i": 3}')).toBeNull();
  });

  it('mixes a single sound straight through', () => {
    const p = plan(
      video((d) => {
        d.timeline.clips = [clip('m', 'track-music', media(SONG, 1), 0, 1)];
      }),
    );
    expect(assemblyGraph(p)).toContain('[a0]anull[amix]');
    expect(assemblyGraph(p)).toContain('[amix]apad,atrim=0:4.000000,asetpts=PTS-STARTPTS[aout]');
  });
});
