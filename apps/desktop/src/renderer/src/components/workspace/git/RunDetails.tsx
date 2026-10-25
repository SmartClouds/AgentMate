import type { Project } from '@agentmat/core';
import type {
  GithubActionsRunErrorInput,
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
} from '@shared/apiTypes';
import { useEffect, useState } from 'react';
import {
  ChevronRight,
  CircleX,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommit,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { copyText, RunAnnotations, useRunAnnotations } from '@/components/pipelines/RunAnnotations';
import {
  isLiveRun,
  RunStatusIcon,
  runDuration,
  runTone,
  spanDuration,
} from '@/components/pipelines/runStatus';
import { StopRunButton } from '@/components/pipelines/StopRunButton';
import { useRunDetails } from '@/components/pipelines/useRunDetails';
import { useRunFailure } from '@/components/pipelines/useRunFailure';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PanelNotice } from './PanelNotice';
import { FailedRunActions, RunChip } from './PipelinesSection';
import { RunJobs, summarizeJobs } from './RunJobs';

const EVENT_LABEL: Record<string, string> = {
  workflow_dispatch: 'manual run',
  pull_request: 'pull request',
  pull_request_target: 'pull request',
  workflow_run: 'workflow run',
  repository_dispatch: 'API trigger',
  merge_group: 'merge queue',
};

function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? event.replace(/_/g, ' ');
}

/** The current time, ticking every second while `active`, so a running job's clock keeps moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** A one-line problem with a reason behind a tooltip and a way to try again. */
function InlineProblem({
  message,
  reason,
  onRetry,
}: {
  message: string;
  reason: string;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-xl bg-destructive/[0.05] px-3 py-2 text-xs ring-1 ring-inset ring-destructive/15"
    >
      <CircleX className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        <SimpleTooltip label={reason} className="max-w-sm" wrapTrigger>
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {message}
          </span>
        </SimpleTooltip>
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function JobsSection({
  repo,
  run,
  now,
}: {
  repo: string;
  run: GithubWorkflowRunInfo;
  now: number;
}): React.JSX.Element {
  const details = useRunDetails(repo, run, true);
  const jobs = details.data;

  return (
    <section aria-label="Jobs" className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className={SECTION_HEADING}>Jobs</h3>
        {jobs && jobs.length > 0 ? (
          <span className="text-[11px] text-muted-foreground">{summarizeJobs(jobs)}</span>
        ) : null}
      </div>
      {details.isError ? (
        <InlineProblem
          message="Could not load the jobs from GitHub."
          reason={details.error.message}
          onRetry={() => void details.refetch()}
        />
      ) : !jobs ? (
        <div data-testid="run-jobs-loading" className="space-y-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-11 rounded-xl" style={{ width: `${100 - i * 8}%` }} />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {isLiveRun(run) ? 'GitHub has not started any jobs yet.' : 'No jobs ran for this run.'}
        </p>
      ) : (
        <RunJobs jobs={jobs} now={now} />
      )}
    </section>
  );
}

function AnnotationsSection({
  repo,
  workflow,
  run,
}: {
  repo: string;
  workflow: GithubWorkflowInfo;
  run: GithubWorkflowRunInfo;
}): React.JSX.Element | null {
  const item = {
    id: run.id,
    repo,
    status: run.status,
    displayTitle: run.displayTitle,
    workflowName: workflow.name,
    runNumber: run.runNumber,
    headBranch: run.headBranch,
  };
  const annotations = useRunAnnotations(item, true);
  const data = annotations.data;
  if (!data?.ok || data.annotations.length === 0) return null;

  return (
    <section aria-label="Annotations" className="space-y-2">
      <h3 className={SECTION_HEADING}>Annotations</h3>
      <RunAnnotations run={item} annotations={data.annotations} counts={data.counts} flush />
    </section>
  );
}

/** The failed jobs' errors and the tail of their logs, read only once someone opens it. */
function FailureOutput({ input }: { input: GithubActionsRunErrorInput }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const failure = useRunFailure(input, open);

  return (
    <section aria-label="Failure output" className="space-y-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="group/fold flex cursor-pointer items-center gap-1.5 rounded-full py-1 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          <span className={cn(SECTION_HEADING, 'group-hover/fold:text-foreground/80')}>
            Failure output
          </span>
        </button>
        {open && failure.data ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            aria-label="Copy failure output"
            onClick={() => void copyText(failure.data, 'Failure output copied.')}
          >
            <Copy />
            Copy
          </Button>
        ) : null}
      </div>
      {!open ? null : failure.isError ? (
        <InlineProblem
          message="Could not read the failure."
          reason={failure.error.message}
          onRetry={() => void failure.refetch()}
        />
      ) : failure.data === undefined ? (
        <div data-testid="run-failure-loading" className="space-y-1.5">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-3.5 rounded" style={{ width: `${96 - i * 14}%` }} />
          ))}
        </div>
      ) : (
        <pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap break-words rounded-xl bg-foreground/[0.04] p-3 font-mono text-[11px] leading-relaxed ring-1 ring-inset ring-foreground/[0.08]">
          {failure.data}
        </pre>
      )}
    </section>
  );
}

function RunFacts({ run, now }: { run: GithubWorkflowRunInfo; now: number }): React.JSX.Element {
  const live = isLiveRun(run);
  const span = live ? spanDuration(run.createdAt, null, now) : runDuration(run);
  const timing = `Started ${timeAgo(run.createdAt)}${
    span ? ` · ${live ? 'running for' : 'took'} ${span}` : ''
  }`;

  return (
    <div className="space-y-1">
      <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
        {run.headBranch ? (
          <li className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{run.headBranch}</span>
          </li>
        ) : null}
        <li>{`#${run.runNumber}`}</li>
        {(run.runAttempt ?? 1) > 1 ? <li>{`Attempt ${run.runAttempt}`}</li> : null}
        {run.event ? <li>{eventLabel(run.event)}</li> : null}
        {run.actor ? <li>{`by ${run.actor}`}</li> : null}
        {run.headSha ? (
          <li className="flex items-center gap-1">
            <GitCommit className="h-3 w-3" />
            <SimpleTooltip label={run.headSha}>
              <span className="font-mono">{run.headSha.slice(0, 7)}</span>
            </SimpleTooltip>
          </li>
        ) : null}
      </ul>
      <SimpleTooltip label={new Date(run.createdAt).toLocaleString()} side="bottom" align="start">
        <p className="w-fit text-[11px] text-muted-foreground">{timing}</p>
      </SimpleTooltip>
    </div>
  );
}

/**
 * Everything about one pipeline's latest run: what it ran for and how it ended, each job with its
 * steps, what the jobs flagged, and (for a failure) the output that explains it.
 */
export function RunDetails({
  project,
  repo,
  workflow,
  run,
}: {
  project: Project;
  repo: string;
  workflow: GithubWorkflowInfo;
  run: GithubWorkflowRunInfo | null;
}): React.JSX.Element {
  const live = run ? isLiveRun(run) : false;
  const now = useNow(live);

  if (!run) {
    return (
      <section
        aria-label={`${workflow.name} details`}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <div className="p-5">
          <h2 className="break-words text-base font-semibold">{workflow.name}</h2>
          <PanelNotice
            title="Never run"
            body="This pipeline has not run yet."
            action={{
              label: 'Open workflow on GitHub',
              run: () => void window.agentmat.shell.openExternal(workflow.htmlUrl),
            }}
          />
        </div>
      </section>
    );
  }

  const tone = runTone(run);
  const failureInput: GithubActionsRunErrorInput = {
    repo,
    runId: run.id,
    workflowName: workflow.name,
    displayTitle: run.displayTitle,
    runNumber: run.runNumber,
    headBranch: run.headBranch,
  };

  return (
    <section
      aria-label={`${workflow.name} details`}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl space-y-6 p-5">
        <header className="space-y-3">
          <div className="flex items-start gap-3">
            <RunStatusIcon tone={tone} className="h-9 w-9 rounded-xl" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words text-base font-semibold">{workflow.name}</h2>
                <RunChip tone={tone} />
              </div>
              <p className="break-words text-sm text-foreground/90">{run.displayTitle}</p>
            </div>
          </div>
          <RunFacts run={run} now={now} />
          <div className="flex flex-wrap items-center gap-1.5">
            {tone.outcome === 'failed' ? (
              <FailedRunActions project={project} run={failureInput} className="p-0" />
            ) : null}
            {live ? (
              <StopRunButton
                item={{
                  id: run.id,
                  repo,
                  workflowName: workflow.name,
                  runNumber: run.runNumber,
                }}
                className="h-6 px-2 text-[11px]"
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => void window.agentmat.shell.openExternal(run.htmlUrl)}
            >
              <ExternalLink />
              Open run on GitHub
            </Button>
          </div>
        </header>

        <JobsSection repo={repo} run={run} now={now} />
        <AnnotationsSection repo={repo} workflow={workflow} run={run} />
        {tone.outcome === 'failed' ? <FailureOutput input={failureInput} /> : null}
      </div>
    </section>
  );
}
