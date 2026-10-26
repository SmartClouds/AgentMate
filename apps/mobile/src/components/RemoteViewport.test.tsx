import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RemoteInputEvent } from '@runova/protocol';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { MediaStream } from '../../__mocks__/react-native-webrtc';
import { RemoteTransportMode } from '../remote/transport';
import type { RemoteTile } from '../remote/useRemoteClient';
import { RemoteViewport } from './RemoteViewport';

/**
 * Viewport geometry used by every test here. A 1920x1080 host inside a
 * 390x844 phone viewport aspect-fits to a 390x219.375 box centered vertically,
 * so the middle of the box is (195, 422) in viewport coordinates.
 */
const LAYOUT = { width: 390, height: 844 };
const CENTER = { x: 195, y: 422 };
const HOST_SCREEN = { width: 1920, height: 1080 };

interface Point {
  x: number;
  y: number;
}

interface Json {
  type: string;
  props: Record<string, unknown>;
  children: (Json | string)[];
}

function tree(): Json {
  return screen.toJSON() as unknown as Json;
}

/** The wrap view that owns the pan responder. */
function root() {
  const node = screen.root;
  if (!node) throw new Error('the viewport rendered nothing');
  return node;
}

function nodesOfType(type: string, node: Json = tree(), out: Json[] = []): Json[] {
  if (node.type === type) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== 'string') nodesOfType(type, child, out);
  }
  return out;
}

/** The live transform on the zoom/pan container. */
function transform(): Record<string, number>[] {
  const content = tree().children[0];
  if (typeof content === 'string') throw new Error('the content view is missing');
  const style = content.props.style as { transform: Record<string, number>[] };
  return style.transform;
}

function scaleValue(): number {
  const entry = transform().find((t) => 'scale' in t);
  return entry?.scale ?? 1;
}

/**
 * A responder event complete enough for PanResponder, which reads both
 * `nativeEvent.touches` and the global touch history.
 */
function gesture(points: Point[], timestamp: number) {
  const touches = points.map((p, i) => ({
    identifier: i,
    pageX: p.x,
    pageY: p.y,
    locationX: p.x,
    locationY: p.y,
    target: 1,
    timestamp,
  }));
  const touchBank = points.map((p) => ({
    touchActive: true,
    startPageX: p.x,
    startPageY: p.y,
    startTimeStamp: timestamp,
    currentPageX: p.x,
    currentPageY: p.y,
    currentTimeStamp: timestamp,
    previousPageX: p.x,
    previousPageY: p.y,
    previousTimeStamp: timestamp,
  }));
  return {
    nativeEvent: {
      touches,
      changedTouches: touches,
      identifier: 0,
      target: 1,
      timestamp,
      pageX: points[0]?.x ?? 0,
      pageY: points[0]?.y ?? 0,
      locationX: points[0]?.x ?? 0,
      locationY: points[0]?.y ?? 0,
    },
    touchHistory: {
      touchBank,
      numberActiveTouches: touches.length,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: timestamp,
    },
  };
}

interface ViewportOptions {
  transport?: RemoteTransportMode;
  stream?: MediaStream | null;
  tiles?: Map<string, RemoteTile>;
  hostScreen?: { width: number; height: number } | null;
  live?: boolean;
  layout?: { width: number; height: number };
}

async function renderViewport(options: ViewportOptions = {}) {
  const onInput = jest.fn<(event: RemoteInputEvent) => void>();
  const {
    transport = RemoteTransportMode.JPEG_TILE_FALLBACK,
    stream = null,
    tiles = new Map<string, RemoteTile>(),
    hostScreen = HOST_SCREEN,
    live = true,
    layout = LAYOUT,
  } = options;

  await render(
    <RemoteViewport
      screen={hostScreen}
      // The mock MediaStream stands in for a native one; only toURL() is used.
      stream={stream as never}
      tiles={tiles}
      transport={transport}
      live={live}
      onInput={onInput}
    />,
  );
  await fireEvent(root(), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, ...layout } },
  });
  return onInput;
}

function handlers(): Record<string, (event: unknown) => unknown> {
  return (root() as unknown as { props: Record<string, (event: unknown) => unknown> }).props;
}

async function grant(points: Point[], timestamp = 100) {
  await fireEvent(root(), 'responderGrant', gesture(points, timestamp));
}

async function move(points: Point[], timestamp: number) {
  await fireEvent(root(), 'responderMove', gesture(points, timestamp));
}

async function release(points: Point[], timestamp: number) {
  await fireEvent(root(), 'responderRelease', gesture(points, timestamp));
}

function tile(overrides: Partial<RemoteTile> = {}): RemoteTile {
  return { x: 0, y: 0, w: 64, h: 48, uri: 'data:image/jpeg;base64,AA', ...overrides };
}

describe('RemoteViewport', () => {
  describe('which pipeline renders', () => {
    it('renders the video track when the transport is WebRTC', async () => {
      await renderViewport({
        transport: RemoteTransportMode.WEBRTC_VIDEO,
        stream: new MediaStream(),
        tiles: new Map([['0,0', tile()]]),
      });
      expect(screen.getByTestId('rtc-view')).toBeTruthy();
      // Video and tiles are mutually exclusive, so a stale mosaic can never sit
      // on top of live video.
      expect(nodesOfType('Image')).toHaveLength(0);
    });

    it('renders tiles when the transport fell back, even with a stream still around', async () => {
      // Regression guard for the reverse case: the fallback must win over a
      // stream reference that has not been cleared yet.
      await renderViewport({
        transport: RemoteTransportMode.JPEG_TILE_FALLBACK,
        stream: new MediaStream(),
        tiles: new Map([['0,0', tile()]]),
      });
      expect(screen.queryByTestId('rtc-view')).toBeNull();
      expect(nodesOfType('Image')).toHaveLength(1);
    });

    it('renders tiles while video is still being negotiated', async () => {
      await renderViewport({
        transport: RemoteTransportMode.WEBRTC_VIDEO,
        stream: null,
        tiles: new Map([['0,0', tile()]]),
      });
      expect(screen.queryByTestId('rtc-view')).toBeNull();
      expect(nodesOfType('Image')).toHaveLength(1);
    });

    it('draws nothing before the host reports its resolution', async () => {
      await renderViewport({ hostScreen: null, tiles: new Map([['0,0', tile()]]) });
      expect(nodesOfType('Image')).toHaveLength(0);
    });

    it('places each tile at its host position scaled into the fitted box', async () => {
      await renderViewport({
        tiles: new Map([
          ['0,0', tile()],
          ['64,48', tile({ x: 64, y: 48 })],
        ]),
      });
      const images = nodesOfType('Image');
      expect(images).toHaveLength(2);
      // 390 / 1920 = 0.203125 viewport pixels per host pixel.
      expect(images[1].props.style).toMatchObject({
        left: 13,
        top: 9.75,
        width: 13,
        height: 9.75,
      });
      // Android's default cross-fade reads as flicker on a tile mosaic.
      expect(images[0].props.fadeDuration).toBe(0);
    });
  });

  describe('aspect fitting', () => {
    it('fits to the viewport width for a landscape host', async () => {
      await renderViewport();
      const content = tree().children[0] as Json;
      expect(content.props.style).toMatchObject({ width: 390, height: 219.375 });
    });

    it('fits to the viewport height when the host is taller than the box', async () => {
      await renderViewport({
        hostScreen: { width: 1080, height: 1920 },
        layout: { width: 390, height: 300 },
      });
      const content = tree().children[0] as Json;
      expect(content.props.style).toMatchObject({ width: 168.75, height: 300 });
    });
  });

  describe('claiming touches', () => {
    it('takes the responder only while the session is live', async () => {
      await renderViewport({ live: true });
      expect(handlers().onStartShouldSetResponder({})).toBe(true);
      expect(handlers().onMoveShouldSetResponder({})).toBe(true);
    });

    it('leaves touches alone when the session is not live', async () => {
      // The old TileCanvas captured `live: false` from the first render forever,
      // which is the "touches do nothing" bug; the refs exist to prevent that.
      await renderViewport({ live: false });
      expect(handlers().onStartShouldSetResponder({})).toBe(false);
      expect(handlers().onMoveShouldSetResponder({})).toBe(false);
    });
  });

  describe('one finger', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    it('turns a tap into a left click at the normalized host position', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await release([CENTER], 200);

      expect(onInput.mock.calls).toEqual([
        [{ k: 'down', x: 0.5, y: 0.5, button: 'left' }],
        [{ k: 'up', x: 0.5, y: 0.5, button: 'left' }],
      ]);
    });

    it('clamps a touch outside the fitted box to the edge of the host screen', async () => {
      // The box is letterboxed, so a tap in the black bars would otherwise map
      // to a negative or past-the-end host coordinate.
      const onInput = await renderViewport();
      await grant([{ x: 0, y: 0 }]);
      await release([{ x: 0, y: 0 }], 200);

      expect(onInput.mock.calls).toEqual([
        [{ k: 'down', x: 0, y: 0, button: 'left' }],
        [{ k: 'up', x: 0, y: 0, button: 'left' }],
      ]);
    });

    it('turns a long press into a right click', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await jest.advanceTimersByTimeAsync(480);
      expect(onInput.mock.calls).toEqual([[{ k: 'down', x: 0.5, y: 0.5, button: 'right' }]]);

      await release([CENTER], 700);
      expect(onInput).toHaveBeenLastCalledWith({ k: 'up', x: 0.5, y: 0.5, button: 'right' });
    });

    it('does not fire a right click once the finger has moved', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await move([{ x: 292.5, y: 422 }], 200);
      await jest.advanceTimersByTimeAsync(600);

      expect(onInput.mock.calls).not.toContainEqual([
        { k: 'down', x: 0.5, y: 0.5, button: 'right' },
      ]);
    });

    it('turns a drag into a left press, moves and a release', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await move([{ x: 292.5, y: 422 }], 200);
      await move([{ x: 390, y: 422 }], 300);
      await release([{ x: 390, y: 422 }], 400);

      expect(onInput.mock.calls).toEqual([
        // The press is backdated to where the finger landed, not where it is now.
        [{ k: 'down', x: 0.5, y: 0.5, button: 'left' }],
        [{ k: 'move', x: 0.75, y: 0.5 }],
        [{ k: 'move', x: 1, y: 0.5 }],
        [{ k: 'up', x: 1, y: 0.5, button: 'left' }],
      ]);
    });

    it('ignores movement inside the slop radius', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await move([{ x: 199, y: 425 }], 200);
      expect(onInput).not.toHaveBeenCalled();
    });

    it('releases a held button when the gesture is terminated', async () => {
      // Losing the responder mid-drag without an up event leaves the host stuck
      // with the mouse button down.
      const onInput = await renderViewport();
      await grant([CENTER]);
      await move([{ x: 292.5, y: 422 }], 200);
      onInput.mockClear();

      await fireEvent(root(), 'responderTerminate', gesture([], 300));
      expect(onInput.mock.calls).toEqual([[{ k: 'up', x: 0.5, y: 0.5, button: 'left' }]]);
    });
  });

  describe('two fingers', () => {
    it('scrolls the host when the fingers move together vertically', async () => {
      const onInput = await renderViewport();
      await grant([
        { x: 95, y: 422 },
        { x: 295, y: 422 },
      ]);
      await move(
        [
          { x: 95, y: 398 },
          { x: 295, y: 398 },
        ],
        200,
      );

      expect(onInput).toHaveBeenCalledTimes(1);
      // 24 viewport pixels over the wheel divisor of 24 is exactly one notch,
      // anchored at the midpoint between the fingers.
      expect(onInput).toHaveBeenCalledWith({
        k: 'wheel',
        x: 0.5,
        y: expect.closeTo(0.3906, 3),
        dx: 0,
        dy: 1,
      });
    });

    it('zooms instead of scrolling when the fingers spread', async () => {
      const onInput = await renderViewport();
      await grant([
        { x: 145, y: 422 },
        { x: 245, y: 422 },
      ]);
      await move(
        [
          { x: 95, y: 422 },
          { x: 295, y: 422 },
        ],
        200,
      );

      expect(scaleValue()).toBe(2);
      // Zoom is local to the phone; the host must not see it as input.
      expect(onInput).not.toHaveBeenCalled();
    });

    it('never zooms past the maximum', async () => {
      await renderViewport();
      await grant([
        { x: 190, y: 422 },
        { x: 200, y: 422 },
      ]);
      await move(
        [
          { x: 0, y: 422 },
          { x: 390, y: 422 },
        ],
        200,
      );
      expect(scaleValue()).toBe(6);
    });

    it('snaps back when a pinch ends barely above 1x', async () => {
      // Leaving the view at 1.02x looks like a rendering glitch rather than zoom.
      await renderViewport();
      await grant([
        { x: 145, y: 422 },
        { x: 245, y: 422 },
      ]);
      await move(
        [
          { x: 95, y: 422 },
          { x: 295, y: 422 },
        ],
        200,
      );
      await move(
        [
          { x: 144, y: 422 },
          { x: 246, y: 422 },
        ],
        300,
      );
      expect(scaleValue()).toBeCloseTo(1.02);

      await release(
        [
          { x: 144, y: 422 },
          { x: 246, y: 422 },
        ],
        400,
      );
      expect(scaleValue()).toBe(1);
      expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });

    it('cancels an in-progress drag when a second finger lands', async () => {
      const onInput = await renderViewport();
      await grant([CENTER]);
      await move([{ x: 292.5, y: 422 }], 200);
      onInput.mockClear();

      await move(
        [
          { x: 95, y: 422 },
          { x: 295, y: 422 },
        ],
        300,
      );
      expect(onInput.mock.calls).toEqual([[{ k: 'up', x: 0.5, y: 0.5, button: 'left' }]]);
    });

    it('sends no click when a two-finger gesture is released', async () => {
      const onInput = await renderViewport();
      await grant([
        { x: 95, y: 422 },
        { x: 295, y: 422 },
      ]);
      await release(
        [
          { x: 95, y: 422 },
          { x: 295, y: 422 },
        ],
        200,
      );
      expect(onInput).not.toHaveBeenCalled();
    });
  });

  it('drops any zoom when the host resolution changes', async () => {
    // Tile and video coordinates are relative to the old screen, so keeping the
    // old pan offset would leave the view scrolled to nowhere.
    const onInput = jest.fn<(event: RemoteInputEvent) => void>();
    const { rerender } = await render(
      <RemoteViewport
        screen={HOST_SCREEN}
        stream={null}
        tiles={new Map()}
        transport={RemoteTransportMode.JPEG_TILE_FALLBACK}
        live
        onInput={onInput}
      />,
    );
    await fireEvent(root(), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, ...LAYOUT } },
    });
    await grant([
      { x: 145, y: 422 },
      { x: 245, y: 422 },
    ]);
    await move(
      [
        { x: 95, y: 422 },
        { x: 295, y: 422 },
      ],
      200,
    );
    expect(scaleValue()).toBe(2);

    await rerender(
      <RemoteViewport
        screen={{ width: 1280, height: 720 }}
        stream={null}
        tiles={new Map()}
        transport={RemoteTransportMode.JPEG_TILE_FALLBACK}
        live
        onInput={onInput}
      />,
    );
    expect(scaleValue()).toBe(1);
  });
});
