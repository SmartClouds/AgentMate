import {
  DESIGN_SIZES,
  outputSize,
  type Quality,
  type RenderSettings,
  type StudioDocument,
} from '../document/schema.js';
import type { SceneConfig } from '../runtime/runtime.js';
import { sceneConfig } from '../scenes/config.js';
import { directionOf } from '../text/languages.js';
import { flicksToFrame, flicksToSeconds } from '../time/flicks.js';

/**
 * What a render will do, worked out from the video before anything runs: each scene's frames, in
 * chunks of about two seconds, the transitions between scenes, the output size, and what plays
 * over the scenes (video and pictures, captions, sound). Pure, so the Render dialog shows the same
 * numbers the render uses, and so it can be tested to the frame.
 */

export interface PlannedChunk {
  index: number;
  /** First frame of the chunk, counted from the start of the scene. */
  from: number;
  count: number;
}

export interface PlannedScene {
  sceneId: string;
  /** 1-based, for messages. */
  position: number;
  treeHash: string;
  frames: number;
  chunks: PlannedChunk[];
  /** What the scene's mezzanine depends on; equal inputs mean the frames can be reused. */
  cacheInputs: string;
  config: ReturnType<typeof sceneConfig>;
}

export interface PlannedTransition {
  /** Index of the scene this transition leaves. */
  after: number;
  kind: string;
  frames: number;
}

/** A caption, drawn once by Chromium (so Persian is shaped and runs right to left) as a still. */
export interface PlannedCaption {
  text: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  treeHash: string;
  config: Partial<SceneConfig>;
  /** What the still depends on; equal inputs reuse the still. */
  cacheInputs: string;
}

/** A picture over the scenes for a while: a video or image clip, or a caption. */
export interface PlannedOverlay {
  clipId: string;
  kind: 'video' | 'image' | 'caption';
  /** The media blob, for a video or image clip. */
  hash: string | null;
  caption: PlannedCaption | null;
  startFrame: number;
  frames: number;
  /** Where in the file it starts, for a video clip. */
  inSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

/** A sound in the mix: a voice, music or effects clip, or the sound of a video clip. */
export interface PlannedAudio {
  clipId: string;
  hash: string;
  /** What it is in the mix: music drops under a voice when ducking is on. */
  role: 'voice' | 'music' | 'other';
  startSeconds: number;
  inSeconds: number;
  seconds: number;
  /** The clip's volume times its track's. */
  gain: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}

export interface MediaFacts {
  kind: 'video' | 'audio' | 'image';
  hasAudio: boolean;
}

export interface RenderPlan {
  width: number;
  height: number;
  /** The size scenes are laid out at, in CSS pixels; the output is this times `scale`. */
  design: { width: number; height: number };
  /** Output pixels per design pixel. */
  scale: number;
  fps: number;
  settings: RenderSettings;
  scenes: PlannedScene[];
  transitions: PlannedTransition[];
  /** Frames in the finished video: every scene, less the overlap of each transition. */
  totalFrames: number;
  /** Frames that have to be captured (transitions overlap captured frames, they add none). */
  captureFrames: number;
  /** In drawing order: video under pictures under captions. */
  overlays: PlannedOverlay[];
  audio: PlannedAudio[];
  /** Whether music drops under the voice. */
  duck: boolean;
  /** The loudness the mix is brought to, when there is sound; null for a silent video. */
  loudness: number | null;
}

export type PlanResult = { ok: true; plan: RenderPlan } | { ok: false; problems: string[] };

export interface PlanOptions {
  /** Bumped whenever the runtime or the bundled fonts change, so old mezzanines are not reused. */
  runtimeVersion: string;
  chunkSeconds?: number;
  /** What each imported file is, by hash; clips whose file is not here cannot render. */
  media?: ReadonlyMap<string, MediaFacts>;
  /** The built-in caption page's code tree, needed when the video has captions. */
  captionTree?: string | null;
}

export function buildRenderPlan(doc: StudioDocument, options: PlanOptions): PlanResult {
  const settings = doc.renderSettings;
  const fps = settings.fps;
  const { width, height, scale } = outputSize(settings.aspect, settings.resolution);
  const problems: string[] = [];
  const scenes = doc.scenario.scenes;
  if (scenes.length === 0) problems.push('The video has no scenes yet.');

  const chunkFrames = Math.max(1, Math.round((options.chunkSeconds ?? 2) * fps));
  const planned: PlannedScene[] = [];
  scenes.forEach((scene, i) => {
    const position = i + 1;
    if (!scene.code.treeHash) {
      problems.push(`Scene ${position} has no animation yet. Animate it, or remove it.`);
      return;
    }
    const frames = Math.max(1, flicksToFrame(scene.targetDuration, fps, 'round'));
    const chunks: PlannedChunk[] = [];
    for (let from = 0, index = 0; from < frames; from += chunkFrames, index++) {
      chunks.push({ index, from, count: Math.min(chunkFrames, frames - from) });
    }
    const config = sceneConfig(doc, scene);
    planned.push({
      sceneId: scene.id,
      position,
      treeHash: scene.code.treeHash,
      frames,
      chunks,
      config,
      cacheInputs: JSON.stringify({
        tree: scene.code.treeHash,
        runtime: options.runtimeVersion,
        config,
        width,
        height,
        fps,
        frames,
      }),
    });
  });

  const transitions: PlannedTransition[] = [];
  scenes.forEach((scene, i) => {
    const next = scenes[i + 1];
    if (!next || !scene.transitionOut) return;
    const frames = flicksToFrame(scene.transitionOut.duration, fps, 'round');
    if (frames <= 0) return;
    const here = planned.find((p) => p.sceneId === scene.id);
    const there = planned.find((p) => p.sceneId === next.id);
    if (here && there && (frames >= here.frames || frames >= there.frames)) {
      problems.push(
        `The transition after scene ${i + 1} is as long as a scene it joins; make it shorter.`,
      );
      return;
    }
    transitions.push({ after: i, kind: scene.transitionOut.kind, frames });
  });

  const captureFrames = planned.reduce((sum, s) => sum + s.frames, 0);
  const totalFrames = captureFrames - transitions.reduce((sum, t) => sum + t.frames, 0);
  const layered = planClips(doc, options, { fps, totalFrames, width, height, problems });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: {
      width,
      height,
      design: { ...DESIGN_SIZES[settings.aspect] },
      scale,
      fps,
      settings,
      scenes: planned,
      transitions,
      totalFrames,
      captureFrames,
      ...layered,
    },
  };
}

const VISUAL_TRACKS = ['video', 'image', 'text'] as const;
const SOUND_TRACKS = ['voice', 'music', 'sfx'] as const;

/**
 * The clips over the scenes. A clip is cut where the video ends; one that starts after the end is
 * left out. A muted track is left out. When any track is soloed, only soloed tracks are heard.
 */
function planClips(
  doc: StudioDocument,
  options: PlanOptions,
  frame: { fps: number; totalFrames: number; width: number; height: number; problems: string[] },
): Pick<RenderPlan, 'overlays' | 'audio' | 'duck' | 'loudness'> {
  const { fps, totalFrames, problems } = frame;
  const media = options.media ?? new Map<string, MediaFacts>();
  const tracks = doc.timeline.tracks;
  const soloing = tracks.some((t) => t.solo && t.kind !== 'scene');
  const audible = (trackId: string) => {
    const track = tracks.find((t) => t.id === trackId);
    return !!track && !track.muted && (!soloing || track.solo);
  };
  const overlays: PlannedOverlay[] = [];
  const audio: PlannedAudio[] = [];
  const design = DESIGN_SIZES[doc.renderSettings.aspect];
  const ordered = [...doc.timeline.clips].sort((a, b) => {
    const ta = tracks.findIndex((t) => t.id === a.trackId);
    const tb = tracks.findIndex((t) => t.id === b.trackId);
    return ta - tb || a.start - b.start || a.id.localeCompare(b.id);
  });
  for (const clip of ordered) {
    const track = tracks.find((t) => t.id === clip.trackId);
    if (!track || track.muted) continue;
    const startFrame = flicksToFrame(clip.start, fps, 'round');
    if (startFrame >= totalFrames) continue;
    const frames = Math.min(
      totalFrames - startFrame,
      Math.max(1, flicksToFrame(clip.duration, fps, 'round')),
    );
    const seconds = frames / fps;
    const fadeIn = Math.min(seconds / 2, flicksToSeconds(clip.fadeIn));
    const fadeOut = Math.min(seconds / 2, flicksToSeconds(clip.fadeOut));
    const source = clip.source;
    if (source.type === 'scene') continue;
    if (source.type === 'text') {
      if (!(VISUAL_TRACKS as readonly string[]).includes(track.kind) || !source.text.trim())
        continue;
      if (!options.captionTree) {
        problems.push('The caption page is missing from this copy of Studio.');
        continue;
      }
      const dir = source.dir === 'auto' ? directionOf(source.lang) : source.dir;
      const config: Partial<SceneConfig> = {
        duration: seconds,
        width: design.width,
        height: design.height,
        lang: source.lang,
        dir,
        params: { text: source.text },
        seed: clip.id,
      };
      overlays.push({
        clipId: clip.id,
        kind: 'caption',
        hash: null,
        caption: {
          text: source.text,
          lang: source.lang,
          dir,
          treeHash: options.captionTree,
          config,
          cacheInputs: JSON.stringify({
            tree: options.captionTree,
            runtime: options.runtimeVersion,
            text: source.text,
            lang: source.lang,
            dir,
            width: frame.width,
            height: frame.height,
          }),
        },
        startFrame,
        frames,
        inSeconds: 0,
        fadeInSeconds: fadeIn,
        fadeOutSeconds: fadeOut,
      });
      continue;
    }
    const facts = media.get(source.hash);
    if (!facts) {
      problems.push(
        `A clip on the ${track.name} track plays a file that is not in this video any more.`,
      );
      continue;
    }
    const inSeconds = flicksToSeconds(source.in);
    if (facts.kind !== 'audio' && (VISUAL_TRACKS as readonly string[]).includes(track.kind)) {
      overlays.push({
        clipId: clip.id,
        kind: facts.kind === 'image' ? 'image' : 'video',
        hash: source.hash,
        caption: null,
        startFrame,
        frames,
        inSeconds: facts.kind === 'image' ? 0 : inSeconds,
        fadeInSeconds: fadeIn,
        fadeOutSeconds: fadeOut,
      });
    }
    const heard =
      facts.hasAudio &&
      facts.kind !== 'image' &&
      audible(track.id) &&
      (track.kind === 'video' || (SOUND_TRACKS as readonly string[]).includes(track.kind));
    if (heard && clip.gain * track.volume > 0) {
      audio.push({
        clipId: clip.id,
        hash: source.hash,
        role: track.kind === 'voice' ? 'voice' : track.kind === 'music' ? 'music' : 'other',
        startSeconds: startFrame / fps,
        inSeconds,
        seconds,
        gain: clip.gain * track.volume,
        fadeInSeconds: fadeIn,
        fadeOutSeconds: fadeOut,
      });
    }
  }
  return {
    overlays,
    audio,
    duck: doc.renderSettings.audio.duck !== false,
    loudness: audio.length > 0 ? doc.renderSettings.audio.lufs : null,
  };
}

/** Bits per output pixel per frame each quality aims at, for the size estimate. */
const BITS_PER_PIXEL: Record<Quality, number> = {
  draft: 0.04,
  standard: 0.08,
  high: 0.13,
  master: 0.25,
};

export interface RenderEstimate {
  durationSeconds: number;
  /** The finished file, roughly. */
  outputBytes: number;
  /** Lossless scene frames kept in the cache while rendering. */
  cacheBytes: number;
  /** How long it may take, from the capture speed measured on a mid-range laptop. */
  seconds: number;
}

export function estimateRender(plan: RenderPlan): RenderEstimate {
  const pixels = plan.width * plan.height;
  const durationSeconds = plan.totalFrames / plan.fps;
  const outputBytes = Math.round(
    (pixels * BITS_PER_PIXEL[plan.settings.quality] * plan.totalFrames) / 8,
  );
  // Lossless frames run about a quarter of the raw size.
  const cacheBytes = Math.round(pixels * 4 * plan.captureFrames * 0.25);
  // About 20 frames a second at 1080p (S1), slower in proportion to the pixels; encoding on top.
  const captureFps = 20 * ((1920 * 1080) / pixels);
  const seconds = Math.round(plan.captureFrames / captureFps + durationSeconds * 0.5 + 5);
  return { durationSeconds, outputBytes, cacheBytes, seconds };
}

/** The finished video's length in seconds, as the render will make it. */
export function planSeconds(plan: RenderPlan): number {
  return plan.totalFrames / plan.fps;
}
