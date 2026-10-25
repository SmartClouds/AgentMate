import type { GithubRunJob, GithubRunStep } from '@shared/apiTypes';
import { useId, useState } from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  Minus,
  Spinner,
} from '@/components/icons';
import {
  RunStatusIcon,
  type RunTone,
  runTone,
  spanDuration,
} from '@/components/pipelines/runStatus';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const SUMMARY_ORDER = ['failed', 'running', 'queued', 'passed', 'cancelled'];

/** "1 failed · 1 running · 2 passed": what the jobs came to, worst first. */
export function summarizeJobs(jobs: GithubRunJob[]): string {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const tone = runTone(job);
    const key = tone.outcome === 'other' ? tone.label.toLowerCase() : tone.outcome;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = SUMMARY_ORDER.filter((key) => counts.has(key));
  const rest = [...counts.keys()].filter((key) => !SUMMARY_ORDER.includes(key));
  return [...known, ...rest].map((key) => `${counts.get(key)} ${key}`).join(' · ');
}

/** A step's own glyph. The words are for screen readers, since colour alone says too little. */
function StepGlyph({ tone }: { tone: RunTone }): React.JSX.Element {
  const size = 'h-3.5 w-3.5 shrink-0';
  const icon =
    tone.outcome === 'running' ? (
      <Spinner className={cn(size, 'animate-spin text-warning motion-reduce:animate-none')} />
    ) : tone.outcome === 'failed' ? (
      <CircleX className={cn(size, 'text-destructive')} />
    ) : tone.outcome === 'passed' ? (
      <CircleCheck className={cn(size, 'text-success')} />
    ) : tone.outcome === 'queued' ? (
      <Clock className={cn(size, 'text-muted-foreground')} />
    ) : (
      <Minus className={cn(size, 'text-muted-foreground/60')} />
    );
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {icon}
      <span className="sr-only">{tone.label}</span>
    </span>
  );
}

/** How long a job or step took. Skipped ones never ran, so they show nothing. */
function elapsed(
  item: Pick<GithubRunStep, 'status' | 'conclusion' | 'startedAt' | 'completedAt'>,
  now: number,
): string {
  if (item.conclusion === 'skipped') return '';
  return spanDuration(
    item.startedAt,
    item.completedAt,
    item.status === 'in_progress' ? now : undefined,
  );
}

function StepRow({ step, now }: { step: GithubRunStep; now: number }): React.JSX.Element {
  const tone = runTone(step);
  const failed = tone.outcome === 'failed';
  const muted = tone.outcome === 'cancelled' || tone.label === 'Skipped';
  return (
    <li
      data-failed={failed ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2 py-1 text-xs',
        failed && 'bg-destructive/[0.06] ring-1 ring-inset ring-destructive/20',
        muted && 'text-muted-foreground/70',
      )}
    >
      <StepGlyph tone={tone} />
      <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
        {step.number}
      </span>
      <span className="min-w-0 flex-1 break-words">{step.name}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {elapsed(step, now)}
      </span>
    </li>
  );
}

function JobCard({
  job,
  open,
  onToggle,
  now,
}: {
  job: GithubRunJob;
  open: boolean;
  onToggle: () => void;
  now: number;
}): React.JSX.Element {
  const stepsId = useId();
  const tone = runTone(job);
  const duration = elapsed(job, now);
  return (
    <li
      className={cn(
        // Rings, not borders: the theme's global border colour would hide the tint.
        'rounded-xl ring-1 ring-inset',
        tone.outcome === 'failed'
          ? 'bg-destructive/[0.04] ring-destructive/20'
          : 'bg-foreground/[0.025] ring-foreground/[0.08]',
      )}
    >
      <div className="flex items-center gap-1 pr-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={stepsId}
          // One clear name instead of the glyph, name and time read as run-together fragments.
          aria-label={`${job.name}, ${tone.label}${duration ? `, ${duration}` : ''}`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <RunStatusIcon tone={tone} className="h-6 w-6 rounded-md" />
          <span className="sr-only">{tone.label}</span>
          <span className="min-w-0 flex-1 break-words text-[13px] font-medium">{job.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {duration}
          </span>
        </button>
        {job.htmlUrl ? (
          <SimpleTooltip label="Open job on GitHub">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${job.name} on GitHub`}
              onClick={() => void window.agentmat.shell.openExternal(job.htmlUrl as string)}
            >
              <ExternalLink />
            </Button>
          </SimpleTooltip>
        ) : null}
      </div>
      {open ? (
        <div id={stepsId} className="px-2 pb-2">
          {job.steps.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No steps yet.</p>
          ) : (
            <ol aria-label={`${job.name} steps`} className="space-y-px">
              {job.steps.map((step) => (
                <StepRow key={step.number} step={step} now={now} />
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </li>
  );
}

const JOB_ORDER: Record<string, number> = { failed: 0, running: 1, queued: 2 };

/**
 * The jobs of a run, each one folding open onto its steps. Failures come first, then running and
 * queued jobs, so the one that broke is not buried in a long matrix; the rest keep GitHub's order.
 * A failed or running job, and a run's only job, start open; anything the user folds or opens
 * stays that way when the jobs refresh.
 */
export function RunJobs({ jobs, now }: { jobs: GithubRunJob[]; now?: number }): React.JSX.Element {
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  const clock = now ?? Date.now();
  // Array.prototype.sort is stable, so equal ranks stay in the order GitHub listed them.
  const ordered = [...jobs].sort(
    (a, b) => (JOB_ORDER[runTone(a).outcome] ?? 3) - (JOB_ORDER[runTone(b).outcome] ?? 3),
  );

  return (
    <ul className="space-y-1.5">
      {ordered.map((job) => {
        const outcome = runTone(job).outcome;
        const open =
          chosen[job.id] ?? (jobs.length === 1 || outcome === 'failed' || outcome === 'running');
        return (
          <JobCard
            key={job.id}
            job={job}
            open={open}
            now={clock}
            onToggle={() => setChosen((current) => ({ ...current, [job.id]: !open }))}
          />
        );
      })}
    </ul>
  );
}
