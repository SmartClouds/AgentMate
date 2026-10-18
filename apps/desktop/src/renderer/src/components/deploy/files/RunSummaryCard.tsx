import type { FilesPlanNotice, FilesRunResult, FilesRunState } from '@shared/deployFilesTypes';
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleInfo,
  CircleX,
  Minus,
  RefreshCw,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Chip, type ChipTone, GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FilesRunNotes } from '@/stores/deployFilesRunStore';
import { durationText, NOTICE_TEXT, plural, runCountsText } from './copy';
import { filesProblemText, RUN_STATE_LABEL } from './messages';

/**
 * How a deploy ended (E23): its state in words, what was sent, how long it took, and for files
 * that failed, each one with the reason and a way to send them again. A partial or cancelled run
 * says plainly that the rest is still pending.
 */

export const STATE_LOOK: Record<
  FilesRunState,
  { tone: ChipTone; icon: typeof CircleCheck; iconClass: string; edge: string }
> = {
  done: { tone: 'success', icon: CircleCheck, iconClass: 'text-success', edge: 'ring-success/25' },
  partial: {
    tone: 'warning',
    icon: TriangleAlert,
    iconClass: 'text-warning',
    edge: 'ring-warning/30',
  },
  failed: {
    tone: 'destructive',
    icon: CircleX,
    iconClass: 'text-destructive',
    edge: 'ring-destructive/30',
  },
  cancelled: {
    tone: 'neutral',
    icon: Minus,
    iconClass: 'text-muted-foreground',
    edge: 'ring-foreground/[0.08]',
  },
};

function outcomeText(result: FilesRunResult): string | null {
  if (result.state === 'partial') return 'The rest is still in the list. Deploy again to send it.';
  if (result.state === 'cancelled') return 'What was not sent is still in the list.';
  if (result.state === 'failed') {
    return result.error ? filesProblemText(result.error.code, result.error.message) : null;
  }
  return null;
}

export function RunSummaryCard({
  result,
  notes,
  onRetryFailed,
  onDismiss,
  retrying = false,
  className,
}: {
  result: FilesRunResult;
  notes: FilesRunNotes | null;
  onRetryFailed: (paths: string[]) => void;
  onDismiss: () => void;
  retrying?: boolean;
  className?: string;
}): React.JSX.Element {
  const [showFailed, setShowFailed] = useState(false);
  const look = STATE_LOOK[result.state];
  const Icon = look.icon;
  const outcome = outcomeText(result);
  const failedPaths = result.failed.map((failure) => failure.path);

  return (
    <section
      aria-label="Last deploy"
      className={cn(GLASS_CARD, 'space-y-3 p-4 ring-1 ring-inset', look.edge, className)}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', look.iconClass)} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={look.tone}>{RUN_STATE_LABEL[result.state]}</Chip>
            <span className="text-xs tabular-nums text-foreground/90">
              {runCountsText(result)}. It took {durationText(result.finishedAt - result.startedAt)}.
            </span>
          </div>
          {outcome && <p className="text-xs text-muted-foreground">{outcome}</p>}
          {result.trigger === 'deployOnSave' && (
            <p className="text-[11px] text-muted-foreground">Started by Deploy on save.</p>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss"
          className="shrink-0"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>

      {(Boolean(notes?.notices.length) || Boolean(notes?.drift.length) || !result.atomic) && (
        <ul className="space-y-1 pl-7 text-[11px] text-muted-foreground">
          {notes?.notices.map((notice) => (
            <li key={notice} className="flex gap-1.5">
              <CircleInfo className="mt-px h-3 w-3 shrink-0" />
              {notice === 'clockShift'
                ? NOTICE_TEXT.clockShift(null)
                : NOTICE_TEXT[notice as Exclude<FilesPlanNotice, 'clockShift'>]}
            </li>
          ))}
          {notes && notes.drift.length > 0 && (
            <li className="flex gap-1.5">
              <CircleInfo className="mt-px h-3 w-3 shrink-0" />
              {plural(notes.drift.length, 'file')} changed on the server only{' '}
              {notes.drift.length === 1 ? 'was' : 'were'} left as it is.
            </li>
          )}
          {!result.atomic && (
            <li className="flex gap-1.5">
              <CircleInfo className="mt-px h-3 w-3 shrink-0" />
              This server replaced files in place, so for a moment during each upload the old file
              was gone.
            </li>
          )}
        </ul>
      )}

      {result.failed.length > 0 && (
        <div className="space-y-2 pl-7">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={showFailed}
              onClick={() => setShowFailed((open) => !open)}
            >
              {showFailed ? <ChevronDown /> : <ChevronRight />}
              {showFailed ? 'Hide failed files' : `Show failed files (${result.failed.length})`}
            </Button>
            <Button
              size="xs"
              variant="soft"
              disabled={retrying}
              onClick={() => onRetryFailed(failedPaths)}
            >
              <RefreshCw /> Retry failed
            </Button>
          </div>
          {showFailed && (
            <ul
              aria-label="Failed files"
              className="settings-rows overflow-hidden rounded-lg bg-foreground/[0.03] px-3 ring-1 ring-inset ring-foreground/[0.07]"
            >
              {result.failed.map((failure) => (
                <li key={failure.path} className="space-y-0.5 py-1.5">
                  <p className="truncate font-mono text-xs">{failure.path}</p>
                  <p className="text-[11px] text-destructive">
                    {filesProblemText(failure.code, failure.message)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
