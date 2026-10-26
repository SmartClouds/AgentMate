import { STUDIO_GEN } from '@agentmat/core';
import { type Aspect, formatUsd, type GenJobView, type GenRequest } from '@agentmat/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { studioGenClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  type ChipTone,
  cn,
  confirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  persianTextProps,
  SEGMENT_TRACK,
  Skeleton,
  Spinner,
  segmentClass,
  Textarea,
  toast,
} from '../kit';
import { studioKeys } from '../queryKeys';

export interface GenerateDialogProps {
  videoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The video's shape, which a new picture or clip starts from. */
  aspect: Aspect;
}

const STATUS: Record<GenJobView['status'], { label: string; tone: ChipTone }> = {
  running: { label: 'Making', tone: 'primary' },
  done: { label: 'In Media', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  refused: { label: 'Declined', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const STAGE: Record<NonNullable<GenJobView['stage']>, string> = {
  request: 'Asking the model',
  waiting: 'The provider is making the clip',
  download: 'Downloading',
  import: 'Waiting for the video to open',
};

function Segments<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className={SEGMENT_TRACK} role="radiogroup" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={value === choice.value}
            className={segmentClass(value === choice.value)}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Pictures and short clips made by online models (E38), into the video's media. Each one bills
 * the person's own account, so the price is shown first and asked about once more before anything
 * is sent; what was spent on this video is summed up below.
 */
export function GenerateDialog({
  videoId,
  open,
  onOpenChange,
  aspect,
}: GenerateDialogProps): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const [engine, setEngine] = useState<'openai' | 'gemini'>('gemini');
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [geminiSize, setGeminiSize] = useState<'1K' | '2K' | '4K'>('1K');
  const [starting, setStarting] = useState(false);

  const shape = aspect === '9:16' ? '9:16' : aspect === '16:9' ? '16:9' : aspect;
  const openaiSize =
    aspect === '9:16' || aspect === '4:5'
      ? '1024x1536'
      : aspect === '1:1'
        ? '1024x1024'
        : '1536x1024';
  const request: GenRequest =
    kind === 'video'
      ? { kind, engine: 'gemini', prompt, aspectRatio: shape === '9:16' ? '9:16' : '16:9' }
      : engine === 'openai'
        ? { kind, engine, prompt, size: openaiSize, quality }
        : { kind, engine, prompt, size: geminiSize, aspectRatio: shape };

  const estimate = useQuery({
    queryKey: ['studio', 'gen-estimate', videoId, { ...request, prompt: '' }],
    queryFn: () => studioGenClient().estimate({ ...request, videoId, prompt: 'estimate' }),
    enabled: open,
  });
  const jobs = useQuery({
    queryKey: studioKeys.genJobs(videoId),
    queryFn: () => studioGenClient().jobs(videoId),
    enabled: open,
  });

  useEffect(() => {
    if (kind === 'video') setEngine('gemini');
  }, [kind]);

  const spent = (jobs.data ?? [])
    .filter((j) => j.status === 'done')
    .reduce((sum, j) => sum + j.estimateUsd, 0);

  async function generate(): Promise<void> {
    const price = estimate.data;
    if (!price || prompt.trim().length < 3) return;
    const ok = await confirmDialog({
      title: `Make this with ${price.label}?`,
      description: `This bills your ${price.label} account about ${formatUsd(price.usd)}. ${price.basis}`,
      confirmLabel: 'Make it',
    });
    if (!ok) return;
    setStarting(true);
    try {
      await studioGenClient().start({
        ...request,
        videoId,
        prompt: prompt.trim(),
        confirmedUsd: price.usd,
      });
      toast.success(
        kind === 'image'
          ? 'Making the picture. It lands in Media when it is ready.'
          : 'Making the clip. It lands in Media when it is ready, even after a restart.',
      );
      setPrompt('');
      void queryClient.invalidateQueries({ queryKey: studioKeys.genJobs(videoId) });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setStarting(false);
    }
  }

  const promptProps = persianTextProps(prompt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Generate</DialogTitle>
          <DialogDescription>
            A picture or a short clip made by an online model, billed to your own account with the
            keys in Settings &gt; AI.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-4">
          <Segments
            label="Make"
            value={kind}
            choices={[
              { value: 'image', label: 'Picture' },
              { value: 'video', label: 'Clip' },
            ]}
            onChange={setKind}
          />
          {kind === 'image' ? (
            <Segments
              label="Model"
              value={engine}
              choices={[
                { value: 'gemini', label: STUDIO_GEN.image.gemini.label },
                { value: 'openai', label: STUDIO_GEN.image.openai.label },
              ]}
              onChange={setEngine}
            />
          ) : (
            <div className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Model</span>
              <p className="py-1.5 text-sm">{STUDIO_GEN.video.gemini.label}</p>
            </div>
          )}
          {kind === 'image' && engine === 'openai' && (
            <Segments
              label="Quality"
              value={quality}
              choices={STUDIO_GEN.image.openai.qualities.map((q) => ({
                value: q,
                label: q[0]?.toUpperCase() + q.slice(1),
              }))}
              onChange={setQuality}
            />
          )}
          {kind === 'image' && engine === 'gemini' && (
            <Segments
              label="Size"
              value={geminiSize}
              choices={STUDIO_GEN.image.gemini.sizes.map((s) => ({ value: s, label: s }))}
              onChange={setGeminiSize}
            />
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-prompt`}>What to make</Label>
          <Textarea
            id={`${id}-prompt`}
            value={prompt}
            dir="auto"
            rows={3}
            maxLength={4000}
            className={promptProps.className}
            placeholder={
              kind === 'image'
                ? 'A sunrise over Tehran, flat vector style'
                : 'A slow pan across a desk at night'
            }
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <p aria-label="Estimate" className="min-w-0 flex-1 text-xs text-muted-foreground">
            {estimate.data
              ? `${formatUsd(estimate.data.usd)}. ${estimate.data.basis}`
              : estimate.isError
                ? errorMessage(estimate.error)
                : ''}
          </p>
          <Button
            disabled={!estimate.data || prompt.trim().length < 3 || starting}
            onClick={() => void generate()}
          >
            {starting && <Spinner />} Generate
          </Button>
        </div>

        <section aria-label="Generated" className="space-y-1.5 border-t pt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Made for this video</span>
            <span aria-label="Spent">
              Spent: {spent > 0 ? formatUsd(spent) : '$0'} at list prices
            </span>
          </div>
          {jobs.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {(jobs.data ?? []).map((job) => (
                <li
                  key={job.id}
                  aria-label={job.prompt}
                  className="space-y-0.5 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm',
                        persianTextProps(job.prompt).className,
                      )}
                      dir="auto"
                    >
                      {job.prompt}
                    </span>
                    <Chip tone={STATUS[job.status].tone} dot pulse={job.status === 'running'}>
                      {STATUS[job.status].label}
                    </Chip>
                    {job.status === 'running' && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void studioGenClient()
                            .cancel(job.id)
                            .catch((error: unknown) => toast.error(errorMessage(error)))
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {job.status === 'running' && job.stage ? `${STAGE[job.stage]}. ` : ''}
                    {job.status === 'done' && job.mediaName ? `${job.mediaName}. ` : ''}
                    {job.status === 'done' && job.stage === 'import' ? `${STAGE.import}. ` : ''}
                    {job.error ? `${job.error} ` : ''}
                    {job.model}, {formatUsd(job.estimateUsd)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
