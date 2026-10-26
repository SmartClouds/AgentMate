import { coreErrorMessage } from '@shared/coreErrors';
import type {
  JobInfo,
  JobState,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Spinner, StopCircle, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useJobLog } from './hooks';

/** A job's live log (already redacted by the core), its outcome in words, and a cancel. */

export const JOB_STATE_TEXT: Record<JobState, string> = {
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function StateLine({ job }: { job: JobInfo }): React.JSX.Element {
  const Icon =
    job.state === 'running'
      ? Spinner
      : job.state === 'succeeded'
        ? CircleCheck
        : job.state === 'failed'
          ? CircleX
          : TriangleAlert;
  return (
    <span role="status" className="flex items-center gap-1.5 text-sm">
      <Icon
        className={cn(
          'h-3.5 w-3.5',
          job.state === 'running' && 'text-muted-foreground motion-safe:animate-spin',
          job.state === 'succeeded' && 'text-success',
          job.state === 'failed' && 'text-destructive',
          (job.state === 'cancelled' || job.state === 'interrupted') && 'text-warning',
        )}
      />
      <span className="text-foreground">{JOB_STATE_TEXT[job.state]}</span>
      {job.error && <span className="text-muted-foreground">: {job.error}</span>}
    </span>
  );
}

export function JobLogDialog({
  serverId,
  job,
  canCancel,
  onClose,
  onFinished,
}: {
  serverId: string;
  job: JobInfo | null;
  canCancel: boolean;
  onClose: () => void;
  /** Called once when the job reaches its final state. */
  onFinished?: (job: JobInfo) => void;
}): React.JSX.Element {
  const log = useJobLog(serverId, job);
  const [cancelling, setCancelling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const finished = useRef<string | null>(null);
  const current = log.job ?? job;

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line scrolls to the bottom
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [log.lines.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different job starts fresh
  useEffect(() => {
    setCancelling(false);
    setProblem(null);
  }, [job?.id]);

  useEffect(() => {
    if (!current || current.state === 'running' || finished.current === current.id) return;
    finished.current = current.id;
    onFinished?.(current);
  }, [current, onFinished]);

  async function cancel(): Promise<void> {
    if (!current) return;
    setCancelling(true);
    setProblem(null);
    try {
      await window.runova.deployJobs.cancel(serverId, current.id);
    } catch (error) {
      setProblem(coreErrorMessage(error));
      setCancelling(false);
    }
  }

  const running = current?.state === 'running';

  return (
    <Dialog open={job !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{current?.title ?? 'Job'}</DialogTitle>
          <DialogDescription>
            {running
              ? 'Runs on the server; closing this leaves it running.'
              : 'The whole log stays on the server.'}
          </DialogDescription>
        </DialogHeader>
        {current && <StateLine job={current} />}
        <div
          role="log"
          aria-label="Job log"
          aria-live="polite"
          className="max-h-80 min-h-40 overflow-auto rounded-xl bg-foreground/[0.04] p-3 font-mono text-xs leading-relaxed ring-1 ring-inset ring-foreground/[0.07]"
        >
          {log.lines.length === 0 ? (
            <p className="text-muted-foreground">
              {log.ended ? 'Nothing was written.' : 'Waiting for output…'}
            </p>
          ) : (
            log.lines.map((line) => (
              <div
                key={line.seq}
                className={cn(
                  'whitespace-pre-wrap break-words',
                  line.source === 'err' && 'text-warning',
                  line.source === 'system' && 'text-muted-foreground',
                )}
              >
                {line.text}
              </div>
            ))
          )}
          <div ref={bottom} />
        </div>
        {(problem || log.error) && (
          <p role="alert" className="text-sm text-destructive">
            {problem ?? log.error}
          </p>
        )}
        <DialogFooter>
          {canCancel && running && current?.cancellable && (
            <Button variant="danger" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? <Spinner className="motion-safe:animate-spin" /> : <StopCircle />}
              {cancelling ? 'Cancelling…' : 'Cancel the job'}
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
