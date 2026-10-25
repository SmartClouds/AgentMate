import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createScene } from '../document/schema.js';
import { FLICKS_PER_SECOND, secondsToFlicks } from '../time/flicks.js';
import {
  formatIssues,
  normalizeScene,
  sceneForPrompt,
  toDuration,
  toScenePatch,
} from './answerShapes.js';

describe('toScenePatch', () => {
  it('maps every AI field onto the document scene', () => {
    expect(
      toScenePatch(
        {
          title: 't',
          narration: 'n',
          onScreenText: ['a'],
          durationSeconds: 2,
          visualKind: 'media',
          visualBrief: 'v',
          transition: 'wipeleft',
          musicCue: 'm',
          notes: 'x',
        },
        30,
      ),
    ).toEqual({
      title: 't',
      narration: 'n',
      onScreenText: ['a'],
      targetDuration: secondsToFlicks(2),
      visualKind: 'media',
      visualBrief: 'v',
      transitionOut: { kind: 'wipeleft', duration: FLICKS_PER_SECOND / 2 },
      musicCue: 'm',
      notes: 'x',
    });
  });

  it('turns "cut" into no transition and leaves untouched fields out', () => {
    expect(toScenePatch({ transition: 'cut' }, 30)).toEqual({ transitionOut: null });
  });
});

describe('toDuration', () => {
  it('never rounds a scene down to nothing', () => {
    expect(toDuration(0.001, 24)).toBe(FLICKS_PER_SECOND / 24);
  });
});

describe('sceneForPrompt', () => {
  it('shows seconds and the transition name, and notes only when there are some', () => {
    const scene = createScene({
      id: 's1',
      targetDuration: secondsToFlicks(4.25),
      transitionOut: { kind: 'fade', duration: 1 },
    });
    expect(sceneForPrompt(scene)).toMatchObject({
      id: 's1',
      durationSeconds: 4.3,
      transition: 'fade',
    });
    expect(sceneForPrompt(scene)).not.toHaveProperty('notes');
    expect(sceneForPrompt({ ...scene, notes: 'keep' })).toMatchObject({ notes: 'keep' });
  });
});

describe('formatIssues', () => {
  it('caps a long list and says how many more there were', () => {
    const result = z.array(z.string()).safeParse([1, 2, 3, 4]);
    if (result.success) throw new Error('fixture');
    const lines = formatIssues(result.error, 2);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[0\]: /);
    expect(lines[2]).toBe('... and 2 more.');
  });

  it('prints a root issue without a path', () => {
    const result = z.string().safeParse(1);
    if (result.success) throw new Error('fixture');
    expect(formatIssues(result.error)[0]).not.toContain(':  ');
  });
});

describe('normalizeScene', () => {
  it('maps transition names a model makes up onto the ones Studio renders', () => {
    // Grok answered "fadeout" in the E32 spike, which cost a whole repair round.
    expect(normalizeScene({ transition: 'fadeout' })).toEqual({ transition: 'fade' });
    expect(normalizeScene({ transition: 'Cross-Fade' })).toEqual({ transition: 'fade' });
    expect(normalizeScene({ transition: 'fade to black' })).toEqual({ transition: 'fadeblack' });
    expect(normalizeScene({ transition: 'none' })).toEqual({ transition: 'cut' });
    expect(normalizeScene({ transition: 'WipeLeft' })).toEqual({ transition: 'wipeleft' });
    expect(normalizeScene({ transition: 'zoom spin' })).toEqual({ transition: 'cut' });
  });

  it('treats an unknown visual kind as motion graphics, and leaves everything else alone', () => {
    expect(normalizeScene({ visualKind: 'animation', title: 'x' })).toEqual({
      visualKind: 'motion',
      title: 'x',
    });
    expect(normalizeScene({ visualKind: 'Media' })).toEqual({ visualKind: 'media' });
    expect(normalizeScene({ transition: 3 })).toEqual({ transition: 3 });
    expect(normalizeScene('not a scene')).toBe('not a scene');
  });
});
