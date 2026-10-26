import type { GithubActionsHistoryItem } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Spinner, StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

/** Cancels a queued or in-progress run. Shared by the dashboard card and the Pipelines page. */
export function StopRunButton({
  item,
  className,
}: {
  item: Pick<GithubActionsHistoryItem, 'id' | 'repo' | 'workflowName' | 'runNumber'>;
  className?: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function stopRun(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Stop ${item.workflowName}?`,
      description: `Run #${item.runNumber} on ${item.repo} will be cancelled. Jobs already finished stay as they are.`,
      confirmLabel: 'Stop run',
      variant: 'destructive',
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await window.runova.pipelines.cancelRun({ repo: item.repo, runId: item.id });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Asked GitHub to stop that run.');
      // GitHub takes a moment to flip the run to cancelled, so give it one beat first.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.githubActionsActivity });
      }, 3000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not stop that run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SimpleTooltip label="Stop this run">
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-8 shrink-0 gap-1 px-2 hover:text-destructive', className)}
        disabled={busy}
        aria-label="Stop run"
        onClick={() => void stopRun()}
      >
        {busy ? (
          <Spinner className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <StopCircle className="h-3.5 w-3.5" />
        )}
        Stop
      </Button>
    </SimpleTooltip>
  );
}
