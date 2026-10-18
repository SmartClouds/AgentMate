import type { FilesProgressEvent } from '@shared/deployFilesTypes';
import { CloudUpload, Spinner, X } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FilesRunSample } from '@/stores/deployFilesRunStore';
import { durationText, PHASE_LABEL, plural, timeLeftMs, transferRate } from './copy';

/**
 * A deploy as it runs (E23). It takes the Deploy button's place in the card and never covers the
 * page: the phase, the file on its way, a bar for the files and one for the data, the speed and
 * the time left, and Cancel.
 */
export function RunProgressCard({
  progress,
  samples,
  onCancel,
  cancelling = false,
  className,
}: {
  /** Null between the deploy call and the first event. */
  progress: FilesProgressEvent | null;
  samples: readonly FilesRunSample[];
  onCancel: () => void;
  cancelling?: boolean;
  className?: string;
}): React.JSX.Element {
  const phase = progress ? PHASE_LABEL[progress.phase] : 'Connecting';
  const rate = transferRate(samples);
  const left = progress ? timeLeftMs(progress, rate) : null;
  const bytesPercent =
    progress && progress.bytesTotal > 0
      ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
      : 0;

  return (
    <section
      aria-label="Deploy progress"
      className={cn(GLASS_CARD, 'space-y-3 p-4 ring-1 ring-inset ring-primary/20', className)}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary [&_svg]:size-4">
          <CloudUpload />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
          <p role="status" className="flex items-center gap-1.5 text-sm font-semibold">
            <Spinner className="h-3.5 w-3.5 text-primary motion-safe:animate-spin" />
            {phase}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {progress?.trigger === 'deployOnSave'
              ? 'Deploy on save is sending your changes. '
              : null}
            {progress?.currentPath ? (
              <span className="font-mono text-foreground/85">{progress.currentPath}</span>
            ) : progress?.trigger !== 'deployOnSave' ? (
              'Getting ready to send the files.'
            ) : null}
          </p>
        </div>
        <Button
          size="sm"
          variant="soft"
          disabled={cancelling}
          onClick={onCancel}
          className="shrink-0"
        >
          {cancelling ? <Spinner className="motion-safe:animate-spin" /> : <X />}
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Bar
          label="Files"
          now={progress?.filesDone ?? 0}
          max={progress?.filesTotal ?? 0}
          percent={
            progress && progress.filesTotal > 0
              ? (progress.filesDone / progress.filesTotal) * 100
              : 0
          }
          text={
            progress
              ? `${progress.filesDone} of ${plural(progress.filesTotal, 'file')}`
              : 'Counting files'
          }
        />
        <Bar
          label="Data"
          now={bytesPercent}
          max={100}
          percent={bytesPercent}
          text={
            progress
              ? `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`
              : 'Counting bytes'
          }
        />
      </div>

      <p className="flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted-foreground">
        {rate === null ? (
          <span>Working out the speed…</span>
        ) : (
          <>
            <span>{`${formatBytes(rate)}/s`}</span>
            {left !== null && <span>{`${durationText(left)} left`}</span>}
          </>
        )}
      </p>
    </section>
  );
}

function Bar({
  label,
  now,
  max,
  percent,
  text,
}: {
  label: string;
  now: number;
  max: number;
  percent: number;
  text: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground/85">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={now}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <div
          className="h-full rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)] transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
    </div>
  );
}
