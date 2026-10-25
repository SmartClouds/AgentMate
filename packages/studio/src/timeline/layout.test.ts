import { describe, expect, it } from 'vitest';
import { type Clip, createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { buildRenderPlan } from '../render/plan.js';
import { secondsToFlicks } from '../time/flicks.js';
import {
  clipsInRange,
  clipsOnTrack,
  nearestFreeStart,
  overlapsOnTrack,
  sceneBlocks,
  snap,
  snapPoints,
  trackFor,
  videoLength,
  visibleRange,
} from './layout.js';

const s = secondsToFlicks;

function video(): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'T', language: 'fa' });
  doc.scenario.scenes = [
    createScene({
      id: 'a',
      targetDuration: s(3),
      transitionOut: { kind: 'fade', duration: s(0.5) },
      code: { treeHash: 'a'.repeat(64) },
    }),
    createScene({ id: 'b', targetDuration: s(2), code: { treeHash: 'b'.repeat(64) } }),
    createScene({ id: 'c', targetDuration: s(1.01), code: { treeHash: 'c'.repeat(64) } }),
  ];
  return doc;
}

function clip(id: string, trackId: string, start: number, duration: number): Clip {
  return {
    id,
    trackId,
    start: s(start),
    duration: s(duration),
    source: { type: 'text', text: id, lang: 'fa', dir: 'auto' },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

describe('sceneBlocks', () => {
  it('lays scenes end to end on whole frames, each transition overlapping the scenes it joins', () => {
    const blocks = sceneBlocks(video());
    expect(blocks.map((b) => [b.sceneId, b.start, b.duration, b.transitionOut])).toEqual([
      ['a', 0, s(3), s(0.5)],
      ['b', s(2.5), s(2), 0],
      // 1.01 s at 30 fps rounds to 30 frames.
      ['c', s(4.5), s(1), 0],
    ]);
    expect(videoLength(video())).toBe(s(5.5));
  });

  it('agrees with the render to the frame', () => {
    const doc = video();
    doc.renderSettings.fps = 24;
    const plan = buildRenderPlan(doc, { runtimeVersion: '1' });
    if (!plan.ok) throw new Error('no plan');
    expect(videoLength(doc)).toBe((plan.plan.totalFrames / 24) * s(1));
  });

  it('lays a transition as long as a scene out as a cut, as the render will refuse it', () => {
    const doc = video();
    doc.scenario.scenes[0]!.transitionOut = { kind: 'fade', duration: s(2) };
    expect(sceneBlocks(doc)[0]?.transitionOut).toBe(0);
    expect(videoLength(createDocument({ id: 'v', title: 'T', language: 'en' }))).toBe(0);
  });
});

describe('placing clips', () => {
  const withClips = () => {
    const doc = video();
    doc.timeline.clips = [clip('x', 'track-text', 1, 1), clip('y', 'track-text', 3, 1)];
    return doc;
  };

  it('lists a track in time order and tells when a span is taken', () => {
    const doc = withClips();
    doc.timeline.clips.reverse();
    expect(clipsOnTrack(doc, 'track-text').map((c) => c.id)).toEqual(['x', 'y']);
    expect(trackFor(doc, 'music')?.id).toBe('track-music');
    expect(overlapsOnTrack(doc, 'track-text', s(1.5), s(1))).toBe(true);
    expect(overlapsOnTrack(doc, 'track-text', s(2), s(1))).toBe(false);
    expect(overlapsOnTrack(doc, 'track-text', s(1.5), s(1), new Set(['x']))).toBe(false);
    expect(overlapsOnTrack(doc, 'track-music', s(1), s(1))).toBe(false);
  });

  it('finds the free start nearest to where a clip was dropped', () => {
    const doc = withClips();
    expect(nearestFreeStart(doc, 'track-text', s(5), s(1))).toBe(s(5));
    // Dropped onto x, nearer its start: it goes just before x.
    expect(nearestFreeStart(doc, 'track-text', s(1.2), s(0.5))).toBe(s(0.5));
    // Dropped onto y, nearer its end: it goes right after y.
    expect(nearestFreeStart(doc, 'track-text', s(3.8), s(1))).toBe(s(4));
    // Too long for the gap between x and y, so it goes after y.
    expect(nearestFreeStart(doc, 'track-text', s(2), s(1.5))).toBe(s(4));
    expect(nearestFreeStart(doc, 'track-text', -s(3), s(0.5))).toBe(0);
  });
});

describe('snapping', () => {
  it('snaps to the playhead, scene edges and other clips within the threshold', () => {
    const doc = video();
    doc.timeline.clips = [clip('x', 'track-text', 1, 1)];
    const points = snapPoints(doc, s(4), new Set());
    expect(points).toEqual([0, s(1), s(2), s(2.5), s(3), s(4), s(4.5), s(5.5)]);
    expect(snap(s(2.45), points, s(0.1))).toBe(s(2.5));
    expect(snap(s(3.7), points, s(0.1))).toBe(s(3.7));
    expect(snapPoints(doc, 0, new Set(['x']))).not.toContain(s(1));
  });
});

describe('drawing only what is in view', () => {
  it('works out the visible time with a margin and keeps the clips that touch it', () => {
    const range = visibleRange(1000, 800, 1000, 100);
    expect(range).toEqual({ start: 900_000, end: 1_900_000 });
    expect(visibleRange(0, 800, 1000, 100).start).toBe(0);
    const clips = Array.from({ length: 500 }, (_, i) => ({
      id: `c${i}`,
      start: i * 10_000,
      duration: 10_000,
    }));
    const shown = clipsInRange(clips, range);
    expect(shown.map((c) => c.id)).toEqual(Array.from({ length: 100 }, (_, i) => `c${i + 90}`));
  });
});
