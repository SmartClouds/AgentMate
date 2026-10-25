import { describe, expect, it, vi } from 'vitest';
import { checkScene, isBlank, type SceneFrame, type SceneFrameSource, sameFrame } from './check.js';

/** A frame filled with one color, with an optional small mark of another (a few pixels). */
function frame(fill: number, dot?: number): SceneFrame {
  const bitmap = new Uint8Array(16 * 16 * 4).fill(fill);
  for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255;
  if (dot !== undefined) for (let k = 0; k < 4; k++) bitmap.set([dot, dot, dot, 255], k * 68);
  return { width: 16, height: 16, bitmap };
}

function source(
  draw: (t: number, call: number) => SceneFrame,
  over: Partial<SceneFrameSource> = {},
) {
  let calls = 0;
  const problems: string[] = [];
  const s: SceneFrameSource & { reported: string[] } = {
    reported: problems,
    open: vi.fn(async () => undefined),
    waitReady: vi.fn(async () => true),
    frame: vi.fn(async (t: number) => draw(t, calls++)),
    problems: () => problems,
    close: vi.fn(async () => undefined),
    ...over,
  };
  return s;
}

const options = { url: 'studio-scene://t-x/index.html', duration: 4, fps: 30 };

describe('isBlank', () => {
  it('tells a flat fill from a picture', () => {
    expect(isBlank(frame(20))).toBe(true);
    expect(isBlank(frame(20, 200))).toBe(false);
    expect(isBlank(frame(20, 24))).toBe(true);
    expect(isBlank({ width: 0, height: 0, bitmap: new Uint8Array() })).toBe(true);
  });
});

describe('sameFrame', () => {
  it('allows the faint differences a rasterizer makes, but not a changed picture', () => {
    const a = frame(100, 200);
    const faint = frame(100, 200);
    faint.bitmap.set([103, 99, 101], 40);
    expect(sameFrame(a, faint)).toBe(true);
    // One strongly changed pixel in 256 is over the 0.1% allowed, here at least one pixel.
    const moved = frame(100, 200);
    moved.bitmap.set([10, 10, 10], 40);
    moved.bitmap.set([10, 10, 10], 80);
    expect(sameFrame(a, moved)).toBe(false);
    expect(sameFrame(a, { width: 8, height: 8, bitmap: new Uint8Array(256) })).toBe(false);
  });
});

describe('checkScene', () => {
  it('passes a scene that draws, moves and repeats itself, and keeps the middle frame', async () => {
    const s = source((t) => frame(10, Math.round(t * 50) + 40));
    const result = await checkScene(s, options);
    expect(result).toMatchObject({ ok: true, problems: [], notes: [] });
    expect(result.thumbnail?.bitmap[0]).toBe(140);
    // A warm-up frame, four checked frames and the middle one again.
    expect(vi.mocked(s.frame).mock.calls.map(([t]) => t)).toEqual([0, 0, 1, 2, 4 - 1 / 30, 2]);
    expect(s.close).toHaveBeenCalled();
  });

  it('names blank frames', async () => {
    const result = await checkScene(
      source((t) => (t < 1 ? frame(0) : frame(0, 99))),
      options,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['The frame at 0 s is blank: nothing is drawn.']);
  });

  it('catches a frame that differs when drawn again', async () => {
    const result = await checkScene(
      source((_t, call) => frame(10, 50 + call * 40)),
      options,
    );
    expect(result.problems[0]).toMatch(/at 2 s came out different when drawn a second time/);
  });

  it('notes a scene where nothing moves, without failing it', async () => {
    const result = await checkScene(
      source(() => frame(10, 90)),
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      notes: ['Nothing moves: every checked frame is the same.'],
    });
  });

  it('fails a scene that never gets ready, with what the page reported', async () => {
    const s = source(() => frame(0), { waitReady: vi.fn(async () => false) });
    s.reported.push('Error: Studio is not defined');
    const result = await checkScene(s, options);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/did not finish loading within 10 seconds/);
    expect(result.problems).toContain('Error: Studio is not defined');
  });

  it('fails on errors and blocked requests the page reported, and on a source that breaks', async () => {
    const s = source((t) => frame(10, 40 + t));
    s.reported.push('Blocked connect-src: https://example.com/');
    expect((await checkScene(s, options)).problems).toEqual([
      'Blocked connect-src: https://example.com/',
    ]);

    const broken = source(() => {
      throw new Error('the window crashed');
    });
    const result = await checkScene(broken, options);
    expect(result.problems).toEqual(['The scene could not be checked: the window crashed']);
    expect(broken.close).toHaveBeenCalled();

    // Problems the source only learns while closing are still reported.
    const late = source((t) => frame(10, 40 + t));
    late.close = vi.fn(async () => {
      late.reported.push('Unhandled rejection: no data');
    });
    expect((await checkScene(late, options)).problems).toEqual(['Unhandled rejection: no data']);
  });
});
