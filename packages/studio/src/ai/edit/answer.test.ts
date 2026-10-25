import { describe, expect, it } from 'vitest';
import { applyOps } from '../../document/ops.js';
import { createDocument, createScene, type StudioDocument } from '../../document/schema.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { readEditAnswer } from './answer.js';

function doc(): StudioDocument {
  const d = createDocument({ id: 'v1', title: 'Water', language: 'en' });
  d.scenario.logline = 'A film about water.';
  d.scenario.scenes = [
    createScene({
      id: 'a',
      title: 'Open',
      narration: 'Water is life.',
      targetDuration: secondsToFlicks(5),
    }),
    createScene({ id: 'b', title: 'Middle', narration: 'It is rare.' }),
    createScene({ id: 'c', title: 'Close', narration: 'Save it.' }),
  ];
  return d;
}

const ids = () => {
  let n = 0;
  return () => `new${++n}`;
};

function read(answer: unknown, d = doc()) {
  return readEditAnswer(JSON.stringify(answer), d, ids());
}

describe('readEditAnswer', () => {
  it('turns a scene change into one op with a readable before and after', () => {
    const result = read({
      summary: 'Shortened the opening.',
      ops: [
        { op: 'scene.update', sceneId: 'a', patch: { durationSeconds: 3, narration: 'Water.' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes).toEqual([
      {
        kind: 'scene-changed',
        sceneId: 'a',
        position: 1,
        title: 'Open',
        // In the schema's field order, whatever order the answer used.
        changes: [
          { field: 'narration', label: 'Narration', before: 'Water is life.', after: 'Water.' },
          { field: 'durationSeconds', label: 'Length', before: '5 s', after: '3 s' },
        ],
      },
    ]);
    const applied = applyOps(doc(), result.value.ops).document;
    expect(applied.scenario.scenes[0]?.targetDuration).toBe(secondsToFlicks(3));
  });

  it('places added and moved scenes by "after", checked step by step', () => {
    const result = read({
      summary: 'Added a hook and moved the close up.',
      ops: [
        {
          op: 'scene.add',
          after: null,
          scene: { title: 'Hook', narration: 'Did you know?', durationSeconds: 2 },
        },
        { op: 'scene.move', sceneId: 'c', after: 'a' },
        { op: 'scene.remove', sceneId: 'b' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyOps(doc(), result.value.ops).document;
    expect(applied.scenario.scenes.map((s) => s.id)).toEqual(['new1', 'a', 'c']);
    expect(result.value.changes.map((c) => c.kind)).toEqual([
      'scene-added',
      'scene-moved',
      'scene-removed',
    ]);
    expect(result.value.changes[1]).toMatchObject({ from: 4, to: 3 });
  });

  it('changes the title and the logline', () => {
    const result = read({
      summary: 'Retitled.',
      ops: [
        { op: 'title.set', value: 'Every drop' },
        { op: 'scenario.set', patch: { tone: 'hopeful' } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes).toEqual([
      { kind: 'title', before: 'Water', after: 'Every drop' },
      {
        kind: 'scenario',
        changes: [{ field: 'tone', label: 'Tone', before: '', after: 'hopeful' }],
      },
    ]);
  });

  it('reports an unknown scene id so a repair round can fix it', () => {
    const result = read({ summary: 'x', ops: [{ op: 'scene.remove', sceneId: 'zzz' }] });
    expect(result).toEqual({ ok: false, issues: ['There is no scene with the id zzz.'] });
  });

  it('refuses a move after itself and an empty patch', () => {
    expect(read({ summary: 'x', ops: [{ op: 'scene.move', sceneId: 'a', after: 'a' }] })).toEqual({
      ok: false,
      issues: ['A scene cannot move after itself.'],
    });
    const empty = read({ summary: 'x', ops: [{ op: 'scene.update', sceneId: 'a', patch: {} }] });
    expect(empty.ok).toBe(false);
  });

  it('says so when the answer changes nothing', () => {
    const result = read({
      summary: 'x',
      ops: [{ op: 'scene.update', sceneId: 'a', patch: { title: 'Open' } }],
    });
    expect(result).toEqual({
      ok: false,
      issues: ['The changes leave the scenario exactly as it was.'],
    });
  });

  it('checks the language of new narration', () => {
    const fa = doc();
    fa.language = 'fa';
    const result = read(
      {
        summary: 'x',
        ops: [{ op: 'scene.update', sceneId: 'a', patch: { narration: 'English' } }],
      },
      fa,
    );
    expect(result).toEqual({
      ok: false,
      issues: ['Write the narration and on-screen text in Persian.'],
    });
  });
});

it('reads near-miss transition names in added and changed scenes', () => {
  const result = readEditAnswer(
    JSON.stringify({
      summary: 'x',
      ops: [
        { op: 'scene.update', sceneId: 'a', patch: { transition: 'crossfade' } },
        {
          op: 'scene.add',
          after: 'a',
          scene: { title: 'N', narration: 'n', durationSeconds: 2, transition: 'fade-in' },
        },
      ],
    }),
    doc(),
    ids(),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const applied = applyOps(doc(), result.value.ops).document;
  expect(applied.scenario.scenes[0]?.transitionOut?.kind).toBe('fade');
  expect(applied.scenario.scenes[1]?.transitionOut?.kind).toBe('fade');
});
