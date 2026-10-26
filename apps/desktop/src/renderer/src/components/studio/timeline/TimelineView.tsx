import {
  addClipsOps,
  addMediaClip,
  addTextClip,
  captionClips,
  DEFAULT_STILL,
  type EditOp,
  FLICKS_PER_SECOND,
  formatTimecode,
  framesToFlicks,
  type MediaView,
  newId,
  overlapsOnTrack,
  removeClip,
  type StudioDocument,
  sceneBlocks,
  splitCaptions,
  splitClip,
  type TimelineEdit,
  TRACKS_FOR,
  trackFor,
  videoLength,
} from '@agentmat/studio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../format';
import { Button, ErrorBoundary, Pause, Play, Plus, SimpleTooltip, toast } from '../kit';
import { Inspector } from './Inspector';
import { MediaPanel } from './MediaPanel';
import { ProgramPreview } from './ProgramPreview';
import { Timeline } from './Timeline';
import { useMedia } from './useMedia';

/**
 * The editor's timeline view: the media, the preview, the selected clip's settings and the
 * timeline, sharing one playhead. Keyboard shortcuts work anywhere in the view except in a field.
 */

export interface TimelineViewProps {
  videoId: string;
  document: StudioDocument;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
}

const NEW_CAPTION: Record<string, string> = { fa: 'زیرنویس تازه', en: 'New caption' };

function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const DEFAULT_TRACK: Record<MediaView['kind'], 'video' | 'image' | 'music'> = {
  video: 'video',
  image: 'image',
  audio: 'music',
};

export function TimelineView({
  videoId,
  document: doc,
  apply,
}: TimelineViewProps): React.JSX.Element {
  const media = useMedia(videoId);
  const files = media.data ?? [];
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const length = videoLength(doc);
  const fps = doc.renderSettings.fps;
  const headRef = useRef(0);
  headRef.current = playhead;

  const run = useCallback(
    async (edit: TimelineEdit | null | (() => TimelineEdit | null)) => {
      try {
        const value = typeof edit === 'function' ? edit() : edit;
        if (value) await apply(value.ops, value.label);
      } catch (error) {
        toast.error(errorMessage(error));
      }
    },
    [apply],
  );

  // Play from the playhead with the wall clock, stopping at the end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const from = headRef.current >= length ? 0 : headRef.current;
    const started = performance.now();
    const tick = () => {
      const next = from + ((performance.now() - started) / 1000) * FLICKS_PER_SECOND;
      if (next >= length) {
        setPlayhead(length);
        setPlaying(false);
        return;
      }
      setPlayhead(Math.round(next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, length]);

  const addFile = useCallback(
    (file: MediaView, trackId?: string, at?: number) => {
      const fits =
        trackId &&
        doc.timeline.tracks.find((t) => t.id === trackId && TRACKS_FOR[file.kind].includes(t.kind));
      const track = fits ? trackId : trackFor(doc, DEFAULT_TRACK[file.kind])?.id;
      if (!track) return;
      const id = newId();
      void run(() =>
        addMediaClip(doc, { id, trackId: track, media: file, at: at ?? headRef.current }),
      );
      setSelected(id);
    },
    [doc, run],
  );

  const addCaption = () => {
    const track = trackFor(doc, 'text');
    if (!track) return;
    const id = newId();
    const lang = doc.language;
    const text = NEW_CAPTION[lang.split('-')[0] ?? ''] ?? NEW_CAPTION.en ?? 'New caption';
    // A caption near the end runs to the end rather than past it, and at least a second.
    const at = headRef.current;
    const duration = Math.min(DEFAULT_STILL, Math.max(FLICKS_PER_SECOND, length - at));
    void run(() => addTextClip(doc, { id, trackId: track.id, text, lang, at, duration }));
    setSelected(id);
  };

  const captionScene = (sceneId: string) => {
    const index = doc.scenario.scenes.findIndex((s) => s.id === sceneId);
    const scene = doc.scenario.scenes[index];
    const block = sceneBlocks(doc).find((b) => b.sceneId === sceneId);
    const track = trackFor(doc, 'text');
    if (!scene || !block || !track) return;
    if (overlapsOnTrack(doc, track.id, block.start, block.duration)) {
      toast.error(`There are captions over scene ${index + 1} already; remove them first.`);
      return;
    }
    const lines = splitCaptions(scene.narration, doc.language);
    if (lines.length === 0) return;
    const clips = captionClips({
      lines,
      lang: doc.language,
      trackId: track.id,
      start: block.start,
      span: block.duration,
      fps,
      newId,
    });
    void apply(addClipsOps(clips), `Added captions to scene ${index + 1}`);
  };

  const sceneAtPlayhead = sceneBlocks(doc).find((b) => playhead >= b.start && playhead < b.end);

  const split = () => {
    if (!selected || selected.startsWith('scene:')) return;
    void run(() => splitClip(doc, selected, headRef.current, newId()));
  };
  const remove = (ripple: boolean) => {
    if (!selected || selected.startsWith('scene:')) return;
    const id = selected;
    setSelected(null);
    void run(() => removeClip(doc, id, ripple));
  };

  // Set up again each render, so the handlers always see the latest video and selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typingInField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const frame = framesToFlicks(1, fps);
      const step = event.shiftKey ? FLICKS_PER_SECOND : frame;
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying((p) => !p);
      } else if (event.key.toLowerCase() === 's') {
        split();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove(event.shiftKey);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPlaying(false);
        setPlayhead((t) => Math.max(0, t - step));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPlaying(false);
        setPlayhead((t) => Math.min(length, t + step));
      } else if (event.key === 'Home') {
        setPlayhead(0);
      } else if (event.key === 'End') {
        setPlayhead(length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 lg:grid-cols-[15rem_minmax(0,1fr)_17rem]">
        <ErrorBoundary title="Media">
          <MediaPanel
            videoId={videoId}
            media={media.data}
            loading={media.isLoading}
            onAdd={(file) => addFile(file)}
            aspect={doc.renderSettings.aspect}
          />
        </ErrorBoundary>
        <div className="min-w-0 space-y-1.5">
          <ErrorBoundary title="Preview">
            <ProgramPreview
              videoId={videoId}
              document={doc}
              media={files}
              playhead={playhead}
              playing={playing}
            />
          </ErrorBoundary>
          <div className="flex items-center gap-1.5">
            <SimpleTooltip label={playing ? 'Pause (Space)' : 'Play (Space)'}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={playing ? 'Pause' : 'Play'}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? <Pause /> : <Play />}
              </Button>
            </SimpleTooltip>
            <span className="text-xs tabular-nums text-muted-foreground" aria-label="Playhead">
              {formatTimecode(playhead, fps)} / {formatTimecode(length, fps)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="soft" onClick={addCaption}>
                <Plus /> Caption
              </Button>
              {sceneAtPlayhead && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!doc.scenario.scenes[sceneAtPlayhead.index]?.narration.trim()}
                  onClick={() => captionScene(sceneAtPlayhead.sceneId)}
                >
                  Caption scene {sceneAtPlayhead.index + 1}
                </Button>
              )}
            </div>
          </div>
        </div>
        <ErrorBoundary title="Inspector">
          <Inspector
            document={doc}
            media={files}
            selected={selected}
            apply={(edit) => run(edit)}
            onSplit={split}
            onDelete={remove}
            onCaptionScene={captionScene}
          />
        </ErrorBoundary>
      </div>
      <ErrorBoundary title="Timeline">
        <Timeline
          videoId={videoId}
          document={doc}
          media={files}
          playhead={playhead}
          onSeek={(t) => {
            setPlaying(false);
            setPlayhead(t);
          }}
          selected={selected}
          onSelect={setSelected}
          apply={apply}
          onDropMedia={(hash, trackId, at) => {
            const file = files.find((f) => f.hash === hash);
            if (file) addFile(file, trackId, at);
          }}
        />
      </ErrorBoundary>
    </div>
  );
}
