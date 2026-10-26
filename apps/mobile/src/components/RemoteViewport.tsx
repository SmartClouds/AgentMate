import type { RemoteInputEvent, RemoteMouseButton } from '@runova/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  type GestureResponderEvent,
  Image,
  type LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  View,
} from 'react-native';
import type { MediaStream } from 'react-native-webrtc';
import { RemoteTransportMode } from '../remote/transport';
import type { RemoteTile } from '../remote/useRemoteClient';
import { WebRtc } from '../remote/webrtc';

// Absent in builds without the native module; the tile fallback renders instead.
const RTCView = WebRtc?.RTCView ?? null;

interface RemoteScreenSize {
  width: number;
  height: number;
}

interface RemoteViewportProps {
  screen: RemoteScreenSize | null;
  stream: MediaStream | null;
  tiles: Map<string, RemoteTile>;
  transport: RemoteTransportMode;
  live: boolean;
  onInput: (event: RemoteInputEvent) => void;
}

const LONG_PRESS_MS = 480;
const MOVE_SLOP = 6;
const WHEEL_DIVISOR = 24;
const MIN_SCALE = 1;
const MAX_SCALE = 6;
/** Distance ratio past which a two-finger gesture becomes a pinch, not a scroll. */
const PINCH_THRESHOLD = 0.06;

interface Point {
  x: number;
  y: number;
}

/**
 * Full-screen viewer for the host's display.
 *
 * Renders the WebRTC video track (or, in fallback mode, the JPEG tile mosaic)
 * inside an aspect-fit box, with pinch-to-zoom / two-finger pan applied as a
 * transform, and converts touches to normalized mouse events on the host:
 *   - one finger: tap = click, long-press = right click, drag = left-drag
 *   - two fingers moving apart/together: zoom (anchored at the pinch focus)
 *   - two fingers moving together while zoomed: pan around the zoomed screen
 *   - two fingers moving vertically while not zoomed: scroll wheel
 *
 * Every mutable value lives in a ref: PanResponder callbacks are created once
 * and must never read stale state (the old TileCanvas captured `live: false`
 * from the first render forever (the "touches do nothing" bug).
 */
export function RemoteViewport({
  screen,
  stream,
  tiles,
  transport,
  live,
  onInput,
}: RemoteViewportProps): React.JSX.Element {
  const [layout, setLayout] = useState({ width: 0, height: 0 });

  // --- Geometry, mirrored into refs for the gesture callbacks -----------------
  const aspect = screen && screen.height > 0 ? screen.width / screen.height : 16 / 9;
  let fitWidth = layout.width;
  let fitHeight = aspect > 0 ? layout.width / aspect : 0;
  if (fitHeight > layout.height && layout.height > 0) {
    fitHeight = layout.height;
    fitWidth = layout.height * aspect;
  }

  const geom = useRef({ layoutW: 0, layoutH: 0, fitW: 0, fitH: 0 });
  geom.current = { layoutW: layout.width, layoutH: layout.height, fitW: fitWidth, fitH: fitHeight };

  const liveRef = useRef(live);
  liveRef.current = live;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  // --- Zoom state: Animated values drive the transform without re-renders ----
  const zoom = useRef({ s: 1, tx: 0, ty: 0 });
  const animScale = useRef(new Animated.Value(1)).current;
  const animTx = useRef(new Animated.Value(0)).current;
  const animTy = useRef(new Animated.Value(0)).current;

  const applyZoom = useCallback(
    (s: number, tx: number, ty: number) => {
      const { fitW, fitH } = geom.current;
      const clampedS = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
      const maxTx = (fitW * (clampedS - 1)) / 2;
      const maxTy = (fitH * (clampedS - 1)) / 2;
      const clampedTx = Math.min(maxTx, Math.max(-maxTx, tx));
      const clampedTy = Math.min(maxTy, Math.max(-maxTy, ty));
      zoom.current = { s: clampedS, tx: clampedTx, ty: clampedTy };
      animScale.setValue(clampedS);
      animTx.setValue(clampedTx);
      animTy.setValue(clampedTy);
    },
    [animScale, animTx, animTy],
  );

  // A new host screen invalidates any zoom from the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the screen size is the signal to reset zoom, the effect doesn't read it
  useEffect(() => {
    applyZoom(1, 0, 0);
  }, [applyZoom, screen?.width, screen?.height]);

  /** Map a point in viewport coordinates to normalized host-screen [0..1]². */
  const toHost = useCallback((px: number, py: number): Point => {
    const { layoutW, layoutH, fitW, fitH } = geom.current;
    const { s, tx, ty } = zoom.current;
    const cx = layoutW / 2;
    const cy = layoutH / 2;
    const u = ((px - cx - tx) / s + fitW / 2) / (fitW || 1);
    const v = ((py - cy - ty) / s + fitH / 2) / (fitH || 1);
    return { x: Math.min(1, Math.max(0, u)), y: Math.min(1, Math.max(0, v)) };
  }, []);

  // --- Touch bookkeeping -------------------------------------------------------
  // The wrap view's window offset lets us use pageX/pageY (stable for
  // multi-touch) instead of locationX (unreliable once transforms apply).
  const wrapRef = useRef<View>(null);
  const wrapOffset = useRef<Point>({ x: 0, y: 0 });

  const onLayoutHandler = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLayout({ width, height });
    wrapRef.current?.measureInWindow((x, y) => {
      wrapOffset.current = { x, y };
    });
  }, []);

  const localPoint = useCallback((pageX: number, pageY: number): Point => {
    return { x: pageX - wrapOffset.current.x, y: pageY - wrapOffset.current.y };
  }, []);

  const downButton = useRef<RemoteMouseButton | null>(null);
  const rightClickActive = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTouch = useRef<Point | null>(null);
  const moved = useRef(false);
  const twoFinger = useRef<{
    startDist: number;
    startMid: Point;
    lastMid: Point;
    startZoom: { s: number; tx: number; ty: number };
    mode: 'undecided' | 'pinch' | 'wheel';
  } | null>(null);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const releaseMouse = useCallback(
    (at: Point | null) => {
      const pt = at ?? startTouch.current;
      if (!pt) return;
      const host = toHost(pt.x, pt.y);
      if (rightClickActive.current) {
        onInputRef.current({ k: 'up', x: host.x, y: host.y, button: 'right' });
        rightClickActive.current = false;
      } else if (downButton.current) {
        onInputRef.current({ k: 'up', x: host.x, y: host.y, button: downButton.current });
        downButton.current = null;
      }
    },
    [toHost],
  );

  const touchesInfo = useCallback(
    (evt: GestureResponderEvent) => {
      const touches = evt.nativeEvent.touches;
      const pts = touches.map((t) => localPoint(t.pageX, t.pageY));
      return { count: pts.length, pts };
    },
    [localPoint],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => liveRef.current,
      onMoveShouldSetPanResponder: () => liveRef.current,
      onPanResponderGrant: (evt) => {
        const { count, pts } = touchesInfo(evt);
        if (count >= 2) {
          beginTwoFinger(pts);
          return;
        }
        const pt = pts[0] ?? localPoint(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        startTouch.current = pt;
        moved.current = false;
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          if (startTouch.current && !moved.current && !twoFinger.current) {
            const host = toHost(startTouch.current.x, startTouch.current.y);
            rightClickActive.current = true;
            onInputRef.current({ k: 'down', x: host.x, y: host.y, button: 'right' });
          }
        }, LONG_PRESS_MS);
      },
      onPanResponderMove: (evt) => {
        const { count, pts } = touchesInfo(evt);

        if (count >= 2) {
          // A second finger cancels any in-progress mouse press.
          clearLongPress();
          if (downButton.current || rightClickActive.current) releaseMouse(startTouch.current);
          if (!twoFinger.current) beginTwoFinger(pts);
          else moveTwoFinger(pts);
          return;
        }
        if (twoFinger.current) return; // finger lifted mid-gesture; wait for release

        const pt = pts[0];
        if (!pt || !startTouch.current) return;
        const dx = Math.abs(pt.x - startTouch.current.x);
        const dy = Math.abs(pt.y - startTouch.current.y);
        if (dx > MOVE_SLOP || dy > MOVE_SLOP) moved.current = true;

        if (rightClickActive.current) return;
        if (moved.current) {
          clearLongPress();
          const host = toHost(pt.x, pt.y);
          if (!downButton.current) {
            const start = toHost(startTouch.current.x, startTouch.current.y);
            downButton.current = 'left';
            onInputRef.current({ k: 'down', x: start.x, y: start.y, button: 'left' });
            onInputRef.current({ k: 'move', x: host.x, y: host.y });
          } else {
            onInputRef.current({ k: 'move', x: host.x, y: host.y });
          }
        }
      },
      onPanResponderRelease: (evt) => {
        clearLongPress();
        if (twoFinger.current) {
          // Snap back if the pinch ended barely above 1x.
          if (twoFinger.current.mode === 'pinch' && zoom.current.s < 1.05) applyZoom(1, 0, 0);
          twoFinger.current = null;
          startTouch.current = null;
          return;
        }
        const pt = localPoint(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
        if (rightClickActive.current || downButton.current) {
          releaseMouse(pt);
        } else if (startTouch.current) {
          // A tap that never moved: fire a synthetic click.
          const host = toHost(startTouch.current.x, startTouch.current.y);
          onInputRef.current({ k: 'down', x: host.x, y: host.y, button: 'left' });
          onInputRef.current({ k: 'up', x: host.x, y: host.y, button: 'left' });
        }
        startTouch.current = null;
      },
      onPanResponderTerminate: () => {
        clearLongPress();
        releaseMouse(null);
        downButton.current = null;
        rightClickActive.current = false;
        twoFinger.current = null;
        startTouch.current = null;
      },
    }),
  ).current;

  function beginTwoFinger(pts: Point[]): void {
    if (pts.length < 2) return;
    clearLongPress();
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    twoFinger.current = {
      startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      startMid: mid,
      lastMid: mid,
      startZoom: { ...zoom.current },
      mode: 'undecided',
    };
  }

  function moveTwoFinger(pts: Point[]): void {
    const g = twoFinger.current;
    if (!g || pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const ratio = dist / g.startDist;

    if (g.mode === 'undecided') {
      if (Math.abs(ratio - 1) > PINCH_THRESHOLD || zoom.current.s > 1.01) {
        g.mode = 'pinch';
      } else if (Math.abs(mid.y - g.startMid.y) > 8) {
        g.mode = 'wheel';
      }
    }

    if (g.mode === 'pinch') {
      const { layoutW, layoutH } = geom.current;
      const cx = layoutW / 2;
      const cy = layoutH / 2;
      const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.startZoom.s * ratio));
      // Keep the screen point that was under the fingers at gesture start
      // pinned under them as they move and spread.
      const k = s / g.startZoom.s;
      const tx = mid.x - cx - (g.startMid.x - cx - g.startZoom.tx) * k;
      const ty = mid.y - cy - (g.startMid.y - cy - g.startZoom.ty) * k;
      applyZoom(s, tx, ty);
    } else if (g.mode === 'wheel') {
      const dy = (g.lastMid.y - mid.y) / WHEEL_DIVISOR;
      if (Math.abs(dy) > 0.001) {
        const host = toHost(mid.x, mid.y);
        onInputRef.current({ k: 'wheel', x: host.x, y: host.y, dx: 0, dy });
      }
    }
    g.lastMid = mid;
  }

  const scale = screen && fitWidth > 0 ? fitWidth / screen.width : 0;
  // Video is the primary renderer; tiles draw only when it isn't up. The two
  // are mutually exclusive so a stale mosaic can never sit on top of live video.
  const showVideo =
    RTCView !== null && stream !== null && transport === RemoteTransportMode.WEBRTC_VIDEO;
  const showTiles = !showVideo;

  return (
    <View
      ref={wrapRef}
      style={styles.wrap}
      onLayout={onLayoutHandler}
      {...panResponder.panHandlers}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.content,
          {
            width: fitWidth || undefined,
            height: fitHeight || undefined,
            transform: [{ translateX: animTx }, { translateY: animTy }, { scale: animScale }],
          },
        ]}
      >
        {showVideo && RTCView && stream ? (
          <RTCView streamURL={stream.toURL()} style={styles.video} objectFit="contain" />
        ) : null}
        {showTiles && screen
          ? Array.from(tiles.values()).map((tile) => (
              <Image
                key={`${tile.x},${tile.y}`}
                source={{ uri: tile.uri }}
                // Android <Image> cross-fades new sources over 300ms by
                // default, which on a tile mosaic reads as constant flicker.
                fadeDuration={0}
                style={{
                  position: 'absolute',
                  left: tile.x * scale,
                  top: tile.y * scale,
                  width: tile.w * scale,
                  height: tile.h * scale,
                }}
              />
            ))
          : null}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  content: {
    backgroundColor: '#000000',
  },
  video: {
    width: '100%',
    height: '100%',
  },
});
