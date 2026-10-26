import type { Project } from '@runova/core';
import type { GithubActionsRunErrorInput } from '@shared/apiTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Spinner, Wand2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { RunStatusIcon, type RunTone } from '@/components/pipelines/runStatus';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { FixRunDialog } from './FixRunDialog';
import { PipelinesNotice } from './PipelinesNotice';
import type { PipelinesView } from './usePipelineStatus';

/** A run's outcome as a small tinted chip, live runs with a pulsing dot. */
export function RunChip({ tone }: { tone: RunTone }): React.JSX.Element {
  const live = tone.outcome === 'running' || tone.outcome === 'queued';
  const chipTone =
    tone.outcome === 'failed'
      ? 'destructive'
      : tone.warned || live
        ? 'warning'
        : tone.outcome === 'passed'
          ? 'success'
          : 'neutral';
  return (
    <Chip
      tone={chipTone}
      dot={live}
      pulse={tone.outcome === 'running'}
      className="h-[18px] px-1.5 text-[10px]"
    >
      {tone.label}
    </Chip>
  );
}

/**
 * GitHub Actions for the project: each workflow's latest run, failures first. A card opens that
 * pipeline's details. The data comes from the panel, which shares it with the larger view.
 */
export function PipelinesSection({
  project,
  view,
  retrying,
  onRetry,
  onOpenDetails,
}: {
  project: Project;
  view: PipelinesView;
  retrying: boolean;
  onRetry: () => void;
  onOpenDetails: (workflowId: number) => void;
}): React.JSX.Element {
  if (view.kind === 'loading') {
    return (
      <div data-testid="pipelines-loading" className="space-y-1 px-2 py-1.5">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" style={{ width: `${96 - i * 10}%` }} />
        ))}
      </div>
    );
  }
  if (view.kind === 'notice') {
    return <PipelinesNotice notice={view.notice} retrying={retrying} onRetry={onRetry} />;
  }

  return (
    <div className="min-h-0 flex-1 space-y-px overflow-y-auto py-1">
      {view.rows.map(({ workflow, run, tone }) => {
        const failed = tone?.outcome === 'failed' && run;
        return (
          <div
            key={workflow.id}
            className={cn(
              'group/run mx-1.5 rounded-lg transition-colors',
              failed
                ? 'bg-destructive/[0.05] ring-1 ring-inset ring-destructive/15'
                : 'hover:bg-foreground/[0.06]',
            )}
          >
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => onOpenDetails(workflow.id)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {tone ? (
                <RunStatusIcon tone={tone} className="h-6 w-6 shrink-0 rounded-md" />
              ) : (
                <span className="h-6 w-6 shrink-0 rounded-md bg-foreground/[0.06]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium">{workflow.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {run
                    ? `${run.displayTitle} · ${run.headBranch} · ${timeAgo(run.updatedAt)}`
                    : 'Never run'}
                </span>
              </span>
              {tone ? <RunChip tone={tone} /> : null}
            </button>
            {failed ? (
              <FailedRunActions
                project={project}
                run={{
                  repo: view.repo,
                  runId: run.id,
                  workflowName: workflow.name,
                  displayTitle: run.displayTitle,
                  runNumber: run.runNumber,
                  headBranch: run.headBranch,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Copy the failure, or hand it to an agent to fix. Also used by the Pull request tab's checks. */
export function FailedRunActions({
  project,
  run,
  className,
}: {
  project: Project;
  run: GithubActionsRunErrorInput;
  className?: string;
}): React.JSX.Element {
  const [fixing, setFixing] = useState(false);
  const [copying, setCopying] = useState(false);

  async function copy(): Promise<void> {
    setCopying(true);
    try {
      const result = await window.runova.pipelines.runError(run);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await navigator.clipboard.writeText(result.text);
      toast.success('Failure copied');
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={cn('flex items-center gap-1 pb-1.5 pl-[2.625rem] pr-2', className)}>
      <Button type="button" variant="tint" size="xs" onClick={() => setFixing(true)}>
        <Wand2 />
        Fix with AI
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void copy()}
        disabled={copying}
        className="text-muted-foreground"
      >
        {copying ? <Spinner className="animate-spin" /> : <Copy />}
        Copy error
      </Button>
      {fixing ? (
        <FixRunDialog project={project} run={run} open={fixing} onOpenChange={setFixing} />
      ) : null}
    </div>
  );
}
