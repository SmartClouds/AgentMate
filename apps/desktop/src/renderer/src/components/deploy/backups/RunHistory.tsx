import { coreErrorMessage } from '@shared/coreErrors';
import { backupSize } from '@shared/deploy/backupSchedule';
import type {
  BackupRunInfo,
  BackupRunTargetInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { History } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  CARD_BODY,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
  TABLE_CELL,
  TABLE_HEAD,
} from '../security/SecurityCard';
import { dateAndTime, RUN_STATE, runLabel, TARGET_STATE } from './format';
import { useBackupRuns } from './hooks';

/**
 * One destination's outcome, with the reason on hover when it failed. A failed try before the last
 * leaves it waiting for the next one, which the core makes 30 seconds and then 5 minutes later.
 */
export function TargetChip({ target }: { target: BackupRunTargetInfo }): React.JSX.Element {
  const retrying = target.state === 'pending' && target.attempts > 0;
  const state = retrying
    ? { label: 'Retrying', tone: 'warning' as const }
    : TARGET_STATE[target.state];
  const pruned = target.pruned > 0 ? `, ${target.pruned} old removed` : '';
  const chip = (
    <Chip tone={state.tone} dot pulse={target.state === 'uploading'}>
      {target.destinationName}: {state.label}
      {pruned}
    </Chip>
  );
  const why = target.error
    ? `${target.error}${target.attempts > 1 ? ` (after ${target.attempts} tries)` : ''}`
    : undefined;
  return why ? (
    <SimpleTooltip label={why} wrapTrigger>
      {chip}
    </SimpleTooltip>
  ) : (
    chip
  );
}

export function RunTargets({ run }: { run: BackupRunInfo }): React.JSX.Element {
  if (run.targets.length === 0) {
    return <span className="text-xs text-muted-foreground">This computer only</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {run.targets.map((target) => (
        <TargetChip key={target.destinationId} target={target} />
      ))}
    </span>
  );
}

/** The newest runs first, with each destination's outcome. */
export function RunHistory({ serverId }: { serverId: string }): React.JSX.Element {
  const runs = useBackupRuns(serverId);
  return (
    <SecurityCard
      icon={<History />}
      title="History"
      description="Every backup the server made, newest first, and how each destination took it."
    >
      {runs.isPending ? (
        <RowsSkeleton rows={3} />
      ) : runs.isError ? (
        <LoadFailure message={coreErrorMessage(runs.error)} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>No backups made yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="Backup runs" className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TABLE_HEAD}>Started</th>
                <th className={TABLE_HEAD}>What</th>
                <th className={TABLE_HEAD}>Size</th>
                <th className={TABLE_HEAD}>Result</th>
                <th className={TABLE_HEAD}>Destinations</th>
              </tr>
            </thead>
            <tbody className="settings-rows">
              {runs.data.map((run) => {
                const state = RUN_STATE[run.state];
                return (
                  <tr key={run.id} className="border-t border-foreground/[0.06]">
                    <td
                      className={cn(TABLE_CELL, 'whitespace-nowrap text-xs text-muted-foreground')}
                    >
                      {dateAndTime(run.startedAtUnixMs)}
                    </td>
                    <td className={TABLE_CELL}>
                      <span className="text-foreground">{runLabel(run)}</span>
                      {run.requestedByName && (
                        <span className="block text-xs text-muted-foreground">
                          by {run.requestedByName}
                        </span>
                      )}
                    </td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap')}>
                      {run.sizeBytes ? backupSize(run.sizeBytes) : '-'}
                    </td>
                    <td className={TABLE_CELL}>
                      {run.error ? (
                        <SimpleTooltip label={run.error} wrapTrigger>
                          <Chip tone={state.tone}>{state.label}</Chip>
                        </SimpleTooltip>
                      ) : (
                        <Chip
                          tone={state.tone}
                          dot={run.state === 'running'}
                          pulse={run.state === 'running'}
                        >
                          {state.label}
                        </Chip>
                      )}
                    </td>
                    <td className={TABLE_CELL}>
                      <RunTargets run={run} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SecurityCard>
  );
}
