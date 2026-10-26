import type { RemoteScreenSize } from '@shared/apiTypes';
import type { RemoteMouseButton } from '@shared/remoteProtocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { drawTile } from '@/lib/frameCompositor';
import {
  type ControllerRtcState,
  isInputChannelOpen,
  sendControllerInput,
  subscribeControllerRtc,
} from '@/lib/rtcController';
import { cn } from '@/lib/utils';

const BUTTON_MAP: Record<number, RemoteMouseButton> = { 0: 'left', 1: 'middle', 2: 'right' };
/**
 * Pointer moves are cheap on the dedicated input channel, so it gets a higher
 * sampling rate. The WebSocket fallback keeps the old, gentler rate: that
 * socket also carries JPEG tiles, and doubling the move rate on it would add to
 * the very congestion the input channel exists to escape.
 */
const MOVE_THROTTLE_CHANNEL_MS = 8;
const MOVE_THROTTLE_SOCKET_MS = 16;

interface RemoteScreenProps {
  screen: RemoteScreenSize | null;
  /** True once fully connected, input is only forwarded then. */
  live: boolean;
}

/**
 * The controller's live view of the remote desktop.
 *
 * The primary path renders a WebRTC video track in an `HTMLVideoElement`: the
 * GPU decodes and composites it, so no frame data passes through JavaScript.
 * The JPEG tile canvas remains only as the fallback for hosts that can't
 * negotiate WebRTC, and is not even mounted while video is running.
 *
 * Pointer/keyboard events go out over the input DataChannel when it's up (see
 * rtcController) so they can't queue behind video or file bytes.
 */
export function RemoteScreen({ screen, live }: RemoteScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<HTMLElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const lastMove = useRef(0);
  const [focused, setFocused] = useState(false);
  const [rtc, setRtc] = useState<ControllerRtcState>({
    mode: 'idle',
    stream: null,
    cursor: null,
    quality: null,
  });

  useEffect(() => subscribeControllerRtc(setRtc), []);

  const usingVideo = rtc.mode === 'webrtc' && rtc.stream !== null;

  // Attach the live track to the video element (never via a src attribute).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !rtc.stream) return;
    video.srcObject = rtc.stream;
    void video.play().catch(() => {
      // Autoplay of a muted stream is permitted; a rejection here is benign.
    });
    return () => {
      video.srcObject = null;
    };
  }, [rtc.stream]);

  // (Re)size the tile canvas whenever the host's screen dimensions change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !screen || usingVideo) return;
    canvas.width = screen.width;
    canvas.height = screen.height;
    ctxRef.current = canvas.getContext('2d');
  }, [screen, usingVideo]);

  // Paint incoming tiles (fallback path only).
  useEffect(() => {
    if (usingVideo) return;
    const unsub = window.runova.remote.onFrameTile((tile) => {
      const ctx = ctxRef.current;
      if (ctx) void drawTile(ctx, tile);
    });
    return unsub;
  }, [usingVideo]);

  /**
   * Reports this wrapper's physical-pixel size to the host (see the
   * `display-size` protocol message and `QualityGovernor.displayScale`) so
   * the host can send only as much resolution as this box can actually show,
   * and raise it back up when the box grows (window resized/maximized)
   * instead of staying capped at whatever a smaller size last requested.
   * Debounced: a live drag-resize fires many times a second, and only the
   * settled size is worth renegotiating encoder parameters for.
   */
  useEffect(() => {
    if (!live) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let debounceTimer: number | null = null;
    const report = (): void => {
      const rect = wrapper.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      window.runova.remote.setDisplaySize({
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
      });
    };
    const observer = new ResizeObserver(() => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(report, 400);
    });
    observer.observe(wrapper);
    report(); // unthrottled initial report
    return () => {
      observer.disconnect();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    };
  }, [live]);

  const normalized = useCallback((e: { clientX: number; clientY: number }) => {
    const media = mediaRef.current;
    if (!media) return { x: 0, y: 0 };
    const rect = media.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!live) return;
      const now = performance.now();
      const throttle = isInputChannelOpen() ? MOVE_THROTTLE_CHANNEL_MS : MOVE_THROTTLE_SOCKET_MS;
      if (now - lastMove.current < throttle) return;
      lastMove.current = now;
      const { x, y } = normalized(e);
      sendControllerInput({ k: 'move', x, y });
    },
    [live, normalized],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!live) return;
      (e.currentTarget as HTMLElement).focus();
      const button = BUTTON_MAP[e.button];
      if (!button) return;
      const { x, y } = normalized(e);
      sendControllerInput({ k: 'down', x, y, button });
    },
    [live, normalized],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!live) return;
      const button = BUTTON_MAP[e.button];
      if (!button) return;
      const { x, y } = normalized(e);
      sendControllerInput({ k: 'up', x, y, button });
    },
    [live, normalized],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!live) return;
      const { x, y } = normalized(e);
      // Normalize to "notches": pixel deltas (deltaMode 0) are divided down.
      const factor = e.deltaMode === 0 ? 100 : 1;
      sendControllerInput({ k: 'wheel', x, y, dx: e.deltaX / factor, dy: e.deltaY / factor });
    },
    [live, normalized],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!live) return;
      e.preventDefault();
      const plainChar = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plainChar) sendControllerInput({ k: 'text', text: e.key });
      else sendControllerInput({ k: 'key', code: e.code, down: true });
    },
    [live],
  );

  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (!live) return;
      const plainChar = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (plainChar) return; // already handled as a one-shot text event
      e.preventDefault();
      sendControllerInput({ k: 'key', code: e.code, down: false });
    },
    [live],
  );

  const aspect = screen ? screen.width / screen.height : 16 / 9;

  // The overlay cursor is only correct when the host excluded the OS cursor
  // from its capture. If frames already contain it, drawing here would show two.
  const overlayCursor = rtc.cursor && !rtc.cursor.baked && rtc.cursor.visible ? rtc.cursor : null;

  const interaction = {
    tabIndex: 0,
    onPointerMove,
    onPointerDown,
    onPointerUp,
    onWheel,
    onKeyDown,
    onKeyUp,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    className: cn(
      'h-full w-full object-contain outline-none',
      live ? 'cursor-none' : 'cursor-default',
      focused ? 'ring-2 ring-primary' : 'ring-1 ring-border',
    ),
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/60 p-2">
      {/*
       * This wrapper (not the video/canvas itself) carries the aspect-ratio
       * lock. `height: 100%` gives it an active size to grow into (rather than
       * only ever being capped from above), and the browser's aspect-ratio
       * sizing algorithm shrinks-and-recomputes both axes together when
       * `max-width` binds instead. Without an active height, the element only
       * ever sized down to its *current* intrinsic resolution, so as the
       * WebRTC quality governor stepped resolution down on a poor link, the
       * displayed box visibly shrank instead of staying pinned to the
       * available space. Keeping the lock here (not on the media element)
       * also keeps `getBoundingClientRect()` on the media element exactly
       * equal to the visible content bounds, which pointer normalization and
       * the cursor overlay below both depend on.
       */}
      <div
        ref={wrapperRef}
        className="relative max-h-full max-w-full"
        style={{ aspectRatio: String(aspect), height: '100%' }}
      >
        {usingVideo ? (
          <video
            {...interaction}
            ref={(node) => {
              videoRef.current = node;
              mediaRef.current = node;
            }}
            autoPlay
            muted
            playsInline
          />
        ) : (
          <canvas
            {...interaction}
            ref={(node) => {
              canvasRef.current = node;
              mediaRef.current = node;
            }}
          />
        )}
        {overlayCursor && (
          <svg
            aria-hidden
            viewBox="0 0 12 18"
            className="pointer-events-none absolute h-[18px] w-[12px] drop-shadow"
            style={{
              left: `${overlayCursor.x * 100}%`,
              top: `${overlayCursor.y * 100}%`,
            }}
          >
            <path
              d="M0 0 L0 15 L3.6 11.4 L6 17 L8.4 16 L6 10.5 L11 10.5 Z"
              fill="white"
              stroke="black"
              strokeWidth="1"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
