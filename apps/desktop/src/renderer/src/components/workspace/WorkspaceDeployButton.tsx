import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CloudUpload, Spinner } from '@/components/icons';
import { READ_ONLY_HINT } from '@/components/projects/wordpress/WordPressProjectSection';
import {
  deployOutcome,
  PHASE_LABEL,
  PLANNED_PHASES,
} from '@/components/projects/wordpress/wordpressCopy';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { DeployFlowDialog } from '@/components/wordpress/DeployFlowDialog';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  findWordPressRun,
  listenForWordPressProgress,
  useWordPressOperationStore,
  type WordPressOperationRun,
} from '@/stores/wordpressOperationStore';

const SILENT = { silentLoading: true } as const;

/**
 * Deploy, in the Workspace header of a project linked to a WordPress site, where other projects
 * have Tag a version. It opens the same review and deploy as the project's WordPress tab, and
 * shows a deploy that is still going (or finished while the dialog was closed) so the user can
 * get back to it from here.
 *
 * A worktree's workspace deploys the linked project, so its main folder, not the worktree.
 */
export function WorkspaceDeployButton({
  projectId,
  projectName,
  siteId,
  inWorktree,
}: {
  /** The linked project (the parent, in a worktree's workspace). */
  projectId: string;
  projectName: string;
  siteId: string;
  inWorktree: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const run = useWordPressOperationStore((state) =>
    findWordPressRun(state.runs, { kind: 'deploy', projectId }),
  );
  const sitesQuery = useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: () => window.agentmat.deployWordPress.listSites(),
    meta: SILENT,
  });
  const site = sitesQuery.data?.find((candidate) => candidate.id === siteId) ?? null;
  const siteName = site?.label || site?.siteName || 'its site';

  // A deploy started from another window, or before a reload, only shows through its progress.
  useEffect(() => listenForWordPressProgress(), []);

  const siteGone = sitesQuery.isSuccess && site === null;
  const readOnly = site?.scope === 'read';
  const running = run?.status === 'running';
  const blocked = !running && (siteGone || readOnly);
  const finished = run && run.status !== 'running' ? finishedTone(run) : null;
  const progress = running ? runProgress(run) : null;

  const tip = blocked
    ? siteGone
      ? `${projectName}'s site isn't connected any more. Connect it again from the project's WordPress tab.`
      : READ_ONLY_HINT
    : running
      ? `Deploying to ${siteName}${progress ? `: ${progress.label}` : ''}. Click to see progress`
      : finished
        ? finished.tip
        : // A project made from a site takes the site's name, and "deploy Acme to Acme" reads badly.
          `Review and deploy ${projectName === siteName ? '' : `${projectName} `}to ${siteName}${
            inWorktree ? ", from the project's main folder, not this worktree" : ''
          }`;

  return (
    <>
      <SimpleTooltip label={tip} wrapTrigger={blocked} className="max-w-xs">
        <Button
          variant="tint"
          size="sm"
          className="relative h-8 gap-1.5 px-3"
          aria-label={
            running
              ? `Deploying to ${siteName}`
              : `Deploy to ${siteName}${finished ? `. Last deploy: ${finished.title}` : ''}`
          }
          aria-haspopup="dialog"
          disabled={blocked}
          onClick={() => setOpen(true)}
        >
          {running ? (
            <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          <span className="text-xs">{running ? 'Deploying' : 'Deploy'}</span>
          {running ? (
            // A bar, not a count, so the pill keeps its width while the numbers change and the
            // header buttons beside it stay where they are. The tooltip has the count.
            <span
              data-testid="deploy-progress"
              data-progress={progress?.percent ?? 0}
              className="absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full bg-primary/15"
              aria-hidden
            >
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </span>
          ) : null}
          {finished ? (
            <span
              data-testid="deploy-result-dot"
              data-result={finished.title}
              className={cn(
                'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background',
                finished.className,
              )}
              aria-hidden
            />
          ) : null}
        </Button>
      </SimpleTooltip>
      <DeployFlowDialog open={open} onOpenChange={setOpen} projectId={projectId} siteId={siteId} />
    </>
  );
}

const DEPLOY_STEPS = PLANNED_PHASES.deploy;

/**
 * The latest phase of a running deploy, with its count once it has one, and how far the whole
 * deploy has got: each planned step is an equal share, and the current one fills by its count.
 */
function runProgress(run: WordPressOperationRun): { label: string; percent: number } | null {
  const phase = run.phases.at(-1);
  if (!phase) return null;
  const step = run.progress[phase];
  const counted = step && step.total > 0 ? step : null;
  // A phase off the plan (a rollback) leaves the bar where the last planned one got it.
  const index = Math.max(...run.phases.map((seen) => DEPLOY_STEPS.indexOf(seen)));
  const within = DEPLOY_STEPS[index] === phase && counted ? counted.done / counted.total : 0;
  return {
    // Non-breaking spaces, so the tooltip never splits the count over two lines.
    label: counted
      ? `${PHASE_LABEL[phase]} (${counted.done} of ${counted.total})`
      : PHASE_LABEL[phase],
    percent:
      index < 0 ? 0 : Math.round(((index + Math.min(within, 1)) / DEPLOY_STEPS.length) * 100),
  };
}

/** How a deploy the user has not looked at yet ended: its dot, and what the tooltip says. */
function finishedTone(run: WordPressOperationRun): {
  title: string;
  tip: string;
  className: string;
} {
  if (run.status === 'failed') {
    return {
      title: 'Deploy failed',
      tip: 'The deploy failed. Click to see why',
      className: 'bg-destructive',
    };
  }
  const result = run.result?.kind === 'deploy' ? run.result.value : null;
  const outcome = result ? deployOutcome(result) : null;
  if (!outcome || outcome.tone === 'success') {
    return {
      title: 'Deployed',
      tip: 'The deploy finished. Click to see the result',
      className: 'bg-success',
    };
  }
  return {
    title: outcome.title,
    tip: `${outcome.title}. ${outcome.detail} Click to see more`,
    className: outcome.tone === 'error' ? 'bg-destructive' : 'bg-warning',
  };
}
