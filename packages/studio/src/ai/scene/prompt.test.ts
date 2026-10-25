import { describe, expect, it } from 'vitest';
import { createDocument, createScene } from '../../document/schema.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { buildSceneFixRequest, buildSceneRequest, SCENE_AUTHORING_GUIDE } from './prompt.js';

function doc() {
  const d = createDocument({ id: 'v1', title: 'آب', language: 'fa', aspect: '9:16' });
  d.styleId = 'flat-vector';
  d.scenario.scenes = [
    createScene({
      id: 's1',
      title: 'قطره',
      narration: 'هر قطره مهم است.',
      onScreenText: ['هر قطره', 'مهم است'],
      visualBrief: 'A drop falls into a glass.',
      targetDuration: secondsToFlicks(6),
    }),
    createScene({ id: 's2', title: 'پایان' }),
  ];
  return d;
}

describe('buildSceneRequest', () => {
  it('carries the scene, the size, the style, the runtime contract and the answer format', () => {
    const text = buildSceneRequest({ document: doc(), sceneId: 's1' });
    expect(text).toContain('# Animate a scene of a video');
    expect(text).toContain('Scene 1 of 2: قطره');
    expect(text).toContain('Design size: 1080x1920 (9:16)');
    expect(text).toContain('about 6 seconds');
    expect(text).toContain('right to left');
    expect(text).toContain('The next scene is "پایان"');
    expect(text).toContain('~~~~text\nهر قطره\nمهم است\n~~~~');
    expect(text).toContain('A drop falls into a glass.');
    expect(text).toContain('## Visual style: Flat vector');
    expect(text).toContain(SCENE_AUTHORING_GUIDE);
    expect(text).toContain('```html file:index.html');
    expect(text).toMatch(/U\+200C/);
  });

  it('includes the current files and the change asked for, for a new version', () => {
    const text = buildSceneRequest({
      document: doc(),
      sceneId: 's2',
      instruction: 'Make the text bigger',
      current: [{ path: 'index.html', content: '<p>x</p>\n' }],
    });
    expect(text).toContain('# Change a scene of a video');
    expect(text).toContain('Make the text bigger');
    expect(text).toContain('```html file:index.html\n<p>x</p>\n```');
    expect(text).toContain('This is the last scene');
    expect(text).toContain('(no narration)');
    expect(text).toContain('design it from the narration');
  });

  it('shows the style reference scene as an example when animating from scratch, not when changing', () => {
    const example = [{ path: 'index.html', content: '<p>example</p>\n' }];
    const fresh = buildSceneRequest({ document: doc(), sceneId: 's1', example });
    expect(fresh).toContain('## An example in this style');
    expect(fresh).toContain('```html file:index.html\n<p>example</p>\n```');
    const change = buildSceneRequest({
      document: doc(),
      sceneId: 's1',
      example,
      instruction: 'x',
      current: [{ path: 'index.html', content: 'y\n' }],
    });
    expect(change).not.toContain('## An example in this style');
  });

  it('refuses a scene that is not in the video', () => {
    expect(() => buildSceneRequest({ document: doc(), sceneId: 'nope' })).toThrow(
      /not in the video/,
    );
  });
});

describe('buildSceneFixRequest', () => {
  it('lists the problems and the scene as written, then the original request', () => {
    const text = buildSceneFixRequest(
      'ORIGINAL',
      [{ path: 'scene.js', content: 'x\n' }],
      ['Frame 3 differs when drawn twice.'],
    );
    expect(text).toContain('- Frame 3 differs when drawn twice.');
    expect(text).toContain('```js file:scene.js\nx\n```');
    expect(text.indexOf('ORIGINAL')).toBeGreaterThan(text.indexOf('scene.js'));
  });
});
