import { describe, expect, it } from 'vitest';
import { applyOps } from '../document/ops.js';
import { type Clip, createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import {
  addMediaClip,
  addTextClip,
  type MediaKind,
  type MediaRef,
  moveClip,
  moveScene,
  removeClip,
  splitClip,
  TimelineError,
  trimClip,
  trimScene,
  updateClip,
} from './edits.js';

const s = secondsToFlicks;
const HASH = 'f'.repeat(64);
const CLIP_VIDEO: MediaRef = { hash: HASH, kind: 'video', name: 'beach.mp4', duration: s(10) };
const kinds: Record<string, MediaKind> = { [HASH]: 'video', ['a'.repeat(64)]: 'audio' };
const kindOf = (hash: string) => kinds[hash];

function video(): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'T', language: 'fa' });
  doc.scenario.scenes = [
    createScene({ id: 'a' }),
    createScene({ id: 'b' }),
    createScene({ id: 'c' }),
  ];
  return doc;
}

/** Applies an edit and checks its inverse takes the video back exactly. */
function run(
  doc: StudioDocument,
  edit: { ops: Parameters<typeof applyOps>[1] } | null,
): StudioDocument {
  if (!edit) throw new Error('no edit');
  const result = applyOps(doc, edit.ops);
  expect(applyOps(result.document, result.inverse).document).toEqual(doc);
  return result.document;
}

function placed(): StudioDocument {
  return run(
    video(),
    addMediaClip(video(), { id: 'v', trackId: 'track-video', media: CLIP_VIDEO, at: s(2) }),
  );
}

const clipOf = (doc: StudioDocument, id: string) =>
  doc.timeline.clips.find((c) => c.id === id) as Clip;

describe('adding clips', () => {
  it('places a video clip for its whole length where it was dropped', () => {
    const doc = placed();
    expect(clipOf(doc, 'v')).toMatchObject({
      trackId: 'track-video',
      start: s(2),
      duration: s(10),
      source: { type: 'media', hash: HASH, in: 0, out: s(10) },
      gain: 1,
    });
  });

  it('gives a still image and a caption five seconds, beside what is there', () => {
    const doc = placed();
    const image = addMediaClip(doc, {
      id: 'i',
      trackId: 'track-image',
      media: { hash: 'e'.repeat(64), kind: 'image', name: 'logo.png', duration: null },
      at: 0,
    });
    expect(image.ops[0]).toMatchObject({ clip: { duration: s(5) } });
    const caption = run(
      doc,
      addTextClip(doc, { id: 't', trackId: 'track-text', text: 'سلام', lang: 'fa', at: s(1) }),
    );
    expect(clipOf(caption, 't')).toMatchObject({
      start: s(1),
      duration: s(5),
      source: { text: 'سلام', dir: 'auto' },
    });
  });

  it('refuses a clip on a track of the wrong kind', () => {
    expect(() =>
      addMediaClip(video(), { id: 'v', trackId: 'track-music', media: CLIP_VIDEO, at: 0 }),
    ).toThrow('A video clip goes on a video track.');
    expect(() =>
      addTextClip(video(), { id: 't', trackId: 'track-video', text: 'x', lang: 'en', at: 0 }),
    ).toThrow('A caption clip goes on a text track.');
    expect(() =>
      addTextClip(video(), { id: 't', trackId: 'nope', text: 'x', lang: 'en', at: 0 }),
    ).toThrow('That track is not in the video any more.');
  });
});

describe('moving and trimming', () => {
  it('moves a clip in time, not onto another clip or a track of another kind', () => {
    let doc = placed();
    doc = run(doc, moveClip(doc, 'v', { start: s(4) }, kindOf));
    expect(clipOf(doc, 'v').start).toBe(s(4));
    expect(moveClip(doc, 'v', { start: s(4) }, kindOf)).toBeNull();
    doc = run(
      doc,
      addMediaClip(doc, { id: 'w', trackId: 'track-video', media: CLIP_VIDEO, at: s(20) }),
    );
    expect(() => moveClip(doc, 'w', { start: s(10) }, kindOf)).toThrow(
      'Another clip is already there on that track.',
    );
    expect(() => moveClip(doc, 'w', { start: s(20), trackId: 'track-music' }, kindOf)).toThrow(
      'A video clip goes on a video track.',
    );
    expect(() => moveClip(doc, 'gone', { start: 0 }, kindOf)).toThrow(TimelineError);
  });

  it('trims the end within the file, and the start with the file moving along', () => {
    let doc = placed();
    doc = run(doc, trimClip(doc, 'v', 'end', s(8), s(10)));
    expect(clipOf(doc, 'v')).toMatchObject({
      start: s(2),
      duration: s(6),
      source: { in: 0, out: s(6) },
    });
    doc = run(doc, trimClip(doc, 'v', 'start', s(3), s(10)));
    expect(clipOf(doc, 'v')).toMatchObject({
      start: s(3),
      duration: s(5),
      source: { in: s(1), out: s(6) },
    });
    // Not past the start of the file, nor past its end.
    doc = run(doc, trimClip(doc, 'v', 'start', 0, s(10)));
    expect(clipOf(doc, 'v')).toMatchObject({ start: s(2), source: { in: 0 } });
    doc = run(doc, trimClip(doc, 'v', 'end', s(30), s(10)));
    expect(clipOf(doc, 'v')).toMatchObject({ duration: s(10), source: { out: s(10) } });
    expect(trimClip(doc, 'v', 'end', s(12), s(10))).toBeNull();
  });

  it('keeps a trimmed clip at least a frame long, and lets a still image grow freely', () => {
    let doc = placed();
    doc = run(doc, trimClip(doc, 'v', 'end', 0, s(10)));
    expect(clipOf(doc, 'v').duration).toBe(s(1 / 30));
    let still = video();
    still = run(
      still,
      addMediaClip(still, {
        id: 'i',
        trackId: 'track-image',
        media: { hash: 'e'.repeat(64), kind: 'image', name: 'logo.png', duration: null },
        at: s(1),
      }),
    );
    still = run(still, trimClip(still, 'i', 'end', s(40), null));
    expect(clipOf(still, 'i')).toMatchObject({ duration: s(39), source: { out: s(39) } });
    still = run(still, trimClip(still, 'i', 'start', 0, null));
    expect(clipOf(still, 'i')).toMatchObject({
      start: 0,
      duration: s(40),
      source: { in: 0, out: s(40) },
    });
  });
});

describe('splitting and deleting', () => {
  it('splits a clip so the second part plays on from where the first stops', () => {
    let doc = placed();
    doc = run(doc, updateClip(doc, 'v', { fadeIn: s(1), fadeOut: s(1) }, 'Fades'));
    doc = run(doc, splitClip(doc, 'v', s(5), 'v2'));
    expect(clipOf(doc, 'v')).toMatchObject({
      start: s(2),
      duration: s(3),
      fadeIn: s(1),
      fadeOut: 0,
      source: { in: 0, out: s(3) },
    });
    expect(clipOf(doc, 'v2')).toMatchObject({
      start: s(5),
      duration: s(7),
      fadeIn: 0,
      fadeOut: s(1),
      source: { in: s(3), out: s(10) },
    });
    expect(() => splitClip(doc, 'v', s(2), 'v3')).toThrow('Put the playhead inside the clip');
  });

  it('deletes a clip, closing the gap on its track only when asked', () => {
    let doc = placed();
    doc = run(doc, splitClip(doc, 'v', s(5), 'v2'));
    const plain = run(doc, removeClip(doc, 'v'));
    expect(plain.timeline.clips.map((c) => [c.id, c.start])).toEqual([['v2', s(5)]]);
    const rippled = run(doc, removeClip(doc, 'v', true));
    expect(rippled.timeline.clips.map((c) => [c.id, c.start])).toEqual([['v2', s(2)]]);
    expect(removeClip(doc, 'v', true).label).toBe('Deleted a clip and closed the gap');
  });
});

describe('clip settings', () => {
  it('keeps volume and fades in range, and changes only a caption words', () => {
    let doc = placed();
    doc = run(
      doc,
      updateClip(doc, 'v', { gain: 9, fadeIn: s(20), fadeOut: -5 }, 'Changed the volume'),
    );
    expect(clipOf(doc, 'v')).toMatchObject({ gain: 4, fadeIn: s(5), fadeOut: 0 });
    expect(() => updateClip(doc, 'v', { text: 'x' }, 'Words')).toThrow(
      'Only a caption has words to change.',
    );
    doc = run(
      doc,
      addTextClip(doc, { id: 't', trackId: 'track-text', text: 'a', lang: 'en', at: 0 }),
    );
    doc = run(doc, updateClip(doc, 't', { text: 'Hello' }, 'Edited a caption'));
    expect(clipOf(doc, 't').source).toMatchObject({ type: 'text', text: 'Hello' });
  });
});

describe('the scene track', () => {
  it('reorders scenes and sets a scene length, which then stays fixed', () => {
    let doc = video();
    doc = run(doc, moveScene(doc, 'c', 0));
    expect(doc.scenario.scenes.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(moveScene(doc, 'c', -4)).toBeNull();
    doc = run(doc, trimScene(doc, 'a', s(7.25)));
    expect(doc.scenario.scenes[1]).toMatchObject({ targetDuration: s(7.25), timing: 'fixed' });
    expect(trimScene(doc, 'a', s(7.25))).toBeNull();
    expect(trimScene(doc, 'a', 1)?.ops[0]).toMatchObject({ patch: { targetDuration: s(0.5) } });
    expect(() => moveScene(doc, 'zz', 0)).toThrow('That scene is not in the video any more.');
    expect(() => trimScene(doc, 'zz', 0)).toThrow('That scene is not in the video any more.');
  });
});
