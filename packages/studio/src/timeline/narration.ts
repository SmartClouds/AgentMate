import type { EditOp } from '../document/ops.js';
import type { Clip, StudioDocument } from '../document/schema.js';
import { type Flicks, flicksToFrame, framesToFlicks, secondsToFlicks } from '../time/flicks.js';
import type { TimedLine } from '../voice/text.js';
import { sceneBlocks } from './layout.js';

/**
 * A scene's narration and the captions timed to it belong to the scene: their clip ids carry the
 * scene (`nv-<scene>-…` for the voice, `nc-<scene>-…` for its captions), so when a scene moves or
 * changes length, every edit moves them with it, in the same undo step. The tie lives in the
 * document, so undo and redo keep it right.
 */

export const NARRATION_VOICE = 'nv-';
export const NARRATION_CAPTION = 'nc-';

/** The part of a clip id that names its scene; a long scene id is shortened to a hash. */
export function sceneTag(sceneId: string): string {
  if (sceneId.length <= 40) return sceneId;
  let h = 2166136261;
  for (const ch of sceneId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return `h${h.toString(16)}`;
}

export function narrationClipId(
  sceneId: string,
  kind: 'voice' | 'caption',
  unique: string,
): string {
  return `${kind === 'voice' ? NARRATION_VOICE : NARRATION_CAPTION}${sceneTag(sceneId)}-${unique.slice(0, 8)}`;
}

/** The scene a clip is tied to, or null for a free clip. */
export function tiedScene(doc: StudioDocument, clip: Pick<Clip, 'id'>): string | null {
  const match = /^(?:nv|nc)-(.+)-[A-Za-z0-9_]+$/.exec(clip.id);
  if (!match) return null;
  const tag = match[1];
  return doc.scenario.scenes.find((s) => sceneTag(s.id) === tag)?.id ?? null;
}

/** The voice clip tied to a scene, if it has one. */
export function narrationClip(doc: StudioDocument, sceneId: string): Clip | undefined {
  const prefix = `${NARRATION_VOICE}${sceneTag(sceneId)}-`;
  return doc.timeline.clips.find((c) => c.id.startsWith(prefix));
}

/**
 * The moves that keep tied clips with their scenes after an edit: each clip that was already
 * there, and that the edit itself did not move, shifts by as much as its scene's start moved.
 */
export function followScenes(before: StudioDocument, after: StudioDocument): EditOp[] {
  const startsBefore = new Map(sceneBlocks(before).map((b) => [b.sceneId, b.start]));
  const startsAfter = new Map(sceneBlocks(after).map((b) => [b.sceneId, b.start]));
  const clipsBefore = new Map(before.timeline.clips.map((c) => [c.id, c]));
  const ops: EditOp[] = [];
  for (const clip of after.timeline.clips) {
    const earlier = clipsBefore.get(clip.id);
    if (!earlier || earlier.start !== clip.start) continue;
    const sceneId = tiedScene(after, clip);
    if (!sceneId) continue;
    const from = startsBefore.get(sceneId);
    const to = startsAfter.get(sceneId);
    if (from === undefined || to === undefined || from === to) continue;
    ops.push({
      op: 'clip.update',
      clipId: clip.id,
      patch: { start: Math.max(0, clip.start + to - from) },
    });
  }
  return ops;
}

/** How long a scene runs to fit narration of `seconds`: the voice plus a pause, on a whole frame. */
export function narratedLength(seconds: number, fps: number, pause = 0.5): Flicks {
  const frames = Math.ceil((seconds + pause) * fps - 1e-6);
  return Math.max(framesToFlicks(Math.ceil(fps), fps), framesToFlicks(frames, fps));
}

/** Caption clips from lines timed by the voice, from the scene's start, on whole frames. */
export function captionClipsFromTimes(input: {
  lines: readonly TimedLine[];
  lang: string;
  sceneId: string;
  sceneStart: Flicks;
  trackId: string;
  fps: number;
  newId: () => string;
}): Clip[] {
  const { fps } = input;
  const clips: Clip[] = [];
  for (const line of input.lines) {
    const start = flicksToFrame(input.sceneStart + secondsToFlicks(line.start), fps, 'round');
    const end = flicksToFrame(input.sceneStart + secondsToFlicks(line.end), fps, 'round');
    if (end <= start) continue;
    clips.push({
      id: narrationClipId(input.sceneId, 'caption', input.newId()),
      trackId: input.trackId,
      start: framesToFlicks(start, fps),
      duration: framesToFlicks(end - start, fps),
      source: { type: 'text', text: line.text, lang: input.lang, dir: 'auto' },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
  }
  return clips;
}
