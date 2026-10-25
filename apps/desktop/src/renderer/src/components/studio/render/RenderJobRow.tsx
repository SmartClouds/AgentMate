import type { RenderJobView } from '@agentmat/studio';
import { useState } from 'react';
import { studioRenderClient } from '../client';
import { errorMessage, formatSeconds, formatWhen } from '../format';
import {
  Button,
  Chip,
  cn,
  FolderOpen,
  Play,
  RefreshCw,
  SimpleTooltip,
  StopCircle,
  Trash2,
  toast,
} from '../kit';
import {
  CODEC_LABELS,
  isActive,
  progressLabel,
  QUALITY_LABELS,
  RESOLUTION_LABELS,
  STATUS_CHIPS,
} from './renderLabels';

/** A bar for how far a render is, with its numbers for screen readers. */
export function RenderProgress({ job }: { job: RenderJobView }): React.JSX.Element {
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={progressLabel(job)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.status === 'queued' ? undefined : percent}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none',
            job.status === 'queued' && 'w-0',
          )}
          style={job.status === 'queued' ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">{progressLabel(job)}</p>
    </div>
  );
}

/** One render in the list: what it is, how far it got, and what can be done with it. */
export function RenderJobRow({ job }: { job: RenderJobView }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const status = STATUS_CHIPS[job.status];
  const act = (run: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const client = studioRenderClient();
  const settings = job.settings;
  const facts = [
    `${job.width}x${job.height}`,
    RESOLUTION_LABELS[settings.resolution],
    `${settings.fps} fps`,
    QUALITY_LABELS[settings.quality],
    CODEC_LABELS[settings.codec],
    formatSeconds(job.durationSeconds),
  ].join(', ');

  return (
    <li className="space-y-1.5 rounded-lg bg-foreground/[0.03] px-3 py-2" aria-label={job.fileName}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">
          {job.fileName}
        </span>
        <Chip tone={status.tone} dot pulse={job.status === 'running'}>
          {status.label}
        </Chip>
        {job.resumed && <Chip tone="neutral">Resumed</Chip>}
        <div className="flex items-center gap-0.5">
          {isActive(job) && (
            <SimpleTooltip label="Cancel the render. Finished parts are kept for next time.">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel the render"
                disabled={busy}
                onClick={act(() => client.cancel(job.id))}
              >
                <StopCircle />
              </Button>
            </SimpleTooltip>
          )}
          {(job.status === 'failed' ||
            job.status === 'cancelled' ||
            job.status === 'interrupted') && (
            <SimpleTooltip
              label={
                job.status === 'interrupted'
                  ? 'Carry on where it stopped'
                  : 'Try again, reusing the parts already drawn'
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  job.status === 'interrupted' ? 'Resume the render' : 'Try the render again'
                }
                disabled={busy}
                onClick={act(() => client.retry(job.id))}
              >
                <RefreshCw />
              </Button>
            </SimpleTooltip>
          )}
          {job.status === 'done' && (
            <>
              <SimpleTooltip label="Play the video">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Play the video"
                  onClick={act(() => client.openFile(job.id))}
                >
                  <Play />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip label="Show the file in its folder">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Show the file in its folder"
                  onClick={act(() => client.reveal(job.id))}
                >
                  <FolderOpen />
                </Button>
              </SimpleTooltip>
            </>
          )}
          {!isActive(job) && (
            <SimpleTooltip label="Remove from this list. The file stays where it is.">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Remove from the list"
                disabled={busy}
                onClick={act(() => client.remove(job.id))}
              >
                <Trash2 />
              </Button>
            </SimpleTooltip>
          )}
        </div>
      </div>
      {isActive(job) && <RenderProgress job={job} />}
      {job.error && (
        <p className="text-xs text-destructive" dir="auto">
          {job.error}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {facts}
        {job.status === 'done' && job.reusedChunks > 0 && (
          <>
            {'. '}Reused {job.reusedChunks} of {job.reusedChunks + job.capturedChunks} parts from
            earlier renders
          </>
        )}
        {job.status === 'done' && job.hardware && <>. Encoded on the graphics card</>}
        {'. '}
        {formatWhen(job.endedAt ?? job.startedAt ?? job.createdAt)}
      </p>
    </li>
  );
}
