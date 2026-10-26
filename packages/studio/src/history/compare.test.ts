import { describe, expect, it } from 'vitest';
import { applyOps } from '../document/ops.js';
import { type Clip, createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import { compareDocuments } from './compare.js';

const s = secondsToFlicks;

function video(): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'fa' });
  doc.scenario.scenes = [
    createScene({ id: 'a', title: 'One', targetDuration: s(3) }),
    createScene({ id: 'b', title: 'Two', targetDuration: s(4) }),
    createScene({ id: 'c', title: 'Three', targetDuration: s(2) }),
  ];
  const clip: Clip = {
    id: 'k1',
    trackId: 'track-music',
    start: 0,
    duration: s(5),
    source: { type: 'media', hash: 'f'.repeat(64), in: 0, out: s(5) },
    transitionIn: null,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
  doc.timeline.clips = [clip];
  return doc;
}

describe('comparing two versions', () => {
  it('finds nothing between a version and itself', () => {
    expect(compareDocuments(video(), video())).toEqual([]);
  });

  it('names title, scenario, render, scene and clip changes, with moves read among kept scenes', () => {
    const before = video();
    const after = applyOps(before, [
      { op: 'doc.set', field: 'title', value: 'Launch day' },
      { op: 'scenario.set', patch: { tone: 'warm' } },
      { op: 'render.set', patch: { resolution: '720p' } },
      {
        op: 'scene.update',
        sceneId: 'a',
        patch: { narration: 'سلام', code: { treeHash: 'a'.repeat(64) } },
      },
      { op: 'scene.move', sceneId: 'c', index: 0 },
      { op: 'scene.remove', sceneId: 'b' },
      {
        op: 'scene.add',
        index: 2,
        scene: createScene({ id: 'd', title: 'Four', narration: 'End' }),
      },
      { op: 'clip.update', clipId: 'k1', patch: { gain: 0.5, start: s(1) } },
      { op: 'track.update', trackId: 'track-music', patch: { muted: true } },
    ]).document;
    const names = new Map([['f'.repeat(64), 'song.wav']]);
    const changes = compareDocuments(before, after, names);
    expect(changes.map((c) => c.kind)).toEqual([
      'title',
      'scenario',
      'scene-removed',
      'scene-moved',
      'scene-changed',
      'scene-added',
      'clip-changed',
      'track-changed',
    ]);
    expect(changes.find((c) => c.kind === 'scenario')).toMatchObject({
      changes: [
        { label: 'Tone', before: '', after: 'warm' },
        { label: 'Render size', before: '1080p', after: '720p' },
      ],
    });
    expect(changes.find((c) => c.kind === 'scene-changed')).toMatchObject({
      sceneId: 'a',
      changes: [
        { label: 'Narration', after: 'سلام' },
        { label: 'Animation', before: 'none' },
      ],
    });
    expect(changes.find((c) => c.kind === 'clip-changed')).toMatchObject({
      label: 'song.wav',
      changes: [
        { label: 'Start', before: '0 s', after: '1 s' },
        { label: 'Volume', before: '100%', after: '50%' },
      ],
    });
  });

  it('names clips added and removed, captions by their words', () => {
    const before = video();
    const after = applyOps(before, [
      { op: 'clip.remove', clipId: 'k1' },
      {
        op: 'clip.add',
        clip: {
          id: 'k2',
          trackId: 'track-text',
          start: s(2),
          duration: s(1),
          source: { type: 'text', text: 'سلام دنیا', lang: 'fa', dir: 'auto' },
          transitionIn: null,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
        },
      },
    ]).document;
    expect(compareDocuments(before, after)).toEqual([
      { kind: 'clip-removed', clipId: 'k1', track: expect.any(String), label: 'a file' },
      {
        kind: 'clip-added',
        clipId: 'k2',
        track: expect.any(String),
        label: 'سلام دنیا',
        startSeconds: 2,
      },
    ]);
  });

  it('names every scene field and clip field it watches, and a scene clip', () => {
    const before = video();
    before.timeline.clips.push({
      id: 'k3',
      trackId: 'track-text',
      start: 0,
      duration: s(1),
      source: { type: 'text', text: 'one', lang: 'en', dir: 'auto' },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    before.timeline.clips.push({
      id: 'k4',
      trackId: 'track-scene',
      start: 0,
      duration: s(1),
      source: { type: 'scene', sceneId: 'a' },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    const after = applyOps(before, [
      { op: 'clip.update', clipId: 'k4', patch: { gain: 0.5 } },
      {
        op: 'scene.update',
        sceneId: 'b',
        patch: {
          title: 'Too',
          onScreenText: ['Hi'],
          targetDuration: s(5),
          timing: 'fixed',
          visualKind: 'media',
          visualBrief: 'A desk',
          musicCue: 'calm',
          voiceRef: 'openai:marin',
          transitionOut: { kind: 'fade', duration: s(0.5) },
        },
      },
      { op: 'clip.update', clipId: 'k1', patch: { duration: s(4), fadeIn: s(1), fadeOut: s(1) } },
      {
        op: 'clip.update',
        clipId: 'k3',
        patch: { source: { type: 'text', text: 'two', lang: 'en', dir: 'auto' } },
      },
    ]).document;
    const changes = compareDocuments(before, after);
    const scene = changes.find((c) => c.kind === 'scene-changed');
    expect(scene?.kind === 'scene-changed' && scene.changes.map((c) => c.label)).toEqual([
      'Title',
      'On screen',
      'Length',
      'Timing',
      'Visual',
      'What it shows',
      'Hand over',
      'Music',
      'Voice',
    ]);
    const clips = changes.filter((c) => c.kind === 'clip-changed');
    expect(clips.map((c) => c.kind === 'clip-changed' && c.changes.map((f) => f.label))).toEqual([
      ['Length', 'Fade in', 'Fade out'],
      ['Words'],
      ['Volume'],
    ]);
    expect(clips[2]).toMatchObject({ label: 'a scene' });
    expect(clips[0]).toMatchObject({ label: 'a file' });
  });
});
