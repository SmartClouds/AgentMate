import { describe, expect, it } from 'vitest';
import { secondsToFlicks } from '../time/flicks.js';
import {
  createDocument,
  createScene,
  DESIGN_SIZES,
  outputSize,
  parseDocument,
  STUDIO_SCHEMA_VERSION,
  type StudioDocument,
} from './schema.js';

function doc(overrides: Partial<StudioDocument> = {}): StudioDocument {
  return { ...createDocument({ id: 'v1', title: 'Launch film', language: 'fa' }), ...overrides };
}

describe('createDocument', () => {
  it('starts an empty video with the given title and language and sensible render settings', () => {
    const d = createDocument({ id: 'v1', title: 'Launch film', language: 'fa', aspect: '9:16' });
    expect(d.schemaVersion).toBe(STUDIO_SCHEMA_VERSION);
    expect(d.title).toBe('Launch film');
    expect(d.language).toBe('fa');
    expect(d.scenario.scenes).toEqual([]);
    expect(d.timeline.clips).toEqual([]);
    expect(d.renderSettings).toMatchObject({
      aspect: '9:16',
      resolution: '1080p',
      fps: 30,
      quality: 'standard',
      codec: 'h264',
    });
    // Each kind of track exists from the start, so a new clip always has somewhere to go.
    expect(d.timeline.tracks.map((t) => t.kind)).toEqual([
      'scene',
      'video',
      'image',
      'text',
      'voice',
      'music',
      'sfx',
    ]);
  });

  it('defaults to 16:9 when no aspect is given', () => {
    expect(doc().renderSettings.aspect).toBe('16:9');
  });
});

describe('createScene', () => {
  it('fills every field so a hand-made scene is as complete as a generated one', () => {
    const scene = createScene({ id: 's1', title: 'Hook' });
    expect(scene).toMatchObject({
      id: 's1',
      title: 'Hook',
      narration: '',
      onScreenText: [],
      timing: 'narration',
      visualKind: 'motion',
      code: { treeHash: null },
    });
    expect(scene.targetDuration).toBe(secondsToFlicks(5));
  });
});

describe('parseDocument', () => {
  it('accepts a document it wrote', () => {
    const d = doc({ scenario: { ...doc().scenario, scenes: [createScene({ id: 's1' })] } });
    expect(parseDocument(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('keeps Persian text exactly as written, ZWNJ included', () => {
    const title = 'می‌خواهم ویدئو بسازم';
    expect(parseDocument(doc({ title })).title).toBe(title);
  });

  it('refuses a document from a newer Studio rather than dropping what it cannot read', () => {
    expect(() => parseDocument({ ...doc(), schemaVersion: STUDIO_SCHEMA_VERSION + 1 })).toThrow(
      /newer version of AgentMate/,
    );
  });

  it('refuses something that is not a Studio document', () => {
    expect(() => parseDocument({ hello: 'world' })).toThrow(/not a Studio video/);
    expect(() => parseDocument(null)).toThrow(/not a Studio video/);
  });

  it('refuses times that are not whole flicks', () => {
    const scene = { ...createScene({ id: 's1' }), targetDuration: 1.5 };
    const bad = doc({ scenario: { ...doc().scenario, scenes: [scene] } });
    expect(() => parseDocument(bad)).toThrow();
  });

  it('refuses a clip on a track that does not exist', () => {
    const d = doc();
    const bad = {
      ...d,
      timeline: {
        ...d.timeline,
        clips: [
          {
            id: 'c1',
            trackId: 'nope',
            start: 0,
            duration: secondsToFlicks(1),
            source: { type: 'text', text: 'Hi', lang: 'en', dir: 'auto' },
            transitionIn: null,
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
          },
        ],
      },
    };
    expect(() => parseDocument(bad)).toThrow(/track/);
  });

  it('refuses duplicate scene ids', () => {
    const bad = doc({
      scenario: {
        ...doc().scenario,
        scenes: [createScene({ id: 's1' }), createScene({ id: 's1' })],
      },
    });
    expect(() => parseDocument(bad)).toThrow(/duplicate/i);
  });
});

describe('outputSize', () => {
  it('scales the fixed design size of each aspect, so preview and render lay out the same', () => {
    expect(DESIGN_SIZES['16:9']).toEqual({ width: 1920, height: 1080 });
    expect(outputSize('16:9', '1080p')).toEqual({ width: 1920, height: 1080, scale: 1 });
    expect(outputSize('16:9', '720p')).toEqual({ width: 1280, height: 720, scale: 2 / 3 });
    expect(outputSize('16:9', '2160p')).toEqual({ width: 3840, height: 2160, scale: 2 });
    expect(outputSize('9:16', '1440p')).toEqual({ width: 1440, height: 2560, scale: 4 / 3 });
    expect(outputSize('4:5', '720p')).toEqual({ width: 720, height: 900, scale: 2 / 3 });
    expect(outputSize('1:1', '1080p')).toEqual({ width: 1080, height: 1080, scale: 1 });
  });

  it('always gives even sizes, which H.264 and H.265 need', () => {
    for (const aspect of Object.keys(DESIGN_SIZES) as (keyof typeof DESIGN_SIZES)[]) {
      for (const resolution of ['720p', '1080p', '1440p', '2160p'] as const) {
        const { width, height } = outputSize(aspect, resolution);
        expect(width % 2, `${aspect} ${resolution}`).toBe(0);
        expect(height % 2, `${aspect} ${resolution}`).toBe(0);
      }
    }
  });
});
