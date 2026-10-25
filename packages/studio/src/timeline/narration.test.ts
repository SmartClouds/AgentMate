import { describe, expect, it } from 'vitest';
import { applyOps } from '../document/ops.js';
import { type Clip, createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import { timeLines, wordsByLength } from '../voice/text.js';
import {
  captionClipsFromTimes,
  followScenes,
  narratedLength,
  narrationClip,
  narrationClipId,
  sceneTag,
  tiedScene,
} from './narration.js';

const s = secondsToFlicks;

function clip(id: string, trackId: string, start: number, length: number): Clip {
  return {
    id,
    trackId,
    start: s(start),
    duration: s(length),
    source: { type: 'text', text: id, lang: 'en', dir: 'auto' },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function video(): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'T', language: 'en' });
  doc.scenario.scenes = [
    createScene({ id: 'a', targetDuration: s(3) }),
    createScene({ id: 'b', targetDuration: s(4) }),
  ];
  doc.timeline.clips = [
    clip(narrationClipId('b', 'voice', 'x1'), 'track-voice', 3, 2),
    clip(narrationClipId('b', 'caption', 'x2'), 'track-text', 3.5, 1),
    clip('free', 'track-text', 3.5, 1),
  ];
  return doc;
}

describe('narration tied to its scene', () => {
  it('names clips after their scene, shortening a long scene id', () => {
    expect(narrationClipId('a', 'voice', 'abcdef123456')).toBe('nv-a-abcdef12');
    expect(sceneTag('x'.repeat(50))).toMatch(/^h[0-9a-f]+$/);
    expect(narrationClipId('x'.repeat(64), 'caption', 'u').length).toBeLessThanOrEqual(64);
    const doc = video();
    expect(tiedScene(doc, { id: 'nv-b-x1' })).toBe('b');
    expect(tiedScene(doc, { id: 'free' })).toBeNull();
    expect(tiedScene(doc, { id: 'nv-gone-x1' })).toBeNull();
    expect(narrationClip(doc, 'b')?.id).toBe('nv-b-x1');
  });

  it('moves a scene narration and its captions when an earlier scene changes length, not free clips', () => {
    const before = video();
    const after = applyOps(before, [
      { op: 'scene.update', sceneId: 'a', patch: { targetDuration: s(5) } },
    ]).document;
    expect(followScenes(before, after)).toEqual([
      { op: 'clip.update', clipId: 'nv-b-x1', patch: { start: s(5) } },
      { op: 'clip.update', clipId: 'nc-b-x2', patch: { start: s(5.5) } },
    ]);
  });

  it('follows a reorder too, and leaves a clip the edit itself moved', () => {
    const before = video();
    const moved = applyOps(before, [
      { op: 'scene.move', sceneId: 'b', index: 0 },
      { op: 'clip.update', clipId: 'nc-b-x2', patch: { start: s(9) } },
    ]).document;
    expect(followScenes(before, moved)).toEqual([
      { op: 'clip.update', clipId: 'nv-b-x1', patch: { start: 0 } },
    ]);
    expect(followScenes(before, before)).toEqual([]);
  });
});

describe('narrated scene lengths', () => {
  it('fits a scene to its voice plus a pause, on a whole frame, at least a second', () => {
    expect(narratedLength(2.0, 30)).toBe(s(2.5));
    // 2.01 s plus the pause is 75.3 frames: a frame more, never cutting the voice.
    expect(narratedLength(2.01, 30)).toBe(s(76 / 30));
    expect(narratedLength(0.1, 24)).toBe(s(1));
  });
});

describe('captions timed by the voice', () => {
  it('lays each line where its words are spoken, from the scene start', () => {
    const words = wordsByLength('one two three four', 2);
    const lines = timeLines(['one two', 'three four'], words);
    let n = 0;
    const clips = captionClipsFromTimes({
      lines,
      lang: 'en',
      sceneId: 'b',
      sceneStart: s(3),
      trackId: 'track-text',
      fps: 30,
      newId: () => `id${++n}`,
    });
    expect(
      clips.map((c) => [c.id, c.start, c.duration, c.source.type === 'text' && c.source.text]),
    ).toEqual([
      ['nc-b-id1', s(3), s(0.8), 'one two'],
      ['nc-b-id2', s(3.8), s(1.2), 'three four'],
    ]);
    expect(
      captionClipsFromTimes({
        lines: [{ text: 'x', start: 1, end: 1 }],
        lang: 'en',
        sceneId: 'b',
        sceneStart: 0,
        trackId: 't',
        fps: 30,
        newId: () => 'z',
      }),
    ).toEqual([]);
  });
});
