import type { Project } from '@agentmat/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ExternalLink, Github, RefreshCw } from '@/components/icons';
import { RunStatusIcon } from '@/components/pipelines/runStatus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { PipelinesNotice } from './PipelinesNotice';
import { RunChip } from './PipelinesSection';
import { RunDetails } from './RunDetails';
import type { PipelineRow, PipelinesState } from './usePipelineStatus';

function LoadingPanes(): React.JSX.Element {
  return (
    <div
      data-testid="pipelines-dialog-loading"
      className="flex min-h-0 flex-1 flex-col md:flex-row"
    >
      <div className="space-y-1.5 p-3 md:w-72 md:shrink-0">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-11 rounded-lg" />
        ))}
      </div>
      <div className="flex-1 space-y-3 p-5">
        <Skeleton className="h-9 w-2/3 rounded-xl" />
        <Skeleton className="h-4 w-1/2 rounded" />
        <Skeleton className="h-11 rounded-xl" />
        <Skeleton className="h-11 w-[92%] rounded-xl" />
      </div>
    </div>
  );
}

function PipelineButton({
  row,
  selected,
  onSelect,
}: {
  row: PipelineRow;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const { workflow, run, tone } = row;
  const failed = tone?.outcome === 'failed';
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
        // Rings, not borders: the theme's global border colour would hide the tint.
        selected
          ? failed
            ? 'bg-destructive/[0.09] ring-1 ring-inset ring-destructive/30'
            : 'bg-foreground/[0.09] ring-1 ring-inset ring-foreground/[0.14]'
          : failed
            ? 'bg-destructive/[0.04] ring-1 ring-inset ring-destructive/15 hover:bg-destructive/[0.07]'
            : 'hover:bg-foreground/[0.06]',
      )}
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
  );
}

/** What is inside the dialog once it is open. Mounted only while open, so the selection resets. */
function PipelinesBody({
  project,
  state,
  initialWorkflowId,
  onLeave,
}: {
  project: Project;
  state: PipelinesState;
  initialWorkflowId: number | null;
  onLeave: () => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(initialWorkflowId);
  const { view } = state;

  if (view.kind === 'loading') return <LoadingPanes />;
  if (view.kind === 'notice') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <div className="w-full max-w-md">
          <PipelinesNotice
            notice={view.notice}
            retrying={state.retrying}
            onRetry={state.retry}
            onLeave={onLeave}
          />
        </div>
      </div>
    );
  }

  // The selected pipeline can vanish between refreshes (a workflow file was deleted).
  const selected = view.rows.find((row) => row.workflow.id === selectedId) ?? view.rows[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="Pipelines"
        className="max-h-44 shrink-0 overflow-y-auto p-2 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)] md:max-h-none md:w-72 md:shadow-[inset_-1px_0_0_hsl(var(--border)/0.6)]"
      >
        <ul className="space-y-0.5">
          {view.rows.map((row) => (
            <li key={row.workflow.id}>
              <PipelineButton
                row={row}
                selected={row === selected}
                onSelect={() => setSelectedId(row.workflow.id)}
              />
            </li>
          ))}
        </ul>
      </nav>
      {selected ? (
        <RunDetails
          // A new run of the same pipeline starts afresh instead of inheriting what was folded.
          key={`${selected.workflow.id}:${selected.run?.id ?? 'none'}`}
          project={project}
          repo={view.repo}
          workflow={selected.workflow}
          run={selected.run}
        />
      ) : null}
    </div>
  );
}

/**
 * The Pipelines section with room to breathe: every pipeline on the left, and on the right the
 * jobs and steps of the one picked. It shares the panel's data, so the two never disagree.
 */
export function PipelinesDialog({
  project,
  open,
  onOpenChange,
  state,
  workflowId,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: PipelinesState;
  /** The pipeline to open on, or null for the first one. */
  workflowId: number | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const repo = state.view.kind === 'ready' ? state.view.repo : null;

  function refresh(): void {
    state.refresh();
    void queryClient.invalidateQueries({ queryKey: queryKeys.runDetailsAll });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        tabIndex={-1}
        // Focus the dialog itself: landing on the first toolbar button would pop its tooltip.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="flex h-[min(52rem,88vh)] max-h-[88vh] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 outline-none sm:rounded-2xl"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 pl-5 pr-14 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Github className="h-3.5 w-3.5" />
          </span>
          <DialogTitle className="text-sm font-semibold">Pipelines</DialogTitle>
          {repo ? (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{repo}</span>
          ) : null}
          <DialogDescription className="sr-only">
            The pipelines of this project, with the jobs and steps of each one's latest run.
          </DialogDescription>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <SimpleTooltip label="Refresh from GitHub">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh from GitHub"
                onClick={refresh}
                disabled={state.fetching}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    state.fetching && 'animate-spin motion-reduce:animate-none',
                  )}
                />
              </Button>
            </SimpleTooltip>
            {repo ? (
              <SimpleTooltip label="Open Actions on GitHub">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open Actions on GitHub"
                  onClick={() =>
                    void window.agentmat.shell.openExternal(`https://github.com/${repo}/actions`)
                  }
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </SimpleTooltip>
            ) : null}
          </div>
        </div>
        <PipelinesBody
          project={project}
          state={state}
          initialWorkflowId={workflowId}
          onLeave={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
