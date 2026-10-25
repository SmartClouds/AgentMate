import {
  type Clip,
  clipsInRange,
  type EditOp,
  type MediaView,
  mediaUrl,
  moveClip,
  moveScene,
  type StudioDocument,
  sceneBlocks,
  snap,
  snapPoints,
  type TimelineEdit,
  TRACKS_FOR,
  type Track,
  trimClip,
  trimScene,
  videoLength,
  visibleRange,
} from '@agentmat/studio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../format';
import { Button, cn, GLASS_CARD, SimpleTooltip, toast } from '../kit';
import {
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  tickLabel,
  tickStep,
  ticks,
  toFlicks,
  toPx,
} from './timeMath';
import { type Peaks, usePeaks } from './useMedia';

/**
 * The timeline: a ruler, the scene sequence and a row per track, scrolled sideways and zoomed.
 * Only what is in view is drawn, so a long video with hundreds of clips scrolls as smoothly as a
 * short one. Dragging a clip moves it (snapping to the playhead, scene edges and other clips),
 * dragging its edges trims it, and dragging a scene reorders the sequence; each gesture is one
 * edit, so one undo.
 */

const HEADER_W = 'w-36';
const RULER_H = 24;
const SCENE_H = 44;
const ROW_H = 40;
const SNAP_PX = 8;

export const TIMELINE_MEDIA = 'application/x-agentmate-studio-media';

export interface TimelineProps {
  videoId: string;
  document: StudioDocument;
  media: MediaView[];
  playhead: number;
  onSeek: (flicks: number) => void;
  /** A clip id, `scene:<id>`, or null. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  onDropMedia: (hash: string, trackId: string, at: number) => void;
}

type Drag =
  | {
      kind: 'clip-move' | 'clip-start' | 'clip-end';
      id: string;
      x: number;
      y: number;
      moved: boolean;
      delta: number;
      trackId: string;
    }
  | { kind: 'scene-move' | 'scene-end'; id: string; x: number; moved: boolean; delta: number };

export function Timeline(props: TimelineProps): React.JSX.Element {
  const { document: doc, media, playhead } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const blocks = useMemo(() => sceneBlocks(doc), [doc]);
  const length = videoLength(doc);
  const mediaByHash = useMemo(() => new Map(media.map((m) => [m.hash, m])), [media]);
  const tracks = doc.timeline.tracks.filter((t) => t.kind !== 'scene');
  const pxPerSecond = zoom ?? fitZoom(length, view.width);
  const flicksPerPx = toFlicks(1, pxPerSecond);
  const contentWidth = Math.max(
    view.width,
    toPx(Math.max(length, ...doc.timeline.clips.map((c) => c.start + c.duration)), pxPerSecond) +
      240,
  );
  const range = visibleRange(view.left, view.width, flicksPerPx);
  const kindOf = (hash: string) => mediaByHash.get(hash)?.kind;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ left: el.scrollLeft, width: el.clientWidth || 800 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the playhead in view while it plays past the right edge.
  useEffect(() => {
    const el = scroller.current;
    if (!el || drag) return;
    const x = toPx(playhead, pxPerSecond);
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - 80;
  }, [playhead, pxPerSecond, drag]);

  const run = async (edit: TimelineEdit | null | (() => TimelineEdit | null)) => {
    try {
      const value = typeof edit === 'function' ? edit() : edit;
      if (value) await props.apply(value.ops, value.label);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const seekAt = (clientX: number) => {
    const el = scroller.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    props.onSeek(Math.max(0, Math.min(length, toFlicks(x, pxPerSecond))));
  };

  /** The track row under a point, among the ones a clip of this kind may go on. */
  const trackAt = (clientY: number, clip: Clip): string => {
    const box = rows.current?.getBoundingClientRect();
    if (!box) return clip.trackId;
    const index = Math.floor((clientY - box.top) / ROW_H);
    const track = tracks[index];
    if (!track) return clip.trackId;
    const kind =
      clip.source.type === 'text'
        ? 'text'
        : clip.source.type === 'media'
          ? kindOf(clip.source.hash)
          : undefined;
    return kind && TRACKS_FOR[kind].includes(track.kind) ? track.id : clip.trackId;
  };

  const startDrag = (event: React.PointerEvent, next: Drag) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag(next);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const moved = drag.moved || Math.abs(dx) > 3;
    if (drag.kind === 'clip-move' || drag.kind === 'clip-start' || drag.kind === 'clip-end') {
      const clip = doc.timeline.clips.find((c) => c.id === drag.id);
      if (!clip) return;
      const points = snapPoints(doc, playhead, new Set([clip.id]));
      const threshold = toFlicks(SNAP_PX, pxPerSecond);
      const raw = toFlicks(dx, pxPerSecond);
      let delta = raw;
      if (drag.kind === 'clip-move') {
        const start = snap(clip.start + raw, points, threshold);
        const end = snap(clip.start + clip.duration + raw, points, threshold);
        delta =
          start !== clip.start + raw ? start - clip.start : end - (clip.start + clip.duration);
      } else {
        const edge = drag.kind === 'clip-start' ? clip.start : clip.start + clip.duration;
        delta = snap(edge + raw, points, threshold) - edge;
      }
      const trackId = drag.kind === 'clip-move' ? trackAt(event.clientY, clip) : drag.trackId;
      setDrag({ ...drag, moved, delta, trackId });
    } else {
      setDrag({ ...drag, moved, delta: toFlicks(dx, pxPerSecond) });
    }
  };

  const onPointerUp = () => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (!d.moved) {
      props.onSelect(d.kind.startsWith('scene') ? `scene:${d.id}` : d.id);
      return;
    }
    if (d.kind === 'clip-move') {
      const clip = doc.timeline.clips.find((c) => c.id === d.id);
      if (clip)
        void run(() =>
          moveClip(doc, d.id, { start: clip.start + d.delta, trackId: d.trackId }, kindOf),
        );
    } else if (d.kind === 'clip-start' || d.kind === 'clip-end') {
      const clip = doc.timeline.clips.find((c) => c.id === d.id);
      if (!clip) return;
      const file = clip.source.type === 'media' ? mediaByHash.get(clip.source.hash) : undefined;
      const edge = d.kind === 'clip-start' ? clip.start : clip.start + clip.duration;
      void run(() =>
        trimClip(
          doc,
          d.id,
          d.kind === 'clip-start' ? 'start' : 'end',
          edge + d.delta,
          file?.duration ?? null,
        ),
      );
    } else if (d.kind === 'scene-move') {
      const block = blocks.find((b) => b.sceneId === d.id);
      if (!block) return;
      const center = block.start + block.duration / 2 + d.delta;
      const target = blocks.filter(
        (b) => b.sceneId !== d.id && b.start + b.duration / 2 < center,
      ).length;
      void run(() => moveScene(doc, d.id, target));
    } else {
      const block = blocks.find((b) => b.sceneId === d.id);
      if (block) void run(() => trimScene(doc, d.id, block.duration + d.delta));
    }
  };

  const setTrack = (track: Track, patch: Partial<Pick<Track, 'muted' | 'solo'>>, label: string) =>
    void props.apply([{ op: 'track.update', trackId: track.id, patch }], label);

  const step = tickStep(pxPerSecond);
  const second = toFlicks(1, 1);
  const tickTimes = ticks(range.start / second, range.end / second, step);

  return (
    <section aria-label="Timeline" className={cn(GLASS_CARD, 'flex flex-col overflow-hidden')}>
      <div className="flex items-center gap-1 border-b border-foreground/5 px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground">Timeline</span>
        <div className="ml-auto flex items-center gap-1">
          <SimpleTooltip label="Zoom out (Ctrl and the mouse wheel work too)">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom out"
              disabled={pxPerSecond <= MIN_ZOOM}
              onClick={() => setZoom(Math.max(MIN_ZOOM, pxPerSecond / 1.5))}
            >
              −
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label="Zoom in">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Zoom in"
              disabled={pxPerSecond >= MAX_ZOOM}
              onClick={() => setZoom(Math.min(MAX_ZOOM, pxPerSecond * 1.5))}
            >
              +
            </Button>
          </SimpleTooltip>
          <Button variant="ghost" size="xs" onClick={() => setZoom(null)}>
            Fit
          </Button>
        </div>
      </div>
      <div className="flex min-h-0">
        <div className={cn(HEADER_W, 'shrink-0 border-r border-foreground/5 text-xs')}>
          <div style={{ height: RULER_H }} />
          <div style={{ height: SCENE_H }} className="flex items-center px-2 font-medium">
            Scenes
          </div>
          {tracks.map((track) => (
            <div
              key={track.id}
              style={{ height: ROW_H }}
              className="flex items-center gap-1 px-2"
              aria-label={`${track.name} track`}
            >
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  track.muted && 'text-muted-foreground line-through',
                )}
              >
                {track.name}
              </span>
              <SimpleTooltip label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}>
                <Button
                  variant={track.muted ? 'tint' : 'ghost'}
                  size="icon-xs"
                  aria-pressed={track.muted}
                  aria-label={`Mute ${track.name}`}
                  onClick={() =>
                    setTrack(
                      track,
                      { muted: !track.muted },
                      track.muted ? `Unmuted ${track.name}` : `Muted ${track.name}`,
                    )
                  }
                >
                  M
                </Button>
              </SimpleTooltip>
              <SimpleTooltip
                label={track.solo ? `Stop playing ${track.name} alone` : `Hear ${track.name} alone`}
              >
                <Button
                  variant={track.solo ? 'tint' : 'ghost'}
                  size="icon-xs"
                  aria-pressed={track.solo}
                  aria-label={`Solo ${track.name}`}
                  onClick={() =>
                    setTrack(
                      track,
                      { solo: !track.solo },
                      track.solo ? `Stopped soloing ${track.name}` : `Soloed ${track.name}`,
                    )
                  }
                >
                  S
                </Button>
              </SimpleTooltip>
            </div>
          ))}
        </div>
        <div
          ref={scroller}
          className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          onScroll={(event) =>
            setView({
              left: event.currentTarget.scrollLeft,
              width: event.currentTarget.clientWidth || view.width,
            })
          }
          onWheel={(event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            setZoom(
              Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSecond * (event.deltaY < 0 ? 1.25 : 0.8))),
            );
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="relative" style={{ width: contentWidth }}>
            {/* The ruler: a click or drag puts the playhead there. */}
            <div
              aria-label="Time ruler"
              className="relative cursor-pointer select-none border-b border-foreground/5"
              style={{ height: RULER_H }}
              onPointerDown={(event) => {
                (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
                seekAt(event.clientX);
              }}
              onPointerMove={(event) => {
                if (event.buttons === 1 && !drag) seekAt(event.clientX);
              }}
            >
              {tickTimes.map((t) => (
                <span
                  key={t}
                  className="absolute top-0 h-full border-l border-foreground/15 pl-1 text-[10px] tabular-nums text-muted-foreground"
                  style={{ left: t * pxPerSecond }}
                >
                  {tickLabel(t)}
                </span>
              ))}
            </div>
            <div className="relative" style={{ height: SCENE_H }}>
              {clipsInRange(
                blocks.map((b) => ({ ...b, id: b.sceneId })),
                range,
              ).map((block) => {
                const scene = doc.scenario.scenes[block.index];
                const dragging =
                  drag && 'id' in drag && drag.id === block.sceneId && drag.kind.startsWith('scene')
                    ? drag
                    : null;
                const width = toPx(
                  block.duration + (dragging?.kind === 'scene-end' ? dragging.delta : 0),
                  pxPerSecond,
                );
                const left = toPx(
                  block.start + (dragging?.kind === 'scene-move' ? dragging.delta : 0),
                  pxPerSecond,
                );
                const selected = props.selected === `scene:${block.sceneId}`;
                return (
                  <button
                    key={block.sceneId}
                    type="button"
                    aria-label={`Scene ${block.index + 1}: ${scene?.title || 'Untitled'}`}
                    aria-pressed={selected}
                    className={cn(
                      'absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 text-left text-[11px] transition-colors',
                      scene?.code.treeHash
                        ? 'border-primary/30 bg-primary/15'
                        : 'border-dashed border-foreground/25 bg-foreground/5',
                      selected && 'ring-2 ring-primary',
                      dragging && 'z-10 opacity-80 shadow-lg',
                    )}
                    style={{ left, width: Math.max(4, width) }}
                    onPointerDown={(event) =>
                      startDrag(event, {
                        kind: 'scene-move',
                        id: block.sceneId,
                        x: event.clientX,
                        moved: false,
                        delta: 0,
                      })
                    }
                  >
                    <span className="block truncate font-medium" dir="auto">
                      {block.index + 1}. {scene?.title || 'Untitled'}
                    </span>
                    {block.transitionOut > 0 && (
                      <span
                        className="absolute inset-y-0 right-0 bg-gradient-to-r from-transparent to-primary/30"
                        style={{ width: toPx(block.transitionOut, pxPerSecond) }}
                        aria-hidden
                      />
                    )}
                    <span
                      className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-primary/40"
                      aria-hidden
                      onPointerDown={(event) =>
                        startDrag(event, {
                          kind: 'scene-end',
                          id: block.sceneId,
                          x: event.clientX,
                          moved: false,
                          delta: 0,
                        })
                      }
                    />
                  </button>
                );
              })}
            </div>
            <div ref={rows}>
              {tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  clips={clipsInRange(
                    doc.timeline.clips.filter((c) => c.trackId === track.id),
                    range,
                  )}
                  videoId={props.videoId}
                  mediaByHash={mediaByHash}
                  pxPerSecond={pxPerSecond}
                  selected={props.selected}
                  drag={drag}
                  allClips={doc.timeline.clips}
                  onClipPointerDown={(event, clip, kind) =>
                    startDrag(event, {
                      kind,
                      id: clip.id,
                      x: event.clientX,
                      y: event.clientY,
                      moved: false,
                      delta: 0,
                      trackId: clip.trackId,
                    })
                  }
                  onEmptyPointerDown={(event) => {
                    props.onSelect(null);
                    seekAt(event.clientX);
                  }}
                  onDrop={(hash, clientX) => {
                    const el = scroller.current;
                    if (!el) return;
                    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
                    props.onDropMedia(hash, track.id, Math.max(0, toFlicks(x, pxPerSecond)));
                  }}
                />
              ))}
            </div>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-destructive"
              style={{ left: toPx(playhead, pxPerSecond) }}
              aria-hidden
            />
          </div>
        </div>
      </div>
    </section>
  );
}

interface TrackRowProps {
  track: Track;
  clips: Clip[];
  allClips: Clip[];
  videoId: string;
  mediaByHash: Map<string, MediaView>;
  pxPerSecond: number;
  selected: string | null;
  drag: Drag | null;
  onClipPointerDown: (
    event: React.PointerEvent,
    clip: Clip,
    kind: 'clip-move' | 'clip-start' | 'clip-end',
  ) => void;
  onEmptyPointerDown: (event: React.PointerEvent) => void;
  onDrop: (hash: string, clientX: number) => void;
}

function TrackRow(props: TrackRowProps): React.JSX.Element {
  const { track, pxPerSecond, drag } = props;
  const [over, setOver] = useState(false);
  // A clip dragged here from another track is drawn here while it is held.
  const visiting =
    drag && drag.kind === 'clip-move' && drag.trackId === track.id
      ? props.allClips.filter((c) => c.id === drag.id && c.trackId !== track.id)
      : [];
  return (
    <div
      className={cn(
        'relative border-b border-foreground/5',
        track.muted && 'opacity-50',
        over && 'bg-primary/10',
      )}
      style={{ height: ROW_H }}
      aria-label={`${track.name} clips`}
      onPointerDown={props.onEmptyPointerDown}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TIMELINE_MEDIA)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const hash = event.dataTransfer.getData(TIMELINE_MEDIA);
        if (!hash) return;
        event.preventDefault();
        props.onDrop(hash, event.clientX);
      }}
    >
      {[...props.clips, ...visiting].map((clip) => {
        const held = drag && drag.kind.startsWith('clip') && drag.id === clip.id ? drag : null;
        if (held?.kind === 'clip-move' && held.trackId !== track.id) return null;
        const start =
          clip.start + (held?.kind === 'clip-move' || held?.kind === 'clip-start' ? held.delta : 0);
        const duration =
          clip.duration +
          (held?.kind === 'clip-end' ? held.delta : held?.kind === 'clip-start' ? -held.delta : 0);
        return (
          <ClipBlock
            key={clip.id}
            clip={clip}
            videoId={props.videoId}
            file={
              clip.source.type === 'media' ? props.mediaByHash.get(clip.source.hash) : undefined
            }
            left={toPx(start, pxPerSecond)}
            width={Math.max(3, toPx(duration, pxPerSecond))}
            pxPerSecond={pxPerSecond}
            selected={props.selected === clip.id}
            held={!!held}
            onPointerDown={(event, kind) => props.onClipPointerDown(event, clip, kind)}
          />
        );
      })}
    </div>
  );
}

function clipLabel(clip: Clip, file: MediaView | undefined): string {
  if (clip.source.type === 'text') return clip.source.text;
  return file?.name ?? 'Missing file';
}

function ClipBlock(props: {
  clip: Clip;
  videoId: string;
  file: MediaView | undefined;
  left: number;
  width: number;
  pxPerSecond: number;
  selected: boolean;
  held: boolean;
  onPointerDown: (event: React.PointerEvent, kind: 'clip-move' | 'clip-start' | 'clip-end') => void;
}): React.JSX.Element {
  const { clip, file } = props;
  const label = clipLabel(clip, file);
  const seconds = (f: number) => `${(f / toFlicks(1, 1)).toFixed(1)} s`;
  const audio = file?.kind === 'audio';
  const picture =
    file?.kind === 'video' && file.ready.sprite
      ? mediaUrl(props.videoId, file.hash, 'sprite')
      : file?.kind === 'image' && file.ready.poster
        ? mediaUrl(props.videoId, file.hash, 'poster')
        : null;
  return (
    <button
      type="button"
      aria-label={`${label}, ${seconds(clip.start)} to ${seconds(clip.start + clip.duration)}`}
      aria-pressed={props.selected}
      className={cn(
        'absolute top-1 bottom-1 overflow-hidden rounded-md border text-left text-[11px]',
        clip.source.type === 'text'
          ? 'border-warning/40 bg-warning/15'
          : audio
            ? 'border-success/40 bg-success/15'
            : 'border-primary/40 bg-primary/15',
        !file && clip.source.type === 'media' && 'border-destructive/60 bg-destructive/10',
        props.selected && 'ring-2 ring-primary',
        props.held && 'z-10 shadow-lg',
      )}
      style={{
        left: props.left,
        width: props.width,
        backgroundImage: picture ? `url("${picture}")` : undefined,
        backgroundSize: file?.kind === 'image' ? 'auto 100%' : '100% 100%',
        backgroundRepeat: file?.kind === 'image' ? 'repeat-x' : 'no-repeat',
      }}
      onPointerDown={(event) => props.onPointerDown(event, 'clip-move')}
    >
      {audio && file && <Waveform videoId={props.videoId} file={file} clip={clip} />}
      <span className="relative block truncate px-1.5 py-0.5 font-medium drop-shadow" dir="auto">
        {label}
      </span>
      {props.width > 16 && (
        <>
          <span
            className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-primary/40"
            aria-hidden
            onPointerDown={(event) => props.onPointerDown(event, 'clip-start')}
          />
          <span
            className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-primary/40"
            aria-hidden
            onPointerDown={(event) => props.onPointerDown(event, 'clip-end')}
          />
        </>
      )}
    </button>
  );
}

/** The loudness of the part of the file the clip plays, as bars. */
function Waveform({
  videoId,
  file,
  clip,
}: {
  videoId: string;
  file: MediaView;
  clip: Clip;
}): React.JSX.Element | null {
  const peaks = usePeaks(videoId, file);
  if (!peaks.data || clip.source.type !== 'media') return null;
  return <WaveBars peaks={peaks.data} from={clip.source.in} to={clip.source.out} />;
}

export function WaveBars({
  peaks,
  from,
  to,
}: {
  peaks: Peaks;
  from: number;
  to: number;
}): React.JSX.Element {
  const second = toFlicks(1, 1);
  const first = Math.floor((from / second) * peaks.perSecond);
  const last = Math.ceil((to / second) * peaks.perSecond);
  const slice = peaks.peaks.slice(first, last);
  // At most 200 bars: neighbouring peaks are folded together, keeping the loudest.
  const fold = Math.max(1, Math.ceil(slice.length / 200));
  const bars: number[] = [];
  for (let i = 0; i < slice.length; i += fold) bars.push(Math.max(...slice.slice(i, i + fold)));
  return (
    <svg
      className="absolute inset-0 h-full w-full text-success/60"
      viewBox={`0 0 ${Math.max(1, bars.length)} 255`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {bars.map((v, i) => (
        <rect
          key={i}
          x={i}
          y={(255 - v) / 2}
          width={0.8}
          height={Math.max(1, v)}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
