import type { EditOp } from '../document/ops.js';
import type { Clip, StudioDocument, TrackKind } from '../document/schema.js';
import { type Flicks, framesToFlicks, secondsToFlicks } from '../time/flicks.js';
import { clipEnd, clipsOnTrack, nearestFreeStart, overlapsOnTrack } from './layout.js';

/**
 * What a timeline gesture changes, as edit ops: one drag, trim, split or delete is one list, so it
 * is one undo step and one history entry. The builders check the gesture against the video
 * (tracks of the right kind, no two clips overlapping on a track, a clip at least a frame long)
 * and say why when it cannot be done.
 */

export class TimelineError extends Error {}

export interface TimelineEdit {
  ops: EditOp[];
  label: string;
}

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaRef {
  hash: string;
  kind: MediaKind;
  name: string;
  /** Null for a still image, which can be any length. */
  duration: Flicks | null;
}

/** The tracks each kind of clip may sit on. */
export const TRACKS_FOR: Record<MediaKind | 'text', readonly TrackKind[]> = {
  video: ['video'],
  image: ['image'],
  audio: ['voice', 'music', 'sfx'],
  text: ['text'],
};

/** How long a still image or a new caption runs when first placed. */
export const DEFAULT_STILL = secondsToFlicks(5);

function frame(doc: StudioDocument): Flicks {
  return framesToFlicks(1, doc.renderSettings.fps);
}

function clipOf(doc: StudioDocument, clipId: string): Clip {
  const clip = doc.timeline.clips.find((c) => c.id === clipId);
  if (!clip) throw new TimelineError('That clip is not on the timeline any more.');
  return clip;
}

function trackKind(doc: StudioDocument, trackId: string): TrackKind {
  const track = doc.timeline.tracks.find((t) => t.id === trackId);
  if (!track) throw new TimelineError('That track is not in the video any more.');
  return track.kind;
}

function assertTrack(doc: StudioDocument, trackId: string, kind: MediaKind | 'text') {
  if (!TRACKS_FOR[kind].includes(trackKind(doc, trackId))) {
    const where = TRACKS_FOR[kind].join(', ');
    throw new TimelineError(
      `A ${kind === 'text' ? 'caption' : kind} clip goes on a ${where} track.`,
    );
  }
}

/** What a clip shows or plays, for the track rules. */
export function clipKind(
  clip: Clip,
  mediaKind: (hash: string) => MediaKind | undefined,
): MediaKind | 'text' | null {
  if (clip.source.type === 'text') return 'text';
  if (clip.source.type === 'media') return mediaKind(clip.source.hash) ?? null;
  return null;
}

function assertFree(
  doc: StudioDocument,
  trackId: string,
  start: Flicks,
  duration: Flicks,
  except: string[],
) {
  if (overlapsOnTrack(doc, trackId, start, duration, new Set(except))) {
    throw new TimelineError('Another clip is already there on that track.');
  }
}

export function addMediaClip(
  doc: StudioDocument,
  input: { id: string; trackId: string; media: MediaRef; at: Flicks },
): TimelineEdit {
  assertTrack(doc, input.trackId, input.media.kind);
  const duration = input.media.duration ?? DEFAULT_STILL;
  const start = nearestFreeStart(doc, input.trackId, input.at, duration);
  const clip: Clip = {
    id: input.id,
    trackId: input.trackId,
    start,
    duration,
    source: { type: 'media', hash: input.media.hash, in: 0, out: duration },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
  return { ops: [{ op: 'clip.add', clip }], label: `Added ${input.media.name}` };
}

export function addTextClip(
  doc: StudioDocument,
  input: { id: string; trackId: string; text: string; lang: string; at: Flicks; duration?: Flicks },
): TimelineEdit {
  assertTrack(doc, input.trackId, 'text');
  const duration = input.duration ?? DEFAULT_STILL;
  const start = nearestFreeStart(doc, input.trackId, input.at, duration);
  const clip: Clip = {
    id: input.id,
    trackId: input.trackId,
    start,
    duration,
    source: { type: 'text', text: input.text, lang: input.lang, dir: 'auto' },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
  return { ops: [{ op: 'clip.add', clip }], label: 'Added a caption' };
}

/** Moves a clip in time, and to another track of the same kind when one is given. */
export function moveClip(
  doc: StudioDocument,
  clipId: string,
  to: { start: Flicks; trackId?: string },
  mediaKind: (hash: string) => MediaKind | undefined,
): TimelineEdit | null {
  const clip = clipOf(doc, clipId);
  const trackId = to.trackId ?? clip.trackId;
  const start = Math.max(0, Math.round(to.start));
  if (start === clip.start && trackId === clip.trackId) return null;
  if (trackId !== clip.trackId) {
    const kind = clipKind(clip, mediaKind);
    if (kind) assertTrack(doc, trackId, kind);
  }
  assertFree(doc, trackId, start, clip.duration, [clip.id]);
  return {
    ops: [
      {
        op: 'clip.update',
        clipId,
        patch: trackId === clip.trackId ? { start } : { start, trackId },
      },
    ],
    label: 'Moved a clip',
  };
}

/**
 * Moves one edge of a clip. Trimming the start of a video or sound clip also moves where in the
 * file it starts, so what plays at any moment stays put; no clip can reach past its file or get
 * shorter than a frame.
 */
export function trimClip(
  doc: StudioDocument,
  clipId: string,
  edge: 'start' | 'end',
  to: Flicks,
  mediaDuration: Flicks | null,
): TimelineEdit | null {
  const clip = clipOf(doc, clipId);
  const min = frame(doc);
  const source = clip.source;
  const timed = source.type === 'media' && mediaDuration !== null;
  if (edge === 'end') {
    let end = Math.max(clip.start + min, Math.round(to));
    if (timed && source.type === 'media')
      end = Math.min(end, clip.start + (mediaDuration - source.in));
    const duration = end - clip.start;
    if (duration === clip.duration) return null;
    assertFree(doc, clip.trackId, clip.start, duration, [clip.id]);
    const patch: Partial<Clip> = { duration };
    if (source.type === 'media') patch.source = { ...source, out: source.in + duration };
    return { ops: [{ op: 'clip.update', clipId, patch }], label: 'Trimmed a clip' };
  }
  const end = clipEnd(clip);
  let start = Math.min(end - min, Math.max(0, Math.round(to)));
  if (timed && source.type === 'media') start = Math.max(start, clip.start - source.in);
  if (start === clip.start) return null;
  const duration = end - start;
  assertFree(doc, clip.trackId, start, duration, [clip.id]);
  const patch: Partial<Clip> = { start, duration };
  if (source.type === 'media') {
    const shift = start - clip.start;
    patch.source = timed ? { ...source, in: source.in + shift } : { ...source, out: duration };
  }
  return { ops: [{ op: 'clip.update', clipId, patch }], label: 'Trimmed a clip' };
}

/** Cuts a clip in two at `at`; the second half plays on from where the first stops. */
export function splitClip(
  doc: StudioDocument,
  clipId: string,
  at: Flicks,
  newId: string,
): TimelineEdit {
  const clip = clipOf(doc, clipId);
  const min = frame(doc);
  const cut = Math.round(at);
  if (cut < clip.start + min || cut > clipEnd(clip) - min) {
    throw new TimelineError(
      'Put the playhead inside the clip, at least a frame from either end, to split it.',
    );
  }
  const first = cut - clip.start;
  const second = clipEnd(clip) - cut;
  const source = clip.source;
  const firstSource = source.type === 'media' ? { ...source, out: source.in + first } : source;
  const secondSource =
    source.type === 'media'
      ? { ...source, in: source.in + first, out: source.in + first + second }
      : source;
  const rest: Clip = {
    ...structuredClone(clip),
    id: newId,
    start: cut,
    duration: second,
    source: secondSource,
    transitionIn: null,
    fadeIn: 0,
  };
  return {
    ops: [
      { op: 'clip.update', clipId, patch: { duration: first, source: firstSource, fadeOut: 0 } },
      { op: 'clip.add', clip: rest },
    ],
    label: 'Split a clip',
  };
}

/** Removes a clip; with `ripple`, the clips after it on its track move up to close the gap. */
export function removeClip(doc: StudioDocument, clipId: string, ripple = false): TimelineEdit {
  const clip = clipOf(doc, clipId);
  const ops: EditOp[] = [{ op: 'clip.remove', clipId }];
  if (ripple) {
    for (const later of clipsOnTrack(doc, clip.trackId)) {
      if (later.id === clip.id || later.start < clipEnd(clip)) continue;
      ops.push({
        op: 'clip.update',
        clipId: later.id,
        patch: { start: later.start - clip.duration },
      });
    }
  }
  return { ops, label: ripple ? 'Deleted a clip and closed the gap' : 'Deleted a clip' };
}

/** Volume, fades, a transition in, or a caption's words, checked against the clip. */
export function updateClip(
  doc: StudioDocument,
  clipId: string,
  patch: Partial<Pick<Clip, 'gain' | 'fadeIn' | 'fadeOut' | 'transitionIn'>> & { text?: string },
  label: string,
): TimelineEdit {
  const clip = clipOf(doc, clipId);
  const { text, ...rest } = patch;
  const half = Math.floor(clip.duration / 2);
  const next: Partial<Clip> = { ...rest };
  if (next.gain !== undefined) next.gain = Math.min(4, Math.max(0, next.gain));
  if (next.fadeIn !== undefined) next.fadeIn = Math.min(half, Math.max(0, Math.round(next.fadeIn)));
  if (next.fadeOut !== undefined)
    next.fadeOut = Math.min(half, Math.max(0, Math.round(next.fadeOut)));
  if (text !== undefined) {
    if (clip.source.type !== 'text') throw new TimelineError('Only a caption has words to change.');
    next.source = { ...clip.source, text };
  }
  return { ops: [{ op: 'clip.update', clipId, patch: next }], label };
}

/** Moves a scene in the sequence: the scene track is the scenario's order. */
export function moveScene(
  doc: StudioDocument,
  sceneId: string,
  toIndex: number,
): TimelineEdit | null {
  const from = doc.scenario.scenes.findIndex((s) => s.id === sceneId);
  if (from < 0) throw new TimelineError('That scene is not in the video any more.');
  const index = Math.max(0, Math.min(doc.scenario.scenes.length - 1, toIndex));
  if (index === from) return null;
  return { ops: [{ op: 'scene.move', sceneId, index }], label: `Moved scene ${from + 1}` };
}

/** Sets a scene's length from the timeline; it keeps that length rather than following its voice. */
export function trimScene(
  doc: StudioDocument,
  sceneId: string,
  duration: Flicks,
): TimelineEdit | null {
  const index = doc.scenario.scenes.findIndex((s) => s.id === sceneId);
  const scene = doc.scenario.scenes[index];
  if (!scene) throw new TimelineError('That scene is not in the video any more.');
  const length = Math.max(
    secondsToFlicks(0.5),
    Math.min(secondsToFlicks(600), Math.round(duration)),
  );
  if (length === scene.targetDuration) return null;
  return {
    ops: [{ op: 'scene.update', sceneId, patch: { targetDuration: length, timing: 'fixed' } }],
    label: `Changed the length of scene ${index + 1}`,
  };
}
