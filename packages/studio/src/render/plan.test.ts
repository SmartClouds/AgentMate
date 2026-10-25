import { describe, expect, it } from 'vitest';
import { createDocument, createScene, type StudioDocument } from '../document/schema.js';
import { secondsToFlicks } from '../time/flicks.js';
import { buildRenderPlan, estimateRender, planSeconds, type RenderPlan } from './plan.js';

const TREE = 'a'.repeat(64);
const OTHER_TREE = 'b'.repeat(64);

function video(scenes: Parameters<typeof createScene>[0][], edit?: (doc: StudioDocument) => void) {
  const doc = createDocument({ id: 'v1', title: 'Launch', language: 'fa' });
  doc.scenario.scenes = scenes.map((s) => createScene({ code: { treeHash: TREE }, ...s }));
  edit?.(doc);
  return doc;
}

function plan(doc: StudioDocument, chunkSeconds?: number): RenderPlan {
  const result = buildRenderPlan(doc, { runtimeVersion: '1', chunkSeconds });
  if (!result.ok) throw new Error(result.problems.join(' '));
  return result.plan;
}

describe('buildRenderPlan', () => {
  it('counts each scene in frames at the video frame rate, and chunks it in two seconds', () => {
    const p = plan(video([{ id: 's1', targetDuration: secondsToFlicks(5) }]));
    expect(p).toMatchObject({ width: 1920, height: 1080, scale: 1, fps: 30, totalFrames: 150 });
    expect(p.scenes[0]?.frames).toBe(150);
    expect(p.scenes[0]?.chunks).toEqual([
      { index: 0, from: 0, count: 60 },
      { index: 1, from: 60, count: 60 },
      { index: 2, from: 120, count: 30 },
    ]);
  });

  it('rounds a scene that does not end on a frame to the nearest one', () => {
    // 1.01 s at 30 fps is 30.3 frames.
    const p = plan(video([{ id: 's1', targetDuration: secondsToFlicks(1.01) }]));
    expect(p.scenes[0]?.frames).toBe(30);
    expect(p.scenes[0]?.chunks).toEqual([{ index: 0, from: 0, count: 30 }]);
  });

  it('follows the frame rate and the output size the video is set to', () => {
    const p = plan(
      video([{ id: 's1', targetDuration: secondsToFlicks(2) }], (doc) => {
        doc.renderSettings.fps = 60;
        doc.renderSettings.aspect = '9:16';
        doc.renderSettings.resolution = '2160p';
      }),
      1,
    );
    expect(p).toMatchObject({ width: 2160, height: 3840, scale: 2, fps: 60, totalFrames: 120 });
    expect(p.design).toEqual({ width: 1080, height: 1920 });
    expect(p.scenes[0]?.chunks.map((c) => c.count)).toEqual([60, 60]);
  });

  it('takes the overlap of each transition out of the finished length, but not out of capture', () => {
    const p = plan(
      video([
        {
          id: 's1',
          targetDuration: secondsToFlicks(3),
          transitionOut: { kind: 'fade', duration: secondsToFlicks(0.5) },
        },
        { id: 's2', targetDuration: secondsToFlicks(2) },
        {
          id: 's3',
          targetDuration: secondsToFlicks(2),
          // The last scene has nothing to transition to, so this is ignored.
          transitionOut: { kind: 'dissolve', duration: secondsToFlicks(1) },
        },
      ]),
    );
    expect(p.transitions).toEqual([{ after: 0, kind: 'fade', frames: 15 }]);
    expect(p.captureFrames).toBe(90 + 60 + 60);
    expect(p.totalFrames).toBe(210 - 15);
    expect(planSeconds(p)).toBe(6.5);
  });

  it('lists every reason a video cannot render yet, all at once', () => {
    const result = buildRenderPlan(
      video([
        { id: 's1', code: { treeHash: null } },
        {
          id: 's2',
          targetDuration: secondsToFlicks(1),
          transitionOut: { kind: 'fade', duration: secondsToFlicks(1) },
        },
        { id: 's3', targetDuration: secondsToFlicks(3) },
        { id: 's4', code: { treeHash: null } },
      ]),
      { runtimeVersion: '1' },
    );
    expect(result).toEqual({
      ok: false,
      problems: [
        'Scene 1 has no animation yet. Animate it, or remove it.',
        'Scene 4 has no animation yet. Animate it, or remove it.',
        'The transition after scene 2 is as long as a scene it joins; make it shorter.',
      ],
    });
  });

  it('refuses a video with no scenes', () => {
    expect(buildRenderPlan(video([]), { runtimeVersion: '1' })).toEqual({
      ok: false,
      problems: ['The video has no scenes yet.'],
    });
  });

  it('skips a transition shorter than a frame', () => {
    const p = plan(
      video([{ id: 's1', transitionOut: { kind: 'fade', duration: 1000 } }, { id: 's2' }]),
    );
    expect(p.transitions).toEqual([]);
    expect(p.totalFrames).toBe(300);
  });

  it('changes a scene cache key only when something that shows in its frames changes', () => {
    const base = video([{ id: 's1' }, { id: 's2' }]);
    const key = (doc: StudioDocument, runtimeVersion = '1', index = 0) => {
      const result = buildRenderPlan(doc, { runtimeVersion });
      if (!result.ok) throw new Error('no plan');
      return result.plan.scenes[index]?.cacheInputs;
    };
    const first = key(base);
    expect(key(structuredClone(base))).toBe(first);

    const narration = structuredClone(base);
    narration.scenario.scenes[0] = {
      ...narration.scenario.scenes[0]!,
      narration: 'Spoken, not drawn',
    };
    expect(key(narration)).toBe(first);

    const code = structuredClone(base);
    code.scenario.scenes[0] = { ...code.scenario.scenes[0]!, code: { treeHash: OTHER_TREE } };
    expect(key(code)).not.toBe(first);

    const length = structuredClone(base);
    length.scenario.scenes[0] = {
      ...length.scenario.scenes[0]!,
      targetDuration: secondsToFlicks(6),
    };
    expect(key(length)).not.toBe(first);

    const params = structuredClone(base);
    params.scenario.scenes[0] = { ...params.scenario.scenes[0]!, params: { color: 'red' } };
    expect(key(params)).not.toBe(first);

    const size = structuredClone(base);
    size.renderSettings.resolution = '720p';
    expect(key(size)).not.toBe(first);

    const language = structuredClone(base);
    language.language = 'en';
    expect(key(language)).not.toBe(first);

    expect(key(base, '2')).not.toBe(first);
    // Two scenes with the same code differ by seed, so their frames are not shared.
    expect(key(base, '1', 1)).not.toBe(first);

    // Quality and codec change only the encode, never the captured frames.
    const encode = structuredClone(base);
    encode.renderSettings.quality = 'master';
    encode.renderSettings.codec = 'vp9';
    expect(key(encode)).toBe(first);
  });
});

describe('estimateRender', () => {
  it('scales the size with quality and the time with pixels', () => {
    const doc = video([{ id: 's1', targetDuration: secondsToFlicks(10) }]);
    const standard = estimateRender(plan(doc));
    expect(standard.durationSeconds).toBe(10);
    // 1920x1080 x 0.08 bits x 300 frames / 8.
    expect(standard.outputBytes).toBe(6_220_800);
    expect(standard.cacheBytes).toBe(1920 * 1080 * 300);
    expect(standard.seconds).toBe(15 + 5 + 5);

    doc.renderSettings.quality = 'master';
    doc.renderSettings.resolution = '2160p';
    const master = estimateRender(plan(doc));
    expect(master.outputBytes).toBeGreaterThan(standard.outputBytes * 10);
    expect(master.seconds).toBe(60 + 5 + 5);
  });
});
