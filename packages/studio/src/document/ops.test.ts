import { describe, expect, it } from 'vitest';
import { secondsToFlicks } from '../time/flicks.js';
import { applyOps, type EditOp, OpError, parseEditOps } from './ops.js';
import { type Clip, createDocument, createScene, type StudioDocument } from './schema.js';

const SECOND = secondsToFlicks(1);

function textClip(id: string, start = 0, trackId = 'track-text'): Clip {
  return {
    id,
    trackId,
    start,
    duration: SECOND,
    source: { type: 'text', text: `Clip ${id}`, lang: 'en', dir: 'auto' },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
}

function sceneClip(id: string, sceneId: string): Clip {
  return { ...textClip(id, 0, 'track-scene'), source: { type: 'scene', sceneId } };
}

/** A document with a little of everything, so every op has something to act on. */
function base(): StudioDocument {
  const d = createDocument({ id: 'v1', title: 'Film', language: 'en' });
  d.scenario.scenes = [
    createScene({ id: 's1', title: 'Hook' }),
    createScene({ id: 's2', title: 'Problem' }),
    createScene({ id: 's3', title: 'Answer' }),
  ];
  d.timeline.clips = [sceneClip('c1', 's1'), sceneClip('c2', 's2'), textClip('t1', SECOND)];
  return d;
}

/** One example of every op, each valid against `base()`. */
const EVERY_OP: EditOp[] = [
  { op: 'doc.set', field: 'title', value: 'New title' },
  { op: 'doc.set', field: 'styleId', value: 'flat-vector' },
  { op: 'scenario.set', patch: { logline: 'A film about films', tone: 'warm' } },
  { op: 'scene.add', scene: createScene({ id: 's9', title: 'Extra' }), index: 1 },
  { op: 'scene.remove', sceneId: 's2' },
  { op: 'scene.move', sceneId: 's3', index: 0 },
  {
    op: 'scene.update',
    sceneId: 's1',
    patch: { narration: 'سلام دنیا', targetDuration: SECOND * 7 },
  },
  {
    op: 'track.add',
    track: {
      id: 'track-extra',
      kind: 'music',
      name: 'Music 2',
      muted: false,
      solo: false,
      locked: false,
      volume: 0.5,
    },
    index: 2,
  },
  { op: 'track.remove', trackId: 'track-text' },
  { op: 'track.update', trackId: 'track-music', patch: { muted: true, volume: 0.2 } },
  { op: 'clip.add', clip: textClip('t2', SECOND * 3) },
  { op: 'clip.remove', clipId: 'c1' },
  { op: 'clip.update', clipId: 't1', patch: { start: SECOND * 2, gain: 0.5 } },
  { op: 'render.set', patch: { fps: 60, aspect: '9:16' } },
  { op: 'doc.replace', document: createDocument({ id: 'v1', title: 'Restored', language: 'fa' }) },
];

describe('applyOps', () => {
  it.each(EVERY_OP.map((op) => [op.op, op] as const))(
    '%s can be undone exactly by its inverse',
    (_name, op) => {
      const before = base();
      const { document: after, inverse } = applyOps(before, [op]);
      expect(after).not.toEqual(before);
      expect(applyOps(after, inverse).document).toEqual(before);
    },
  );

  it('undoes a whole batch in one go, in reverse order', () => {
    const before = base();
    const ops: EditOp[] = [
      { op: 'scene.add', scene: createScene({ id: 's4' }), index: 0 },
      { op: 'scene.update', sceneId: 's4', patch: { title: 'First' } },
      { op: 'scene.move', sceneId: 's4', index: 3 },
      { op: 'scene.remove', sceneId: 's1' },
    ];
    const { document: after, inverse } = applyOps(before, ops);
    expect(after.scenario.scenes.map((s) => s.id)).toEqual(['s2', 's3', 's4']);
    expect(applyOps(after, inverse).document).toEqual(before);
  });

  it('never changes the document it was given', () => {
    const before = base();
    const copy = structuredClone(before);
    applyOps(before, EVERY_OP.slice(0, 8));
    expect(before).toEqual(copy);
  });

  it('removes the clips that play a removed scene, and brings them back on undo', () => {
    const { document, inverse } = applyOps(base(), [{ op: 'scene.remove', sceneId: 's1' }]);
    expect(document.timeline.clips.map((c) => c.id)).toEqual(['c2', 't1']);
    expect(applyOps(document, inverse).document.timeline.clips.map((c) => c.id)).toEqual([
      'c1',
      'c2',
      't1',
    ]);
  });

  it('removes the clips on a removed track, and brings them back on undo', () => {
    const { document, inverse } = applyOps(base(), [
      { op: 'track.remove', trackId: 'track-scene' },
    ]);
    expect(document.timeline.clips.map((c) => c.id)).toEqual(['t1']);
    expect(applyOps(document, inverse).document).toEqual(base());
  });

  it('clamps an index past either end instead of failing', () => {
    const { document } = applyOps(base(), [
      { op: 'scene.add', scene: createScene({ id: 'end' }), index: 99 },
      { op: 'scene.move', sceneId: 's3', index: -4 },
    ]);
    expect(document.scenario.scenes.map((s) => s.id)).toEqual(['s3', 's1', 's2', 'end']);
  });

  it('applies all or nothing: a bad op in the middle leaves the document untouched', () => {
    const before = base();
    expect(() =>
      applyOps(before, [
        { op: 'doc.set', field: 'title', value: 'Changed' },
        { op: 'scene.update', sceneId: 'missing', patch: { title: 'x' } },
      ]),
    ).toThrow(OpError);
    expect(before).toEqual(base());
  });

  it.each<[string, EditOp, RegExp]>([
    ['an unknown scene', { op: 'scene.remove', sceneId: 'nope' }, /scene/],
    ['an unknown track', { op: 'track.update', trackId: 'nope', patch: { muted: true } }, /track/],
    ['an unknown clip', { op: 'clip.remove', clipId: 'nope' }, /clip/],
    [
      'a duplicate scene id',
      { op: 'scene.add', scene: createScene({ id: 's1' }), index: 0 },
      /already/,
    ],
    ['a duplicate clip id', { op: 'clip.add', clip: textClip('t1') }, /already/],
    ['a clip on a missing track', { op: 'clip.add', clip: textClip('t9', 0, 'nowhere') }, /track/],
  ])('explains why it refuses %s', (_name, op, message) => {
    expect(() => applyOps(base(), [op])).toThrow(message);
  });

  it('refuses an op that would leave an invalid document', () => {
    expect(() =>
      applyOps(base(), [{ op: 'scene.update', sceneId: 's1', patch: { targetDuration: 1.5 } }]),
    ).toThrow(OpError);
  });

  it('does nothing for an empty batch', () => {
    const before = base();
    const result = applyOps(before, []);
    expect(result.document).toEqual(before);
    expect(result.inverse).toEqual([]);
  });
});

describe('parseEditOps', () => {
  it('accepts ops as they arrive over IPC or from an AI answer', () => {
    const ops = parseEditOps(JSON.parse(JSON.stringify(EVERY_OP)));
    expect(ops).toHaveLength(EVERY_OP.length);
  });

  it('refuses an op it does not know', () => {
    expect(() => parseEditOps([{ op: 'scene.explode', sceneId: 's1' }])).toThrow(
      /not a valid edit/,
    );
  });

  it('refuses a patch that tries to change an id', () => {
    expect(() =>
      parseEditOps([{ op: 'scene.update', sceneId: 's1', patch: { id: 'x' } }]),
    ).toThrow();
  });

  it.each([
    { op: 'doc.set', field: 'title', value: null },
    { op: 'doc.set', field: 'language', value: 'not a language' },
    { op: 'doc.set', field: 'styleId', value: 'x'.repeat(65) },
  ])('refuses a document field set to something it cannot hold (%o)', (op) => {
    expect(() => parseEditOps([op])).toThrow(/not a valid/);
  });

  it('refuses something that is not a list', () => {
    expect(() => parseEditOps({ op: 'doc.set' })).toThrow(/not a valid edit/);
  });
});
