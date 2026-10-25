import {
  type Clip,
  DESIGN_SIZES,
  directionOf,
  FLICKS_PER_SECOND,
  type MediaView,
  mediaUrl,
  type StudioDocument,
  sceneBlocks,
  sceneConfig,
  sceneUrl,
  type Track,
} from '@agentmat/studio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../kit';
import { useSceneSeek } from '../scenes/useSceneSeek';

/**
 * The video at the playhead: the scene playing there, with the video, pictures and captions over
 * it and the sound under it. Scenes run in their sandboxed pages as in the scene previews; video
 * and sound play their small proxies, kept in step with the playhead. Transitions show as cuts
 * here; the render draws them exactly.
 */

export interface ProgramPreviewProps {
  videoId: string;
  document: StudioDocument;
  media: MediaView[];
  playhead: number;
  playing: boolean;
}

const seconds = (flicks: number) => flicks / FLICKS_PER_SECOND;

/** How faded in or out a clip is at `t`, 0 to 1. */
export function fadeAt(clip: Clip, t: number): number {
  const into = t - clip.start;
  const left = clip.start + clip.duration - t;
  let level = 1;
  if (clip.fadeIn > 0) level = Math.min(level, into / clip.fadeIn);
  if (clip.fadeOut > 0) level = Math.min(level, left / clip.fadeOut);
  return Math.max(0, Math.min(1, level));
}

/** Which tracks are heard: not muted, and soloed when any track is. */
export function audibleTracks(tracks: Track[]): Set<string> {
  const soloing = tracks.some((t) => t.solo && t.kind !== 'scene');
  return new Set(tracks.filter((t) => !t.muted && (!soloing || t.solo)).map((t) => t.id));
}

export function ProgramPreview(props: ProgramPreviewProps): React.JSX.Element {
  const { document: doc, playhead, media } = props;
  const size = DESIGN_SIZES[doc.renderSettings.aspect];
  const stage = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const blocks = useMemo(() => sceneBlocks(doc), [doc]);
  const mediaByHash = useMemo(() => new Map(media.map((m) => [m.hash, m])), [media]);
  const tracks = doc.timeline.tracks;
  const audible = audibleTracks(tracks);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / size.width || 0.25);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size.width]);

  const index = blocks.findIndex((b) => playhead >= b.start && playhead < b.end);
  const current =
    index >= 0 ? index : playhead >= (blocks.at(-1)?.end ?? 0) ? blocks.length - 1 : 0;
  const shown = [blocks[current], blocks[current + 1]].filter(
    (b): b is NonNullable<typeof b> => !!b,
  );

  const active = doc.timeline.clips
    .filter((c) => playhead >= c.start && playhead < c.start + c.duration)
    .filter((c) => !tracks.find((t) => t.id === c.trackId)?.muted)
    .sort(
      (a, b) =>
        tracks.findIndex((t) => t.id === a.trackId) - tracks.findIndex((t) => t.id === b.trackId),
    );

  return (
    <div
      ref={stage}
      role="img"
      aria-label="Video preview"
      className="relative w-full overflow-hidden rounded-lg bg-black"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      {shown.map((block) => {
        const scene = doc.scenario.scenes[block.index];
        if (!scene) return null;
        const visible = block.index === current;
        if (!scene.code.treeHash) {
          return visible ? (
            <div
              key={block.sceneId}
              className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-white/70"
              dir="auto"
            >
              Scene {block.index + 1} is not animated yet.
            </div>
          ) : null;
        }
        return (
          <SceneLayer
            key={block.sceneId}
            label={`Scene ${block.index + 1}`}
            url={sceneUrl(scene.code.treeHash, sceneConfig(doc, scene))}
            width={size.width}
            height={size.height}
            scale={scale}
            visible={visible}
            t={visible ? Math.max(0, seconds(playhead - block.start)) : 0}
          />
        );
      })}
      {active.map((clip) => {
        const track = tracks.find((t) => t.id === clip.trackId);
        const opacity = fadeAt(clip, playhead);
        if (clip.source.type === 'text') {
          const dir = clip.source.dir === 'auto' ? directionOf(clip.source.lang) : clip.source.dir;
          return (
            <div key={clip.id} className="pointer-events-none absolute inset-0" style={{ opacity }}>
              <p
                lang={clip.source.lang}
                dir={dir}
                className={cn(
                  'absolute left-1/2 max-w-[82%] -translate-x-1/2 rounded-[0.45em] bg-[rgba(12,14,18,0.62)] px-[0.8em] py-[0.35em] text-center font-semibold leading-normal text-white',
                  /^(fa|ar|ur)\b/.test(clip.source.lang) && 'font-vazirmatn',
                )}
                style={{ bottom: '8%', fontSize: `${size.height * 0.046 * scale}px` }}
              >
                {clip.source.text}
              </p>
            </div>
          );
        }
        if (clip.source.type !== 'media') return null;
        const file = mediaByHash.get(clip.source.hash);
        if (!file) return null;
        const volume = Math.min(1, clip.gain * (track?.volume ?? 1)) * opacity;
        const heard = !!track && audible.has(track.id);
        if (file.kind === 'image') {
          return (
            <img
              key={clip.id}
              alt=""
              src={mediaUrl(props.videoId, file.hash, 'proxy')}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
              style={{ opacity }}
            />
          );
        }
        const at = seconds(clip.source.in + (playhead - clip.start));
        if (file.kind === 'video') {
          return (
            <MediaLayer
              key={clip.id}
              kind="video"
              src={mediaUrl(props.videoId, file.hash, file.ready.proxy ? 'proxy' : 'original')}
              at={at}
              playing={props.playing}
              volume={heard ? volume : 0}
              opacity={opacity}
            />
          );
        }
        return (
          <MediaLayer
            key={clip.id}
            kind="audio"
            src={mediaUrl(props.videoId, file.hash, file.ready.proxy ? 'proxy' : 'original')}
            at={at}
            playing={props.playing}
            volume={heard ? volume : 0}
            opacity={1}
          />
        );
      })}
    </div>
  );
}

function SceneLayer(props: {
  label: string;
  url: string;
  width: number;
  height: number;
  scale: number;
  visible: boolean;
  t: number;
}): React.JSX.Element {
  const { frameRef, send, loaded } = useSceneSeek();
  const [ready, setReady] = useState(false);
  const { t, visible } = props;
  useEffect(() => {
    if (ready && visible) send(t);
  }, [ready, visible, t, send]);
  return (
    <iframe
      ref={frameRef}
      title={props.label}
      src={props.url}
      sandbox="allow-scripts"
      className={cn(
        'absolute left-0 top-0 origin-top-left border-0',
        !props.visible && 'invisible',
      )}
      style={{ width: props.width, height: props.height, transform: `scale(${props.scale})` }}
      onLoad={() => {
        loaded();
        setReady(true);
      }}
    />
  );
}

/** A video or sound proxy held to the playhead: re-seeked when it drifts, paused with it. */
function MediaLayer(props: {
  kind: 'video' | 'audio';
  src: string;
  at: number;
  playing: boolean;
  volume: number;
  opacity: number;
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const { at, playing, volume } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume));
    const drift = Math.abs(el.currentTime - at);
    if (!playing) {
      if (!el.paused) el.pause();
      if (drift > 0.04) el.currentTime = at;
      return;
    }
    if (drift > 0.3) el.currentTime = at;
    if (el.paused) void el.play().catch(() => undefined);
  }, [at, playing, volume]);
  if (props.kind === 'audio') return <audio ref={ref} src={props.src} preload="auto" />;
  return (
    <video
      ref={ref}
      src={props.src}
      preload="auto"
      playsInline
      className="pointer-events-none absolute inset-0 h-full w-full bg-black object-contain"
      style={{ opacity: props.opacity }}
    />
  );
}
