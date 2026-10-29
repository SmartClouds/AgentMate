import type { Project } from '@runova/core';
import type { GithubRunJob, GithubRunStep, GithubStepLog } from '@shared/apiTypes';
import { useId, useState } from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  Minus,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import {
  RunStatusIcon,
  type RunTone,
  runTone,
  spanDuration,
} from '@/components/pipelines/runStatus';
import { useJobLog } from '@/components/pipelines/useJobLog';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FixStepDialog, type StepFixTarget } from './FixStepDialog';
import { StepLog, type StepLogState } from './StepLog';

/** What the run around the jobs is, so a step's fix can say where it failed. */
export type RunFacts = Pick<
  StepFixTarget,
  'workflowName' | 'displayTitle' | 'runNumber' | 'headBranch'
>;

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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
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

/** A step that never started (queued, or skipped) has no log to open. */
function hasLog(step: GithubRunStep): boolean {
  return step.startedAt !== null && step.conclusion !== 'skipped';
}

/** The errors and warnings a step printed, once its log is in. */
function LogCounts({ log }: { log: GithubStepLog | undefined }): React.JSX.Element | null {
  if (!log || (log.errors === 0 && log.warnings === 0)) return null;
  const badge =
    'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium tabular-nums';
  return (
    <span className="flex shrink-0 items-center gap-1">
      {log.errors > 0 ? (
        <span
          aria-label={plural(log.errors, 'error')}
          className={cn(badge, 'bg-destructive/10 text-destructive')}
        >
          <CircleX className="h-2.5 w-2.5" />
          {log.errors}
        </span>
      ) : null}
      {log.warnings > 0 ? (
        <span
          aria-label={plural(log.warnings, 'warning')}
          className={cn(badge, 'bg-warning/10 text-warning')}
        >
          <TriangleAlert className="h-2.5 w-2.5" />
          {log.warnings}
        </span>
      ) : null}
    </span>
  );
}

/** What a step that can open onto its log needs: where the log is at, and how to fix it. */
interface StepLogSource {
  state: StepLogState;
  githubUrl: string | null;
  fix: { project: Project; target: StepFixTarget } | null;
}

function StepRow({
  step,
  now,
  log,
  open,
  onToggle,
}: {
  step: GithubRunStep;
  now: number;
  /** Only for a step that can be opened onto its log. */
  log?: StepLogSource;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const logId = useId();
  const [fixing, setFixing] = useState(false);
  const tone = runTone(step);
  const failed = tone.outcome === 'failed';
  const muted = tone.outcome === 'cancelled' || tone.label === 'Skipped';
  const duration = elapsed(step, now);
  const stepLog = log?.state.kind === 'ready' ? log.state.log : undefined;
  const counts = stepLog
    ? [
        stepLog.errors > 0 ? plural(stepLog.errors, 'error') : null,
        stepLog.warnings > 0 ? plural(stepLog.warnings, 'warning') : null,
      ]
    : [];

  const content = (
    <>
      <StepGlyph tone={tone} />
      <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
        {step.number}
      </span>
      <span className="min-w-0 flex-1 break-words">{step.name}</span>
      <LogCounts log={stepLog} />
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{duration}</span>
      {log ? (
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-muted-foreground/40 transition-transform duration-150 group-hover/step:text-muted-foreground motion-reduce:transition-none',
            open && 'rotate-90 text-muted-foreground',
          )}
        />
      ) : (
        // Keeps the durations of plain rows lined up with the ones that open.
        <span className="w-2.5 shrink-0" />
      )}
    </>
  );
  const row = 'flex w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-xs';

  return (
    <li
      data-failed={failed ? 'true' : undefined}
      className={cn(
        'rounded-lg',
        failed && 'bg-destructive/[0.06] ring-1 ring-inset ring-destructive/20',
        muted && 'text-muted-foreground/70',
      )}
    >
      {log ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? logId : undefined}
          // One clear name instead of the glyph, number, name and time as run-together fragments.
          aria-label={[`Step ${step.number}: ${step.name}`, tone.label, ...counts, duration]
            .filter(Boolean)
            .join(', ')}
          onClick={onToggle}
          className={cn(
            row,
            'group/step cursor-pointer outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60',
            open && !failed && 'bg-foreground/[0.03]',
          )}
        >
          {content}
        </button>
      ) : (
        <div className={row}>{content}</div>
      )}
      {log && open ? (
        <StepLog
          id={logId}
          stepName={step.name}
          state={log.state}
          githubUrl={log.githubUrl}
          failed={failed}
          onFix={log.fix ? () => setFixing(true) : undefined}
        />
      ) : null}
      {log?.fix && stepLog ? (
        <FixStepDialog
          project={log.fix.project}
          target={log.fix.target}
          log={stepLog}
          failed={failed}
          open={fixing}
          onOpenChange={setFixing}
        />
      ) : null}
    </li>
  );
}

function JobCard({
  job,
  open,
  onToggle,
  now,
  repo,
  project,
  run,
  isStepOpen,
  onToggleStep,
}: {
  job: GithubRunJob;
  open: boolean;
  onToggle: () => void;
  now: number;
  repo?: string;
  project?: Project;
  run?: RunFacts;
  isStepOpen: (step: GithubRunStep) => boolean;
  onToggleStep: (step: GithubRunStep, open: boolean) => void;
}): React.JSX.Element {
  const stepsId = useId();
  const tone = runTone(job);
  const duration = elapsed(job, now);
  // Read as soon as the job is open, so its steps show their error and warning counts.
  const jobLog = useJobLog(repo ?? '', job, open && Boolean(repo));

  function logSource(step: GithubRunStep): StepLogSource | undefined {
    if (!repo || !hasLog(step)) return undefined;
    const state: StepLogState =
      job.status !== 'completed'
        ? { kind: 'waiting' }
        : jobLog.isError
          ? { kind: 'error', reason: jobLog.error.message, retry: () => void jobLog.refetch() }
          : !jobLog.data
            ? { kind: 'loading' }
            : {
                kind: 'ready',
                log: jobLog.data.find((item) => item.number === step.number) ?? {
                  number: step.number,
                  lines: [],
                  errors: 0,
                  warnings: 0,
                },
              };
    return {
      state,
      githubUrl: job.htmlUrl ? `${job.htmlUrl}#step:${step.number}:1` : null,
      fix: project
        ? {
            project,
            target: {
              ...run,
              repo,
              jobId: job.id,
              jobName: job.name,
              stepNumber: step.number,
              stepName: step.name,
            },
          }
        : null,
    };
  }

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
              onClick={() => void window.runova.shell.openExternal(job.htmlUrl as string)}
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
              {job.steps.map((step) => {
                const stepOpen = isStepOpen(step);
                return (
                  <StepRow
                    key={step.number}
                    step={step}
                    now={now}
                    log={logSource(step)}
                    open={stepOpen}
                    onToggle={() => onToggleStep(step, !stepOpen)}
                  />
                );
              })}
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
 *
 * Given the repo, each step that ran also opens onto its own log, and a job's first failed step
 * starts open on it. Given the project too, a step that failed or warned can be fixed with AI.
 */
export function RunJobs({
  jobs,
  now,
  repo,
  project,
  run,
}: {
  jobs: GithubRunJob[];
  now?: number;
  repo?: string;
  project?: Project;
  run?: RunFacts;
}): React.JSX.Element {
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  const [chosenSteps, setChosenSteps] = useState<Record<string, boolean>>({});
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
        const firstFailed = job.steps.find(
          (step) => hasLog(step) && runTone(step).outcome === 'failed',
        );
        return (
          <JobCard
            key={job.id}
            job={job}
            open={open}
            now={clock}
            onToggle={() => setChosen((current) => ({ ...current, [job.id]: !open }))}
            repo={repo}
            project={project}
            run={run}
            isStepOpen={(step) =>
              chosenSteps[`${job.id}:${step.number}`] ?? step.number === firstFailed?.number
            }
            onToggleStep={(step, next) =>
              setChosenSteps((current) => ({ ...current, [`${job.id}:${step.number}`]: next }))
            }
          />
        );
      })}
    </ul>
  );
}
