import {
  DESIGN_SIZES,
  outputSize,
  type Quality,
  type RenderSettings,
  type StudioDocument,
} from '../document/schema.js';
import { sceneConfig } from '../scenes/config.js';
import { flicksToFrame } from '../time/flicks.js';

/**
 * What a render will do, worked out from the video before anything runs: each scene's frames, in
 * chunks of about two seconds, the transitions between scenes, and the output size. Pure, so the
 * Render dialog shows the same numbers the render uses, and so it can be tested to the frame.
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
}

export type PlanResult = { ok: true; plan: RenderPlan } | { ok: false; problems: string[] };

export interface PlanOptions {
  /** Bumped whenever the runtime or the bundled fonts change, so old mezzanines are not reused. */
  runtimeVersion: string;
  chunkSeconds?: number;
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

  if (problems.length > 0) return { ok: false, problems };
  const captureFrames = planned.reduce((sum, s) => sum + s.frames, 0);
  const totalFrames = captureFrames - transitions.reduce((sum, t) => sum + t.frames, 0);
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
    },
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
