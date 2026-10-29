import { useEffect, useState } from 'react';
import { ListTodo } from '@/components/icons';
import { segmentClass } from '@/components/layout/statusBarKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { openPlanJob, type PlanJob, useRelayPlanJobsStore } from '@/stores/relayPlanJobsStore';
import { formatElapsed } from './usePlanJob';

/** A result waiting on the user beats a failure, which beats one still running. */
function rank(job: PlanJob): number {
  if (job.status === 'done') return 0;
  if (job.status === 'failed') return 1;
  return 2;
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

const WORD: Record<PlanJob['kind'], string> = {
  split: 'Splitting',
  revise: 'Revising',
  'catch-up': 'Planning',
};

/**
 * The status bar's planner item, there only while a Relay plan runs in the background or waits
 * to be reviewed. A click opens its dialog again.
 */
export function RelayPlanStatusSegment(): React.JSX.Element | null {
  const jobs = useRelayPlanJobsStore((s) => s.jobs);
  const list = Object.values(jobs)
    .filter((job): job is PlanJob => Boolean(job))
    .sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
  const job = list[0];
  const now = useNow(job?.status === 'running');
  if (!job) return null;

  const where = job.projectName || 'a project';
  const text =
    job.status === 'done'
      ? 'Tasks ready'
      : job.status === 'failed'
        ? 'Planning failed'
        : `${WORD[job.kind]} ${formatElapsed(Math.max(0, Math.floor((now - job.startedAt) / 1000)))}`;
  const label =
    job.status === 'done'
      ? `The plan for ${where} is ready to review`
      : job.status === 'failed'
        ? `Planning for ${where} stopped: ${job.error ?? 'no answer'}`
        : `Planning tasks for ${where} in the background`;
  const more = list.length - 1;

  return (
    <SimpleTooltip
      label={more > 0 ? `${label}. ${more} more plan${more > 1 ? 's' : ''}.` : label}
      side="top"
    >
      <button
        type="button"
        aria-label={label}
        onClick={() => openPlanJob(job.key)}
        className={cn(
          segmentClass,
          job.status === 'done' && 'text-primary',
          job.status === 'failed' && 'text-destructive',
        )}
      >
        <ListTodo
          aria-hidden
          className={cn('h-3 w-3', job.status === 'running' && 'animate-pulse text-primary')}
        />
        <span className="font-medium tabular-nums">{text}</span>
        {more > 0 ? <span className="opacity-70">+{more}</span> : null}
      </button>
    </SimpleTooltip>
  );
}
