import type { WpDeployRecord, WpDeployState } from '@runova/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { wordPressErrorCode } from '@shared/wordpressErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  CircleCheck,
  CircleX,
  Clock,
  History,
  Minus,
  RefreshCw,
  Spinner,
  Undo,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { DeployCard } from '../deployKit';
import { SetupFailure } from '../SetupFailure';
import { newOperationId, useOperationProgress, useSiteHistory } from './hooks';
import {
  DEPLOY_STATE_DETAIL,
  DEPLOY_STATE_LABEL,
  progressText,
  ROLLBACK_REASON,
  SCOPE_SUMMARY,
  siteTimeText,
  wpProblem,
} from './messages';

const STATE_TONE: Record<WpDeployState, { icon: typeof CircleCheck; tone: string }> = {
  open: { icon: Clock, tone: 'text-primary' },
  applying: { icon: Clock, tone: 'text-primary' },
  applied: { icon: Clock, tone: 'text-primary' },
  done: { icon: CircleCheck, tone: 'text-success' },
  rolledBack: { icon: Undo, tone: 'text-warning' },
  aborted: { icon: Minus, tone: 'text-muted-foreground' },
  expired: { icon: CircleX, tone: 'text-muted-foreground' },
};

/** Only applied or finished deploys have files to put back. */
function rollbackable(record: WpDeployRecord): boolean {
  return record.state === 'done' || record.state === 'applied';
}

function changeCount(record: WpDeployRecord): string {
  const parts = [
    record.puts > 0 ? `${record.puts} ${record.puts === 1 ? 'file' : 'files'} written` : null,
    record.deletes > 0
      ? `${record.deletes} ${record.deletes === 1 ? 'file' : 'files'} deleted`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'No file changes';
}

function rollbackOffReason(
  site: DeployWordPressSite,
  record: WpDeployRecord,
  busy: boolean,
): string | null {
  if (site.scope === 'read') return SCOPE_SUMMARY.read;
  if (busy) return 'Another rollback is running.';
  if (!record.canRollback) {
    return "The site can't put this deploy back: its snapshot is gone (the last five are kept), or the files it wrote changed since.";
  }
  return null;
}

/**
 * Deploys to this site, newest first, with what became of each: still running, live, rolled back
 * and why, or dropped. A deploy whose snapshot the site still keeps can be rolled back from here.
 */
export function SiteDeploysPanel({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const queryClient = useQueryClient();
  const historyQuery = useSiteHistory(site.id);
  const [running, setRunning] = useState<{ deployId: string; operationId: string } | null>(null);
  const progress = useOperationProgress(running?.operationId ?? null);

  async function run(record: WpDeployRecord, force: boolean): Promise<void> {
    const operationId = newOperationId();
    setRunning({ deployId: record.deployId, operationId });
    let retryForced = false;
    try {
      const result = await window.runova.deployWordPress.rollback({
        operationId,
        siteId: site.id,
        deployId: record.deployId,
        ...(force ? { force: true } : {}),
      });
      if (!result || result.state === 'rolledBack') {
        toast.success('Rolled back. The files are as they were before that deploy.');
      } else {
        toast.warning(
          `The rollback ended as "${DEPLOY_STATE_LABEL[result.state]}". ${DEPLOY_STATE_DETAIL[result.state]}`,
        );
      }
    } catch (error) {
      if (!force && wordPressErrorCode(error) === 'conflict') {
        retryForced = await confirmDialog({
          title: 'Files changed since this deploy',
          description:
            'Some files this deploy wrote were changed on the site afterwards. Rolling back anyway puts the old versions back over those changes.',
          warning: 'Changes made on the site since the deploy will be lost.',
          confirmLabel: 'Roll back anyway',
          variant: 'destructive',
        });
      } else {
        toast.error(wpProblem(error));
      }
    } finally {
      setRunning(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressHistory(site.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSiteInfo(site.id) });
    }
    if (retryForced) await run(record, true);
  }

  async function rollBack(record: WpDeployRecord): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Roll back this deploy?',
      description: `The files it changed go back to how they were before it (${changeCount(record).toLowerCase()}). Nothing else on the site is touched.`,
      items: [{ name: record.label || 'Untitled deploy', detail: siteTimeText(record.startedAt) }],
      confirmLabel: 'Roll back',
      variant: 'destructive',
    });
    if (confirmed) await run(record, false);
  }

  let body: React.ReactNode;
  if (historyQuery.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  } else if (historyQuery.isError) {
    body = (
      <div className="space-y-3">
        <SetupFailure message={wpProblem(historyQuery.error)} />
        <Button
          size="sm"
          variant="soft"
          disabled={historyQuery.isFetching}
          onClick={() => void historyQuery.refetch()}
        >
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  } else if (historyQuery.data.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        Nothing has been deployed to this site yet. Deploys start from a WordPress project.
      </p>
    );
  } else {
    body = (
      <ul aria-label="Deploys" className="settings-rows">
        {historyQuery.data.map((record) => {
          const { icon: Icon, tone } = STATE_TONE[record.state];
          const mine = running?.deployId === record.deployId;
          const off = rollbackable(record)
            ? rollbackOffReason(site, record, running !== null)
            : null;
          return (
            <li key={record.deployId} className="flex flex-wrap items-start gap-3 py-3">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="break-words text-sm font-medium text-foreground">
                  {record.label || 'Untitled deploy'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {siteTimeText(record.startedAt)}
                  {record.connectionLabel ? `, from ${record.connectionLabel}` : ''}.{' '}
                  {changeCount(record)}.
                </p>
                <p className="text-xs text-foreground">
                  <span className={cn('font-medium', tone)}>
                    {DEPLOY_STATE_LABEL[record.state]}.
                  </span>{' '}
                  {record.state === 'rolledBack' && record.reason
                    ? ROLLBACK_REASON[record.reason]
                    : DEPLOY_STATE_DETAIL[record.state]}
                </p>
                {mine && (
                  <p role="status" className="flex items-center gap-1.5 text-xs text-primary">
                    <Spinner className="h-3 w-3 motion-safe:animate-spin" />
                    {progress ? progressText(progress) : 'Rolling back'}
                  </p>
                )}
              </div>
              {rollbackable(record) && (
                <SimpleTooltip label={off} wrapTrigger>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={off !== null}
                    aria-label={`Roll back ${record.label || 'this deploy'}`}
                    onClick={() => void rollBack(record)}
                  >
                    {mine ? <Spinner className="motion-safe:animate-spin" /> : <Undo />}
                    Roll back
                  </Button>
                </SimpleTooltip>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <DeployCard
      icon={<History />}
      title="Deploys"
      description="Every deploy takes a snapshot first, and a deploy that breaks the site is rolled back on its own. The site keeps the last five snapshots for a manual rollback."
      actions={
        <Button
          size="sm"
          variant="soft"
          disabled={historyQuery.isFetching}
          onClick={() => void historyQuery.refetch()}
        >
          <RefreshCw /> Refresh
        </Button>
      }
    >
      {body}
    </DeployCard>
  );
}
