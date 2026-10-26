import { type PullRequestInfo, summarizeChecks } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/** What on an open PR is waiting on the user: failed checks plus unresolved threads. */
export function pullRequestAttention(pr: PullRequestInfo | null | undefined): {
  count: number;
  failing: boolean;
} {
  if (!pr || pr.state !== 'OPEN') return { count: 0, failing: false };
  const failed = summarizeChecks(pr.checks).failed;
  const open = pr.threads.filter((thread) => !thread.isResolved).length;
  return { count: failed + open, failing: failed > 0 };
}

/**
 * `#42` next to the branch name, coloured by the PR's checks and review, or "Create PR" once the
 * branch is published without one. Reads whatever the Pull request tab last loaded, so it never
 * starts a gh call of its own.
 */
export function BranchPrPill({ projectId }: { projectId: string }): React.JSX.Element | null {
  const revealPanelSection = useWorkspaceStore((s) => s.revealPanelSection);
  const { data } = useQuery<PullRequestStatus>({
    queryKey: queryKeys.pullRequest(projectId),
    queryFn: () => window.runova.pullRequests.status(projectId),
    enabled: false,
  });
  const pr = data?.pr;
  if (!pr) {
    // A published branch with no PR yet: the next step is opening one.
    const ready =
      data?.github &&
      data.authenticated &&
      data.branch &&
      !data.onDefaultBranch &&
      data.hasUpstream &&
      !data.error;
    if (!ready) return null;
    return (
      <SimpleTooltip label={`${data.branch} is published. Click to open a pull request for it`}>
        <button
          type="button"
          onClick={() => revealPanelSection('pullRequest')}
          className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-primary/12 px-2 text-[10.5px] font-semibold text-primary ring-1 ring-inset ring-primary/25 transition-colors hover:bg-primary/20"
        >
          <GitPullRequest className="h-2.5 w-2.5" />
          Create PR
        </button>
      </SimpleTooltip>
    );
  }
  const { failing } = pullRequestAttention(pr);
  const running = pr.state === 'OPEN' && summarizeChecks(pr.checks).running > 0;
  const changesRequested = pr.reviewDecision === 'CHANGES_REQUESTED';
  const label =
    pr.state === 'MERGED'
      ? 'merged'
      : pr.state === 'CLOSED'
        ? 'closed'
        : failing
          ? 'checks failing'
          : running
            ? 'checks running'
            : changesRequested
              ? 'changes requested'
              : pr.isDraft
                ? 'draft'
                : pr.reviewDecision === 'APPROVED'
                  ? 'approved'
                  : pr.reviewDecision === 'REVIEW_REQUIRED'
                    ? 'waiting for review'
                    : 'open';

  return (
    <SimpleTooltip label={`Pull request #${pr.number}, ${label}. Click to open the pull request`}>
      <button
        type="button"
        onClick={() => revealPanelSection('pullRequest')}
        className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-foreground/[0.06] px-2 text-[10.5px] font-medium tabular-nums transition-colors hover:bg-foreground/[0.1]"
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            pr.state === 'MERGED'
              ? 'bg-primary'
              : pr.state === 'CLOSED' || failing
                ? 'bg-destructive'
                : running || changesRequested
                  ? 'bg-warning'
                  : pr.isDraft
                    ? 'bg-muted-foreground'
                    : 'bg-success',
          )}
        />
        <GitPullRequest className="h-2.5 w-2.5 text-muted-foreground" />#{pr.number}
      </button>
    </SimpleTooltip>
  );
}
