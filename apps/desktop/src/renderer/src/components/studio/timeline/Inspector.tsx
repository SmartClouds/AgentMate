import {
  type Clip,
  FLICKS_PER_SECOND,
  type MediaView,
  type StudioDocument,
  secondsToFlicks,
  type TimelineEdit,
  updateClip,
} from '@agentmat/studio';
import { useEffect, useState } from 'react';
import { errorMessage, scriptClass } from '../format';
import { Button, cn, GLASS_CARD, Input, Label, Textarea, Trash2, toast } from '../kit';

/**
 * The selected clip's settings: volume, fades and a caption's words, with split and delete. A
 * slider or field is saved when it is let go, so dragging a volume slider is one undo step.
 */

export interface InspectorProps {
  document: StudioDocument;
  media: MediaView[];
  selected: string | null;
  apply: (edit: TimelineEdit | null) => Promise<void>;
  onSplit: () => void;
  onDelete: (ripple: boolean) => void;
  onCaptionScene: (sceneId: string) => void;
}

const secs = (flicks: number) => Math.round((flicks / FLICKS_PER_SECOND) * 100) / 100;

export function Inspector(props: InspectorProps): React.JSX.Element {
  const { document: doc, selected } = props;
  const clip = doc.timeline.clips.find((c) => c.id === selected);
  const sceneIndex = selected?.startsWith('scene:')
    ? doc.scenario.scenes.findIndex((s) => `scene:${s.id}` === selected)
    : -1;
  const scene = doc.scenario.scenes[sceneIndex];

  return (
    <section aria-label="Inspector" className={cn(GLASS_CARD, 'space-y-3 p-3 text-sm')}>
      {clip ? (
        <ClipSettings key={clip.id} {...props} clip={clip} />
      ) : scene ? (
        <div className="space-y-2">
          <h3 className="font-medium" dir="auto">
            Scene {sceneIndex + 1}: {scene.title || 'Untitled'}
          </h3>
          <p className="text-xs text-muted-foreground">
            {secs(scene.targetDuration)} s. Drag the scene to reorder it, or its right edge to
            change its length.
          </p>
          <Button
            size="sm"
            variant="soft"
            disabled={!scene.narration.trim()}
            onClick={() => props.onCaptionScene(scene.id)}
          >
            Captions from its narration
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Select a clip or a scene on the timeline to change it. Space plays, S splits the selected
          clip at the playhead, Delete removes it.
        </p>
      )}
    </section>
  );
}

function ClipSettings(props: InspectorProps & { clip: Clip }): React.JSX.Element {
  const { clip, document: doc } = props;
  const track = doc.timeline.tracks.find((t) => t.id === clip.trackId);
  const file =
    clip.source.type === 'media'
      ? props.media.find((m) => m.hash === (clip.source as { hash: string }).hash)
      : undefined;
  const hasSound =
    clip.source.type === 'media' &&
    (file?.kind === 'audio' || (file?.kind === 'video' && file.hasAudio));
  const [gain, setGain] = useState(Math.round(clip.gain * 100));
  const [fadeIn, setFadeIn] = useState(String(secs(clip.fadeIn)));
  const [fadeOut, setFadeOut] = useState(String(secs(clip.fadeOut)));
  const [text, setText] = useState(clip.source.type === 'text' ? clip.source.text : '');
  useEffect(() => setGain(Math.round(clip.gain * 100)), [clip.gain]);
  useEffect(() => setFadeIn(String(secs(clip.fadeIn))), [clip.fadeIn]);
  useEffect(() => setFadeOut(String(secs(clip.fadeOut))), [clip.fadeOut]);

  const save = (patch: Parameters<typeof updateClip>[2], label: string) => {
    try {
      void props.apply(updateClip(doc, clip.id, patch, label));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const seconds = (value: string) => {
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? secondsToFlicks(n) : null;
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="truncate font-medium" dir="auto">
          {clip.source.type === 'text' ? 'Caption' : (file?.name ?? 'Missing file')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {track?.name}, {secs(clip.start)} s to {secs(clip.start + clip.duration)} s
        </p>
      </div>
      {clip.source.type === 'text' && (
        <div className="space-y-1">
          <Label htmlFor={`text-${clip.id}`}>Words</Label>
          <Textarea
            id={`text-${clip.id}`}
            dir="auto"
            rows={3}
            value={text}
            className={scriptClass(text)}
            onChange={(event) => setText(event.target.value)}
            onBlur={() => {
              const next = text.trim();
              if (next && clip.source.type === 'text' && next !== clip.source.text)
                save({ text: next }, 'Edited a caption');
            }}
          />
        </div>
      )}
      {hasSound && (
        <div className="space-y-1">
          <Label htmlFor={`gain-${clip.id}`}>Volume: {gain}%</Label>
          <input
            id={`gain-${clip.id}`}
            type="range"
            min={0}
            max={200}
            step={5}
            value={gain}
            className="w-full accent-primary"
            onChange={(event) => setGain(Number(event.target.value))}
            onPointerUp={() =>
              gain / 100 !== clip.gain && save({ gain: gain / 100 }, 'Changed the volume')
            }
            onKeyUp={() =>
              gain / 100 !== clip.gain && save({ gain: gain / 100 }, 'Changed the volume')
            }
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`fade-in-${clip.id}`}>Fade in (s)</Label>
          <Input
            id={`fade-in-${clip.id}`}
            inputMode="decimal"
            value={fadeIn}
            onChange={(event) => setFadeIn(event.target.value)}
            onBlur={() => {
              const value = seconds(fadeIn);
              if (value !== null && value !== clip.fadeIn)
                save({ fadeIn: value }, 'Changed a fade');
              else setFadeIn(String(secs(clip.fadeIn)));
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`fade-out-${clip.id}`}>Fade out (s)</Label>
          <Input
            id={`fade-out-${clip.id}`}
            inputMode="decimal"
            value={fadeOut}
            onChange={(event) => setFadeOut(event.target.value)}
            onBlur={() => {
              const value = seconds(fadeOut);
              if (value !== null && value !== clip.fadeOut)
                save({ fadeOut: value }, 'Changed a fade');
              else setFadeOut(String(secs(clip.fadeOut)));
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="soft" onClick={props.onSplit}>
          Split at playhead
        </Button>
        <Button size="sm" variant="danger" onClick={() => props.onDelete(false)}>
          <Trash2 /> Delete
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDelete(true)}>
          Delete and close the gap
        </Button>
      </div>
    </div>
  );
}
