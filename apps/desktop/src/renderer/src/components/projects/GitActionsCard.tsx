import type { ProjectGithubAction } from '@runova/core';
import type { GithubWorkflowInfo, GithubWorkflowRunInfo } from '@shared/apiTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  ExternalLink,
  Github,
  Play,
  RefreshCw,
  Spinner,
  StopCircle,
  TriangleAlert,
} from '@/components/icons';
import { CopyRunErrorButton } from '@/components/pipelines/CopyRunErrorButton';
import { RunWorkflowDialog } from '@/components/projects/RunWorkflowDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshFailureBell, refreshTooltip } from '@/components/ui/refresh-failure-bell';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useLastGoodData } from '@/hooks/useLastGoodData';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useTerminalStore } from '@/stores/terminalStore';

const GH_INSTALL_URL = 'https://cli.github.com/';
const QUERY_META = { silentLoading: true } as const;
/** A dispatched run takes a moment to show up in the API, so refresh again shortly after. */
const SETTLE_MS = 3000;

function runTone(run: GithubWorkflowRunInfo | null | undefined): {
  label: string;
  variant: 'success' | 'destructive' | 'warning' | 'outline';
} {
  if (!run) return { label: 'Never run', variant: 'outline' };
  if (run.status !== 'completed') {
    if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') {
      return { label: 'Queued', variant: 'warning' };
    }
    return { label: 'Running', variant: 'warning' };
  }
  if (run.conclusion === 'success') return { label: 'Passing', variant: 'success' };
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    return { label: 'Failed', variant: 'destructive' };
  }
  if (run.conclusion === 'cancelled') return { label: 'Cancelled', variant: 'outline' };
  if (run.conclusion === 'skipped') return { label: 'Skipped', variant: 'outline' };
  return { label: run.conclusion ?? 'Completed', variant: 'outline' };
}

function workflowFileName(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] || path;
}

export function GitActionsCard({
  projectId,
  muted,
}: {
  projectId: string;
  muted: ProjectGithubAction[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const openSession = useTerminalStore((s) => s.openSession);

  const statusQuery = useQuery({
    queryKey: queryKeys.pipelineStatus(projectId),
    queryFn: () => window.runova.pipelines.status(projectId),
    refetchInterval: 30_000,
    meta: QUERY_META,
  });

  const watchMutation = useMutation({
    mutationFn: (actions: ProjectGithubAction[]) =>
      window.runova.pipelines.setMuted(projectId, actions),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.pipelineStatus(projectId), status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not update watched workflows.');
    },
  });

  // A failed refresh keeps the workflows that last loaded on screen and flags it on Refresh.
  const lastGood = useLastGoodData({
    storageKey: `pipeline-status:${projectId}`,
    query: statusQuery,
    failureOf: (result) => result.error,
    title: 'Could not refresh GitHub Actions',
  });

  const status = lastGood.data;
  const repo = status?.github ? `${status.github.owner}/${status.github.repo}` : '';
  // While the save is in flight the switch should already show where it was dragged to.
  const effectiveMuted =
    watchMutation.isPending && watchMutation.variables ? watchMutation.variables : muted;
  const mutedIds = new Set(effectiveMuted.map((item) => item.workflowId));

  function refreshSoon(): void {
    void statusQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.githubActionsActivity });
    setTimeout(() => {
      void statusQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: queryKeys.githubActionsActivity });
    }, SETTLE_MS);
  }

  const cancelMutation = useMutation({
    mutationFn: (runId: number) => window.runova.pipelines.cancelRun({ repo, runId }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Asked GitHub to stop that run.');
      refreshSoon();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not stop that run.');
    },
  });

  async function handleStop(
    workflow: GithubWorkflowInfo,
    run: GithubWorkflowRunInfo,
  ): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Stop ${workflow.name}?`,
      description: `Run #${run.runNumber} on ${run.headBranch || 'this branch'} will be cancelled. Jobs already finished stay as they are.`,
      confirmLabel: 'Stop run',
      variant: 'destructive',
    });
    if (confirmed) cancelMutation.mutate(run.id);
  }

  function handleInstallGh(): void {
    void window.runova.shell.openExternal(GH_INSTALL_URL);
  }

  function handleSignIn(): void {
    openSession({ title: 'GitHub login', initialInput: 'gh auth login' });
    toast.info('Press Enter in the terminal to sign in to GitHub.');
  }

  function toggleWatch(workflow: GithubWorkflowInfo, enabled: boolean): void {
    const next = enabled
      ? effectiveMuted.filter((item) => item.workflowId !== workflow.id)
      : [
          ...effectiveMuted.filter((item) => item.workflowId !== workflow.id),
          { workflowId: workflow.id, path: workflow.path, name: workflow.name },
        ];
    watchMutation.mutate(next);
  }

  return (
    <div className="glass space-y-3 rounded-[calc(var(--radius)+2px)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Github className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">GitHub Actions</p>
            <p className="text-xs text-muted-foreground">
              Every workflow in this repo is watched, and failures go to Notifications. Switch one
              off to stop hearing about it.
            </p>
          </div>
        </div>
        <SimpleTooltip
          label={
            lastGood.failure
              ? refreshTooltip('Refresh', lastGood.failure, lastGood.savedAt)
              : undefined
          }
          className="max-w-sm"
        >
          <span className="relative inline-flex">
            <Button
              variant="outline"
              size="sm"
              disabled={statusQuery.isFetching}
              onClick={lastGood.refresh}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <RefreshFailureBell failure={lastGood.failure} />
          </span>
        </SimpleTooltip>
      </div>

      {statusQuery.isPending && !status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-3.5 w-3.5 animate-spin" />
          Reading workflows…
        </div>
      ) : status?.error ? (
        <div className="rounded-xl bg-foreground/[0.03] px-3 py-4 text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
          <p>{status.error}</p>
          {!status.cliAvailable ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={handleInstallGh}>
              Install GitHub CLI
            </Button>
          ) : !status.authenticated ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={handleSignIn}>
              Sign in with gh
            </Button>
          ) : null}
        </div>
      ) : !status || status.workflows.length === 0 ? (
        <p className="rounded-xl bg-foreground/[0.03] px-3 py-4 text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
          No GitHub Actions workflows in this repository yet.
        </p>
      ) : (
        <div className="space-y-1.5">
          {status.workflows.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              repo={repo}
              projectId={projectId}
              run={status.runsByWorkflowId[workflow.id]}
              watched={!mutedIds.has(workflow.id)}
              pending={watchMutation.isPending}
              stopping={cancelMutation.isPending}
              onToggle={(enabled) => toggleWatch(workflow, enabled)}
              onStop={(run) => void handleStop(workflow, run)}
              onStarted={refreshSoon}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow,
  repo,
  projectId,
  run,
  watched,
  pending,
  stopping,
  onToggle,
  onStop,
  onStarted,
}: {
  workflow: GithubWorkflowInfo;
  repo: string;
  projectId: string;
  run: GithubWorkflowRunInfo | null | undefined;
  watched: boolean;
  pending: boolean;
  stopping: boolean;
  onToggle: (enabled: boolean) => void;
  onStop: (run: GithubWorkflowRunInfo) => void;
  onStarted: () => void;
}): React.JSX.Element {
  const [runOpen, setRunOpen] = useState(false);
  const tone = runTone(run);
  const running = run != null && run.status !== 'completed';
  const failed = tone.variant === 'destructive';

  return (
    <div
      className={cn(
        // Rings, not border colours, which the theme's global border rule would override.
        'flex items-center gap-3 rounded-xl px-3 py-2.5',
        watched
          ? 'bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]'
          : 'ring-1 ring-inset ring-foreground/[0.05]',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
          tone.variant === 'success' && 'bg-success/15 text-success',
          tone.variant === 'destructive' && 'bg-destructive/15 text-destructive',
          tone.variant === 'warning' && 'bg-warning/15 text-warning',
          tone.variant === 'outline' && 'bg-foreground/[0.06] text-muted-foreground',
        )}
      >
        {running ? (
          <Spinner className="h-3.5 w-3.5 animate-spin" />
        ) : tone.variant === 'success' ? (
          <CircleCheck className="h-3.5 w-3.5" />
        ) : tone.variant === 'destructive' ? (
          <TriangleAlert className="h-3.5 w-3.5" />
        ) : (
          <Github className="h-3.5 w-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{workflow.name}</p>
          <Badge variant={tone.variant} className="shrink-0">
            {tone.label}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          <span className="font-mono">{workflowFileName(workflow.path)}</span>
          {run?.headBranch ? ` · ${run.headBranch}` : ''}
          {run?.updatedAt ? ` · ${timeAgo(run.updatedAt)}` : ''}
          {watched ? '' : ' · not watched'}
        </p>
      </div>
      {running && run ? (
        <SimpleTooltip label="Stop this run">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 hover:text-destructive"
            disabled={stopping || !repo}
            onClick={() => onStop(run)}
            aria-label={`Stop ${workflow.name}`}
          >
            <StopCircle className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      ) : workflow.dispatchable && repo ? (
        <SimpleTooltip label="Run this workflow now">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => setRunOpen(true)}
            aria-label={`Run ${workflow.name}`}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      ) : null}
      {failed && run && repo ? (
        <CopyRunErrorButton
          iconOnly
          input={{
            repo,
            runId: run.id,
            workflowName: workflow.name,
            displayTitle: run.displayTitle,
            runNumber: run.runNumber,
            headBranch: run.headBranch,
          }}
        />
      ) : null}
      {repo ? (
        <RunWorkflowDialog
          open={runOpen}
          onOpenChange={setRunOpen}
          repo={repo}
          workflow={workflow}
          projectId={projectId}
          onStarted={onStarted}
        />
      ) : null}
      {run?.htmlUrl ? (
        <SimpleTooltip label="Open this run on GitHub">
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => void window.runova.shell.openExternal(run.htmlUrl)}
            aria-label="Open run on GitHub"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      ) : null}
      <SimpleTooltip label={watched ? 'Stop watching this pipeline' : 'Watch this pipeline again'}>
        <div className="shrink-0">
          <Switch
            checked={watched}
            disabled={pending}
            onCheckedChange={onToggle}
            aria-label={watched ? `Stop watching ${workflow.name}` : `Watch ${workflow.name}`}
          />
        </div>
      </SimpleTooltip>
    </div>
  );
}
