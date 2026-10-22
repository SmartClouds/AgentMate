import { coreErrorMessage } from '@shared/coreErrors';
import type { BackupPlanInfo } from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays, Pencil, Play, Plus, Trash2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { fromNow } from '../security/format';
import {
  CARD_BODY,
  CARD_ROWS,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
} from '../security/SecurityCard';
import type { BackupsTab } from './BackupsPanel';
import { describeCron } from './format';
import { useBackupDestinations, useBackupPlans, useRefreshBackups } from './hooks';
import { PlanDialog } from './PlanDialog';

/** Backup plans (E28): when each runs, what it keeps, where it sends, and runs off schedule. */
export function PlansTab({
  server,
  onOpenTab,
}: {
  server: DeployServer;
  onOpenTab: (tab: BackupsTab) => void;
}): React.JSX.Element {
  const plans = useBackupPlans(server.id);
  const destinations = useBackupDestinations(server.id);
  const refresh = useRefreshBackups(server.id);
  const [editing, setEditing] = useState<{ plan: BackupPlanInfo | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const names = new Map((destinations.data ?? []).map((one) => [one.id, one.name]));

  async function runNow(plan: BackupPlanInfo): Promise<void> {
    setProblem(null);
    try {
      await window.agentmat.deployServerBackups.runPlan({ serverId: server.id, id: plan.id });
      toast.success(`${plan.name} is running. The history shows how it goes.`);
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    }
  }

  async function remove(plan: BackupPlanInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the plan ${plan.name}?`,
      description:
        'It stops running. The backups it made stay on their destinations until you delete them.',
      confirmLabel: 'Delete the plan',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setProblem(null);
    try {
      await window.agentmat.deployServerBackups.deletePlan({ serverId: server.id, id: plan.id });
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    }
  }

  const noDestinations = destinations.data !== undefined && destinations.data.length === 0;
  return (
    <SecurityCard
      icon={<CalendarDays />}
      title="Plans"
      description="Each plan backs up on its schedule, sends the backup to every destination it names and keeps the last few there. It only ever deletes backups it made itself."
      actions={
        <SimpleTooltip label={noDestinations ? 'Add a destination first.' : undefined} wrapTrigger>
          <Button size="sm" disabled={noDestinations} onClick={() => setEditing({ plan: null })}>
            <Plus className="h-3.5 w-3.5" /> New plan
          </Button>
        </SimpleTooltip>
      }
    >
      {plans.isPending ? (
        <RowsSkeleton rows={2} />
      ) : plans.isError ? (
        <LoadFailure message={coreErrorMessage(plans.error)} onRetry={() => void plans.refetch()} />
      ) : plans.data.length === 0 ? (
        <div className={cn(CARD_BODY, 'space-y-2 text-sm text-muted-foreground')}>
          <p>No plans yet.</p>
          {noDestinations && (
            <Button size="sm" variant="soft" onClick={() => onOpenTab('destinations')}>
              Add a destination
            </Button>
          )}
        </div>
      ) : (
        <ul className={CARD_ROWS}>
          {plans.data.map((plan) => (
            <li
              key={plan.id}
              aria-label={plan.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {plan.name}
                  {!plan.enabled && <Chip>Paused</Chip>}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {describeCron(plan.cron)} ({plan.timeZone}).{' '}
                  {plan.enabled && plan.nextRunAtUnixMs
                    ? `Next run ${fromNow(plan.nextRunAtUnixMs)}.`
                    : ''}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Keeps the last {plan.keepLast}
                  {plan.keepDays ? `, none older than ${plan.keepDays} days` : ''}, on{' '}
                  {plan.destinationIds
                    .map((id) => names.get(id) ?? 'a removed destination')
                    .join(', ')}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Button size="sm" variant="soft" onClick={() => void runNow(plan)}>
                  <Play className="h-3.5 w-3.5" /> Run now
                </Button>
                <SimpleTooltip label="Edit">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${plan.name}`}
                    onClick={() => setEditing({ plan })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Delete">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${plan.name}`}
                    onClick={() => void remove(plan)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p role="alert" className={cn(CARD_BODY, 'text-sm text-destructive')}>
          {problem}
        </p>
      )}
      <PlanDialog
        server={server}
        plan={editing?.plan ?? null}
        destinations={destinations.data ?? []}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={refresh}
      />
    </SecurityCard>
  );
}
