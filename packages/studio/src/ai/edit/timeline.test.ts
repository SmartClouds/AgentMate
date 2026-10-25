import { describe, expect, it } from 'vitest';
import { applyOps } from '../../document/ops.js';
import {
  type Clip,
  createDocument,
  createScene,
  type StudioDocument,
} from '../../document/schema.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { buildEditRequest } from '../prompts.js';
import { type EditContext, readEditAnswer } from './answer.js';

/** Edits by typing that change the timeline: clips, captions and tracks. */

const s = secondsToFlicks;
const SONG = 'a'.repeat(64);
const BEACH = 'b'.repeat(64);
const CONTEXT: EditContext = {
  media: [
    { hash: SONG, name: 'Song.mp3', kind: 'audio', duration: s(30) },
    { hash: BEACH, name: 'beach.mp4', kind: 'video', duration: s(8) },
  ],
};

function video(): StudioDocument {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'en' });
  doc.scenario.scenes = [
    createScene({
      id: 's1',
      narration: 'Meet the new app. It saves you an hour a day.',
      targetDuration: s(6),
    }),
    createScene({ id: 's2', narration: '', targetDuration: s(4) }),
  ];
  return doc;
}

function answer(ops: unknown[]): string {
  return JSON.stringify({ summary: 'Done.', ops });
}

let n = 0;
const makeId = () => `n${++n}`;

function read(doc: StudioDocument, ops: unknown[]) {
  return readEditAnswer(answer(ops), doc, makeId, CONTEXT);
}

function accepted(doc: StudioDocument, ops: unknown[]) {
  const result = read(doc, ops);
  if (!result.ok) throw new Error(result.issues.join(' '));
  return { proposal: result.value, after: applyOps(doc, result.value.ops).document };
}

describe('timeline changes by typing', () => {
  it('adds music by file name, trimmed and quieter, as one readable change', () => {
    const { proposal, after } = accepted(video(), [
      {
        op: 'clip.add',
        track: 'music',
        file: 'song.MP3',
        startSeconds: 0,
        durationSeconds: 10,
        volume: 0.4,
      },
    ]);
    const clip = after.timeline.clips[0] as Clip;
    expect(clip).toMatchObject({
      trackId: 'track-music',
      start: 0,
      duration: s(10),
      gain: 0.4,
      source: { hash: SONG, in: 0, out: s(10) },
    });
    expect(proposal.changes).toEqual([
      { kind: 'clip-added', clipId: clip.id, track: 'Music', label: 'Song.mp3', startSeconds: 0 },
    ]);
  });

  it('adds a caption, captions a scene from its narration, and changes and removes clips', () => {
    const { after: withCaption } = accepted(video(), [
      {
        op: 'clip.add',
        track: 'text',
        text: 'Free for a month',
        startSeconds: 7,
        durationSeconds: 2,
      },
    ]);
    const caption = withCaption.timeline.clips[0] as Clip;
    expect(caption).toMatchObject({
      start: s(7),
      duration: s(2),
      source: { type: 'text', text: 'Free for a month', lang: 'en' },
    });

    const { proposal: captioned, after: withNarration } = accepted(withCaption, [
      { op: 'captions.fromNarration', sceneId: 's1' },
    ]);
    expect(captioned.changes).toEqual([
      { kind: 'captions-added', sceneId: 's1', position: 1, count: 2 },
    ]);
    expect(withNarration.timeline.clips).toHaveLength(3);

    const { proposal: changed, after: moved } = accepted(withNarration, [
      {
        op: 'clip.update',
        clipId: caption.id,
        startSeconds: 8,
        fadeInSeconds: 0.5,
        text: 'Free for 30 days',
      },
    ]);
    expect(changed.changes[0]).toMatchObject({
      kind: 'clip-changed',
      label: '"Free for a month"',
      changes: [
        { field: 'start', before: '7 s', after: '8 s' },
        { field: 'fadeIn', before: '0 s', after: '0.5 s' },
        { field: 'text', before: 'Free for a month', after: 'Free for 30 days' },
      ],
    });
    const { proposal: removed, after: gone } = accepted(moved, [
      { op: 'clip.remove', clipId: caption.id },
    ]);
    expect(removed.changes).toEqual([
      { kind: 'clip-removed', clipId: caption.id, track: 'Text', label: '"Free for 30 days"' },
    ]);
    expect(gone.timeline.clips).toHaveLength(2);
  });

  it('mutes a track and sets its volume', () => {
    const { proposal, after } = accepted(video(), [
      { op: 'track.set', track: 'music', muted: true, volume: 0.5 },
    ]);
    expect(after.timeline.tracks.find((t) => t.kind === 'music')).toMatchObject({
      muted: true,
      volume: 0.5,
    });
    expect(proposal.changes).toEqual([
      {
        kind: 'track-changed',
        track: 'Music',
        changes: [
          { field: 'muted', label: 'Muted', before: 'No', after: 'Yes' },
          { field: 'volume', label: 'Volume', before: '100%', after: '50%' },
        ],
      },
    ]);
  });

  it('sends back what is wrong, for a repair round', () => {
    const doc = video();
    const issues = (ops: unknown[]) => {
      const result = read(doc, ops);
      return result.ok ? [] : result.issues;
    };
    expect(issues([{ op: 'clip.add', track: 'music', file: 'nope.mp3', startSeconds: 0 }])).toEqual(
      ['There is no file named "nope.mp3" in the files list.'],
    );
    expect(
      issues([{ op: 'clip.add', track: 'image', file: 'beach.mp4', startSeconds: 0 }]),
    ).toEqual(['beach.mp4 is video, so it goes on a video track.']);
    expect(issues([{ op: 'clip.add', track: 'text', startSeconds: 0 }])).toEqual([
      'A text clip needs its words in "text".',
    ]);
    expect(issues([{ op: 'clip.remove', clipId: 'zz' }])).toEqual([
      'There is no clip with the id zz.',
    ]);
    expect(issues([{ op: 'captions.fromNarration', sceneId: 's2' }])).toEqual([
      'Scene 2 has no narration to caption.',
    ]);
    expect(issues([{ op: 'track.set', track: 'music', muted: false }])).toEqual([
      'The changes leave the scenario exactly as it was.',
    ]);
    expect(issues([{ op: 'clip.update', clipId: 'x' }])[0]).toMatch(
      /A clip change must change something/,
    );
    // Two clips in the same spot on one track.
    expect(
      issues([
        { op: 'clip.add', track: 'video', file: 'beach.mp4', startSeconds: 0 },
        { op: 'clip.update', clipId: 'missing', startSeconds: 0 },
      ]),
    ).toEqual(['There is no clip with the id missing.']);
    const { after } = accepted(doc, [{ op: 'captions.fromNarration', sceneId: 's1' }]);
    const again = readEditAnswer(
      answer([{ op: 'captions.fromNarration', sceneId: 's1' }]),
      after,
      makeId,
      CONTEXT,
    );
    expect(again.ok ? [] : again.issues).toEqual([
      'There are captions over scene 1 already; remove them first.',
    ]);
  });

  it('shows the AI the timeline, the files and where each scene plays', () => {
    const { after } = accepted(video(), [
      { op: 'clip.add', track: 'music', file: 'Song.mp3', startSeconds: 1 },
    ]);
    const request = buildEditRequest({
      instruction: 'make the music quieter',
      document: after,
      media: CONTEXT.media,
    });
    expect(request).toContain('## The timeline now');
    expect(request).toContain('"file": "Song.mp3"');
    expect(request).toContain('"durationSeconds": 30');
    expect(request).toContain('"id": "s2",\n   "startSeconds": 6,\n   "endSeconds": 10');
    expect(request).toContain('captions.fromNarration');
  });
});
