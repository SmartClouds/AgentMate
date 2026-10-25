import type { GenerationStatus, GenerationView } from '@agentmat/studio';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { studioAiClient } from '../client';
import { errorMessage, formatWhen, scriptClass } from '../format';
import {
  Button,
  ChevronDown,
  ChevronUp,
  Chip,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LoadFailure,
  Notice,
  SECTION_WELL,
  Skeleton,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { runLabel } from './runSettings';

export const STATUS_LABELS: Record<
  GenerationStatus,
  { label: string; tone: 'primary' | 'neutral' | 'success' | 'warning' | 'destructive' }
> = {
  running: { label: 'Running', tone: 'primary' },
  done: { label: 'Written', tone: 'success' },
  proposed: { label: 'Waiting for you', tone: 'primary' },
  applied: { label: 'Applied', tone: 'success' },
  discarded: { label: 'Discarded', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'destructive' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
};

export const STAGE_LABELS: Record<GenerationView['stage'], string> = {
  scenario: 'Scenario',
  edit: 'Edit by typing',
};

function took(g: GenerationView): string | null {
  if (!g.finishedAt) return null;
  const seconds = Math.round((g.finishedAt - g.startedAt) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function TextBlock({
  title,
  text,
}: {
  title: string;
  text: string | null;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (text === null) return null;
  return (
    <div>
      <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronUp /> : <ChevronDown />} {title}
      </Button>
      {open && (
        <pre
          dir="auto"
          className={cn(
            'mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.04] p-2 font-mono text-[11px]',
            scriptClass(text),
          )}
        >
          {text || '(empty)'}
        </pre>
      )}
    </div>
  );
}

export interface GenerationDetailsDialogProps {
  videoId: string;
  generationId: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Everything about one AI run: which CLI, model and effort, what the user asked, and for each
 * attempt the exact request sent, the answer and the CLI's log. This is what makes a result
 * reproducible, and what explains a failure.
 */
export function GenerationDetailsDialog({
  videoId,
  generationId,
  onOpenChange,
}: GenerationDetailsDialogProps): React.JSX.Element {
  const detail = useQuery({
    queryKey: studioKeys.generationDetail(videoId, generationId ?? ''),
    queryFn: () => studioAiClient().generationDetail(videoId, generationId as string),
    enabled: generationId !== null,
  });
  const g = detail.data;
  const status = g ? STATUS_LABELS[g.status] : null;

  return (
    <Dialog open={generationId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI run</DialogTitle>
          <DialogDescription>What was asked, of which AI, and what came back.</DialogDescription>
        </DialogHeader>
        {detail.isPending && generationId !== null && (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {detail.error && (
          <LoadFailure
            message={`The run's record did not load. ${errorMessage(detail.error)}`}
            retry={() => void detail.refetch()}
          />
        )}
        {g && status && (
          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Stage</dt>
              <dd className="flex items-center gap-2">
                {STAGE_LABELS[g.stage]} <Chip tone={status.tone}>{status.label}</Chip>
              </dd>
              <dt className="text-muted-foreground">AI</dt>
              <dd>{runLabel(g)}</dd>
              {g.cliName && g.cliId === null && (
                <>
                  <dt className="text-muted-foreground">Answered by</dt>
                  <dd>{g.cliName}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-mono text-xs leading-5">{g.model ?? 'CLI default'}</dd>
              <dt className="text-muted-foreground">Effort</dt>
              <dd>{g.effort ?? 'Not set'}</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd>
                {formatWhen(g.startedAt)}
                {took(g) && <span className="text-muted-foreground"> · took {took(g)}</span>}
              </dd>
              {g.params.targetSeconds !== undefined && (
                <>
                  <dt className="text-muted-foreground">Length</dt>
                  <dd>about {g.params.targetSeconds} s</dd>
                </>
              )}
            </dl>
            <div className={SECTION_WELL}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">What you asked</p>
              <p
                dir="auto"
                className={cn(
                  'whitespace-pre-wrap break-words text-sm',
                  scriptClass(g.instruction),
                )}
              >
                {g.instruction}
              </p>
            </div>
            {g.error && (
              <Notice tone="destructive" size="sm">
                {g.error}
              </Notice>
            )}
            {g.attempts.map((attempt, i) => (
              <section
                key={attempt.requestHash + i}
                className={SECTION_WELL}
                aria-label={i === 0 ? 'First try' : `Repair round ${i}`}
              >
                <p className="text-xs font-semibold">
                  {i === 0 ? 'First try' : `Repair round ${i}`}
                </p>
                {attempt.issues.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {attempt.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
                {attempt.error && <p className="mt-1 text-xs text-destructive">{attempt.error}</p>}
                <div className="mt-1 flex flex-col items-start">
                  <TextBlock title="Request sent" text={g.texts[i]?.request ?? null} />
                  <TextBlock title="Answer" text={g.texts[i]?.output ?? null} />
                  <TextBlock title="CLI output" text={g.texts[i]?.log ?? null} />
                </div>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
