import type { Project } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { ExternalLink, GitPullRequest, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PrSurfaceLeaveContext } from './PrCard';
import { PullRequestSection } from './PullRequestSection';

/**
 * The Pull request section with room to breathe: the same cards and the same live data as the
 * panel, laid out wide. Anything in it that points back at the panel closes it first.
 */
export function PullRequestDialog({
  project,
  open,
  onOpenChange,
  status,
  loading,
  fetching,
  onRetry,
  onNewBranch,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: PullRequestStatus | undefined;
  loading: boolean;
  fetching: boolean;
  onRetry: () => void;
  onNewBranch: () => void;
}): React.JSX.Element {
  const close = (): void => onOpenChange(false);
  const pr = status?.pr;
  const repo = status?.github ? `${status.github.owner}/${status.github.repo}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        tabIndex={-1}
        // Focus the dialog itself: landing on the first toolbar button would pop its tooltip.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        className="flex h-[min(56rem,88vh)] max-h-[88vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0 outline-none sm:rounded-2xl"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 pl-5 pr-14 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <GitPullRequest className="h-3.5 w-3.5" />
          </span>
          <DialogTitle className="text-sm font-semibold">Pull request</DialogTitle>
          {repo ? (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{repo}</span>
          ) : null}
          <DialogDescription className="sr-only">
            Create, review and merge the pull request for {status?.branch ?? 'this branch'}.
          </DialogDescription>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <SimpleTooltip label="Refresh from GitHub">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh from GitHub"
                onClick={onRetry}
                disabled={fetching}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    fetching && 'animate-spin motion-reduce:animate-none',
                  )}
                />
              </Button>
            </SimpleTooltip>
            {pr ? (
              <SimpleTooltip label="Open on GitHub">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open on GitHub"
                  onClick={() => void window.runova.shell.openExternal(pr.url)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </SimpleTooltip>
            ) : null}
          </div>
        </div>
        <PrSurfaceLeaveContext.Provider value={close}>
          <div className="flex min-h-0 flex-1 flex-col">
            <PullRequestSection
              project={project}
              status={status}
              loading={loading}
              onRetry={onRetry}
              onNewBranch={() => {
                close();
                onNewBranch();
              }}
              wide
            />
          </div>
        </PrSurfaceLeaveContext.Provider>
      </DialogContent>
    </Dialog>
  );
}
