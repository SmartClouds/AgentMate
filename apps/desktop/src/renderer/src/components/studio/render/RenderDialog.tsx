import {
  ASPECTS,
  CODECS,
  type EditOp,
  FRAME_RATES,
  nonCommercialNarration,
  QUALITIES,
  RESOLUTIONS,
  type RenderEstimateView,
  type RenderSettings,
  type StudioDocument,
} from '@agentmat/studio';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioClient, studioRenderClient } from '../client';
import { errorMessage, formatBytes, formatSeconds } from '../format';
import { ASPECT_LABELS } from '../home/NewVideoDialog';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Notice,
  SEGMENT_TRACK,
  SimpleTooltip,
  Skeleton,
  Switch,
  segmentClass,
  toast,
  Video,
  Wrench,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { RenderJobRow } from './RenderJobRow';
import {
  CODEC_HINTS,
  CODEC_LABELS,
  QUALITY_HINTS,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
} from './renderLabels';

export interface RenderDialogProps {
  videoId: string;
  document: StudioDocument;
  /** The video's edit number; the estimate is asked for again after every edit. */
  seq: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apply: (ops: EditOp[], label: string) => Promise<boolean>;
  onOpenDevSetup: () => void;
}

interface Choice<T extends string | number> {
  value: T;
  label: string;
  hint?: string;
  /** Why it cannot be picked here, if it cannot. */
  disabled?: string | null;
}

function Segments<T extends string | number>(props: {
  label: string;
  value: T;
  choices: Choice<T>[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{props.label}</legend>
      <div className={SEGMENT_TRACK} role="radiogroup" aria-label={props.label}>
        {props.choices.map((choice) => {
          const button = (
            <button
              key={String(choice.value)}
              type="button"
              role="radio"
              aria-checked={props.value === choice.value}
              aria-disabled={choice.disabled ? true : undefined}
              className={segmentClass(props.value === choice.value)}
              onClick={() => !choice.disabled && props.onChange(choice.value)}
            >
              {choice.label}
            </button>
          );
          const tip = choice.disabled ?? choice.hint;
          return tip ? (
            <SimpleTooltip key={String(choice.value)} label={tip}>
              {button}
            </SimpleTooltip>
          ) : (
            button
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Renders the video to a file: the format, size, frame rate, quality and codec (each saved to the
 * video as an edit, so it can be undone and is there next time), the file name, and what the
 * render will cost in space and time. Below, the video's renders, with their progress.
 */
export function RenderDialog({
  videoId,
  document,
  seq,
  open,
  onOpenChange,
  apply,
  onOpenDevSetup,
}: RenderDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const fileId = useId();
  const hwId = useId();
  const settings = document.renderSettings;
  const nonCommercial = nonCommercialNarration(document.scenario.scenes.map((s) => s.voiceRef));
  const [fileName, setFileName] = useState('');
  const [startAspect, setStartAspect] = useState(settings.aspect);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setFileName('');
    setStartAspect(settings.aspect);
  }, [open]);

  const tools = useQuery({
    queryKey: studioKeys.renderTools,
    queryFn: () => studioRenderClient().tools(),
    enabled: open,
    staleTime: 30_000,
  });
  const estimate = useQuery({
    queryKey: studioKeys.renderEstimate(videoId, seq),
    queryFn: () => studioRenderClient().estimate(videoId),
    enabled: open,
  });
  const studioSettings = useQuery({
    queryKey: studioKeys.settings,
    queryFn: () => studioClient().settings(),
    enabled: open,
  });
  const gpuAllowed = studioSettings.data?.hwEncode !== false;
  const jobs = useQuery({
    queryKey: studioKeys.renderList(videoId),
    queryFn: () => studioRenderClient().jobs(videoId),
    enabled: open,
  });
  const start = useMutation({
    mutationFn: () =>
      studioRenderClient().start({ videoId, fileName: fileName.trim() || undefined }),
    onSuccess: async (job) => {
      setFileName('');
      toast.success(
        job.status === 'queued' ? `Queued ${job.fileName}.` : `Rendering ${job.fileName}.`,
      );
      await queryClient.invalidateQueries({ queryKey: studioKeys.renders });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const set = (patch: Partial<RenderSettings>, label: string) =>
    void apply([{ op: 'render.set', patch }], label);
  const codecs = tools.data?.codecs;
  const missingFfmpeg = tools.data ? !tools.data.ffmpeg.found || !tools.data.ffprobe.found : false;
  const codecProblem = codecs?.[settings.codec] ?? null;
  const ready = estimate.data?.ok === true;
  const canRender = ready && !missingFfmpeg && !codecProblem && !start.isPending && !!tools.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Render the video</DialogTitle>
          <DialogDescription>
            Makes a video file in the video's renders folder. Each choice is saved with the video,
            and you can keep working while it renders.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canRender) start.mutate();
          }}
        >
          {missingFfmpeg && (
            <Notice
              tone="warning"
              size="sm"
              action={
                <Button type="button" size="sm" variant="soft" onClick={onOpenDevSetup}>
                  <Wrench /> Open Dev Setup
                </Button>
              }
            >
              Rendering needs ffmpeg, which is not installed yet. Dev Setup installs it in a click
              (the Studio stack).
            </Notice>
          )}
          {nonCommercial.length > 0 && (
            <Notice tone="warning" size="sm">
              This video is for non-commercial use only: its narration uses{' '}
              {nonCommercial.join(' and ')}.
            </Notice>
          )}
          <Segments
            label="Format"
            value={settings.aspect}
            choices={ASPECTS.map((value) => ({ value, label: ASPECT_LABELS[value] }))}
            onChange={(aspect) => set({ aspect }, 'Changed the video format')}
          />
          {settings.aspect !== startAspect && (
            <Notice tone="warning" size="sm">
              Scenes lay out again at the new shape. Check them in the scene previews before you
              render.
            </Notice>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Segments
              label="Size"
              value={settings.resolution}
              choices={RESOLUTIONS.map((value) => ({ value, label: RESOLUTION_LABELS[value] }))}
              onChange={(resolution) => set({ resolution }, 'Changed the render size')}
            />
            <Segments
              label="Frame rate"
              value={settings.fps}
              choices={FRAME_RATES.map((value) => ({ value, label: `${value} fps` }))}
              onChange={(fps) => set({ fps }, 'Changed the frame rate')}
            />
            <Segments
              label="Quality"
              value={settings.quality}
              choices={QUALITIES.map((value) => ({
                value,
                label: QUALITY_LABELS[value],
                hint: QUALITY_HINTS[value],
              }))}
              onChange={(quality) => set({ quality }, 'Changed the render quality')}
            />
            <Segments
              label="Codec"
              value={settings.codec}
              choices={CODECS.map((value) => ({
                value,
                label: CODEC_LABELS[value],
                hint: CODEC_HINTS[value],
                disabled: missingFfmpeg ? null : (codecs?.[value] ?? null),
              }))}
              onChange={(codec) => set({ codec }, 'Changed the codec')}
            />
          </div>
          {codecProblem && !missingFfmpeg && (
            <Notice tone="destructive" size="sm">
              {codecProblem}
            </Notice>
          )}
          <div className="flex items-center gap-2">
            <Switch
              id={hwId}
              checked={settings.hwEncode && gpuAllowed}
              disabled={!gpuAllowed}
              onCheckedChange={(hwEncode) =>
                set(
                  { hwEncode },
                  hwEncode
                    ? 'Turned on graphics card encoding'
                    : 'Turned off graphics card encoding',
                )
              }
            />
            <Label htmlFor={hwId}>Encode on the graphics card when it can</Label>
            {!gpuAllowed && (
              <span className="text-xs text-muted-foreground">
                Turned off for every video in Settings
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={fileId}>File name</Label>
            <div className="flex items-center gap-2">
              <Input
                id={fileId}
                dir="auto"
                maxLength={120}
                value={fileName}
                placeholder={estimate.data?.ok ? estimate.data.fileName : ''}
                onChange={(event) => setFileName(event.target.value)}
              />
              <span className="text-sm text-muted-foreground">
                .
                {estimate.data?.ok
                  ? estimate.data.extension
                  : settings.codec === 'vp9'
                    ? 'webm'
                    : 'mp4'}
              </span>
            </div>
          </div>
          <RenderSummary estimate={estimate} resolution4k={settings.resolution === '2160p'} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button type="submit" disabled={!canRender}>
              <Video /> {start.isPending ? 'Starting...' : 'Render'}
            </Button>
          </DialogFooter>
        </form>
        {(jobs.data?.length ?? 0) > 0 && (
          <section aria-label="Renders of this video" className="space-y-2 pt-2">
            <h3 className="text-sm font-medium">Renders of this video</h3>
            <ul className="max-h-72 space-y-1.5 overflow-y-auto">
              {jobs.data?.map((job) => (
                <RenderJobRow key={job.id} job={job} />
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenderSummary({
  estimate,
  resolution4k,
}: {
  estimate: UseQueryResult<RenderEstimateView>;
  resolution4k: boolean;
}): React.JSX.Element {
  if (estimate.isLoading)
    return <Skeleton className="h-12 w-full" aria-label="Working out the render" />;
  if (estimate.error) {
    return (
      <Notice tone="destructive" size="sm">
        {errorMessage(estimate.error)}
      </Notice>
    );
  }
  const data = estimate.data;
  if (!data) return <></>;
  if (!data.ok) {
    return (
      <Notice tone="warning" size="sm">
        <span className="block font-medium">This video cannot render yet:</span>
        <ul className="list-disc ps-4">
          {data.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </Notice>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground" aria-label="What the render makes">
        {formatSeconds(data.durationSeconds)} long, {data.width}x{data.height}, {data.frames}{' '}
        frames. About {formatBytes(data.outputBytes)}, and about {formatSeconds(data.seconds)} to
        render.
      </p>
      {resolution4k && (
        <Notice tone="neutral" size="sm">
          4K draws each frame at four times the pixels of 1080p, so it takes a good while longer.
        </Notice>
      )}
      {data.warnings.map((warning) => (
        <Notice key={warning} tone="warning" size="sm">
          {warning}
        </Notice>
      ))}
    </div>
  );
}
