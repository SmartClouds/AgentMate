import type { Clip, StudioDocument, Track, TrackKind } from '../document/schema.js';
import { type Flicks, flicksToFrame, framesToFlicks } from '../time/flicks.js';

/**
 * Where everything sits on the timeline. The scene track is not stored as clips: it is laid out
 * from the scenario, scene after scene, each transition overlapping the two scenes it joins, the
 * same way the render lays them out (frames at the video's frame rate). Every other track holds
 * clips placed in time over the scenes. Pure, so the timeline, the preview and the render agree.
 */

export interface SceneBlock {
  sceneId: string;
  index: number;
  start: Flicks;
  duration: Flicks;
  end: Flicks;
  /** The overlap with the next scene, 0 for a cut or the last scene. */
  transitionOut: Flicks;
}

/** The scene sequence in time, as the render will play it. */
export function sceneBlocks(doc: StudioDocument): SceneBlock[] {
  const fps = doc.renderSettings.fps;
  const scenes = doc.scenario.scenes;
  const frames = scenes.map((s) => Math.max(1, flicksToFrame(s.targetDuration, fps, 'round')));
  const blocks: SceneBlock[] = [];
  let at = 0;
  scenes.forEach((scene, index) => {
    const own = frames[index] as number;
    const next = frames[index + 1];
    let overlap = 0;
    if (next !== undefined && scene.transitionOut) {
      const t = flicksToFrame(scene.transitionOut.duration, fps, 'round');
      // A transition as long as a scene it joins cannot render; the render refuses it and so it
      // is laid out as a cut until it is fixed.
      if (t > 0 && t < own && t < next) overlap = t;
    }
    blocks.push({
      sceneId: scene.id,
      index,
      start: framesToFlicks(at, fps),
      duration: framesToFlicks(own, fps),
      end: framesToFlicks(at + own, fps),
      transitionOut: framesToFlicks(overlap, fps),
    });
    at += own - overlap;
  });
  return blocks;
}

/** How long the finished video runs: the scene sequence. Clips past its end are cut there. */
export function videoLength(doc: StudioDocument): Flicks {
  return sceneBlocks(doc).at(-1)?.end ?? 0;
}

export function clipEnd(clip: Clip): Flicks {
  return clip.start + clip.duration;
}

/** The track a kind of media goes on by default. */
export function trackFor(doc: StudioDocument, kind: TrackKind): Track | undefined {
  return doc.timeline.tracks.find((t) => t.kind === kind);
}

export function clipsOnTrack(doc: StudioDocument, trackId: string): Clip[] {
  return doc.timeline.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Whether a span overlaps any clip on the track, other than the ones left out. */
export function overlapsOnTrack(
  doc: StudioDocument,
  trackId: string,
  start: Flicks,
  duration: Flicks,
  except: ReadonlySet<string> = new Set(),
): boolean {
  const end = start + duration;
  return doc.timeline.clips.some(
    (c) => c.trackId === trackId && !except.has(c.id) && c.start < end && start < clipEnd(c),
  );
}

/**
 * The free start nearest to `wanted` for a span of `duration` on a track: where it was asked for
 * when that is free, otherwise just after or just before whatever is in the way.
 */
export function nearestFreeStart(
  doc: StudioDocument,
  trackId: string,
  wanted: Flicks,
  duration: Flicks,
  except: ReadonlySet<string> = new Set(),
): Flicks {
  const start = Math.max(0, wanted);
  if (!overlapsOnTrack(doc, trackId, start, duration, except)) return start;
  const others = clipsOnTrack(doc, trackId).filter((c) => !except.has(c.id));
  const candidates = others
    .flatMap((c) => [clipEnd(c), c.start - duration])
    .filter((t) => t >= 0 && !overlapsOnTrack(doc, trackId, t, duration, except));
  candidates.sort((a, b) => Math.abs(a - start) - Math.abs(b - start) || a - b);
  return candidates[0] ?? Math.max(start, ...others.map(clipEnd));
}

/** The times worth snapping to: 0, the playhead, scene edges and the edges of other clips. */
export function snapPoints(
  doc: StudioDocument,
  playhead: Flicks,
  except: ReadonlySet<string>,
): Flicks[] {
  const points = new Set<Flicks>([0, playhead]);
  for (const block of sceneBlocks(doc)) {
    points.add(block.start);
    points.add(block.end);
  }
  for (const clip of doc.timeline.clips) {
    if (except.has(clip.id)) continue;
    points.add(clip.start);
    points.add(clipEnd(clip));
  }
  return [...points].sort((a, b) => a - b);
}

/** `time` moved to the nearest snap point within `threshold`, or left where it is. */
export function snap(time: Flicks, points: readonly Flicks[], threshold: Flicks): Flicks {
  let best = time;
  let distance = threshold;
  for (const point of points) {
    const d = Math.abs(point - time);
    if (d <= distance) {
      best = point;
      distance = d;
    }
  }
  return best;
}

export interface TimeRange {
  start: Flicks;
  end: Flicks;
}

/** The time a scrolled timeline shows, with a margin so clips do not pop in at the edges. */
export function visibleRange(
  scrollLeftPx: number,
  widthPx: number,
  flicksPerPx: number,
  marginPx = 200,
): TimeRange {
  return {
    start: Math.max(0, (scrollLeftPx - marginPx) * flicksPerPx),
    end: (scrollLeftPx + widthPx + marginPx) * flicksPerPx,
  };
}

/** The clips that touch a range, so a long timeline draws only what is on screen. */
export function clipsInRange<T extends { start: Flicks; duration: Flicks }>(
  clips: readonly T[],
  range: TimeRange,
): T[] {
  return clips.filter((c) => c.start < range.end && c.start + c.duration > range.start);
}
