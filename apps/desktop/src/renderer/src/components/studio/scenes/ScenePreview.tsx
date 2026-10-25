import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, cn, Pause, Play, SimpleTooltip } from '../kit';
import { useSceneSeek } from './useSceneSeek';

/**
 * A scene playing in the editor. The page runs in a sandboxed iframe at an opaque origin, so its
 * code cannot reach the app; the editor drives it only through `useSceneSeek`.
 */

export interface ScenePreviewProps {
  url: string;
  /** The scene's design size, which the page lays out at; it is scaled to fit. */
  width: number;
  height: number;
  duration: number;
  /** Starts playing on its own, looping (for the styles gallery). */
  autoPlay?: boolean;
  label: string;
  className?: string;
}

function formatTime(t: number): string {
  return `${t.toFixed(1)} s`;
}

export function ScenePreview({
  url,
  width,
  height,
  duration,
  autoPlay = false,
  label,
  className,
}: ScenePreviewProps): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  const [time, setShownTime] = useState(0);
  /** The latest time, for the play loop to start from without restarting on every tick. */
  const timeRef = useRef(0);
  const setTime = useCallback((t: number) => {
    timeRef.current = t;
    setShownTime(t);
  }, []);
  const [playing, setPlaying] = useState(autoPlay);
  const [loaded, setLoaded] = useState(false);
  const { frameRef, send, loaded: frameLoaded, slow, errors } = useSceneSeek();

  // Fit the design-size page into the box.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => setScale(Math.min(box.clientWidth / width, box.clientHeight / height) || 0.2);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [width, height]);

  // Play: advance time with the wall clock and ask for each new moment, looping at the end.
  useEffect(() => {
    if (!playing || !loaded) return;
    let raf = 0;
    const start = performance.now() - timeRef.current * 1000;
    const tick = () => {
      const t = ((performance.now() - start) / 1000) % Math.max(0.1, duration);
      setTime(t);
      send(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loaded, duration, send, setTime]);

  return (
    <figure className={cn('space-y-1.5', className)} aria-label={label}>
      <div
        ref={boxRef}
        className="relative w-full overflow-hidden rounded-lg bg-black/80"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <iframe
          ref={frameRef}
          title={label}
          src={url}
          sandbox="allow-scripts"
          className="absolute left-0 top-0 origin-top-left border-0"
          style={{ width, height, transform: `scale(${scale})` }}
          onLoad={() => {
            setLoaded(true);
            frameLoaded();
            send(time);
          }}
        />
      </div>
      <figcaption className="flex items-center gap-2">
        <SimpleTooltip label={playing ? 'Pause' : 'Play'}>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
        </SimpleTooltip>
        <input
          type="range"
          aria-label="Time"
          min={0}
          max={duration}
          step={0.01}
          value={time}
          className="h-1 min-w-0 flex-1 accent-primary"
          onChange={(event) => {
            const t = Number(event.target.value);
            setPlaying(false);
            setTime(t);
            send(t);
          }}
        />
        <span className="w-14 text-right text-[11px] tabular-nums text-muted-foreground">
          {formatTime(time)}
        </span>
        {slow && (
          <SimpleTooltip label="This scene takes longer than a frame to draw, so the preview skips frames. The render draws every one.">
            <Chip tone="warning">Slow scene</Chip>
          </SimpleTooltip>
        )}
        {errors.length > 0 && (
          <SimpleTooltip label={errors.join('\n')}>
            <Chip tone="destructive">
              {errors.length} {errors.length === 1 ? 'problem' : 'problems'}
            </Chip>
          </SimpleTooltip>
        )}
      </figcaption>
    </figure>
  );
}
